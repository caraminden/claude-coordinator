// The worker pool (#1868, src/turn-line.ts) as the Status page's Workers tile reads and sets it: its size, the pause and
// the limits Auto steers by (#1892, src/turn-limits.ts). Any person, admin or not: the pool is all of Citadel's.
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import { DEFAULT_LIMITS, LIMIT_INFO, type LimitKey } from '../turn-limits.ts';

const SIZE_MAX = 50;
const WEEK_MS = 7 * 24 * 3_600_000;

/** Each limit with its default, who changed it and when, and for the pressure and memory lines how often the last 7 days crossed it. */
function limitRows({ runner, store }: Pick<App, 'runner' | 'store'>) {
  const now = runner.turnLine.limits();
  const saved = runner.turnLine.savedLimits();
  const lines = (share: 'cpu' | 'mem' | 'free') => LIMIT_INFO.filter((i) => i.share === share);
  const crossed = store.hostCrossings(
    Date.now() - WEEK_MS,
    lines('cpu').map((i) => now[i.key]),
    lines('mem').map((i) => now[i.key]),
    lines('free').map((i) => now[i.key]),
  );
  const at = (share: 'cpu' | 'mem' | 'free', key: LimitKey) => (crossed[share][lines(share).findIndex((i) => i.key === key)] ?? 0) / (crossed.total || 1);
  return LIMIT_INFO.map(({ key, label, unit, lo, hi, share }) => ({
    key,
    label,
    unit,
    lo,
    hi,
    value: now[key],
    default: DEFAULT_LIMITS[key],
    ...(saved.by[key] && saved.values[key] !== undefined ? { by: saved.by[key].by, at: saved.by[key].at } : {}),
    ...(share && crossed.total ? { share: Math.round(at(share, key) * 1000) / 10 } : {}),
  }));
}

/** The waits handed to the server that ended in the last 7 days (#1890): how many, how long the middle one ran, and how many woke a cold minion. */
function waitsEnded(jobs: ReturnType<App['minionJobs']['stats']>) {
  if (!jobs.length) return { count: 0, median: null, woken: 0, cold: 0 };
  const ms = jobs.map((j) => j.ms).sort((a, b) => a - b);
  const woken = jobs.filter((j) => j.cold !== null);
  return { count: jobs.length, median: ms[Math.floor(ms.length / 2)], woken: woken.length, cold: woken.filter((j) => j.cold).length };
}

function tile(app: Pick<App, 'runner' | 'store' | 'minionJobs'>) {
  const { people, ...rest } = app.runner.turnLine.summary();
  const { min, max } = app.runner.turnLine.limits();
  return { ...rest, min, max, limits: limitRows(app), waits: waitsEnded(app.minionJobs.stats()), people: people.map(({ person, ...p }) => ({ name: app.store.getUser(person)?.name ?? 'Automatic', ...p })) };
}

export const workerRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/workers',
    who: ['person'],
    handler: ({ res, app }) => json(res, 200, tile(app)),
  },
  {
    method: 'PUT',
    path: '/api/workers',
    who: ['person'],
    handler: async ({ req, res, app, session }) => {
      const body: unknown = await readJson(req);
      const { size, pause, limits } = (body ?? {}) as { size?: unknown; pause?: unknown; limits?: unknown };
      // One at a time: a wider pool with a pause would start turns on the way to the pause.
      if ([size, pause, limits].filter((x) => x !== undefined).length !== 1) throw new HttpError(400, 'size, pause or limits is needed, one of them');
      if (size !== undefined && size !== null && !(Number.isInteger(size) && Number(size) >= 1 && Number(size) <= SIZE_MAX)) throw new HttpError(400, `size is a whole number from 1 to ${SIZE_MAX}, or null for Auto`);
      if (pause !== undefined && pause !== true && pause !== false && pause !== 'stop') throw new HttpError(400, "pause is true, 'stop' or false");
      const line = app.runner.turnLine;
      if (limits !== undefined) {
        const keys = new Set<string>(LIMIT_INFO.map((i) => i.key));
        if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new HttpError(400, 'limits is an object of limit names to a number, or null for the default');
        for (const [k, v] of Object.entries(limits)) {
          if (!keys.has(k)) throw new HttpError(400, `${k} is not a limit`);
          if (v !== null && typeof v !== 'number') throw new HttpError(400, `${k} is a number, or null for the default`);
        }
        try {
          line.setLimits(limits as Partial<Record<LimitKey, number | null>>, session.name);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      if (size !== undefined) line.setSize(size === null ? null : Number(size), session.name);
      if (pause !== undefined) line.setPause(pause, session.name);
      return json(res, 200, tile(app));
    },
  },
];
