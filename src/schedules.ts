// Scheduled minions: a saved brief that starts on a cron schedule. The schedule lives in the app
// (this table plus a timer in the server), since minions can't install systemd timers.
import type { DatabaseSync } from 'node:sqlite';
import type { Project, Store, User } from './db.ts';
import type { Runner } from './runner.ts';
import { HttpError } from './http.ts';
import { pickFor } from '../public/model-table.js';
import { pacific } from './pacific.ts';

export interface Schedule {
  id: number;
  project_id: number;
  /** Short name people see in the Schedules panel, e.g. "Nightly health check". */
  name: string;
  /** Five-field cron (minute hour day-of-month month day-of-week) in the server's time zone, or @hourly/@daily/@weekly. */
  cron: string;
  /** The first message each run starts from. */
  brief: string;
  /** The `type` property each run's minion gets. */
  type: string;
  /** The model and effort each run starts with (src/db.ts MODELS, EFFORTS); null for the scheme's default. */
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
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@nightly': '0 0 * * *', '@weekly': '0 0 * * 0' };
// [lowest, highest] per field: minute, hour, day of month, month, day of week (0 and 7 are Sunday).
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
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
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0); continue; }
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
    if (d.getTime() <= after || secondPass) { d.setTime(d.getTime() + 60_000); continue; }
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
  if (/^[0-7](,[0-7])*$/.test(dow)) return `${dow.split(',').map((d) => DAYS[Number(d)]).join(', ')} at ${at}`;
  return cron;
}

export class ScheduleError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

export class Schedules {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEDULES_SCHEMA);
    // Columns added after the table (#387, #745), for databases created before them.
    const cols = (db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]).map((c) => c.name);
    const added = { model: 'TEXT', effort: 'TEXT', min_minions: 'INTEGER', gate_scope: "TEXT NOT NULL DEFAULT 'scheme'", last_skip: 'TEXT', once: 'INTEGER NOT NULL DEFAULT 0' };
    for (const [c, ddl] of Object.entries(added)) if (!cols.includes(c)) db.exec(`ALTER TABLE schedules ADD COLUMN ${c} ${ddl}`);
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
    } catch (err: any) {
      throw new ScheduleError(err.message);
    }
    if (next === null) throw new ScheduleError(`"${cron}" never runs`);
    return next;
  }

  create(s: Pick<Schedule, 'project_id' | 'name' | 'cron' | 'brief' | 'type' | 'created_by'> & Partial<Pick<Schedule, 'model' | 'effort' | 'min_minions' | 'gate_scope'>> & { once?: boolean }, now = Date.now()): Schedule {
    const r = this.db
      .prepare('INSERT INTO schedules (project_id, name, cron, brief, type, model, effort, min_minions, gate_scope, once, next_run_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.project_id, s.name, s.cron.trim(), s.brief, s.type, s.model ?? null, s.effort ?? null, s.min_minions ?? null, s.gate_scope ?? 'scheme', Number(!!s.once), this.next(s.cron, now), s.created_by, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Change a schedule. A new cron or a resume counts the next run from now; a pause clears it. */
  update(id: number, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'brief' | 'type' | 'model' | 'effort' | 'min_minions' | 'gate_scope'>> & { paused?: boolean; once?: boolean }, now = Date.now()): Schedule {
    const old = this.get(id);
    if (!old) throw new ScheduleError('No such schedule');
    const s = { ...old, ...patch, cron: (patch.cron ?? old.cron).trim(), paused: patch.paused === undefined ? old.paused : Number(patch.paused), once: patch.once === undefined ? old.once : Number(patch.once) };
    // A paused schedule's new cron is checked too, or the typo only shows at resume.
    if (patch.cron !== undefined) this.next(s.cron, now);
    const next = s.paused ? null : patch.cron !== undefined || (old.paused && !s.paused) ? this.next(s.cron, now) : old.next_run_at;
    this.db
      .prepare('UPDATE schedules SET name = ?, cron = ?, brief = ?, type = ?, model = ?, effort = ?, min_minions = ?, gate_scope = ?, once = ?, paused = ?, next_run_at = ? WHERE id = ?')
      .run(s.name, s.cron, s.brief, s.type, s.model, s.effort, s.min_minions, s.gate_scope, s.once, s.paused, next, id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
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
  ran(id: number, outcome: { ticketId: number } | { error: string } | { skip: string }, now = Date.now()) {
    const s = this.get(id);
    if (!s) return;
    let next: number | null = null;
    try {
      next = nextRun(s.cron, now);
    } catch {}
    if ('ticketId' in outcome) {
      const done = !!s.once;
      this.db.prepare('UPDATE schedules SET last_run_at = ?, last_ticket_id = ?, last_error = NULL, last_skip = NULL, paused = ?, next_run_at = ? WHERE id = ?').run(now, outcome.ticketId, done ? 1 : s.paused, done ? null : next, id);
    } else if ('skip' in outcome) {
      // The gate was reached, so an older "didn't start" is stale.
      this.db.prepare('UPDATE schedules SET last_skip = ?, last_error = NULL, next_run_at = ? WHERE id = ?').run(outcome.skip, next, id);
    } else {
      this.db.prepare('UPDATE schedules SET last_error = ?, next_run_at = ? WHERE id = ?').run(outcome.error, next, id);
    }
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

/** The run's window, for its brief: when the last real run was and how many minions were made since (#745). */
export function runWindow(s: Schedule, lastNumber: number | null, minions: number): string {
  const where = s.gate_scope === 'all' ? 'across all schemes' : 'in this scheme';
  const last = s.last_run_at ? `${pacific(s.last_run_at)}${lastNumber != null ? ` (#${lastNumber})` : ''}` : `never (scheduled ${pacific(s.created_at)})`;
  return `Last real run: ${last}; since then ${minions} minion${minions === 1 ? '' : 's'} ${where}.`;
}

/** The first message of a run's minion: what it is, its window, how to file itself away when there is nothing to report, then the brief. */
export function runBrief(s: Schedule, when: string, window: string): string {
  return [
    `Scheduled run of "${s.name}" (${describeCron(s.cron)}, this run ${when}). A schedule started this minion, not a person, and nobody is watching it live.`,
    window,
    'Do the brief below. If you find nothing a person needs to see or act on, file the run away quietly: set only the note (e.g. "nothing to report"), leaving state null, since state ready pings people; call close_self; end your turn with one line on what you checked. If you do find something, leave the minion open in state ready with a short report: that pings people and shows in the Needs-you inbox.',
    '',
    s.brief,
  ].join('\n');
}

export interface ScheduledRunDeps {
  store: Store;
  /** server.ts's newMinion: a minion with its worktree, not started yet. */
  newMinion: (project: Project, m: ReturnType<typeof runMinion>, by: string) => Promise<{ id: number; number: number }>;
  runner: Pick<Runner, 'emit' | 'send' | 'limitWait' | 'netWait'>;
  broadcast: (msg: object) => void;
  /** Who a run's minion says started it. */
  by: string;
}

/**
 * Each due schedule starts a fresh minion with its brief. server.ts calls runDue every half minute; a
 * schedule that came due while the server was down runs once when it is back. Moved out of server.ts
 * (docs/adr/0002-background-jobs-out-of-server.md).
 */
export class ScheduledRuns {
  private scheduling = false;

  private d: ScheduledRunDeps;

  constructor(d: ScheduledRunDeps) {
    this.d = d;
  }

  async run(s: Schedule, now = Date.now()) {
    await this.start(s, now);
    this.d.broadcast({ type: 'schedules', projectId: s.project_id });
  }

  private async start(s: Schedule, now: number) {
    const { store, runner, by } = this.d;
    const project = store.getProject(s.project_id);
    const last = s.last_ticket_id ? store.getTicket(s.last_ticket_id) : null;
    if (!project) return store.schedules.remove(s.id);
    // Two runs at once would step on each other (and double the cost), so a slot is skipped while the last run works,
    // or waits to resume after a usage limit or an outage. Not state 'limited': a run that gave up keeps it for good.
    if (last && (last.status === 'running' || runner.limitWait(last.id) || runner.netWait(last.id))) return store.schedules.ran(s.id, { error: `#${last.number}, the run before, was still working, so this slot was skipped` }, now);
    // The activity gate (#745): a quiet stretch costs nothing, no minion and no note, and the window keeps growing.
    const minions = store.schedules.minionsSince(s, by);
    if (s.min_minions != null && minions < s.min_minions) {
      const skip = `Skipped ${pacific(now)}: ${minions} minion${minions === 1 ? '' : 's'} since ${pacific(store.schedules.since(s))} (needs ${s.min_minions})`;
      console.log(`Schedule ${s.id} "${s.name}": ${skip}`);
      return store.schedules.ran(s.id, { skip }, now);
    }
    try {
      // Its turns run for whoever made the schedule (their GitHub), or the scheme's owner once they're gone; it's theirs.
      const maker = store.findUser('name', s.created_by);
      const { id, number } = await this.d.newMinion(project, runMinion(s, maker), by);
      store.updateTicket(id, { person_id: maker && !maker.disabled_at ? maker.id : null });
      const pinnedFor = pinForOwner(store, id);
      if (pinnedFor) this.d.broadcast({ type: 'ticket_pin', name: pinnedFor, projectId: project.id, ticketId: id, pinned: true });
      store.schedules.ran(s.id, { ticketId: id }, now);
      runner.emit(id, 'note', { text: `Started by the schedule "${s.name}" (${describeCron(s.cron)}).` });
      runner.send(id, by, runBrief(s, new Date(now).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), runWindow(s, last?.number ?? null, minions)), [], { brief: true });
      console.log(`Schedule ${s.id} "${s.name}" started #${number}`);
    } catch (err: any) {
      console.error(`Schedule ${s.id} "${s.name}" didn't start:`, err);
      store.schedules.ran(s.id, { error: err.message }, now);
    }
  }

  async runDue() {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      for (const s of this.d.store.schedules.due()) await this.run(s);
    } finally {
      this.scheduling = false;
    }
  }
}
