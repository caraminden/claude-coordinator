#!/usr/bin/env node
// The standing tier scorecard (#1107): per type of work and per model and effort, what minions cost and how
// often they needed a second go. Reads the database read-only and writes a dated markdown table.
//
//   node tools/tier-scorecard.ts [--days 28] [--db <path>] [--out <file>|-]
//
// The default output is reports/tier-scorecard-<date>.md in the shared folder (the same file again the same day).
// Run it weekly and before every tier review (schedule 19). A turn run from a container can't open the live
// database: run it on the host, or pass --db with a copy.
//
// A row is a minion created in the window, grouped by its `type` property and the model and effort it ran on
// (last_model/last_effort when it was never set). Every column's query is in COLUMNS below, so a number can be
// checked by hand. What the columns can and can't see:
//  - cost: every turn of the minion, as the database priced it (list price).
//  - reopens: a person's message after the minion was dismissed (dismissals leave a "dismissed this minion" note;
//    nothing else records a reopen). Counts minions, not messages.
//  - failed ships: Citadel's "land didn't go through" message to the minion, counted per message.
//  - strikes: strike events in the minion's chat (text a person struck out of its words), counted per strike.
//  - step-ups / person changes: the "<who> set this minion to <model|effort>" notes (one per change, so a model and
//    an effort change are two), split into a Taskmaster's and a person's. Grunts and the advisor billing other models
//    are not changes (#1720). A minion's own change ("Claude set") counts in neither.
// Not here yet: which step-up reasons held up (A4's reasons are not stored), and Grunts' own spend.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { attachEventsIfThere } from '../src/events-db.ts';

export interface Column {
  name: string;
  note: string;
  sql: string;
}

/** Each query takes :since (ms) and returns (ticket, n): one number per minion created since then. */
export const COLUMNS: Column[] = [
  {
    name: 'cost',
    note: 'USD, all turns',
    sql: `SELECT t.ticket_id AS ticket, sum(t.cost_usd) AS n FROM turns t
          JOIN tickets k ON k.id = t.ticket_id WHERE k.created_at >= :since GROUP BY t.ticket_id`,
  },
  {
    name: 'reopens',
    note: 'person wrote after it was dismissed',
    sql: `SELECT d.ticket_id AS ticket, 1 AS n FROM events d JOIN tickets k ON k.id = d.ticket_id
          WHERE k.created_at >= :since AND d.kind = 'note' AND d.data LIKE '%dismissed this minion%'
            AND EXISTS (SELECT 1 FROM events m WHERE m.ticket_id = d.ticket_id AND m.kind = 'user_message' AND m.id > d.id)
          GROUP BY d.ticket_id`,
  },
  {
    name: 'failed ships',
    note: "land.sh's failure messages",
    sql: `SELECT e.ticket_id AS ticket, count(*) AS n FROM events e JOIN tickets k ON k.id = e.ticket_id
          WHERE k.created_at >= :since AND e.kind = 'user_message' AND e.data LIKE '%land didn''t go through%'
          GROUP BY e.ticket_id`,
  },
  {
    name: 'strikes',
    note: 'struck-out text',
    sql: `SELECT e.ticket_id AS ticket, count(*) AS n FROM events e JOIN tickets k ON k.id = e.ticket_id
          WHERE k.created_at >= :since AND e.kind = 'strike' GROUP BY e.ticket_id`,
  },
  {
    name: 'step-ups',
    note: 'a Taskmaster set its model or effort',
    sql: `SELECT e.ticket_id AS ticket, count(*) AS n FROM events e JOIN tickets k ON k.id = e.ticket_id
          WHERE k.created_at >= :since AND e.kind = 'note' AND e.data LIKE '%"text":"Taskmaster set this minion to %'
          GROUP BY e.ticket_id`,
  },
  {
    name: 'person changes',
    note: 'a person set its model or effort',
    sql: `SELECT e.ticket_id AS ticket, count(*) AS n FROM events e JOIN tickets k ON k.id = e.ticket_id
          WHERE k.created_at >= :since AND e.kind = 'note' AND e.data LIKE '%"text":"% set this minion to %'
            AND e.data NOT LIKE '%"text":"Taskmaster set this minion to %' AND e.data NOT LIKE '%"text":"Claude set this minion to %'
          GROUP BY e.ticket_id`,
  },
];

/** One row per minion created since :since: its type and tier. */
export const MINIONS_SQL = `
  SELECT k.id AS ticket,
         coalesce((SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
                   WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1), 'untyped') AS type,
         coalesce(k.model, k.last_model, 'default') AS model,
         coalesce(k.effort, k.last_effort, pr.default_effort, 'default') AS effort
  FROM tickets k LEFT JOIN projects pr ON pr.id = k.project_id
  WHERE k.created_at >= :since AND k.kind = 'ticket'`;

export interface Row {
  type: string;
  tier: string;
  minions: number;
  cost: number;
  counts: Record<string, number>;
}

export function collect(db: DatabaseSync, sinceMs: number): Row[] {
  const rows = new Map<string, Row>();
  const of = new Map<number, Row>();
  for (const m of db.prepare(MINIONS_SQL).all({ since: sinceMs }) as { ticket: number; type: string; model: string; effort: string }[]) {
    const tier = `${m.model.replace(/^claude-/, '')} ${m.effort}`;
    const key = `${m.type}\u0000${tier}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { type: m.type, tier, minions: 0, cost: 0, counts: Object.fromEntries(COLUMNS.slice(1).map((c) => [c.name, 0])) }));
    r.minions++;
    of.set(m.ticket, r);
  }
  for (const c of COLUMNS) {
    for (const x of db.prepare(c.sql).all({ since: sinceMs }) as { ticket: number; n: number }[]) {
      const r = of.get(x.ticket);
      if (!r) continue;
      if (c.name === 'cost') r.cost += x.n;
      else r.counts[c.name] += x.n;
    }
  }
  return [...rows.values()].sort((a, b) => a.type.localeCompare(b.type) || b.minions - a.minions);
}

export function render(rows: Row[], date: string, days: number): string {
  const head = ['Type', 'Model and effort', 'Minions', '$ total', '$ per minion', ...COLUMNS.slice(1).map((c) => c.name)];
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  const body = rows.map((r) => line([r.type, r.tier, r.minions, r.cost.toFixed(0), (r.cost / r.minions).toFixed(2), ...COLUMNS.slice(1).map((c) => r.counts[c.name])]));
  return [
    `# Tier scorecard (${date})`,
    '',
    `Minions created in the ${days} days to ${date}, by type and the model and effort they ran on. Rebuilt with \`node tools/tier-scorecard.ts\` (#1107); the schedule 19 tier review starts from this table.`,
    '',
    line(head),
    line(head.map(() => '---')),
    ...body,
    '',
    '## What each column counts',
    '',
    ...COLUMNS.map((c) => `- **${c.name}** (${c.note}):\n  \`\`\`sql\n  ${c.sql.replace(/\s+/g, ' ').trim()}\n  \`\`\``),
    '- **Minions / type / tier**:\n  ```sql\n  ' + MINIONS_SQL.replace(/\s+/g, ' ').trim() + '\n  ```',
    '',
    '## Read it with care',
    '',
    '- Harder work goes to higher tiers, so a dearer tier is not a worse choice by itself: compare within a type, and look at reopens and failed ships before cost.',
    '- Small rows (a handful of minions) are noise.',
    "- Not counted yet: which step-up reasons held up (the reasons are not stored), and Grunts' own spend.",
    '',
  ].join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: 'string', default: '28' }, db: { type: 'string' }, out: { type: 'string' } } });
  const days = Number(values.days);
  const dbPath = values.db ?? join(process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator'), 'coordinator.db');
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}: run this on the host, or pass --db.`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  attachEventsIfThere(db, dbPath);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const md = render(collect(db, Date.now() - days * 86400_000), date, days);
  const out = values.out ?? join(homedir(), '.local/share/claude-coordinator/projects/2/shared/project/reports', `tier-scorecard-${date}.md`);
  if (out === '-') process.stdout.write(md);
  else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    console.log(`Wrote ${out}`);
  }
}
