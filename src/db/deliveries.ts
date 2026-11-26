// The one outbox's table (ADR 0021, #1385): every saved "send this later" row. src/outbox.ts is the only writer.
import type { Store } from '../db.ts';
import type { AlertBatch } from '../alert-wakes.ts';
import type { Armed } from '../ci-armed.ts';
import type { Relay } from '../wake.ts';
import { inScope, scoped } from '../read-scope.ts';

export type DeliveryState = 'waiting' | 'held' | 'sending' | 'sent' | 'dropped' | 'failed';

/** Each outbox kind's two JSON columns: `when_arg` (what it waits on) and `payload` (what it sends). Its module writes both. */
type Shapes = {
  /** src/wake.ts: wake the minion once `when_arg`'s commit (null: the server's next commit) is live. `text` and `light` are set when it is met. */
  wake_when_live: { when_arg: string | null; payload: { reason: string; since: string | null; light?: boolean; text?: string } };
  /** src/wake.ts: a note `ticket` sends once its commit `when_arg` ships or is live; `batch` groups the ones met together. */
  relay: { when_arg: string; payload: { ticket: number; to: Relay['to']; text: string; batch?: number } };
  /** src/wake.ts: a sealed minion's brief, held until minion `after`'s work is live or merged. `why` is set when it is met. */
  chain: { when_arg: { after: number; base: string | null; since?: number }; payload: { message: string; from: string; reason: string; told?: true; why?: string } };
  /** src/wake.ts: wake_at, due at `when_arg` (ms). */
  wake_at: { when_arg: number; payload: { note: string; setBy: string } };
  /** src/ci-health.ts: wake once the runners labelled `when_arg` are back. `text` is set when it is met. */
  runners_back: { when_arg: string; payload: { reason: string; text?: string } };
  /** src/ci-armed.ts: a card or Taskmaster message armed for CI on commit `when_arg`. */
  ci_armed: { when_arg: string; payload: Armed };
  /** src/alert-wakes.ts: one scheme's batch of alerts for its Taskmaster. */
  alert: { when_arg: null; payload: AlertBatch };
  /** server.ts: news from a test box job. */
  box_job: { when_arg: number; payload: { text: string } };
};
export type DeliveryKind = keyof Shapes;

type DeliveryBase = {
  id: number;
  project_id: number;
  to_kind: 'minion' | 'taskmaster';
  to_id: number;
  when_kind: string;
  set_by: string;
  state: DeliveryState;
  due: number | null;
  met_at: number | null;
  dedupe_key: string | null;
  origin: string | null;
  attempts: number;
  last_error: string | null;
  reason: string | null;
  /** The runner event a `sending` row was handed as: it is sent once a turn carrying that event starts. */
  event_id: number | null;
  created_at: number;
  updated_at: number;
};
type AnyDelivery = { [P in DeliveryKind]: DeliveryBase & { kind: P } & Shapes[P] }[DeliveryKind];
type AnyNewDelivery = {
  [P in DeliveryKind]: Pick<DeliveryBase, 'project_id' | 'to_kind' | 'to_id' | 'when_kind' | 'set_by'> & Partial<Pick<DeliveryBase, 'id' | 'state' | 'due' | 'met_at' | 'dedupe_key' | 'origin' | 'reason'>> & { kind: P; when_arg?: Shapes[P]['when_arg']; payload?: Shapes[P]['payload'] };
}[DeliveryKind];
/** A row of kind K (any kind by default): its `kind` says which `when_arg` and `payload` it holds. */
export type Delivery<K extends DeliveryKind = DeliveryKind> = Extract<AnyDelivery, { kind: K }>;
export type NewDelivery<K extends DeliveryKind = DeliveryKind> = Extract<AnyNewDelivery, { kind: K }>;
export type DeliveryPatch = Partial<Pick<DeliveryBase, 'state' | 'due' | 'met_at' | 'attempts' | 'last_error' | 'reason' | 'event_id'> & Pick<Delivery, 'when_arg' | 'payload'>>;
/** Whether `r` is a row of `kind`. */
export const ofKind = <K extends DeliveryKind>(r: Delivery | undefined, kind: K): r is Delivery<K> => r?.kind === kind;
type DeliveryQuery = { kind?: DeliveryKind; to?: number; toKind?: string; states?: DeliveryState[]; dedupe?: string };
/** listDeliveries of one kind, typed as that kind's rows (Store's methods can't carry a type parameter). */
export const deliveriesOf = <K extends DeliveryKind>(store: Pick<Store, 'listDeliveries'>, kind: K, q: Omit<DeliveryQuery, 'kind'> = {}): Delivery<K>[] => store.listDeliveries({ ...q, kind }).filter((r) => ofKind(r, kind));
/** getDelivery, when the row is of `kind`. */
export const deliveryOf = <K extends DeliveryKind>(store: Pick<Store, 'getDelivery'>, id: number, kind: K): Delivery<K> | undefined => {
  const r = store.getDelivery(id);
  return ofKind(r, kind) ? r : undefined;
};

// The states of a row not yet sent or dropped, which a read scope keeps.
const LIVE: DeliveryState[] = ['waiting', 'held', 'sending'];
/** A row as stored: both JSON columns still text. */
type DeliveryRow = DeliveryBase & { kind: DeliveryKind; when_arg: string; payload: string };
const row = (r: DeliveryRow): Delivery => ({ ...r, when_arg: JSON.parse(r.when_arg), payload: JSON.parse(r.payload) });
const PATCHABLE = new Set(['when_arg', 'payload', 'state', 'due', 'met_at', 'attempts', 'last_error', 'reason', 'event_id']);

function insert(store: Store, d: NewDelivery, now: number): number {
  const cols = ['project_id', 'kind', 'to_kind', 'to_id', 'when_kind', 'when_arg', 'payload', 'set_by', 'state', 'due', 'met_at', 'dedupe_key', 'origin', 'reason', 'created_at', 'updated_at'];
  const vals = [d.project_id, d.kind, d.to_kind, d.to_id, d.when_kind, JSON.stringify(d.when_arg ?? null), JSON.stringify(d.payload ?? {}), d.set_by, d.state ?? 'waiting', d.due ?? null, d.met_at ?? null, d.dedupe_key ?? null, d.origin ?? null, d.reason ?? null, now, now];
  if (d.id != null) cols.unshift('id'), vals.unshift(d.id);
  const r = store.db.prepare(`INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (origin) DO NOTHING`).run(...vals);
  return r.changes ? Number(r.lastInsertRowid) : 0;
}

export const deliveryQueries = {
  /** Add a row and return it. */
  addDelivery(this: Store, d: NewDelivery, now = Date.now()): Delivery {
    return this.getDelivery(insert(this, d, now))!;
  },

  getDelivery(this: Store, id: number): Delivery | undefined {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
    return r ? row(r as unknown as DeliveryRow) : undefined;
  },

  /** Rows in id order, narrowed by kind, target (a minion's id unless toKind says otherwise), states or dedupe key. */
  listDeliveries(this: Store, q: DeliveryQuery = {}): Delivery[] {
    // In a read scope (src/read-scope.ts) every row still to go is read once (or every row in the states asked, which the
    // prune keeps short), and each ask for some of them filters that: a scheme's list asked twice a minion (#1527).
    if (inScope(this.db) && q.dedupe == null && q.states?.length) {
      const states = q.states.every((s) => LIVE.includes(s)) ? LIVE : [...new Set(q.states)].sort();
      const live = scoped(this.db, `deliveries:${states.join(',')}`, () => this.db.prepare(`SELECT * FROM deliveries WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`).all(...states) as unknown as DeliveryRow[]);
      return live.filter((r) => (q.kind == null || r.kind === q.kind) && (q.to == null || (r.to_kind === (q.toKind ?? 'minion') && Number(r.to_id) === Number(q.to))) && q.states!.includes(r.state)).map(row);
    }
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.kind != null) where.push('kind = ?'), args.push(q.kind);
    if (q.to != null) where.push('to_kind = ? AND to_id = ?'), args.push(q.toKind ?? 'minion', q.to);
    if (q.dedupe != null) where.push('dedupe_key = ?'), args.push(q.dedupe);
    if (q.states?.length) where.push(`state IN (${q.states.map(() => '?').join(', ')})`), args.push(...q.states);
    return (this.db.prepare(`SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`).all(...args) as unknown as DeliveryRow[]).map(row);
  },

  /** Change a row, only if it is still in one of `from` (when given). True if it changed: a claim that lost says false. */
  updateDelivery(this: Store, id: number, patch: DeliveryPatch, from?: DeliveryState[], now = Date.now()): boolean {
    // A row going back to waiting or held while a twin with its dedupe key already is would break the unique index and
    // abort the outbox pass (#1431): it is dropped as the twin's duplicate instead (the twin carries the newer payload).
    if (patch.state === 'waiting' || patch.state === 'held') {
      const me = this.db.prepare('SELECT kind, dedupe_key, state FROM deliveries WHERE id = ?').get(id) as { kind: string; dedupe_key: string | null; state: string } | undefined;
      if (me?.dedupe_key != null && (!from?.length || from.includes(me.state as DeliveryState)) && !['waiting', 'held'].includes(me.state)) {
        const twin = this.db.prepare("SELECT 1 FROM deliveries WHERE kind = ? AND dedupe_key = ? AND state IN ('waiting', 'held') AND id != ?").get(me.kind, me.dedupe_key, id);
        if (twin) patch = { state: 'dropped', reason: 'a newer row with the same key is waiting' };
      }
    }
    const keys = (Object.keys(patch) as (keyof DeliveryPatch)[]).filter((k) => PATCHABLE.has(k));
    const vals = keys.map((k) => (k === 'payload' || k === 'when_arg' ? JSON.stringify(patch[k]) : (patch[k] ?? null)));
    const guard = from?.length ? ` AND state IN (${from.map(() => '?').join(', ')})` : '';
    const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
    return this.db.prepare(`UPDATE deliveries SET ${sets} WHERE id = ?${guard}`).run(...vals, now, id, ...(from ?? [])).changes > 0;
  },

  /** Delete sent rows older than `sentBefore` and dropped or failed rows older than `endedBefore`. */
  pruneDeliveries(this: Store, sentBefore: number, endedBefore: number): number {
    return Number(this.db.prepare("DELETE FROM deliveries WHERE (state = 'sent' AND updated_at < ?) OR (state IN ('dropped', 'failed') AND updated_at < ?)").run(sentBefore, endedBefore).changes);
  },

  /** Whether a turn of `ticketId` started after event `eventId` was posted: its session's init comes after it (output alone could be the turn it queued behind). */
  turnSince(this: Store, ticketId: number, eventId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE ticket_id = ? AND kind = 'claude' AND id > ? AND json_extract(data, '$.subtype') = 'init' LIMIT 1").get(ticketId, eventId);
  },

  /** Run `fn` in one transaction on this connection, so the settings it writes commit with its rows or not at all (alert wakes' `told`, #1392). */
  deliveryTransaction<T>(this: Store, fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /**
   * Move an old settings key's rows into the table and empty the key, in one transaction: all of them or none (ADR 0021,
   * "Steps"). A row keeps its old id when the table never used it, so an id a minion remembers still names its wake; an
   * `origin` already moved is skipped. Returns the rows added.
   */
  importDeliveries(this: Store, key: string, rows: NewDelivery[], now = Date.now()): Delivery[] {
    const ids: number[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const d of [...rows].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
        const seq = (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'deliveries'").get() as { seq: number } | undefined)?.seq ?? 0;
        const id = insert(this, { ...d, id: d.id != null && d.id > seq ? d.id : undefined }, now);
        if (id) ids.push(id);
      }
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return ids.map((id) => this.getDelivery(id)!);
  },
};
