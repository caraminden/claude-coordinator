// Where a ticket's work stands: its GitHub pull request, if it has one, and whether its branch is merged.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

// #1463: starting a git process holds the server's thread (the fork itself), and branchStatus used to start 8 to 15
// of them per call. A question asked only of commit hashes (how many commits A..B, is A in B) has one answer forever,
// so it is kept here and asked once; the refs are read in one for-each-ref. A call where nothing moved starts at most
// 3: that read, the worktree's status, and gh when the PR is due a look.
const SETTLED_MAX = 5000;
const settled = new Map<string, unknown>();
/** `ask`'s answer for this key, asked once; null answers (git couldn't tell) aren't kept, so they're asked again. */
async function once<T>(key: string, ask: () => Promise<T | null>): Promise<T | null> {
  if (settled.has(key)) return settled.get(key) as T;
  const v = await ask();
  if (v !== null) {
    if (settled.size >= SETTLED_MAX) settled.delete(settled.keys().next().value!);
    settled.set(key, v);
  }
  return v;
}
/** For tests: forget the kept answers. */
export function forgetSettled() {
  settled.clear();
}

/** Each named ref that exists, as name → commit, and origin/HEAD's target; one git process. */
async function readRefs(repoDir: string, names: string[]): Promise<{ sha: Map<string, string>; originHead: string | null }> {
  const out = await tryGit(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', '--', ...names], repoDir) ?? '';
  const sha = new Map<string, string>();
  let originHead: string | null = null;
  for (const line of out.split('\n')) {
    const [ref, obj, sym] = line.split('\t');
    if (!ref || !obj || !names.includes(ref)) continue; // for-each-ref also matches refs below a name (main/x)
    sha.set(ref, obj);
    if (ref === 'refs/remotes/origin/HEAD' && sym) originHead = sym;
  }
  return { sha, originHead };
}

/**
 * Status of a ticket's branch in the project's checkout. Merged means its commits are all in the
 * local default branch or origin's (tickets here are often merged locally rather than through a PR).
 */
export async function branchStatus(repoDir: string, branch: string, startedAt: number, withPr: boolean, live: Live | null = null, build: number | null = null, worktree: string | null = null): Promise<BranchStatus | null> {
  const head = `refs/heads/${branch}`;
  const builds = build ? [`refs/heads/build/${build}`, `refs/remotes/origin/build/${build}`] : [];
  // origin/HEAD names the default branch; main and master cover nearly every repo, and any other name costs a second read.
  let refs = await readRefs(repoDir, [head, 'refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master', ...builds]);
  const tip = refs.sha.get(head);
  if (!tip) return null;
  const originHead = refs.originHead?.replace(/^refs\/remotes\//, '') ?? null;
  const localDefault = originHead?.replace(/^origin\//, '') ?? 'main';
  if (!['main', 'master'].includes(localDefault)) {
    const more = await readRefs(repoDir, [`refs/heads/${localDefault}`]);
    refs = { sha: new Map([...refs.sha, ...more.sha]), originHead: refs.originHead };
  }
  const bases: { name: string; sha: string | undefined }[] = [];
  const localSha = refs.sha.get(`refs/heads/${localDefault}`);
  if (localSha) bases.push({ name: localDefault, sha: localSha });
  if (originHead) bases.push({ name: originHead, sha: refs.sha.get('refs/remotes/origin/HEAD') });
  // Only "it has commits" is kept: a git call that fails (a timeout under load) reads as empty, so empty is asked again.
  const empty = (await once<boolean>(`made\0${repoDir}\0${branch}\0${tip}\0${startedAt}`, async () => ((await emptyBranch(repoDir, branch, startedAt, tip)) ? null : false))) ?? true;
  let ahead = 0;
  let merged = false;
  for (const base of bases) {
    const count = base.sha ? await countBetween(repoDir, base.sha, tip) : null;
    if (count === null) continue;
    if (base === bases[0]) ahead = count;
    if (count === 0) merged = !empty;
  }
  // In a build with a branch (specs/build-branches.md): whether its work is in build/<n> yet.
  const buildSha = builds.map((r) => refs.sha.get(r)).find(Boolean);
  return {
    branch,
    tip,
    base: bases[0]?.name ?? null,
    ahead,
    merged,
    empty,
    build: buildSha ? {
      n: build!,
      merged: !empty && await contains(repoDir, buildSha, tip) === true,
      ahead: (await countBetween(repoDir, buildSha, tip)) ?? 0,
    } : null,
    pr: withPr ? await findPr(repoDir, branch) : null,
    deploy: merged && live ? await deployed(repoDir, tip, live) : null,
    uncommitted: worktree ? await uncommittedFiles(worktree) : 0,
  };
}

/** Commits in `tip` that `base` lacks (both hashes); null when git can't tell. */
function countBetween(repoDir: string, base: string, tip: string): Promise<number | null> {
  return once(`count\0${repoDir}\0${base}\0${tip}`, async () => {
    const n = Number(await tryGit(['rev-list', '--count', `${base}..${tip}`], repoDir) ?? NaN);
    return Number.isNaN(n) ? null : n;
  });
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
export async function emptyBranch(repoDir: string, branch: string, startedAt: number, tip: string = branch): Promise<boolean> {
  const made = await madeCommits(repoDir, branch, Math.floor(startedAt / 1000));
  if (made !== null) return !made;
  const tipTime = Number(await tryGit(['log', '-1', '--format=%ct', tip], repoDir)) * 1000;
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

const HASH = /^[0-9a-f]{40,64}$/;

/** Is `ancestor` contained in `commit`? Null when the repo doesn't know one of them. Kept when both are hashes. */
async function contains(repoDir: string, commit: string, ancestor: string): Promise<boolean | null> {
  if (HASH.test(commit) && HASH.test(ancestor)) return once(`contains\0${repoDir}\0${commit}\0${ancestor}`, () => isAncestor(repoDir, commit, ancestor));
  return isAncestor(repoDir, commit, ancestor);
}

async function isAncestor(repoDir: string, commit: string, ancestor: string): Promise<boolean | null> {
  try {
    await run('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: repoDir, timeout: 15_000 });
    return true;
  } catch (err) {
    return (err as { code?: number }).code === 1 ? false : null;
  }
}

/** Whether the live checkout and the running server contain the branch's tip. */
async function deployed(repoDir: string, tip: string, live: Live): Promise<BranchStatus['deploy']> {
  // Another scheme's repo doesn't know the server's commit: its work never deploys here.
  const isLive = live.head ? await contains(repoDir, live.head, tip) : null;
  if (isLive === null) return null;
  const checkout = isLive ? null : await checkoutHead(live.checkoutDir);
  const pulled = isLive || (!!checkout && (await contains(repoDir, checkout, tip)) === true);
  return { pulled, live: isLive };
}

/**
 * The live checkout's HEAD commit, read from its .git files (no process: #1463), else from git: a detached HEAD
 * holds the hash, a branch HEAD names a loose ref. A packed ref, a worktree's .git file or anything odd asks git.
 */
export async function checkoutHead(dir: string): Promise<string | null> {
  try {
    const head = (await readFile(join(dir, '.git', 'HEAD'), 'utf8')).trim();
    if (HASH.test(head)) return head;
    const ref = head.match(/^ref: (refs\/[^\s]+)$/)?.[1];
    if (ref && !ref.includes('..')) {
      const sha = (await readFile(join(dir, '.git', ref), 'utf8')).trim();
      if (HASH.test(sha)) return sha;
    }
  } catch { /* fall back to git */ }
  return tryGit(['rev-parse', 'HEAD'], dir);
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
  // public/threadstate.js refBucket reads "Shipped to " as final (shown as deployed): keep the words in step.
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
