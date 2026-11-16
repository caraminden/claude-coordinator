#!/usr/bin/env node
// The advisor trial's numbers (#817): minions on Sonnet with an Opus advisor against Sonnet-medium ones.
// Reads the database read-only and prints markdown, for the trial report in the shared folder's reports/.
//
//   node tools/advisor-trial.ts [--since 2026-11-16] [--db <path>]
//
// A trial minion is one whose model is claude-sonnet-5-5+opus-advisor now, or that consulted the advisor at least
// once (so one moved off it still counts; its later turns count too). The baseline is the same window's turns of
// minions on claude-sonnet-5-5 at medium that never consulted. A consult is a `server_tool_use` block named
// `advisor` in the turn's events (slimEvent keeps them; usage.iterations is dropped). turns.cost_usd includes
// the advisor's own cost. Self-review findings, failed lands and redo minions aren't in the database: read
// the trial minions' chats for those.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ADVISED = 'claude-sonnet-5-5+opus-advisor';
const { values } = parseArgs({ options: { since: { type: 'string', default: '2026-11-16' }, db: { type: 'string' } } });
const dataDir = process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator');
const db = new DatabaseSync(values.db ?? join(dataDir, 'coordinator.db'), { readOnly: true });
// Midnight Pacific on the day given (PST is UTC-8; the trial runs in November).
const since = Date.parse(`${values.since}T08:00:00Z`);
if (Number.isNaN(since)) throw new Error(`--since wants a date like 2026-11-16, not ${values.since}`);

type Turn = { id: number; ticket_id: number; event_id: number | null; cost_usd: number };
const turns = db.prepare('SELECT id, ticket_id, event_id, cost_usd FROM turns WHERE ended_at >= ? ORDER BY ticket_id, id').all(since) as Turn[];
const tickets = new Map((db.prepare('SELECT t.id, t.number, t.title, t.model, t.effort, t.kind, p.name AS scheme FROM tickets t JOIN projects p ON p.id = t.project_id').all() as any[]).map((t) => [t.id, t]));

/** Advisor consults in each turn: blocks in the events after the ticket's previous turn, up to its own result event. */
const consultsOf = (() => {
  const rows = db.prepare(`SELECT id, ticket_id, data FROM events WHERE kind = 'claude' AND created_at >= ? AND data LIKE '%server_tool_use%' AND data LIKE '%"advisor"%'`).all(since - 86_400_000) as { id: number; ticket_id: number; data: string }[];
  const at = new Map<number, number[]>();
  for (const r of rows) {
    const n = (JSON.parse(r.data).message?.content ?? []).filter((b: any) => b?.type === 'server_tool_use' && b.name === 'advisor').length;
    if (!at.has(r.ticket_id)) at.set(r.ticket_id, []);
    for (let i = 0; i < n; i++) at.get(r.ticket_id)!.push(r.id);
  }
  return at;
})();

const byTicket = new Map<number, { turn: Turn; consults: number }[]>();
const prev = new Map<number, number>();
for (const t of turns) {
  const from = prev.get(t.ticket_id) ?? (db.prepare('SELECT COALESCE(MAX(event_id), 0) AS e FROM turns WHERE ticket_id = ? AND ended_at < ?').get(t.ticket_id, since) as { e: number }).e;
  const to = t.event_id ?? Infinity;
  const consults = (consultsOf.get(t.ticket_id) ?? []).filter((e) => e > from && e <= to).length;
  if (t.event_id) prev.set(t.ticket_id, t.event_id);
  byTicket.set(t.ticket_id, [...(byTicket.get(t.ticket_id) ?? []), { turn: t, consults }]);
}

const trial: number[] = [];
const baseline: number[] = [];
for (const [id, list] of byTicket) {
  const t = tickets.get(id);
  if (!t || t.kind === 'coordinator') continue;
  if (t.model === ADVISED || list.some((x) => x.consults)) trial.push(id);
  else if (t.model === 'claude-sonnet-5-5' && t.effort === 'medium') baseline.push(id);
}

const money = (n: number) => `$${n.toFixed(2)}`;
function sum(ids: number[]) {
  const all = ids.flatMap((id) => byTicket.get(id)!);
  const cost = all.reduce((s, x) => s + x.turn.cost_usd, 0);
  const consults = all.reduce((s, x) => s + x.consults, 0);
  return { minions: ids.length, turns: all.length, cost, perTurn: all.length ? cost / all.length : 0, consults, consultsPerTurn: all.length ? consults / all.length : 0, over3: all.filter((x) => x.consults > 3).length };
}

const out: string[] = [`# Advisor trial numbers since ${values.since} (PST)`, ''];
const a = sum(trial);
const b = sum(baseline);
out.push('| | minions | turns | cost a turn | consults a turn | turns over 3 consults | total |', '|---|---|---|---|---|---|---|');
out.push(`| Sonnet + Opus advisor | ${a.minions} | ${a.turns} | ${money(a.perTurn)} | ${a.consultsPerTurn.toFixed(2)} | ${a.over3} | ${money(a.cost)} |`);
out.push(`| Sonnet medium, no advisor | ${b.minions} | ${b.turns} | ${money(b.perTurn)} | – | – | ${money(b.cost)} |`);
out.push('', '## Trial minions', '', '| minion | model now | turns | cost a turn | consults (a turn) | max in a turn |', '|---|---|---|---|---|---|');
for (const id of trial) {
  const t = tickets.get(id);
  const s = sum([id]);
  const max = Math.max(...byTicket.get(id)!.map((x) => x.consults));
  out.push(`| ${t.scheme} #${t.number} ${t.title.replaceAll('|', '/')} | ${t.model ?? 'default'} ${t.effort ?? ''} | ${s.turns} | ${money(s.perTurn)} | ${s.consults} (${s.consultsPerTurn.toFixed(2)}) | ${max} |`);
}
if (!trial.length) out.push('| none yet | | | | | |');
out.push('', 'A trial minion whose model now is not the advisor was moved off it: read its chat for why.');
console.log(out.join('\n'));
