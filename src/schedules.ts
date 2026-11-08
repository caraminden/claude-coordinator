// Scheduled minions: a saved brief that starts on a cron schedule. The schedule lives in the app
// (this table plus a timer in the server), since minions can't install systemd timers.
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db.ts';
import { HttpError } from './http.ts';

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
  paused: number;
  /** When it is next due (ms); null while paused. */
  next_run_at: number | null;
  last_run_at: number | null;
  /** The minion its last run started. */
  last_ticket_id: number | null;
  /** Why the last run didn't start, shown in the panel until a run starts. */
  last_error: string | null;
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
  paused INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_ticket_id INTEGER,
  last_error TEXT,
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
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
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

  create(s: Pick<Schedule, 'project_id' | 'name' | 'cron' | 'brief' | 'type' | 'created_by'>, now = Date.now()): Schedule {
    const r = this.db
      .prepare('INSERT INTO schedules (project_id, name, cron, brief, type, next_run_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.project_id, s.name, s.cron.trim(), s.brief, s.type, this.next(s.cron, now), s.created_by, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Change a schedule. A new cron or a resume counts the next run from now; a pause clears it. */
  update(id: number, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'brief' | 'type'>> & { paused?: boolean }, now = Date.now()): Schedule {
    const old = this.get(id);
    if (!old) throw new ScheduleError('No such schedule');
    const s = { ...old, ...patch, cron: (patch.cron ?? old.cron).trim(), paused: patch.paused === undefined ? old.paused : Number(patch.paused) };
    const next = s.paused ? null : patch.cron !== undefined || (old.paused && !s.paused) ? this.next(s.cron, now) : old.next_run_at;
    this.db.prepare('UPDATE schedules SET name = ?, cron = ?, brief = ?, type = ?, paused = ?, next_run_at = ? WHERE id = ?').run(s.name, s.cron, s.brief, s.type, s.paused, next, id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  /** Schedules whose run is due. One that came due while the server was down runs once, not once per missed slot. */
  due(now = Date.now()): Schedule[] {
    return this.db.prepare('SELECT * FROM schedules WHERE paused = 0 AND next_run_at <= ? ORDER BY next_run_at').all(now) as unknown as Schedule[];
  }

  /** Record a run: the minion it started, or why it didn't start; either way the next run counts from now. */
  ran(id: number, outcome: { ticketId: number } | { error: string }, now = Date.now()) {
    const s = this.get(id);
    if (!s) return;
    let next: number | null = null;
    try {
      next = nextRun(s.cron, now);
    } catch {}
    if ('ticketId' in outcome) {
      this.db.prepare('UPDATE schedules SET last_run_at = ?, last_ticket_id = ?, last_error = NULL, next_run_at = ? WHERE id = ?').run(now, outcome.ticketId, next, id);
    } else {
      this.db.prepare('UPDATE schedules SET last_error = ?, next_run_at = ? WHERE id = ?').run(outcome.error, next, id);
    }
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

/** The first message of a run's minion: what it is, how to file itself away when there is nothing to report, then the brief. */
export function runBrief(s: Schedule, when: string): string {
  return [
    `Scheduled run of "${s.name}" (${describeCron(s.cron)}, this run ${when}). A schedule started this minion, not a person, and nobody is watching it live.`,
    'Do the brief below. If you find nothing a person needs to see or act on, file the run away quietly: set only the note (e.g. "nothing to report"), leaving state null, since state ready pings people; call close_self; end your turn with one line on what you checked. If you do find something, leave the minion open in state ready with a short report: that pings people and shows in the Needs-you inbox.',
    '',
    s.brief,
  ].join('\n');
}
