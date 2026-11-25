import { existsSync, mkdtempSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Room a restart-anywhere run needs in /dev/shm at its peak, with margin (measured peak about 48 MB on disk). */
export const SHM_NEEDED = 100 * 1024 * 1024;

/** Free bytes on a path, or 0 when it can't be read. */
export function freeBytes(path: string): number {
  try {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}

/** TEST_ROOT_ON_DISK=1 forces disk (for timing). /dev/shm only when it exists and has room for the run; else normal disk, so a full memory disk never fails a run. */
export function pickRoot(prefix: string, needed = SHM_NEEDED, free: (p: string) => number = freeBytes, shm = '/dev/shm'): string {
  if (existsSync(shm) && !process.env.TEST_ROOT_ON_DISK) {
    try {
      if (free(shm) >= needed) return mkdtempSync(join(shm, prefix));
    } catch {
      /* not writable: fall through to disk */
    }
  }
  return mkdtempSync(join(tmpdir(), prefix));
}
