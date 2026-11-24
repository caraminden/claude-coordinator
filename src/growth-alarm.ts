// The growth alarm (#1762). Cara, 2026-11-24, on the leak hunt's (#1756) leak-checks page: "3. Growth alarm on the box:
// Go", after two leaks found the same day ("I am concerned it is a hole in our approach"). Every check we had looked at one
// moment; this one watches the 5-minute host_samples rows for something that keeps growing: the server's memory and open
// files, the citadel-supervisor-* units, /tmp, and each app server's memory. A 'growth' health event records it and Citadel's
// Taskmaster is woken once, held through 2-9 AM Pacific like CI alerts (quietUntil); an app's names the app so it can relay.
//
// Two ways to ring:
// - A steady rise: over the last RISE_WINDOW_MS, inside one run of the thing measured (the server's own readings since this
//   start, an app's since its unit started; /tmp and the supervisor units belong to the box, so a restart doesn't cut them),
//   after its first WARMUP_MS. The window's hours' medians climb, at least MIN_UP_STEPS of them, none falls back by more than
//   a tenth of the rise, no single hour makes more than half of it, and the rise passes the series' floor. So a spike that
//   settles, or one step up that then stays flat (the server's warm cache, report C), doesn't ring.
// - A bound: supervisor units over running turns + SUPERVISOR_SLACK, /tmp over TMP_BOUND.
// Each alarm rings once; it can ring again only after QUIET_AFTER_MS without it (the 'growth-open' setting holds them, so a
// restart doesn't repeat one).
import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Store, HostSample, ContraptionRow } from './db.ts';
import { quietUntil } from './alert-wakes.ts';
import { median } from './stats.ts';

export const RISE_WINDOW_MS = 6 * 3_600_000;
/** The start of a run that isn't judged: the server reaches its baseline in its first hour (leak hunt, finding C). */
export const WARMUP_MS = 3_600_000;
const HOURS = 6;
const MIN_UP_STEPS = 3;
/** The fewest readings an hour needs to count (12 are taken). */
const MIN_PER_HOUR = 6;
/** An alarm closes after this long without ringing, and may ring again after. */
export const QUIET_AFTER_MS = 6 * 3_600_000;
export const SUPERVISOR_SLACK = 10;
export const TMP_BOUND = 3 * 1024 ** 3;
export const KIND = 'growth';
const OPEN = 'growth-open';
/**
 * "Tune before it wakes anyone" (the handoff): the new readings (open fds, the units, /tmp, app servers) have no history
 * to set their floors against, so for this long after the first check a rise in one is recorded but wakes no one. The
 * bounds (the handoff's own numbers) and the server's memory (set against a week of readings) wake from the start.
 */
export const LEARN_MS = 3 * 24 * 3_600_000;
const SINCE = 'growth-since';

const MB = 1024 ** 2;
/**
 * The least rise over the window that rings, in the series' own unit, and as a share of where it started. Set against
 * Nov 16-24's readings: the server's memory creeps 10-30 MB an hour after its first hour (finding C), so its floor is 300 MB
 * between the first and last hours' medians, 5 hours apart: 60 MB an hour; 184 open files at the hunt; /tmp held 2 GB of leftovers; app servers sit at 30-300 MB.
 */
export const FLOORS: Record<Series['kind'], { rise: number; share: number }> = {
  rss: { rise: 300 * MB, share: 0.3 },
  fds: { rise: 100, share: 0.5 },
  supervisors: { rise: 10, share: 0.5 },
  tmp: { rise: 512 * MB, share: 0.25 },
  app: { rise: 150 * MB, share: 0.5 },
};

/** One app server's reading in host_samples.app_mem: its memory and when its unit's cgroup was made (its run). */
export interface AppMem {
  mem: number;
  since: number;
}

/** One thing watched: its readings, oldest first, from its run's start plus WARMUP_MS. */
export interface Series {
  kind: 'rss' | 'fds' | 'supervisors' | 'tmp' | 'app';
  /** One alarm per series per run: keyed by the server's start or an app unit's; /tmp and the units are the box's, with no run. */
  key: string;
  name: string;
  points: [number, number][];
}
/** The window's start and end values (hours' medians) when it rose steadily past its floor, else null. */
export function steadyRise(points: [number, number][], now: number, floor: { rise: number; share: number }): { from: number; to: number } | null {
  const start = now - RISE_WINDOW_MS;
  const hours: number[][] = Array.from({ length: HOURS }, () => []);
  for (const [at, v] of points) {
    if (at <= start || at > now || !Number.isFinite(v)) continue;
    hours[Math.min(HOURS - 1, Math.floor((at - start) / 3_600_000))].push(v);
  }
  if (hours.some((h) => h.length < MIN_PER_HOUR)) return null;
  const m = hours.map((h) => median(h)!);
  const rise = m[HOURS - 1] - m[0];
  if (rise < floor.rise || m[HOURS - 1] < m[0] * (1 + floor.share)) return null;
  let up = 0;
  for (let i = 1; i < HOURS; i++) {
    const step = m[i] - m[i - 1];
    if (step < -rise / 10 || step > rise / 2) return null;
    if (step > 0) up++;
  }
  return up >= MIN_UP_STEPS ? { from: m[0], to: m[HOURS - 1] } : null;
}

/** The watched series from host_samples rows (oldest first), each cut to its current run after its warm-up. */
export function seriesOf(rows: HostSample[], bootAt: number): Series[] {
  const out: Series[] = [];
  const serverFrom = bootAt + WARMUP_MS;
  const col = (kind: Series['kind'], name: string, pick: (r: HostSample) => number | null | undefined, from: number) => {
    const points = rows.flatMap((r): [number, number][] => {
      const v = pick(r);
      return r.at >= from && v != null ? [[r.at, v]] : [];
    });
    out.push({ kind, key: kind === 'rss' || kind === 'fds' ? `${kind}@${bootAt}` : kind, name, points });
  };
  col('rss', "the server's memory", (r) => r.rss, serverFrom);
  col('fds', "the server's open files", (r) => r.open_fds, serverFrom);
  col('supervisors', 'citadel-supervisor-* units', (r) => r.supervisors, 0);
  col('tmp', '/tmp', (r) => r.tmp_used, 0);
  const latest = parseApps(rows.at(-1)?.app_mem);
  for (const [app, now] of Object.entries(latest)) {
    const points = rows.flatMap((r): [number, number][] => {
      const a = parseApps(r.app_mem)[app];
      return a && a.since === now.since && r.at >= now.since + WARMUP_MS ? [[r.at, a.mem]] : [];
    });
    out.push({ kind: 'app', key: `app:${app}@${now.since}`, name: app, points });
  }
  return out;
}

export function parseApps(json: string | null | undefined): Record<string, AppMem> {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** One alarm that rang (a 'growth' health event's detail, JSON). */
export interface Growth {
  key: string;
  kind: Series['kind'] | 'bound';
  what: string;
  from?: number;
  to: number;
  line?: number;
  app?: string;
  scheme?: string | null;
}

const size = (kind: string, v: number) => (kind === 'rss' || kind === 'tmp' || kind === 'app' ? `${Math.round(v / MB)} MB` : String(Math.round(v)));

/** What rings now, from host_samples rows (oldest first) and the turns running at the newest. */
export function alarms(rows: HostSample[], bootAt: number, now: number, turns: number): Growth[] {
  const out: Growth[] = [];
  for (const s of seriesOf(rows, bootAt)) {
    const r = steadyRise(s.points, now, FLOORS[s.kind]);
    if (!r) continue;
    out.push({ key: s.key, kind: s.kind, what: `${s.name} rose steadily for ${RISE_WINDOW_MS / 3_600_000} hours, ${size(s.kind, r.from)} to ${size(s.kind, r.to)}`, from: r.from, to: r.to, ...(s.kind === 'app' ? { app: s.name } : {}) });
  }
  const last = rows.at(-1);
  if (last?.supervisors != null && last.supervisors > turns + SUPERVISOR_SLACK) {
    out.push({ key: 'bound:supervisors', kind: 'bound', what: `${last.supervisors} citadel-supervisor-* units are running with ${turns} turns running (the line: turns + ${SUPERVISOR_SLACK})`, to: last.supervisors, line: turns + SUPERVISOR_SLACK });
  }
  if (last?.tmp_used != null && last.tmp_used > TMP_BOUND) {
    out.push({ key: 'bound:tmp', kind: 'bound', what: `/tmp holds ${(last.tmp_used / 1024 ** 3).toFixed(1)} GB, every account's files on the shared tmpfs (the line: ${TMP_BOUND / 1024 ** 3} GB)`, to: last.tmp_used, line: TMP_BOUND });
  }
  return out;
}

/** 'growth-open': each alarm's key, when it last rang, and whether its Taskmaster has heard. */
type Open = Record<string, { last: number; woke: boolean; what: string }>;

export interface GrowthDeps {
  store: Store;
  bootAt: number;
  /** Turns running now. */
  turns: () => number;
  /** Citadel's own scheme, whose Taskmaster hears. */
  ownScheme: () => number | null;
  tell?: (projectId: number, text: string) => void;
}

/** The scheme an app belongs to, for the Taskmaster to relay to. */
function appScheme(store: Store, app: string): string | null {
  const c: ContraptionRow | undefined = store.getContraption(app);
  return c?.home_scheme != null ? (store.getProject(c.home_scheme)?.name ?? null) : null;
}

/** Runs after each host sample: records what newly rings and wakes Citadel's Taskmaster (outside 2-9 AM Pacific). Returns what newly rang. */
export function checkGrowth(d: GrowthDeps, now: number): Growth[] {
  const { store } = d;
  const rows = store.hostSamples(now - RISE_WINDOW_MS - WARMUP_MS);
  const open: Open = store.getSetting<Open>(OPEN) ?? {};
  // One the Taskmaster hasn't heard yet (held overnight, or no Taskmaster) stays until it has.
  for (const [k, o] of Object.entries(open)) if (o.woke && now - o.last > QUIET_AFTER_MS) delete open[k];
  let since = store.getSetting<number>(SINCE);
  if (since == null) store.setSetting(SINCE, (since = now));
  const learning = now - since < LEARN_MS;
  const fresh: Growth[] = [];
  for (const g of alarms(rows, d.bootAt, now, d.turns())) {
    if (open[g.key]) {
      open[g.key].last = now;
      continue;
    }
    if (g.app) g.scheme = appScheme(store, g.app);
    const quiet = learning && g.kind !== 'rss' && g.kind !== 'bound';
    store.addHealthEvent(KIND, now, null, JSON.stringify(quiet ? { ...g, learning: true } : g));
    open[g.key] = { last: now, woke: quiet, what: g.app ? `the app ${g.app}${g.scheme ? ` (scheme ${g.scheme})` : ''}: ${g.what.replace(`${g.app} rose`, 'its server rose')}` : g.what };
    fresh.push(g);
  }
  const own = d.ownScheme();
  const unheard = Object.entries(open).filter(([, o]) => !o.woke);
  if (unheard.length && own != null && d.tell && store.getOverlord(own) && quietUntil(now) === null) {
    d.tell(
      own,
      `Growth alarm on perigee: ${unheard.length === 1 ? 'something keeps' : 'some things keep'} growing.\n${unheard.map(([, o]) => `- ${o.what}`).join('\n')}\n\nThe 5-minute host_samples rows have the readings (rss, open_fds, supervisors, tmp_used, app_mem); 'growth' health events record each. A leak leaves these behind: leftover units, /tmp entries, open files (shared/project/reports/leak-hunt-2026-11.md). Find what's growing; an app's alarm goes to its scheme's Taskmaster to look into. Each rings once until it has been quiet for ${QUIET_AFTER_MS / 3_600_000} hours.`,
    );
    for (const [, o] of unheard) o.woke = true;
  }
  store.setSetting(OPEN, open);
  return fresh;
}

/** The new readings host_samples takes each 5 minutes (#1762); each null where it can't be read. Never throws. */
export interface GrowthReading {
  open_fds: number | null;
  supervisors: number | null;
  tmp_used: number | null;
  app_mem: string | null;
}

export interface ReadDeps {
  /** citadel.slice's cgroup dir (memory-storms' citadelSliceDir), or null where there is none. */
  slice: string | null;
  /** Contraption names whose app server unit (citadel-app-<name>.service) is read. */
  apps: string[];
  fdDir?: string;
  tmp?: string;
}

export async function readGrowth(d: ReadDeps): Promise<GrowthReading> {
  const open_fds = await readdir(d.fdDir ?? '/proc/self/fd').then(
    (l) => l.length,
    () => null,
  );
  const tmp_used = await statfs(d.tmp ?? '/tmp').then(
    (s) => (s.blocks - s.bfree) * s.bsize,
    () => null,
  );
  let supervisors: number | null = null;
  let app_mem: string | null = null;
  if (d.slice) {
    supervisors = await readdir(join(d.slice, 'citadel-taskmasters.slice')).then(
      (l) => l.filter((n) => /^citadel-supervisor-.*\.service$/.test(n)).length,
      () => null,
    );
    const apps: Record<string, AppMem> = {};
    const dir = join(dirname(d.slice), 'contraptions.slice');
    await Promise.all(
      d.apps.map(async (name) => {
        const unit = join(dir, `citadel-app-${name}.service`);
        try {
          const [mem, st] = await Promise.all([readFile(join(unit, 'memory.current'), 'utf8'), stat(unit)]);
          // The cgroup is made when the unit starts, so its ctime marks the run.
          if (Number.isFinite(Number(mem.trim()))) apps[name] = { mem: Number(mem.trim()), since: Math.round(st.ctimeMs) };
        } catch {
          // Not running, or no such unit: left out.
        }
      }),
    );
    app_mem = Object.keys(apps).length ? JSON.stringify(apps) : null;
  }
  return { open_fds, supervisors, tmp_used, app_mem };
}
