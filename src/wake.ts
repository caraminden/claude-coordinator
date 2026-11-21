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
import { buildRefOf, madeCommits } from './branch.ts';
import type { Store } from './db.ts';
import { githubRepo } from './github.ts';
import type { Runner } from './runner.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';
import { catchUpTicketDir } from './workspace.ts';
import { ZONE, pacificWeekday } from './pacific.ts';

const run = promisify(execFile);
/** A PR lookup's answer: tests' stand-ins answer at once. */
type Maybe<T> = T | Promise<T>;

/** A note a minion queued for another scheme's Taskmaster or a minion of its own scheme (relay_when_live), sent once `commit` is live. */
export interface Relay {
  id: number;
  /** The id of the minion that queued it. */
  ticket: number;
  /** Where it goes: held mail for a scheme's Taskmaster (`scheme` is its name), or for a minion (#number). */
  to: { scheme: string; taskmaster: number } | { minion: number; number: number };
  text: string;
  commit: string;
}

/** Relays split into runs from one minion with the same text and commit, in order: they share their Taskmaster notes. */
export function groupRelays(rs: Relay[]): Relay[][] {
  const groups = new Map<string, Relay[]>();
  for (const r of rs) {
    const key = JSON.stringify([r.ticket, r.commit, r.text]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

/** Where relays go, for a note: minion numbers as ranges ("#579–#586", "#3, #5–#7"), then scheme names. */
export function relayDests(rs: Relay[]): string {
  const nums = [...new Set(rs.flatMap((r) => ('minion' in r.to ? [r.to.number] : [])))].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    runs.push(j - i >= 2 ? `#${nums[i]}–#${nums[j]}` : nums.slice(i, j + 1).map((n) => `#${n}`).join(', '));
    i = j + 1;
  }
  return [...runs, ...new Set(rs.flatMap((r) => ('scheme' in r.to ? [r.to.scheme] : [])))].join(', ');
}

/** A minion waiting for a commit to be live, or (commit null) for the next deploy after `since`. */
export interface Waiter {
  ticket: number;
  commit: string | null;
  reason: string;
  /** The commit the server ran when the waiter was set; a no-commit waiter wakes once that changes. */
  since: string | null;
  /** Its wake is a machine's notice of success (a handed-off land now live, #942), which runs at low effort (#951). */
  light?: true;
}

/** How people read a chain's `when` (Cara, 2026-11-19: "Land"): "#3's work has landed", "... is merged into Build 4" for a feeder (whose merged means in its build), or "... is live". */
export const chainIs = (when: Chain['when'], build?: number | null) => (when !== 'merged' ? 'is live' : build ? `is merged into Build ${build}` : 'has shipped');

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
const RELAYS = 'relay-when-live';

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

/**
 * A red's fix minion (#1074): its branch's tip once commits it made since `since` (unix seconds) are in `sha` (the
 * default branch's tip on GitHub), by hash or as patch twins after a rebase; else null, as for a minion with no commits
 * of its own, or a tip that only caught up to main.
 */
export async function fixShipped(repo: string, branch: string, since: number, sha: string): Promise<string | null> {
  if (!(await madeCommits(repo, branch, since))) return null;
  const tip = await git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`]);
  return tip && (await within(repo, sha, tip)) ? tip : null;
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
  private send: (ticketId: number, text: string, light?: boolean) => void;
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
  /** A relay is live: leave its text as held mail (set by the server, which owns the runner). */
  deliver: (r: Relay) => void = () => {};
  /** Relays just delivered together (one minion, same text and commit): the sender's Taskmaster hears of them in one note. */
  sent: (rs: Relay[]) => void = () => {};
  /** The commit the server runs now: what it booted from, then what its front end last reloaded to. */
  head: string | null;
  /** The check waiting for its turn, if any, and the end of the newest one: checks run one at a time. */
  private queued: Promise<number> | null = null;
  private last: Promise<unknown> = Promise.resolve();
  prs: PrLookup = githubPrs();

  constructor(store: Store, repo: string, head: string | null, send: (ticketId: number, text: string, light?: boolean) => void) {
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
   * its scheme's main, or for a feeder its build's branch), 'unshipped' once it was dismissed with its work in neither, else 'wait'. Work
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
    if (!landed) {
      // A feeder merged into its build (specs/build-branches.md) has shipped as far as it goes alone, and
      // closes then: merged means in the build, and live waits for the build to land (where this server runs the code).
      const ref = leader.build ? await buildRefOf(b.repo, leader.build) : null;
      if (ref && (await within(b.repo, ref, b.tip))) return c.when === 'merged' || !(await runs(b.repo, this.head)) ? 'go' : 'wait';
      return closed ? 'unshipped' : 'wait';
    }
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

  /**
   * What wakes parked `ticket` by itself: its start_after leader's work, unless the chain is held (only Unpark starts it then),
   * or its wake_when_live reason; null when nothing here does. The list shows such a minion under Waiting, not Parked.
   */
  wakesOn(ticket: number): string | null {
    const c = this.chains().find((o) => o.ticket === ticket);
    if (c) return c.held ? null : this.heldFor(ticket);
    return this.list().find((w) => w.ticket === ticket)?.reason ?? null;
  }

  /** What `ticket`, parked on start_after, waits for ("#3 Leader's work has landed"), or null when it isn't. */
  heldFor(ticket: number): string | null {
    const c = this.chains().find((o) => o.ticket === ticket);
    const leader = c && this.store.getTicket(c.after);
    if (!c) return null;
    const who = `#${leader?.number ?? c.after} ${leader?.title ?? ''}`;
    return c.held ? `${who}'s work ${chainIs(c.when, leader?.build)}, and ${who} was dismissed without it, so only Unpark starts you` : `${who}'s work ${chainIs(c.when, leader?.build)}`;
  }

  /** The brief `ticket` holds until its leader's work is in, for its chat to show read-only; null once it is sent (release) or when there is none. */
  heldBrief(ticket: number): { text: string; from: string; leader: number; when: Chain['when']; is: string } | null {
    const c = this.chains().find((o) => o.ticket === ticket);
    if (!c || !c.message) return null;
    const leader = this.store.getTicket(c.after);
    return { text: c.message, from: c.from, leader: leader?.number ?? c.after, when: c.when, is: chainIs(c.when, leader?.build) };
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
    for (const c of go) this.start(c, `${n(c.after)}'s work ${chainIs(c.when, this.store.getTicket(c.after)?.build)}`);
    for (const c of hold) this.hold(c, `${n(c.after)} was dismissed without its work shipping`);
    return go.length;
  }

  relays(ticket?: number): Relay[] {
    return (this.store.getSetting<Relay[]>(RELAYS) ?? []).filter((r) => ticket === undefined || r.ticket === ticket);
  }

  /** Queue a relay; false (it was delivered at once) when its commit is live already. */
  async addRelay(r: Omit<Relay, 'id'>): Promise<{ queued: boolean; relay: Relay }> {
    const relay = { ...r, id: Math.max(0, ...this.relays().map((o) => o.id)) + 1 };
    // Asked again if a deploy went live meanwhile, as add() does: its check has been and gone without this relay.
    let since: number | string | undefined;
    do {
      since = this.head;
      if (await this.live({ ticket: r.ticket, commit: r.commit, reason: '', since })) {
        this.deliver(relay);
        return { queued: false, relay };
      }
    } while (since !== this.head);
    // Read again: another relay may have been queued while git ran.
    const now = this.relays();
    relay.id = Math.max(relay.id, ...now.map((o) => o.id + 1));
    this.store.setSetting(RELAYS, [...now, relay]);
    return { queued: true, relay };
  }

  /** Drop `ticket`'s pending relay `id`; the relay, or null when it has none. */
  cancelRelay(ticket: number, id: number): Relay | null {
    const all = this.relays();
    const r = all.find((o) => o.id === id && o.ticket === ticket) ?? null;
    if (r) this.store.setSetting(RELAYS, all.filter((o) => o !== r));
    return r;
  }

  /** Deliver each relay whose commit is live, once; a dismissed minion's relays go out too. */
  private async checkRelays(): Promise<void> {
    const ready: Relay[] = [];
    for (const r of this.relays()) if (await this.live({ ticket: r.ticket, commit: r.commit, reason: '', since: this.head })) ready.push(r);
    // Dropped before sending, so a send that throws can't deliver one twice; read again: one cancelled meanwhile stays cancelled.
    const now = this.relays();
    const go = ready.filter((r) => now.some((o) => o.id === r.id));
    if (!go.length) return;
    this.store.setSetting(RELAYS, now.filter((r) => !go.some((o) => o.id === r.id)));
    for (const r of go) {
      try {
        this.deliver(r);
      } catch (err) {
        console.error(`Relaying #${r.ticket}'s note failed:`, err);
      }
    }
    for (const batch of groupRelays(go)) {
      try {
        this.sent(batch);
      } catch (err) {
        console.error(`Noting #${batch[0].ticket}'s relays failed:`, err);
      }
    }
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
  async add(ticket: number, commit: string | null, reason: string, light = false): Promise<boolean> {
    let w: Waiter;
    // Asked again if a deploy went live meanwhile: its check has been and gone without this waiter.
    do {
      w = { ticket, commit, reason, since: this.head, ...(light ? { light: true as const } : {}) };
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
        else this.send(w.ticket, `${w.commit ? `\`${short(w.commit)}\` is live now` : 'A deploy is live now'} (the server runs \`${short(head!)}\`): ${w.reason}`, !!w.light);
      } catch (err) {
        console.error(`Waking #${w.ticket} failed:`, err); // the others still get theirs
      }
    }
    await this.checkRelays();
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
      await catchUpTicketDir(t.cwd, repo, t.build).catch((err) => console.error(`Catching up #${t.number}'s branch failed:`, err));
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

// wake_at (#722): a minion or Taskmaster asks to be messaged, in its own chat, at a time. The list is in the settings
// table like the waiters, so it outlives a restart; one timer waits for the nearest, and boot catches up on any missed.
const TIMED = 'timed-wakes';
export const MAX_WAKES = 20;
export const MAX_AHEAD_MS = 90 * 86_400_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TimedWake { id: number; ticket: number; at: number; note: string; setBy: string }

/** `ms` as "Tue 18 Nov, 09:00 PST": every time people read is Pacific. */
export const pacificTime = pacificWeekday;

/** An ISO time ("2026-11-18 09:00", "…T09:00:00Z", "…-08:00") as ms; without an offset it is Pacific. NaN when it isn't a time. */
export function parseWakeTime(text: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?\s*(Z|[+-]\d\d:?\d\d)?$/i.exec(text.trim());
  if (!m) return NaN;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1, 7).map((x) => Number(x ?? 0));
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  if (new Date(local).getUTCMonth() !== mo - 1 || h > 23 || mi > 59 || s > 59) return NaN; // 31 Nov, 24:00, 09:99
  if (m[7] && Number(m[7].slice(-2)) > 59) return NaN;
  if (m[7]) return m[7].toUpperCase() === 'Z' ? local : local - (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(-2))) * 60_000;
  // Pacific: guess the zone's offset at that instant, then correct once (the guess can sit across a DST change).
  const offset = (t: number) => {
    const z = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'longOffset' }).formatToParts(t).find((x) => x.type === 'timeZoneName')!.value; // "GMT-08:00"
    const [, sign, hh, mm] = /GMT([+-])(\d\d):(\d\d)/.exec(z)!;
    return (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm)) * 60_000;
  };
  return local - offset(local - offset(local));
}

export class TimedWakes {
  private store: Store;
  private send: (ticketId: number, text: string) => void;
  now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, send: (ticketId: number, text: string) => void, now: () => number = Date.now) {
    this.store = store;
    this.send = send;
    this.now = now;
  }

  list(ticket?: number): TimedWake[] {
    const all = this.store.getSetting<TimedWake[]>(TIMED) ?? [];
    return ticket === undefined ? all : all.filter((w) => w.ticket === ticket);
  }

  /** The soonest wake of `ticket`, for its list note, or null. */
  next(ticket: number): TimedWake | null {
    return this.list(ticket).sort((a, b) => a.at - b.at)[0] ?? null;
  }

  /** Set a wake; throws a message the caller can pass on when the time is past, too far out, or the chat has too many. */
  add(ticket: number, at: number, note: string, setBy: string): TimedWake {
    const now = this.now();
    if (!Number.isFinite(at)) throw new Error('That is not a time: use "2026-11-18 09:00" (Pacific unless it ends in Z or an offset like -08:00).');
    if (at <= now) throw new Error(`${pacificTime(at)} is already past (it is ${pacificTime(now)}). Give a later time.`);
    if (at > now + MAX_AHEAD_MS) throw new Error(`${pacificTime(at)} is more than 90 days away. Set a wake nearer the date, or ask a person.`);
    if (this.list(ticket).length >= MAX_WAKES) throw new Error(`This chat already has ${MAX_WAKES} wakes pending: cancel one first.`);
    const all = this.list();
    const w = { id: Math.max(0, ...all.map((o) => o.id)) + 1, ticket, at, note, setBy };
    this.store.setSetting(TIMED, [...all, w]);
    this.arm();
    return w;
  }

  /** Cancel one of `ticket`'s wakes; false when it is gone (already fired, or never its own). */
  cancel(ticket: number, id: number): boolean {
    const all = this.list();
    if (!all.some((w) => w.id === id && w.ticket === ticket)) return false;
    this.store.setSetting(TIMED, all.filter((w) => w.id !== id));
    this.arm();
    return true;
  }

  /** Send every wake that is due (a dismissed minion's is dropped unsent), then wait for the next. */
  fire(): number {
    const now = this.now();
    const all = this.list();
    const due = all.filter((w) => w.at <= now);
    // Dropped before sending, so a send that throws can't send twice.
    if (due.length) this.store.setSetting(TIMED, all.filter((w) => w.at > now));
    for (const w of due) {
      const t = this.store.getTicket(w.ticket);
      if (!t || t.status === 'closed') continue;
      try {
        // The runner queues a send for a chat mid-turn, so it is read after that turn ends.
        this.send(w.ticket, `Wake you set for ${pacificTime(w.at)}: ${w.note}`);
      } catch (err) {
        console.error(`Waking #${w.ticket} (wake_at) failed:`, err);
      }
    }
    this.arm();
    return due.length;
  }

  /** One timer, to the nearest wake (capped: setTimeout can't count past 24 days). At boot this also sends the ones missed while down. */
  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const soonest = Math.min(...this.list().map((w) => w.at));
    if (!Number.isFinite(soonest)) return;
    this.timer = setTimeout(() => this.fire(), Math.min(Math.max(soonest - this.now(), 0), MAX_TIMER_MS));
    this.timer.unref();
  }
}
