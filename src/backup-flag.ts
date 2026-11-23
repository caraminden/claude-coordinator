// Contraptions with a database but no backup (#1383). A periodic check (daily, plus once after boot; not at deploy, since
// an app's data grows after its deploy and a deploy-time check would miss a database created later): for each app whose
// DATA_DIR holds a SQLite file, it needs a `backup` timer and a `disk_warn_gb` in citadel-app.json (the #828 convention).
// An app missing either is flagged to its home scheme's Taskmaster as held mail, once per app per set of gaps: the
// last flagged set is kept in settings, so a restart or the next day says nothing, and a changed set says it again.
// Reads files only; it changes no app and no backup. Any scheme's app is checked: the Taskmaster is its home scheme's.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pacificDay } from './pacific.ts';

export const FLAG_KEY = 'backup-flag';
const DB_FILE = /\.(db|sqlite|sqlite3)$/i;

/** Whether `dir` holds a non-empty SQLite file within two levels, skipping backups/ (a copy isn't the app's own).
 *  Async, and it stats only names that look like a database: a data folder can hold thousands of files (#1735). */
export async function hasDatabase(dir: string, depth = 2): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (depth === 2 && e.name === 'backups') continue;
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) { if (depth > 1 && await hasDatabase(p, depth - 1)) return true; continue; }
      if (DB_FILE.test(e.name)) { const st = await stat(p); if (st.isFile() && st.size > 0) return true; }
    } catch {} // gone between the listing and the stat
  }
  return false;
}

/** What an app lacks, in words: [] when it follows the convention (or has no database). */
export function backupGaps(hasDb: boolean, manifest: { timers: Record<string, unknown>; disk_warn_gb: number | null }): string[] {
  if (!hasDb) return [];
  const gaps: string[] = [];
  if (!manifest.timers.backup) gaps.push('no `backup` timer');
  if (manifest.disk_warn_gb == null) gaps.push('no `disk_warn_gb`');
  return gaps;
}

export interface FlagApp { name: string; title: string; home_scheme: number | null }
export interface FlagDeps<A extends FlagApp = FlagApp> {
  apps(): A[];
  dataDir(app: A): string;
  manifest(app: A): Promise<{ timers: Record<string, unknown>; disk_warn_gb: number | null }>;
  /** The home scheme's Taskmaster ticket id, or null when it has none. */
  taskmaster(scheme: number): number | null;
  mail(taskmasterId: number, text: string): void;
  getState(): Record<string, string>;
  setState(s: Record<string, string>): void;
}

/** The setting's key for the Pacific day of the last round (not an app name: it has a space). */
export const RAN_KEY = ' ran';

/** One round: the gaps of every app with a database, flagged where they're new. Returns the apps flagged now.
 *  `oncePerDay`: skip when a round already ran this Pacific day, so restarts don't repeat it. Rows saved before
 *  this have no day and run once. */
export async function flagUnbacked<A extends FlagApp>(d: FlagDeps<A>, opts: { oncePerDay?: boolean; now?: number } = {}): Promise<{ app: string; gaps: string[] }[]> {
  const state = { ...d.getState() };
  const today = pacificDay(opts.now ?? Date.now());
  if (opts.oncePerDay && state[RAN_KEY] === today) return [];
  const flagged: { app: string; gaps: string[] }[] = [];
  for (const app of d.apps()) {
    let gaps: string[] = [];
    try {
      gaps = backupGaps(await hasDatabase(d.dataDir(app)), await d.manifest(app));
    } catch {
      continue; // no readable manifest: not this check's to say
    }
    if (!gaps.length) { delete state[app.name]; continue; } // fixed: a later regression flags again
    const sig = gaps.join('|');
    if (state[app.name] === sig || app.home_scheme == null) continue;
    const tm = d.taskmaster(app.home_scheme);
    if (tm == null) continue; // tried again next round
    d.mail(tm, `${app.title} (${app.name}) keeps a database but has ${gaps.join(' and ')} in its citadel-app.json. Its data has no nightly backup or no disk-space warning until the app adopts the convention: the template's tools/backup.ts, a \`timers.backup\` entry and \`disk_warn_gb\` (kit skill contraption-ui, new-app template; Citadel #828). Flagged once; it flags again only if the gaps change.`);
    state[app.name] = sig;
    flagged.push({ app: app.name, gaps });
  }
  state[RAN_KEY] = today;
  d.setState(state);
  return flagged;
}
