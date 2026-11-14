// SQLite's WAL checkpoints, run on a worker thread of their own (#680). A checkpoint copies the WAL into the
// database and fsyncs both; left to SQLite, whichever commit pushed the WAL past 1000 pages ran it on the event
// loop, so a write as small as a setting held every person's page and every minion's tool call for as long as
// perigee's disk stalled (10.5 s once). With WAL and synchronous=NORMAL a commit itself doesn't fsync.
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { Store } from './db.ts';

export const CHECKPOINT_MS = 10_000;

/**
 * From now on the store's connection never checkpoints: a worker with its own connections to coordinator.db and
 * state.db does, every `everyMs`, PASSIVE so it never waits on or blocks a writer. If the worker stops, the
 * connection goes back to checkpointing itself. Null for an in-memory store.
 */
export function checkpointOffThread(store: Store, everyMs = CHECKPOINT_MS): Worker | null {
  if (!store.statePath) return null;
  const worker = new Worker(new URL(import.meta.url), { workerData: { checkpoint: { paths: [store.path, store.statePath], everyMs } } });
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
  const { paths, everyMs } = workerData.checkpoint as { paths: string[]; everyMs: number };
  const dbs = paths.map((p) => new DatabaseSync(p, { timeout: 5000 }));
  setInterval(() => {
    dbs.forEach((db, i) => {
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      } catch (err: any) {
        // A busy database just waits for the next round.
        console.error(`WAL checkpoint of ${paths[i]}: ${err?.message ?? err}`);
      }
    });
    parentPort!.postMessage('checkpointed');
  }, everyMs);
}
