// Backup freshness (#1142): one reading of the nightly backups, for the Status page's line and the watchdog's push.
// Reads files only and changes no backup: the newest database backup (deploy/backup.sh) and its size, when the desktop
// last pulled the off-box copy (deploy/offbox-serve.sh touches offbox/.pulled), when that set was last made (offbox.sh
// renames SHA256SUMS into place only once every step before it passed), and which apps wrote a dated folder
// under their own DATA_DIR/backups/<day>/ (the #828 convention, before 04:00 PST).
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pacificDay } from './pacific.ts';

const HOUR = 3_600_000;
/** A database backup older than this missed a night (the job runs every 24 h). */
export const DB_STALE_H = 26;
/** The desktop pulls nightly; this much quiet means it missed one. */
export const PULL_STALE_H = 36;

export interface AppBackup {
  name: string;
  title: string;
  day: string | null;
  ok: boolean;
}
export interface BackupInfo {
  db: { at: number; size: number } | null;
  /** null: nothing has pulled yet (or off-box isn't set up here). */
  pulledAt: number | null;
  /** When the off-box set was last made (SHA256SUMS); null: off-box isn't set up here. */
  setAt: number | null;
  apps: AppBackup[];
}

const newest = async (dir: string, pattern: RegExp): Promise<string | null> => {
  try {
    return (
      (await readdir(dir))
        .filter((f) => pattern.test(f))
        .sort()
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
};

/** An app's newest dated backup folder with something in it, and whether that is recent enough: today's or yesterday's Pacific day, with slack. Async: the server's thread never waits on the disk for it (#1878). */
export async function appBackup(appData: string, now: number): Promise<{ day: string | null; ok: boolean }> {
  const backups = join(appData, 'backups');
  const days = await readdir(backups).then(
    (fs) =>
      fs
        .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
        .sort()
        .reverse(),
    () => [] as string[],
  );
  let day: string | null = null;
  for (const d of days) {
    const has = await readdir(join(backups, d)).then(
      (fs) => fs.some((f) => !f.startsWith('.')),
      () => false,
    );
    if (has) {
      day = d;
      break;
    }
  }
  return { day, ok: !!day && day >= pacificDay(now - 30 * HOUR) };
}

export async function readBackups(dataDir: string, home: string, apps: { name: string; title: string }[], now: number): Promise<BackupInfo> {
  const dir = join(dataDir, 'backups');
  const file = await newest(dir, /^coordinator-\d{4}-\d{2}-\d{2}\.db$/);
  let db: BackupInfo['db'] = null;
  try {
    if (file) {
      const s = await stat(join(dir, file));
      db = { at: s.mtimeMs, size: s.size };
    }
  } catch {} // gone between the listing and the stat: no backup to report
  const mtime = (f: string) =>
    stat(join(dataDir, 'offbox', f)).then(
      (s) => s.mtimeMs,
      () => null,
    );
  const [pulledAt, setAt, rows] = await Promise.all([mtime('.pulled'), mtime('SHA256SUMS'), Promise.all(apps.map(async (a) => ({ name: a.name, title: a.title, ...(await appBackup(join(home, '.local/share', a.name), now)) })))]);
  return { db, pulledAt, setAt, apps: rows };
}

/**
 * What is missing, in words, for the alert and the line's colour. An app that never wrote a backup isn't listed (only
 * Mandate was known to, 2026-11-19); one that did and stopped is. A never-pulled off-box copy isn't a miss yet.
 */
export function backupProblems(b: BackupInfo, now: number): string[] {
  const out: string[] = [];
  if (!b.db) out.push('no database backup on disk');
  else if (now - b.db.at > DB_STALE_H * HOUR) out.push(`the database backup is ${Math.round((now - b.db.at) / HOUR)} h old`);
  // .pulled is touched on every list, so a fresh pull can be of an old set: a failed state-db check or off-box step leaves SHA256SUMS behind.
  if (b.setAt === null && b.pulledAt !== null) out.push('the off-box set is missing (no SHA256SUMS)');
  else if (b.setAt !== null && now - b.setAt > DB_STALE_H * HOUR) out.push(`the off-box set was last made ${Math.round((now - b.setAt) / HOUR)} h ago`);
  if (b.pulledAt !== null && now - b.pulledAt > PULL_STALE_H * HOUR) out.push(`the off-box copy was last pulled ${Math.round((now - b.pulledAt) / HOUR)} h ago`);
  for (const a of b.apps) if (a.day && !a.ok) out.push(`${a.title} last wrote a backup on ${a.day}`);
  return out;
}
