// A Store over the live database that a replay can't write to (#1503), with no 2 GB copy: the file opens read-only,
// and each table the judge writes is shadowed by an empty TEMP table of the same shape. SQLite resolves an unqualified
// name to temp first, so the judge's reads and writes of those tables stay in memory; a write anywhere else fails.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store, type Ticket } from '../../src/db.ts';

export const LIVE_DB = join(process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator'), 'coordinator.db');

/** `shadow`: the tables the judge writes; `seed` copies rows from the live table into its shadow (a WHERE clause, or '' for all). */
export function replayStore(path: string, shadow: string[], seed: Record<string, string> = {}): Store {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = 0; PRAGMA temp_store = MEMORY;');
  // The chat log and the state live in their own files beside the main one (#1169): attach them read-only, as the app does.
  for (const [name, file] of [['state', 'state.db'], ['chat', 'events.db']]) {
    const other = join(dirname(path), file);
    if (existsSync(other)) db.prepare('ATTACH DATABASE ? AS ' + name).run(`file:${other}?mode=ro`);
  }
  for (const table of shadow) {
    const row = db.prepare("SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
    if (!row) throw new Error(`replayStore: no table ${table} in ${path}`);
    db.exec(row.sql.replace(/^CREATE TABLE (IF NOT EXISTS )?/i, 'CREATE TEMP TABLE '));
    if (table in seed) db.exec(`INSERT INTO temp.${table} SELECT * FROM main.${table} ${seed[table] ? `WHERE ${seed[table]}` : ''}`);
  }
  const store = Object.create(Store.prototype) as Store;
  (store as unknown as { db: DatabaseSync }).db = db;
  return store;
}

/**
 * The scheme's minions as they were at `now()`: none made later, and one closed later still open. `extra` are the ones the
 * replay itself started, always open; `hide` are the ones the judge really started, which the replay's own stand in for.
 * Each scheme's list is read once per `now`: a judge may list them per file it checks.
 */
export function minionsAsOf(store: Store, now: () => number, extra: Ticket[] = [], hide = new Set<number>()) {
  const then = (t: Ticket): Ticket | undefined =>
    t.created_at > now() || hide.has(t.id) ? undefined : t.status === 'closed' && (t.closed_at ?? 0) > now() ? ({ ...t, status: 'working' } as Ticket) : t;
  const list = store.listTickets.bind(store);
  const get = store.getTicket.bind(store);
  const read = new Map<number, { at: number; rows: Ticket[] }>();
  store.listTickets = (pid: number) => {
    if (read.get(pid)?.at !== now()) read.set(pid, { at: now(), rows: list(pid).flatMap((t) => then(t) ?? []) });
    return [...extra.filter((t) => t.project_id === pid), ...read.get(pid)!.rows];
  };
  store.getTicket = (id: number) => extra.find((t) => t.id === id) ?? (() => { const t = get(id); return t && then(t); })();
}
