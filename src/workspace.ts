// Project checkouts and per-ticket working directories.
import { execFile } from 'node:child_process';
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
  let base = 'HEAD';
  try {
    base = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  } catch {
    // No origin/HEAD (e.g. local repo); branch from the checkout's HEAD.
  }
  // Branches are named by the per-project number; a branch left over from before
  // per-project numbering may already have the name, so add a suffix then.
  const name = `ticket/${ticketNumber}-${slugify(title)}`;
  let branch = name;
  for (let i = 2; await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoDir).then(() => true, () => false); i++) {
    branch = `${name}-${i}`;
  }
  await mkdir(join(projectDir(dataDir, projectId), 'tickets'), { recursive: true });
  await git(['worktree', 'add', '--quiet', '-b', branch, cwd, base], repoDir);
  return { cwd, branch };
}
