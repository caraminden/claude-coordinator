// What a minion waits for, for the minion list's chip and its popover (ADR 0021 step 7, #1387). It reads the outbox's
// `deliveries` (whatever kinds have moved in) and, until a kind moves, the old keys: start_after chains, wake_when_live
// and runners-back. It writes nothing.
import type { Store, Ticket } from './db.ts';
import type { Delivery } from './db/deliveries.ts';
import { ZONE } from './pacific.ts';

/** A dropped wait stays on the readout, greyed, this long (ADR 0021: dropped rows are deleted after 7 days). */
export const DROPPED_SHOWN_MS = 7 * 86_400_000;

export type WaitRow = {
  /** The delivery's id, or null for a wait still in an old key (no Cancel here). */
  id: number | null;
  kind: string;
  /** The chip: `⏱ 06:00` for a time, `⇢ #1177` for another minion's work, else `⇢ event`. */
  chip: string;
  /** What it waits for, in words. */
  what: string;
  set_by: string;
  since: number | null;
  /** ms epoch the wait is due, for a timed one. */
  due: number | null;
  state: 'waiting' | 'held' | 'sending' | 'dropped' | 'failed';
  reason: string | null;
  cancellable: boolean;
};

/** The old keys' waits for one minion, as the runner's hooks give them (server.ts). */
export type LegacyWaits = (ticket: number) => Pick<WaitRow, 'kind' | 'chip' | 'what' | 'set_by' | 'since'>[];

/** Pacific "06:00", with the weekday ("Sat 06:00") when it is a day or more away. */
const hhmm = (ms: number, now: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${Math.abs(ms - now) < 20 * 3_600_000 ? '' : `${p.weekday} `}${p.hour}:${p.minute}`;
};

function chipOf(store: Store, r: Delivery, now: number): string {
  if (r.when_kind === 'at' || (r.due != null && r.when_kind === 'now')) return `⏱ ${hhmm(r.due ?? Number(r.when_arg), now)}`;
  const other = Number(r.when_arg?.ticket ?? r.when_arg?.after ?? r.payload?.after);
  const n = Number.isFinite(other) && other ? store.getTicket(other)?.number : null;
  return n ? `⇢ #${n}` : '⇢ event';
}

const whatOf = (r: Delivery) => String(r.payload?.note ?? r.payload?.reason ?? r.payload?.text ?? r.when_arg?.reason ?? r.kind).slice(0, 300);

/** `ticket`'s waits: live ones in id order, then recently dropped ones. A Taskmaster's are its scheme's `taskmaster` rows. */
export function waitsFor(store: Store, t: Ticket, legacy: LegacyWaits = () => [], now = Date.now()): WaitRow[] {
  const q = t.kind === 'coordinator' ? { toKind: 'taskmaster', to: t.project_id } : { toKind: 'minion', to: t.id };
  const row = (r: Delivery): WaitRow => ({
    id: r.id, kind: r.kind, chip: chipOf(store, r, now), what: whatOf(r), set_by: r.set_by,
    since: r.created_at, due: r.due, state: r.state as WaitRow['state'], reason: r.reason, cancellable: (r.state === 'waiting' || r.state === 'held') && r.kind !== 'chain', // a chain's row is its brief: Start now or dismiss, not drop
  });
  const live = store.listDeliveries({ ...q, states: ['waiting', 'held', 'sending'] }).map(row);
  const dropped = store.listDeliveries({ ...q, states: ['dropped', 'failed'] }).filter((r) => r.updated_at > now - DROPPED_SHOWN_MS).map(row);
  // A wait the table already holds is never also read from an old key (a kind mid-move would show it twice).
  const seen = new Set(live.map((r) => `${r.kind}\0${r.what}`));
  const old = t.kind === 'coordinator' ? [] : legacy(t.id).filter((l) => !seen.has(`${l.kind}\0${l.what}`)).map((l): WaitRow => ({ id: null, ...l, due: null, state: 'waiting', reason: null, cancellable: false }));
  return [...live, ...old, ...dropped];
}
