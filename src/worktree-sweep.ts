/**
 * Dismissed minions' worktrees and leftover Grunt worktrees (#660). A minion's worktree goes 3 days after
 * its latest dismissal; its branch stays, and a reopen recreates the folder from it (workspace.ts
 * restoreTicketDir). Anything not on the branch (uncommitted edits, new files, a detached HEAD's commits)
 * is first saved as a commit under refs/citadel/saved/, without touching the worktree, its index or the
 * branch; a reopen puts it back. Git-ignored files are not saved: they are build output and caches.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskUsage, low } from './build-output.ts';
import { identity } from './scheme-repo.ts';

const DAY = 24 * 60 * 60_000;
/** Josh, 2026-11-13: "lets do 3 days", one number for every scheme. */
export const GRACE_MS = 3 * DAY;
/** A Grunt worktree younger than this is never removed, whatever the turns say. */
export const GRUNT_AGE_MS = DAY;
/** New files bigger than this together aren't copied into the repo: the worktree is kept instead. */
export const SAVE_LIMIT = 200 * 2 ** 20;

export const savedRef = (key: string) => `refs/citadel/saved/${key}`;

const git = async (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => (await low(['git', ...args], { cwd, env: env && { ...process.env, ...env } })).stdout.trim();

/** Whether `dir` is a git checkout of its own (not a folder inside another repo's checkout). */
export async function ownCheckout(dir: string): Promise<boolean> {
  try {
    const real = await realpath(dir);
    return (await git(['rev-parse', '--show-toplevel'], real)) === real;
  } catch {
    return false;
  }
}

/**
 * Save what a worktree holds beyond `branch` (null: a detached HEAD, always saved) into `ref`: a commit of
 * the whole working tree (tracked and new, not ignored, files) whose parent is HEAD. Nothing in the
 * worktree changes. Returns whether it saved, or why the worktree must be kept.
 */
export async function saveWork(dir: string, ref: string, branch: string | null, message: string): Promise<{ saved: boolean } | { kept: string }> {
  const head = await git(['rev-parse', 'HEAD'], dir);
  const tip = branch ? await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], dir).catch(() => '') : '';
  const dirty = await git(['--no-optional-locks', 'status', '--porcelain'], dir);
  if (!dirty && tip === head) return { saved: false };
  let bytes = 0;
  for (const f of (await git(['ls-files', '-z', '--others', '--exclude-standard'], dir)).split('\0').filter(Boolean)) {
    bytes += (await lstat(join(dir, f)).catch(() => null))?.size ?? 0;
  }
  if (bytes > SAVE_LIMIT) return { kept: `${Math.round(bytes / 2 ** 20)} MiB of new files, too big to save` };
  // A copy of its index, so `add -A` rehashes only what changed and the real index is never touched.
  const scratch = await mkdtemp(join(tmpdir(), 'citadel-save-'));
  try {
    const index = join(scratch, 'index');
    await copyFile(await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], dir), index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    await git(['add', '-A', '--', ':/'], dir, env);
    const tree = await git(['write-tree'], dir, env);
    const commit = await git([...await identity(dir), 'commit-tree', tree, '-p', head, '-m', message], dir);
    await git(['update-ref', ref, commit], dir);
    return { saved: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Remove a worktree whatever it holds (save it first) at low priority; returns the bytes it took. Throws if git won't (a locked worktree). */
export async function removeWorktree(repoDir: string, dir: string): Promise<number> {
  const bytes = await diskUsage([dir]);
  await git(['worktree', 'remove', '--force', dir], repoDir);
  await git(['worktree', 'prune'], repoDir);
  return bytes;
}

/**
 * Put a saved ref's files back into a recreated worktree as uncommitted changes (the index stays at the
 * branch), then drop the ref. Only when its parent is the branch's tip; otherwise the ref stays and the
 * answer says where. Null when there was nothing saved. Synchronous: it runs just before a turn starts.
 */
export function restoreSaved(cwd: string, repoDir: string, ref: string, branch: string): string | null {
  const g = (args: string[], dir = repoDir) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let parent: string;
  try {
    parent = g(['rev-parse', '--verify', '--quiet', `${ref}^`]);
  } catch {
    return null;
  }
  if (parent !== g(['rev-parse', `refs/heads/${branch}`])) return `its uncommitted work was saved in ${ref}, but the branch has moved since: \`git checkout ${ref} -- .\` brings it back`;
  g(['restore', `--source=${ref}`, '--worktree', '--', ':/'], cwd);
  g(['update-ref', '-d', ref]);
  return 'its uncommitted work is back as uncommitted changes';
}

export type GruntWorktree = { path: string; branch: string | null; locked: boolean };

/** The repo's Grunt worktrees (`…/.claude/worktrees/agent-*`, under the main checkout or a minion's). */
export async function gruntWorktrees(repoDir: string): Promise<GruntWorktree[]> {
  const out: GruntWorktree[] = [];
  for (const block of (await git(['worktree', 'list', '--porcelain'], repoDir)).split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path || !/\/\.claude\/worktrees\/agent-[^/]+$/.test(path)) continue;
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice(18) ?? null;
    out.push({ path, branch, locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) });
  }
  return out;
}

/** When a folder was made: its birth time, else its change time (never earlier than its birth), else null when it's gone. */
export async function madeAt(dir: string): Promise<number | null> {
  const s = await stat(dir).catch(() => null);
  return s ? (s.birthtimeMs > 0 ? s.birthtimeMs : s.ctimeMs) : null;
}
