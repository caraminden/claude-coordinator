// Project checkouts and per-ticket working directories.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { identity } from './scheme-repo.ts';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ticket';
}

export function projectDir(dataDir: string, projectId: number): string {
  return join(dataDir, 'projects', String(projectId));
}

/** Where every thread and the coordinator of a project share handoffs, specs and notes. Ticket ids are numbers, so "project" never clashes with a ticket's shared folder. */
export function projectSharedDir(dataDir: string, projectId: number): string {
  return join(projectDir(dataDir, projectId), 'shared', 'project');
}

export async function removeProjectDir(dataDir: string, projectId: number) {
  await rm(projectDir(dataDir, projectId), { recursive: true, force: true });
}

/** Clone the project's repo into the data dir. Returns the checkout path. */
export async function cloneProject(dataDir: string, projectId: number, repoUrl: string): Promise<string> {
  const dir = join(projectDir(dataDir, projectId), 'repo');
  // Project ids can be reused after a failed create; clear any leftover partial clone.
  await rm(dir, { recursive: true, force: true });
  await mkdir(projectDir(dataDir, projectId), { recursive: true });
  await git(['clone', '--quiet', '--', repoUrl, dir]);
  return dir;
}

/** What a new minion branches from: local main, or origin's if a push put it ahead. Fetches first. */
export async function ticketBase(repoDir: string): Promise<string> {
  try {
    await git(['fetch', '--quiet', 'origin'], repoDir);
  } catch {
    // Best effort: branch from what we already have if the remote is unreachable.
  }
  const ok = (args: string[]) => git(args, repoDir).then(() => true, () => false);
  let base = 'HEAD';
  try {
    base = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  } catch {
    // No origin/HEAD (e.g. local repo); branch from the checkout's HEAD.
  }
  // Minions merge into the local default branch, which may never be pushed: branch from it
  // unless origin's copy is ahead of it (a scheme kept up to date by pushes). Diverged: local wins.
  const local = base.replace(/^origin\//, '');
  if (local !== base && await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`])
    && !await ok(['merge-base', '--is-ancestor', local, base])) {
    base = local;
  }
  return base;
}

/**
 * A scheme cloned from an empty repo has a main with no commits, and a worktree needs one to branch
 * from (#181). If a push has since given origin that branch, that's the base; otherwise main gets an
 * empty "Start" commit, made locally only and without touching the index or the files. Returns the
 * base to use.
 */
async function bornBase(repoDir: string, base: string): Promise<string> {
  const ok = (args: string[]) => git(args, repoDir).then(() => true, () => false);
  if (await ok(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) return base;
  const branch = await git(['symbolic-ref', '--short', 'HEAD'], repoDir);
  if (await ok(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) return `origin/${branch}`;
  const tree = await git(['hash-object', '-t', 'tree', '-w', '/dev/null'], repoDir);
  const commit = await git([...await identity(repoDir), 'commit-tree', tree, '-m', 'Start'], repoDir);
  // The empty old value: only if main is still unborn, so two minions created at once agree on one commit.
  await git(['update-ref', `refs/heads/${branch}`, commit, ''], repoDir).catch(async (err) => {
    if (!await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) throw err;
  });
  return branch;
}

/**
 * A chained minion starts later than it was created: fast-forward its branch to what a new minion
 * would branch from now, so it builds on the work it waited for. Only a fast-forward: a branch with
 * commits of its own, or a dirty worktree, is left as it is. Returns whether it moved.
 */
export async function catchUpTicketDir(cwd: string, repoDir: string | null): Promise<boolean> {
  if (!repoDir) return false;
  // Resolved in the scheme's repo: "HEAD" in the worktree would be the minion's own branch.
  const base = await git(['rev-parse', `${await ticketBase(repoDir)}^{commit}`], repoDir);
  const before = await git(['rev-parse', 'HEAD'], cwd);
  try {
    await git(['merge', '--ff-only', '--quiet', base], cwd);
  } catch {
    return false;
  }
  return (await git(['rev-parse', 'HEAD'], cwd)) !== before;
}

/**
 * Create the working directory for a ticket: a fresh git worktree on its own
 * branch when the project has a repo, otherwise a plain folder.
 */
export async function createTicketDir(
  dataDir: string,
  projectId: number,
  repoDir: string | null,
  ticketId: number,
  ticketNumber: number,
  title: string,
): Promise<{ cwd: string; branch: string | null }> {
  const cwd = join(projectDir(dataDir, projectId), 'tickets', String(ticketId));
  if (!repoDir) {
    await mkdir(cwd, { recursive: true });
    return { cwd, branch: null };
  }
  const base = await bornBase(repoDir, await ticketBase(repoDir));
  const ok = (args: string[]) => git(args, repoDir).then(() => true, () => false);
  // Branches are named by the per-project number; a branch left over from before
  // per-project numbering may already have the name, so add a suffix then.
  const name = `ticket/${ticketNumber}-${slugify(title)}`;
  let branch = name;
  for (let i = 2; await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); i++) {
    branch = `${name}-${i}`;
  }
  await mkdir(join(projectDir(dataDir, projectId), 'tickets'), { recursive: true });
  await git(['worktree', 'add', '--quiet', '-b', branch, cwd, base], repoDir);
  return { cwd, branch };
}

/**
 * Put back a ticket's worktree from its branch if the folder is gone (deploy/prune.sh removes
 * worktrees of long-closed tickets but keeps their branches). Synchronous: it runs just before a
 * turn starts. Returns true if it recreated the folder.
 */
export function restoreTicketDir(cwd: string, repoDir: string | null, branch: string | null): boolean {
  if (!cwd || existsSync(cwd) || !repoDir || !branch) return false;
  execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, timeout: GIT_TIMEOUT_MS });
  execFileSync('git', ['worktree', 'add', '--quiet', cwd, branch], { cwd: repoDir, timeout: GIT_TIMEOUT_MS });
  return true;
}
