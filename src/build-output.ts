/**
 * A dismissed minion's build output (#336): the git-ignored `target/` and `node_modules/` folders in
 * its worktree, which a build makes again and which run to hundreds of GiB across a Rust scheme's
 * minions. The worktree and branch stay, so a reopen still works; only those folders go.
 * Safe by construction: only a folder git calls wholly ignored (so it holds no tracked file), inside a
 * worktree at exactly projects/<scheme>/tickets/<id>, reached through no symlink. `rm` never follows
 * symlinks inside what it removes.
 */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const NAMES = new Set(['target', 'node_modules']);
// Lowest best-effort IO class and lowest CPU priority, so a sweep never hogs the box. Not the idle
// class: under steady IO it can starve, holding the minion's lane (and a reopen) behind it.
const LOW = ['ionice', '-c2', '-n7', 'nice', '-n19'];

/** The worktree a minion of `projectId` must have for its build output to be cleared: nothing else is ever touched. */
export function ticketWorktree(dataDir: string, projectId: number, ticketId: number): string {
  return join(dataDir, 'projects', String(projectId), 'tickets', String(ticketId));
}

/**
 * The build-output folders in `worktree`, absolute. Folders inside an ignored folder of another name
 * (build/node_modules) aren't found: git reports only the outer one. Throws if it isn't a git worktree.
 */
export async function findBuildOutput(worktree: string): Promise<string[]> {
  const real = await realpath(worktree);
  // A folder that is no checkout of its own would answer for whatever repo holds it.
  const top = (await low(['git', '-C', real, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if (top !== real) throw new Error(`${worktree} is not a git worktree of its own`);
  const { stdout } = await low(['git', '-C', real, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  const found: string[] = [];
  // A trailing slash means git found the whole folder ignored; a name without one is a file or a symlink.
  for (const rel of stdout.split('\0').filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)).sort()) {
    if (!NAMES.has(basename(rel)) || found.some((f) => rel.startsWith(f + '/'))) continue;
    const dir = join(real, rel);
    // Reached through no symlink, and a real folder itself.
    if (!dir.startsWith(real + sep) || (await realpath(dirname(dir))) !== dirname(dir) || !(await lstat(dir)).isDirectory()) continue;
    found.push(rel);
  }
  return found.map((rel) => join(real, rel));
}

/** Disk space the folders take, in bytes (du, at low priority). */
export async function diskUsage(dirs: string[]): Promise<number> {
  if (!dirs.length) return 0;
  const { stdout } = await low(['du', '-sk', '--one-file-system', '--', ...dirs]).catch((err) => ({ stdout: String(err.stdout ?? '') }));
  return stdout.split('\n').reduce((sum, line) => sum + (Number(line.split('\t')[0]) || 0), 0) * 1024;
}

/** Remove the worktree's build output at low priority, one folder at a time; returns the bytes freed. */
export async function clearBuildOutput(worktree: string): Promise<{ dirs: number; bytes: number }> {
  const dirs = await findBuildOutput(worktree);
  const bytes = await diskUsage(dirs);
  for (const dir of dirs) await low(['rm', '-rf', '--one-file-system', '--', dir]);
  return { dirs: dirs.length, bytes };
}

async function low(cmd: string[]) {
  const opts = { timeout: 60 * 60_000, maxBuffer: 64 * 1024 * 1024 };
  try {
    return await run(LOW[0], [...LOW.slice(1), ...cmd], opts);
  } catch (err: any) {
    if (err.code !== 'ENOENT' || err.path !== LOW[0]) throw err;
    return run(cmd[0], cmd.slice(1), opts); // a box without ionice
  }
}

/** "12.3 GiB", or MiB under one GiB. */
export const size = (bytes: number) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : `${Math.round(bytes / 2 ** 20)} MiB`;
