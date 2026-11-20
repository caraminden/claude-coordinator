// Search over a scheme's past minions (#1156): each closed minion's title, type, brief, last words and the files it
// wrote, and the shared folder's handoffs, in SQLite full-text tables. Built a few minions at a time as they close,
// never per question; search_minions and the citadel:scout Grunt read it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db.ts';
import { spokenText } from './memory.ts';
import { projectSharedDir } from './workspace.ts';

// rowid is the ticket's id, so a minion closed again replaces its row. Porter stems "scripts" and "seeding".
export const MINION_INDEX_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS minion_index USING fts5(title, type, brief, said, files, project_id UNINDEXED, closed_at UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS handoff_index USING fts5(name, body, project_id UNINDEXED, mtime UNINDEXED, tokenize = 'porter unicode61');
`;

const BRIEF_MAX = 3000;
const SAID_MAX = 4000;
/** Minions indexed between yields: each reads its events (0.2 to 1.6 MB on Citadel's), so a few keep the server's loop free. */
const PER_CALL = 5;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A path as a reader would say it: worktree-relative, $TMPDIR/… for scratch, shared/… for the shared folder. */
export function shortPath(p: string): string {
  return p.replace(/^.*\/projects\/\d+\/tickets\/\d+\//, '').replace(/^.*\/projects\/\d+\/tmp\/\d+\//, '$TMPDIR/').replace(/^.*\/projects\/\d+\/shared\/project\//, 'shared/')
    .replace(/^"?\$\{?TMPDIR\}?"?\//, '$TMPDIR/').replace(/"$/, '');
}

/** Files a Bash command writes from a heredoc (`cat > x <<EOF`, `tee x <<EOF`): how most scratch scripts get made. */
export function heredocTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/(?:\bcat\s*>>?|\btee\s+(?:-a\s+)?)\s*("?)([^\s"'<>|;&]+)\1\s*<</g)) out.push(m[2]);
  return out;
}

/** A person's or agent's words as an FTS5 query: every word quoted (no operators get through), all of them, or any with `any`. */
export function ftsQuery(q: string, any = false): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words)].slice(0, 24).map((w) => `"${w}"`).join(any ? ' OR ' : ' ');
}

export interface MinionHit { kind: 'minion'; ticket_id: number; number: number; title: string; type: string; status: string; closed_at: number; files: string; snippet: string }
export interface HandoffHit { kind: 'handoff'; name: string; mtime: number; snippet: string }

export class MinionIndex {
  private db: DatabaseSync;
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    this.db = store.db;
  }

  private markKey = (projectId: number) => `minion_index_after:${projectId}`;

  /** Index the scheme's minions closed since the last call, oldest first, at most `max`; returns how many. */
  indexClosed(projectId: number, max = PER_CALL): number {
    const [at, id] = this.store.getSetting<[number, number]>(this.markKey(projectId)) ?? [0, 0];
    const rows = this.db.prepare(`SELECT id, number, title, coalesce(closed_at, updated_at) AS at FROM tickets
      WHERE project_id = :p AND kind = 'ticket' AND status = 'closed' AND (coalesce(closed_at, updated_at) > :at OR (coalesce(closed_at, updated_at) = :at AND id > :id))
      ORDER BY at, id LIMIT :max`).all({ p: projectId, at, id, max }) as { id: number; number: number; title: string; at: number }[];
    for (const t of rows) this.indexTicket(projectId, t);
    if (rows.length) this.store.setSetting(this.markKey(projectId), [rows.at(-1)!.at, rows.at(-1)!.id]);
    return rows.length;
  }

  private indexTicket(projectId: number, t: { id: number; number: number; title: string; at: number }) {
    const brief = (this.db.prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'user_message' ORDER BY id LIMIT 1").get(t.id) as { data: string } | undefined)?.data;
    let briefText = '';
    try {
      briefText = brief ? spokenText('user_message', JSON.parse(brief)) : '';
    } catch {}
    // Its last words: the newest top-level replies (not a Grunt's), newest last, up to SAID_MAX.
    const said: string[] = [];
    let len = 0;
    for (const r of this.db.prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' ORDER BY id DESC LIMIT 400").iterate(t.id) as Iterable<{ data: string }>) {
      try {
        const d = JSON.parse(r.data);
        if (d.parent_tool_use_id) continue;
        const text = spokenText('claude', d).trim();
        if (!text) continue;
        said.unshift(cut(text, 1500));
        if ((len += text.length) >= SAID_MAX) break;
      } catch {}
    }
    const files = new Set<string>();
    const calls = this.db.prepare(`SELECT json_extract(c.value, '$.name') AS name, json_extract(c.value, '$.input.file_path') AS path, json_extract(c.value, '$.input.command') AS cmd
      FROM events e, json_each(e.data, '$.message.content') c
      WHERE e.ticket_id = ? AND e.kind = 'claude' AND e.data LIKE '%"tool_use"%' AND json_valid(e.data) AND json_extract(c.value, '$.type') = 'tool_use'
        AND (json_extract(c.value, '$.name') IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit') OR (json_extract(c.value, '$.name') = 'Bash' AND json_extract(c.value, '$.input.command') LIKE '%<<%'))`)
      .all(t.id) as { name: string; path: string | null; cmd: string | null }[];
    for (const c of calls) for (const p of c.name === 'Bash' ? heredocTargets(c.cmd ?? '') : c.path ? [c.path] : []) files.add(shortPath(p));
    const type = String(this.store.props.forTarget('minion', t.id).type ?? '');
    this.db.prepare('DELETE FROM minion_index WHERE rowid = ?').run(t.id);
    this.db.prepare('INSERT INTO minion_index (rowid, title, type, brief, said, files, project_id, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.title, type, cut(briefText, BRIEF_MAX), said.join('\n\n'), [...files].slice(0, 200).join('\n'), projectId, t.at);
  }

  /** Bring the scheme's handoffs/ rows in line with the folder: new and changed files in, gone ones out. */
  syncHandoffs(projectId: number, dataDir: string) {
    const dir = join(projectSharedDir(dataDir, projectId), 'handoffs');
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      names = [];
    }
    const have = new Map((this.db.prepare('SELECT rowid AS id, name, mtime FROM handoff_index WHERE project_id = ?').all(projectId) as { id: number; name: string; mtime: number }[]).map((r) => [r.name, r]));
    for (const name of names) {
      let mtime: number;
      try {
        mtime = Math.floor(statSync(join(dir, name)).mtimeMs);
      } catch {
        continue;
      }
      const row = have.get(name);
      have.delete(name);
      if (row?.mtime === mtime) continue;
      if (row) this.db.prepare('DELETE FROM handoff_index WHERE rowid = ?').run(row.id);
      let body = '';
      try {
        body = readFileSync(join(dir, name), 'utf8').slice(0, 20_000);
      } catch {
        continue;
      }
      this.db.prepare('INSERT INTO handoff_index (name, body, project_id, mtime) VALUES (?, ?, ?, ?)').run(name, body, projectId, mtime);
    }
    for (const gone of have.values()) this.db.prepare('DELETE FROM handoff_index WHERE rowid = ?').run(gone.id);
  }

  /**
   * The scheme's past minions and handoffs that match `query` (all its words, then any of them to fill up), best
   * first; `since` keeps minions closed at or after it. An empty query lists the newest closed.
   */
  search(projectId: number, query: string, opts: { since?: number; limit?: number } = {}): (MinionHit | HandoffHit)[] {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 10), 1), 30);
    const since = opts.since ?? 0;
    const minion = (match: string | null, n: number, skip: number[]) => this.db.prepare(`SELECT i.rowid AS ticket_id, t.number, t.title, i.type, t.status, i.closed_at, i.files,
        ${match ? "snippet(minion_index, -1, '[', ']', '…', 20)" : "substr(i.said, -300)"} AS snippet
      FROM minion_index i JOIN tickets t ON t.id = i.rowid AND t.project_id = i.project_id
      WHERE ${match ? 'minion_index MATCH ? AND' : ''} i.project_id = ? AND i.closed_at >= ? ${skip.length ? `AND i.rowid NOT IN (${skip.map(Number).join(',')})` : ''}
      ORDER BY ${match ? 'bm25(minion_index, 5, 1, 2, 2, 3)' : 'i.closed_at DESC'} LIMIT ?`)
      .all(...(match ? [match] : []), projectId, since, n).map((r: any) => ({ kind: 'minion' as const, ...r }));
    const all = ftsQuery(query);
    if (!all) return minion(null, limit, []);
    const hits: (MinionHit | HandoffHit)[] = minion(all, limit, []);
    if (hits.length < limit) hits.push(...minion(ftsQuery(query, true), limit - hits.length, hits.map((h) => (h as MinionHit).ticket_id)));
    // Handoffs are live work, not history: since doesn't drop them, and a few at most ride along.
    const handoffs = this.db.prepare(`SELECT name, mtime, snippet(handoff_index, 1, '[', ']', '…', 20) AS snippet FROM handoff_index
      WHERE handoff_index MATCH ? AND project_id = ? ORDER BY bm25(handoff_index, 5, 1) LIMIT 3`).all(all, projectId).map((r: any) => ({ kind: 'handoff' as const, ...r }));
    return [...hits, ...handoffs];
  }

  deleteTicket(ticketId: number) {
    this.db.prepare('DELETE FROM minion_index WHERE rowid = ?').run(ticketId);
  }
}

/** Every minute (server.ts): each indexed scheme's newly closed minions and its handoffs folder, a scheme at a time. */
export class MinionIndexer {
  private store: Store;
  private dataDir: string;
  private running = false;
  constructor(store: Store, dataDir: string) {
    this.store = store;
    this.dataDir = dataDir;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (const p of this.store.listProjects()) {
        await new Promise((r) => setImmediate(r));
        this.store.minionIndex.syncHandoffs(p.id, this.dataDir);
        while (this.store.minionIndex.indexClosed(p.id) > 0) await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.running = false;
    }
  }
}
