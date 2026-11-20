// The nightly backup Citadel ships off the box (the #828 convention): a finished copy of the database in
// DATA_DIR/backups/<YYYY-MM-DD>/, written before 04:00 Pacific. Citadel hard-links the newest 7 days to
// Cara's desktop; it never copies anything else in DATA_DIR. Anything new the app keeps in DATA_DIR
// (uploads, a second database) goes into this copy too, or it isn't backed up.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './db.ts';

export const KEEP_DAYS = 14;

/** Copy the database into today's folder and drop folders past KEEP_DAYS. Returns the folder written. */
export function backup(dataDir: string, day = new Date().toISOString().slice(0, 10)): string {
  const root = join(dataDir, 'backups');
  const out = join(root, day);
  mkdirSync(out, { recursive: true });
  const src = join(dataDir, DB_FILE);
  let failed = false;
  if (existsSync(src)) {
    // VACUUM INTO won't overwrite, and a failed copy must not replace a good one from earlier today.
    const tmp = join(out, `${DB_FILE}.tmp`);
    rmSync(tmp, { force: true });
    try {
      const db = new DatabaseSync(src, { readOnly: true });
      try {
        db.prepare('VACUUM INTO ?').run(tmp);
      } finally {
        db.close();
      }
      renameSync(tmp, join(out, DB_FILE));
    } catch (err) {
      failed = true;
      rmSync(tmp, { force: true });
      console.error(`backup: ${(err as Error).message}`);
    }
  }
  const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const keep = new Set(days.slice(-KEEP_DAYS));
  // A night that failed keeps the newest good copy, however old.
  if (failed) keep.add(days.findLast((d) => existsSync(join(root, d, DB_FILE))) ?? '');
  for (const old of days) if (!keep.has(old)) rmSync(join(root, old), { recursive: true, force: true });
  if (failed) throw new Error('backup failed: see above');
  return out;
}
