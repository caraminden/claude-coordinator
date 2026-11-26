/**
 * Dismissed minions' worktrees and leftover Grunt worktrees (#660). A minion's worktree goes 3 days after
 * its latest dismissal; its branch stays, and a reopen recreates the folder from it (workspace.ts
 * restoreTicketDir). Anything not on the branch (uncommitted edits, new files, a detached HEAD's commits)
 * is first saved as a commit under refs/citadel/saved/, without touching the worktree, its index or the
 * branch; a reopen puts it back. Git-ignored files are not saved: they are build output and caches.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { diskUsage, exists, low } from './build-output.ts';
import { identity } from './scheme-repo.ts';
import { thrown } from './thrown.ts';

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
 * A git checkout inside `dir` besides its own (a clone a minion made, a Grunt's worktree): its unpushed work
 * would go with the folder and a save can't hold it. Build and dependency folders aren't searched.
 */
export async function nestedCheckout(dir: string): Promise<string | null> {
  const { stdout } = await low(['find', dir, '(', '-path', join(dir, '.git'), '-o', '-name', 'node_modules', '-o', '-name', 'target', ')', '-prune', '-o', '-name', '.git', '-print', '-quit']);
  return stdout.trim() ? stdout.trim().slice(dir.length + 1, -'/.git'.length) : null;
}

/**
 * Save what a worktree holds beyond `branch` (null: a detached HEAD, always saved) into `ref`, as `git stash`
 * does: a commit of the working tree (tracked and new, not ignored, files) whose parents are HEAD and a
 * commit of the index, so staged and unstaged versions both survive. Nothing in the worktree changes.
 * Returns whether it saved, or why the worktree must be kept.
 */
export async function saveWork(dir: string, ref: string, branch: string | null, message: string): Promise<{ saved: boolean } | { kept: string }> {
  const nested = await nestedCheckout(dir);
  if (nested) return { kept: `holds another git checkout, ${nested}` };
  const head = await git(['rev-parse', 'HEAD'], dir);
  const tip = branch ? await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], dir).catch(() => '') : '';
  const dirty = await git(['--no-optional-locks', 'status', '--porcelain'], dir);
  if (!dirty && tip === head) return { saved: false };
  // An earlier save a reopen couldn't put back (its branch moved) is someone's work: never write over it.
  if (await git(['rev-parse', '--verify', '--quiet', ref], dir).catch(() => '')) return { kept: `its earlier saved work in ${ref} isn't restored yet` };
  let bytes = 0;
  for (const f of (await git(['ls-files', '-z', '--others', '--exclude-standard'], dir)).split('\0').filter(Boolean)) {
    bytes += (await lstat(join(dir, f)).catch(() => null))?.size ?? 0;
  }
  if (bytes > SAVE_LIMIT) return { kept: `${Math.round(bytes / 2 ** 20)} MiB of new files, too big to save` };
  // A copy of its index, so the real one is never touched and `add -A` rehashes only what changed.
  const scratch = await mkdtemp(join(tmpdir(), 'citadel-save-'));
  try {
    const index = join(scratch, 'index');
    await copyFile(await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], dir), index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    const who = await identity(dir);
    const staged = await git([...who, 'commit-tree', await git(['write-tree'], dir, env), '-p', head, '-m', `${message} (its index)`], dir);
    await git(['add', '-A', '--', ':/'], dir, env);
    const commit = await git([...who, 'commit-tree', await git(['write-tree'], dir, env), '-p', head, '-p', staged, '-m', message], dir);
    // The empty old value: only if no ref appeared meanwhile.
    await git(['update-ref', ref, commit, ''], dir);
    return { saved: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Where a folder goes while it's deleted: beside it, so the move is one atomic rename. */
export const trashOf = (dir: string) => join(dirname(dir), `.removing-${basename(dir)}`);

/**
 * Remove a worktree whatever it holds (save it first) at low priority; returns the bytes it took. Throws,
 * touching nothing, on a locked one. The folder is renamed aside first, then git forgets it, then it's
 * deleted, so a delete that fails or is cut short leaves a `.removing-*` folder (clearTrash), never half a
 * checkout at the minion's path that a reopen can't recreate.
 */
export async function removeWorktree(repoDir: string, dir: string): Promise<number> {
  const admin = (await exists(join(dir, '.git'))) ? await git(['rev-parse', '--absolute-git-dir'], dir).catch(() => null) : null;
  if (admin && (await exists(join(admin, 'locked')))) throw new Error('locked');
  const bytes = await diskUsage([dir]);
  const trash = trashOf(dir);
  if (await exists(trash)) throw new Error(`${basename(trash)} is still there from an earlier removal`);
  await rename(dir, trash);
  // Its admin entry now points at a folder that's gone, so prune drops it.
  await git(['worktree', 'prune'], repoDir);
  // Best effort: what it can't delete (files another user owns) stays for clearTrash to report.
  await low(['rm', '-rf', '--one-file-system', '--', trash]).catch(() => {});
  return bytes;
}

/**
 * Delete what a removal left (`.removing-*` folders in `parent`), each on its own. Returns the bytes freed
 * and the folders it couldn't delete.
 */
export async function clearTrash(parent: string): Promise<{ bytes: number; stuck: string[] }> {
  const out = { bytes: 0, stuck: [] as string[] };
  for (const name of (await readdir(parent).catch(() => [] as string[])).filter((n) => n.startsWith('.removing-'))) {
    const dir = join(parent, name);
    const before = await diskUsage([dir]);
    try {
      await low(['rm', '-rf', '--one-file-system', '--', dir]);
      out.bytes += before;
    } catch (err) {
      out.bytes += before - (await diskUsage([dir]));
      out.stuck.push(
        `${dir}: ${
          String(thrown(err).stderr || thrown(err).message)
            .trim()
            .split('\n')[0]
        }`,
      );
    }
  }
  return out;
}

/**
 * Put a saved ref's files back into a recreated worktree as they were, staged and unstaged, then drop the ref. Only when its parent is the branch's tip; otherwise the ref stays and the
 * answer says where. Null when there was nothing saved. Synchronous: it runs just before a turn starts.
 */
export function restoreSaved(cwd: string, repoDir: string, ref: string, branch: string): string | null {
  const g = (args: string[], dir = repoDir) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let parent: string;
  try {
    parent = g(['rev-parse', '--verify', '--quiet', `${ref}^1`]);
  } catch {
    return null;
  }
  if (parent !== g(['rev-parse', `refs/heads/${branch}`])) return `its uncommitted work was saved in ${ref}, but the branch has moved since: \`git checkout ${ref} -- .\` brings it back`;
  g(['restore', `--source=${ref}^2`, '--staged', '--', ':/'], cwd);
  g(['restore', `--source=${ref}`, '--worktree', '--', ':/'], cwd);
  g(['update-ref', '-d', ref]);
  return 'its uncommitted work is back as uncommitted changes';
}

export type Worktree = { path: string; branch: string | null; locked: boolean };

/** The repo's worktrees as git lists them, its main checkout first. */
export async function worktrees(repoDir: string): Promise<Worktree[]> {
  const out: Worktree[] = [];
  for (const block of (await git(['worktree', 'list', '--porcelain'], repoDir)).split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice(18) ?? null;
    out.push({ path, branch, locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) });
  }
  return out;
}

/** The Grunt worktrees among them (`…/.claude/worktrees/agent-*`, under the main checkout or a minion's). */
export const isGrunt = (w: Worktree) => /\/\.claude\/worktrees\/agent-[^/]+$/.test(w.path);

/** When a folder was made: its birth time, else its change time (never earlier than its birth), else null when it's gone. */
export async function madeAt(dir: string): Promise<number | null> {
  const s = await stat(dir).catch(() => null);
  return s ? (s.birthtimeMs > 0 ? s.birthtimeMs : s.ctimeMs) : null;
}
