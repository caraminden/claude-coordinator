// Turns: what each cost, their steps' times, and spend by minion, day and payer (#1313: src/db.ts by area).
import { type FinishedStep, STEP_RATIO, type SpendRowRaw, type Turn, type TurnResult } from '../db-rows.ts';
import type { GruntRow } from '../grunts.ts';
import type { KeepaliveRow } from '../keepalive.ts';
import type { PromptHashes } from '../prompt-hashes.ts';
import { scoped } from '../read-scope.ts';
import { turnRow } from '../turn-row.ts';
import type { Store } from '../db.ts';

export const turnQueries = {
  /**
   * Store a finished turn. Its cost is the session's running total minus the total at the session's
   * previous turn; a total that went down means Claude Code started counting afresh (it restores the
   * running total on --resume only when the session was the last one run in that folder), so the
   * whole total is this turn's.
   */
  async recordTurn(this: Store, ticketId: number, r: TurnResult): Promise<Turn> {
    return turnRow(this.db, ticketId, r);
  },

  /** Keep a turn's Grunts (#948). A Grunt already kept (it was still running at an earlier turn's end) has its calls and cost refreshed, and stays under the turn that first saw it. */
  recordGrunts(this: Store, turnId: number, rows: GruntRow[]) {
    const put = this.db.prepare(`INSERT INTO turn_grunts (agent_id, turn_id, agent_type, model, effort, calls, cost_usd, request_shape, spawn_depth, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET calls = excluded.calls, cost_usd = excluded.cost_usd, model = excluded.model, effort = excluded.effort`);
    for (const g of rows) put.run(g.agent_id, turnId, g.agent_type, g.model, g.effort, g.calls, g.cost_usd, g.request_shape, g.spawn_depth, g.description);
  },

  /** Minions' turns that ended since `since`, oldest first, for the keepalive readout and its miss check (#862). */
  minionTurnsSince(this: Store, since: number): KeepaliveRow[] {
    return this.db
      .prepare(`SELECT t.ticket_id, t.ended_at, t.duration_ms, t.cost_usd, t.input_tokens, t.output_tokens,
          t.cache_read_tokens, t.cache_write_tokens, t.keepalive FROM turns t JOIN tickets k ON k.id = t.ticket_id
          WHERE t.ended_at >= ? AND k.kind != 'coordinator' AND t.side IS NULL ORDER BY t.ended_at, t.id`)
      .all(since) as unknown as KeepaliveRow[];
  },

  /** A minion's latest turns' hash logs (#878), newest first, with how much of each turn's prompt came from the cache. */
  promptHashes(this: Store, ticketId: number, limit = 1): { ended_at: number; cache_read_tokens: number | null; cache_write_tokens: number | null; hashes: PromptHashes }[] {
    const rows = this.db
      .prepare(`SELECT ended_at, cache_read_tokens, cache_write_tokens, prompt_digest FROM turns
        WHERE ticket_id = ? AND prompt_digest IS NOT NULL ORDER BY id DESC LIMIT ?`)
      .all(ticketId, limit) as { ended_at: number; cache_read_tokens: number | null; cache_write_tokens: number | null; prompt_digest: string }[];
    return rows.map(({ prompt_digest, ...r }) => ({ ...r, hashes: JSON.parse(prompt_digest) }));
  },

  /**
   * Fill the turns table from stored result events, for turns from before it existed. Session ids
   * come from each turn's init event. Only runs on an empty table; returns how many turns it added.
   */
  backfillTurns(this: Store): number {
    if (this.db.prepare('SELECT 1 FROM turns LIMIT 1').get()) return 0;
    const rows = this.db
      .prepare(`SELECT id, ticket_id, data, created_at FROM events WHERE kind = 'claude'
          AND (data LIKE '{"type":"system","subtype":"init"%' OR data LIKE '{"type":"result"%') ORDER BY id`)
      .iterate() as Iterable<{ id: number; ticket_id: number; data: string; created_at: number }>;
    const session = new Map<number, string | null>();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const ev = JSON.parse(row.data);
        if (ev.type === 'system') {
          session.set(row.ticket_id, ev.session_id ?? null);
        } else if (typeof ev.total_cost_usd === 'number') {
          turnRow(this.db, row.ticket_id, {
            event_id: row.id,
            session_id: session.get(row.ticket_id) ?? null,
            ended_at: row.created_at,
            session_cost_usd: ev.total_cost_usd,
            duration_ms: ev.duration_ms,
          });
          added++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  },

  /** A ticket's turns, oldest first. */
  listTurns(this: Store, ticketId: number): Turn[] {
    return this.db.prepare('SELECT * FROM turns WHERE ticket_id = ? ORDER BY id').all(ticketId) as unknown as Turn[];
  },

  /** Record finished steps (#571, public/progress.js applyEvent's `finished`); one already recorded (same start) is kept. */
  addStepTimes(this: Store, ticketId: number, steps: FinishedStep[], effort: string | null) {
    if (!steps.length) return;
    const add = this.db.prepare(`INSERT OR IGNORE INTO step_times (ticket_id, task_id, subject, estimate, started_at, finished_at, work_ms, model, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const s of steps) add.run(ticketId, s.id, s.subject, s.estimate, s.startedAt, s.finishedAt, Math.round(s.work), s.model, effort);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /**
   * What steps really took against their guesses (#571): working minutes over guessed minutes, summed over the
   * newest STEP_RATIO.recent finished steps with a guess. The scheme's own once it has STEP_RATIO.scheme of them,
   * else every scheme's, and 1 until there are STEP_RATIO.least anywhere. A sum, not the median step's ratio:
   * that undershoots whole plans (progress-estimates-2026-11 report).
   */
  stepRatio(this: Store, projectId: number): number {
    const sum = (where: string, ...args: number[]) =>
      this.db
        .prepare(`SELECT COUNT(*) AS n, SUM(work_ms) AS work, SUM(estimate) AS guess FROM (
      SELECT s.work_ms, s.estimate FROM step_times s JOIN tickets t ON t.id = s.ticket_id WHERE s.estimate IS NOT NULL ${where}
      ORDER BY s.finished_at DESC LIMIT ${STEP_RATIO.recent})`)
        .get(...args) as { n: number; work: number | null; guess: number | null };
    const own = sum('AND t.project_id = ?', projectId);
    const pick = own.n >= STEP_RATIO.scheme ? own : sum('');
    const ratio = pick.n >= STEP_RATIO.least && pick.guess ? pick.work! / 60_000 / pick.guess : 1;
    return ratio > 0 ? ratio : 1;
  },

  /** When a ticket's last finished turn ended (ms), or null before its first. */
  lastTurnEnd(this: Store, ticketId: number): number | null {
    // A side question's fork (#932) isn't the minion's turn: its prefix may sit on another login, and the minion's own is no warmer for it.
    return scoped(this.db, `last-turn-end:${ticketId}`, () => (this.db.prepare('SELECT ended_at FROM turns WHERE ticket_id = ? AND side IS NULL ORDER BY id DESC LIMIT 1').get(ticketId) as { ended_at: number } | undefined)?.ended_at ?? null);
  },

  /** What a ticket's turns have cost so far; `hostOnly`: the server login's turns only. */
  ticketCost(this: Store, ticketId: number, hostOnly = false): number {
    return scoped(this.db, `cost:${ticketId}:${hostOnly}`, () => (this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE ticket_id = ?${hostOnly ? ' AND payer IS NULL' : ''}`).get(ticketId) as { c: number }).c);
  },

  /**
   * Every closed minion created since `since` that cost anything (open ones are still short of their final cost), every scheme (#1114): its `type` property (null untyped),
   * the model it was set to or last ran on, and what its turns cost. src/minion-budget.ts takes the usual cost from these.
   */
  minionCosts(this: Store, since: number): { type: string | null; model: string | null; cost: number }[] {
    return this.db
      .prepare(`SELECT (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
          WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type,
        coalesce(k.model, k.last_model) AS model, c.cost
      FROM tickets k JOIN (SELECT ticket_id, SUM(cost_usd) AS cost FROM turns GROUP BY ticket_id) c ON c.ticket_id = k.id
      WHERE k.kind = 'ticket' AND k.status = 'closed' AND k.created_at >= ? AND c.cost > 0`)
      .all(since) as unknown as { type: string | null; model: string | null; cost: number }[];
  },

  /** Cost per local day ('2026-10-28') and project, for turns ended at or after `since`; `hostOnly`: the server login's turns only. */
  dailyCosts(this: Store, since: number, hostOnly = false): { day: string; project_id: number; cost: number; turns: number }[] {
    return this.db
      .prepare(`SELECT date(u.ended_at / 1000, 'unixepoch', 'localtime') AS day, t.project_id, SUM(u.cost_usd) AS cost, COUNT(*) AS turns
          FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? ${hostOnly ? 'AND u.payer IS NULL ' : ''}GROUP BY day, t.project_id ORDER BY day`)
      .all(since) as unknown as { day: string; project_id: number; cost: number; turns: number }[];
  },

  /** Spend since `since` by payer (null: the server login) and project, every payer's turns (#689). */
  spendByPayer(this: Store, since: number): { payer: number | null; project_id: number; cost: number }[] {
    return this.db.prepare('SELECT u.payer, t.project_id, SUM(u.cost_usd) AS cost FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? GROUP BY u.payer, t.project_id').all(since) as unknown as { payer: number | null; project_id: number; cost: number }[];
  },

  /** What one payer's turns on one of their accounts cost since `since`; a turn from before #905 kept no account and counts as account 1's. */
  accountSpend(this: Store, payer: number | null, account: number, since: number): number | null {
    // Turns kept no account before #905, so a window holding one of those can't be split by account (keepalive pings keep none, and cost next to nothing).
    if (this.db.prepare('SELECT 1 FROM turns WHERE payer IS ? AND ended_at >= ? AND account IS NULL AND keepalive IS NULL LIMIT 1').get(payer, since)) return null;
    return (this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE payer IS ? AND ended_at >= ? AND ${account === 1 ? '(account IS NULL OR account = 1)' : 'account = ?'}`).get(payer, since, ...(account === 1 ? [] : [account])) as { c: number }).c;
  },

  /**
   * One payer's turns that ended in [since, until), summed in the database to one row per minion, kind of turn and model (#905,
   * #956: all time stays a few thousand rows, never one per turn). Turns from before the split was kept sum under `model` null.
   */
  spendRows(this: Store, payer: number | null, since: number, until: number): SpendRowRaw[] {
    return this.db
      .prepare(`SELECT u.ticket_id, u.keepalive, u.side, k.project_id, k.number, k.title, k.kind, k.created_by,
          coalesce(k.last_model, k.model) AS minion_model, m.model, sum(coalesce(m.cost_usd, u.cost_usd)) AS cost,
          (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
            WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type
        FROM turns u JOIN tickets k ON k.id = u.ticket_id LEFT JOIN turn_models m ON m.turn_id = u.id
        WHERE u.ended_at >= ? AND u.ended_at < ? AND u.payer IS ?
        GROUP BY u.ticket_id, u.keepalive, u.side, m.model`)
      .all(since, until, payer) as unknown as SpendRowRaw[];
  },

  /** What every payer's Fable turns cost since `since` (#1061), from the per-model split, so turns before it was kept count for nothing. */
  fableSpend(this: Store, since: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(m.cost_usd), 0) AS c FROM turn_models m JOIN turns u ON u.id = m.turn_id WHERE u.ended_at >= ? AND m.model LIKE '%fable%'").get(since) as { c: number }).c;
  },
};
