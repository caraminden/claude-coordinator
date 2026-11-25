// Urgent minions (#1888): which go ahead of every share when they want a worker (src/turn-line.ts), and in what order.
// Josh, 2026-11-24: 'mark it as "urgent" which would just push it to the top of the queue when it wants a worker', "Until it
// ships. The minion should be tagged as "urgent" and take a top spot until its done", "No limit". A person's choice, on or off,
// stands against a Taskmaster's and the server's. Saved in the settings table; a ship or a close forgets both.
import type { Store } from './db.ts';

const URGENT = 'urgent';
/** Tags the server sets by itself at any one time, so people's order stays theirs (the replay's "Two"). */
const SERVER_MAX = 2;

export interface UrgentBy {
  kind: 'person' | 'taskmaster' | 'server';
  /** Who, in words. */
  by: string;
  reason?: string;
  /** A server tag's cause, so it goes when that does. */
  cause?: string;
}
export type UrgentMark = UrgentBy & { ticket: number; at: number };
type Off = Pick<UrgentMark, 'ticket' | 'kind' | 'by' | 'at'>;

export class Urgent {
  private store: Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting'>;
  private changed: (ids: number[]) => void;
  /** The group in its order, the newest press last. */
  private on: UrgentMark[];
  private off: Off[];

  constructor(store: Urgent['store'], changed: Urgent['changed']) {
    this.store = store;
    this.changed = changed;
    const saved = store.getSetting<{ on: UrgentMark[]; off: Off[] }>(URGENT);
    this.on = saved?.on ?? [];
    this.off = saved?.off ?? [];
  }

  get(ticketId: number): UrgentMark | null {
    return this.on.find((m) => m.ticket === ticketId) ?? null;
  }

  /** As pages show it. */
  view(ticketId: number): Pick<UrgentMark, 'kind' | 'by' | 'reason' | 'at'> | null {
    const m = this.get(ticketId);
    return m && { kind: m.kind, by: m.by, at: m.at, ...(m.reason ? { reason: m.reason } : {}) };
  }

  list(): UrgentMark[] {
    return [...this.on];
  }

  /** Its place in the group, or undefined when it isn't in it. */
  place(ticketId: number): number | undefined {
    const i = this.on.findIndex((m) => m.ticket === ticketId);
    return i < 0 ? undefined : i;
  }

  /** The person whose choice, on or off, stands for this minion. */
  private person(ticketId: number): Off | undefined {
    return [this.get(ticketId), this.off.find((o) => o.ticket === ticketId)].find((m) => m?.kind === 'person') ?? undefined;
  }

  /**
   * Into the group, or with `before` (a minion in it, null for the end: a drag) to that spot. A drag inside the group moves
   * it and keeps who marked it and why; a press on an agent's or the server's tag takes it over, spot kept. Why not, or null.
   */
  set(ticketId: number, how: UrgentBy, before?: number | null): string | null {
    const was = this.get(ticketId);
    if (how.kind !== 'person') {
      const person = this.person(ticketId);
      if (person) return was ? `${person.by} already marked it Urgent` : `${person.by} took Urgent off it`;
    }
    if (how.kind === 'server') {
      if (this.off.some((o) => o.ticket === ticketId)) return 'Urgent was taken off it';
      if (was) return null;
      if (this.on.filter((m) => m.kind === 'server').length >= SERVER_MAX) return `the server has marked ${SERVER_MAX} already`;
    }
    const mark: UrgentMark = was && (was.kind === 'person' || before !== undefined) ? was : { ...how, ticket: ticketId, at: Date.now() };
    const rest = this.on.filter((m) => m.ticket !== ticketId);
    const spot = before === undefined ? this.place(ticketId) : rest.findIndex((m) => m.ticket === before);
    rest.splice(spot === undefined || spot < 0 ? rest.length : spot, 0, mark);
    this.save(
      rest,
      this.off.filter((o) => o.ticket !== ticketId),
      [ticketId],
    );
    return null;
  }

  /** Out of the group, remembered so nobody with less say puts it back. Why not, or null. */
  unset(ticketId: number, how: Pick<UrgentBy, 'kind' | 'by'>): string | null {
    const person = this.person(ticketId);
    if (how.kind !== 'person' && person) return this.get(ticketId) ? `${person.by} marked it Urgent` : null;
    if (!this.get(ticketId)) return null;
    this.save(
      this.on.filter((m) => m.ticket !== ticketId),
      [...this.off.filter((o) => o.ticket !== ticketId), { ticket: ticketId, kind: how.kind, by: how.by, at: Date.now() }],
      [ticketId],
    );
    return null;
  }

  /** It shipped or closed: its tag goes, and whoever took one off has no say over its next work. */
  done(ticketId: number) {
    if (!this.on.some((m) => m.ticket === ticketId) && !this.off.some((o) => o.ticket === ticketId)) return;
    this.save(
      this.on.filter((m) => m.ticket !== ticketId),
      this.off.filter((o) => o.ticket !== ticketId),
      [ticketId],
    );
  }

  /** The server's tags whose cause `over` says has passed. */
  passed(over: (mark: UrgentMark) => boolean) {
    const gone = this.on.filter((m) => m.kind === 'server' && over(m)).map((m) => m.ticket);
    if (gone.length)
      this.save(
        this.on.filter((m) => !gone.includes(m.ticket)),
        this.off,
        gone,
      );
  }

  private save(on: UrgentMark[], off: Off[], ids: number[]) {
    this.on = on;
    this.off = off;
    this.store.setSetting(URGENT, { on, off });
    this.changed(ids);
  }
}
