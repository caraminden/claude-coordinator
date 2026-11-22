// Keeps coordinator.db and its -wal in the box's memory (#1560). perigee evicts file cache from the server's group even with
// gigabytes free, so the server's one thread spent 8 to 9% of its time waiting for database pages to come off disk (#1537).
// Measured there: a file read once was 5% in memory 16 s later; re-read every 5 s it stayed at 100%, every 15 s it did not.
// So a worker thread reads both files end to end every WARM_MS. It never touches SQLite and never the event loop.
//
// It limits itself: a pass that read at under SLOW_MB_S means the pages were coming off disk. After SLOW_PASSES of those in a row
// it waits BACKOFF_MS before the next pass (and counts that), so it can't become the box's top disk reader. One pass at a time:
// a pass longer than the period just delays the next, nothing queues.
import { closeSync, openSync, readSync } from 'node:fs';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import type { Store } from './db.ts';

export const WARM_MS = 5000;
export const SLOW_MB_S = 200;
export const SLOW_PASSES = 3;
export const BACKOFF_MS = 30_000;
/** A pass smaller than this says nothing about the disk's speed: it is not counted as slow. */
export const MIN_MB_FOR_SPEED = 8;
export const WARMER_SETTING = 'db-warmer';
const CHUNK = 1 << 20;

/** The last pass as the Status page's sample stores it; backoffs counts since the server started. */
export interface WarmStats { ms: number; mb: number; backoffs: number }

/** Reads `fd` to its end, `chunk` bytes at a time into `buf`; the bytes read. */
export function readThrough(fd: number, buf: Buffer): number {
  let pos = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) return pos;
    pos += n;
  }
}

/** Decides the wait after a pass: tracks passes in a row that were slower than SLOW_MB_S, and says when to back off. */
export class Pacer {
  private slow = 0;
  /** Returns the ms to wait before the next pass, and whether this pass began a backoff. */
  after(mb: number, ms: number, everyMs = WARM_MS): { wait: number; backoff: boolean } {
    const speed = mb / Math.max(ms, 0.001) * 1000;
    if (mb >= MIN_MB_FOR_SPEED && speed < SLOW_MB_S) this.slow++; else this.slow = 0;
    if (this.slow >= SLOW_PASSES) { this.slow = 0; return { wait: BACKOFF_MS, backoff: true }; }
    return { wait: Math.max(0, everyMs - ms), backoff: false };
  }
}

export interface Warmer { worker: Worker; stats: () => WarmStats; stop: () => void }

/**
 * Starts the warmer for the store's database. The `db-warmer` setting (false turns it off, no restart: a timer here carries it to the
 * worker every 5 s). Null for an in-memory store.
 */
export function warmDatabase(store: Store, everyMs = WARM_MS, settingMs = 5000): Warmer | null {
  if (!store.statePath) return null;
  // [last pass ms, last pass MB, backoffs]; and one flag, 1 = on.
  const shared = new Float64Array(new SharedArrayBuffer(8 * 3));
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), { workerData: { warm: { path: store.path, everyMs, shared, flag } }, trackUnmanagedFds: false });
  worker.unref();
  const apply = () => { try { Atomics.store(flag, 0, store.getSetting<boolean>(WARMER_SETTING) === false ? 0 : 1); } catch { /* keep the last value */ } };
  apply();
  const timer = setInterval(apply, settingMs);
  timer.unref();
  worker.on('error', (err) => console.error(`Database warmer failed: ${err?.message ?? err}`));
  worker.once('exit', () => clearInterval(timer));
  return { worker, stats: () => ({ ms: shared[0], mb: shared[1], backoffs: shared[2] }), stop: () => { clearInterval(timer); void worker.terminate(); } };
}

if (!isMainThread && workerData?.warm) {
  const { path, everyMs, shared, flag } = workerData.warm as { path: string; everyMs: number; shared: Float64Array; flag: Int32Array };
  const buf = Buffer.allocUnsafe(CHUNK);
  // The database's own fd is opened once and never closed: closing any fd on a file drops the process's SQLite locks on it (#860).
  // The Worker is made with trackUnmanagedFds: false, so even this worker's exit leaves it open.
  // The -wal takes none, so it is opened afresh each pass (a checkpoint can restart it).
  let dbFd: number | null = null;
  const pacer = new Pacer();
  const pass = () => {
    const t0 = performance.now();
    let bytes = 0;
    try {
      dbFd ??= openSync(path, 'r');
      bytes += readThrough(dbFd, buf);
    } catch (err: any) { if (err?.code !== 'ENOENT') console.error(`Database warmer: reading the database: ${err?.message ?? err}`); }
    try {
      const fd = openSync(`${path}-wal`, 'r');
      try { bytes += readThrough(fd, buf); } finally { closeSync(fd); }
    } catch (err: any) { if (err?.code !== 'ENOENT') console.error(`Database warmer: reading the WAL: ${err?.message ?? err}`); }
    return { bytes, ms: performance.now() - t0 };
  };
  const loop = () => {
    let wait = everyMs;
    if (Atomics.load(flag, 0) !== 1) {
      shared[0] = 0; shared[1] = 0; // off: no stale pass for the Status page to show
    } else {
      const { bytes, ms } = pass();
      const mb = bytes / 1048576;
      const p = pacer.after(mb, ms, everyMs);
      shared[0] = Math.round(ms * 10) / 10; shared[1] = Math.round(mb * 10) / 10;
      if (p.backoff) shared[2]++;
      wait = p.wait;
    }
    setTimeout(loop, wait);
  };
  loop();
}
