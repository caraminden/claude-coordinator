// Start now (#1957): a person gives a waiting minion a worker of its own, past the pool's size, and keeps it while they work
// with it. Josh, 2026-11-25: "We should make it so I can force create a new worker if there is a minion I want to actively
// work on"; "While you're working with it"; "Two per person". A capped exception to the pool (src/turn-line.ts). Saved in
// the settings table, so a restart keeps each hold and its clock.
import type { Store, Ticket } from './db.ts';

const HOLDS = 'start-now';

export const HOLD = {
  /** A hold ends this long after the last thing its person did in the minion. */
  idleMs: 30 * 60_000,
  /** Holds each person may have, across Citadel. */
  each: 2,
};

export interface WorkerHold {
  ticket: number;
  user: number;
  /** Who, in words. */
  by: string;
  /** Pressed at. */
  since: number;
  /** The last thing they did in it. */
  at: number;
}

export interface HoldDeps {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting'>;
  /** The minion can use it no longer (holdOver). */
  over: (ticketId: number) => boolean;
  /** Holds of these minions began, ended or moved their clock. */
  changed: (ids: number[]) => void;
  now: () => number;
}

/** A minion that can use a worker of its own no longer: gone, closed, or sealed with no turn running or waiting (`sealedIdle`). */
export const holdOver = (t: Ticket | undefined, sealedIdle: (t: Ticket) => boolean): boolean => !t || t.status === 'closed' || sealedIdle(t);

export class StartNow {
  private d: HoldDeps;
  private saved: WorkerHold[];

  constructor(d: HoldDeps) {
    this.d = d;
    this.saved = d.store.getSetting<WorkerHold[]>(HOLDS) ?? [];
  }

  private live(h: WorkerHold): boolean {
    return this.d.now() - h.at < HOLD.idleMs && !this.d.over(h.ticket);
  }

  get(ticketId: number): WorkerHold | null {
    const h = this.saved.find((x) => x.ticket === ticketId);
    return h && this.live(h) ? h : null;
  }

  list(): WorkerHold[] {
    return this.saved.filter((h) => this.live(h));
  }

  /** As pages show it. */
  view(ticketId: number): { by: string; user: number; since: number; until: number } | null {
    const h = this.get(ticketId);
    return h && { by: h.by, user: h.user, since: h.since, until: h.at + HOLD.idleMs };
  }

  /** The hold is theirs from now; null, or why not: another person's on it, or `full`, the holds they have already. */
  press(ticketId: number, user: number, by: string): { theirs: WorkerHold } | { full: WorkerHold[] } | null {
    const was = this.get(ticketId);
    if (was && was.user !== user) return { theirs: was };
    if (was) return this.touch(ticketId, user);
    this.sweep();
    const mine = this.saved.filter((h) => h.user === user);
    if (mine.length >= HOLD.each) return { full: mine };
    const at = this.d.now();
    this.save([...this.saved, { ticket: ticketId, user, by, since: at, at }], [ticketId]);
    return null;
  }

  /** A message or a card answer of `user`'s in it: their hold's 30 minutes start again. */
  touch(ticketId: number, user: number | null | undefined): null {
    const was = this.get(ticketId);
    if (was && was.user === user)
      this.save(
        this.saved.map((h) => (h === was ? { ...h, at: this.d.now() } : h)),
        [ticketId],
      );
    return null;
  }

  /** Released, shipped, sealed or closed. A turn that runs goes on; its next waits in the line. */
  end(ticketId: number) {
    if (this.saved.some((h) => h.ticket === ticketId))
      this.save(
        this.saved.filter((h) => h.ticket !== ticketId),
        [ticketId],
      );
  }

  /** Drop those that are over, so pages hear it: their time passed, or their minion was sealed or closed. */
  sweep() {
    const gone = this.saved.filter((h) => !this.live(h));
    if (gone.length)
      this.save(
        this.list(),
        gone.map((h) => h.ticket),
      );
  }

  /** Forget them all: a boot check's copied database must start no turns from them. */
  clear() {
    this.saved = [];
    this.d.store.deleteSetting(HOLDS);
  }

  private save(holds: WorkerHold[], ids: number[]) {
    this.saved = holds;
    this.d.store.setSetting(HOLDS, holds);
    this.d.changed(ids);
  }
}
