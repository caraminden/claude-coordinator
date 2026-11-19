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
  /** For a minion in a build whose branch exists: whether build/<n> has all its work (it merged in). */
  build?: { n: number; merged: boolean; ahead: number } | null;
  pr: { number: number; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; url: string; draft: boolean } | null;
  /**
   * For merged work in the repo the server itself runs from: whether the live checkout has pulled it
   * (a deploy is under way) and whether the running server contains it. Null otherwise.
   */
  deploy: { pulled: boolean; live: boolean } | null;
  /** Files changed in the minion's worktree and not committed (uncommittedFiles); 0 when it wasn't looked at. */
  uncommitted?: number;
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
export async function branchStatus(repoDir: string, branch: string, startedAt: number, withPr: boolean, live: Live | null = null, build: number | null = null, worktree: string | null = null): Promise<BranchStatus | null> {
  const tip = await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoDir);
  if (!tip) return null;
  const originHead = await tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  const localDefault = originHead?.replace(/^origin\//, '') ?? 'main';
  const bases = [];
  if (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${localDefault}`], repoDir)) bases.push(localDefault);
  if (originHead) bases.push(originHead);
  const empty = await emptyBranch(repoDir, branch, startedAt);
  let ahead = 0;
  let merged = false;
  for (const base of bases) {
    const count = Number(await tryGit(['rev-list', '--count', `${base}..${branch}`], repoDir) ?? NaN);
    if (Number.isNaN(count)) continue;
    if (base === bases[0]) ahead = count;
    if (count === 0) merged = !empty;
  }
  // In a build with a branch (specs/build-branches.md): whether its work is in build/<n> yet.
  const buildRef = build ? await buildRefOf(repoDir, build) : null;
  return {
    branch,
    tip,
    base: bases[0] ?? null,
    ahead,
    merged,
    empty,
    build: buildRef ? {
      n: build!,
      merged: !empty && await contains(repoDir, buildRef, `refs/heads/${branch}`) === true,
      ahead: Number(await tryGit(['rev-list', '--count', `${buildRef}..refs/heads/${branch}`], repoDir)) || 0,
    } : null,
    pr: withPr ? await findPr(repoDir, branch) : null,
    deploy: merged && live ? await deployed(repoDir, branch, live) : null,
    uncommitted: worktree ? await uncommittedFiles(worktree) : 0,
  };
}

/**
 * How many files in a minion's worktree hold work not committed yet: edited, staged or deleted tracked files,
 * and new files inside folders the repo already tracks. A new top-level file or folder (`?? shots/`, `?? notes.md`)
 * is the minion's scratch, not work. 0 when git can't tell (the worktree is gone).
 */
export async function uncommittedFiles(worktree: string): Promise<number> {
  try {
    // --no-optional-locks: never take index.lock, which would make the minion's own `git commit` fail meanwhile.
    const { stdout } = await run('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: worktree, timeout: 15_000 });
    return stdout.split('\n').filter((l) => l && !(l.startsWith('?? ') && !l.slice(3).replace(/\/"?$/, '').includes('/'))).length;
  } catch {
    return 0;
  }
}

/**
 * Nothing committed on the branch since the minion started (`startedAt`, ms). A branch only fast-forwarded
 * to a newer main has a new tip but none of its own work, so ask its reflog (madeCommits). With no reflog
 * (they expire), a branch whose newest commit predates the minion is still where it was cut from.
 */
export async function emptyBranch(repoDir: string, branch: string, startedAt: number): Promise<boolean> {
  const made = await madeCommits(repoDir, branch, Math.floor(startedAt / 1000));
  if (made !== null) return !made;
  const tipTime = Number(await tryGit(['log', '-1', '--format=%ct', branch], repoDir)) * 1000;
  return !tipTime || tipTime < startedAt;
}

/** Build <n>'s branch as a ref: local build/<n>, else origin's; null when it has none (src/workspace.ts buildBranch). */
export async function buildRefOf(repoDir: string, build: number): Promise<string | null> {
  for (const ref of [`refs/heads/build/${build}`, `refs/remotes/origin/build/${build}`]) {
    if (await tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoDir)) return ref;
  }
  return null;
}

/**
 * Does `branch` hold commits the minion made at or after `since` (unix seconds)? From the branch's reflog,
 * newest first: a commit, cherry-pick or revert counts, and so does a rebase that kept some of them (as
 * land.sh's does). A rebase that finished on the very commit it went onto either fast-forwarded a branch
 * main already contains (look further back) or dropped all its commits, as main already had the same
 * change (#590): then the branch has nothing of its own until it commits again. Merge commits and other
 * fast-forwards don't count. Null when the branch has no reflog.
 */
export async function madeCommits(repoDir: string, branch: string, since: number): Promise<boolean | null> {
  const lines = (await tryGit(['reflog', 'show', '--date=unix', '--format=%H %gd %gs', `refs/heads/${branch}`], repoDir) ?? '')
    .split('\n').map((line) => line.match(/^(\w+) .*?@\{(\d+)\}\s+(.*)$/)).filter((m) => !!m);
  if (!lines.length) return null;
  for (const [i, [, sha, time, what]] of lines.entries()) {
    if (Number(time) < since) break;
    if (/^(commit(?! \(merge\))|cherry-pick|revert)\b/.test(what)) return true;
    if (!/^rebase\b.*\(finish\)/.test(what)) continue;
    if (!what.endsWith(` onto ${sha}`)) return true;
    const before = lines[i + 1]?.[1];
    if (!before || (await contains(repoDir, sha, before)) !== true) return false;
  }
  return false;
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
 * merged into its build, on main, deploying, live, or not live because the last deploy failed. Live is by ancestry: the
 * running server contains the branch, whichever minion's deploy carried it there; changes in its worktree not
 * committed yet take it back to its branch. Null before the minion has committed or changed anything.
 */
export interface Ship {
  stage: 'branch' | 'build' | 'main' | 'deploying' | 'live' | 'failed';
  text: string;
  /** The branch's newest commit, short. */
  commit: string;
  /** The whole deploy report, for a failed deploy. */
  detail?: string;
}

export function shipLine(s: BranchStatus | null, interruptible: number, failure: string | null): Ship | null {
  if (!s || (s.empty && !s.uncommitted)) return null;
  const commit = s.tip.slice(0, 7);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // New work in its worktree (#632) isn't live, nor in its build, nor merged: back on its branch until it lands.
  // A land already in flight (on main, deploying, failed) keeps its stage, which says it isn't live either.
  const edits = s.uncommitted ? 'changes not committed yet' : null;
  if (edits && (s.empty || s.deploy?.live || (s.merged && !s.deploy) || (!s.merged && s.build?.merged))) {
    return { stage: 'branch', text: `On its branch: ${edits}`, commit };
  }
  const and = edits ? `, and ${edits}` : '';
  // A feeder merged into its build: done for now, live when the build lands (main takes it by merge, so its hashes stay).
  if (!s.merged && s.build?.merged) return { stage: 'build', text: `Merged into Build ${s.build.n}, not live until the build ships`, commit };
  if (!s.merged && s.build) return { stage: 'branch', text: `On its branch: ${plural(s.build.ahead, 'commit')} not in build/${s.build.n}${and}`, commit };
  if (!s.merged) return { stage: 'branch', text: `On its branch: ${plural(s.ahead, 'commit')} not on ${s.base ?? 'main'}${and}`, commit };
  // Another scheme's repo: landed is as far as it goes here.
  if (!s.deploy) return { stage: 'main', text: `Shipped to ${s.base ?? 'main'}`, commit };
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
