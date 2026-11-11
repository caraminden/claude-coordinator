// Where a ticket's work stands: its GitHub pull request, if it has one, and whether its branch is merged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BranchStatus {
  branch: string;
  /** The branch's newest commit. */
  tip: string;
  /** The base the branch is compared with, like "main". */
  base: string | null;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  /** The branch has commits of its own and the base has all of them. */
  merged: boolean;
  /** Nothing committed on the branch since the ticket started. */
  empty: boolean;
  pr: { number: number; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; url: string; draft: boolean } | null;
  /**
   * For merged work in the repo the server itself runs from: whether the live checkout has pulled it
   * (a deploy is under way) and whether the running server contains it. Null otherwise.
   */
  deploy: { pulled: boolean; live: boolean } | null;
}

/** The commit the server runs and its live checkout, to place merged work in a deploy. */
export interface Live {
  head: string | null;
  checkoutDir: string;
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
export async function branchStatus(repoDir: string, branch: string, startedAt: number, withPr: boolean, live: Live | null = null): Promise<BranchStatus | null> {
  const tip = await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoDir);
  if (!tip) return null;
  const originHead = await tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  const localDefault = originHead?.replace(/^origin\//, '') ?? 'main';
  const bases = [];
  if (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${localDefault}`], repoDir)) bases.push(localDefault);
  if (originHead) bases.push(originHead);
  // Its reflog says whether the minion committed since it started: a branch only fast-forwarded to a
  // newer main has a new tip but none of its own work (as `committed` in src/wake.ts). With no reflog
  // (they expire), a branch whose newest commit predates the ticket is still where it was cut from.
  const reflog = (await tryGit(['reflog', 'show', '--date=unix', '--format=%gd %gs', `refs/heads/${branch}`], repoDir) ?? '')
    .split('\n').map((line) => line.match(/@\{(\d+)\}\s+(.*)$/)).filter((m) => !!m);
  const tipTime = Number(await tryGit(['log', '-1', '--format=%ct', branch], repoDir)) * 1000;
  const empty = reflog.length
    ? !reflog.some((m) => Number(m[1]) >= Math.floor(startedAt / 1000) && /^(commit(?! \(merge\))|cherry-pick|revert)\b/.test(m[2]))
    : !tipTime || tipTime < startedAt;
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
    tip,
    base: bases[0] ?? null,
    ahead,
    merged,
    empty,
    pr: withPr ? await findPr(repoDir, branch) : null,
    deploy: merged && live ? await deployed(repoDir, branch, live) : null,
  };
}

/** Is `ancestor` contained in `commit`? Null when the repo doesn't know one of them. */
async function contains(repoDir: string, commit: string, ancestor: string): Promise<boolean | null> {
  try {
    await run('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: repoDir, timeout: 15_000 });
    return true;
  } catch (err) {
    return (err as { code?: number }).code === 1 ? false : null;
  }
}

/** Whether the live checkout and the running server contain the branch. */
async function deployed(repoDir: string, branch: string, live: Live): Promise<BranchStatus['deploy']> {
  // Another scheme's repo doesn't know the server's commit: its work never deploys here.
  const isLive = live.head ? await contains(repoDir, live.head, `refs/heads/${branch}`) : null;
  if (isLive === null) return null;
  const checkout = isLive ? null : await tryGit(['rev-parse', 'HEAD'], live.checkoutDir);
  const pulled = isLive || (!!checkout && (await contains(repoDir, checkout, `refs/heads/${branch}`)) === true);
  return { pulled, live: isLive };
}

/**
 * Where a minion's change is, as one line for its bar and a stage for its row's badge: on its branch,
 * on main, deploying, live, or not live because the last deploy failed. Live is by ancestry: the
 * running server contains the branch, whichever minion's deploy carried it there. Null before the
 * minion has committed anything.
 */
export interface Ship {
  stage: 'branch' | 'main' | 'deploying' | 'live' | 'failed';
  text: string;
  /** The branch's newest commit, short. */
  commit: string;
  /** The whole deploy report, for a failed deploy. */
  detail?: string;
}

export function shipLine(s: BranchStatus | null, interruptible: number, failure: string | null): Ship | null {
  if (!s || s.empty) return null;
  const commit = s.tip.slice(0, 7);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!s.merged) return { stage: 'branch', text: `On its branch: ${plural(s.ahead, 'commit')} not on ${s.base ?? 'main'}`, commit };
  // Another scheme's repo: merged is as far as it goes here.
  if (!s.deploy) return { stage: 'main', text: `Merged into ${s.base ?? 'main'}`, commit };
  if (s.deploy.live) return { stage: 'live', text: 'Live', commit };
  if (failure) {
    // Why, from the report: what follows "failed: ", or its first sentence. The bar shows it all on hover.
    const why = failure.match(/failed: (.*?)[.,](\s|$)/)?.[1] ?? failure.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
    return { stage: 'failed', text: `Not live, the last deploy failed: ${why.length > 80 ? why.slice(0, 79) + '…' : why}`, commit, detail: failure };
  }
  if (s.deploy.pulled) {
    return { stage: 'deploying', text: interruptible ? `Deploying: waiting on the idle restart, ${plural(interruptible, 'turn')} running` : 'Deploying', commit };
  }
  return { stage: 'main', text: 'On main, not deployed', commit };
}
