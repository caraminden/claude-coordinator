// One turn's row (#1877): what a result event says as a TurnResult, and its write, outside src/db.ts so the Store method and
// backfillTurns share it.
import type { DatabaseSync } from 'node:sqlite';
import type { Turn, TurnResult } from './db-rows.ts';
import type { ClaudeEvent } from './claude-events.ts';
import type { SpendState } from './spend-alert.ts';

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

/** Ends that leave claude no chance to save what its session cost: SIGKILL, SIGABRT, SIGSEGV, SIGBUS. On SIGTERM it saves, and the resumed session's total has it. */
const UNSAVED = [137, 134, 139, 135, 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS'];

/** What a turn that died unsaved had spent since its last result, by model (#1938); null when there is nothing to count. `exit` null: killed with its wrapper, which outlives a SIGTERM. */
export function killedSpend(turn: { spend?: SpendState } | null | undefined, exit: { code: number | null; signal: string | null; error?: string } | null): Record<string, number> | null {
  if (exit && !UNSAVED.includes(exit.code ?? '') && !UNSAVED.includes(exit.signal ?? '')) return null;
  const open = Object.entries(turn?.spend?.open ?? {}).filter(([, usd]) => Number.isFinite(usd) && usd > 0);
  return open.length ? Object.fromEntries(open) : null;
}

/** recordTurn's write, run at once: backfillTurns runs it in its own transaction. */
export function turnRow(db: DatabaseSync, ticketId: number, r: TurnResult): Turn {
  const last = (side: boolean, session?: string | null) =>
    db.prepare(`SELECT id, session_id, session_cost_usd FROM turns WHERE ticket_id = ? AND side IS ?${session ? ' AND session_id = ?' : ''} ORDER BY id DESC LIMIT 1`).get(ticketId, side ? 1 : null, ...(session ? [session] : [])) as { id: number; session_id: string | null; session_cost_usd: number } | undefined;
  // A side thread's turns follow its own fork's (threads interleave); the fork's first starts from its parent's total.
  const prev = r.side && r.session_id ? (last(true, r.session_id) ?? (r.fork_of ? last(false, r.fork_of) : undefined)) : last(!!r.side);
  const sameSession = (prev && (prev.session_id ?? null) === (r.session_id ?? null)) || (r.side && !!r.fork_of && prev?.session_id === r.fork_of);
  const base = sameSession && (r.estimate || prev.session_cost_usd <= r.session_cost_usd) ? prev.session_cost_usd : 0;
  const total = r.estimate ? base : r.session_cost_usd;
  const guess = Object.entries(r.estimate ?? {});
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
      r.estimate ? guess.reduce((a, [, usd]) => a + usd, 0) : total - base,
      total,
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
  if (r.estimate && !unsplit) {
    const had = base > 0 ? (db.prepare('SELECT model, session_cost_usd FROM turn_models WHERE turn_id = ?').all(prev!.id) as { model: string; session_cost_usd: number }[]) : [];
    const run = new Map([...guess.map(([model]) => [model.slice(0, 100), 0] as const), ...had.map((m) => [m.model, m.session_cost_usd] as const)]);
    for (const [model, was] of run) add.run(row.id, model, r.estimate[model] ?? 0, was);
  }
  const sum = totals.reduce((a, [, t]) => a + t, 0);
  for (const [model, total] of totals) {
    const before = base > 0 && !unsplit ? ((was.get(prev!.id, model) as { session_cost_usd: number } | undefined)?.session_cost_usd ?? 0) : 0;
    add.run(row.id, model, unsplit ? (sum ? (row.cost_usd * total) / sum : 0) : before <= total ? total - before : total, total);
  }
  return row;
}
