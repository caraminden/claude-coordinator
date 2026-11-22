// The chat log (the events table) in a file of its own beside the database, events.db, attached as `chat` (#1169):
// it was 1.67 GB of the 2 GB main file, which every deploy's boot check copies (the Nov 10 jam was that copy timing
// out). A database not yet moved keeps its events in the main file, and they win by name: SQLite looks for an
// unqualified table in main before any attached file, so every query reads `events` wherever it lives.
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const EVENTS_FILE = 'events.db';
/** The schema name events.db is attached under. */
export const CHAT = 'chat';
/** Set once a database's events have moved to events.db: from then on a missing events.db is an error, never an empty chat log. */
export const MOVED_KEY = 'events_moved';

/** events.db beside coordinator.db, `<name>.events` beside any other file (tests keep several in one folder; no .db, so backup globs skip it); null in memory. */
export function eventsPath(dbPath: string): string | null {
  if (dbPath === ':memory:') return null;
  const name = basename(dbPath);
  return join(dirname(dbPath), name === 'coordinator.db' ? EVENTS_FILE : `${name}.events`);
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

/** Attach events.db as `chat` on a connection that writes it, made WAL like the main file. */
export function attachEventsForWrite(db: DatabaseSync, file: string) {
  db.prepare(`ATTACH DATABASE ? AS ${CHAT}`).run(file);
  db.exec(`PRAGMA ${CHAT}.journal_mode = WAL; PRAGMA ${CHAT}.synchronous = NORMAL; PRAGMA ${CHAT}.journal_size_limit = 16777216;`);
}

/**
 * Move the events from the main file into events.db (attached as `chat`), in two commits, since SQLite doesn't commit
 * two WAL files as one: copy them and check every row arrived (same id, minion, kind, time and size), then rename the
 * main table to events_old and mark the database moved. A crash between the two leaves the main table in charge and
 * the next start drops that copy and makes it again. Renaming is instant; the server drops events_old afterwards in
 * batches (dropEventsOld), and tools/events-unsplit.ts puts the chat log back with or without it.
 */
export function moveEvents(db: DatabaseSync, file: string): { rows: number; ms: number } {
  const started = Date.now();
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  // Moved already, yet the main file has events again: a release older than the one that reads events.db ran without
  // tools/events-unsplit.ts and wrote new events there, whose ids collide with events.db's. Merging either way loses rows.
  if (eventsMoved(db) || hasTable(db, 'main', 'events_old'))
    throw new Error(`The chat log moved to ${file}, but the main file has an events table again: an older release wrote it after the move. Nothing was changed; merge the two by hand (their ids collide) or restore both files from backups/.`);
  // A copy left by a move that stopped before its second commit is stale: the main file stayed in charge since.
  db.exec(`BEGIN IMMEDIATE;
    DROP TABLE IF EXISTS ${CHAT}.events;
    CREATE TABLE ${CHAT}.events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO ${CHAT}.events (id, ticket_id, kind, data, created_at) SELECT id, ticket_id, kind, data, created_at FROM main.events ORDER BY id;
    ${eventsSchema(CHAT)}
    COMMIT;`);
  const rows = n('SELECT count(*) AS n FROM main.events');
  // octet_length reads each value's size from its row header, not the text itself.
  const same = n(`SELECT count(*) AS n FROM main.events m JOIN ${CHAT}.events c ON c.id = m.id
    WHERE c.ticket_id = m.ticket_id AND c.kind = m.kind AND c.created_at = m.created_at AND octet_length(c.data) = octet_length(m.data)`);
  if (same !== rows) throw new Error(`Moving the chat log to ${file}: ${rows - same} of ${rows} events didn't arrive whole, so the main file keeps them; nothing was renamed.`);
  db.exec(`BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS main.card_fates_events_deleted;
    ALTER TABLE main.events RENAME TO events_old;
    INSERT OR REPLACE INTO main.settings (key, value) VALUES ('${MOVED_KEY}', '${Date.now()}');
    COMMIT;`);
  return { rows, ms: Date.now() - started };
}

/** Rows deleted per commit when dropping events_old: on a copy of the live file (2026-11-21) 2,000 took at most 69 ms each, 7.9 s for all 1,088,907, where one DROP of 1.6 GB took 33 s in one write. */
export const DROP_OLD_BATCH = 2000;

export type DropOld = { rows: number; ms: number; beforeMb: number; afterMb: number } | { missing: number };

/**
 * Drop the main file's copy of the chat log from before the move (events_old, #1169 ship 3), then VACUUM the main file
 * to give its space back (2,165 MB to 271 MB on a copy). Only once every events_old id is in events.db: with any missing
 * it changes nothing and says how many, since then events.db isn't the whole log (one put back from an older
 * events-<day>.db, or the boot check's copy, which holds only open chats). It deletes in batches of `batch`, each its
 * own commit, so no write holds the lock for long and the WAL checkpoints as it goes, and drops the empty table last; a
 * stop part way leaves fewer rows for the next start, and one between the drop and the VACUUM leaves the space free,
 * which the next start vacuums (over half the file and `minFreeMb` free). Null when there is nothing to do.
 */
export function dropEventsOld(db: DatabaseSync, { batch = DROP_OLD_BATCH, minFreeMb = 100 } = {}): DropOld | null {
  const started = Date.now();
  const pragma = (k: 'page_count' | 'page_size' | 'freelist_count') => (db.prepare(`PRAGMA main.${k}`).get() as Record<string, number>)[k];
  const mb = (pages: number) => Math.round((pages * pragma('page_size')) / 1e6);
  const old = hasTable(db, 'main', 'events_old');
  if (old ? !eventsMoved(db) || eventsHome(db) !== CHAT : pragma('freelist_count') * 2 < pragma('page_count') || mb(pragma('freelist_count')) < minFreeMb) return null;
  const beforeMb = mb(pragma('page_count'));
  let rows = 0;
  if (old) {
    const { missing } = db.prepare(`SELECT count(*) AS missing FROM main.events_old o WHERE NOT EXISTS (SELECT 1 FROM ${CHAT}.events c WHERE c.id = o.id)`).get() as { missing: number };
    if (missing) return { missing };
    const del = db.prepare(`DELETE FROM main.events_old WHERE id IN (SELECT id FROM main.events_old ORDER BY id LIMIT ${batch})`);
    for (let changed; (changed = Number(del.run().changes)); ) rows += changed;
    db.exec('DROP TABLE main.events_old');
  }
  db.exec('VACUUM main; PRAGMA main.wal_checkpoint(TRUNCATE);');
  return { rows, ms: Date.now() - started, beforeMb, afterMb: mb(pragma('page_count')) };
}

/** What dropEventsOld did, for the server's log. */
function saidDrop(d: DropOld | null): string | null {
  if (!d) return null;
  if ('missing' in d) return `Kept the main file's old copy of the chat log (events_old): ${d.missing} of its events aren't in events.db, so events.db may not hold the whole log. Find out why before dropping it by hand.`;
  const what = d.rows ? `Dropped the main file's old copy of the chat log (events_old, ${d.rows} events) and vacuumed it` : 'Vacuumed the main file, over half of it free (as a start stopped between dropping events_old and its VACUUM leaves it)';
  return `${what}: ${d.beforeMb} MB to ${d.afterMb} MB in ${d.ms} ms.`;
}

/**
 * The server's move, on a worker thread before it opens the database: the event loop keeps pinging systemd's watchdog
 * (60 s, deploy/claude-coordinator.service.d/watchdog.conf) through a move that took ~30 s on a copy. Then the same
 * worker drops the main file's old copy (dropEventsOld: 12-29 s on copies of the live file). Resolves to what it did, or
 * null when there was nothing to do.
 */
export function moveEventsOffThread(dbPath: string): Promise<string | null> {
  return new Promise((ok, no) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { moveEvents: dbPath } });
    let said: string | null = null;
    worker.once('message', (m) => (said = m));
    worker.once('error', no);
    // On exit, not on its message: by then it has closed the database, so the Store opening next never waits on it.
    worker.once('exit', (code) => (code ? no(new Error(`the chat log move's worker exited with ${code}`)) : ok(said)));
  });
}

if (!isMainThread && workerData?.moveEvents) {
  const path: string = workerData.moveEvents;
  const db = new DatabaseSync(path, { timeout: 30_000 });
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    attachEventsForWrite(db, eventsPath(path)!);
    const done = eventsHome(db) === 'main' ? moveEvents(db, eventsPath(path)!) : null;
    const moved = done && `Moved the chat log to ${eventsPath(path)}: ${done.rows} events in ${done.ms} ms.`;
    const dropped = saidDrop(dropEventsOld(db));
    parentPort!.postMessage([moved, dropped].filter(Boolean).join(' ') || null);
  } finally {
    db.close();
  }
}
