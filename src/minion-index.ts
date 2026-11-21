// Search over a scheme's past minions (#1156): each closed minion's title, type, brief, last words and the files it
// wrote, and the shared folder's handoffs, in SQLite full-text tables. Built a few minions at a time as they close,
// never per question; search_minions and the citadel:scout Grunt read it.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db.ts';
import { reconcileMoved, tidyForClosed } from './handoff-tidy.ts';
import { spokenText } from './memory.ts';
import { projectSharedDir } from './workspace.ts';

// rowid is the ticket's id, so a minion closed again replaces its row. Porter stems "scripts" and "seeding".
export const MINION_INDEX_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS minion_index USING fts5(title, type, brief, said, files, project_id UNINDEXED, closed_at UNINDEXED, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS handoff_index USING fts5(name, body, project_id UNINDEXED, mtime UNINDEXED, tokenize = 'porter unicode61');
`;

/** A folder listed within this long of its last change is listed again next pass: see syncHandoffs. */
const RACY_MS = 2_000;
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
  /** Set by MinionIndexer: called with each newly closed minion's brief, so its handoff can be filed (src/handoff-tidy.ts). */
  onClosed?: (projectId: number, briefText: string) => void;
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
    for (const t of rows) {
      // One unreadable transcript is skipped, not retried: the mark must still pass it, or the scheme's index stops there.
      try {
        const briefText = this.indexTicket(projectId, t);
        this.onClosed?.(projectId, briefText);
      } catch (e) {
        console.error(`minion index: skipped #${t.number} (ticket ${t.id}): ${(e as Error).message}`);
      }
      this.store.setSetting(this.markKey(projectId), [t.at, t.id]);
    }
    return rows.length;
  }

  private indexTicket(projectId: number, t: { id: number; number: number; title: string; at: number }): string {
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
    return briefText;
  }

  /** Per scheme: what the last sync saw (each folder's and file's mtime) and the rows it left, so a pass that finds nothing changed touches no table (#1463). */
  private handoffSeen = new Map<number, { dirs: Map<string, number>; files: Map<string, number>; rows: Map<string, { id: number; mtime: number }> }>();

  /**
   * Bring the scheme's handoffs/ rows in line with the folder: new and changed files in, gone ones out. Every file call
   * is async (#1463: its readdir, stat and the table read held the server's thread for 3.4 s in 11 stalls on Nov 21).
   * The filed folders (shipped/, not-picked/) are listed again only when their own mtime moves: files are moved into
   * them, not edited. handoffs/ itself is stat'ed file by file, since a live handoff is edited in place. Returns whether
   * a handoff file is at `rel` (relative to the shared folder), as of this listing.
   */
  async syncHandoffs(projectId: number, dataDir: string): Promise<(rel: string) => boolean> {
    const dir = join(projectSharedDir(dataDir, projectId), 'handoffs');
    const seen = this.handoffSeen.get(projectId);
    const dirs = new Map<string, number>();
    const files = new Map<string, number>();
    // Filed handoffs (src/handoff-tidy.ts) stay searchable under their folder: "shipped/x.md", "not-picked/x.md".
    for (const sub of ['', 'shipped', 'not-picked']) {
      const at = await stat(join(dir, sub)).then((s) => Math.floor(s.mtimeMs), () => null);
      if (at === null) continue; // no such folder
      const prefix = sub ? `${sub}/` : '';
      const keep = () => { for (const [name, mtime] of seen?.files ?? []) if (name.startsWith(prefix) && (sub || !name.includes('/'))) files.set(name, mtime); };
      if (sub && seen?.dirs.get(sub) === at) {
        dirs.set(sub, at);
        keep();
        continue;
      }
      let names: string[];
      try {
        names = (await readdir(join(dir, sub))).filter((n) => n.endsWith('.md'));
      } catch {
        keep(); // a listing that failed (EMFILE, EIO) drops no rows, and the next pass lists it again
        continue;
      }
      // Noted only once listed: a folder whose listing failed is listed again next pass. A folder changed moments before
      // its listing may change again within the same mtime tick (a coarse clock, a 1 s filesystem), which would leave
      // its mtime where it was, so it is noted as unseen and listed again next pass (git's "racy" entries; #1483).
      dirs.set(sub, Date.now() - at < RACY_MS ? -1 : at);
      // A few stats at a time: the thread pool is shared with every other file call the server makes.
      for (let i = 0; i < names.length; i += 8) {
        const batch = names.slice(i, i + 8);
        const times = await Promise.all(batch.map((n) => stat(join(dir, sub, n)).then((s) => Math.floor(s.mtimeMs), () => null)));
        batch.forEach((n, j) => times[j] !== null && files.set(`${prefix}${n}`, times[j]!));
      }
    }
    const rows = seen?.rows ?? new Map((this.db.prepare('SELECT rowid AS id, name, mtime FROM handoff_index WHERE project_id = ?').all(projectId) as { id: number; name: string; mtime: number }[]).map((r) => [r.name, { id: r.id, mtime: r.mtime }]));
    this.handoffSeen.set(projectId, { dirs, files, rows });
    for (const [name, mtime] of files) {
      const row = rows.get(name);
      if (row?.mtime === mtime) continue;
      let body: string;
      try {
        body = (await readFile(join(dir, name), 'utf8')).slice(0, 20_000);
      } catch {
        continue; // gone or unreadable: the next pass tries it again
      }
      // Read again after the await: another pass may have filed it meanwhile.
      const now = rows.get(name);
      if (now) this.db.prepare('DELETE FROM handoff_index WHERE rowid = ?').run(now.id);
      const { lastInsertRowid } = this.db.prepare('INSERT INTO handoff_index (name, body, project_id, mtime) VALUES (?, ?, ?, ?)').run(name, body, projectId, mtime);
      rows.set(name, { id: Number(lastInsertRowid), mtime });
    }
    for (const [name, gone] of [...rows]) {
      if (files.has(name)) continue;
      this.db.prepare('DELETE FROM handoff_index WHERE rowid = ?').run(gone.id);
      rows.delete(name);
    }
    return (rel) => rel.startsWith('handoffs/') && files.has(rel.slice('handoffs/'.length));
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
    store.minionIndex.onClosed = (projectId, briefText) => {
      try { tidyForClosed(store, dataDir, projectId, briefText); } catch (e) { console.error(`handoff tidy: ${(e as Error).message}`); }
    };
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (const p of this.store.listProjects()) {
        await new Promise((r) => setImmediate(r));
        while (this.store.minionIndex.indexClosed(p.id) > 0) await new Promise((r) => setImmediate(r));
        const has = await this.store.minionIndex.syncHandoffs(p.id, this.dataDir);
        try { reconcileMoved(this.store, this.dataDir, p.id, has); } catch (e) { console.error(`handoff tidy: ${(e as Error).message}`); }
      }
    } finally {
      this.running = false;
    }
  }
}
