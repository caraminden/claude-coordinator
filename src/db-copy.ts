// A consistent copy of a database another process keeps writing (the live server, in WAL mode).
import { access, rm } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { eventsPath, eventsSchema } from './events-db.ts';

/**
 * Copy `src` to `dest` in one backup step, so one read transaction. SQLite restarts a backup whenever
 * another connection writes the source between steps, so the default (100 pages a step) never ends
 * while busy turns keep writing a large database (#497). In WAL mode the one step blocks no writer.
 * The chat log's own file beside it (events.db, #1169) comes too: all of it, or with `events: 'open'` only
 * the chats of minions still open (the boot check's, 116 MB of 1.7 GB on 2026-11-21). The two files are two
 * read transactions, so a copy can be a few events apart from its main file: fine for a copy that is only read
 * or tried out, which every caller's is.
 */
export async function copyDb(src: string, dest: string, { events = 'all' }: { events?: 'all' | 'open' } = {}): Promise<void> {
  await copyFile(src, dest);
  const from = eventsPath(src)!;
  const to = eventsPath(dest)!;
  await Promise.all([to, `${to}-wal`, `${to}-shm`].map((f) => rm(f, { force: true })));
  if (
    !(await access(from).then(
      () => true,
      () => false,
    ))
  )
    return; // a database not yet moved, from before events.db
  if (events === 'all') return copyFile(from, to);
  // A busy timeout: the attached source is a live writer's file, and the default of 0 fails at once with "database is locked" (#1632).
  const db = new DatabaseSync(to, { timeout: 30_000 });
  try {
    db.prepare('ATTACH DATABASE ? AS src').run(from);
    db.prepare('ATTACH DATABASE ? AS copy').run(dest);
    if (!db.prepare("SELECT 1 FROM src.sqlite_master WHERE type = 'table' AND name = 'events'").get()) return;
    db.exec(`BEGIN; ${eventsSchema('main', false)}
      INSERT INTO main.events (id, ticket_id, kind, data, created_at) SELECT id, ticket_id, kind, data, created_at FROM src.events WHERE ticket_id IN (SELECT id FROM copy.tickets WHERE status != 'closed');
      COMMIT; PRAGMA main.journal_mode = WAL;`);
  } finally {
    db.close();
  }
}

async function copyFile(src: string, dest: string) {
  const live = new DatabaseSync(src, { readOnly: true, timeout: 30_000 });
  try {
    await backup(live, dest, { rate: 2 ** 31 - 1 });
  } finally {
    live.close();
  }
}
