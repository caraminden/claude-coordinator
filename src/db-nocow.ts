// The live database in a no-copy-on-write file (#761). On btrfs with COW, every page SQLite rewrites in place
// lands in a new extent: coordinator.db reached 34k extents, and cold reads of it held the event loop for
// 0.6-1.5 s. A file made empty with `chattr +C` and then filled stays in place. This runs once at a start,
// before the Store opens the file, and does nothing on later starts (the file has C) or where the filesystem
// has no such attribute. Any failure leaves the old file where it was, and the server starts on it as before.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readdirSync, readlinkSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { thrown } from './thrown.ts';

/** The file system calls that differ between machines, for tests to stand in for. */
export type NoCowOps = {
  /** True if the file has btrfs's no-COW attribute, false if not, null where the filesystem has no attributes. */
  noCow(file: string): boolean | null;
  /** Set the no-COW attribute on an empty file; throws where it can't. */
  setNoCow(file: string): void;
  /** Other processes that have `file` open (by pid). */
  openBy(file: string): number[];
  /** Bytes free to this user on the filesystem holding `dir`. */
  freeBytes(dir: string): number;
};

export const hostOps: NoCowOps = {
  noCow(file) {
    try {
      // `lsattr -d`: one line, the flags then the name. A filesystem without attributes (tmpfs) fails.
      const flags = execFileSync('lsattr', ['-d', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(' ')[0];
      return flags.includes('C');
    } catch {
      return null;
    }
  },
  setNoCow(file) {
    execFileSync('chattr', ['+C', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  },
  openBy(file) {
    const pids: number[] = [];
    for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid)) {
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue; // gone, or another user's
      }
      for (const fd of fds) {
        try {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`) === file) {
            pids.push(Number(pid));
            break;
          }
        } catch {}
      }
    }
    return pids;
  },
  freeBytes(dir) {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  },
};

export type NoCowResult = { moved: boolean; note: string };

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Every table's row count, so the copy can be checked against the file it came from. */
function counts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]) {
    out[name] = Number((db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n);
  }
  return out;
}

function fsyncPath(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A Pacific-free, sortable stamp for the backup's name: 20261115-180102. */
const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');

/** The most the copy may take: the server isn't listening yet, and tools/deploy.sh rolls back a restart that isn't healthy in 30 s. */
export const COPY_BUDGET_MS = 20_000;
/** After a failed try, starts leave the file alone this long, so a fault that repeats costs one restart a day the copy. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Move `db` (a WAL-mode SQLite file only this process writes) into a no-COW file of the same name, keeping the
 * old one beside it as `<db>.backup-cow-<stamp>` (deploy/prune.sh drops it after 7 days, once a nightly backup
 * checks out). Call it before anything in this process opens the file. Never throws.
 */
export function moveToNoCow(db: string, ops: NoCowOps = hostOps, { now = new Date(), budgetMs = COPY_BUDGET_MS } = {}): NoCowResult {
  try {
    return move(db, ops, now, budgetMs);
  } catch (err) {
    return { moved: false, note: `left as it was: ${String(thrown(err).message ?? err).trim()}` };
  }
}

function move(db: string, ops: NoCowOps, now: Date, budgetMs: number): NoCowResult {
  const dir = dirname(db);
  const tmp = `${db}.nocow-tmp`;
  const failed = `${db}.nocow-failed`;
  const skip = (note: string): NoCowResult => ({ moved: false, note });
  if (!existsSync(db)) return skip('no database yet');
  const has = ops.noCow(db);
  if (has === null) return skip('this filesystem has no file attributes');
  if (has) {
    walNoCow(db, ops);
    return skip('already no-COW');
  }
  if (existsSync(failed)) {
    if (now.getTime() - statSync(failed).mtimeMs < RETRY_AFTER_MS) return skip(`an earlier try failed (${failed}); it tries again a day after, or once that file is deleted`);
    unlinkSync(failed);
  }
  // Left by a start that was killed partway: the temp copy (a journal of it would be rolled back onto the next
  // one), and a backup link to the file still in use.
  dropTmp(tmp);
  const ino = statSync(db).ino;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${basename(db)}.backup-cow-`) && statSync(join(dir, f)).ino === ino) unlinkSync(join(dir, f));
  }
  // Another process with the file open would keep the old one and share the new one's WAL. Only the server
  // writes it; a reader (the watchdog, a dev copy, sqlite3 -readonly) would read pages of one with the WAL of the other.
  const others = () => [...new Set([db, `${db}-wal`].flatMap((f) => ops.openBy(f)))];
  const open = others();
  if (open.length) return skip(`open in process ${open.join(', ')}, so it waits for a start when it isn't`);
  const size = statSync(db).size + (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);
  // The copy, and still the size of the database free after it: the old file stays as the backup.
  const free = ops.freeBytes(dir);
  if (free < 2 * size) return skip(`${Math.round(free / 2 ** 20)} MB free, and the copy needs ${Math.round((2 * size) / 2 ** 20)} MB`);

  const started = Date.now();
  // A failure from here leaves the marker, except one a moment's reader caused.
  let mark = true;
  try {
    closeSync(openSync(tmp, 'wx', 0o600));
    ops.setNoCow(tmp);
    if (ops.noCow(tmp) !== true) throw new Error('chattr +C did not take');
    // In a process of its own, so a cold disk can't hold the start past deploy's health wait: it's killed instead.
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), db, tmp], {
      argv0: 'citadel-server', // ananicy runs anything called node at idle priority (deploy/priority.md)
      timeout: budgetMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error || r.signal) throw new Error(r.signal ? `the copy took over ${budgetMs / 1000} s` : `the copy could not start: ${r.error!.message}`);
    if (r.status === BUSY) {
      mark = false;
      throw new Error('a reader held the WAL checkpoint');
    }
    if (r.status !== 0) throw new Error(`the copy failed: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
    // The copy's close, the last connection's, checkpointed and deleted the WAL. One with pages in it would be
    // replayed onto the new file.
    if (existsSync(`${db}-wal`) && statSync(`${db}-wal`).size > 0) {
      mark = false;
      throw new Error('the WAL still holds pages after the copy');
    }
    if (others().length) {
      mark = false;
      throw new Error(`process ${others().join(', ')} opened it during the copy`);
    }
    fsyncPath(tmp);
    const backup = `${db}.backup-cow-${stamp(now)}`;
    // The backup is a second name for the old file, so at every point `db` names a whole database.
    linkSync(db, backup);
    renameSync(tmp, db);
    fsyncPath(dir);
    walNoCow(db, ops);
    return { moved: true, note: `moved into a no-COW file in ${Date.now() - started} ms; the old file is ${basename(backup)}` };
  } catch (err) {
    try {
      dropTmp(tmp);
    } catch {}
    if (mark) {
      try {
        writeFileSync(failed, `${now.toISOString()} ${String(thrown(err).message ?? err).trim()}\n`);
      } catch {}
    }
    throw err;
  }
}

const BUSY = 3;

/**
 * The copy process: checkpoint the WAL into `db`, VACUUM INTO `tmp` (already made, empty, no-COW), and check the
 * copy against it. Exits 0 when the copy checks out, BUSY when a reader held the checkpoint.
 */
function copyInto(db: string, tmp: string): number {
  const src = new DatabaseSync(db, { timeout: 1000 });
  let before: Record<string, number>;
  try {
    const cp = src.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    if (cp.busy) return BUSY;
    before = counts(src);
    src.prepare('VACUUM INTO ?').run(tmp);
  } finally {
    src.close();
  }
  const copy = new DatabaseSync(tmp);
  try {
    const check = (copy.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
    if (check !== 'ok') throw new Error(`the copy's quick_check says ${check}`);
    if (JSON.stringify(counts(copy)) !== JSON.stringify(before)) throw new Error("the copy's row counts differ from the database's");
    // WAL in the header, as the Store keeps it, so the first open doesn't rewrite it.
    copy.exec('PRAGMA journal_mode = WAL');
  } finally {
    copy.close();
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(copyInto(process.argv[2], process.argv[3]));
  } catch (err) {
    console.error(String(thrown(err).message ?? err).split('\n')[0]);
    process.exit(1);
  }
}

function dropTmp(tmp: string) {
  for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) if (existsSync(f)) unlinkSync(f);
}

/**
 * The WAL in a no-COW file too: an empty one made here with +C, which SQLite then opens and keeps (it truncates
 * the WAL, and deletes it only at the last close). Only when there's none, so never over pages not yet copied in.
 */
function walNoCow(db: string, ops: NoCowOps) {
  const wal = `${db}-wal`;
  try {
    closeSync(openSync(wal, 'wx', 0o600));
  } catch {
    return; // there is one already
  }
  try {
    ops.setNoCow(wal);
  } catch {}
}
