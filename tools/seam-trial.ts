#!/usr/bin/env node
// The fresh-sessions-at-seams trial's readout (#1129): the fresh group against the control group, each minion counted
// from the moment it was enrolled (its turn ended past 150k of context). Reads the database read-only.
//
//   node tools/seam-trial.ts [--db <path>] [--out <file>|-]
//
// The default output is reports/seam-trial-<date>.md in the shared folder. A turn run from a container can't open
// the live database: run it on the host, or pass --db with a copy. The numbers go on a card before anything goes wider.
// Every metric's query is in METRICS below, so a number can be checked by hand; reopens, strikes and failed ships
// are the tier scorecard's (tools/tier-scorecard.ts), limited to after enrolment.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { SEAM_TRIAL_KEY, SEAM_WHY, type Arm, type Enrolled, type SeamTrial } from '../src/seam-trial.ts';
import { attachEventsIfThere } from '../src/events-db.ts';

/** A person telling a minion it already had the answer: "I already said", "as I told you", "you asked me that". */
export const ALREADY = /\b(already|just) (said|told|asked|answered|gave|decided|picked|explained)\b|\bas I (said|told you|mentioned)\b|\byou (already )?asked (me )?(that|this) (before|already)\b|\bI told you\b/i;

export interface Metric { name: string; note: string; sql?: string }

/** Each query takes :id and :at (the enrolment) and returns n for that minion. */
export const METRICS: Metric[] = [
  { name: 'dismissed', note: 'closed now', sql: `SELECT (status = 'closed') AS n FROM tickets WHERE id = :id` },
  { name: 'cost after enrolment', note: 'USD, turns that ended after it',
    sql: `SELECT coalesce(sum(cost_usd), 0) AS n FROM turns WHERE ticket_id = :id AND ended_at >= :at` },
  { name: 'cache reads after enrolment', note: 'millions of tokens re-read',
    sql: `SELECT coalesce(sum(cache_read_tokens), 0) / 1e6 AS n FROM turns WHERE ticket_id = :id AND ended_at >= :at` },
  { name: 'turns after enrolment', note: 'turns that ended after it',
    sql: `SELECT count(*) AS n FROM turns WHERE ticket_id = :id AND ended_at >= :at` },
  { name: 'seam fresh starts', note: 'handoffs at a seam it picked',
    sql: `SELECT count(*) AS n FROM events WHERE ticket_id = :id AND created_at >= :at AND kind = 'fresh' AND json_extract(data, '$.why') = '${SEAM_WHY}'` },
  { name: 'other fresh starts', note: "a person's /fresh",
    sql: `SELECT count(*) AS n FROM events WHERE ticket_id = :id AND created_at >= :at AND kind = 'fresh' AND coalesce(json_extract(data, '$.why'), '') <> '${SEAM_WHY}'` },
  { name: 'compactions', note: "Claude Code's own, after enrolment",
    sql: `SELECT count(*) AS n FROM events WHERE ticket_id = :id AND created_at >= :at AND kind = 'claude' AND data LIKE '%compact_boundary%'` },
  { name: 'reopens', note: 'a person wrote after a dismissal',
    sql: `SELECT count(*) AS n FROM events d WHERE d.ticket_id = :id AND d.created_at >= :at AND d.kind = 'note' AND d.data LIKE '%dismissed this minion%'
            AND EXISTS (SELECT 1 FROM events m WHERE m.ticket_id = d.ticket_id AND m.kind = 'user_message' AND m.id > d.id)` },
  { name: 'strikes', note: 'struck-out text',
    sql: `SELECT count(*) AS n FROM events WHERE ticket_id = :id AND created_at >= :at AND kind = 'strike'` },
  { name: 'failed ships', note: "land.sh's failure messages",
    sql: `SELECT count(*) AS n FROM events WHERE ticket_id = :id AND created_at >= :at AND kind = 'user_message' AND data LIKE '%land didn''t go through%'` },
  { name: '"already asked"', note: 'a person saying it already had the answer (ALREADY)' },
];

/** People's own messages after enrolment: not relays, held mail or the server's. */
const PEOPLE_SQL = `SELECT data FROM events WHERE ticket_id = :id AND created_at >= :at AND kind = 'user_message'`;
const machine = /^(system|citadel|github|mandate|taskmaster|#)/i;

export function alreadyAsked(db: DatabaseSync, e: Enrolled): number {
  let n = 0;
  for (const { data } of db.prepare(PEOPLE_SQL).all({ id: e.id, at: e.at }) as { data: string }[]) {
    try {
      const d = JSON.parse(data);
      if (typeof d.text === 'string' && d.author && !d.from && !d.mail && !machine.test(d.author) && ALREADY.test(d.text)) n++;
    } catch { /* not JSON: not a person's message */ }
  }
  return n;
}

function metric(db: DatabaseSync, sql: string, e: Enrolled): number {
  const st = db.prepare(sql);
  st.setAllowUnknownNamedParameters(true); // not every query uses :at
  return Number((st.get({ id: e.id, at: e.at }) as { n: number } | undefined)?.n ?? 0);
}

export interface MinionRow { arm: Arm; id: number; number: number | null; scheme: string; title: string; context: number; values: Record<string, number> }

export function collect(db: DatabaseSync, trial: SeamTrial): MinionRow[] {
  const rows: MinionRow[] = [];
  for (const arm of ['fresh', 'control'] as const) {
    for (const e of trial[arm]) {
      const t = db.prepare(`SELECT k.number, k.title, p.name AS scheme FROM tickets k LEFT JOIN projects p ON p.id = k.project_id WHERE k.id = ?`).get(e.id) as { number: number | null; title: string; scheme: string } | undefined;
      const values: Record<string, number> = {};
      for (const m of METRICS) values[m.name] = m.sql ? metric(db, m.sql, e) : alreadyAsked(db, e);
      rows.push({ arm, id: e.id, number: t?.number ?? null, scheme: t?.scheme ?? '?', title: t?.title ?? '(gone)', context: e.context, values });
    }
  }
  return rows;
}

const fmt = (m: Metric, v: number) => (m.name.startsWith('cost') ? `$${v.toFixed(2)}` : m.name.startsWith('cache') ? v.toFixed(1) : String(Math.round(v * 100) / 100));

export function render(trial: SeamTrial, rows: MinionRow[], date: string): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  const of = (arm: Arm) => rows.filter((r) => r.arm === arm);
  const total = (arm: Arm, m: Metric) => of(arm).reduce((a, r) => a + r.values[m.name], 0);
  const per = (arm: Arm, m: Metric) => (of(arm).length ? total(arm, m) / of(arm).length : 0);
  const summary = METRICS.map((m) => line([`${m.name} (${m.note})`, ...(['fresh', 'control'] as const).flatMap((a) => [fmt(m, total(a, m)), fmt(m, per(a, m))])]));
  const head = ['Group', 'Minion', 'Scheme', 'Context at enrolment', ...METRICS.map((m) => m.name)];
  const body = rows.map((r) => line([r.arm, `#${r.number ?? '?'} ${r.title.replace(/\|/g, '/').slice(0, 50)}`, r.scheme, `${Math.round(r.context / 1000)}k`, ...METRICS.map((m) => fmt(m, r.values[m.name]))]));
  const pacific = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
  return [
    `# Fresh sessions at seams: trial readout (${date})`,
    '',
    `Minions of every scheme whose turn ended past 150k of context, enrolled from ${pacific(trial.since)} PT${trial.full ? ` until both groups filled at ${pacific(trial.full)} PT` : ' (still enrolling)'}, alternately into the fresh group (told to hand off at a seam and carry on fresh) and the control group (carried on as before). Everything is counted from each minion's enrolment. Rebuilt with \`node tools/seam-trial.ts\` (#1129).`,
    '',
    line(['Metric', 'Fresh: total', 'Fresh: per minion', 'Control: total', 'Control: per minion']), line(['---', '---', '---', '---', '---']),
    line(['minions', of('fresh').length, '', of('control').length, '']),
    ...summary,
    '',
    '## Per minion',
    '',
    line(head), line(head.map(() => '---')), ...body,
    '',
    '## Read it with care',
    '',
    '- 20 against 20 is small: one runaway minion moves a group\'s cost. Look at the per-minion rows before the totals.',
    '- A minion still open is counted so far; rerun once most are dismissed.',
    '- "Already asked" is a phrase match on people\'s messages (ALREADY in the script): read the hits before trusting the count.',
    '- The fresh group\'s first turn after enrolment re-reads its context once more (its tool list changed), a one-off cost.',
    '',
  ].join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { db: { type: 'string' }, out: { type: 'string' } } });
  const dbPath = values.db ?? join(process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator'), 'coordinator.db');
  if (!existsSync(dbPath)) { console.error(`No database at ${dbPath}: run this on the host, or pass --db.`); process.exit(1); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  attachEventsIfThere(db, dbPath);
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEAM_TRIAL_KEY) as { value: string } | undefined;
  if (!raw) { console.error('No trial yet: nobody has been enrolled.'); process.exit(1); }
  const trial = JSON.parse(raw.value) as SeamTrial;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const md = render(trial, collect(db, trial), date);
  const out = values.out ?? join(homedir(), '.local/share/claude-coordinator/projects/2/shared/project/reports', `seam-trial-${date}.md`);
  if (out === '-') process.stdout.write(md);
  else { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md); console.log(`Wrote ${out}`); }
}
