// A Store over the live database that a replay can't write to (#1503), with no 2 GB copy: the file opens read-only,
// and each table the judge writes is shadowed by an empty TEMP table of the same shape. SQLite resolves an unqualified
// name to temp first, so the judge's reads and writes of those tables stay in memory; a write anywhere else fails.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/db.ts';

export const LIVE_DB = join(process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator'), 'coordinator.db');

/** `shadow`: the tables the judge writes; `seed` copies rows from the live table into its shadow (a WHERE clause, or '' for all). */
export function replayStore(path: string, shadow: string[], seed: Record<string, string> = {}): Store {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = 0; PRAGMA temp_store = MEMORY;');
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
