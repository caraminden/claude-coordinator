// The one outbox (ADR 0021, #1385): every "send this later" lives as a row in `deliveries` (src/db/deliveries.ts), and
// this one dispatcher sends them. Kinds register how a row comes true and how it is sent; the outbox owns the timer, the
// order per target, the crash rule (waiting → sending → sent, resend at boot), retries and the 3-day rule for a
// dismissed target. Step 0 moves `wake_at` here (src/wake.ts TimedWakes); later steps add the other kinds.
import type { Store, Ticket } from './db.ts';
import type { Delivery, NewDelivery } from './db/deliveries.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A failed send is tried again this many minutes on, then the row is `failed`. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360];
/** How long a dismissed minion's rows wait for a reopen before they are dropped (Cara, 2026-11-20, "a few days"). */
export const HOLD_MS = 3 * DAY;
const SENT_KEEP_MS = DAY;
const ENDED_KEEP_MS = 7 * DAY;
const PRUNE_EVERY_MS = 60 * MINUTE;
/** How often a handed row asks the runner whether it still holds it (a usage-limit wait can hold it for days). */
const RECHECK_MS = 5 * MINUTE;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What pokes the outbox: `boot`, `tick` (the timer), `added`, `closed`, `reopened`, and the condition events later kinds read. */
export type OutboxEvent = { type: string; ticket?: number; [k: string]: unknown };

/**
 * What `deliver` says happened to one row. `accepted`: the receiver made it durable (held mail, a saved card). `handed`:
 * given to the runner as event `event` (saved on the row), sent once a turn carrying it starts; until then it is
 * re-checked: still held by the runner (its queue, a usage-limit or network wait) it waits on, dropped by it (the turn was
 * refused when it came to run) it is retried, and left by a killed server it is sent again, marked as a possible repeat.
 * `retry` and `drop` carry a reason; a throw counts as retry.
 */
export type Outcome = { state: 'accepted' } | { state: 'handed'; event: number } | { state: 'retry'; reason: string } | { state: 'drop'; reason: string };

export type DeliverCtx = {
  now: number;
  /** When this server started: a time row due before it was missed while the server was down. */
  bootAt: number;
  /** Send `text` to the row's minion, with its delivery id, and the possible-repeat line on a row a killed server left sending. */
  send(row: Delivery, text: string): Outcome;
};

export type Kind = {
  kind: string;
  /** A condition row's test against an event (and on boot and add, against current state). `at` rows need none. */
  ready?(row: Delivery, event: OutboxEvent): boolean;
  /** Every row of this kind for one target that came due in one pass, in id order: one outcome per row. */
  deliver(rows: Delivery[], ctx: DeliverCtx): Outcome[];
  /** A re-add with the same dedupe_key: the payload to keep. Without it the new payload replaces the old. */
  merge?(row: Delivery, incoming: NewDelivery): unknown;
  /** `deliver`: still sent to a dismissed minion (relays, as held mail). Default `hold`: the 3-day rule. */
  onDismiss?: 'hold' | 'deliver';
  /** The dual read (ADR 0021, "Steps"): move anything found in the kind's old settings key into the table. Runs every pass. */
  migrate?(): void;
  /** One line on what the row would have sent, for the setter's Taskmaster when it fails. */
  describe?(row: Delivery): string;
};

export type OutboxRunner = {
  send(ticketId: number, author: string, text: string): { event: { id: number } };
  /** Whether the minion's next turn still carries this event (Runner.holds). */
  holds(ticketId: number, eventId: number): boolean;
  onLane(ticketId: number, what: string, step: () => unknown): Promise<unknown>;
  refuseTurn?: (ticket: Ticket, author: string) => string | null;
  leaveMail(to: number, author: string, text: string): void;
};

const LIVE = ['waiting', 'held', 'sending'] as const;
const target = (r: Delivery) => `${r.to_kind}:${r.to_id}`;

/** "2 h 5 min", "3 d 4 h", "45 min": how late or how long, for people and minions. */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

export class Outbox {
  private kinds = new Map<string, Kind>();
  /** Rows a killed server left `sending`, found again at each boot (the state is saved, so a second kill finds them too). */
  private leftover = new Set<number>();
  /** Targets with a lane step queued or running: no second one, and the timer skips their rows until it ends. */
  private busy = new Set<string>();
  private inflight = new Set<Promise<unknown>>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private bootAt = 0;
  private prunedAt = 0;
  private stopped = false;
  private now: () => number;
  private store: Store;
  private runner: OutboxRunner;
  private opts: { author: string; now?: () => number; log?: (msg: string) => void };

  constructor(store: Store, runner: OutboxRunner, opts: { author: string; now?: () => number; log?: (msg: string) => void }) {
    this.store = store;
    this.runner = runner;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** The outbox's clock (tests give it a fake one). */
  clock(): number {
    return this.now();
  }

  register(kind: Kind) {
    this.kinds.set(kind.kind, kind);
  }

  /** Save a row (a re-add with the same dedupe_key merges into the waiting one) and reconcile it at once. */
  add(d: NewDelivery): Delivery {
    const kind = this.kinds.get(d.kind);
    if (!kind) throw new Error(`No outbox kind ${d.kind}`);
    const now = this.now();
    const [old] = d.dedupe_key == null ? [] : this.store.listDeliveries({ kind: d.kind, dedupe: d.dedupe_key, states: ['waiting', 'held'] });
    let row: Delivery;
    if (old) {
      this.store.updateDelivery(old.id, { payload: kind.merge ? kind.merge(old, d) : d.payload, when_arg: d.when_arg ?? old.when_arg, due: d.due ?? old.due }, undefined, now);
      row = this.store.getDelivery(old.id)!;
    } else row = this.store.addDelivery(d, now);
    void this.poke({ type: 'added', ticket: d.to_kind === 'minion' ? d.to_id : undefined });
    return row;
  }

  /** Drop a waiting or held row; false if it was already sending, sent or gone. */
  cancel(id: number, reason = 'cancelled'): boolean {
    const ok = this.store.updateDelivery(id, { state: 'dropped', reason }, ['waiting', 'held'], this.now());
    if (ok) void this.poke({ type: 'cancelled' });
    return ok;
  }

  /** Run a pass for this event. Passes run one at a time; the promise ends once the deliveries started so far have run
   * (tests await it; the server never does, since a delivery waits behind its minion's running turn). */
  poke(event: OutboxEvent): Promise<void> {
    const pass = this.chain.then(() => this.pass(event));
    this.chain = pass.catch((err) => this.opts.log?.(`outbox: ${event.type} pass failed: ${(err as Error)?.stack ?? err}`));
    return pass.then(
      () => Promise.all([...this.inflight]).then(() => {}),
      () => {},
    );
  }

  /** Once, after runner.recover() restored its queues: rows a killed server left `sending` are checked at once (sent
   * again, marked, unless the runner still holds them); missed time rows go late. */
  boot(): Promise<void> {
    this.bootAt = this.now();
    for (const r of this.store.listDeliveries({ states: ['sending'] })) {
      this.leftover.add(r.id);
      this.store.updateDelivery(r.id, { due: this.bootAt }, ['sending'], this.bootAt);
    }
    return this.poke({ type: 'boot' });
  }

  /** The runner started a turn carrying these events: the rows handed as them are sent; a reopened minion's held rows go back. */
  turnStarted(ticketId: number, eventIds: number[]) {
    const now = this.now();
    const ids = new Set(eventIds);
    const rows = this.store.listDeliveries({ to: ticketId, states: ['sending', 'held'] });
    for (const r of rows) if (r.state === 'sending' && r.event_id != null && ids.has(r.event_id)) this.store.updateDelivery(r.id, { state: 'sent' }, ['sending'], now);
    if (rows.some((r) => r.state === 'held')) void this.poke({ type: 'reopened', ticket: ticketId });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private live(): Delivery[] {
    return this.store.listDeliveries({ states: [...LIVE] }).filter((r) => this.kinds.has(r.kind));
  }

  /** A minion target's ticket: undefined if it is gone. A Taskmaster target (a project) always counts as open. */
  private closed(r: Delivery): 'gone' | boolean {
    if (r.to_kind !== 'minion') return false;
    const t = this.store.getTicket(r.to_id);
    return t ? t.status === 'closed' : 'gone';
  }

  private pass(event: OutboxEvent): void {
    if (this.stopped || !this.bootAt) return; // nothing is sent before boot (a boot check never boots it)
    for (const k of this.kinds.values()) {
      try {
        k.migrate?.();
      } catch (err) {
        this.opts.log?.(`outbox: moving ${k.kind}'s old rows failed, tried again next pass: ${(err as Error)?.stack ?? err}`); // the rows already in the table still go
      }
    }
    const now = this.now();
    for (const r of this.live()) {
      const kind = this.kinds.get(r.kind)!;
      if (r.state === 'held') {
        // Reconcile, not only listen: a reopen is seen by the target's state, whichever path reopened it.
        if (this.closed(r) === false) this.reopen(r, now);
        else if (r.due != null && r.due <= now) this.drop(r, 'minion dismissed', now);
      } else if (r.state === 'waiting') {
        const closed = this.closed(r);
        if (closed === true && kind.onDismiss !== 'deliver') {
          this.store.updateDelivery(r.id, { state: 'held', due: now + HOLD_MS, reason: 'target closed' }, ['waiting'], now);
        } else if (r.met_at == null && r.due == null && kind.ready?.(r, event)) {
          this.store.updateDelivery(r.id, { met_at: now, due: now }, ['waiting'], now);
        }
      }
    }
    if (now - this.prunedAt >= PRUNE_EVERY_MS) {
      this.prunedAt = now;
      this.store.pruneDeliveries(now - SENT_KEEP_MS, now - ENDED_KEEP_MS);
    }
    const due = new Map<string, Delivery>();
    for (const r of this.live()) if (r.state !== 'held' && r.due != null && r.due <= now && !this.busy.has(target(r)) && !due.has(target(r))) due.set(target(r), r);
    for (const [key, r] of due) {
      this.busy.add(key);
      const step = () => this.deliverTarget(r.to_kind, r.to_id);
      // shortcut: a Taskmaster target (a project) has no lane of its own here; the kinds that send to one (relays, step 2) give it one.
      const run = r.to_kind === 'minion' ? this.runner.onLane(r.to_id, 'outbox', step) : Promise.resolve().then(step);
      const p: Promise<unknown> = run
        .catch((err) => this.opts.log?.(`outbox: delivery to ${key} failed: ${(err as Error)?.stack ?? err}`))
        .finally(() => {
          this.busy.delete(key);
          this.inflight.delete(p);
          this.arm();
        });
      this.inflight.add(p);
    }
    this.arm();
  }

  private reopen(r: Delivery, now: number) {
    const due = r.when_kind === 'at' ? Number(r.when_arg) : r.met_at != null ? now : null;
    // Only a row whose time came while the minion was dismissed keeps saying so.
    const reason = due != null && due <= now ? r.reason : null;
    this.store.updateDelivery(r.id, { state: 'waiting', due, reason }, ['held'], now);
  }

  private drop(r: Delivery, reason: string, now: number) {
    if (!this.store.updateDelivery(r.id, { state: 'dropped', reason }, ['held', 'waiting', 'sending'], now)) return;
    const setter = /^minion:(\d+)$/.exec(r.set_by);
    if (setter && !(r.to_kind === 'minion' && Number(setter[1]) === r.to_id)) {
      const what = this.kinds.get(r.kind)?.describe?.(r) ?? r.kind;
      this.runner.leaveMail(Number(setter[1]), this.opts.author, `Dropped delivery #${r.id} to #${r.to_id} (${what}): ${reason}.`);
    }
  }

  /** Inside the target's lane (so no turn of its is starting): check its handed rows, then send its due rows, kind by
   * kind, in id order. Re-reads the target; never claims for a closed one. */
  private deliverTarget(toKind: string, toId: number) {
    if (this.stopped) return;
    const now = this.now();
    const dueRows = (state: 'waiting' | 'sending') =>
      this.store.listDeliveries({ to: toId, toKind, states: [state] }).filter((r) => this.kinds.has(r.kind) && r.due != null && r.due <= now);
    const repeats = new Set<number>();
    for (const r of dueRows('sending')) {
      const left = this.leftover.delete(r.id);
      if (r.event_id != null && toKind === 'minion' && this.runner.holds(toId, r.event_id)) {
        this.store.updateDelivery(r.id, { due: now + RECHECK_MS }, ['sending'], now);
      } else if (left) {
        // A killed server left it: its turn may have started before the kill, so the copy sent now says it may repeat.
        if (this.store.updateDelivery(r.id, { state: 'waiting', due: now }, ['sending'], now)) repeats.add(r.id);
      } else this.retry(r, 'the runner dropped it before its turn started', now);
    }
    let rows = dueRows('waiting');
    if (!rows.length) return;
    if (toKind === 'minion') {
      const t = this.store.getTicket(toId);
      if (!t) {
        for (const r of rows) this.drop(r, 'minion deleted', now);
        return;
      }
      if (t.status === 'closed') {
        for (const r of rows.filter((r) => this.kinds.get(r.kind)!.onDismiss !== 'deliver')) {
          this.store.updateDelivery(r.id, { state: 'held', due: now + HOLD_MS, reason: 'target closed' }, ['waiting'], now);
        }
        rows = rows.filter((r) => this.kinds.get(r.kind)!.onDismiss === 'deliver');
      }
      const refused = t.status === 'closed' ? null : (this.runner.refuseTurn?.(t, this.opts.author) ?? null);
      if (refused) {
        for (const r of rows) this.retry(r, refused, now);
        return;
      }
    }
    const claimed = rows.filter((r) => this.store.updateDelivery(r.id, { state: 'sending', met_at: r.met_at ?? now }, ['waiting'], now));
    const ctx: DeliverCtx = { now, bootAt: this.bootAt, send: (row, text) => this.sendTo(row, text, repeats.has(row.id)) };
    for (const kindName of new Set(claimed.map((r) => r.kind))) {
      const batch = claimed.filter((r) => r.kind === kindName).map((r) => this.store.getDelivery(r.id)!);
      let outcomes: Outcome[];
      try {
        outcomes = this.kinds.get(kindName)!.deliver(batch, ctx);
      } catch (err) {
        outcomes = batch.map(() => ({ state: 'retry', reason: String((err as Error)?.message ?? err) }));
      }
      batch.forEach((r, i) => this.settle(r, outcomes[i] ?? { state: 'retry', reason: 'no outcome' }, now));
    }
  }

  private sendTo(row: Delivery, text: string, repeat: boolean): Outcome {
    const tail = repeat ? `(The server restarted while sending this, so it may repeat delivery #${row.id}.)` : `(delivery #${row.id})`;
    try {
      return { state: 'handed', event: this.runner.send(row.to_id, this.opts.author, `${text}\n\n${tail}`).event.id };
    } catch (err) {
      return { state: 'retry', reason: String((err as Error)?.message ?? err) }; // this row only: the others in its batch were sent
    }
  }

  private settle(r: Delivery, o: Outcome, now: number) {
    if (o.state === 'accepted') this.store.updateDelivery(r.id, { state: 'sent' }, ['sending'], now);
    else if (o.state === 'handed') this.store.updateDelivery(r.id, { event_id: o.event, due: now + RECHECK_MS }, ['sending'], now);
    else if (o.state === 'drop') this.store.updateDelivery(r.id, { state: 'dropped', reason: o.reason }, ['sending'], now);
    else this.retry(r, o.reason, now);
  }

  private retry(r: Delivery, reason: string, now: number) {
    const attempts = r.attempts + 1;
    if (attempts <= RETRY_MINUTES.length) {
      this.store.updateDelivery(r.id, { state: 'waiting', attempts, last_error: reason, met_at: r.met_at ?? now, due: now + RETRY_MINUTES[attempts - 1] * MINUTE }, undefined, now);
      return;
    }
    this.store.updateDelivery(r.id, { state: 'failed', attempts, last_error: reason, reason: `failed ${attempts} times` }, undefined, now);
    // A lost wake strands a minion, so the setter's Taskmaster is woken, not given held mail (ADR 0021).
    const setter = /^minion:(\d+)$/.exec(r.set_by);
    const of = this.store.getTicket(setter ? Number(setter[1]) : r.to_id);
    const tm = of && this.store.ownerCoordinator(of);
    if (!tm) return this.opts.log?.(`outbox: delivery #${r.id} failed, and no Taskmaster to tell`);
    const what = this.kinds.get(r.kind)?.describe?.(r) ?? r.kind;
    this.runner.send(tm.id, this.opts.author, `Delivery #${r.id} to #${r.to_id} failed ${attempts} times and was given up (${what}). Last error: ${reason}`);
  }

  /** One timer, to the smallest due among rows it can act on (capped at 2^31-1 ms). */
  private arm() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    let next = Infinity;
    for (const r of this.live()) {
      if (r.due == null || (r.state !== 'held' && this.busy.has(target(r)))) continue;
      next = Math.min(next, r.due);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => void this.poke({ type: 'tick' }), Math.min(Math.max(0, next - this.now()), MAX_TIMER_MS));
    this.timer.unref?.();
  }
}
