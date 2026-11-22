// Puts the chat log back into the main file (#1169's rollback, for going back past the release that reads events.db,
// ship 1, which reads either layout): node tools/events-unsplit.ts <coordinator.db> --service-stopped
//
// With the service stopped, it brings events_old (the main file's copy from before the move) up to date from events.db
// (new rows, edited rows, deleted rows), renames it back to events, restores the main file's card-fates trigger and
// clears the moved marker, in one transaction. Then events.db is set aside as events.db.unsplit-<time>, so nothing
// reads it. A main file with no events_old (the server drops it once every row is in events.db, #1169 ship 3) gets a
// new events table filled from events.db, which holds the whole log, so the tool works the same after the drop.
import { renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CHAT, MOVED_KEY, cardFatesTrigger, eventsPath, eventsSchema } from '../src/events-db.ts';

export function unsplitEvents(dbPath: string): { rows: number; setAside: string } {
  const file = eventsPath(dbPath)!;
  const db = new DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    db.prepare(`ATTACH DATABASE ? AS ${CHAT}`).run(file);
    const has = (schema: string, name: string) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    if (!has(CHAT, 'events')) throw new Error(`${file} has no events table: nothing to put back.`);
    if (has('main', 'events')) throw new Error(`${dbPath} already has its events in the main file.`);
    const cols = 'id, ticket_id, kind, data, created_at';
    db.exec('BEGIN IMMEDIATE');
    try {
      if (has('main', 'events_old')) {
        db.exec(`DELETE FROM main.events_old WHERE id NOT IN (SELECT id FROM ${CHAT}.events);
          INSERT OR REPLACE INTO main.events_old (${cols}) SELECT ${cols} FROM ${CHAT}.events c WHERE NOT EXISTS (SELECT 1 FROM main.events_old o
            WHERE o.id = c.id AND o.ticket_id = c.ticket_id AND o.kind = c.kind AND o.data = c.data AND o.created_at = c.created_at);
          ALTER TABLE main.events_old RENAME TO events;`);
      } else {
        db.exec(`${eventsSchema('main')} INSERT INTO main.events (${cols}) SELECT ${cols} FROM ${CHAT}.events ORDER BY id;`);
      }
      db.exec(`${eventsSchema('main')} ${cardFatesTrigger('main')}`);
      db.prepare('DELETE FROM main.settings WHERE key = ?').run(MOVED_KEY);
      const n = (s: string) => (db.prepare(`SELECT count(*) AS n FROM ${s}.events`).get() as { n: number }).n;
      const rows = n('main');
      if (rows !== n(CHAT)) throw new Error(`the main file would have ${rows} events and events.db has ${n(CHAT)}; nothing changed.`);
      db.exec('COMMIT');
      db.exec(`PRAGMA ${CHAT}.journal_mode = DELETE; DETACH DATABASE ${CHAT};`); // folds events.db's WAL in, so the one file holds it all
      const setAside = `${file}.unsplit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(file, setAside);
      return { rows, setAside };
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [path, flag] = process.argv.slice(2);
  if (!path || flag !== '--service-stopped') {
    console.error('Usage: node tools/events-unsplit.ts <coordinator.db> --service-stopped\nStop the service first: a running server keeps writing to events.db.');
    process.exit(2);
  }
  const { rows, setAside } = unsplitEvents(path);
  console.log(`Put ${rows} events back in ${path}; events.db is now ${setAside}.`);
}
