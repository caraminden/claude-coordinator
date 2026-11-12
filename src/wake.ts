// wake_when_live: minions waiting on someone else's deploy hear once it is live, instead of relying
// on the Taskmaster to remember. The server checks the waiters when it starts (a restart) and when it
// reloads its front end (a front-end-only deploy, which doesn't restart).
// Chained minions (create_ticket's start_after) use the same check: one is created parked, with its
// brief held until the minion it follows has its work live (or merged); also checked when a minion
// is dismissed.
// In a scheme whose code this server doesn't run (Delve), nothing deploys here, so live means merged
// on that scheme's main, for chains and commit waiters alike: checked whenever chains are.
// Merged also counts a pull request merged on GitHub (#229): a squash or rebase merge leaves none of
// the branch's commits on main, so there the PR's merge commit stands in for them.
// And a commit counts by its change (#261): one landed from another branch, cherry-picked or rebased
// with a new hash, the way one minion lands another's work. A branch with no commits of its own never
// counts as work in: it is on main trivially.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { madeCommits } from './branch.ts';
import type { Store } from './db.ts';
import { githubRepo } from './github.ts';
import type { Runner } from './runner.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';
import { catchUpTicketDir } from './workspace.ts';

const run = promisify(execFile);
/** A PR lookup's answer: tests' stand-ins answer at once. */
type Maybe<T> = T | Promise<T>;

/** A minion waiting for a commit to be live, or (commit null) for the next deploy after `since`. */
export interface Waiter {
  ticket: number;
  commit: string | null;
  reason: string;
  /** The commit the server ran when the waiter was set; a no-commit waiter wakes once that changes. */
  since: string | null;
}

/** A minion created parked, whose brief is held until minion `after`'s work is live or merged. */
export interface Chain {
  ticket: number;
  /** The id (not number) of the minion it follows. */
  after: number;
  when: 'live' | 'merged';
  /** Its first message, and who wrote it. */
  message: string;
  from: string;
  /** The followed minion's branch tip when the chain was set, if that was already on main: no work of its own yet. */
  base: string | null;
  /** When the chain was set (unix seconds, from follow()): with base, only commits after this count; none if unset (set before #126). */
  since?: number;
  /** People were told the followed minion was dismissed without shipping; kept, in case it ships after all. */
  held?: boolean;
}

/** A merged pull request: the commit it was opened at (its head) and the one main got (its merge commit). */
export interface PrMerge {
  number: number;
  head: string;
  commit: string | null;
}

/** Asks GitHub about merged pull requests in a scheme's repo; tests swap in their own. */
export interface PrLookup {
  /** The newest PR opened from `branch` (whose tip is `tip`), if it is merged. */
  branch(repo: string, branch: string, tip: string): Maybe<PrMerge | null>;
  /** A merged PR that contains `commit`. */
  commit(repo: string, commit: string): Maybe<PrMerge | null>;
  /** Drop the remembered "not merged" answers: a PR was just seen merged. */
  forget?(): void;
}

/** The answer of `gh pr list --json number,state,headRefOid,mergeCommit`, newest first: its first PR if merged. */
export function mergedPr(list: { number: number; state: string; headRefOid: string; mergeCommit?: { oid: string } | null }[]): PrMerge | null {
  const pr = list[0];
  return pr?.state === 'MERGED' ? { number: pr.number, head: pr.headRefOid, commit: pr.mergeCommit?.oid ?? null } : null;
}

/** The answer of GitHub's "pull requests of a commit" API: a merged one, if any. */
export function mergedPrOf(list: { number: number; merged_at: string | null; head: { sha: string }; merge_commit_sha: string | null }[]): PrMerge | null {
  const pr = list.find((p) => p.merged_at);
  return pr ? { number: pr.number, head: pr.head.sha, commit: pr.merge_commit_sha } : null;
}

// A PR that wasn't merged is asked about again after this long; a merged one is remembered.
const UNMERGED_MS = 60_000;

/**
 * PR lookups through the gh CLI, for repos whose origin is on GitHub. Each is cached: a call takes
 * about half a second, and checks run at restarts, reloads and dismissals. `as` gives
 * a repo's GitHub login (#321: its scheme owner's, since a private repo may let no one else read it).
 */
export function githubPrs(as: (repo: string) => GithubEnv = () => undefined): PrLookup {
  const merged = new Map<string, PrMerge>();
  const unmerged = new Map<string, number>();
  // Counts forget()s: an answer asked for before one is too old to remember as "not merged".
  let forgets = 0;
  const ask = async (repo: string, key: string, args: string[], parse: (json: any) => PrMerge | null): Promise<PrMerge | null> => {
    const hit = merged.get(key);
    if (hit) return hit;
    if ((unmerged.get(key) ?? 0) > Date.now() || !githubRepo((await git(repo, ['remote', 'get-url', 'origin'])) ?? '')) return null;
    let pr: PrMerge | null = null;
    const asked = forgets;
    try {
      pr = parse(JSON.parse((await run('gh', args, { cwd: repo, env: asEnv(as(repo)), encoding: 'utf8', timeout: 8_000 })).stdout));
    } catch (err: any) {
      console.error(`Asking GitHub about ${key.split('\0').slice(1).join(' ')} failed:`, err.stderr?.trim() || err.message);
    }
    if (pr) merged.set(key, pr);
    else if (asked === forgets) unmerged.set(key, Date.now() + UNMERGED_MS);
    return pr;
  };
  return {
    // Keyed by the tip too: a new commit on the branch may mean a new PR.
    branch: (repo, branch, tip) => ask(repo, `${repo}\0${branch}\0${tip}`,
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,headRefOid,mergeCommit'], mergedPr),
    commit: (repo, commit) => ask(repo, `${repo}\0${commit}`, ['api', `repos/{owner}/{repo}/commits/${commit}/pulls`], mergedPrOf),
    forget: () => {
      forgets++;
      unmerged.clear();
    },
  };
}

/** All waiters, in the settings table so they outlive the restart they wait for. */
const KEY = 'wake-when-live';
const CHAINS = 'chained-minions';

// Never execFileSync here (#526): a check runs dozens of these, and the server answered nobody until they ended.
async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    // A patch-id log over a long-lived branch's span can pass the 1 MB default.
    return (await run('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * The commit of `ref` by which `tip`'s work is in it, or null: `tip` when `ref` contains it, else the
 * newest commit of `ref` with the same change as one of tip's own commits, once every one of those
 * has its twin there (landed from another branch with new hashes). Merge commits aren't work.
 * shortcut: a squash outside a PR, or a pick that resolved a conflict, changes the patch and isn't seen; the dependency's merged PR or its dismissal covers most of those.
 */
export async function within(repo: string, ref: string, tip: string): Promise<string | null> {
  if ((await git(repo, ['merge-base', '--is-ancestor', tip, ref])) !== null) return tip;
  // Each side's commits that change something, as '=' (has a twin) or '+' and the hash: empty commits all share one patch id.
  const marks = async (side: string) => ((await git(repo, ['log', '--cherry-mark', side, '--no-merges', '--topo-order', '--raw', '--format=%x00%m%H', `${ref}...${tip}`])) ?? '')
    .split('\0').filter((c) => c.includes('\n:')).map((c) => c.slice(0, c.indexOf('\n')));
  const own = await marks('--right-only');
  if (!own.length || own.some((m) => !m.startsWith('='))) return null;
  return (await marks('--left-only')).find((m) => m.startsWith('='))?.slice(1) ?? null;
}

/** Whether the server running `head` runs this scheme's code: that commit is in the scheme's repo. */
async function runs(repo: string | null, head: string | null): Promise<boolean> {
  return !!repo && !!head && (await git(repo, ['cat-file', '-e', `${head}^{commit}`])) !== null;
}

/** The same, at once, for callers that can't wait (a turn's start): one git call of a few ms. */
export function runsRepo(repo: string | null, head: string | null): boolean {
  if (!repo || !head) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class LiveWaiters {
  private store: Store;
  /** The live checkout: the server's own code. */
  private repo: string;
  private send: (ticketId: number, text: string) => void;
  /**
   * Start a chained minion: give it its held brief. Its chain stays stored until then, so a start that
   * never sends (the server dies while it catches up the branch) runs again after a restart: the start
   * calls release() as it sends, and end() when it is over either way.
   */
  start: (c: Chain, why: string) => void = () => {};
  /** Chained minions whose start is running in this process: check() leaves them be. */
  private starting = new Set<number>();
  /** A chained minion's leader was dismissed without shipping: tell people, once. */
  hold: (c: Chain, why: string) => void = () => {};
  /** The commit the server runs now: what it booted from, then what its front end last reloaded to. */
  head: string | null;
  /** The check waiting for its turn, if any, and the end of the newest one: checks run one at a time. */
  private queued: Promise<number> | null = null;
  private last: Promise<unknown> = Promise.resolve();
  prs: PrLookup = githubPrs();

  constructor(store: Store, repo: string, head: string | null, send: (ticketId: number, text: string) => void) {
    this.store = store;
    this.repo = repo;
    this.head = head;
    this.send = send;
  }

  chains(): Chain[] {
    return this.store.getSetting<Chain[]>(CHAINS) ?? [];
  }

  /** The repo of `ticket`'s scheme, when this server doesn't run its code: there live means merged. */
  async elsewhere(ticket: number): Promise<string | null> {
    const t = this.store.getTicket(ticket);
    const repo = t && this.store.getProject(t.project_id)?.repo_dir;
    return repo && this.head && !(await runs(repo, this.head)) ? repo : null;
  }

  /** The commit by which `commit` is on the scheme's main, locally or on origin, or null. */
  private async merged(repo: string, commit: string): Promise<string | null> {
    for (const ref of await this.mains(repo)) {
      const c = await within(repo, ref, commit);
      if (c) return c;
    }
    return null;
  }

  /** The refs that are a repo's main: local, and origin's if it has one. */
  private async mains(repo: string): Promise<string[]> {
    const refs: string[] = [];
    for (const ref of ['HEAD', 'refs/remotes/origin/HEAD']) if ((await git(repo, ['rev-parse', '-q', '--verify', ref])) !== null) refs.push(ref);
    return refs;
  }

  /**
   * The commit by which a followed minion's work is on its scheme's main, or null: its branch tip when
   * main has it (or the main commit by which main has all of its changes), else the merge commit of the
   * branch's newest PR, if that is merged and the branch has no commits of its own since the PR's head
   * (merging main in doesn't count).
   */
  private async landed(b: { repo: string; branch: string; tip: string }): Promise<string | null> {
    const merged = await this.merged(b.repo, b.tip);
    if (merged) return merged;
    const pr = await this.prs.branch(b.repo, b.branch, b.tip);
    if (!pr?.commit) return null;
    const since = pr.head === b.tip ? '0' : await git(b.repo, ['rev-list', '--count', '--no-merges', b.tip, `^${pr.head}`, ...(await this.mains(b.repo)).map((r) => `^${r}`)]);
    return since === '0' ? pr.commit : null;
  }

  /** The followed minion's scheme repo, branch and its tip, or null when it has neither. */
  private async tip(after: number): Promise<{ repo: string; branch: string; tip: string } | null> {
    const t = this.store.getTicket(after);
    const repo = t && this.store.getProject(t.project_id)?.repo_dir;
    const tip = repo && t.branch ? await git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${t.branch}^{commit}`]) : null;
    return repo && tip ? { repo, branch: t.branch!, tip } : null;
  }

  /**
   * Did the minion commit on `branch` at or after `since` (unix seconds), with that work still on it? Its
   * tip alone can't tell: a branch caught up to a newer main (a fast-forward) has a new tip that is on
   * main, but none of its own work, and so does one whose commits a rebase dropped (madeCommits).
   */
  private async committed(repo: string, branch: string, since: number): Promise<boolean> {
    return (await madeCommits(repo, branch, since)) ?? false;
  }

  /**
   * Where a chain stands: 'go' once the followed minion's work is in (live: the running server; merged:
   * its scheme's main), 'unshipped' once it was dismissed with its work in neither, else 'wait'. Work
   * means commits it made (since the chain was set, if its tip was on main then), or anything at all once
   * it is dismissed: a dismissed minion that never committed counts as done. A scheme whose
   * code this server doesn't run can't be live, so there live means merged.
   */
  private async chainState(c: Chain): Promise<'go' | 'wait' | 'unshipped'> {
    const leader = this.store.getTicket(c.after);
    if (!leader) return 'unshipped';
    const closed = leader.status === 'closed';
    const b = await this.tip(c.after);
    if (!b) return closed ? 'go' : 'wait'; // no repo: dismissed is all there is to wait for
    if (!closed && !(await this.committed(b.repo, b.branch, c.base ? (c.since ?? Infinity) : 0))) return 'wait';
    const landed = await this.landed(b);
    if (!landed) return closed ? 'unshipped' : 'wait';
    if (c.when === 'merged' || !(await runs(b.repo, this.head))) return 'go';
    return (await this.live({ ticket: c.ticket, commit: landed, reason: '', since: null })) ? 'go' : 'wait';
  }

  /**
   * Where following minion `after` stands right now, checked before a chained minion is created:
   * 'go' (start it at once), 'wait' (hold it, with `base` and `since` for chain), or 'unshipped' (refuse).
   */
  async follow(after: number, when: Chain['when']): Promise<{ state: 'go' | 'wait' | 'unshipped'; base: string | null; since: number }> {
    const b = await this.tip(after);
    const base = b && (await this.landed(b)) ? b.tip : null;
    const since = Math.floor(Date.now() / 1000);
    return { state: await this.chainState({ ticket: 0, after, when, message: '', from: '', base, since }), base, since };
  }

  /** Hold a chained minion's brief (after follow said 'wait'). */
  chain(c: Chain): void {
    this.store.setSetting(CHAINS, [...this.chains().filter((o) => o.ticket !== c.ticket), c]);
  }

  /** What `ticket`, parked on start_after, waits for ("#3 Leader's work is merged"), or null when it isn't. */
  heldFor(ticket: number): string | null {
    const c = this.chains().find((o) => o.ticket === ticket);
    const leader = c && this.store.getTicket(c.after);
    if (!c) return null;
    const who = `#${leader?.number ?? c.after} ${leader?.title ?? ''}`;
    return c.held ? `${who}'s work is ${c.when}, and ${who} was dismissed without it, so only Start now starts you` : `${who}'s work is ${c.when}`;
  }

  /** `ticket`'s held brief, kept in the chain, for a start about to run (Start now); null when none, or one already runs. */
  claim(ticket: number): Chain | null {
    const c = this.chains().find((o) => o.ticket === ticket) ?? null;
    if (!c || this.starting.has(ticket)) return null;
    this.starting.add(ticket);
    return c;
  }

  /** A start of `ticket` is over, sent or not: the next check() may start it again if its chain is still stored. */
  end(ticket: number): void {
    this.starting.delete(ticket);
  }

  /** Take `ticket`'s held brief out of the chain (its start sends it now), or null. */
  release(ticket: number): Chain | null {
    const all = this.chains();
    const c = all.find((o) => o.ticket === ticket) ?? null;
    if (c) this.store.setSetting(CHAINS, all.filter((o) => o !== c));
    return c;
  }

  /** Start each chained minion whose leader's work is in; tell people about leaders dismissed unshipped. */
  private async checkChains(): Promise<number> {
    const states = new Map<number, 'go' | 'wait' | 'unshipped'>();
    for (const c of this.chains()) {
      const t = this.store.getTicket(c.ticket);
      if (t && t.status !== 'closed') states.set(c.ticket, await this.chainState(c));
    }
    const keep: Chain[] = [];
    const go: Chain[] = [];
    const hold: Chain[] = [];
    // Read again, and nothing below waits: a chain set or released while git and gh ran stays as it is now.
    for (const c of this.chains()) {
      const t = this.store.getTicket(c.ticket);
      if (!t || t.status === 'closed') continue;
      const state = states.get(c.ticket);
      // Kept until its start sends the brief (release), so a start the server dies in runs again.
      if (state === 'go') {
        keep.push(c);
        if (!this.starting.has(c.ticket)) go.push(c);
      } else keep.push(state === 'unshipped' && !c.held ? (hold.push(c), { ...c, held: true }) : c);
    }
    this.store.setSetting(CHAINS, keep);
    const n = (id: number) => `#${this.store.getTicket(id)?.number ?? id}`;
    for (const c of go) this.starting.add(c.ticket);
    for (const c of go) this.start(c, `${n(c.after)}'s work is ${c.when === 'merged' ? 'merged' : 'live'}`);
    for (const c of hold) this.hold(c, `${n(c.after)} was dismissed without its work being merged`);
    return go.length;
  }

  list(): Waiter[] {
    return this.store.getSetting<Waiter[]>(KEY) ?? [];
  }

  /** The full hash of a commit the live checkout (unless `only`) or `otherRepo` (the scheme's repo) knows, or null. */
  async resolve(commit: string, otherRepo: string | null, only = false): Promise<string | null> {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null;
    for (const dir of only ? [otherRepo] : [this.repo, otherRepo]) {
      const full = dir && (await git(dir, ['rev-parse', '-q', '--verify', `${commit}^{commit}`]));
      if (full) return full;
    }
    return null;
  }

  /**
   * Is this waiter's deploy live (in a scheme this server doesn't run: its commit merged)? A commit
   * in a merged PR counts by the PR's merge commit, which a squash or rebase merge needs.
   */
  private async live(w: Waiter): Promise<boolean> {
    const head = this.head;
    if (!head) return false;
    const other = await this.elsewhere(w.ticket);
    if (other) return !!w.commit && (!!(await this.merged(other, w.commit)) || !!(await this.prs.commit(other, w.commit))?.commit);
    if (!w.commit) return head !== w.since;
    // The live checkout pulls only main, so a branch commit that landed rebased is known only to the
    // scheme's repo, which also has the live commit here (else it would be elsewhere()): look there too.
    const t = this.store.getTicket(w.ticket);
    const scheme = t && this.store.getProject(t.project_id)?.repo_dir;
    const has = async (c: string) => (await within(this.repo, head, c)) !== null || (!!scheme && scheme !== this.repo && (await runs(scheme, head)) && (await within(scheme, head, c)) !== null);
    if (await has(w.commit)) return true;
    const pr = await this.prs.commit(this.repo, w.commit);
    return !!pr?.commit && (await has(pr.commit));
  }

  /**
   * Wait for `commit` (a full hash, or null for the next deploy). Returns false, storing nothing, when
   * it is live already. A second call for the same ticket and commit replaces the first.
   */
  async add(ticket: number, commit: string | null, reason: string): Promise<boolean> {
    let w: Waiter;
    // Asked again if a deploy went live meanwhile: its check has been and gone without this waiter.
    do {
      w = { ticket, commit, reason, since: this.head };
      if (commit && (await this.live(w))) return false;
    } while (w.since !== this.head);
    this.store.setSetting(KEY, [...this.list().filter((o) => o.ticket !== ticket || o.commit !== commit), w]);
    return true;
  }

  /**
   * The server now runs `head`, or a minion was dismissed: message each waiter whose deploy is live,
   * once, and drop it, and start the chained minions whose leader's work is in. A waiter whose minion
   * was dismissed is dropped without a message. Returns how many were woken or started.
   * Checks run one at a time, off the event loop (#526), and a call while one already waits its turn
   * shares that one: it starts after the call, so it sees all the call would.
   */
  check(head: string | null = this.head): Promise<number> {
    this.head = head;
    if (!this.queued) {
      const next = this.last.then(() => {
        this.queued = null;
        return this.checkNow();
      });
      this.queued = next;
      this.last = next.catch(() => {});
    }
    return this.queued;
  }

  private async checkNow(): Promise<number> {
    const head = this.head;
    const live: Waiter[] = [];
    for (const w of this.list()) {
      const t = this.store.getTicket(w.ticket);
      if (t && t.status !== 'closed' && (await this.live(w))) live.push(w);
    }
    const waiting: Waiter[] = [];
    const woken: Waiter[] = [];
    // Read again, and nothing waits until they are stored: a waiter added while git and gh ran stays.
    for (const w of this.list()) {
      const t = this.store.getTicket(w.ticket);
      if (!t || t.status === 'closed') continue;
      (live.some((o) => o.ticket === w.ticket && o.commit === w.commit && o.since === w.since) ? woken : waiting).push(w);
    }
    // Dropped before sending, so a send that throws can't wake anyone twice.
    this.store.setSetting(KEY, waiting);
    const short = (c: string) => c.slice(0, 7);
    for (const w of woken) {
      try {
        if (w.commit && (await this.elsewhere(w.ticket))) this.send(w.ticket, `\`${short(w.commit)}\` is on the scheme's main now: ${w.reason}`);
        else this.send(w.ticket, `${w.commit ? `\`${short(w.commit)}\` is live now` : 'A deploy is live now'} (the server runs \`${short(head!)}\`): ${w.reason}`);
      } catch (err) {
        console.error(`Waking #${w.ticket} failed:`, err); // the others still get theirs
      }
    }
    return woken.length + (await this.checkChains());
  }

  /**
   * Minions in pending-deploy whose branch the live commit contains, by hash or by change. A deploy reports
   * only to the minions that ran it, so this also catches one whose commit went live in someone else's
   * restart. A branch the minion never committed on is no evidence: any live commit contains it.
   */
  async pendingLive(): Promise<number[]> {
    if (!this.head) return [];
    const ids: number[] = [];
    for (const p of this.store.listProjects()) {
      if (!p.repo_dir) continue;
      for (const t of this.store.listTickets(p.id)) {
        if (t.state !== 'pending-deploy' || t.status === 'closed' || !t.branch) continue;
        // A scheme whose repo doesn't have the live commit (another app's) fails here, as it should.
        if ((await this.committed(p.repo_dir, t.branch, 0)) && (await within(p.repo_dir, this.head, `refs/heads/${t.branch}`))) ids.push(t.id);
      }
    }
    return ids;
  }
}

/**
 * Start a chained minion (LiveWaiters.start, Start now): catch its branch up to what a new minion would
 * branch from, so it builds on the work it waited for, then send its held brief. Both run on the minion's
 * lane: after a turn running in its worktree now (a parked minion answering a message) and that turn's
 * save, never under it, and before the brief's turn (#468 S07-2). The brief stays in the chain until it is
 * sent, so a server that dies during the catch-up starts it after the restart. Resolves once it is sent,
 * or at once while a turn runs, so Start now doesn't wait that turn out.
 */
export async function startChained(c: Chain, why: string, { store, runner, waiters }: { store: Store; runner: Pick<Runner, 'onLane' | 'isRunning' | 'emit' | 'send'>; waiters: LiveWaiters }): Promise<void> {
  const t = store.getTicket(c.ticket);
  if (!t) return waiters.end(c.ticket);
  const repo = store.getProject(t.project_id)?.repo_dir ?? null;
  let failed: { err: unknown } | null = null;
  const sent = runner.onLane(c.ticket, 'chained start', async () => {
    try {
      await catchUpTicketDir(t.cwd, repo).catch((err) => console.error(`Catching up #${t.number}'s branch failed:`, err));
      if (!waiters.release(c.ticket)) return; // dismissed meanwhile
      try {
        runner.emit(c.ticket, 'note', { text: `${why}, so this minion started.` });
        runner.send(c.ticket, c.from, c.message, [], { brief: true });
      } catch (err) {
        waiters.chain(c); // held again: the next check, or Start now, tries again
        failed = { err };
        throw err;
      }
    } finally {
      waiters.end(c.ticket);
    }
  });
  if (runner.isRunning(c.ticket)) return; // it starts once the turn ends; a failure then is logged
  await sent;
  if (failed) throw (failed as { err: unknown }).err; // the lane only logs it: Start now's caller hears it
}
