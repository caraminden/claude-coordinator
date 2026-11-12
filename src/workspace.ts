// Project checkouts and per-ticket working directories.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { asEnv, identity, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

async function git(args: string[], cwd?: string, as?: GithubEnv, timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: asEnv(as), maxBuffer: 16 * 1024 * 1024, timeout });
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

/** Every scheme's skills-survey reports (`reports/skills-survey-*.md` in its shared folder), for onboarding's three-month check: the name carries the stack and month. */
export function surveyReports(dataDir: string): string[] {
  const ls = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  return ls(join(dataDir, 'projects'))
    .filter((id) => /^\d+$/.test(id))
    .flatMap((id) => {
      const dir = join(projectSharedDir(dataDir, Number(id)), 'reports');
      return ls(dir).filter((f) => /^skills-survey-.*\.md$/.test(f)).map((f) => join(dir, f));
    });
}

export async function removeProjectDir(dataDir: string, projectId: number) {
  await rm(projectDir(dataDir, projectId), { recursive: true, force: true });
}

/** Clone the project's repo into the data dir, as `as` (#195) or the box's login. Returns the checkout path. */
export async function cloneProject(dataDir: string, projectId: number, repoUrl: string, as?: GithubEnv): Promise<string> {
  const dir = join(projectDir(dataDir, projectId), 'repo');
  // Project ids can be reused after a failed create; clear any leftover partial clone.
  await rm(dir, { recursive: true, force: true });
  await mkdir(projectDir(dataDir, projectId), { recursive: true });
  await git(['clone', '--quiet', '--', repoUrl, dir], undefined, as);
  return dir;
}

/**
 * Bring the scheme checkout's main up to origin's (#208): PRs merged on GitHub leave it behind, and
 * the base check, self-review and the catalogue read it. Only a fast-forward, only when origin is
 * strictly ahead (a scheme whose base is local main, moved by land.sh, is left alone), and only on
 * main with nothing uncommitted. Returns why it didn't, or null when it moved or had nothing to do.
 */
export async function catchUpMain(repoDir: string): Promise<string | null> {
  const ok = (args: string[]) => git(args, repoDir).then(() => true, () => false);
  const origin = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir).catch(() => null);
  const local = origin?.replace(/^origin\//, '');
  if (!origin || !local || !await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${local}`])) return null;
  if (await ok(['merge-base', '--is-ancestor', origin, local])) return null; // level, or local is ahead
  if (!await ok(['merge-base', '--is-ancestor', local, origin])) return `${local} and ${origin} have diverged`;
  const on = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoDir).catch(() => null);
  if (on !== local) return `the checkout is on ${on ?? 'a detached HEAD'}, not ${local}`;
  // Untracked files don't block it: the merge itself refuses to overwrite one.
  if (await git(['status', '--porcelain', '--untracked-files=no'], repoDir)) return 'the checkout has uncommitted changes';
  try {
    await git(['merge', '--ff-only', '--quiet', origin], repoDir);
  } catch (err: any) {
    return `the fast-forward failed: ${String(err.stderr || err.message).trim().split('\n')[0]}`;
  }
  return null;
}

/** Told when why a scheme's main can't catch up changes: a reason, or null once it's level again (server.ts notes it). */
export const mainSync = {
  stuck: (repoDir: string, why: string | null) => { if (why) console.warn(`Not fast-forwarding main in ${repoDir}: ${why}`); },
  /** The GitHub login the fetch runs as (#321: the scheme owner's; server.ts sets it); undefined is the box's. */
  as: (_repoDir: string): GithubEnv => undefined,
  /** How long the fetch may take: a remote that stalls would hold up every new minion of the repo behind it. */
  fetchMs: 45_000,
};

// One catch-up per repo at a time: two at once would trip over git's index lock.
const syncing = new Map<string, Promise<void>>();
const stuckWhy = new Map<string, string | null>();

/**
 * Fetch origin, best effort, then catch the checkout's main up to it. Not under the deploy lock: if
 * a merge on GitHub moves Citadel's main mid-land, land.sh's own fast-forward refuses and nothing lands.
 */
export function syncMain(repoDir: string): Promise<void> {
  const next = (syncing.get(repoDir) ?? Promise.resolve()).then(async () => {
    try {
      await git(['fetch', '--quiet', 'origin'], repoDir, mainSync.as(repoDir), mainSync.fetchMs);
    } catch {
      // Unreachable or stalled remote: work from what we already have.
    }
    const why = await catchUpMain(repoDir).catch((err) => `the catch-up failed: ${err.message}`);
    if ((stuckWhy.get(repoDir) ?? null) === why) return;
    stuckWhy.set(repoDir, why);
    try {
      mainSync.stuck(repoDir, why);
    } catch (err) {
      console.error(`Reporting main in ${repoDir} failed:`, err);
    }
  });
  syncing.set(repoDir, next.catch(() => {}));
  return next;
}

/**
 * A build's branch (build branches, specs/build-branches.md): `build/<n>` in the scheme repo, or origin's
 * copy when only a push made it. null when the build has none, which is every build until its build
 * minion makes the branch, and every scheme that uses the build label without build branches (Delve).
 * Synchronous: the minion's prompt asks at the start of each turn.
 */
export function buildBranch(repoDir: string | null, build: number | null | undefined): string | null {
  if (!repoDir || !build) return null;
  for (const [ref, name] of [[`refs/heads/build/${build}`, `build/${build}`], [`refs/remotes/origin/build/${build}`, `origin/build/${build}`]]) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoDir, stdio: 'ignore', timeout: 10_000 });
      return name;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * Whether the scheme's land script can merge into a build (`tools/land.sh --into build/<n>`), read from
 * its checkout. Until it can, no prompt mentions builds: a build minion could make the branch but nothing
 * could merge into it or land it.
 */
export function landsBuilds(repoDir: string | null): boolean {
  if (!repoDir) return false;
  try {
    return /--into\b/.test(readFileSync(join(repoDir, 'tools', 'land.sh'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * What a new minion branches from: its build's branch when it has one, else local main, or origin's if a
 * push put it ahead. Fetches first.
 */
export async function ticketBase(repoDir: string, build: number | null = null): Promise<string> {
  await syncMain(repoDir);
  const ofBuild = buildBranch(repoDir, build);
  if (ofBuild) return ofBuild;
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
 * would branch from now (its build's branch, for a minion in a build that has one), so it builds on the
 * work it waited for. Only a fast-forward: a branch with
 * commits of its own, or uncommitted changes to a file the fast-forward would change, leaves it as it is;
 * other uncommitted files don't stop it. So it runs only between turns (src/wake.ts startChained).
 * Returns whether it moved.
 */
export async function catchUpTicketDir(cwd: string, repoDir: string | null, build: number | null = null): Promise<boolean> {
  if (!repoDir) return false;
  // Resolved in the scheme's repo: "HEAD" in the worktree would be the minion's own branch.
  const base = await git(['rev-parse', `${await ticketBase(repoDir, build)}^{commit}`], repoDir);
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
 * branch when the project has a repo (from its build's branch when it has one), otherwise a plain folder.
 */
export async function createTicketDir(
  dataDir: string,
  projectId: number,
  repoDir: string | null,
  ticketId: number,
  ticketNumber: number,
  title: string,
  build: number | null = null,
): Promise<{ cwd: string; branch: string | null }> {
  const cwd = join(projectDir(dataDir, projectId), 'tickets', String(ticketId));
  if (!repoDir) {
    await mkdir(cwd, { recursive: true });
    return { cwd, branch: null };
  }
  const base = await bornBase(repoDir, await ticketBase(repoDir, build));
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
