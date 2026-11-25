// What puts a waiting minion where it stands in its person's share of the line for a worker (#1888, src/turn-line.ts):
// its ship was refused, other minions wait on it, or its session is about to go cold on the account its turn would use.
import { keptCards } from './card-wait.ts';
import type { Store, Ticket } from './db.ts';
import type { LinePlace } from './turn-line.ts';
import type { Urgent } from './urgent.ts';
import { otherId } from './waits-readout.ts';
import type { Chain } from './wake.ts';

/** A session's last 20 minutes before its one-hour cache expires (Josh, 2026-11-24: "About to go cold first"). */
const GOING_COLD_MS = 40 * 60_000;
const CACHE_MS = 60 * 60_000;

/** Whose plan and which of its accounts a turn runs on: where its prompt cache is. */
export interface OnAccount {
  payer: number | null;
  account: number | null;
}

/** Whether a turn on `next` finds what a turn on `last` cached. An account not recorded is the plan's first. */
export const sameAccount = (last: OnAccount, next: OnAccount) => last.payer === next.payer && (last.account ?? 1) === (next.account ?? 1);

/** How warm a waiting turn's session is: 0 about to go cold, 1 under way, 2 brand new. `last` is null for one whose cache its turn can't use. */
export function heatOf(session: boolean, last: { ended_at: number } | null, now: number): 0 | 1 | 2 {
  if (!session) return 2;
  const age = last ? now - last.ended_at : 0;
  return age >= GOING_COLD_MS && age < CACHE_MS ? 0 : 1;
}

/** The open minions that other open minions wait on: a chained start, a wait on its work, a claim it holds with a queue behind it. */
export function waitedOn(store: Store, chains: Chain[]): Set<number> {
  const open = (id: number) => {
    const t = store.getTicket(id);
    return !!t && t.status !== 'closed' && t.kind !== 'coordinator';
  };
  const ids = new Set<number>();
  const add = (waiter: number, on: number | null) => {
    if (on && on !== waiter && open(waiter) && open(on)) ids.add(on);
  };
  for (const c of chains) if (!c.held) add(c.ticket, c.after);
  // A chain's own rows are in `chains`, where a held one is known.
  for (const r of store.listDeliveries({ states: ['waiting', 'sending'] })) if (r.kind !== 'chain' && r.to_kind === 'minion') add(r.to_id, otherId(r));
  for (const c of store.claims.queued()) add(c.ticket, c.holder);
  return ids;
}

/** waitedOn is read again at most this often: the order is worked out on every change to the line. */
const WAITED_MS = 5000;
const refusedKey = (ticketId: number) => `refused-ship:${ticketId}`;

export interface PlaceDeps {
  store: Store;
  urgent: Urgent;
  chains: () => Chain[];
  now: () => number;
}

export class LinePlaces {
  private d: PlaceDeps;
  private waited: { at: number; ids: Set<number> } | null = null;

  constructor(d: PlaceDeps) {
    this.d = d;
  }

  /** A waiting minion's place, `next` the account its turn would run on (null: a model that keeps no Claude cache). */
  place(ticket: Ticket, next: () => OnAccount | null): Pick<LinePlace, 'urgent' | 'first' | 'heat'> {
    const { store, urgent, now } = this.d;
    const last = ticket.session_id ? store.lastTurnOn(ticket.id) : null;
    const at = now();
    // Whose account it would run on is looked up only for one about to go cold.
    const on = last && heatOf(true, last, at) === 0 ? next() : null;
    const spot = urgent.place(ticket.id);
    return { ...(spot === undefined ? {} : { urgent: spot }), first: !!store.getSetting(refusedKey(ticket.id)) || !!keptCards(store).get(ticket.id)?.answer || this.others(ticket.id), heat: heatOf(!!ticket.session_id, last && on && sameAccount(last, on) ? last : null, at) };
  }

  private others(ticketId: number): boolean {
    const at = Date.now();
    if (!this.waited || at - this.waited.at >= WAITED_MS || at < this.waited.at) this.waited = { at, ids: waitedOn(this.d.store, this.d.chains()) };
    return this.waited.ids.has(ticketId);
  }

  /** Its handed-off ship was refused, or in a pull-request scheme its PR's CI went red; `false` once it tries again, passes, ships or closes. */
  refused(ticketId: number, yes: boolean) {
    if (yes) this.d.store.setSetting(refusedKey(ticketId), true);
    else this.d.store.deleteSetting(refusedKey(ticketId));
  }
}
