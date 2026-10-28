// Project checkouts and per-ticket working directories.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
