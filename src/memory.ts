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
  /** null for the Taskmaster's chat (kind 'coordinator'). */
  number: number | null;
  title: string;
  kind: string;
  status: string;
  source_kind: SourceKind;
  source_id: number;
  ts: number;
  text: string;
  score: number;
}

/**
 * How close in meaning a new minion's title and brief must be to an open minion's title and note to count as
 * maybe the same work (#488, #689). On Citadel's last 40 starts (2026-11-14): true repeats (#651 and #679 of #605)
 * scored 0.636-0.638, near-misses in the same area 0.62-0.70, unrelated work mostly 0.44-0.60. No clean gap, so
 * false alarms happen (about 7 starts in 40 flagged): create_ticket's not_duplicate overrides, and a person only gets a note.
 */
export const TWIN_SCORE = 0.63;

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
/** A turn with no result and no later message counts as over after this (LIVE_MS while its minion still runs): its reply so far is what it said. */
const STUCK_MS = 60 * 60_000;
/** A turn whose minion still runs holds the scheme's mark this long at most: past it, later turns past the window of 200 wait no more. */
const LIVE_MS = 24 * 60 * 60_000;
/** Texts per embed request. */
const PER_REQUEST = 2;
/** Vectors a search reads at a time (1 MB), so a cold read holds the server briefly between yields. */
const SEARCH_PAGE = 256;
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
  // Each minion's indexed title-and-note text, by ticket id: read once, so a pass reads just the tickets table, not
  // every ticket chunk with its 4 KB vector each minute (#613).
  private ticketTexts: Map<number, string> | null = null;

  constructor(store: Store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`BEGIN IMMEDIATE; ${MEMORY_SCHEMA} COMMIT;`);
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
    // Two texts a request: 8 full chunks took ~85 s of a whole core (#525), too near llamaEmbed's 120 s timeout on a busy box.
    for (let i = 0; i < todo.length; i += PER_REQUEST) {
      const part = todo.slice(i, i + PER_REQUEST);
      const vecs = await embed(part.map((p) => p.text));
      part.forEach((p, j) => {
        put.run(p.project_id, p.ticket_id, p.person_id, p.source_kind, p.source_id, p.ts, p.text, new Uint8Array(vecs[j].buffer), model);
        if (p.source_kind === 'ticket') this.ticketTexts?.set(p.source_id, p.text);
      });
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
    // The ids first, from the covering index, then the 200 rows' text: the one query sorted every message past the mark with its
    // text in the sorter, 0.7 s of the loop a pass when the mark sat behind a running turn (#1125).
    const ids = (this.db.prepare(`SELECT e.id FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND e.kind = 'user_message' AND e.id > ? ORDER BY e.id LIMIT 200`).all(projectId, after) as { id: number }[]).map((r) => r.id);
    const msgs = (ids.length ? this.db.prepare(`SELECT e.id, e.ticket_id, e.data, e.created_at, EXISTS (SELECT 1 FROM memory_chunks m WHERE m.source_kind = 'turn' AND m.source_id = e.id AND m.ticket_id = e.ticket_id AND m.ts = e.created_at) AS done
      FROM events e WHERE e.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; ticket_id: number; data: string; created_at: number; done: number }[] : [])
      .sort((x, y) => x.id - y.id);
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
    const result = (this.db.prepare(`SELECT MIN(event_id) AS id FROM turns WHERE ticket_id = ? AND event_id > ? AND side IS NULL
      ${msg.steered ? '' : 'AND (duration_ms IS NULL OR ended_at - duration_ms >= ?)'}`).get(m.ticket_id, m.id, ...(msg.steered ? [] : [m.created_at])) as { id: number | null }).id;
    let end = result !== null ? result + 1 : Infinity;
    if (end === Infinity) {
      // No result (refused, or the turn died): once it's stuck, its reply is what came before the next message.
      const next = (this.db.prepare("SELECT MIN(id) AS id FROM events WHERE ticket_id = ? AND id > ? AND kind = 'user_message'").get(m.ticket_id, m.id) as { id: number | null }).id;
      // A turn still running past the hour is its minion's latest: it may yet reply.
      const live = next === null && this.store.getTicket(m.ticket_id)?.status === 'running';
      if (now - m.created_at < (live ? LIVE_MS : STUCK_MS)) return 'running';
      end = next ?? Infinity;
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
    const indexed = (this.ticketTexts ??= new Map(
      (this.db.prepare("SELECT source_id, text FROM memory_chunks WHERE source_kind = 'ticket'").all() as { source_id: number; text: string }[]).map((r) => [r.source_id, r.text]),
    ));
    const rows = this.db.prepare(`SELECT id, number, title, note, person_id, updated_at FROM tickets
      WHERE project_id = ? AND kind = 'ticket' ORDER BY id`).all(projectId) as { id: number; number: number; title: string; note: string | null; person_id: number | null; updated_at: number }[];
    return rows
      .map((t) => ({ project_id: projectId, ticket_id: t.id, person_id: t.person_id, source_kind: 'ticket' as const, source_id: t.id, ts: t.updated_at, text: `#${t.number} ${t.title}${t.note ? `\n${t.note}` : ''}` }))
      .filter((t) => t.text !== indexed.get(t.ticket_id));
  }

  /** Rows embedded by another model, to embed again with this one. */
  private staleRows(projectId: number, model: string, max: number): Pending[] {
    return this.db.prepare('SELECT project_id, ticket_id, person_id, source_kind, source_id, ts, text FROM memory_chunks WHERE project_id = ? AND model != ? LIMIT ?')
      .all(projectId, model, max) as unknown as Pending[];
  }

  /**
   * The scheme's `limit` chunks closest in meaning to `query`, best first; `ticketId` narrows it to one
   * minion's, `personId` to one person's messages, `openMinions` to the titles and notes of minions not dismissed.
   * shortcut: brute force over every vector of the scheme; past ~100k rows, cache them or move to sqlite-vec.
   */
  async search(projectId: number, query: string, embed: Embed, model: string, opts: { limit?: number; ticketId?: number; personId?: number; openMinions?: boolean } = {}): Promise<MemoryHit[]> {
    const [q] = await embed([query], true);
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 5), 1), 20);
    // Every row of the project index comes back, matching or not (vec null when not), so a page is 256 rows scanned and a
    // selective filter can't walk the whole scheme in one call (it held the loop up to 2.8 s, #1034).
    const page = this.db.prepare(`SELECT m.id, CASE WHEN t.project_id = ?1 AND m.ts >= t.created_at
        ${opts.ticketId === undefined && opts.personId !== undefined ? "AND m.person_id = ?3 AND m.source_kind = 'turn'" : ''}
        ${opts.openMinions ? "AND m.source_kind = 'ticket' AND t.status != 'closed'" : ''}
        THEN m.vec END AS vec
      FROM memory_chunks m LEFT JOIN tickets t ON t.id = m.ticket_id
      WHERE m.project_id = ?1 AND m.model = ?2 AND m.id > ?4 ${opts.ticketId !== undefined ? 'AND m.ticket_id = ?3' : ''}
      ORDER BY m.id LIMIT ${SEARCH_PAGE}`);
    const top: { id: number; score: number }[] = [];
    // In pages with a yield between them: read cold, Citadel's 3.5k vectors (14 MB) held the server 1.0 s in one go (#614).
    let after = 0;
    for (;;) {
      const rows = page.all(projectId, model, opts.ticketId ?? opts.personId ?? null, after) as { id: number; vec: Uint8Array | null }[];
      for (const r of rows) {
        if (!r.vec) continue;
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
      if (rows.length < SEARCH_PAGE) break;
      after = rows[rows.length - 1].id;
      await new Promise((r) => setImmediate(r));
    }
    const get = this.db.prepare('SELECT m.ticket_id, t.number, t.title, t.kind, t.status, m.source_kind, m.source_id, m.ts, m.text FROM memory_chunks m JOIN tickets t ON t.id = m.ticket_id WHERE m.id = ?');
    // A minion deleted while the search yielded takes its chunks with it.
    return top.flatMap(({ id, score }) => {
      const hit = get.get(id) as Omit<MemoryHit, 'score'> | undefined;
      return hit ? [{ ...hit, score: Math.round(score * 1000) / 1000 }] : [];
    });
  }

  deleteTicket(ticketId: number) {
    this.db.prepare('DELETE FROM memory_chunks WHERE ticket_id = ?').run(ticketId);
    this.forgetTicket(ticketId);
  }

  /** Drop a minion's remembered title and note, so it is compared afresh (deleteTicket, and the server's side of it on the writer). */
  forgetTicket(ticketId: number) {
    this.ticketTexts?.delete(ticketId);
  }
}

/**
 * Embed what was said since the last pass, a little at a time, never in a request. server.ts calls run
 * every minute. Moved out of server.ts (docs/adr/0002-background-jobs-out-of-server.md).
 */
export class MemoryIndexer {
  private indexing = false;
  private down = false; // say so once per outage, not every minute

  private store: Store;
  private embed: Embed;
  private model: string;
  private indexed: (projectId: number) => boolean;

  constructor(store: Store, embed: Embed, model: string, indexed: (projectId: number) => boolean) {
    this.store = store;
    this.embed = embed;
    this.model = model;
    this.indexed = indexed;
  }

  async run() {
    if (this.indexing) return;
    this.indexing = true;
    try {
      // A batch per scheme in turn, so one scheme's backfill never holds up another's new turns, and
      // one scheme that fails (a chunk the model refuses) sits out this pass without stopping the rest.
      let failed: any = null;
      const out = new Set<number>();
      for (let more = true; more; ) {
        more = false;
        for (const p of this.store.listProjects()) {
          if (!this.indexed(p.id) || out.has(p.id)) continue;
          // A scheme with nothing to embed never awaits: without this, every scheme's reads ran as one stall (0.7 s on live, #613).
          await new Promise((r) => setImmediate(r));
          try {
            if ((await this.store.memory.index(p.id, this.embed, this.model, 8)) > 0) more = true;
          } catch (err) {
            failed = err;
            out.add(p.id);
          }
        }
      }
      if (failed) throw failed;
      if (this.down) console.log('Semantic memory: the embedding service is back');
      this.down = false;
    } catch (err: any) {
      if (!this.down) console.error('Semantic memory indexing stopped:', err?.cause?.code ?? err?.message ?? err);
      this.down = true;
    } finally {
      this.indexing = false;
    }
  }
}
