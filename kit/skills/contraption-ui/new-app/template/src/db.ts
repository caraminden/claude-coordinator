// The app's SQLite file in DATA_DIR, migrated on open. Migrations are migrations/NNNN-*.sql, applied in
// order, each in its own transaction; PRAGMA user_version holds the highest one applied. A migration that
// has shipped is never edited: add the next number instead. citadel-app.json lists the folder under
// `migrations`, so Roll back to last green never goes back past one.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');
export const DB_FILE = 'app.db';

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync, dir = MIGRATIONS): number {
  let at = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const files = readdirSync(dir).filter((f) => /^\d{4}-[\w-]+\.sql$/.test(f)).sort();
  for (const f of files) {
    const n = Number(f.slice(0, 4));
    if (n <= at) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.exec(`PRAGMA user_version = ${n}`);
      db.exec('COMMIT');
      at = n;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${f} failed: ${(err as Error).message}`);
    }
  }
  return at;
}
