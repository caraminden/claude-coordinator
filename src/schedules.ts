// Scheduled minions: a saved brief that starts on a cron schedule. The schedule lives in the app
// (this table plus a timer in the server), since minions can't install systemd timers.
import type { HeldStarts } from './held-starts.ts';
import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Store, Ticket, User } from './db.ts';
import type { Runner } from './runner.ts';
import { HttpError } from './http.ts';
import { pickFor } from '../public/model-table.js';
import { pacific } from './pacific.ts';
import { projectSharedDir } from './workspace.ts';
import { faultPoint } from './fault-points.ts';
import { inLine } from './turn-line.ts';
import { thrown } from './thrown.ts';
import { cardHeld } from './card-wait.ts';

/** What an activity trigger counts (#1798): ships to main, or minions made. */
export type TriggerKind = 'ships' | 'minions';
const HOUR = 3_600_000;

export interface Schedule {
  id: number;
  project_id: number;
  /** Short name people see on the Schedules page, e.g. "Nightly health check". */
  name: string;
  /** Five-field cron (minute hour day-of-month month day-of-week) in the server's time zone, or @hourly/@daily/@weekly. */
  cron: string;
  /** The first message each run starts from. */
  brief: string;
  /** The `type` property each run's minion gets. */
  type: string;
  /** The model and effort each run starts with (src/db-rows.ts MODELS, EFFORTS); null for the scheme's default. */
  model: string | null;
  effort: string | null;
  paused: number;
  /** When it is next due (ms); null while paused. */
  next_run_at: number | null;
  last_run_at: number | null;
  /** The minion its last run started. */
  last_ticket_id: number | null;
  /** Why the last run didn't start, shown in the panel until a run starts. */
  last_error: string | null;
  /** The activity gate (#745): a run starts only if at least this many minions were made since the last real run; null always runs. */
  min_minions: number | null;
  /** Whose minions the gate counts: the schedule's own scheme, or every scheme (for Citadel's cross-scheme sweeps). */
  gate_scope: 'scheme' | 'all';
  /** Why the gate last skipped a slot; a real run clears it. */
  last_skip: string | null;
  /** A one-off: paused after its first real run, so a dated cron doesn't come round again next year. */
  once: number;
  /** A standard audit's template (kit/schedules/<slug>.md, #799) whose body each run renders fresh; null for a custom brief. */
  template: string | null;
  /** The scheme's own additions to its template, appended under "For <scheme>:". */
  notes: string;
  /** The group it shows under on the Schedules page (#1083): chosen when it's made, guessed from its name if not (guessCategory). */
  category: string;
  /** The activity trigger (#1798): run early once this many ships to main or new minions (counted as the gate counts, in gate_scope) since the last real run; null has none. */
  trigger_kind: TriggerKind | null;
  trigger_count: number | null;
  /** A trigger's floor: never runs within this many hours of the last real run; null is a day. */
  trigger_gap_hours: number | null;
  created_by: string;
  created_at: number;
}

export const SCHEDULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  brief TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'chore',
  model TEXT,
  effort TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_ticket_id INTEGER,
  last_error TEXT,
  min_minions INTEGER,
  gate_scope TEXT NOT NULL DEFAULT 'scheme',
  last_skip TEXT,
  once INTEGER NOT NULL DEFAULT 0,
  template TEXT,
  notes TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  trigger_kind TEXT,
  trigger_count INTEGER,
  trigger_gap_hours INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- One row per slot that started a minion or was skipped by a gate (H1, #1057): the history the schedule's last_* columns can't keep.
CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  ticket_id INTEGER,
  skip TEXT
);
CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule ON schedule_runs (schedule_id, at);
`;

/** One slot in a schedule's history: the minion it started, or why the gate skipped it. */
export interface ScheduleRun {
  id: number;
  schedule_id: number;
  at: number;
  ticket_id: number | null;
  skip: string | null;
}

const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@nightly': '0 0 * * *', '@weekly': '0 0 * * 0' };
// [lowest, highest] per field: minute, hour, day of month, month, day of week (0 and 7 are Sunday).
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const FIELD = ['minute', 'hour', 'day of month', 'month', 'day of week'];

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Cron's own rule: with both day fields restricted, a day matching either one runs. */
  domAny: boolean;
  dowAny: boolean;
}

/** Parse a cron expression; throws an Error saying what is wrong. */
export function parseCron(expr: string): Cron {
  const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error(`A schedule needs five cron fields (minute hour day month weekday) or @hourly/@daily/@weekly, not "${expr}"`);
  const sets = parts.map((part, i) => {
    const [lo, hi] = RANGES[i];
    const out = new Set<number>();
    for (const item of part.split(',')) {
      const m = item.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`Can't read the ${FIELD[i]} field "${part}"`);
      const from = m[1] === '*' ? lo : Number(m[2]);
      const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`The ${FIELD[i]} field "${part}" is out of range (${lo}-${hi})`);
      for (let v = from; v <= to; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny || c.dowAny) return dom && dow;
  return dom || dow;
}

/** The first minute strictly after `after` (ms) that the schedule runs, in the server's local time; null if none within ~5 years. */
export function nextRun(expr: string, after: number): number | null {
  const c = parseCron(expr);
  // The next whole minute by the clock, not by local fields: in the hour repeated when clocks go back,
  // rebuilding from local fields lands in its first pass, before `after` (#468 S04-3).
  const d = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const limit = after + 5 * 366 * 86_400_000;
  // Clocks going forward skip an hour: a schedule wanting it runs at the first minute after the gap (#468 S04-4).
  const skipped = (h: number) => d.getHours() !== h && d.getHours() !== (h + 1) % 24 && c.hour.has((h + 1) % 24);
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0);
      continue;
    }
    const h = d.getHours();
    if (!c.hour.has(h)) {
      d.setHours(h + 1, 0);
      if (skipped(h)) return d.getTime();
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setTime(d.getTime() + 60_000);
      if (skipped(h)) return d.getTime();
      continue;
    }
    // In the hour repeated when clocks go back, a schedule at set hours ran in its first pass: as cron, not again (#468 S04-3 review).
    const secondPass = c.hour.size < 24 && new Date(d.getTime() - 3_600_000).getHours() === h;
    if (d.getTime() <= after || secondPass) {
      d.setTime(d.getTime() + 60_000);
      continue;
    }
    return d.getTime();
  }
  return null;
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const pad = (n: string) => String(n).padStart(2, '0');

/** A cron expression in words for the common shapes (server time); anything else stays as cron. */
export function describeCron(cron: string): string {
  const alias = { '@hourly': 'Every hour', '@daily': 'Every day at 00:00', '@nightly': 'Every day at 00:00', '@weekly': 'Sundays at 00:00' }[cron.trim().toLowerCase()];
  if (alias) return alias;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0])) return cron;
  const [min, hour, dom, mon, dow] = f;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${pad(min)}`;
  if (!/^\d+$/.test(hour) || mon !== '*') return cron;
  const at = `${pad(hour)}:${pad(min)}`;
  if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${at}`;
  if (dom !== '*') return cron;
  if (dow === '*') return `Every day at ${at}`;
  if (dow === '1-5') return `Weekdays at ${at}`;
  if (/^[0-7](,[0-7])*$/.test(dow))
    return `${dow
      .split(',')
      .map((d) => DAYS[Number(d)])
      .join(', ')} at ${at}`;
  return cron;
}

export class ScheduleError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/** A standard audit's template (kit/schedules/<slug>.md, #799): the row's defaults and the brief every scheme's run renders. */
export interface ScheduleTemplate {
  slug: string;
  name: string;
  type: string;
  model: string;
  effort: string;
  min_minions: number | null;
  /** Its activity trigger (#1798), from `trigger: <n> ships|minions` and `trigger_gap: <h>h`; none leaves both null. */
  trigger_kind: TriggerKind | null;
  trigger_count: number | null;
  trigger_gap_hours: number | null;
  /** The base cron; each scheme runs it shifted by its slot (staggerCron). */
  cron: string;
  /** "<n>m within <w>m" shifts the time, "<n>d within <w>d" the day of the month. */
  stagger: string;
  /** What a scheme needs before it gets this audit, for the setup plan and the Taskmaster. */
  applies: string;
  body: string;
}

export const TEMPLATE_DIR = join(import.meta.dirname, '..', 'kit', 'schedules');

/** The kit's schedule templates by slug, read fresh (a few small files) so a deploy's kit edit applies at once. */
export function loadTemplates(dir = TEMPLATE_DIR): Map<string, ScheduleTemplate> {
  const out = new Map<string, ScheduleTemplate>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const slug = file.slice(0, -3);
    const m = readFileSync(join(dir, file), 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`kit/schedules/${file} has no frontmatter`);
    const f = Object.fromEntries(
      m[1]
        .split('\n')
        .map((l) => l.match(/^(\w+):\s*(.*)$/))
        .filter(Boolean)
        .map((x) => [x![1], x![2].trim()]),
    );
    for (const k of ['name', 'type', 'model', 'effort', 'cron', 'stagger', 'applies']) if (!f[k]) throw new Error(`kit/schedules/${file} has no ${k}`);
    const trig = f.trigger ? f.trigger.match(/^(\d+) (ships|minions)$/) : null;
    if (f.trigger && !trig) throw new Error(`kit/schedules/${file}: can't read the trigger "${f.trigger}" (e.g. "150 ships" or "300 minions")`);
    const gap = f.trigger_gap ? f.trigger_gap.match(/^(\d+)h$/) : null;
    if (f.trigger_gap && (!gap || !trig)) throw new Error(`kit/schedules/${file}: trigger_gap "${f.trigger_gap}" needs a trigger and hours, e.g. "12h"`);
    out.set(slug, {
      slug,
      name: f.name,
      type: f.type,
      model: f.model,
      effort: f.effort,
      min_minions: f.min_minions ? Number(f.min_minions) : null,
      trigger_kind: trig ? (trig[2] as TriggerKind) : null,
      trigger_count: trig ? Number(trig[1]) : null,
      trigger_gap_hours: gap ? Number(gap[1]) : null,
      cron: f.cron,
      stagger: f.stagger,
      applies: f.applies,
      body: m[2].trim(),
    });
  }
  return out;
}

/** Scheme `slot`'s cron: the base shifted by slot × step, wrapping inside the window, so schemes don't all start at once. */
export function staggerCron(base: string, stagger: string, slot: number): string {
  const m = stagger.match(/^(\d+)([md]) within (\d+)\2$/);
  if (!m) throw new Error(`Can't read the stagger "${stagger}" (e.g. "10m within 120m" or "1d within 28d")`);
  const [step, unit, within] = [Number(m[1]), m[2], Number(m[3])];
  const f = base.trim().split(/\s+/);
  const shift = (step * slot) % within;
  if (unit === 'm') {
    if (!/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) throw new Error(`A minute stagger needs a set minute and hour, not "${base}"`);
    const t = (Number(f[1]) * 60 + Number(f[0]) + shift) % 1440;
    return [t % 60, Math.floor(t / 60), ...f.slice(2)].join(' ');
  }
  if (!/^\d+(,\d+)*$/.test(f[2])) throw new Error(`A day stagger needs a set day of the month (or a list like 1,16), not "${base}"`);
  return [
    f[0],
    f[1],
    f[2]
      .split(',')
      .map((d) => Number(d) + shift)
      .join(','),
    ...f.slice(3),
  ].join(' ');
}

export interface TemplateVars {
  scheme: string;
  /** Citadel's shared folder, where the cross-scheme process digests live. */
  citadelShared: string;
  /** The memory folder a memory curator run tidies, known only when the run starts. */
  memoryDir?: string;
}

/** A run's brief from its template: the body with the scheme filled in, then the scheme's notes. */
export function renderTemplate(t: ScheduleTemplate, notes: string, v: TemplateVars): string {
  const body = t.body.replace(/\{(\w+)\}/g, (all, k) => {
    if (k === 'scheme') return v.scheme;
    if (k === 'citadel_shared') return v.citadelShared;
    if (k === 'memory_dir') return v.memoryDir ?? "the scheme's memory folder (filled in when the run starts)";
    throw new Error(`kit/schedules/${t.slug}.md uses ${all}, which nothing fills in`);
  });
  return notes.trim() ? `${body}\n\nFor ${v.scheme}:\n${notes.trim()}` : body;
}

/** A new row from a template: its defaults, the scheme's slot (id − 1), the notes and the rendered brief. */
export function templateFields(t: ScheduleTemplate, project: Pick<Project, 'id' | 'name'>, notes: string, v: TemplateVars) {
  return {
    name: t.name,
    type: t.type,
    model: t.model,
    effort: t.effort,
    min_minions: t.min_minions,
    trigger_kind: t.trigger_kind,
    trigger_count: t.trigger_count,
    trigger_gap_hours: t.trigger_gap_hours,
    cron: staggerCron(t.cron, t.stagger, project.id - 1),
    template: t.slug,
    notes: notes.trim(),
    brief: renderTemplate(t, notes, v),
  };
}

/** Whether a minion is the latest run of its scheme's app turns check (kit/schedules/app-turns.md), until the next run replaces it: the one minion that reads the turn audit (#844). */
export function isAppTurnsRun(store: Pick<Store, 'schedules'>, ticket: { id: number; project_id: number }): boolean {
  return store.schedules.list(ticket.project_id).some((s) => s.template === 'app-turns' && s.last_ticket_id === ticket.id);
}

/** The values a scheme's templates fill in. Citadel's shared folder is found by the scheme's name. */
export function templateVars(store: Pick<Store, 'getProject' | 'listProjects'>, dataDir: string, projectId: number): TemplateVars {
  const citadel = store.listProjects().find((p) => p.name === 'Citadel');
  return { scheme: store.getProject(projectId)?.name ?? 'this scheme', citadelShared: citadel ? projectSharedDir(dataDir, citadel.id) : "Citadel's shared folder" };
}

/** A standard audit's category, by its kit template. */
const TEMPLATE_CATEGORY: Record<string, string> = {
  'code-health': 'Code',
  'test-audit': 'Tests',
  'monthly-retro': 'Process',
  'upstream-check': 'Skills and docs',
  'app-turns': 'Apps',
  'memory-curator': 'Process',
  'ship-lessons': 'Process',
  'glossary-drift': 'Skills and docs',
  architecture: 'Code',
  'area-review': 'Code',
};
// First match on the name wins; a name nothing matches stays uncategorised ('', shown as Other).
const NAME_CATEGORY: [RegExp, string][] = [
  [/read-?back/i, 'Read-backs'],
  [/\bmodel|usage|anthropic/i, 'Models and usage'],
  [/contraption|app turns/i, 'Apps'],
  [/code health|architecture/i, 'Code'],
  [/\btest/i, 'Tests'],
  [/skill|docs?\b|upstream|\bkit\b/i, 'Skills and docs'],
  [/idea/i, 'Ideas'],
  [/feedback|glyph|ledger|refit|export|records/i, 'Data and feedback'],
  [/pipeline|\bland|deploy|\bci\b|housekeeping|process|retro/i, 'Process'],
];

/** A schedule's category when none was chosen (#1083): its template's, else the first name rule that matches, else ''. */
export function guessCategory(s: Pick<Schedule, 'name'> & { template?: string | null }): string {
  if (s.template && TEMPLATE_CATEGORY[s.template]) return TEMPLATE_CATEGORY[s.template];
  return NAME_CATEGORY.find(([re]) => re.test(s.name))?.[1] ?? '';
}

export class Schedules {
  private db: DatabaseSync;
  /** The first event id at or after a time (Store.eventIdAt), so a ship count reads only its window's notes. */
  private eventIdAt: (at: number) => number;

  constructor(db: DatabaseSync, eventIdAt: (at: number) => number = () => 0) {
    this.db = db;
    this.eventIdAt = eventIdAt;
    db.exec(SCHEDULES_SCHEMA);
    // Columns added after the table (#387, #745, #799, #1083, #1798), for databases created before them.
    const cols = (db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]).map((c) => c.name);
    const added = {
      model: 'TEXT',
      effort: 'TEXT',
      min_minions: 'INTEGER',
      gate_scope: "TEXT NOT NULL DEFAULT 'scheme'",
      last_skip: 'TEXT',
      once: 'INTEGER NOT NULL DEFAULT 0',
      template: 'TEXT',
      notes: "TEXT NOT NULL DEFAULT ''",
      category: "TEXT NOT NULL DEFAULT ''",
      trigger_kind: 'TEXT',
      trigger_count: 'INTEGER',
      trigger_gap_hours: 'INTEGER',
    };
    for (const [c, ddl] of Object.entries(added)) if (!cols.includes(c)) db.exec(`ALTER TABLE schedules ADD COLUMN ${c} ${ddl}`);
    // A database from before triggers (schema 115, #1798): its standard audits take their template's, this once.
    if (!cols.includes('trigger_count')) {
      try {
        this.fillTriggers(loadTemplates());
      } catch (err) {
        console.error("Schedules: standard audits didn't get their triggers:", err); // a broken template mustn't stop the start
      }
    }
  }

  /** Every schedule's name in every scheme, for the usage ledger's list of known items. */
  allNames(): string[] {
    return (this.db.prepare('SELECT DISTINCT name FROM schedules').all() as { name: string }[]).map((r) => r.name);
  }

  list(projectId: number): Schedule[] {
    return this.db.prepare('SELECT * FROM schedules WHERE project_id = ? ORDER BY paused, next_run_at, id').all(projectId) as unknown as Schedule[];
  }

  get(id: number): Schedule | null {
    return (this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as Schedule | undefined) ?? null;
  }

  /** The next run after `now`, or a ScheduleError saying why there is none. */
  private next(cron: string, now: number): number {
    let next: number | null;
    try {
      next = nextRun(cron, now);
    } catch (err) {
      throw new ScheduleError(thrown(err).message ?? String(err));
    }
    if (next === null) throw new ScheduleError(`"${cron}" never runs`);
    return next;
  }

  create(s: Pick<Schedule, 'project_id' | 'name' | 'cron' | 'brief' | 'type' | 'created_by'> & Partial<Pick<Schedule, 'model' | 'effort' | 'min_minions' | 'gate_scope' | 'template' | 'notes' | 'category' | 'trigger_kind' | 'trigger_count' | 'trigger_gap_hours'>> & { once?: boolean }, now = Date.now()): Schedule {
    const r = this.db
      .prepare('INSERT INTO schedules (project_id, name, cron, brief, type, model, effort, min_minions, gate_scope, once, template, notes, category, trigger_kind, trigger_count, trigger_gap_hours, next_run_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        s.project_id,
        s.name,
        s.cron.trim(),
        s.brief,
        s.type,
        s.model ?? null,
        s.effort ?? null,
        s.min_minions ?? null,
        s.gate_scope ?? 'scheme',
        Number(!!s.once),
        s.template ?? null,
        s.notes ?? '',
        s.category ?? guessCategory(s),
        s.trigger_count == null ? null : (s.trigger_kind ?? null),
        s.trigger_count ?? null,
        s.trigger_count == null ? null : (s.trigger_gap_hours ?? null),
        this.next(s.cron, now),
        s.created_by,
        now,
      );
    return this.get(Number(r.lastInsertRowid))!;
  }

  /**
   * Change a schedule. A new cron or a resume counts the next run from now; a pause clears it. A whole new brief on a
   * templated row, without notes, detaches it into a custom copy (#799); notes come with their rendered brief, and a
   * template with its fields attaches one.
   */
  update(id: number, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'brief' | 'type' | 'model' | 'effort' | 'min_minions' | 'gate_scope' | 'template' | 'notes' | 'category' | 'trigger_kind' | 'trigger_count' | 'trigger_gap_hours'>> & { paused?: boolean; once?: boolean }, now = Date.now()): Schedule {
    const old = this.get(id);
    if (!old) throw new ScheduleError('No such schedule');
    const detach = old.template && patch.brief !== undefined && patch.notes === undefined;
    const s = { ...old, ...patch, ...(detach ? { template: null, notes: '' } : {}), cron: (patch.cron ?? old.cron).trim(), paused: patch.paused === undefined ? old.paused : Number(patch.paused), once: patch.once === undefined ? old.once : Number(patch.once) };
    // A paused schedule's new cron is checked too, or the typo only shows at resume.
    if (patch.cron !== undefined) this.next(s.cron, now);
    const next = s.paused ? null : patch.cron !== undefined || (old.paused && !s.paused) ? this.next(s.cron, now) : old.next_run_at;
    this.db
      .prepare('UPDATE schedules SET name = ?, cron = ?, brief = ?, type = ?, model = ?, effort = ?, min_minions = ?, gate_scope = ?, once = ?, template = ?, notes = ?, category = ?, trigger_kind = ?, trigger_count = ?, trigger_gap_hours = ?, paused = ?, next_run_at = ? WHERE id = ?')
      .run(s.name, s.cron, s.brief, s.type, s.model, s.effort, s.min_minions, s.gate_scope, s.once, s.template, s.notes, s.category, s.trigger_count == null ? null : s.trigger_kind, s.trigger_count, s.trigger_count == null ? null : s.trigger_gap_hours, s.paused, next, id);
    return this.get(id)!;
  }

  /** Keep the last rendered brief on a templated row, for the panel, list_schedules and an older release on rollback. */
  setBrief(id: number, brief: string) {
    this.db.prepare('UPDATE schedules SET brief = ? WHERE id = ?').run(brief, id);
  }

  /** Schema 82 (#1083): every uncategorised schedule gets its guessed category, once. */
  categorize() {
    const set = this.db.prepare('UPDATE schedules SET category = ? WHERE id = ?');
    for (const s of this.db.prepare("SELECT id, name, template FROM schedules WHERE category = ''").all() as unknown as Schedule[]) {
      const c = guessCategory(s);
      if (c) set.run(c, s.id);
    }
  }

  /** Schema 115 (#1798): each standard audit's row takes its template's trigger, once, as min_minions reached them when made. */
  fillTriggers(templates: Map<string, ScheduleTemplate>) {
    const set = this.db.prepare('UPDATE schedules SET trigger_kind = ?, trigger_count = ?, trigger_gap_hours = ? WHERE id = ?');
    for (const s of this.db.prepare('SELECT id, template FROM schedules WHERE template IS NOT NULL AND trigger_count IS NULL').all() as unknown as Schedule[]) {
      const t = templates.get(s.template!);
      if (t?.trigger_count != null) set.run(t.trigger_kind, t.trigger_count, t.trigger_gap_hours, s.id);
    }
  }

  /** Schedules with a trigger whose floor has passed: not paused, and no real run within their gap (a day unless set). */
  triggerable(now = Date.now()): Schedule[] {
    return this.db.prepare(`SELECT * FROM schedules WHERE paused = 0 AND trigger_count IS NOT NULL AND COALESCE(last_run_at, created_at) <= ? - COALESCE(trigger_gap_hours, 24) * ${HOUR} ORDER BY id`).all(now) as unknown as Schedule[];
  }

  remove(id: number): boolean {
    this.db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(id);
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  /** Schedules whose run is due. One that came due while the server was down runs once, not once per missed slot. */
  due(now = Date.now()): Schedule[] {
    return this.db.prepare('SELECT * FROM schedules WHERE paused = 0 AND next_run_at <= ? ORDER BY next_run_at').all(now) as unknown as Schedule[];
  }

  /**
   * Record a slot: the minion it started, why it didn't start, or why the activity gate skipped it. Either way the next
   * run counts from now. Only a started minion moves last_run_at, so a skip leaves the gate's window growing; a one-off
   * pauses after it.
   */
  ran(id: number, outcome: { ticketId: number; triggered?: boolean } | { error: string } | { skip: string }, now = Date.now()) {
    const s = this.get(id);
    if (!s) return;
    let next: number | null = null;
    try {
      next = nextRun(s.cron, now);
      // The calendar is a trigger's fallback (Cara, 2026-11-24): a triggered run takes the coming slot's place.
      if ('ticketId' in outcome && outcome.triggered) next = nextRun(s.cron, next!);
    } catch {}
    // One commit: a crash between the history row and the schedule would leave the slot owed, and a second row for it.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if ('ticketId' in outcome || 'skip' in outcome) {
        this.db.prepare('INSERT INTO schedule_runs (schedule_id, at, ticket_id, skip) VALUES (?, ?, ?, ?)').run(id, now, 'ticketId' in outcome ? outcome.ticketId : null, 'skip' in outcome ? outcome.skip : null);
      }
      if ('ticketId' in outcome) {
        const done = !!s.once;
        this.db.prepare('UPDATE schedules SET last_run_at = ?, last_ticket_id = ?, last_error = NULL, last_skip = NULL, paused = ?, next_run_at = ? WHERE id = ?').run(now, outcome.ticketId, done ? 1 : s.paused, done ? null : next, id);
      } else if ('skip' in outcome) {
        // The gate was reached, so an older "didn't start" is stale.
        this.db.prepare('UPDATE schedules SET last_skip = ?, last_error = NULL, next_run_at = ? WHERE id = ?').run(outcome.skip, next, id);
      } else {
        // Never earlier than it was: a triggered run's error keeps the slot that run took.
        this.db.prepare('UPDATE schedules SET last_error = ?, next_run_at = ? WHERE id = ?').run(outcome.error, next == null ? null : Math.max(next, s.next_run_at ?? 0), id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * The minion a run made for this slot before a kill cut its start off, ahead of the slot's ran mark (C3, #1406): made
   * by Citadel (`by`) under the schedule's name since the slot came due. A run that got its ran mark moved next_run_at
   * past its own minion's making, so an older run's minion never matches. Two schedules sharing a name in one scheme
   * can't tell their minions apart, so they never adopt one.
   */
  cutOff(s: Schedule, by: string): { id: number; number: number; status: string } | null {
    if (s.next_run_at == null) return null;
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE project_id = ? AND name = ?').get(s.project_id, s.name) as { n: number }).n > 1) return null;
    return (
      (this.db.prepare("SELECT id, number, status FROM tickets WHERE project_id = ? AND kind = 'ticket' AND title = ? AND created_by = ? AND created_at >= ? AND id IS NOT ? ORDER BY id LIMIT 1").get(s.project_id, s.name, by, s.next_run_at, s.last_ticket_id) as
        | { id: number; number: number; status: string }
        | undefined) ?? null
    );
  }

  /** The newest `limit` slots, newest first. */
  runs(id: number, limit = 10): ScheduleRun[] {
    return this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(id, limit) as unknown as ScheduleRun[];
  }

  /** A run that waited for the box (#1302): say how long, in the line the schedule's page shows beside a skip. */
  heldNote(id: number, text: string) {
    this.db.prepare('UPDATE schedules SET last_skip = ? WHERE id = ?').run(text, id);
  }

  /** How many slots the gate skipped since `since`. */
  skipsSince(id: number, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ? AND skip IS NOT NULL AND at >= ?').get(id, since) as { n: number }).n;
  }

  /** When the gate's window opens: the last real run, or the schedule's making if it has never run. */
  since(s: Schedule): number {
    return s.last_run_at ?? s.created_at;
  }

  /**
   * The gate's measure: minions made since the last real run, in the schedule's scheme or every scheme. Taskmasters
   * don't count, and nor do minions Citadel itself started (`by`: scheduled runs and wake-ups), so schedules don't
   * keep each other awake.
   */
  minionsSince(s: Schedule, by: string): number {
    const scope = s.gate_scope === 'all' ? '' : 'AND project_id = ?';
    const args = s.gate_scope === 'all' ? [] : [s.project_id];
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE kind != 'coordinator' AND created_by != ? AND created_at > ? ${scope}`).get(by, this.since(s), ...args) as { n: number }).n);
  }

  /**
   * Ships to main since the last real run, in the schedule's scheme or every scheme: the minions with a "Shipped <commit>"
   * note (Store.shippedNotes), each once, since a busy minion's follow-ups post several. A merge into a build branch
   * ("Merged …") and a ship whose push failed don't count.
   */
  shipsSince(s: Schedule): number {
    const since = this.since(s);
    const scope = s.gate_scope === 'all' ? '' : 'AND t.project_id = ?';
    const args = s.gate_scope === 'all' ? [] : [s.project_id];
    return Number(
      (
        this.db
          .prepare(`SELECT COUNT(DISTINCT e.ticket_id) AS n FROM events e JOIN tickets t ON t.id = e.ticket_id WHERE e.id >= ? AND e.created_at > ? AND e.kind = 'note'
      AND e.data LIKE '{"text":"Shipped %' AND e.data NOT LIKE '%not pushed to origin: the push failed.%' ${scope}`)
          .get(this.eventIdAt(since), since, ...args) as { n: number }
      ).n,
    );
  }
}

/**
 * Pin a run's minion for the scheme's owner, as if they'd pinned it (#384; Cara, 2026-11-08: "Lets have them default to
 * pinned for the scheme owner"), since no person started it. Only at the start: an unpin sticks. No owner, or one who's
 * been removed, pins for nobody. Returns whose pin it is, for the broadcast.
 */
export function pinForOwner(store: Pick<Store, 'getTicket' | 'getProject' | 'getUser' | 'setTicketPinned'>, ticketId: number): string | null {
  const ticket = store.getTicket(ticketId);
  const ownerId = ticket && store.getProject(ticket.project_id)?.owner_id;
  const owner = ownerId != null ? store.getUser(ownerId) : undefined;
  if (!owner || owner.disabled_at) return null;
  store.setTicketPinned(owner.name, ticketId, true);
  return owner.name;
}

/** The minion a run starts: its title, type and model and effort (null: the scheme's defaults), assigned to the schedule's maker while they're around. */
export function runMinion(s: Schedule, maker: Pick<User, 'name' | 'disabled_at'> | undefined) {
  // A schedule made before #698 may name neither: its runs take the model table's pick for its type.
  const table = pickFor(s.type);
  return { title: s.name, model: s.model ?? table.model, effort: s.effort ?? table.effort, props: { type: s.type, ...(maker && !maker.disabled_at ? { assigned: maker.name } : {}) } };
}

export { pacific };

/** The run's window, for its brief: when the last real run was and how many minions were made and ships made since (#745), led by what triggered it (#1798). */
export function runWindow(s: Schedule, lastNumber: number | null, minions: number, ships: number, triggered = false): string {
  const where = s.gate_scope === 'all' ? 'across all schemes' : 'in this scheme';
  const last = s.last_run_at ? `${pacific(s.last_run_at)}${lastNumber != null ? ` (#${lastNumber})` : ''}` : `never (scheduled ${pacific(s.created_at)})`;
  const count = s.trigger_kind === 'ships' ? ships : minions;
  const lead = triggered ? `Triggered: ${count} ${s.trigger_kind} since ${pacific(s.last_run_at ?? s.created_at)} (runs after ${s.trigger_count}). ` : '';
  return `${lead}Last real run: ${last}; since then ${minions} minion${minions === 1 ? '' : 's'} and ${ships} ship${ships === 1 ? '' : 's'} ${where}.`;
}

/** What a schedule's trigger says, for the page and list_schedules: "runs after 150 ships" (across all schemes, at most every 12 h). */
export function describeTrigger(s: Pick<Schedule, 'trigger_kind' | 'trigger_count' | 'trigger_gap_hours' | 'gate_scope'>): string | null {
  if (s.trigger_count == null || !s.trigger_kind) return null;
  const gap = s.trigger_gap_hours == null ? '' : `, at most every ${s.trigger_gap_hours} h`;
  return `runs after ${s.trigger_count} ${s.trigger_count === 1 ? s.trigger_kind.slice(0, -1) : s.trigger_kind}${s.gate_scope === 'all' ? ' across all schemes' : ''}${gap}`;
}

/** The first message of a run's minion: what it is, its window, how to file itself away when there is nothing to report, then the brief. */
export function runBrief(s: Schedule, when: string, window: string): string {
  return [
    `Scheduled run of "${s.name}" (${describeCron(s.cron)}, this run ${when}). A schedule started this minion, not a person, and nobody is watching it live.`,
    window,
    'Do the brief below. If you find nothing a person needs to see or act on, file the run away quietly: set only the note (e.g. "nothing to report"), leaving state null, since state ready pings people; call close_self; end your turn with one line on what you checked. If you do find something, leave the minion open in state ready with a short report: that pings people and shows in the Needs-you inbox. If the run writes handoff files, end with one multi-select ask_question card, one option per handoff (or per item when one file holds several), the option for each handoff with its `start` so a plain pick starts that minion by itself, your recommendation marked, and start no minions yourself. A handoff for another scheme\'s repo gets no option: send its path to your Taskmaster and leave the file. Once a person answers (if every pick started, you hear it as held mail), keep the picked handoffs (or items), delete the others the card offered, and send the picks that did not start to your Taskmaster with message_coordinator, naming each handoff path.',
    '',
    s.brief,
  ].join('\n');
}

export interface ScheduledRunDeps {
  store: Store;
  /** server.ts's newMinion: a minion with its worktree, not started yet. */
  newMinion: (project: Project, m: ReturnType<typeof runMinion>, by: string) => Promise<{ id: number; number: number }>;
  runner: Pick<Runner, 'emit' | 'send' | 'limitWait' | 'netWait' | 'killWait'> & Partial<Pick<Runner, 'jobs'>>;
  broadcast: (msg: object) => void;
  /** Who a run's minion says started it. */
  by: string;
  /** For a templated schedule's placeholders (Citadel's shared folder). */
  dataDir: string;
  /** The schedule templates; the kit's by default. */
  templates?: () => Map<string, ScheduleTemplate>;
  /** The memory folder the memory curator (#1111) tidies in a scheme, and its note count; none skips its run. */
  memoryTarget?: (projectId: number) => { dir: string; notes: number } | null;
  /** Holds a run's brief while the box is starved (#1302, src/held-starts.ts); without it the brief is sent at once. */
  held?: Pick<HeldStarts, 'start'>;
}

/**
 * Each due schedule starts a fresh minion with its brief. server.ts calls runDue every half minute; a
 * schedule that came due while the server was down runs once when it is back. Moved out of server.ts
 * (docs/adr/0002-background-jobs-out-of-server.md).
 */
export class ScheduledRuns {
  private scheduling = false;
  /** When runDue last looked at the activity triggers (#1798): once an hour is soon enough for a count in the hundreds. */
  private triggersAt = 0;

  private d: ScheduledRunDeps;

  constructor(d: ScheduledRunDeps) {
    this.d = d;
  }

  /** Start a run: its calendar slot came, or (`triggered`) its activity trigger's count was hit (#1798). */
  async run(s: Schedule, now = Date.now(), triggered = false) {
    await this.start(s, now, triggered);
    this.d.broadcast({ type: 'schedules', projectId: s.project_id });
  }

  /** Start each schedule whose trigger count was hit since its last real run, once its gap has passed. */
  async runTriggered(now = Date.now()) {
    const { store, by } = this.d;
    for (const s of store.schedules.triggerable(now)) {
      const count = s.trigger_kind === 'ships' ? store.schedules.shipsSince(s) : store.schedules.minionsSince(s, by);
      if (count >= s.trigger_count!) await this.run(s, now, true);
    }
  }

  private async start(s: Schedule, now: number, triggered = false) {
    const { store, runner, by } = this.d;
    const project = store.getProject(s.project_id);
    const last = s.last_ticket_id ? store.getTicket(s.last_ticket_id) : null;
    if (!project) return store.schedules.remove(s.id);
    // A kill after this slot's minion was made and before its ran mark (C3, #1406): finish that start, not a second one.
    const cut = triggered ? null : store.schedules.cutOff(s, by);
    if (cut?.status === 'closed') return store.schedules.ran(s.id, { ticketId: cut.id }, now);
    if (cut) return this.begin(s, project, cut, last, store.schedules.minionsSince(s, by), now, false);
    // Two runs at once would step on each other (and double the cost), so a slot is skipped while the last run works (its own job running on past its turn, #1890, included),
    // or waits to resume after a usage limit, an outage or a kill. Not state 'limited': a run that gave up keeps it for good.
    // A trigger just waits for the next hourly check, quietly: no slot of the calendar's was missed.
    if (last && (last.status === 'running' || inLine(store, last.id) || runner.jobs?.running(last.id).length || runner.limitWait(last.id) || runner.netWait(last.id) || runner.killWait(last.id) || cardHeld(store, last.id)))
      return triggered ? undefined : store.schedules.ran(s.id, { error: `#${last.number}, the run before, was still working, so this slot was skipped` }, now);
    // The activity gate (#745): a quiet stretch costs nothing, no minion and no note, and the window keeps growing. It
    // gates calendar slots; a trigger's own count was just met.
    const minions = store.schedules.minionsSince(s, by);
    if (!triggered && s.min_minions != null && minions < s.min_minions) {
      const skip = `Skipped ${pacific(now)}: ${minions} minion${minions === 1 ? '' : 's'} since ${pacific(store.schedules.since(s))} (needs ${s.min_minions})`;
      console.log(`Schedule ${s.id} "${s.name}": ${skip}`);
      return store.schedules.ran(s.id, { skip }, now);
    }
    // The app turns check (#844) skips, as free as the gate above, a stretch with no app turns to read.
    if (s.template === 'app-turns') {
      const newest = store.schemeTurnAudit(s.project_id, { limit: 1 })[0];
      if (!newest || newest.at <= store.schedules.since(s)) {
        const skip = `Skipped ${pacific(now)}: no app turns since ${pacific(store.schedules.since(s))}`;
        console.log(`Schedule ${s.id} "${s.name}": ${skip}`);
        return triggered ? undefined : store.schedules.ran(s.id, { skip }, now);
      }
    }
    // Ship lessons (#1119) skips, as free, a stretch with no new lines or too few open ones to repeat.
    if (s.template === 'ship-lessons') {
      const newest = store.lessons.newestOpen(s.project_id);
      const open = store.lessons.list(s.project_id, { limit: 2 }, now).length;
      if (!newest || newest <= store.schedules.since(s) || open < 2) {
        const skip = `Skipped ${pacific(now)}: ${open < 2 ? `${open} open ship lesson${open === 1 ? '' : 's'}, too few to repeat` : `no new ship lessons since ${pacific(store.schedules.since(s))}`}`;
        console.log(`Schedule ${s.id} "${s.name}": ${skip}`);
        return triggered ? undefined : store.schedules.ran(s.id, { skip }, now);
      }
    }
    let memoryDir: { dir: string; notes: number } | null | undefined;
    // The memory curator (#1111) skips, as free, a scheme with no notes or with last week's tidy still waiting on a member.
    if (s.template === 'memory-curator') {
      const open = store.memoryProposals.open(s.project_id);
      memoryDir = this.d.memoryTarget?.(s.project_id);
      const why = open ? `a tidy${open.ticket_id === null ? '' : ` from #${store.getTicket(open.ticket_id)?.number}`} still waits on a member` : !memoryDir?.notes ? 'no memory notes to tidy' : null;
      if (why) {
        const skip = `Skipped ${pacific(now)}: ${why}`;
        console.log(`Schedule ${s.id} "${s.name}": ${skip}`);
        return triggered ? undefined : store.schedules.ran(s.id, { skip }, now);
      }
    }
    try {
      // A standard audit renders its kit template now, so a template fix reaches every scheme's next run (#799).
      if (s.template) {
        const t = (this.d.templates ?? loadTemplates)().get(s.template);
        if (!t) throw new Error(`its template kit/schedules/${s.template}.md is gone from the kit`);
        s = { ...s, brief: renderTemplate(t, s.notes, { ...templateVars(store, this.d.dataDir, s.project_id), ...(memoryDir ? { memoryDir: memoryDir.dir } : {}) }) };
        store.schedules.setBrief(s.id, s.brief);
      }
      // Its turns run for whoever made the schedule (their GitHub), or the scheme's owner once they're gone; it's theirs.
      const maker = store.findUser('name', s.created_by);
      const made = await this.d.newMinion(project, runMinion(s, maker), by);
      await this.begin(s, project, made, last, minions, now, triggered);
    } catch (err) {
      console.error(`Schedule ${s.id} "${s.name}" didn't start:`, err);
      store.schedules.ran(s.id, { error: thrown(err).message ?? String(err) }, now);
    }
  }

  /** A run's minion exists: give it to the maker, pin it, mark the slot ran and send its brief. Safe to repeat up to the ran mark. */
  private async begin(s: Schedule, project: Project, { id, number }: { id: number; number: number }, last: Ticket | null | undefined, minions: number, now: number, triggered: boolean) {
    const { store, runner, by } = this.d;
    let marked = false;
    try {
      const maker = store.findUser('name', s.created_by);
      store.updateTicket(id, { person_id: maker && !maker.disabled_at ? maker.id : null });
      const pinnedFor = pinForOwner(store, id);
      if (pinnedFor) this.d.broadcast({ type: 'ticket_pin', name: pinnedFor, projectId: project.id, ticketId: id, pinned: true });
      await faultPoint('schedule-started'); // a drill's kill between the minion's start and the slot's ran mark (C3)
      const ships = store.schedules.shipsSince(s); // counted from `s`, the row as it was before this run
      store.schedules.ran(s.id, { ticketId: id, triggered }, now);
      marked = true;
      store.usage.used('schedule', s.name);
      const why = triggered ? `, early: ${s.trigger_kind === 'ships' ? ships : minions} ${s.trigger_kind} since its last run` : '';
      runner.emit(id, 'note', { text: `Started by the schedule "${s.name}" (${describeCron(s.cron)}${why}).` });
      const message = runBrief(s, pacific(now), runWindow(s, last?.number ?? null, minions, ships, triggered));
      const opts = { brief: true, schedule: s.name };
      const send = () => runner.send(id, by, message, [], opts);
      // The minion exists either way; while the box is starved its brief waits (up to 10 minutes) as a sealed row.
      if (this.d.held) await this.d.held.start({ ticket: id, from: by, message, opts, schedule: s.id }, send);
      else send();
      console.log(`Schedule ${s.id} "${s.name}" started #${number}`);
    } catch (err) {
      console.error(`Schedule ${s.id} "${s.name}" didn't start:`, err);
      // A trigger's minion exists, so it is the run: unmarked, the next hourly check would make another.
      if (triggered && !marked) store.schedules.ran(s.id, { ticketId: id, triggered }, now);
      store.schedules.ran(s.id, { error: thrown(err).message ?? String(err) }, now);
    }
  }

  async runDue(now = Date.now()) {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      for (const s of this.d.store.schedules.due(now)) await this.run(s, now);
      if (now - this.triggersAt >= HOUR) {
        this.triggersAt = now;
        await this.runTriggered(now);
      }
    } finally {
      this.scheduling = false;
    }
  }
}
