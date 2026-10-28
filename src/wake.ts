// wake_when_live: minions waiting on someone else's deploy hear once it is live, instead of relying
// on the Taskmaster to remember. The server checks the waiters when it starts (a restart) and when it
// reloads its front end (a front-end-only deploy, which doesn't restart).
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

/** All waiters, in the settings table so they outlive the restart they wait for. */
const KEY = 'wake-when-live';

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
  /** The commit the server runs now: what it booted from, then what its front end last reloaded to. */
  head: string | null;

  constructor(store: Store, repo: string, head: string | null, send: (ticketId: number, text: string) => void) {
    this.store = store;
    this.repo = repo;
    this.head = head;
    this.send = send;
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
   * The server now runs `head`: message each waiter whose deploy is live, once, and drop it. A waiter
   * whose minion was dismissed is dropped without a message. Returns how many were woken.
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
    return woken.length;
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
