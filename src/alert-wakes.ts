// Mandate alerts wake the Taskmaster they're about (#869). Cara, 2026-11-17: "When we get these CI or other alerts sent to
// my Mandate, there should be some callback to the relevant taskmaster so it can explain to me what happened without me
// asking." Her picks the same day: alarm items only (quiet ones don't count), the alert's link opens that Taskmaster's
// chat, a new problem inside an open alert is news but rewording and clearing aren't, and 2-9 AM Pacific holds the wake
// until 9. A wake reloads a Taskmaster's whole context, so it's one per alert (not per person who got it), and a burst
// is one wake per scheme. Scheme 0 is Citadel-wide (CI health, timers with no home scheme): the server sends it to the
// scheme whose repo the live checkout is.
// A scheme's batch is an `alert` row in the outbox (ADR 0021 step 6) that new alerts merge into, sent by the outbox's timer.
import type { Store } from './db.ts';
import type { Delivery } from './db/deliveries.ts';
import type { Outbox } from './outbox.ts';
import { ZONE } from './pacific.ts';

/** How long a scheme's batch waits for more alerts after its newest one. */
export const BATCH_MS = 60_000;
/** The longest a batch waits while alerts keep coming. */
export const MAX_WAIT_MS = 5 * 60_000;
/** The old key, `{ told, batches }`: moved into the table and `TOLD` on first boot, and read again every pass (the dual read). */
const OLD_KEY = 'alert-wakes';
/** Alert (`<from id>:<key>`) → the problem ids in it the Taskmaster has heard of, or will in the row waiting. */
const TOLD = 'alert-told';
const KIND = 'alert';

/** A problem inside an alert: CI health's one alert holds several. `facts`: what the Taskmaster needs that the title lacks. */
export interface AlertPart {
  id: string;
  title: string;
  facts?: string;
}
export interface Raised {
  /** Who the Mandate item is from: a scheme, or id 0 for Citadel-wide senders. */
  from: { id: number; name: string };
  key: string;
  title: string;
  link: string;
  /** Who got it. */
  person: string;
  /** Its problems; the alert itself is the one problem when left out. */
  parts?: AlertPart[];
}
interface Queued {
  sender: string;
  title: string;
  link: string;
  to: string[];
  parts: AlertPart[] | null;
}
/** An `alert` row's payload. `note`: the line the waits readout shows. */
interface Batch {
  first: number;
  last: number;
  alerts: Record<string, Queued>;
  note?: string;
  held?: boolean;
}
type Told = Record<string, string[]>;

export interface AlertWakeDeps {
  /** Wake the scheme's Taskmaster (0: the Citadel scheme's); false when there's none to wake. */
  wake: (scheme: number, text: string) => boolean;
}

/** When the overnight hold that `t` falls in ends (9:00 AM Pacific), or null outside 2-9 AM Pacific. */
export function quietUntil(t: number): number | null {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(t).map((x) => [x.type, x.value]));
  const h = Number(p.hour);
  if (h < 2 || h >= 9) return null;
  return t - (((h * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 + (t % 1000)) + 9 * 3600_000;
}

const names = (to: string[]) => (to.length > 1 ? `${to.slice(0, -1).join(', ')} and ${to.at(-1)}` : to[0]);
/** The earlier of 60 s after the last alert and 5 min after the first, pushed past 2-9 AM Pacific. */
const settled = (b: Batch) => Math.min(b.last + BATCH_MS, b.first + MAX_WAIT_MS);
const dueOf = (b: Batch) => quietUntil(settled(b)) ?? settled(b);
const noted = (b: Batch): Batch => {
  const titles = Object.values(b.alerts).map((q) => q.title);
  return { ...b, note: `Explain ${titles.length === 1 ? 'a Mandate alert' : `${titles.length} Mandate alerts`}: ${titles.join('; ')}` };
};
/** Two batches for one scheme as one: the newer copy of an alert wins. */
const fold = (a: Batch, b: Batch): Batch => noted({ first: Math.min(a.first, b.first), last: Math.max(a.last, b.last), alerts: { ...a.alerts, ...b.alerts }, ...(a.held || b.held ? { held: true } : {}) });

export class AlertWakes {
  private store: Store;
  private outbox: Outbox;
  constructor(store: Store, outbox: Outbox, deps: AlertWakeDeps) {
    this.store = store;
    this.outbox = outbox;
    outbox.register({
      kind: KIND,
      migrate: () => this.migrate(),
      merge: (row, incoming) => fold(row.payload, incoming.payload as Batch),
      due: dueOf,
      describe: (r) => String(r.payload.note ?? 'alert wake'),
      deliver: (rows, ctx) =>
        rows.map((r) => {
          const b = r.payload as Batch;
          // Due before 2 AM but sent inside the hold (a late boot, a retry, a resend after a kill): it waits for 9 too.
          const quiet = quietUntil(ctx.now);
          if (quiet !== null) {
            this.hold(r, quiet);
            return { state: 'accepted' as const }; // no-op for the outbox: hold took the row out of `sending`
          }
          const held = quietUntil(b.first) !== null || quietUntil(settled(b)) !== null || !!b.held;
          const again = ctx.repeat(r) ? '\n\n(The server restarted while sending this, so it may repeat an earlier wake.)' : '';
          if (deps.wake(r.to_id, wakeText(b, held) + again)) return { state: 'accepted' as const };
          console.log(`Alert wakes: scheme ${r.to_id} has no Taskmaster; ${Object.keys(b.alerts).length} alert(s) not explained`);
          return { state: 'drop' as const, reason: 'no Taskmaster to wake' };
        }),
    });
  }

  /** The dual read: the old key's told, until the move empties it. */
  private told(): Told {
    return this.store.getSetting<Told>(TOLD) ?? this.store.getSetting<{ told?: Told }>(OLD_KEY)?.told ?? {};
  }

  private waiting(scheme: number): Delivery | undefined {
    return this.store.listDeliveries({ kind: KIND, dedupe: String(scheme), states: ['waiting'] })[0];
  }

  private add(scheme: number, b: Batch) {
    this.outbox.add({ project_id: scheme, kind: KIND, to_kind: 'taskmaster', to_id: scheme, when_kind: 'at', set_by: 'citadel', dedupe_key: String(scheme), payload: noted(b) });
  }

  /** Put a `sending` row back to wait until `until`, or fold it into the scheme's row that started waiting meanwhile. */
  private hold(r: Delivery, until: number) {
    const now = this.outbox.clock();
    this.store.deliveryTransaction(() => {
      const twin = this.waiting(r.to_id);
      if (!twin) return void this.store.updateDelivery(r.id, { state: 'waiting', due: until, payload: { ...r.payload, held: true } }, ['sending'], now);
      const b = fold({ ...r.payload, held: true }, twin.payload);
      this.store.updateDelivery(twin.id, { payload: b, due: dueOf(b) }, ['waiting'], now);
      this.store.updateDelivery(r.id, { state: 'dropped', reason: `held overnight in #${twin.id}` }, ['sending'], now);
    });
  }

  /** Take an alert out of its scheme's waiting row, and drop the row once it holds none. */
  private trim(scheme: number, id: string) {
    const row = this.waiting(scheme);
    if (!row?.payload.alerts[id]) return;
    const alerts = { ...row.payload.alerts };
    delete alerts[id];
    if (!Object.keys(alerts).length) this.outbox.cancel(row.id, 'its alerts cleared');
    else this.store.updateDelivery(row.id, { payload: noted({ ...row.payload, alerts }) }, ['waiting'], this.outbox.clock());
  }

  /** Move the old key's batches into the table and its told into `TOLD`, emptying the key, all in one transaction. */
  private migrate() {
    const old = this.store.getSetting<{ told?: Told; batches?: Record<string, Batch> }>(OLD_KEY);
    if (!old) return;
    this.store.deliveryTransaction(() => {
      this.store.setSetting(TOLD, { ...old.told, ...this.store.getSetting<Told>(TOLD) });
      for (const [scheme, b] of Object.entries(old.batches ?? {})) if (Object.keys(b.alerts ?? {}).length) this.add(Number(scheme), b);
      this.store.deleteSetting(OLD_KEY);
    });
  }

  /** An alarm item Mandate took for one person: queues the news in it, if any, for its scheme's next wake. */
  raise(a: Raised, now = this.outbox.clock()) {
    this.store.deliveryTransaction(() => {
      const told = this.told();
      const id = `${a.from.id}:${a.key}`;
      const parts = a.parts ?? [{ id: a.key, title: a.title }];
      const heard = new Set(told[id] ?? []);
      const fresh = parts.filter((p) => !heard.has(p.id));
      // What it holds now: a problem that left (or returns later, as news again) stops counting as heard.
      told[id] = parts.map((p) => p.id);
      this.store.setSetting(TOLD, told);
      const queued = this.waiting(a.from.id)?.payload.alerts[id] as Queued | undefined;
      if (!fresh.length && !queued) return;
      const q: Queued = queued ? structuredClone(queued) : { sender: a.from.name, title: a.title, link: a.link, to: [], parts: a.parts ? [] : null };
      Object.assign(q, { title: a.title, link: a.link });
      if (!q.to.includes(a.person)) q.to.push(a.person);
      if (q.parts) q.parts = [...q.parts.filter((p) => parts.some((x) => x.id === p.id)), ...fresh.filter((p) => !q.parts!.some((x) => x.id === p.id))];
      if (q.parts && !q.parts.length) return this.trim(a.from.id, id);
      // Only news moves the wait on (a merge keeps the row's first and the later last).
      this.add(a.from.id, { first: now, last: fresh.length ? now : 0, alerts: { [id]: q } });
    });
  }

  /** The alert's item was cleared: nothing to wake anyone for, and the next time it opens is news. */
  clear(from: { id: number }, key: string) {
    const id = `${from.id}:${key}`;
    const told = this.told();
    if (!told[id] && !this.waiting(from.id)?.payload.alerts[id]) return;
    this.store.deliveryTransaction(() => {
      delete told[id];
      this.store.setSetting(TOLD, told);
      this.trim(from.id, id);
    });
  }
}

function wakeText(b: Batch, held: boolean): string {
  const alerts = Object.values(b.alerts);
  const lines = alerts.map((q) => {
    const news = q.parts?.length ? `\n  New in it: ${q.parts.map((p) => `${p.title}${p.facts ? ` (${p.facts})` : ''}`).join('; ')}` : '';
    return `- "${q.title}" from ${q.sender}, to ${names(q.to)}; its link: ${q.link}${news}`;
  });
  return `${alerts.length === 1 ? 'A Mandate alert' : `${alerts.length} Mandate alerts`} went out${held ? ', held overnight (2-9 AM Pacific) before reaching you' : ''}:\n${lines.join('\n')}\n\nExplain it to them here now, in a short reply nobody asked for: what happened, whether lands or minions' work are blocked, and what they have to do (or that nothing is needed). Look it up first where these facts don't settle it (\`ci-failures <run id>\`, \`gh run view <run id> --log-failed\`, the server's journal). Their alert opens this chat. You hear once per new problem in an alert, never when it clears.`;
}
