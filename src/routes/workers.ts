// The worker pool (#1868, src/turn-line.ts) as the Status page's Workers tile reads and sets it: its size, the pause and
// the limits Auto steers by (#1892, src/turn-limits.ts). Any person, admin or not: the pool is all of Citadel's. A connected
// machine's own size and limits (Build 7 T4) are its owner's or an admin's. And where one minion's turns run (src/runs-on.ts).
import { ANYWHERE, HOME } from '../runs-on.ts';
import type { Session } from '../auth.ts';
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import { DEFAULT_LIMITS, LIMIT_INFO, MACHINE_LIMITS, type LimitKey } from '../turn-limits.ts';

const SIZE_MAX = 50;
const WEEK_MS = 7 * 24 * 3_600_000;

/** Each limit with its default, who changed it and when, and, at perigee, for the pressure and memory lines how often the last 7 days crossed it. */
function limitRows({ runner, store }: Pick<App, 'runner' | 'store'>, place = 0) {
  const now = runner.turnLine.limits(place);
  const saved = runner.turnLine.savedLimits(place);
  const lines = (share: 'cpu' | 'mem' | 'free') => LIMIT_INFO.filter((i) => i.share === share);
  // A week of samples, perigee's alone.
  const crossed = place
    ? null
    : store.hostCrossings(
        Date.now() - WEEK_MS,
        lines('cpu').map((i) => now[i.key]),
        lines('mem').map((i) => now[i.key]),
        lines('free').map((i) => now[i.key]),
      );
  const at = (share: 'cpu' | 'mem' | 'free', key: LimitKey) => (crossed?.[share][lines(share).findIndex((i) => i.key === key)] ?? 0) / (crossed?.total || 1);
  // How long a wait may hold a worker is the server's own; a machine has no say in it.
  return LIMIT_INFO.filter(({ key }) => !place || key !== 'waitHold').map(({ key, label, unit, lo, hi, share }) => ({
    key,
    label,
    unit,
    lo,
    hi,
    value: now[key],
    default: (place ? MACHINE_LIMITS : DEFAULT_LIMITS)[key],
    ...(saved.by[key] && saved.values[key] !== undefined ? { by: saved.by[key].by, at: saved.by[key].at } : {}),
    ...(share && crossed?.total ? { share: Math.round(at(share, key) * 1000) / 10 } : {}),
  }));
}

/** The waits handed to the server that ended in the last 7 days (#1890): how many, how long the middle one ran, and how many woke a cold minion. */
function waitsEnded(jobs: ReturnType<App['minionJobs']['stats']>) {
  if (!jobs.length) return { count: 0, median: null, woken: 0, cold: 0 };
  const ms = jobs.map((j) => j.ms).sort((a, b) => a - b);
  const woken = jobs.filter((j) => j.cold !== null);
  return { count: jobs.length, median: ms[Math.floor(ms.length / 2)], woken: woken.length, cold: woken.filter((j) => j.cold).length };
}

/** A PC's owner alone sets how much of it minions get (the page Josh picked from: "theirs alone to set"). */
const mine = (session: Session, owner: number) => session.uid === owner;

function tile(app: Pick<App, 'runner' | 'store' | 'minionJobs' | 'heavyNow'>, session: Session) {
  const { people, machines, ...rest } = app.runner.turnLine.summary();
  const places = machines.map(({ owner, ...m }) => ({ ...m, owner: app.store.getUser(owner)?.name ?? null, mine: mine(session, owner), limits: limitRows(app, m.id) }));
  const { min, max } = app.runner.turnLine.limits();
  return { ...rest, heavy: app.heavyNow?.() ?? { home: [], machines: [] }, machines: places, min, max, limits: limitRows(app), waits: waitsEnded(app.minionJobs.stats()), people: people.map(({ person, ...p }) => ({ name: app.store.getUser(person)?.name ?? 'Automatic', ...p })) };
}

export const workerRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/workers',
    who: ['person'],
    handler: ({ res, app, session }) => json(res, 200, tile(app, session)),
  },
  {
    method: 'PUT',
    path: '/api/workers',
    who: ['person'],
    handler: async ({ req, res, app, session }) => {
      const body: unknown = await readJson(req);
      const { size, pause, limits, place = 0 } = (body ?? {}) as { size?: unknown; pause?: unknown; limits?: unknown; place?: unknown };
      // One at a time: a wider pool with a pause would start turns on the way to the pause.
      if ([size, pause, limits].filter((x) => x !== undefined).length !== 1) throw new HttpError(400, 'size, pause or limits is needed, one of them');
      if (size !== undefined && size !== null && !(Number.isInteger(size) && Number(size) >= 1 && Number(size) <= SIZE_MAX)) throw new HttpError(400, `size is a whole number from 1 to ${SIZE_MAX}, or null for Auto`);
      if (pause !== undefined && pause !== true && pause !== false && pause !== 'stop') throw new HttpError(400, "pause is true, 'stop' or false");
      const line = app.runner.turnLine;
      const machine = place === 0 ? null : app.runner.pools?.machines().find((m) => m.id === place);
      if (machine === undefined) throw new HttpError(404, 'That machine runs no minion turns now');
      if (machine && pause !== undefined) throw new HttpError(400, 'The pause is for every place');
      if (machine && !mine(session, machine.owner)) throw new HttpError(403, `Only ${app.store.getUser(machine.owner)?.name ?? 'its owner'} sets ${machine.name}'s workers`);
      if (machine && Number(size) > machine.cap) throw new HttpError(400, `${machine.name} takes at most ${machine.cap} turns at once`);
      const at = machine?.id ?? 0;
      if (limits !== undefined) {
        const keys = new Set<string>(LIMIT_INFO.map((i) => i.key));
        if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new HttpError(400, 'limits is an object of limit names to a number, or null for the default');
        for (const [k, v] of Object.entries(limits)) {
          if (!keys.has(k)) throw new HttpError(400, `${k} is not a limit`);
          if (v !== null && typeof v !== 'number') throw new HttpError(400, `${k} is a number, or null for the default`);
        }
        try {
          line.setLimits(limits as Partial<Record<LimitKey, number | null>>, session.name, Date.now(), at);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      if (size !== undefined) line.setSize(size === null ? null : Number(size), session.name, at);
      if (pause !== undefined) line.setPause(pause, session.name);
      return json(res, 200, tile(app, session));
    },
  },
  {
    // Where its turns run, and what this person could pick: their own machines, each with why it can't be picked now.
    method: 'GET',
    path: '/api/tickets/:ticket/runs-on',
    who: ['person'],
    handler: ({ res, app, session, ticket }) => json(res, 200, { runs_on: app.runner.runsOn.view(ticket.id), machines: app.runner.pools?.choices(ticket.project_id, session.uid ?? null) ?? [] }),
  },
  {
    // { on }: 'anywhere', 'perigee' or a machine's name.
    method: 'PUT',
    path: '/api/tickets/:ticket/runs-on',
    who: ['person'],
    refuse: "Only people change where a minion runs; a new minion's is create_ticket's runs_on",
    async handler({ req, res, app, session, ticket }) {
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'A Taskmaster always runs at perigee');
      const on = runsOnPick(app, ticket.project_id, ((await readJson(req)) as { on?: unknown } | null)?.on, session.uid ?? null);
      app.runner.runsOn.set(ticket.id, on, session.name);
      return json(res, 200, { runs_on: app.runner.runsOn.view(ticket.id) });
    },
  },
];

/** A "Runs on" value as a mark to set, null for anywhere: a machine is picked by its owner alone, for a scheme it is lent to. */
export function runsOnPick(app: Pick<App, 'runner'>, projectId: number, value: unknown, person: number | null): { machine: number | null; name: string } | null {
  if (value === ANYWHERE) return null;
  if (value === HOME) return { machine: null, name: HOME };
  const machines = app.runner.pools?.choices(projectId, person) ?? [];
  const m = machines.find((x) => x.name === value);
  if (!m) throw new HttpError(400, `runs_on is ${[ANYWHERE, HOME, ...machines.map((x) => x.name)].join(', ').replace(/, ([^,]*)$/, ' or $1')}`);
  if (m.why) throw new HttpError(403, `It can't run only on ${m.name}: ${m.why}`);
  return { machine: m.id, name: m.name };
}
