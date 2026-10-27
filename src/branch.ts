// Where a ticket's work stands: its GitHub pull request, if it has one, and whether its branch is merged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BranchStatus {
  branch: string;
  /** The base the branch is compared with, like "main". */
  base: string | null;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  /** The branch has commits of its own and the base has all of them. */
  merged: boolean;
  /** Nothing committed on the branch since the ticket started. */
  empty: boolean;
  pr: { number: number; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; url: string; draft: boolean } | null;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: 15_000 });
  return stdout.trim();
}

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

/** The newest pull request whose head is `branch`, via the gh CLI; null if none or gh can't tell. */
async function findPr(repoDir: string, branch: string): Promise<BranchStatus['pr']> {
  try {
    const { stdout } = await run('gh', [
      'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,title,state,url,isDraft',
    ], { cwd: repoDir, timeout: 20_000 });
    const [pr] = JSON.parse(stdout);
    return pr ? { number: pr.number, title: pr.title, state: pr.state, url: pr.url, draft: !!pr.isDraft } : null;
  } catch {
    return null;
  }
}

/**
 * Status of a ticket's branch in the project's checkout. Merged means its commits are all in the
 * local default branch or origin's (tickets here are often merged locally rather than through a PR).
 */
export async function branchStatus(repoDir: string, branch: string, startedAt: number, withPr: boolean): Promise<BranchStatus | null> {
  if (!(await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoDir))) return null;
  const originHead = await tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  const localDefault = originHead?.replace(/^origin\//, '') ?? 'main';
  const bases = [];
  if (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${localDefault}`], repoDir)) bases.push(localDefault);
  if (originHead) bases.push(originHead);
  const tipTime = Number(await tryGit(['log', '-1', '--format=%ct', branch], repoDir)) * 1000;
  // A branch whose newest commit predates the ticket is still where it was cut from.
  const empty = !tipTime || tipTime < startedAt;
  let ahead = 0;
  let merged = false;
  for (const base of bases) {
    const count = Number(await tryGit(['rev-list', '--count', `${base}..${branch}`], repoDir) ?? NaN);
    if (Number.isNaN(count)) continue;
    if (base === bases[0]) ahead = count;
    if (count === 0) merged = !empty;
  }
  return {
    branch,
    base: bases[0] ?? null,
    ahead,
    merged,
    empty,
    pr: withPr ? await findPr(repoDir, branch) : null,
  };
}
