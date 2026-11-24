// Batch reads for a request's read scope (src/read-scope.ts, #1527): each fills one kind of per-minion row for a whole
// list in one query, so the Store's scoped single-row reads find it there instead of reading again.
import type { EventRow, Store } from '../db.ts';
import { inScope, warm } from '../read-scope.ts';

export const readWarmQueries = {
  /** Inside a read scope (src/read-scope.ts): every one of `keys` in one read, for getSetting. */
  warmSettings(this: Store, keys: string[]) {
    if (!inScope(this.db) || !keys.length) return;
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE key IN (SELECT value FROM json_each(?))').all(JSON.stringify(keys)) as { key: string; value: string }[];
    const got = new Map(rows.map((r) => [r.key, r.value]));
    warm(
      this.db,
      keys.map((k) => [`setting:${k}`, got.get(k) ?? null]),
    );
  },

  /** Inside a read scope (src/read-scope.ts): ticketCost (both kinds) and lastTurnEnd of every one of `ids`, in one read. */
  warmTurnTotals(this: Store, ids: number[]) {
    if (!inScope(this.db) || !ids.length) return;
    const rows = this.db
      .prepare(`SELECT j.value AS id, COALESCE(SUM(t.cost_usd), 0) AS c, COALESCE(SUM(CASE WHEN t.payer IS NULL THEN t.cost_usd END), 0) AS h,
        (SELECT ended_at FROM turns WHERE ticket_id = j.value AND side IS NULL ORDER BY id DESC LIMIT 1) AS e
      FROM json_each(?) j LEFT JOIN turns t ON t.ticket_id = j.value GROUP BY j.value`)
      .all(JSON.stringify(ids)) as { id: number; c: number; h: number; e: number | null }[];
    warm(
      this.db,
      rows.flatMap(
        (r) =>
          [
            [`cost:${r.id}:false`, r.c],
            [`cost:${r.id}:true`, r.h],
            [`last-turn-end:${r.id}`, r.e ?? null],
          ] as [string, unknown][],
      ),
    );
  },

  /** Inside a read scope (src/read-scope.ts): every open card of `projectId`'s minions in one read, for openCardsOf of each of `ticketIds`. */
  warmOpenCards(this: Store, projectId: number, ticketIds: number[]) {
    if (!inScope(this.db)) return;
    const by = new Map<number, EventRow[]>(ticketIds.map((id) => [id, []]));
    for (const e of this.openCards(projectId)) by.get(e.ticket_id)?.push(e);
    warm(
      this.db,
      [...by].map(([id, rows]) => [`open-cards:${id}`, rows]),
    );
  },

  /** Inside a read scope (src/read-scope.ts): every one of `ids` in one read, for getEvent. */
  warmEvents(this: Store, ids: number[]) {
    if (!inScope(this.db) || !ids.length) return;
    const rows = this.db.prepare('SELECT * FROM events WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as unknown as EventRow[];
    const got = new Map(rows.map((e) => [e.id, e]));
    warm(
      this.db,
      ids.map((id) => [`event:${id}`, got.get(id)]),
    );
  },
};
