// One turn's row (#1877): what a result event says as a TurnResult, and its write, outside src/db.ts so the Store method and
// backfillTurns share it.
import type { DatabaseSync } from 'node:sqlite';
import type { Turn, TurnResult } from './db-rows.ts';
import type { ClaudeEvent } from './claude-events.ts';

/** The fields of a TurnResult its result event holds. */
export function turnOf(ev: ClaudeEvent) {
  return {
    session_id: typeof ev.session_id === 'string' ? ev.session_id : null,
    session_cost_usd: ev.total_cost_usd!,
    duration_ms: ev.duration_ms,
    usage: ev.usage,
    modelUsage: ev.modelUsage,
  };
}

/** recordTurn's write, run at once: backfillTurns runs it in its own transaction. */
export function turnRow(db: DatabaseSync, ticketId: number, r: TurnResult): Turn {
  const last = (side: boolean, session?: string | null) =>
    db.prepare(`SELECT id, session_id, session_cost_usd FROM turns WHERE ticket_id = ? AND side IS ?${session ? ' AND session_id = ?' : ''} ORDER BY id DESC LIMIT 1`).get(ticketId, side ? 1 : null, ...(session ? [session] : [])) as { id: number; session_id: string | null; session_cost_usd: number } | undefined;
  // A side thread's turns follow its own fork's (threads interleave); the fork's first starts from its parent's total.
  const prev = r.side && r.session_id ? (last(true, r.session_id) ?? (r.fork_of ? last(false, r.fork_of) : undefined)) : last(!!r.side);
  const sameSession = (prev && (prev.session_id ?? null) === (r.session_id ?? null)) || (r.side && !!r.fork_of && prev?.session_id === r.fork_of);
  const base = sameSession && prev.session_cost_usd <= r.session_cost_usd ? prev.session_cost_usd : 0;
  const u = r.usage ?? null;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  const row = db
    .prepare(`INSERT INTO turns (ticket_id, event_id, session_id, ended_at, cost_usd, session_cost_usd, duration_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, payer, keepalive, account, prompt_digest, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(
      ticketId,
      r.event_id ?? null,
      r.session_id ?? null,
      r.ended_at,
      r.session_cost_usd - base,
      r.session_cost_usd,
      n(r.duration_ms),
      n(u?.input_tokens),
      n(u?.output_tokens),
      n(u?.cache_read_input_tokens),
      n(u?.cache_creation_input_tokens),
      r.payer ?? null,
      r.keepalive ? 1 : null,
      n(r.account),
      r.hashes ? JSON.stringify(r.hashes) : null,
      r.side ? 1 : null,
    ) as unknown as Turn;
  // Each model's running total, less its total at the session's previous turn, as the whole turn's cost is (#905).
  const models = r.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage) : [];
  const was = db.prepare('SELECT session_cost_usd FROM turn_models WHERE turn_id = ? AND model = ?');
  const add = db.prepare('INSERT INTO turn_models (turn_id, model, cost_usd, session_cost_usd) VALUES (?, ?, ?, ?)');
  const totals = models.flatMap(([model, m]) => {
    const total = m?.costUSD;
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 && model ? [[model.slice(0, 100), total] as const] : [];
  });
  // The session's previous turn ran before the split was kept: its share of each model is unknown, so split this turn's cost pro rata.
  const unsplit = base > 0 && !db.prepare('SELECT 1 FROM turn_models WHERE turn_id = ?').get(prev!.id);
  const sum = totals.reduce((a, [, t]) => a + t, 0);
  for (const [model, total] of totals) {
    const before = base > 0 && !unsplit ? ((was.get(prev!.id, model) as { session_cost_usd: number } | undefined)?.session_cost_usd ?? 0) : 0;
    add.run(row.id, model, unsplit ? (sum ? (row.cost_usd * total) / sum : 0) : before <= total ? total - before : total, total);
  }
  return row;
}
