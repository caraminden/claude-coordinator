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
  /** The chip: `⏱ 06:00` for a time, `⇢ #1177` for another minion (its work, or a note from it), `⇢ live` / `⇢ main` for a commit, else `⇢ event`. */
  chip: string;
  /** What it waits for, in words (the waiter's own text, cut to 300). */
  what: string;
  /** One sentence Citadel builds from the wait's kind and target (#1512, Cara's take A): what happens, and when. */
  headline: string;
  /** The waiter's first sentence, a muted second line under the headline; '' when the headline already says it. */
  line: string;
  /** The waiter's full words, for the summary a click opens. */
  text: string;
  /** Short facts for the summary: who set it and when, what it waits on. */
  facts: string[];
  /** The minion it names, for an "Open #N" link. */
  link: { project: number; number: number } | null;
  set_by: string;
  since: number | null;
  /** ms epoch the wait is due, for a timed one. */
  due: number | null;
  state: 'waiting' | 'held' | 'sending' | 'dropped' | 'failed';
  reason: string | null;
  cancellable: boolean;
};

/** The old keys' waits for one minion, as the runner's hooks give them (server.ts). */
export type LegacyWaits = (ticket: number) => (Pick<WaitRow, 'kind' | 'chip' | 'what' | 'set_by' | 'since'> & { headline?: string; link?: WaitRow['link'] })[];

/** Pacific "06:00", with the weekday ("Sat 06:00") when it is a day or more away. */
const hhmm = (ms: number, now: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${Math.abs(ms - now) < 20 * 3_600_000 ? '' : `${p.weekday} `}${p.hour}:${p.minute}`;
};

/** The minion a wait names: a relay's sender, a chain's leader, a wait on another minion's work. */
export function otherId(r: Pick<Delivery, 'kind' | 'when_arg' | 'payload'>): number | null {
  const id = Number(r.when_arg?.ticket ?? r.when_arg?.after ?? r.payload?.after ?? (r.kind === 'relay' ? r.payload?.ticket : null));
  return Number.isFinite(id) && id ? id : null;
}
function otherOf(store: Store, r: Delivery): Ticket | null {
  const id = otherId(r);
  return id ? (store.getTicket(id) ?? null) : null;
}

const sha = (r: Delivery) => (typeof r.when_arg === 'string' && /^[0-9a-f]{7,40}$/i.test(r.when_arg) ? r.when_arg.slice(0, 7) : null);
/** "is live" or "ships": a merged wait fires once it is on main, a live one once it is deployed. */
const lands = (r: Delivery) => (r.when_kind === 'merged' ? 'ships' : 'is live');

function chipOf(r: Delivery, other: Ticket | null, now: number): string {
  if (r.when_kind === 'at' || (r.due != null && r.when_kind === 'now')) return `⏱ ${hhmm(r.due ?? Number(r.when_arg), now)}`;
  if (other) return `⇢ #${other.number}`;
  if (r.when_kind === 'live' || r.when_kind === 'merged') return r.when_kind === 'merged' ? '⇢ main' : '⇢ live';
  if (r.when_kind === 'ci' || r.kind === 'runners_back') return '⇢ CI';
  return '⇢ event';
}

function headlineOf(r: Delivery, other: Ticket | null, now: number): string {
  const n = other ? `#${other.number}` : null;
  const target = n ? `${n}'s change` : (sha(r) ?? 'its commit');
  switch (r.kind) {
    case 'relay':
      return n ? `Note from ${n} once its change ${lands(r)}` : `Note once ${target} ${lands(r)}`;
    case 'wake_at':
      return `Wakes itself at ${hhmm(r.due ?? Number(r.when_arg), now)}${r.payload?.setBy === 'Taskmaster' || r.set_by === 'Taskmaster' ? ', set by the Taskmaster' : ''}`;
    case 'wake_when_live':
      return `Wakes when ${target} ${lands(r)}`;
    case 'chain':
      return `Starts when ${n ?? 'its leader'} ${lands(r)}`;
    case 'box_job': {
      const m = /\bon ([\w.-]+)/.exec(String(r.payload?.text ?? ''));
      return `News from its job${m ? ` on ${m[1]}` : ''}`;
    }
    case 'runners_back':
      return 'Wakes when CI runners are back';
  }
  if (r.when_kind === 'at') return `Due at ${hhmm(r.due ?? Number(r.when_arg), now)}`;
  if (r.when_kind === 'ci') return 'Wakes when CI finishes';
  return n ? `Waits on ${n}` : sha(r) ? `Waits until ${sha(r)} ${lands(r)}` : 'Waits for an event';
}

/** The waiter's full words: a relay's text, a wake's note, a chain's reason. */
const textOf = (r: Delivery) => String(r.payload?.note ?? r.payload?.reason ?? r.payload?.text ?? r.when_arg?.reason ?? '').slice(0, 2000);

/** The first sentence of `text`, minus a leading "#824 here:"; a long one is cut at its first colon (if that leaves a
 * phrase), else at a word, with "…". */
export function firstLine(text: string): string {
  const t = text.replace(/^\s*(?:#\d+|\w+ #\d+)\s+here[:,.]\s*/i, '').trim();
  const one = (/^[\s\S]*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t).replace(/\s+/g, ' ').trim();
  if (one.length <= 110) return one.replace(/^./, (c) => c.toUpperCase());
  const colon = one.indexOf(': ');
  if (colon >= 20 && colon <= 110) return one.slice(0, colon);
  return `${one.slice(0, 110).replace(/\s+\S*$/, '')}…`;
}

const at = (ms: number, now: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(ms).map((x) => [x.type, x.value]));
  const today = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric' }).format(now) === `${p.month} ${p.day}`;
  return today ? `at ${p.hour}:${p.minute} ${p.timeZoneName}` : `on ${p.month} ${p.day}`;
};

/** Who set it, in words: "#824", "the Taskmaster", "Cara". */
function setter(store: Store, by: string): string {
  const m = /^minion:(\d+)$/.exec(by);
  if (m) {
    const t = store.getTicket(Number(m[1]));
    return t ? (t.kind === 'coordinator' ? 'the Taskmaster' : `#${t.number}`) : 'a minion';
  }
  return by === 'Taskmaster' || by === 'coordinator' ? 'the Taskmaster' : by;
}

function factsOf(store: Store, r: Delivery, now: number): string[] {
  const s = sha(r);
  return [`Set by ${setter(store, r.payload?.setBy === 'Taskmaster' ? 'Taskmaster' : r.set_by)} ${at(r.created_at, now)}`, r.due != null ? `due ${hhmm(r.due, now)}` : s ? `waits for ${s} to ${r.when_kind === 'merged' ? 'reach main' : 'go live'}` : ''].filter(Boolean);
}

const whatOf = (r: Delivery) => String(r.payload?.note ?? r.payload?.reason ?? r.payload?.text ?? r.when_arg?.reason ?? r.kind).slice(0, 300);

/** `ticket`'s waits: live ones in id order, then recently dropped ones. A Taskmaster's are its scheme's `taskmaster` rows. */
export function waitsFor(store: Store, t: Ticket, legacy: LegacyWaits = () => [], now = Date.now()): WaitRow[] {
  const q = t.kind === 'coordinator' ? { toKind: 'taskmaster', to: t.project_id } : { toKind: 'minion', to: t.id };
  const row = (r: Delivery): WaitRow => {
    const other = otherOf(store, r),
      text = textOf(r);
    return {
      id: r.id,
      kind: r.kind,
      chip: chipOf(r, other, now),
      what: whatOf(r),
      set_by: r.set_by,
      headline: headlineOf(r, other, now),
      line: text ? firstLine(text) : '',
      text,
      facts: factsOf(store, r, now),
      link: other && other.kind !== 'coordinator' ? { project: other.project_id, number: other.number! } : null,
      since: r.created_at,
      due: r.due,
      state: r.state as WaitRow['state'],
      reason: r.reason,
      cancellable: (r.state === 'waiting' || r.state === 'held') && r.kind !== 'chain', // a chain's row is its brief: Start now or dismiss, not drop
    };
  };
  const live = store.listDeliveries({ ...q, states: ['waiting', 'held', 'sending'] }).map(row);
  const dropped = store
    .listDeliveries({ ...q, states: ['dropped', 'failed'] })
    .filter((r) => r.updated_at > now - DROPPED_SHOWN_MS)
    .map(row);
  // A wait the table already holds is never also read from an old key (a kind mid-move would show it twice).
  const seen = new Set(live.map((r) => `${r.kind}\0${r.what}`));
  const old =
    t.kind === 'coordinator'
      ? []
      : legacy(t.id)
          .filter((l) => !seen.has(`${l.kind}\0${l.what}`))
          .map(
            (l): WaitRow => ({
              id: null,
              ...l,
              headline: l.headline ?? headlineOf({ kind: l.kind, when_kind: 'live', when_arg: null, payload: {} } as unknown as Delivery, null, now),
              line: l.what ? firstLine(l.what) : '',
              text: l.what,
              facts: l.since ? [`Set by ${setter(store, l.set_by)} ${at(l.since, now)}`] : [],
              link: l.link ?? null,
              due: null,
              state: 'waiting',
              reason: null,
              cancellable: false,
            }),
          );
  return [...live, ...old, ...dropped];
}
