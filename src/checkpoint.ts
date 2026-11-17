// SQLite's WAL checkpoints, run on a worker thread of their own (#680). A checkpoint copies the WAL into the
// database and fsyncs both; left to SQLite, whichever commit pushed the WAL past 1000 pages ran it on the event
// loop, so a write as small as a setting held every person's page and every minion's tool call for as long as
// perigee's disk stalled (10.5 s once). With WAL and synchronous=NORMAL a commit itself doesn't fsync, except one:
// the first write after a checkpoint that emptied the WAL starts the WAL over and fsyncs its new header, on the
// writer's thread. Checkpointing every 10 s made that the event loop's fsync every 10 s (holds up to 14.3 s on
// one-row writes, #791). So the worker lets the WAL fill first, and meanwhile only fsyncs it.
import { closeSync, fsyncSync, openSync, readSync } from 'node:fs';
import { endianness } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { Store } from './db.ts';

export const CHECKPOINT_MS = 10_000;
/** A WAL this long (8 MB of 4 KB pages; live writes 10 to 50 pages a second) is checkpointed, or any WAL after MAX_WAIT_MS. */
export const WAL_PAGES = 2000;
export const MAX_WAIT_MS = 10 * 60_000;

// One -shm fd per database, opened once and never closed (#860). Closing any fd on a file drops every POSIX lock
// this process holds on it, SQLite's own included: with its -shm locks gone, the next process to open the database
// took itself for the first, truncated the -shm and re-initialised it, and the server's mmap of it died with SIGBUS.
const shmFds = new Map<string, number>();

/** How many frames a database's WAL holds, from its wal-index (-shm) header: mxFrame, 4 bytes at 16 in the machine's byte order. Null if unreadable. */
export function walFrames(dbPath: string): number | null {
  try {
    let fd = shmFds.get(dbPath);
    if (fd === undefined) shmFds.set(dbPath, (fd = openSync(`${dbPath}-shm`, 'r')));
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 16) < 4) return null;
    return endianness() === 'LE' ? b.readUInt32LE() : b.readUInt32BE();
  } catch {
    return null;
  }
}

/**
 * From now on the store's connection never checkpoints: a worker with its own connections to coordinator.db and
 * state.db does, PASSIVE so it never waits on or blocks a writer. Every `everyMs` it fsyncs each WAL (a power cut
 * still loses only the last few seconds, #470) and checkpoints one that has reached `walPages` or waited
 * `maxWaitMs`. If the worker stops, the connection goes back to checkpointing itself. Null for an in-memory store.
 */
export function checkpointOffThread(store: Store, everyMs = CHECKPOINT_MS, walPages = WAL_PAGES, maxWaitMs = MAX_WAIT_MS): Worker | null {
  if (!store.statePath) return null;
  const worker = new Worker(new URL(import.meta.url), { workerData: { checkpoint: { paths: [store.path, store.statePath], everyMs, walPages, maxWaitMs } } });
  worker.unref();
  store.autoCheckpoint(false);
  worker.on('error', (err) => console.error(`WAL checkpoint worker failed: ${err?.message ?? err}`));
  worker.once('exit', (code) => {
    store.autoCheckpoint(true);
    console.error(`WAL checkpoint worker stopped (exit code ${code}); the server's connection checkpoints itself again, on the event loop.`);
  });
  return worker;
}

if (!isMainThread && workerData?.checkpoint) {
  const { paths, everyMs, walPages, maxWaitMs } = workerData.checkpoint as { paths: string[]; everyMs: number; walPages: number; maxWaitMs: number };
  const dbs = paths.map((p) => new DatabaseSync(p, { timeout: 5000 }));
  const last = paths.map(() => Date.now());
  setInterval(() => {
    dbs.forEach((db, i) => {
      try {
        const frames = walFrames(paths[i]);
        if (frames !== null && frames < walPages && Date.now() - last[i] < maxWaitMs) {
          // Not yet: only make what's in the WAL safe from a power cut, as the checkpoint's own fsync did.
          // Closing this fd is safe, unlike one on -shm or the database: SQLite takes no locks on the -wal file.
          const fd = openSync(`${paths[i]}-wal`, 'r');
          try { fsyncSync(fd); } finally { closeSync(fd); }
          return;
        }
        db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        last[i] = Date.now();
      } catch (err: any) {
        // A busy database just waits for the next round.
        console.error(`WAL checkpoint of ${paths[i]}: ${err?.message ?? err}`);
      }
    });
    parentPort!.postMessage('checkpointed');
  }, everyMs);
}
