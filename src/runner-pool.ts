// One runner pool (Build 11, specs/one-runner-pool.md): Citadel sees every scheme's waiting CI jobs and places each on a
// machine that lends that scheme CI, can run it and has its room now. Piece P1 only watches: it keeps the books of every
// job it sees (the pool_jobs table), puts the waiting ones in line and says where it would start each ("would start X on
// Y"); nothing on any PC changes. P3 starts runners from the same placing.
//   - The line (Cara, 2026-11-27, #2264's card, Q2: "Citadel's ships first", "But dont make other schemes or even
//     non-ships wait too long, let them take turns, just prio ships and citadel"): Citadel's ships, then other schemes'
//     ships oldest first, then everything else, the scheme that has waited longest since its last start next. Every
//     MOVE_UP_MS a job has waited moves it up one step.
//   - Room (Cara, 2026-11-27: "if a machine doesnt have room, we can wait and load balance, not run the job starved"): a
//     job starts only where its size is free; a big job that has waited BIG_HOLD_MS holds the machine it waits for, so
//     smaller, later jobs stop starting there.
//   - The one thing GitHub decides: a runner made for job A may take job B of the same repo (P0, #2266). settle() keeps
//     the books by the job each runner really took.
// Pure but for RunnerPool, which reads ShipWatch's look (src/ci-ships.ts) and the store.
import { osOfLabel } from './ci-auto.ts';
import { runnerLabel } from './ci-runner.ts';
import { HEAVY_SIZES, heavyKind } from './heavy-place.ts';
import { COST, rank } from './machine-balancer.ts';

/** The pool's numbers, in one place: starting values (#2264), changed only here. */
export const POOL = {
  /** How often ShipWatch looks at every repo's runs (src/ci-ships.ts SHIP_POLL_MS). */
  pollMs: 15_000,
  /** Each this long a job has waited moves it up one step in the line. */
  moveUpMs: 10 * 60_000,
  /** A job too big for the room that opens up holds its machine after this long. */
  bigHoldMs: 2 * 60_000,
  /** A runner the pool started that took no job in this long is stopped and removed (P3 acts on it). */
  reapMs: 2 * 60_000,
  /** A running run's jobs are read again at least this often when GitHub says the run didn't change (API budget, P0). */
  runningMs: 60_000,
  /** Ended jobs' rows are kept this long. */
  keepMs: 14 * 24 * 3600_000,
  /** Threads a job counts as: a plain CI job, and a heavy kind by its `citadel-heavy-<kind>` label (an unknown kind as a build). */
  sizes: { ci: COST.ci, heavy: HEAVY_SIZES as Readonly<Record<string, number>>, heavyUnknown: HEAVY_SIZES.apk },
} as const;

export type Os = 'windows' | 'linux';

/** What a job needs of a machine, read from its labels (spec section 3, step 2): labels only describe the job now. */
export interface Needs {
  /** null: its labels name no Windows or Linux runner, so no machine is known to run it. */
  os: Os | null;
  /** A `<slug>-desktop` job runs inside the owner's logon session. */
  session: boolean;
  size: number;
}

/** A job's needs from its labels and its scheme's name (`self-hosted` and case ignored). */
export function needsOf(labels: readonly string[], schemeName: string): Needs {
  const ls = labels.map((l) => l.toLowerCase()).filter((l) => l !== 'self-hosted');
  const kind = heavyKind(ls);
  const size = kind ? (POOL.sizes.heavy[kind.kind] ?? POOL.sizes.heavyUnknown) : POOL.sizes.ci;
  const ci = runnerLabel(schemeName);
  const desktop = ci ? `${ci.replace(/-ci$/, '')}-desktop` : null;
  const session = !!desktop && ls.includes(desktop);
  let os: Os | null = session ? 'windows' : null;
  for (const l of ls) if (!os && l !== kind?.label) os = osOfLabel(schemeName, l);
  os ??= ls.includes('windows') ? 'windows' : ls.includes('linux') ? 'linux' : null;
  return { os, session, size };
}

/** A job waiting for a runner, as the line sees it. */
export interface PoolJob {
  /** owner/name, lowercase. */
  repo: string;
  /** The job's id on GitHub. */
  id: number;
  run: number;
  name: string;
  scheme: number;
  /** A ship's run (a `land/` branch). */
  ship: boolean;
  /** The scheme whose ships go first (Citadel's own). */
  first: boolean;
  /** When it was queued (ms). */
  since: number;
  needs: Needs;
}

/** A machine that lends CI, as the placer sees it. */
export interface PoolMachine {
  id: number;
  name: string;
  /** Its owner's order (null: none, after every one with an order). */
  priority: number | null;
  os: readonly Os[];
  /** A person is signed in there, for `-desktop` jobs. */
  session: boolean;
  /** The schemes its CI switch lends to. */
  schemes: readonly number[];
  /** Threads free for CI now: the owner's limit less what runs there, CI jobs and minion turns together. */
  free: number;
  /** Why it takes no new job now ("is offline", "is paused", P4's "Cara is in a game"); null: it may. */
  off: string | null;
}

export interface Placed {
  job: PoolJob;
  /** 1 for the first in line. */
  place: number;
  /** 0 Citadel's ships, 1 other ships, 2 the rest, after moving up for its wait. */
  step: number;
  /** Where it starts now; null: it waits, and `why` says why. */
  machine: number | null;
  why: string | null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A job's step: its kind's, less one each MOVE_UP_MS it has waited, never past the first. */
export function stepOf(job: Pick<PoolJob, 'ship' | 'first' | 'since'>, now: number): number {
  const base = job.ship ? (job.first ? 0 : 1) : 2;
  return Math.max(0, base - Math.floor(Math.max(0, now - job.since) / POOL.moveUpMs));
}

/**
 * The line: by step; ships (steps 0 and 1) oldest first; the rest taking turns between schemes, the one whose last
 * start is oldest (never: before any) next, each its own oldest job, and a scheme that goes moves to the back.
 */
export function line(jobs: readonly PoolJob[], now: number, lastStart: ReadonlyMap<number, number>): { job: PoolJob; step: number }[] {
  const old = (a: PoolJob, b: PoolJob) => a.since - b.since || a.id - b.id;
  const by = [0, 1, 2].map(() => [] as PoolJob[]);
  for (const j of jobs) by[stepOf(j, now)].push(j);
  const out = [...by[0].sort(old).map((job) => ({ job, step: 0 })), ...by[1].sort(old).map((job) => ({ job, step: 1 }))];
  const queues = new Map<number, PoolJob[]>();
  for (const j of by[2].sort(old)) (queues.get(j.scheme) ?? queues.set(j.scheme, []).get(j.scheme)!).push(j);
  // Each scheme's turn comes by its last start; its own oldest job breaks a tie (two never started).
  const turn = new Map([...queues.keys()].map((s) => [s, lastStart.get(s) ?? -Infinity]));
  let tick = now;
  while (queues.size) {
    const [s] = [...queues.keys()].sort((a, b) => turn.get(a)! - turn.get(b)! || old(queues.get(a)![0], queues.get(b)![0]));
    const q = queues.get(s)!;
    out.push({ job: q.shift()!, step: 2 });
    if (!q.length) queues.delete(s);
    turn.set(s, ++tick);
  }
  return out;
}

const OS_WORD: Record<Os, string> = { windows: 'Windows', linux: 'Linux' };

export interface PlaceIn {
  jobs: readonly PoolJob[];
  machines: readonly PoolMachine[];
  now: number;
  /** Each scheme's last start (ms), for taking turns. */
  lastStart: ReadonlyMap<number, number>;
  /** Each scheme's machine where its last job ran: its warm folder. */
  warm: ReadonlyMap<number, number>;
}

/**
 * Where each job in line starts now, and why each other one waits. A job goes to a machine that lends its scheme CI, runs
 * its OS (and session), isn't off, and has its size free; among those the owner's order, then the warm one, then the most
 * room (rank()). Room is taken as jobs are placed. A job that has waited BIG_HOLD_MS without room holds the machine it
 * waits for: no later job starts there in this look.
 */
export function place(i: PlaceIn): Placed[] {
  const free = new Map(i.machines.map((m) => [m.id, m.free]));
  const held = new Map<number, PoolJob>();
  const name = (id: number) => i.machines.find((m) => m.id === id)?.name ?? `machine ${id}`;
  return line(i.jobs, i.now, i.lastStart).map(({ job, step }, k): Placed => {
    const out = (machine: number | null, why: string | null): Placed => ({ job, place: k + 1, step, machine, why });
    const n = job.needs;
    const lent = i.machines.filter((m) => m.schemes.includes(job.scheme));
    if (!lent.length) return out(null, 'no machine lends CI to its scheme');
    if (!n.os) return out(null, 'its labels name no Windows or Linux runner (a `<scheme>-ci` or `<scheme>-ci-linux` label)');
    const can = lent.filter((m) => m.os.includes(n.os!) && (!n.session || m.session));
    if (!can.length) return out(null, n.session ? 'no machine lending its scheme CI has a person signed in on Windows' : `no machine lending its scheme CI runs ${OS_WORD[n.os]}`);
    const on = can.filter((m) => !m.off);
    if (!on.length) return out(null, can.map((m) => `${m.name} ${m.off}`).join('; '));
    const open = on.filter((m) => !held.has(m.id));
    if (!open.length) return out(null, `held for a bigger job ahead of it: ${[...new Set(on.map((m) => `${held.get(m.id)!.name} on ${m.name}`))].join(', ')}`);
    const warm = i.warm.get(job.scheme) ?? null;
    const [fit] = rank(
      open.filter((m) => free.get(m.id)! >= n.size).map((m) => ({ ...m, free: free.get(m.id)! })),
      { warm },
    );
    if (fit) {
      free.set(fit.id, free.get(fit.id)! - n.size);
      return out(fit.id, null);
    }
    // rank() leaves out machines with nothing free: one more thread each keeps their order and lets a full one be waited for.
    const [best] = rank(
      open.map((m) => ({ ...m, free: free.get(m.id)! + 1 })),
      { warm },
    );
    const room = `room on ${name(best.id)}: needs ${plural(n.size, 'thread')}, ${free.get(best.id)!} free`;
    if (i.now - job.since < POOL.bigHoldMs) return out(null, room);
    held.set(best.id, job);
    return out(null, `${room}; nothing smaller starts there meanwhile`);
  });
}

/** A runner the pool started (P3): for which job, on which machine. */
export interface PoolRunner {
  name: string;
  repo: string;
  machine: number;
  /** The job it was made for. */
  job: number;
  at: number;
}

/** A job of the repo GitHub says a runner runs, or ran. */
export interface Took {
  repo: string;
  id: number;
  runner: string;
}

/**
 * The books after a look (spec section 3, "The one thing GitHub still decides"): each runner holds the job it really
 * took, which may be another waiting job of its repo than the one it was made for (P0 saw it twice). A job whose runner
 * took another one is free to be placed again; a runner that took nothing in POOL.reapMs is to be stopped and removed.
 */
export function settle(runners: readonly PoolRunner[], took: readonly Took[], now: number): { holds: Map<string, { machine: number; job: number | null }>; free: number[]; reap: string[] } {
  const key = (repo: string, name: string) => `${repo.toLowerCase()}\0${name.toLowerCase()}`;
  const ran = new Map(took.map((t) => [key(t.repo, t.runner), t.id]));
  const holds = new Map<string, { machine: number; job: number | null }>();
  const reap: string[] = [];
  const held = new Set<number>();
  const pending: PoolRunner[] = [];
  for (const r of runners) {
    const id = ran.get(key(r.repo, r.name));
    if (id !== undefined) {
      holds.set(r.name, { machine: r.machine, job: id });
      held.add(id);
    } else if (now - r.at >= POOL.reapMs) reap.push(r.name);
    else pending.push(r);
  }
  // A swap: the job made for a runner that took another is still waiting, and a runner still waiting whose own job
  // was taken stands for that one instead, so no job is booked twice and none is lost.
  const spare = runners.filter((r) => ran.has(key(r.repo, r.name)) && !held.has(r.job)).map((r) => r.job);
  for (const r of pending) {
    const i = held.has(r.job) ? spare.findIndex((j) => runners.find((o) => o.job === j)?.repo.toLowerCase() === r.repo.toLowerCase()) : -1;
    const job = !held.has(r.job) ? r.job : i >= 0 ? spare.splice(i, 1)[0] : null;
    holds.set(r.name, { machine: r.machine, job });
    if (job !== null) held.add(job);
  }
  // The jobs made for runners that no runner holds now (a swap's leftover, a reaped runner's): placed again.
  const free = [...new Set(runners.map((r) => r.job))].filter((j) => !held.has(j));
  return { holds, free, reap };
}
