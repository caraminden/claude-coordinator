// The chat log (the events table) in a file of its own beside the database, events.db, attached as `chat` (#1169):
// it was 1.67 GB of the 2 GB main file, which every deploy's boot check copies (the Nov 10 jam was that copy timing
// out). A database not yet moved keeps its events in the main file, and they win by name: SQLite looks for an
// unqualified table in main before any attached file, so every query reads `events` wherever it lives.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const EVENTS_FILE = 'events.db';
/** The schema name events.db is attached under. */
export const CHAT = 'chat';
/** Set once a database's events have moved to events.db: from then on a missing events.db is an error, never an empty chat log. */
export const MOVED_KEY = 'events_moved';

/** events.db beside a database file; null for an in-memory database. */
export function eventsPath(dbPath: string): string | null {
  return dbPath === ':memory:' ? null : join(dirname(dbPath), EVENTS_FILE);
}

/**
 * The events table and its indexes in `schema`. In main it keeps its link to tickets; SQLite can't link across files,
 * so in events.db deleteTicket clears a minion's events by hand (it always has).
 */
export function eventsSchema(schema: string, linkTickets = schema === 'main'): string {
  const fk = linkTickets ? ' REFERENCES tickets(id)' : '';
  return `
CREATE TABLE IF NOT EXISTS ${schema}.events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL${fk},
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${schema}.events_ticket ON events(ticket_id, id);
-- A minion's events of one kind without reading its whole history: its open cards (openCardsWhere, #527).
CREATE INDEX IF NOT EXISTS ${schema}.events_ticket_kind ON events(ticket_id, kind, id);
-- A scheme's cards without a seek into every minion's events (recentCards, #759): partial, so no other query's plan can change.
CREATE INDEX IF NOT EXISTS ${schema}.events_cards ON events(ticket_id, kind) WHERE kind IN ('question', 'plan', 'approval');
-- Error events by time, for the post-deploy watch's turnOutcomes (#1178): partial, so it holds only the few error rows and no other query's plan can change.
CREATE INDEX IF NOT EXISTS ${schema}.events_errors ON events(created_at) WHERE kind = 'error';
-- Notes and people's messages by id (#1251), partial like events_errors: Home's ship notes walked every claude row since a
-- visit (13.6 s of the loop), and the memory indexer seeked into every minion of a scheme for new messages (23 s on a busy disk).
CREATE INDEX IF NOT EXISTS ${schema}.events_notes ON events(id) WHERE kind = 'note';
CREATE INDEX IF NOT EXISTS ${schema}.events_asks ON events(id, ticket_id) WHERE kind = 'user_message';
`;
}

/**
 * Any deleted event drops every saved card fate, whichever release deletes it (after a rollback an older one does, and the
 * ids it frees get reused): the fates are read again from the chats. A trigger in main can't watch a table in another
 * file, so with events in events.db it is a TEMP trigger, made on each connection that writes (the server's and the
 * write worker's).
 */
export function cardFatesTrigger(where: 'main' | typeof CHAT): string {
  return `CREATE ${where === CHAT ? 'TEMP ' : ''}TRIGGER IF NOT EXISTS card_fates_events_deleted AFTER DELETE ON ${where === CHAT ? `${CHAT}.` : ''}events
WHEN EXISTS (SELECT 1 FROM card_fates LIMIT 1)
BEGIN DELETE FROM card_fates; END;`;
}

const hasTable = (db: DatabaseSync, schema: string, name: string) =>
  !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/** Where a connection's events table is: main (not yet moved), chat (events.db), or none yet (a new database). */
export function eventsHome(db: DatabaseSync): 'main' | typeof CHAT | null {
  if (hasTable(db, 'main', 'events')) return 'main';
  const attached = (db.prepare('PRAGMA database_list').all() as { name: string }[]).some((d) => d.name === CHAT);
  return attached && hasTable(db, CHAT, 'events') ? CHAT : null;
}

/** True once this database's events have moved to events.db (MOVED_KEY in its settings). */
export function eventsMoved(db: DatabaseSync): boolean {
  return hasTable(db, 'main', 'settings') && !!db.prepare('SELECT 1 FROM main.settings WHERE key = ?').get(MOVED_KEY);
}

/**
 * Attach events.db to a connection that opened the database file on its own (a read-only tool, a worker), so `events`
 * resolves wherever it lives. Only if the file is there: attaching on a read-only connection can't make one, and a
 * database not yet moved needs none. Not inside a transaction (SQLite refuses an ATTACH there).
 */
export function attachEventsIfThere(db: DatabaseSync, dbPath: string): boolean {
  const file = eventsPath(dbPath);
  if (!file || !existsSync(file)) return false;
  db.prepare(`ATTACH DATABASE ? AS ${CHAT}`).run(file);
  return true;
}
