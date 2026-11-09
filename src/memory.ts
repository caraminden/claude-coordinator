// Semantic memory (#331): what people and minions said, embedded by a local model (llama-server on
// perigee, deploy/citadel-embed.service) so minions and the Taskmaster can search it by meaning.
// Indexed: each person's message with the minion's final reply for that turn, and minion titles and
// notes. Never: person_notes, tool calls or their output, contraption turns.
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db.ts';

// No foreign keys, like person_notes, so an older release's deleteTicket still works after a rollback;
// reads join tickets and drop rows older than their minion (an id reused after such a delete).
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_chunks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL,
  person_id INTEGER,
  source_kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  vec BLOB NOT NULL,
  model TEXT NOT NULL,
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS memory_chunks_project ON memory_chunks(project_id, model);
CREATE INDEX IF NOT EXISTS memory_chunks_ticket ON memory_chunks(ticket_id);
`;

/** What one indexed piece of text is: a turn (source_id: the person's message event) or a minion's title and note (source_id: its ticket). */
export type SourceKind = 'turn' | 'ticket';

export interface MemoryHit {
  ticket_id: number;
  number: number;
  title: string;
  source_kind: SourceKind;
  source_id: number;
  ts: number;
  text: string;
  score: number;
}

/** Texts in, one unit-length vector per text out; `query` marks a search, which the model wants instructed. */
export type Embed = (texts: string[], query?: boolean) => Promise<Float32Array[]>;

/** What people and Claude said in an event, for searching (not tool calls or their output). */
export function spokenText(kind: string, data: any): string {
  if (kind === 'user_message') return typeof data?.text === 'string' ? data.text : '';
  // A reply the link check sent back that its rewrite replaced (#281) isn't in the chat to jump to.
  if (data?.type !== 'assistant' || data.replaced) return '';
  return (data.message?.content ?? []).filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

// About 600 tokens a chunk at most: embedding costs about 7 CPU-seconds per 500 tokens on perigee (#331's benchmark).
const USER_MAX = 1000;
const REPLY_MAX = 1500;
/** A turn with no result and no later message counts as over after this: its reply so far is what it said. */
const STUCK_MS = 60 * 60_000;
/** Messages that aren't a person's or a relay's ask: CI and server notices are noise. */
const NOT_ASKS = new Set(['GitHub', 'System']);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Qwen3-Embedding wants an instruction on the query side only (its model card: 1-5% better retrieval). */
const QUERY_INSTRUCT = 'Instruct: Given a question about past work, decisions and conversations in a software team\'s chats with its AI agents, retrieve the passages that answer it\nQuery: ';

/** An Embed backed by llama-server's OpenAI-style /v1/embeddings. */
export function llamaEmbed(url: string, timeoutMs = 120_000): Embed {
  return async (texts, query = false) => {
    const res = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: query ? texts.map((t) => QUERY_INSTRUCT + t) : texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`embedding service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('embedding service sent the wrong number of vectors');
    return [...data.data].sort((a, b) => a.index - b.index).map((d) => unit(Float32Array.from(d.embedding)));
  };
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

type Pending = { project_id: number; ticket_id: number; person_id: number | null; source_kind: SourceKind; source_id: number; ts: number; text: string };

export class Memory {
  private db: DatabaseSync;
  private store: Store;

  constructor(store: Store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`BEGIN; ${MEMORY_SCHEMA} COMMIT;`);
  }

  /**
   * One indexing pass over a scheme, at most `max` new chunks: finished turns after the last one it
   * saw, then minions whose title or note changed, then rows another model embedded. Returns how many it embedded.
   */
  async index(projectId: number, embed: Embed, model: string, max = 32, now = Date.now()): Promise<number> {
    const turns = this.pendingTurns(projectId, max, now);
    const todo = turns.chunks;
    if (todo.length < max) todo.push(...this.pendingTickets(projectId).slice(0, max - todo.length));
    if (todo.length < max) todo.push(...this.staleRows(projectId, model, max - todo.length));
    const put = this.db.prepare(`INSERT INTO memory_chunks (project_id, ticket_id, person_id, source_kind, source_id, ts, text, vec, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_kind, source_id) DO UPDATE SET project_id = excluded.project_id, ticket_id = excluded.ticket_id, person_id = excluded.person_id,
        ts = excluded.ts, text = excluded.text, vec = excluded.vec, model = excluded.model`);
    for (let i = 0; i < todo.length; i += 8) {
      const part = todo.slice(i, i + 8);
      const vecs = await embed(part.map((p) => p.text));
      part.forEach((p, j) => put.run(p.project_id, p.ticket_id, p.person_id, p.source_kind, p.source_id, p.ts, p.text, new Uint8Array(vecs[j].buffer), model));
    }
    if (turns.mark !== null) this.store.setSetting(this.markKey(projectId), turns.mark);
    return todo.length;
  }

  private markKey = (projectId: number) => `memory_turns_after:${projectId}`;

  /**
   * The scheme's people's messages after the mark, oldest first, whose turn is over and isn't indexed
   * yet (at most `max`), and the new mark: the last message before the first still running or left for the next pass.
   */
  private pendingTurns(projectId: number, max: number, now: number): { chunks: Pending[]; mark: number | null } {
    const after = this.store.getSetting<number>(this.markKey(projectId)) ?? 0;
    const msgs = this.db.prepare(`SELECT e.id, e.ticket_id, e.data, e.created_at, EXISTS (SELECT 1 FROM memory_chunks m WHERE m.source_kind = 'turn' AND m.source_id = e.id AND m.ticket_id = e.ticket_id AND m.ts = e.created_at) AS done
      FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND e.kind = 'user_message' AND e.id > ? ORDER BY e.id LIMIT 200`)
      .all(projectId, after) as { id: number; ticket_id: number; data: string; created_at: number; done: number }[];
    const chunks: Pending[] = [];
    let mark: number | null = null;
    let held = false; // a message before this one is still running or left over: the mark stays behind it
    for (const m of msgs) {
      const turn = m.done ? null : chunks.length < max ? this.turnOf(m, now) : 'later';
      if (turn && typeof turn === 'object') chunks.push({ project_id: projectId, ...turn });
      // An indexed chunk is done once this pass saves it, so it moves the mark like one with nothing to index.
      if (turn === 'running' || turn === 'later') held = true;
      else if (!held) mark = m.id;
    }
    return { chunks, mark };
  }

  /** A message's chunk; null when there's nothing to index; 'running' while its turn may still reply. */
  private turnOf(m: { id: number; ticket_id: number; data: string; created_at: number }, now: number): Omit<Pending, 'project_id'> | null | 'running' | 'later' {
    let msg: any;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return null;
    }
    const asked = spokenText('user_message', msg).trim();
    if (!asked || NOT_ASKS.has(msg.author)) return null;
    // Its turn's result: the first after it, or for a message that waited for the turn before it to end,
    // the first of a turn that started after it was sent (a steer joins the running turn instead).
    const result = (this.db.prepare(`SELECT MIN(event_id) AS id FROM turns WHERE ticket_id = ? AND event_id > ?
      ${msg.steered ? '' : 'AND (duration_ms IS NULL OR ended_at - duration_ms >= ?)'}`).get(m.ticket_id, m.id, ...(msg.steered ? [] : [m.created_at])) as { id: number | null }).id;
    let end = result !== null ? result + 1 : Infinity;
    if (end === Infinity) {
      // No result (refused, or the turn died): once it's stuck, its reply is what came before the next message.
      if (now - m.created_at < STUCK_MS) return 'running';
      end = (this.db.prepare("SELECT MIN(id) AS id FROM events WHERE ticket_id = ? AND id > ? AND kind = 'user_message'").get(m.ticket_id, m.id) as { id: number | null }).id ?? Infinity;
    }
    // The turn's last words that aren't a Grunt's: its reply.
    const rows = this.db.prepare("SELECT data FROM events WHERE ticket_id = ? AND id > ? AND id < ? AND kind = 'claude' ORDER BY id DESC LIMIT 300")
      .all(m.ticket_id, m.id, Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER) as { data: string }[];
    let reply = '';
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (!d.parent_tool_use_id) reply = spokenText('claude', d).trim();
      } catch {}
      if (reply) break;
    }
    const person = typeof msg.author === 'string' ? this.store.findUser('name', msg.author)?.id ?? null : null;
    return {
      ticket_id: m.ticket_id, person_id: person, source_kind: 'turn', source_id: m.id, ts: m.created_at,
      text: `${msg.author ?? 'Someone'}: ${cut(asked, USER_MAX)}${reply ? `\n\nReply: ${cut(reply, REPLY_MAX)}` : ''}`,
    };
  }

  /** Minions (not the Taskmaster) whose title and note aren't indexed as they read now. */
  private pendingTickets(projectId: number): Pending[] {
    const rows = this.db.prepare(`SELECT t.id, t.number, t.title, t.note, t.person_id, t.updated_at, m.text AS indexed FROM tickets t
      LEFT JOIN memory_chunks m ON m.source_kind = 'ticket' AND m.source_id = t.id
      WHERE t.project_id = ? AND t.kind = 'ticket' ORDER BY t.id`).all(projectId) as { id: number; number: number; title: string; note: string | null; person_id: number | null; updated_at: number; indexed: string | null }[];
    return rows
      .map((t) => ({ project_id: projectId, ticket_id: t.id, person_id: t.person_id, source_kind: 'ticket' as const, source_id: t.id, ts: t.updated_at, text: `#${t.number} ${t.title}${t.note ? `\n${t.note}` : ''}`, indexed: t.indexed }))
      .filter((t) => t.text !== t.indexed)
      .map(({ indexed, ...p }) => p);
  }

  /** Rows embedded by another model, to embed again with this one. */
  private staleRows(projectId: number, model: string, max: number): Pending[] {
    return this.db.prepare('SELECT project_id, ticket_id, person_id, source_kind, source_id, ts, text FROM memory_chunks WHERE project_id = ? AND model != ? LIMIT ?')
      .all(projectId, model, max) as unknown as Pending[];
  }

  /**
   * The scheme's `limit` chunks closest in meaning to `query`, best first; `ticketId` narrows it to one
   * minion's, `personId` to one person's messages.
   * shortcut: brute force over every vector of the scheme; past ~100k rows, cache them or move to sqlite-vec.
   */
  async search(projectId: number, query: string, embed: Embed, model: string, opts: { limit?: number; ticketId?: number; personId?: number } = {}): Promise<MemoryHit[]> {
    const [q] = await embed([query], true);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), 20);
    const rows = this.db.prepare(`SELECT m.id, m.vec FROM memory_chunks m JOIN tickets t ON t.id = m.ticket_id
      WHERE m.project_id = ?1 AND t.project_id = ?1 AND m.model = ?2 AND m.ts >= t.created_at
        ${opts.ticketId !== undefined ? 'AND m.ticket_id = ?3' : opts.personId !== undefined ? "AND m.person_id = ?3 AND m.source_kind = 'turn'" : ''}`)
      .all(projectId, model, ...[opts.ticketId ?? opts.personId].filter((x) => x !== undefined)) as { id: number; vec: Uint8Array }[];
    const top: { id: number; score: number }[] = [];
    for (const r of rows) {
      const v = new Float32Array(r.vec.slice().buffer); // a copy: the blob's offset needn't be 4-aligned
      if (v.length !== q.length) continue;
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      if (top.length < limit || s > top[top.length - 1].score) {
        top.push({ id: r.id, score: s });
        top.sort((a, b) => b.score - a.score);
        if (top.length > limit) top.pop();
      }
    }
    const get = this.db.prepare('SELECT m.ticket_id, t.number, t.title, m.source_kind, m.source_id, m.ts, m.text FROM memory_chunks m JOIN tickets t ON t.id = m.ticket_id WHERE m.id = ?');
    return top.map(({ id, score }) => ({ ...(get.get(id) as unknown as Omit<MemoryHit, 'score'>), score: Math.round(score * 1000) / 1000 }));
  }

  deleteTicket(ticketId: number) {
    this.db.prepare('DELETE FROM memory_chunks WHERE ticket_id = ?').run(ticketId);
  }
}
