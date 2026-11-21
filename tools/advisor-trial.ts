#!/usr/bin/env node
// The advisor trial's numbers (#817): turns on Sonnet with an Opus advisor against Sonnet-medium ones.
// Reads the database read-only and prints markdown, for the trial report in the shared folder's reports/.
//
//   node tools/advisor-trial.ts [--since 2026-11-16] [--db <path>]
//
// Each turn counts by the model it really ran on, its own `init` event, not the minion's setting now.
// A trial minion is one set to claude-sonnet-5-5+opus-advisor now or that consulted at least once; its
// Sonnet turns are the trial's, and its turns on another model are escalations (moved off it). The
// baseline is the window's Sonnet turns of every other minion now set to medium effort (no turn records its
// effort). A consult is a `server_tool_use` block named `advisor` (slimEvent keeps them; usage.iterations is
// dropped). turns.cost_usd includes the advisor's cost. Self-review findings, failed lands and redo minions
// aren't in the database: read the trial minions' chats for those.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { attachEventsIfThere } from '../src/events-db.ts';

export const ADVISED = 'claude-sonnet-5-5+opus-advisor';
const SONNET = 'claude-sonnet-5-5';

export interface TurnRow { ticket: number; cost: number; model: string | null; consults: number }
export interface Totals { minions: number; turns: number; cost: number; consults: number; over3: number }

/** Every minion turn ended since `since`, with the model its init event named and its advisor consults. */
export function trialTurns(db: DatabaseSync, since: number): TurnRow[] {
  const turns = db.prepare(`SELECT t.ticket_id, t.event_id, t.cost_usd FROM turns t JOIN tickets k ON k.id = t.ticket_id
    WHERE t.ended_at >= ? AND k.kind != 'coordinator' ORDER BY t.ticket_id, t.id`).all(since) as { ticket_id: number; event_id: number | null; cost_usd: number }[];
  const out: TurnRow[] = [];
  let ticket = -1;
  let from = 0;
  for (const t of turns) {
    if (t.ticket_id !== ticket) {
      ticket = t.ticket_id;
      from = (db.prepare('SELECT COALESCE(MAX(event_id), 0) AS e FROM turns WHERE ticket_id = ? AND ended_at < ?').get(ticket, since) as { e: number }).e;
    }
    const to = t.event_id ?? Number.MAX_SAFE_INTEGER;
    const events = db.prepare(`SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' AND id > ? AND id <= ?
      AND (data LIKE '%"subtype":"init"%' OR (data LIKE '%server_tool_use%' AND data LIKE '%"advisor"%')) ORDER BY id`).all(ticket, from, to) as { data: string }[];
    let model: string | null = null;
    let consults = 0;
    for (const e of events) {
      const ev = JSON.parse(e.data);
      if (ev.type === 'system' && ev.subtype === 'init') model = ev.model ?? null;
      else consults += (ev.message?.content ?? []).filter((b: any) => b?.type === 'server_tool_use' && b.name === 'advisor').length;
    }
    out.push({ ticket, cost: t.cost_usd, model, consults });
    if (t.event_id) from = t.event_id;
  }
  return out;
}

/** The trial's minions and turns, its escalations, and the Sonnet-medium baseline. */
export function trialNumbers(db: DatabaseSync, since: number) {
  const rows = trialTurns(db, since);
  const settings = new Map((db.prepare('SELECT id, model, effort FROM tickets').all() as { id: number; model: string | null; effort: string | null }[]).map((t) => [t.id, t]));
  const trialIds = new Set(rows.filter((r) => r.consults || settings.get(r.ticket)?.model === ADVISED).map((r) => r.ticket));
  const sum = (list: TurnRow[]): Totals => ({
    minions: new Set(list.map((r) => r.ticket)).size, turns: list.length, cost: list.reduce((s, r) => s + r.cost, 0),
    consults: list.reduce((s, r) => s + r.consults, 0), over3: list.filter((r) => r.consults > 3).length,
  });
  const trial = rows.filter((r) => trialIds.has(r.ticket) && r.model === SONNET);
  return {
    trial: sum(trial),
    escalated: sum(rows.filter((r) => trialIds.has(r.ticket) && r.model !== SONNET)),
    baseline: sum(rows.filter((r) => !trialIds.has(r.ticket) && r.model === SONNET && settings.get(r.ticket)?.effort === 'medium')),
    perMinion: [...trialIds].map((id) => ({ id, ...sum(trial.filter((r) => r.ticket === id)), max: Math.max(0, ...trial.filter((r) => r.ticket === id).map((r) => r.consults)), escalated: rows.some((r) => r.ticket === id && r.model !== SONNET) })),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { since: { type: 'string', default: '2026-11-16' }, db: { type: 'string' } } });
  const dataDir = process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator');
  const dbFile = values.db ?? join(dataDir, 'coordinator.db');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  attachEventsIfThere(db, dbFile);
  // Midnight Pacific on the day given (PST is UTC-8; the trial runs in November).
  const since = Date.parse(`${values.since}T08:00:00Z`);
  if (Number.isNaN(since)) throw new Error(`--since wants a date like 2026-11-16, not ${values.since}`);
  const n = trialNumbers(db, since);
  const names = new Map((db.prepare('SELECT t.id, t.number, t.title, t.model, t.effort, p.name AS scheme FROM tickets t JOIN projects p ON p.id = t.project_id').all() as any[]).map((t) => [t.id, t]));
  const money = (x: number) => `$${x.toFixed(2)}`;
  const per = (a: number, b: number) => (b ? a / b : 0);
  const out = [`# Advisor trial numbers since ${values.since} (PST)`, '',
    '| | minions | turns | cost a turn | consults a turn | turns over 3 consults | total |', '|---|---|---|---|---|---|---|',
    `| Sonnet + Opus advisor | ${n.trial.minions} | ${n.trial.turns} | ${money(per(n.trial.cost, n.trial.turns))} | ${per(n.trial.consults, n.trial.turns).toFixed(2)} | ${n.trial.over3} | ${money(n.trial.cost)} |`,
    `| their turns after moving off Sonnet | ${n.escalated.minions} | ${n.escalated.turns} | ${money(per(n.escalated.cost, n.escalated.turns))} | – | – | ${money(n.escalated.cost)} |`,
    `| Sonnet, minions now at medium, no advisor | ${n.baseline.minions} | ${n.baseline.turns} | ${money(per(n.baseline.cost, n.baseline.turns))} | – | – | ${money(n.baseline.cost)} |`,
    '', '## Trial minions', '', '| minion | setting now | Sonnet turns | cost a turn | consults (a turn) | max in a turn | moved off |', '|---|---|---|---|---|---|---|'];
  for (const m of n.perMinion) {
    const t = names.get(m.id);
    out.push(`| ${t.scheme} #${t.number} ${String(t.title).replaceAll('|', '/')} | ${t.model ?? 'default'} ${t.effort ?? ''} | ${m.turns} | ${money(per(m.cost, m.turns))} | ${m.consults} (${per(m.consults, m.turns).toFixed(2)}) | ${m.max} | ${m.escalated ? 'yes' : ''} |`);
  }
  if (!n.perMinion.length) out.push('| none yet | | | | | | |');
  console.log(out.join('\n'));
}
