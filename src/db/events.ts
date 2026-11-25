// A chat's log: its events, pages of them, plans, and what a chat has looked at or been told (#1313: src/db.ts by area).
import type { ClaudeEvent } from '../claude-events.ts';
import type { EventRow } from '../db-rows.ts';
import { copyRow, scoped } from '../read-scope.ts';
import type { Store } from '../db.ts';

/** The Overlord's events every person's Mine shows (#920; public/mine.js inMine says the same): items marked for everyone, and its cards' answers and results so they settle there. */
const MINE_EVENTS = `(json_extract(data, '$.everyone') = 1 OR kind IN ('question_result', 'question_more', 'card_reply', 'plan_result', 'approval_result')
  OR (kind = 'user_message' AND (json_extract(data, '$.answer') IS NOT NULL OR json_extract(data, '$.plan') IS NOT NULL)))`;

export const eventQueries = {
  addEvent(this: Store, ticketId: number, kind: string, data: unknown, reserved?: number): EventRow {
    const now = Date.now();
    const json = JSON.stringify(data);
    // With the write worker on, the id is handed out here, so the row is known before the worker writes it (src/db-writer.ts).
    let id: number | null = reserved ?? null;
    if (id === null && this.eventIds) this.eventIds.next = (id = Math.max(this.eventIds.next, this.eventIds.floor())) + 1;
    const rowid = this.insertEvent(id, ticketId, kind, json, now, data);
    if (kind === 'user_message' && json.includes('status:')) this.noteLooks(ticketId, json, now);
    return { id: id ?? (rowid as number), ticket_id: ticketId, kind, data: json, created_at: now };
  },

  /**
   * The Status page's looks (#1273): a minion whose title, or a message to it, quotes a tile's tag ("status:citadel/cpu") is
   * on that tile. Noted as it's written, a health event per tag, so the page reads a few rows and never scans messages.
   */
  noteLooks(this: Store, ticketId: number, text: string, at: number) {
    for (const tag of new Set(text.match(/status:(?:citadel|app:[\w.-]+)\/[a-z][a-z0-9-]*/g))) this.addHealthEvent('look', at, null, `${tag}\n${ticketId}`);
  },

  /** addEvent's write: the row (its id, if one was handed out), and its author's latest action. Returns the row's id. */
  insertEvent(this: Store, id: number | null, ticketId: number, kind: string, json: string, now: number, data: unknown): number {
    const r = this.db.prepare('INSERT INTO events (id, ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)').run(id, ticketId, kind, json, now);
    // A message or an approval click is its author's latest action in the scheme, for the recap (Store.recap).
    const actor = kind === 'user_message' ? (data as { author?: unknown } | null)?.author : kind === 'approval_result' ? (data as { by?: unknown } | null)?.by : null;
    if (typeof actor === 'string') {
      this.db
        .prepare(`INSERT INTO last_actions (name, project_id, at) SELECT ?, project_id, ? FROM tickets WHERE id = ?
        ON CONFLICT (name, project_id) DO UPDATE SET at = MAX(at, excluded.at)`)
        .run(actor, now, ticketId);
    }
    return Number(r.lastInsertRowid);
  },

  getEvent(this: Store, id: number): EventRow | undefined {
    const e = scoped(this.db, `event:${id}`, () => this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined);
    return copyRow(e);
  },

  /** Replace an event's data, for cards whose status lives in the card (plans). */
  setEventData(this: Store, id: number, data: unknown) {
    this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    this.forgetCards(id);
  },

  /**
   * A chat's events of these kinds after event `afterId`, oldest first: by index, so a long chat's thousands of Claude
   * events are never read. Reading a Taskmaster's whole chat to answer one card held the server 1-3 s (#759).
   */
  eventsOfKinds(this: Store, ticketId: number, kinds: string[], afterId = 0): EventRow[] {
    return this.db.prepare('SELECT * FROM events INDEXED BY events_ticket_kind WHERE ticket_id = ? AND kind IN (SELECT value FROM json_each(?)) AND id > ? ORDER BY id').all(ticketId, JSON.stringify(kinds), afterId) as unknown as EventRow[];
  },

  /** The data of a chat's first user_message (a minion's brief), or undefined: one row, never the whole chat (#1974). */
  firstMessage(this: Store, ticketId: number): string | undefined {
    return (this.db.prepare("SELECT data FROM events INDEXED BY events_ticket_kind WHERE ticket_id = ? AND kind = 'user_message' ORDER BY id LIMIT 1").get(ticketId) as { data: string } | undefined)?.data;
  },

  /** The event the chat's last counted turn ended at, or 0: the running turn's come after it. */
  lastTurnEvent(this: Store, ticketId: number): number {
    return (this.db.prepare('SELECT event_id FROM turns WHERE ticket_id = ? AND event_id IS NOT NULL AND side IS NULL ORDER BY id DESC LIMIT 1').get(ticketId) as { event_id: number } | undefined)?.event_id ?? 0;
  },

  /** Whether one of a chat's last 50 messages carries `sendId` (send-ids.ts): taken before a restart forgot it (#1862). */
  tookSend(this: Store, ticketId: number, sendId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM (SELECT data FROM events INDEXED BY events_ticket_kind WHERE ticket_id = ? AND kind = 'user_message' ORDER BY id DESC LIMIT 50)
      WHERE json_extract(data, '$.sendId') = ?`)
      .get(ticketId, sendId);
  },

  /** A chat's newest plan card, or undefined: a real plan, not a machine's notes (#617), its lending (#1638) or a release key card (#837), which ride the same event kind. */
  latestPlan(this: Store, ticketId: number): EventRow | undefined {
    return this.db
      .prepare(`SELECT * FROM events WHERE ticket_id = ? AND kind = 'plan' AND json_extract(data, '$.machine') IS NULL
      AND json_extract(data, '$.releaseKey') IS NULL AND json_extract(data, '$.machineLend') IS NULL ORDER BY id DESC LIMIT 1`)
      .get(ticketId) as unknown as EventRow | undefined;
  },

  /** The backup chat's lines (src/backup.ts): the newest `limit` messages, notes, errors and replies with text after `afterId`, oldest first. */
  chatTextEvents(this: Store, ticketId: number, afterId: number, limit: number): EventRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE ticket_id = ? AND id > ? AND (kind IN ('user_message', 'note', 'error')
      OR (kind = 'claude' AND json_extract(data, '$.type') = 'assistant' AND instr(data, '"type":"text"') > 0))
      ORDER BY id DESC LIMIT ?`)
        .all(ticketId, afterId, limit) as unknown as EventRow[]
    ).reverse();
  },

  /** A chat's events in [from, before), oldest first; `mine` keeps only what Mine shows from the Overlord (MINE_EVENTS). */
  eventsBetween(this: Store, ticketId: number, from: number, before: number, mine = false): EventRow[] {
    return this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND id >= ? AND id < ? ${mine ? `AND ${MINE_EVENTS}` : ''} ORDER BY id`).all(ticketId, from, before) as unknown as EventRow[];
  },

  /** A chat's newest `limit` events before `before`, newest first; `mine` as in eventsBetween. */
  eventsBefore(this: Store, ticketId: number, before: number, limit: number, mine = false): EventRow[] {
    return this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND id < ? ${mine ? `AND ${MINE_EVENTS}` : ''} ORDER BY id DESC LIMIT ?`).all(ticketId, before, limit) as unknown as EventRow[];
  },

  /** A chat's newest event of `kind` (#1149: the message a person just sent). */
  lastEventOf(this: Store, ticketId: number, kind: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE ticket_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(ticketId, kind) as unknown as EventRow | undefined;
  },

  listEvents(this: Store, ticketId: number, afterId = 0): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE ticket_id = ? AND id > ? ORDER BY id').all(ticketId, afterId) as unknown as EventRow[];
  },

  /**
   * A page of a ticket's history before `before`, oldest first, in whole turns: as many of the newest
   * turns as fit in `limit` events, and always at least one, so a running or long turn comes whole.
   * A turn starts just after the previous turn's result, so the messages that started it come with it.
   * With `from`, the page reaches back to the start of the turn holding that event too.
   */
  eventsPage(this: Store, ticketId: number, before: number, limit: number, from?: number): { events: EventRow[]; more: boolean } {
    const recent = this.db
      .prepare(`
      SELECT id, kind = 'claude' AND json_extract(data, '$.type') = 'result' AS ends FROM events
      WHERE ticket_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(ticketId, before, limit + 1) as { id: number; ends: number }[];
    if (!recent.length) return { events: [], more: false };
    let start = recent.at(-1)!.id;
    if (recent.length > limit) {
      // The oldest turn start in the newest `limit` events: the event after a result.
      const i = recent.findLastIndex((r, n) => n > 0 && r.ends);
      start = i > 0 ? recent[i - 1].id : this.turnStart(ticketId, recent[0].id);
    }
    if (from != null) start = Math.min(start, this.turnStart(ticketId, from));
    // Notes after a long last turn (dismissed, deployed) aren't a turn: they come with the turn before them,
    // so a minion never opens on nothing but "Load earlier" (#288).
    const hasTurn = this.db
      .prepare(`
      SELECT 1 FROM events WHERE ticket_id = ? AND id >= ? AND id < ? AND (kind = 'user_message'
        OR (kind = 'claude' AND json_extract(data, '$.type') = 'system' AND json_extract(data, '$.subtype') = 'init')) LIMIT 1`)
      .get(ticketId, start, before);
    const prev = !hasTurn && (this.db.prepare('SELECT MAX(id) AS id FROM events WHERE ticket_id = ? AND id < ?').get(ticketId, start) as { id: number | null });
    if (prev && prev.id != null) start = this.turnStart(ticketId, prev.id);
    const events = this.db.prepare('SELECT * FROM events WHERE ticket_id = ? AND id >= ? AND id < ? ORDER BY id').all(ticketId, start, before) as unknown as EventRow[];
    const more = !!this.db.prepare('SELECT 1 FROM events WHERE ticket_id = ? AND id < ? LIMIT 1').get(ticketId, start);
    return { events, more };
  },

  /** The first event of the turn holding event `id`: the one after the last result before it. */
  turnStart(this: Store, ticketId: number, id: number): number {
    const row = this.db
      .prepare(`
      SELECT MIN(id) AS id FROM events WHERE ticket_id = ? AND id > COALESCE((
        SELECT MAX(id) FROM events WHERE ticket_id = ? AND id < ? AND kind = 'claude' AND json_extract(data, '$.type') = 'result'), 0)`)
      .get(ticketId, ticketId, id) as { id: number | null };
    return row.id ?? id;
  },

  /**
   * A ticket's events before `before` that can change its task list (progress.js applyEvent): turn
   * starts, Claude's messages and tool calls, and the results that give a TaskCreate its id. Tool results
   * are most of the bytes, so they are left out by prefix, without parsing anyone's JSON (#497).
   */
  planEvents(this: Store, ticketId: number, before = Number.MAX_SAFE_INTEGER, after = 0): EventRow[] {
    return this.db
      .prepare(`
      SELECT * FROM events WHERE ticket_id = ? AND id < ? AND id > ? AND kind = 'claude' AND (data NOT LIKE '{"type":"user"%' OR instr(data, 'Task #') > 0)
      ORDER BY id`)
      .all(ticketId, before, after) as unknown as EventRow[];
  },

  /**
   * The text of a ticket's replies that may link files (subagents' included), from its Claude events after event
   * `after`, at most `limit` events read: `upTo` is the last one read, and `more` that there may be more after it.
   * Read in pages from where the last scan stopped, since a long chat's whole history read cold held the server
   * a second (#609).
   */
  replyTexts(this: Store, ticketId: number, after = 0, limit = -1): { texts: string[]; upTo: number; more: boolean } {
    const rows = this.db.prepare("SELECT id, CASE WHEN data LIKE '%\"type\":\"assistant\"%' AND data LIKE '%](%' THEN data END AS data FROM events WHERE ticket_id = ? AND kind = 'claude' AND id > ? ORDER BY id LIMIT ?").all(ticketId, after, limit) as { id: number; data: string | null }[];
    const texts: string[] = [];
    for (const { data } of rows) {
      if (data == null) continue;
      const content = JSON.parse(data).message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    return { texts, upTo: rows.at(-1)?.id ?? after, more: limit >= 0 && rows.length === limit };
  },

  /** Pass every stored Claude event through `fn` and save what it returns (null deletes the event). */
  rewriteClaudeEvents(this: Store, fn: (data: ClaudeEvent) => unknown): { changed: number; deleted: number } {
    const changes: { id: number; data: string | null }[] = [];
    for (const row of this.db.prepare("SELECT id, data FROM events WHERE kind = 'claude'").iterate() as Iterable<{ id: number; data: string }>) {
      const next = fn(JSON.parse(row.data));
      const data = next == null ? null : JSON.stringify(next);
      if (data !== row.data) changes.push({ id: row.id, data });
    }
    const update = this.db.prepare('UPDATE events SET data = ? WHERE id = ?');
    const remove = this.db.prepare('DELETE FROM events WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const c of changes) c.data == null ? remove.run(c.id) : update.run(c.data, c.id);
      // Task-list states saved from the old events (planKey) no longer match them.
      if (changes.length) this.db.prepare("DELETE FROM settings WHERE key LIKE 'plan:%'").run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const deleted = changes.filter((c) => c.data == null).length;
    if (deleted) {
      // a deleted newest id can come back, below recentCards' `upTo`, as a card
      this.cardFates.clear();
      this.savedFates.clear();
      this.db.prepare('DELETE FROM card_fates').run();
      this.cardRows.clear();
    }
    return { changed: changes.length - deleted, deleted };
  },

  /** Newest-first messages and Claude output in a project whose raw JSON contains the text (case-insensitive for ASCII). */
  findEvents(this: Store, projectId: number, text: string, limit = 3000, ticketId?: number): EventRow[] {
    // The data is JSON text: a quote, backslash or line break is stored escaped, so the needle is too.
    const like = `%${JSON.stringify(text)
      .slice(1, -1)
      .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(`SELECT e.* FROM events e JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('user_message', 'claude') AND e.data LIKE ? ESCAPE '\\' ${ticketId ? 'AND e.ticket_id = ?' : ''}
        ORDER BY e.id DESC LIMIT ?`)
      .all(projectId, like, ...(ticketId ? [ticketId] : []), limit) as unknown as EventRow[];
  },

  /** PR events already handled for a ticket (keys starting with `prefix`, which is stripped). */
  githubSeen(this: Store, ticketId: number, prefix: string): string[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return (this.db.prepare("SELECT key FROM github_seen WHERE ticket_id = ? AND key LIKE ? ESCAPE '\\'").all(ticketId, like) as { key: string }[]).map((r) => r.key.slice(prefix.length));
  },

  /** Record PR events as handled; `delivered` says whether any were sent to the ticket. */
  addGithubSeen(this: Store, ticketId: number, keys: string[], delivered: boolean) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO github_seen (ticket_id, key, delivered, created_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const k of keys) insert.run(ticketId, k, delivered ? 1 : 0, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /**
   * When a ticket's turns since `since` started and ended: a turn starts with Claude's init event
   * and ends with its result, an error, or a stop or restart note.
   */
  turnMarks(this: Store, ticketId: number, since: number): { at: number; start: boolean }[] {
    const rows = this.db
      .prepare(`SELECT created_at, kind, data FROM events WHERE ticket_id = ? AND created_at >= ? AND (
          (kind = 'claude' AND (data LIKE '{"type":"system","subtype":"init"%' OR data LIKE '{"type":"result"%'))
          OR kind = 'error'
          OR (kind = 'note' AND (data LIKE '{"text":"Stopped by user.%' OR data LIKE '{"text":"The server restarted during this turn%')))
        ORDER BY id`)
      .all(ticketId, since) as { created_at: number; kind: string; data: string }[];
    return rows.map((r) => ({ at: r.created_at, start: r.kind === 'claude' && r.data.startsWith('{"type":"system"') }));
  },

  /** The first event id created at or after `at`, by halving over ids (they grow with time), or one past the last: events has no index on time. */
  eventIdAt(this: Store, at: number): number {
    // Two one-row lookups on the primary key: the one-query MIN(id), MAX(id) scanned the whole events table (0.7-1.3 s of stall).
    const first = this.db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    const last = this.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    if (!first || !last) return 1;
    const ends = { lo: first.id, hi: last.id };
    const next = this.db.prepare('SELECT id, created_at FROM events WHERE id >= ? ORDER BY id LIMIT 1');
    let lo = Number(ends.lo),
      hi = Number(ends.hi) + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = next.get(mid) as { id: number; created_at: number } | undefined;
      if (!row || row.created_at >= at) hi = mid;
      else lo = Number(row.id) + 1;
    }
    return lo;
  },
};
