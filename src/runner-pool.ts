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
import type { PoolSight } from './ci-ships.ts';
import type { PoolLook, PoolRow } from './db/runner-pool.ts';

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
  /** Threads CI may use there at most: the owner's CI limit, less the minion turns running there. */
  limit: number;
  /** Threads free for CI now: `limit` less the CI jobs running there. */
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
    // The held job isn't named: it may be another scheme's, which this job's people can't see.
    if (!open.length) return out(null, `held for a bigger job ahead of it on ${on.map((m) => m.name).join(', ')}`);
    const warm = i.warm.get(job.scheme) ?? null;
    const [fit] = rank(
      open.filter((m) => free.get(m.id)! >= n.size).map((m) => ({ ...m, free: free.get(m.id)! })),
      { warm },
    );
    if (fit) {
      free.set(fit.id, free.get(fit.id)! - n.size);
      return out(fit.id, null);
    }
    // Only a machine whose whole limit fits it is waited for (held): holding one it can never fit would starve it.
    const big = open.filter((m) => m.limit >= n.size);
    if (!big.length) return out(null, `too big for now: needs ${plural(n.size, 'thread')}, and the most CI may use on any machine for it is ${Math.max(...open.map((m) => m.limit))}`);
    // rank() leaves out machines with nothing free: one more thread each keeps their order and lets a full one be waited for.
    const [best] = rank(
      big.map((m) => ({ ...m, free: free.get(m.id)! + 1 })),
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
  /** Its labels, the job's: a swap is only with a job that asks for the same ones. */
  labels: readonly string[];
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
  const kind = (r: PoolRunner) =>
    `${r.repo.toLowerCase()}\0${[...r.labels]
      .map((l) => l.toLowerCase())
      .sort()
      .join(',')}`;
  const spare = runners.filter((r) => ran.has(key(r.repo, r.name)) && !held.has(r.job));
  for (const r of pending) {
    const i = held.has(r.job) ? spare.findIndex((o) => kind(o) === kind(r)) : -1;
    const job = !held.has(r.job) ? r.job : i >= 0 ? spare.splice(i, 1)[0].job : null;
    holds.set(r.name, { machine: r.machine, job });
    if (job !== null) held.add(job);
  }
  // The jobs made for runners that no runner holds now (a swap's leftover, a reaped runner's): placed again.
  const free = [...new Set(runners.map((r) => r.job))].filter((j) => !held.has(j));
  return { holds, free, reap };
}

/** A machine that lends CI, as the server knows it; the pool takes what CI runs there off `limit` to get its free room. */
export interface PoolPc extends Omit<PoolMachine, 'free'> {
  /** Its runner agents' hostnames: a runner's name starts with one. */
  hosts: readonly string[];
}

/** One job in the line, as the CI page shows it. */
export interface PoolLineJob {
  repo: string;
  scheme: number;
  id: number;
  run: number;
  name: string;
  labels: string[];
  ship: boolean;
  since: number;
  size: number;
  place: number;
  step: number;
  /** The machine it would start on now (P1 starts nothing); null: it waits, `why` says why. */
  machine: string | null;
  why: string | null;
}

export interface PoolView {
  at: number;
  /** Every waiting job, in line order. */
  line: PoolLineJob[];
  /** P1: nothing is started; the line says what would be. */
  watching: true;
}

type Open = { repo: string; id: number; run: number; scheme: number; size: number; runner: string | null; ranOn: number | null };

/** Which machine a runner is on: a pool slot's `pool-m<id>-` (P2's src/runner-slots.ts), else the hostname its name starts with (the longest that fits). */
export function machineOfRunner(runner: string, pcs: readonly Pick<PoolPc, 'id' | 'hosts'>[]): number | null {
  const name = runner.toLowerCase();
  const slot = /^pool-m(\d+)-/.exec(name);
  if (slot) return pcs.find((p) => p.id === Number(slot[1]))?.id ?? null;
  let best: { id: number; len: number } | null = null;
  for (const p of pcs) for (const h of p.hosts.map((x) => x.toLowerCase())) if (h && (name === h || name.startsWith(`${h}-`)) && h.length > (best?.len ?? 0)) best = { id: p.id, len: h.length };
  return best?.id ?? null;
}

export interface PoolDeps {
  /** The scheme that has the repo (id and name, for its labels); null: none, so its jobs aren't the pool's. */
  scheme(repo: string): { id: number; name: string } | null;
  /** owner/name of the repo whose ships go first (Citadel's own), lowercase; null when unknown. */
  first(): string | null;
  machines(): PoolPc[];
  store: { poolLook(look: PoolLook): void; poolOpen(): PoolRow[]; poolLastStarts(): { project_id: number; at: number; machine: number | null }[] };
  log(line: string): void;
  now(): number;
}

/**
 * The pool, watching only (P1): each ShipWatch look (`pass`) keeps the books of the jobs seen, puts the waiting ones in line
 * and places them, and logs "would start X on Y" once for each job's new place. Nothing is started anywhere.
 */
export class RunnerPool {
  private d: PoolDeps;
  private open: Map<string, Open> | null = null;
  private lastStart = new Map<number, number>();
  private warm = new Map<number, number>();
  private said = new Map<string, number>();
  private current: PoolView = { at: 0, line: [], watching: true };

  constructor(d: PoolDeps) {
    this.d = d;
  }

  view(): PoolView {
    return this.current;
  }

  pass(sight: PoolSight): PoolView {
    const now = this.d.now();
    if (!this.open) {
      this.open = new Map(this.d.store.poolOpen().map((r) => [`${r.repo}#${r.job_id}`, { repo: r.repo, id: r.job_id, run: r.run_id, scheme: r.project_id ?? 0, size: r.size, runner: r.runner, ranOn: r.ran_on }]));
      for (const r of this.d.store.poolLastStarts()) {
        this.lastStart.set(r.project_id, r.at);
        if (r.machine !== null) this.warm.set(r.project_id, r.machine);
      }
    }
    const pcs = this.d.machines();
    const look: PoolLook = { seen: [], ran: [], placed: [], ended: [], at: now };
    const first = this.d.first()?.toLowerCase() ?? null;
    const waiting: PoolJob[] = [];
    const listed = new Set<string>();
    for (const j of sight.jobs) {
      const s = this.d.scheme(j.repo);
      if (!s) continue;
      const key = `${j.repo}#${j.id}`;
      listed.add(key);
      const needs = needsOf(j.labels, s.name);
      const ship = j.ship;
      let o = this.open.get(key);
      if (!o) {
        o = { repo: j.repo, id: j.id, run: j.run, scheme: s.id, size: needs.size, runner: null, ranOn: null };
        this.open.set(key, o);
        look.seen.push({ repo: j.repo, job_id: j.id, run_id: j.run, project_id: s.id, name: j.name, labels: JSON.stringify(j.labels), size: needs.size, ship: ship ? 1 : 0, first_seen: now });
      }
      if (j.status === 'in_progress' && j.runner && j.runner !== o.runner) {
        o.runner = j.runner;
        o.ranOn = machineOfRunner(j.runner, pcs);
        look.ran.push({ repo: j.repo, job_id: j.id, runner: j.runner, ran_on: o.ranOn, started_at: now });
        this.lastStart.set(s.id, now);
        if (o.ranOn !== null) this.warm.set(s.id, o.ranOn);
      }
      if (j.status === 'queued') waiting.push({ repo: j.repo, id: j.id, run: j.run, name: j.name, scheme: s.id, ship, first: ship && j.repo === first, since: Number.isFinite(j.created) ? j.created : now, needs });
    }
    // A job no longer listed ended: its run is gone from the queued and running lists, or its run's jobs were read without
    // it. One whose run is listed but whose jobs weren't read (past the first queued runs) stays open.
    for (const [key, o] of [...this.open]) {
      if (listed.has(key) || !sight.repos.has(o.repo)) continue;
      const run = `${o.repo}#${o.run}`;
      if (sight.runs.has(run) && !sight.known.has(run)) continue;
      look.ended.push({ repo: o.repo, job_id: o.id });
      this.open.delete(key);
    }
    // CI's room in use on each machine: the jobs running there now, by their size.
    const used = new Map<number, number>();
    for (const o of this.open.values()) if (o.runner && o.ranOn !== null) used.set(o.ranOn, (used.get(o.ranOn) ?? 0) + o.size);
    const machines = pcs.map(({ hosts: _, ...m }) => ({ ...m, free: Math.max(0, m.limit - (used.get(m.id) ?? 0)) }));
    const placed = place({ jobs: waiting, machines, now, lastStart: this.lastStart, warm: this.warm });
    const nameOf = (id: number | null) => (id === null ? null : (machines.find((m) => m.id === id)?.name ?? `machine ${id}`));
    const said = new Map<string, number>();
    for (const p of placed) {
      if (p.machine === null) continue;
      const key = `${p.job.repo}#${p.job.id}`;
      said.set(key, p.machine);
      if (this.said.get(key) === p.machine) continue;
      look.placed.push({ repo: p.job.repo, job_id: p.job.id, machine: p.machine });
      this.d.log(`Runner pool (watching): would start ${p.job.repo} "${p.job.name}" (job ${p.job.id}${p.job.ship ? ', a ship' : ''}) on ${nameOf(p.machine)}, place ${p.place} of ${placed.length}`);
    }
    this.said = said;
    if (look.seen.length || look.ran.length || look.placed.length || look.ended.length) this.d.store.poolLook(look);
    this.current = {
      at: now,
      watching: true,
      line: placed.map((p) => ({
        repo: p.job.repo,
        scheme: p.job.scheme,
        id: p.job.id,
        run: p.job.run,
        name: p.job.name,
        labels: sight.jobs.find((j) => j.repo === p.job.repo && j.id === p.job.id)?.labels ?? [],
        ship: p.job.ship,
        since: p.job.since,
        size: p.job.needs.size,
        place: p.place,
        step: p.step,
        machine: nameOf(p.machine),
        why: p.why,
      })),
    };
    return this.current;
  }
}
