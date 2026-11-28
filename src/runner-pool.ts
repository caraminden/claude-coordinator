// One runner pool (Build 11, specs/one-runner-pool.md): Citadel sees every scheme's waiting CI jobs and places each on a
// machine that lends that scheme CI, can run it and has its room now. Piece P1 only watches: it keeps the books of every
// job it sees (the pool_jobs table), puts the waiting ones in line and says where it would start each ("would start X on
// Y"); nothing on any PC changes. P3 starts runners from the same placing, for the schemes switched to the pool (poolOn): a
// scheme is on the pool or on its standing runners, never both, and the standing runners' running jobs count as used room.
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
import { poolName, slotPrefix, MAX_SLOTS, type SlotReport } from './runner-slots.ts';

/**
 * The per-scheme switch (P3): a scheme whose setting is on has its CI jobs started by the pool, one one-job runner each, and
 * its standing runners taken off (src/ci-auto.ts); off, the default for every scheme, it keeps its standing runners. A
 * setting, not a column: P6 moves every scheme over and P7 drops the switch.
 */
export const poolKey = (scheme: number) => `ci_pool:${scheme}`;
export const poolOn = (store: { getSetting<T>(key: string): T | null }, scheme: number) => store.getSetting<boolean>(poolKey(scheme)) === true;

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
  /** A pool runner neither said to have taken a job nor seen on one in this long is forgotten: the agent's reaper stopped it at reapMs. */
  forgetMs: 3 * 60_000,
  /** A job whose runner didn't start is tried again after this long. */
  startAgainMs: 60_000,
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
  /** Its scheme's standing runners take it: placed to show where it would start, it takes no room and holds no machine. */
  standing?: boolean;
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
  const real = new Map(i.machines.map((m) => [m.id, m.free]));
  // A standing scheme's job is placed against the room as a watcher sees it, every job ahead of it taking some; only the
  // pool's own jobs take real room, so a standing scheme's never keeps a pool job from starting.
  const seen = new Map(real);
  const held = new Map<number, PoolJob>();
  const name = (id: number) => i.machines.find((m) => m.id === id)?.name ?? `machine ${id}`;
  return line(i.jobs, i.now, i.lastStart).map(({ job, step }, k): Placed => {
    const out = (machine: number | null, why: string | null): Placed => ({ job, place: k + 1, step, machine, why });
    const n = job.needs;
    const free = job.standing ? seen : real;
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
      seen.set(fit.id, seen.get(fit.id)! - n.size);
      if (!job.standing) real.set(fit.id, real.get(fit.id)! - n.size);
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
    if (i.now - job.since < POOL.bigHoldMs || job.standing) return out(null, room);
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
  /** Where it starts (a pool scheme's) or would start (a standing scheme's); null: it waits, `why` says why. */
  machine: string | null;
  why: string | null;
  /** Its scheme is on the pool, which starts it; false: its standing runners take it, and `machine` is only where the pool would. */
  pool: boolean;
  /** A runner was started for it and hasn't taken it yet (place 0: out of the line). */
  starting: boolean;
}

/** A job running on a machine, or a pool runner started there that hasn't taken its job yet, as the Machines page shows it. */
export interface PoolRunning {
  repo: string;
  scheme: number;
  name: string;
  size: number;
  /** When it started running, or its runner was started (ms). */
  since: number;
  /** A one-job runner of the pool's; false: a standing runner's job. */
  pool: boolean;
  starting: boolean;
}

/** A machine lending CI: its room in threads, and what runs there. */
export interface PoolMachineView {
  id: number;
  name: string;
  limit: number;
  used: number;
  free: number;
  off: string | null;
  running: PoolRunning[];
}

export interface PoolView {
  at: number;
  /** Every waiting job, in line order; the ones whose runner is starting first, at place 0. */
  line: PoolLineJob[];
  machines: PoolMachineView[];
  /** Nothing can be started (no start wired): the line only says what would be. */
  watching: boolean;
}

type Open = { repo: string; id: number; run: number; scheme: number; name: string; size: number; runner: string | null; ranOn: number | null; startedAt: number | null };

/** A one-job runner the pool started, until its agent says it ended or stopped, its job ends, or it is forgotten. */
type Started = PoolRunner & { scheme: number; os: Os; slot: number; size: number; jobName: string; took: boolean; ran: boolean };

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
  /** The scheme's switch is on (poolOn); left out, none is. */
  pooled?(scheme: number): boolean;
  /** The repo still has standing runners on a PC (src/ci-auto.ts is taking them off): none of its jobs start until they're gone, so a scheme is never on both. */
  standing?(repo: string): boolean;
  /** Start one one-job runner (src/runner-slots.ts RunnerSlots.start); rejects, or answers ok false, when it didn't start. Left out, the pool only watches. */
  start?(ask: { repo: string; scheme: number; machine: number; os: Os; slot: number; labels: string[]; job: number }): Promise<{ name: string; ok: boolean; output: string }>;
}

/** The lowest slot not in `busy`, so the warmest folder is reused; null when all MAX_SLOTS are. */
export function freeSlot(busy: ReadonlySet<number>): number | null {
  for (let n = 1; n <= MAX_SLOTS; n++) if (!busy.has(n)) return n;
  return null;
}

/**
 * The pool. Each ShipWatch look (`pass`) keeps the books of the jobs seen, puts the waiting ones in line and places them.
 * A pool scheme's placed job gets a one-job runner started on its machine, in the lowest free slot of that scheme there; a
 * standing scheme's is only logged as "would start X on Y" (P1's watching), and takes no room: its standing runners run it,
 * and the room it uses then is counted from the job running there, as every running job's is.
 */
export class RunnerPool {
  private d: PoolDeps;
  private open: Map<string, Open> | null = null;
  private lastStart = new Map<number, number>();
  private warm = new Map<number, number>();
  private said = new Map<string, number>();
  private started = new Map<string, Started>();
  /** A job whose runner didn't start: not tried again before `until`, and `why` says what went wrong. */
  private failed = new Map<string, { until: number; why: string }>();
  private current: PoolView = { at: 0, line: [], machines: [], watching: true };

  constructor(d: PoolDeps) {
    this.d = d;
  }

  view(): PoolView {
    return this.current;
  }

  /** The machines that could take the scheme's jobs now: lending it CI, online and not off. For CI health's "fine" (a pool scheme has no standing runner to be online). */
  able(scheme: number): string[] {
    return this.d
      .machines()
      .filter((m) => m.schemes.includes(scheme) && !m.off)
      .map((m) => m.name);
  }

  /** An agent's word on a slot (src/runner-slots.ts onReport): a runner that took its job keeps its room until it is seen running; one that ended or stopped is gone. */
  onSlot(r: Pick<SlotReport, 'runner' | 'event'>) {
    const rec = this.started.get(r.runner);
    if (!rec) return;
    if (r.event === 'took') rec.took = true;
    else if (r.event === 'ended' || r.event === 'stopped') this.started.delete(r.runner);
  }

  pass(sight: PoolSight): PoolView {
    const now = this.d.now();
    if (!this.open) {
      this.open = new Map(this.d.store.poolOpen().map((r) => [`${r.repo}#${r.job_id}`, { repo: r.repo, id: r.job_id, run: r.run_id, scheme: r.project_id ?? 0, name: r.name, size: r.size, runner: r.runner, ranOn: r.ran_on, startedAt: r.started_at }]));
      for (const r of this.d.store.poolLastStarts()) {
        this.lastStart.set(r.project_id, r.at);
        if (r.machine !== null) this.warm.set(r.project_id, r.machine);
      }
    }
    const open = this.open;
    const pcs = this.d.machines();
    const look: PoolLook = { seen: [], ran: [], placed: [], ended: [], at: now };
    const first = this.d.first()?.toLowerCase() ?? null;
    const waiting: PoolJob[] = [];
    const listed = new Set<string>();
    /** A pool scheme's job that won't start for a reason of its own (the reason shown instead of a place). */
    const held = new Map<string, string>();
    for (const j of sight.jobs) {
      const s = this.d.scheme(j.repo);
      if (!s) continue;
      const key = `${j.repo}#${j.id}`;
      listed.add(key);
      const needs = needsOf(j.labels, s.name);
      const ship = j.ship;
      let o = this.open.get(key);
      if (!o) {
        o = { repo: j.repo, id: j.id, run: j.run, scheme: s.id, name: j.name, size: needs.size, runner: null, ranOn: null, startedAt: null };
        this.open.set(key, o);
        look.seen.push({ repo: j.repo, job_id: j.id, run_id: j.run, project_id: s.id, name: j.name, labels: JSON.stringify(j.labels), size: needs.size, ship: ship ? 1 : 0, first_seen: now });
      }
      if (j.status === 'in_progress' && j.runner && j.runner !== o.runner) {
        o.runner = j.runner;
        o.ranOn = machineOfRunner(j.runner, pcs);
        o.startedAt = now;
        look.ran.push({ repo: j.repo, job_id: j.id, runner: j.runner, ran_on: o.ranOn, started_at: now });
        this.lastStart.set(s.id, now);
        if (o.ranOn !== null) this.warm.set(s.id, o.ranOn);
      }
      if (j.status !== 'queued') continue;
      const pooled = !!this.d.start && (this.d.pooled?.(s.id) ?? false);
      if (pooled && this.d.standing?.(j.repo)) held.set(key, "its standing runners are still being taken off; the pool starts its jobs once they're gone");
      // shortcut: a desktop job's runner needs the owner's logon session, which a slot isn't (src/runner-slots.ts refuses it); P6 starts those.
      else if (pooled && needs.session) held.set(key, 'a desktop job needs a runner in the signed-in session, which the pool starts from P6 on');
      waiting.push({ repo: j.repo, id: j.id, run: j.run, name: j.name, scheme: s.id, ship, first: ship && j.repo === first, since: Number.isFinite(j.created) ? j.created : now, needs, standing: !pooled || held.has(key) });
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
    // The pool's own runners: which job each holds now (a same-repo swap included, settle()), and which are done with.
    const took: Took[] = [...this.open.values()].flatMap((o) => (o.runner ? [{ repo: o.repo, id: o.id, runner: o.runner }] : []));
    const onJob = new Set(took.map((t) => t.runner.toLowerCase()));
    const { holds } = settle([...this.started.values()], took, now);
    const covered = new Map<string, Started>();
    for (const r of [...this.started.values()]) {
      const running = onJob.has(r.name);
      // Seen on a job that has since ended, or never on one long after the agent's own reaper would have stopped it.
      if ((r.ran && !running) || (!running && !r.took && now - r.at >= POOL.forgetMs)) {
        this.started.delete(r.name);
        continue;
      }
      if (running) r.ran = true;
      else {
        const job = holds.get(r.name)?.job;
        if (job != null) covered.set(`${r.repo}#${job}`, r);
      }
    }
    // CI's room in use on each machine: the jobs running there now by their size (standing runners' too), and the pool's runners not on one yet.
    const usedNow = () => {
      const used = new Map<number, number>();
      const add = (m: number, n: number) => used.set(m, (used.get(m) ?? 0) + n);
      for (const o of open.values()) if (o.runner && o.ranOn !== null) add(o.ranOn, o.size);
      for (const r of this.started.values()) if (!onJob.has(r.name)) add(r.machine, r.size);
      return used;
    };
    const used = usedNow();
    const machines = pcs.map(({ hosts: _, ...m }) => ({ ...m, free: Math.max(0, m.limit - (used.get(m.id) ?? 0)) }));
    const placed = place({ jobs: waiting.filter((j) => !covered.has(`${j.repo}#${j.id}`)), machines, now, lastStart: this.lastStart, warm: this.warm });
    const nameOf = (id: number | null) => (id === null ? null : (machines.find((m) => m.id === id)?.name ?? `machine ${id}`));
    const labelsOf = (repo: string, id: number) => sight.jobs.find((j) => j.repo === repo && j.id === id)?.labels ?? [];
    for (const [k, f] of [...this.failed]) if (f.until <= now || !listed.has(k)) this.failed.delete(k);
    const said = new Map<string, number>();
    for (const p of placed) {
      const key = `${p.job.repo}#${p.job.id}`;
      if (held.has(key)) {
        p.machine = null;
        p.why = held.get(key)!;
        continue;
      }
      if (p.machine === null) continue;
      if (!p.job.standing) {
        const f = this.failed.get(key);
        if (f) {
          p.machine = null;
          p.why = f.why;
          continue;
        }
        const r = this.begin(p.job, p.machine, labelsOf(p.job.repo, p.job.id), now);
        if (r) {
          look.placed.push({ repo: p.job.repo, job_id: p.job.id, machine: p.machine });
          covered.set(key, r);
        } else p.why = `every slot of its scheme on ${nameOf(p.machine)} is busy`;
        p.machine = null;
        continue;
      }
      said.set(key, p.machine);
      if (this.said.get(key) === p.machine) continue;
      look.placed.push({ repo: p.job.repo, job_id: p.job.id, machine: p.machine });
      this.d.log(`Runner pool (watching): would start ${p.job.repo} "${p.job.name}" (job ${p.job.id}${p.job.ship ? ', a ship' : ''}) on ${nameOf(p.machine)}, place ${p.place} of ${placed.length}`);
    }
    this.said = said;
    if (look.seen.length || look.ran.length || look.placed.length || look.ended.length) this.d.store.poolLook(look);
    const lineJob = (j: PoolJob, o: { place: number; step: number; machine: string | null; why: string | null; starting: boolean }): PoolLineJob => ({
      repo: j.repo,
      scheme: j.scheme,
      id: j.id,
      run: j.run,
      name: j.name,
      labels: labelsOf(j.repo, j.id),
      ship: j.ship,
      since: j.since,
      size: j.needs.size,
      pool: !j.standing || held.has(`${j.repo}#${j.id}`),
      ...o,
    });
    const after = usedNow();
    const startingJobs = waiting.filter((j) => covered.has(`${j.repo}#${j.id}`));
    this.current = {
      at: now,
      watching: !this.d.start,
      line: [
        ...startingJobs.map((j) => lineJob(j, { place: 0, step: stepOf(j, now), machine: nameOf(covered.get(`${j.repo}#${j.id}`)!.machine), why: null, starting: true })),
        ...placed.filter((p) => !covered.has(`${p.job.repo}#${p.job.id}`)).map((p, k) => lineJob(p.job, { place: k + 1, step: p.step, machine: nameOf(p.machine), why: p.why, starting: false })),
      ],
      machines: machines.map((m) => ({
        id: m.id,
        name: m.name,
        limit: m.limit,
        used: after.get(m.id) ?? 0,
        free: Math.max(0, m.limit - (after.get(m.id) ?? 0)),
        off: m.off,
        running: [
          ...[...open.values()].filter((o) => o.runner && o.ranOn === m.id).map((o) => ({ repo: o.repo, scheme: o.scheme, name: o.name, size: o.size, since: o.startedAt ?? now, pool: o.runner!.toLowerCase().startsWith('pool-'), starting: false })),
          ...[...this.started.values()].filter((r) => r.machine === m.id && !onJob.has(r.name)).map((r) => ({ repo: r.repo, scheme: r.scheme, name: r.jobName, size: r.size, since: r.at, pool: true, starting: true })),
        ],
      })),
    };
    return this.current;
  }

  /** Start a one-job runner for `job` on `machine` in its scheme's lowest free slot there, booked at once so the next look doesn't start a second; null when every slot is busy. */
  private begin(job: PoolJob, machine: number, labels: string[], now: number): Started | null {
    const os = job.needs.os!;
    const prefix = (n: number) => slotPrefix(machine, os, n);
    const busy = new Set<number>();
    for (const r of this.started.values()) if (r.scheme === job.scheme && r.machine === machine && r.os === os) busy.add(r.slot);
    for (const o of this.open!.values()) {
      if (o.scheme !== job.scheme || !o.runner) continue;
      for (let n = 1; n <= MAX_SLOTS; n++) if (o.runner.toLowerCase().startsWith(prefix(n))) busy.add(n);
    }
    const slot = freeSlot(busy);
    if (slot === null) return null;
    const name = poolName(machine, os, slot, job.id);
    const rec: Started = { name, repo: job.repo, machine, job: job.id, labels, at: now, scheme: job.scheme, os, slot, size: job.needs.size, jobName: job.name, took: false, ran: false };
    this.started.set(name, rec);
    this.lastStart.set(job.scheme, now);
    const key = `${job.repo}#${job.id}`;
    const fail = (why: string) => {
      this.started.delete(name);
      this.failed.set(key, { until: this.d.now() + POOL.startAgainMs, why: `its runner didn't start (${why.slice(0, 200)}); trying again shortly` });
      this.d.log(`Runner pool: couldn't start ${name} for ${job.repo} "${job.name}" (job ${job.id}): ${why}`);
    };
    this.d.log(`Runner pool: starting ${name} for ${job.repo} "${job.name}" (job ${job.id}${job.ship ? ', a ship' : ''})`);
    this.d.start!({ repo: job.repo, scheme: job.scheme, machine, os, slot, labels, job: job.id }).then(
      (r) => {
        if (!r.ok) fail(r.output.trim().split('\n').at(-1) || 'the agent refused');
      },
      (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
    );
    return rec;
  }
}
