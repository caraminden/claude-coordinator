// Cards: which are open, the recent ones, and what became of them (#1313: src/db.ts by area).
import { NOT_PEOPLE } from '../auth.ts';
import { scoped } from '../read-scope.ts';
import type { CardFate, EventRow } from '../db-rows.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { Store } from '../db.ts';

/**
 * SQL on user_message event `a`: a person wrote it in that chat, so a card from before #812 counts it as handling it.
 * Not a relay from another chat (`from`: a minion, this or another scheme's Taskmaster), held mail, a
 * brief, Mandate's hook news, nor a name that isn't a person's (#610).
 */
const PERSON_WROTE = `json_extract(a.data, '$.from') IS NULL AND json_extract(a.data, '$.mail') IS NULL AND json_extract(a.data, '$.brief') IS NULL
  AND lower(coalesce(json_extract(a.data, '$.author'), '')) NOT IN (${[...NOT_PEOPLE, 'Mandate'].map((n) => `'${n.toLowerCase().replace(/'/g, "''")}'`).join(', ')})
  AND coalesce(json_extract(a.data, '$.author'), '') NOT LIKE '#%'`;

export const cardQueries = {
  /**
   * A project's stored cards still waiting on a person, in threads that aren't dismissed: questions
   * nobody has answered (nor the minion settled), and plans still pending. Approval cards live in memory (Approvals.pending).
   * Only a card's own answer (a click, a doc Send, a held answer) clears it; a message typed in the chat doesn't (#812),
   * since it may be about anything. The minion settles a card someone answered by typing (settle_question).
   */
  openCards(this: Store, projectId: number): EventRow[] {
    return this.openCardsWhere('t.project_id = ?', projectId);
  },

  /** One minion's open cards (openCards), oldest first. */
  openCardsOf(this: Store, ticketId: number): EventRow[] {
    return [...scoped(this.db, `open-cards:${ticketId}`, () => this.openCardsWhere('e.ticket_id = ?', ticketId))];
  },

  /** When the oldest of a minion's open cards (openCards) was posted, or null with none. */
  openCardAt(this: Store, ticketId: number): number | null {
    return this.openCardsOf(ticketId)[0]?.created_at ?? null;
  },

  /** The event id of the oldest of a minion's open cards (openCards) with at most `within` events after it, or null. */
  openCardEventId(this: Store, ticketId: number, within: number): number | null {
    const id = this.openCardsWhere('e.ticket_id = ?', ticketId)[0]?.id;
    if (id == null) return null;
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE ticket_id = ? AND id > ?').get(ticketId, id) as { n: number };
    return n <= within ? id : null;
  },

  /** Whether the chat still shows card event `eventId` under its turn's words: no message and no turn end since (public/thread.js heldCards). */
  heldBelow(this: Store, ticketId: number, eventId: number): boolean {
    return !this.db.prepare("SELECT 1 FROM events WHERE ticket_id = ? AND id > ? AND (kind = 'user_message' OR (kind = 'claude' AND json_extract(data, '$.type') = 'result')) LIMIT 1").get(ticketId, eventId);
  },

  /** The id of the chat event that posted a minion's card `cardId` of `kind`, or null if there's none. */
  cardEventId(this: Store, ticketId: number, kind: string, cardId: string): number | null {
    const row = this.db.prepare("SELECT id FROM events WHERE ticket_id = ? AND kind = ? AND json_extract(data, '$.id') = ? ORDER BY id DESC LIMIT 1").get(ticketId, kind, cardId) as { id: number } | undefined;
    return row?.id ?? null;
  },

  pickedCards(this: Store, projectId: number, limit: number) {
    return this.db
      .prepare(`
      SELECT * FROM (
        SELECT e.id, t.number, t.kind AS tkind, t.status AS tstatus
        FROM events e INDEXED BY events_cards JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('question', 'plan', 'approval')
        ORDER BY e.id DESC LIMIT ?)
      ORDER BY id`)
      .all(projectId, limit) as { id: number; number: number | null; tkind: string; tstatus: string }[];
  },

  readCardRows(this: Store, ids: number[]) {
    if (!ids.length) return;
    for (const row of this.db.prepare('SELECT * FROM events WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as unknown as EventRow[]) {
      this.cardRows.set(row.id, { ...row, cid: JSON.parse(row.data).id ?? null });
    }
  },

  /**
   * Read up to `chunk` of recentCards' card rows it hasn't read yet, and say how many are still unread. The first
   * recentCards after a restart reads all 500 rows at once, scattered over a gigabyte file: 1.3 s of held loop when the
   * disk was busy. The server calls this in small steps at start, so that first call finds them read.
   */
  warmCardRows(this: Store, projectId: number, limit: number, chunk: number): number {
    const unread = this.pickedCards(projectId, limit)
      .filter((p) => !this.cardRows.has(p.id))
      .map((p) => p.id);
    this.readCardRows(unread.slice(0, chunk));
    return Math.max(unread.length - chunk, 0);
  },

  /**
   * A project's newest `limit` question, plan and approval cards, oldest first,
   * each with its minion and how it was settled: the answer to it (`reply`), and an approval's result (`result`). For the link check (#531).
   */
  recentCards(this: Store, projectId: number, limit: number): (EventRow & { number: number | null; tkind: string; tstatus: string; reply: string | null; result: string | null })[] {
    // Which cards, from the index alone; their rows only for cards not read before. Re-reading the 500 rows every
    // time, scattered over a gigabyte file, held the event loop 1-5 s whenever the page cache had dropped them (#759).
    const picked = this.pickedCards(projectId, limit);
    this.readCardRows(picked.filter((p) => !this.cardRows.has(p.id)).map((p) => p.id));
    const cards = picked.flatMap((p) => {
      const row = this.cardRows.get(p.id);
      return row ? [{ ...row, number: p.number, tkind: p.tkind, tstatus: p.tstatus }] : [];
    });
    const upTo = (this.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number | null }).id ?? 0;
    // After a restart the memory is empty: take what was saved, as long as it is of this very card and not newer than the
    // events (a deleted newest id can come back as another card, #762). Anything else is read again from the card on.
    const lost = cards.filter((c) => !this.cardFates.has(c.id));
    if (lost.length) {
      const saved = new Map((this.db.prepare('SELECT * FROM card_fates WHERE card_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(lost.map((c) => c.id))) as unknown as (CardFate & { card_id: number; ticket_id: number; cid: string | null; up_to: number })[]).map((r) => [r.card_id, r]));
      for (const c of lost) {
        const r = saved.get(c.id);
        if (r && r.ticket_id === c.ticket_id && r.cid === (c.cid == null ? null : String(c.cid)) && r.up_to >= c.id && r.up_to <= upTo) {
          this.cardFates.set(c.id, { reply: r.reply, result: r.result, upTo: r.up_to });
          this.savedFates.set(c.id, { reply: r.reply, result: r.result, upTo: r.up_to });
        }
      }
    }
    const fates = cards.map((c) => this.cardFates.get(c.id) ?? { reply: null, result: null, upTo: c.id });
    // Each chat's messages are read once from its oldest card still waiting, not once per card: 500 cards each
    // scanning the rest of a long chat held the event loop 1-3 s (#622). By kind: left to itself SQLite walked
    // events_ticket, every event of the chat (56,619 rows for 1,861 messages), 2-3 s from a cold cache after a restart.
    for (const ticket of new Set(cards.map((c) => c.ticket_id))) {
      const mine = cards.flatMap((c, i) => (c.ticket_id === ticket ? [{ cid: c.cid, approval: c.kind === 'approval', fate: fates[i] }] : []));
      const from = (pick: (f: CardFate) => string | null, of = mine) => Math.min(...of.filter((m) => pick(m.fate) == null).map((m) => m.fate.upTo));
      const replyFrom = from((f) => f.reply);
      const replies =
        replyFrom === Infinity
          ? []
          : (this.db
              .prepare(`
        SELECT a.id, coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) AS card,
          json_object('author', json_extract(a.data, '$.author'), 'at', a.created_at, 'text', substr(json_extract(a.data, '$.text'), 1, 200),
            'answer', json(json_extract(a.data, '$.answer'))) AS reply
        FROM events a INDEXED BY events_ticket_kind WHERE a.ticket_id = ? AND a.kind = 'user_message' AND a.id > ? AND a.id <= ?
          AND coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) IS NOT NULL ORDER BY a.id`)
              .all(ticket, replyFrom, upTo) as { id: number; card: unknown; reply: string }[]);
      // Only an approval gets a result: looking one up for every chat's questions and plans was half a cold call (#759).
      const resultFrom = from(
        (f) => f.result,
        mine.filter((m) => m.approval),
      );
      const results =
        resultFrom === Infinity
          ? []
          : (this.db
              .prepare(`
        SELECT id, json_extract(data, '$.id') AS card, json_set(data, '$.at', created_at) AS result
        FROM events INDEXED BY events_ticket_kind WHERE ticket_id = ? AND kind = 'approval_result' AND id > ? AND id <= ? ORDER BY id`)
              .all(ticket, resultFrom, upTo) as { id: number; card: unknown; result: string }[]);
      for (const { cid, approval, fate } of mine) {
        // Only a click on this card answers it: not one on another card, not a typed message (#812).
        fate.reply ??= replies.find((a) => a.id > fate.upTo && a.card === cid)?.reply ?? null;
        if (approval) fate.result ??= results.find((r) => r.id > fate.upTo && r.card === cid)?.result ?? null;
        fate.upTo = upTo;
      }
    }
    this.saveFates(cards, fates);
    return cards.map(({ cid, ...c }, i) => {
      this.cardFates.set(c.id, fates[i]);
      return { ...c, reply: fates[i].reply, result: fates[i].result };
    });
  },

  saveFates(this: Store, cards: { id: number; ticket_id: number; cid: unknown }[], fates: CardFate[]) {
    const now = Date.now();
    const lagging = now - this.fatesSavedAt > 5 * 60_000;
    const todo = cards.flatMap((c, i) => {
      const was = this.savedFates.get(c.id),
        f = fates[i];
      return !was || was.reply !== f.reply || was.result !== f.result || (lagging && was.upTo !== f.upTo) ? [{ c, f }] : [];
    });
    if (!todo.length) return;
    if (lagging) this.fatesSavedAt = now;
    // On the write worker a failed write is only logged, so this remembers it as saved: it is read again after a restart.
    if (this.putFates(todo.map(({ c, f }) => [c.id, c.ticket_id, c.cid == null ? null : String(c.cid), f.reply, f.result, f.upTo])) === false) return;
    for (const { c, f } of todo) this.savedFates.set(c.id, { ...f });
  },

  /** saveFates' write, in one commit: rows of card_fates' columns. False if it failed. */
  putFates(this: Store, rows: unknown[][]): boolean {
    const put = this.db.prepare('INSERT OR REPLACE INTO card_fates (card_id, ticket_id, cid, reply, result, up_to) VALUES (?, ?, ?, ?, ?, ?)');
    try {
      this.db.exec('BEGIN');
      for (const r of rows) put.run(...(r as SQLInputValue[]));
      this.db.exec('COMMIT');
      return true;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* no transaction was open */
      }
      return false; // not saved: it is read again after a restart
    }
  },

  /** Drop what recentCards and openCardsWhere remember of cards: one card's row (its data changed), or everything. */
  forgetCards(this: Store, id?: number) {
    if (id !== undefined) return void this.cardRows.delete(id);
    this.doneCards.clear();
    this.cardFates.clear();
    this.savedFates.clear();
    this.cardRows.clear();
  },

  openCardsWhere(this: Store, scope: string, id: number): EventRow[] {
    // Index-only: events_ticket_kind holds (ticket_id, kind, id).
    const ids = (
      this.db
        .prepare(`SELECT e.id FROM events e INDEXED BY events_ticket_kind JOIN tickets t ON t.id = e.ticket_id
      WHERE ${scope} AND t.status != 'closed' AND e.kind IN ('plan', 'question')`)
        .all(id) as { id: number }[]
    )
      .map((r) => r.id)
      .filter((i) => !this.doneCards.has(i));
    if (!ids.length) return [];
    const open = this.db
      .prepare(`
      SELECT e.* FROM events e WHERE e.id IN (SELECT value FROM json_each(?)) AND (
        (e.kind = 'plan' AND json_extract(e.data, '$.status') = 'pending')
        OR (e.kind = 'question' AND json_extract(e.data, '$.settled') IS NULL))
      AND NOT EXISTS (
        SELECT 1 FROM events a WHERE a.ticket_id = e.ticket_id AND a.kind = 'user_message' AND a.id > e.id
          -- only this card's own answer settles it, a held one for a cold asker (#687) too; a typed message answers nothing (#812)
          AND (coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) = json_extract(e.data, '$.id')
            OR (e.id <= ${this.typedHandlesUpTo} AND ${PERSON_WROTE} AND json_extract(e.data, '$.to') IS NULL
              AND coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) IS NULL)))
      ORDER BY e.id`)
      .all(JSON.stringify(ids)) as unknown as EventRow[];
    const still = new Set(open.map((e) => e.id));
    for (const i of ids) if (!still.has(i)) this.doneCards.add(i);
    return open;
  },
};
