// wake_when_live: minions waiting on someone else's deploy hear once it is live, instead of relying
// on the Taskmaster to remember. The server checks the waiters when it starts (a restart) and when it
// reloads its front end (a front-end-only deploy, which doesn't restart).
// Chained minions (create_ticket's start_after) use the same check: one is created parked, with its
// brief held until the minion it follows has its work live (or merged); also checked when a minion
// is dismissed.
import { execFileSync } from 'node:child_process';
import type { Store } from './db.ts';

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
  /** When the chain was set (unix seconds; chain() fills it in): with base, only commits after this count. */
  since?: number;
  /** People were told the followed minion was dismissed without shipping; kept, in case it ships after all. */
  held?: boolean;
}

/** All waiters, in the settings table so they outlive the restart they wait for. */
const KEY = 'wake-when-live';
const CHAINS = 'chained-minions';

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export class LiveWaiters {
  private store: Store;
  /** The live checkout: the server's own code. */
  private repo: string;
  private send: (ticketId: number, text: string) => void;
  /** Start a chained minion: give it its held brief. */
  start: (c: Chain, why: string) => void = () => {};
  /** A chained minion's leader was dismissed without shipping: tell people, once. */
  hold: (c: Chain, why: string) => void = () => {};
  /** The commit the server runs now: what it booted from, then what its front end last reloaded to. */
  head: string | null;

  constructor(store: Store, repo: string, head: string | null, send: (ticketId: number, text: string) => void) {
    this.store = store;
    this.repo = repo;
    this.head = head;
    this.send = send;
  }

  chains(): Chain[] {
    return this.store.getSetting<Chain[]>(CHAINS) ?? [];
  }

  /** Is `commit` on the scheme's main, locally or on origin? */
  private merged(repo: string, commit: string): boolean {
    return ['HEAD', 'refs/remotes/origin/HEAD'].some((ref) => git(repo, ['merge-base', '--is-ancestor', commit, ref]) !== null);
  }

  /** The followed minion's scheme repo, branch and its tip, or null when it has neither. */
  private tip(after: number): { repo: string; branch: string; tip: string } | null {
    const t = this.store.getTicket(after);
    const repo = t && this.store.getProject(t.project_id)?.repo_dir;
    const tip = repo && t.branch ? git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${t.branch}^{commit}`]) : null;
    return repo && tip ? { repo, branch: t.branch!, tip } : null;
  }

  /**
   * Did the minion commit on `branch` at or after `since` (unix seconds)? Asks the branch's reflog, since
   * its tip alone can't tell: a branch caught up to a newer main (a fast-forward) has a new tip that is
   * on main, but none of its own work. Merge commits don't count; a rebase keeps the commits it moves.
   */
  private committed(repo: string, branch: string, since: number): boolean {
    const log = git(repo, ['reflog', 'show', '--date=unix', '--format=%gd %gs', `refs/heads/${branch}`]) ?? '';
    return log.split('\n').some((line) => {
      const m = line.match(/@\{(\d+)\}\s+(.*)$/);
      return !!m && Number(m[1]) >= since && /^(commit(?! \(merge\))|cherry-pick|revert)\b/.test(m[2]);
    });
  }

  /**
   * Where a chain stands: 'go' once the followed minion's work is in (live: the running server; merged:
   * its scheme's main), 'unshipped' once it was dismissed with its work in neither, else 'wait'. Work
   * means commits it made (since the chain was set, if its tip was on main then), or anything at all once
   * it is dismissed: a dismissed minion that never committed counts as done. A scheme whose
   * code this server doesn't run can't be live, so there live means merged.
   */
  private chainState(c: Chain): 'go' | 'wait' | 'unshipped' {
    const leader = this.store.getTicket(c.after);
    if (!leader) return 'unshipped';
    const closed = leader.status === 'closed';
    const b = this.tip(c.after);
    if (!b) return closed ? 'go' : 'wait'; // no repo: dismissed is all there is to wait for
    const merged = this.merged(b.repo, b.tip);
    if (closed && !merged) return 'unshipped';
    if (!merged || (!closed && !this.committed(b.repo, b.branch, c.base ? (c.since ?? 0) : 0))) return 'wait';
    const runsThisScheme = !!this.head && git(b.repo, ['cat-file', '-e', `${this.head}^{commit}`]) !== null;
    if (c.when === 'merged' || !runsThisScheme) return 'go';
    return this.live({ ticket: c.ticket, commit: b.tip, reason: '', since: null }) ? 'go' : 'wait';
  }

  /**
   * Where following minion `after` stands right now, checked before a chained minion is created:
   * 'go' (start it at once), 'wait' (hold it, with `base` for add), or 'unshipped' (refuse).
   */
  follow(after: number, when: Chain['when']): { state: 'go' | 'wait' | 'unshipped'; base: string | null } {
    const b = this.tip(after);
    const base = b && this.merged(b.repo, b.tip) ? b.tip : null;
    return { state: this.chainState({ ticket: 0, after, when, message: '', from: '', base, since: Math.floor(Date.now() / 1000) }), base };
  }

  /** Hold a chained minion's brief (after follow said 'wait'). */
  chain(c: Chain): void {
    const set = { ...c, since: c.since ?? Math.floor(Date.now() / 1000) };
    this.store.setSetting(CHAINS, [...this.chains().filter((o) => o.ticket !== c.ticket), set]);
  }

  /** Take `ticket`'s held brief out of the chain (someone wrote to it: it starts now), or null. */
  release(ticket: number): Chain | null {
    const all = this.chains();
    const c = all.find((o) => o.ticket === ticket) ?? null;
    if (c) this.store.setSetting(CHAINS, all.filter((o) => o !== c));
    return c;
  }

  /** Start each chained minion whose leader's work is in; tell people about leaders dismissed unshipped. */
  private checkChains(): number {
    const keep: Chain[] = [];
    const go: Chain[] = [];
    const hold: Chain[] = [];
    for (const c of this.chains()) {
      const t = this.store.getTicket(c.ticket);
      if (!t || t.status === 'closed') continue;
      const state = this.chainState(c);
      if (state === 'go') go.push(c);
      else keep.push(state === 'unshipped' && !c.held ? (hold.push(c), { ...c, held: true }) : c);
    }
    this.store.setSetting(CHAINS, keep);
    const n = (id: number) => `#${this.store.getTicket(id)?.number ?? id}`;
    for (const c of go) this.start(c, `${n(c.after)}'s work is ${c.when === 'merged' ? 'merged' : 'live'}`);
    for (const c of hold) this.hold(c, `${n(c.after)} was dismissed without its work being merged`);
    return go.length;
  }

  list(): Waiter[] {
    return this.store.getSetting<Waiter[]>(KEY) ?? [];
  }

  /** The full hash of a commit the live checkout or `otherRepo` (the scheme's repo) knows, or null. */
  resolve(commit: string, otherRepo: string | null): string | null {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) return null;
    for (const dir of [this.repo, otherRepo]) {
      const full = dir && git(dir, ['rev-parse', '-q', '--verify', `${commit}^{commit}`]);
      if (full) return full;
    }
    return null;
  }

  /** Is this waiter's deploy live? */
  private live(w: Waiter): boolean {
    if (!this.head) return false;
    if (!w.commit) return this.head !== w.since;
    return git(this.repo, ['merge-base', '--is-ancestor', w.commit, this.head]) !== null;
  }

  /**
   * Wait for `commit` (a full hash, or null for the next deploy). Returns false, storing nothing, when
   * it is live already. A second call for the same ticket and commit replaces the first.
   */
  add(ticket: number, commit: string | null, reason: string): boolean {
    const w: Waiter = { ticket, commit, reason, since: this.head };
    if (commit && this.live(w)) return false;
    this.store.setSetting(KEY, [...this.list().filter((o) => o.ticket !== ticket || o.commit !== commit), w]);
    return true;
  }

  /**
   * The server now runs `head`, or a minion was dismissed: message each waiter whose deploy is live,
   * once, and drop it, and start the chained minions whose leader's work is in. A waiter whose minion
   * was dismissed is dropped without a message. Returns how many were woken or started.
   */
  check(head: string | null = this.head): number {
    this.head = head;
    const waiting: Waiter[] = [];
    const woken: Waiter[] = [];
    for (const w of this.list()) {
      const t = this.store.getTicket(w.ticket);
      if (!t || t.status === 'closed') continue;
      (this.live(w) ? woken : waiting).push(w);
    }
    // Dropped before sending, so a send that throws can't wake anyone twice.
    this.store.setSetting(KEY, waiting);
    const short = (c: string) => c.slice(0, 7);
    for (const w of woken) {
      const what = w.commit ? `\`${short(w.commit)}\` is live now` : 'A deploy is live now';
      this.send(w.ticket, `${what} (the server runs \`${short(head!)}\`): ${w.reason}`);
    }
    return woken.length + this.checkChains();
  }

  /**
   * Minions in pending-deploy whose branch the live commit contains. A deploy reports only to the
   * minions that ran it, so this also catches one whose commit went live in someone else's restart.
   */
  pendingLive(): number[] {
    if (!this.head) return [];
    const ids: number[] = [];
    for (const p of this.store.listProjects()) {
      if (!p.repo_dir) continue;
      for (const t of this.store.listTickets(p.id)) {
        if (t.state !== 'pending-deploy' || t.status === 'closed' || !t.branch) continue;
        // A scheme whose repo doesn't have the live commit (another app's) fails here, as it should.
        if (git(p.repo_dir, ['merge-base', '--is-ancestor', `refs/heads/${t.branch}`, this.head]) !== null) ids.push(t.id);
      }
    }
    return ids;
  }
}
