// The one outbox's table (ADR 0021, #1385): every saved "send this later" row. src/outbox.ts is the only writer.
import type { Store } from '../db.ts';

export type DeliveryState = 'waiting' | 'held' | 'sending' | 'sent' | 'dropped' | 'failed';
export type Delivery = {
  id: number;
  project_id: number;
  kind: string;
  to_kind: 'minion' | 'taskmaster';
  to_id: number;
  when_kind: string;
  when_arg: any;
  payload: any;
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
export type NewDelivery = Pick<Delivery, 'project_id' | 'kind' | 'to_kind' | 'to_id' | 'when_kind' | 'set_by'> &
  Partial<Pick<Delivery, 'id' | 'when_arg' | 'payload' | 'state' | 'due' | 'met_at' | 'dedupe_key' | 'origin' | 'reason'>>;
export type DeliveryPatch = Partial<Pick<Delivery, 'when_arg' | 'payload' | 'state' | 'due' | 'met_at' | 'attempts' | 'last_error' | 'reason' | 'event_id'>>;

const row = (r: any): Delivery => ({ ...r, when_arg: JSON.parse(r.when_arg), payload: JSON.parse(r.payload) });
const PATCHABLE = new Set(['when_arg', 'payload', 'state', 'due', 'met_at', 'attempts', 'last_error', 'reason', 'event_id']);

function insert(store: Store, d: NewDelivery, now: number): number {
  const cols = ['project_id', 'kind', 'to_kind', 'to_id', 'when_kind', 'when_arg', 'payload', 'set_by', 'state', 'due', 'met_at', 'dedupe_key', 'origin', 'reason', 'created_at', 'updated_at'];
  const vals = [d.project_id, d.kind, d.to_kind, d.to_id, d.when_kind, JSON.stringify(d.when_arg ?? null), JSON.stringify(d.payload ?? {}), d.set_by, d.state ?? 'waiting', d.due ?? null, d.met_at ?? null, d.dedupe_key ?? null, d.origin ?? null, d.reason ?? null, now, now];
  if (d.id != null) (cols.unshift('id'), vals.unshift(d.id));
  const r = store.db.prepare(`INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (origin) DO NOTHING`).run(...(vals as any[]));
  return r.changes ? Number(r.lastInsertRowid) : 0;
}

export const deliveryQueries = {
  /** Add a row and return it. */
  addDelivery(this: Store, d: NewDelivery, now = Date.now()): Delivery {
    return this.getDelivery(insert(this, d, now))!;
  },

  getDelivery(this: Store, id: number): Delivery | undefined {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
    return r ? row(r) : undefined;
  },

  /** Rows in id order, narrowed by kind, target (a minion's id unless toKind says otherwise), states or dedupe key. */
  listDeliveries(this: Store, q: { kind?: string; to?: number; toKind?: string; states?: DeliveryState[]; dedupe?: string } = {}): Delivery[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.kind != null) (where.push('kind = ?'), args.push(q.kind));
    if (q.to != null) (where.push('to_kind = ? AND to_id = ?'), args.push(q.toKind ?? 'minion', q.to));
    if (q.dedupe != null) (where.push('dedupe_key = ?'), args.push(q.dedupe));
    if (q.states?.length) (where.push(`state IN (${q.states.map(() => '?').join(', ')})`), args.push(...q.states));
    return (this.db.prepare(`SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`).all(...args) as any[]).map(row);
  },

  /** Change a row, only if it is still in one of `from` (when given). True if it changed: a claim that lost says false. */
  updateDelivery(this: Store, id: number, patch: DeliveryPatch, from?: DeliveryState[], now = Date.now()): boolean {
    const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
    const vals = keys.map((k) => (k === 'payload' || k === 'when_arg' ? JSON.stringify((patch as any)[k]) : (patch as any)[k]));
    const guard = from?.length ? ` AND state IN (${from.map(() => '?').join(', ')})` : '';
    const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
    return this.db.prepare(`UPDATE deliveries SET ${sets} WHERE id = ?${guard}`).run(...vals, now, id, ...(from ?? [])).changes > 0;
  },

  /** Delete sent rows older than `sentBefore` and dropped or failed rows older than `endedBefore`. */
  pruneDeliveries(this: Store, sentBefore: number, endedBefore: number): number {
    return Number(
      this.db.prepare("DELETE FROM deliveries WHERE (state = 'sent' AND updated_at < ?) OR (state IN ('dropped', 'failed') AND updated_at < ?)").run(sentBefore, endedBefore).changes,
    );
  },

  /** Whether a turn of `ticketId` started after event `eventId` was posted: its session's init comes after it (output alone could be the turn it queued behind). */
  turnSince(this: Store, ticketId: number, eventId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE ticket_id = ? AND kind = 'claude' AND id > ? AND json_extract(data, '$.subtype') = 'init' LIMIT 1").get(ticketId, eventId);
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
