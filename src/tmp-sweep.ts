/**
 * Scratch Citadel's own tools leave in perigee's RAM-backed /tmp when they are killed (#1339): lint-ps1's profile
 * folders (84 filled 4.5G), boot-check's copies of the database (1.7G each) and a ship train's scratch worktree.
 * Removed only when it is ours (our uid), made by one of these tools (by name), older than an hour, and its maker is
 * gone: no live pid for a name that carries one, and no process of ours working inside it. Anything else in /tmp is
 * other users' or other apps', and stays.
 */
import { lstatSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const MIN_AGE_MS = 60 * 60_000;
const NAMES: { re: RegExp; pid: boolean }[] = [
  { re: /^lint-ps1-(\d+)$/, pid: true },
  { re: /^heavy-(\d+)$/, pid: true },
  { re: /^citadel-boot-check-[A-Za-z0-9]+$/, pid: false },
  { re: /^land-train\.[A-Za-z0-9]+$/, pid: false },
];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
};

/** Directories our processes have as their working directory (a ship's tool that cd'd into its scratch). */
function workingDirs(proc: string): string[] {
  const out: string[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const p of pids) {
    try {
      out.push(readlinkSync(join(proc, p, 'cwd')));
    } catch {
      // Another user's, or gone already.
    }
  }
  return out;
}

/** Sweep each of `roots` (default: /tmp and the heavy commands' folder); returns the folders removed. */
export function sweepOrphanTmp(roots: string[] = ['/tmp'], now = Date.now(), opts: { proc?: string; uid?: number } = {}): string[] {
  const uid = opts.uid ?? process.getuid?.();
  const cwds = workingDirs(opts.proc ?? '/proc');
  const removed: string[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const rule = NAMES.find((r) => r.re.test(name));
      if (!rule) continue;
      const dir = join(root, name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs < MIN_AGE_MS) continue;
        if (rule.pid && alive(Number(rule.re.exec(name)![1]))) continue;
        if (cwds.some((c) => c === dir || c.startsWith(`${dir}/`))) continue;
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        // Gone, or not ours to remove: the next pass looks again.
      }
    }
  }
  return removed;
}
