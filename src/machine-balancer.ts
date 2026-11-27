// One balancer per machine (Build 7 M6, specs/machine-connections.md section 6): each connected machine's room, in
// threads, split across what it does. Josh, 2026-11-25: "coordinate the load balancing across all the jobs a machine can
// do, so if there is CI to run, we use less workers, or more workers, maybe we hold off on a build until the worker count
// drops", and his picks "A · Waiting CI shrinks the workers" and "Q1 What a heavy job waits on: Its size to be free":
//   1. a ship's tests there go first (#1902; the line's ships() block stays its strongest case);
//   2. each CI job waiting for this PC's runners takes one worker's room: no new turn starts there until it runs;
//   3. a heavy job declares its size; no new turn starts while it waits; it starts once its size is free, or after
//      HEAVY_WAIT_MS anyway (as any other job: lowering its priority is the agent's, M6b);
//   4. the owner's caps are the ceiling for every role. Running turns are never stopped, and the workers grow back on
//      Auto's clock (src/turn-line.ts tickMachines), never at once.
// Perigee keeps today's rules (Josh, "Machines only for now"). The counts are the choices page's: a turn 3 threads, a CI
// job 4, a ship's run 6, an APK or desktop build 8. Pure but for MachineBalancer, which holds the heavy jobs waiting.

/** Threads each kind of work is counted as (the choices page's slider board). */
export const COST = { turn: 3, ci: 4, ship: 6 } as const;
/** Heavy jobs' sizes in threads when they don't say (spec section 6: an APK build 8, a Windows test run 4). */
export const HEAVY = { apk: 8, desktop: 8, windows: 4, gpu: 4 } as const;
/** A heavy job that has waited this long starts anyway. */
export const HEAVY_WAIT_MS = 30 * 60_000;

export interface HeavyJob {
  key: string;
  /** What people read: "APK build", "GPU job 12". */
  label: string;
  size: number;
  since: number;
  /** It has started there and holds its size. */
  running?: true;
}

export interface BalanceIn {
  /** The PC's threads, as its agent reported them; the owner's threads caps come in `caps`. */
  threads: number;
  /** The owner's caps: the most workers, CI runners, and threads for turns and for CI (null: none set). */
  caps: { workers: number | null; runners: number | null; turnThreads: number | null; ciThreads: number | null };
  /** A ship's tests run there now. */
  ship: boolean;
  /** CI jobs queued for runners this PC serves. */
  ciWaiting: number;
  /** Minion turns running there now. */
  running: number;
  heavy: readonly HeavyJob[];
  now: number;
}

export interface Plan {
  /** The most minion workers there: the line starts no turn past it. Running ones are never stopped. */
  workers: number;
  /** CI runners to keep awake (the runner agent applies it; M6's second half). */
  runners: number;
  /** CI jobs that fit now. */
  ci: number;
  /** The heavy jobs that may start now (keys), and those starting only because they waited HEAVY_WAIT_MS. */
  start: string[];
  late: string[];
  /** Why the workers are under the owner's cap, for the Workers tile's row ("2 CI jobs waiting"); null: they aren't. */
  why: string | null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The split, rule by rule (the choices page's take A). */
export function balance(i: BalanceIn): Plan {
  const T = Math.max(0, i.threads);
  const ship = i.ship ? COST.ship : 0;
  const heavyRunning = i.heavy.filter((h) => h.running).reduce((n, h) => n + h.size, 0);
  // Ships first, then the heavy jobs already going: neither is ever squeezed.
  let free = T - ship - heavyRunning;
  const ciRoom = i.caps.ciThreads === null ? free : Math.min(free, i.caps.ciThreads);
  const ci = Math.max(0, Math.min(i.ciWaiting, Math.floor(ciRoom / COST.ci), i.caps.runners ?? Infinity));
  free -= ci * COST.ci;
  const waiting = i.heavy.filter((h) => !h.running).sort((a, b) => a.since - b.since);
  // The oldest one waiting keeps its size free of new turns (not one past its wait: that one starts anyway).
  const reserve = waiting.find((h) => i.now - h.since < HEAVY_WAIT_MS)?.size ?? 0;
  const turnRoom = i.caps.turnThreads === null ? free - reserve : Math.min(free - reserve, i.caps.turnThreads);
  const most = i.caps.workers ?? Infinity;
  const workers = Math.max(0, Math.min(most, Math.floor(turnRoom / COST.turn)));
  // Now, with the turns that run: a heavy job takes what is free, in the order they asked.
  let now = T - ship - heavyRunning - ci * COST.ci - i.running * COST.turn;
  const start: string[] = [];
  const late: string[] = [];
  for (const h of waiting) {
    if (h.size <= now) {
      start.push(h.key);
      now -= h.size;
    } else if (i.now - h.since >= HEAVY_WAIT_MS) late.push(h.key);
    else break; // first come first served: a smaller one behind it doesn't jump the queue
  }
  // CI goes before new turns, so its runners stay awake for all of CI's room, not what the turns leave.
  const runners = Math.max(0, Math.min(i.caps.runners ?? Infinity, Math.floor(ciRoom / COST.ci)));
  const whys: string[] = [];
  const shrunk = workers < Math.min(most, Math.floor((i.caps.turnThreads ?? T) / COST.turn));
  if (shrunk) {
    if (ship) whys.push("a ship's tests run here");
    if (ci) whys.push(`${plural(ci, 'CI job')} waiting`);
    if (reserve) whys.push(`${waiting.find((h) => h.size === reserve)!.label} waits for ${reserve} threads`);
    if (heavyRunning)
      whys.push(
        `${i.heavy
          .filter((h) => h.running)
          .map((h) => h.label)
          .join(', ')} running`,
      );
  }
  return { workers, runners, ci, start, late, why: whys.length ? whys.join('; ') : null };
}

/**
 * Threads free there now for one more heavy job (H2's place()): what the ships, every heavy job held or waiting, the CI
 * that fits and the turns running leave. Never below 0.
 */
export function freeThreads(i: BalanceIn): number {
  const heavy = i.heavy.reduce((n, h) => n + h.size, 0);
  return Math.max(0, i.threads - (i.ship ? COST.ship : 0) - heavy - balance(i).ci * COST.ci - i.running * COST.turn);
}

/** A machine as the ranking sees it: its owner's order (null: none), and the room it has now. */
export interface Rankable {
  id: number;
  priority: number | null;
  /** Workers (or threads) free there now. */
  free: number;
}

/**
 * Where a job goes among the machines that may take it now (Josh, 2026-11-25: "put work on machine 1 before using
 * machine 2"): one marked for a machine goes there; else the owner's highest priority with room, filled to its budget
 * before the next; among equal priority, where it last ran while it has room (warm caches), else the most room.
 * A machine with no order stands after every one with an order. Those with no room are left out.
 */
export function rank<T extends Rankable>(machines: readonly T[], opts: { mark?: number | null; warm?: number | null } = {}): T[] {
  const open = machines.filter((m) => m.free > 0 && (opts.mark == null || m.id === opts.mark));
  const order = (m: T) => m.priority ?? Infinity;
  return [...open].sort((a, b) => order(a) - order(b) || Number(b.id === opts.warm) - Number(a.id === opts.warm) || b.free - a.free || a.id - b.id);
}

export interface BalancerDeps {
  /** The machines the balancer runs for: every owned machine (one away keeps its last report's plan, unused); perigee is never one. */
  machines: () => number[];
  input: (machineId: number) => Omit<BalanceIn, 'heavy' | 'now'> | null;
  /** The plans changed: the line looks again (a target rose), and waiting heavy jobs ask again. */
  changed: (machineIds: number[]) => void;
  log?: (line: string) => void;
  now: () => number;
}

/** Each machine's plan, every TICK_MS and on demand, and the heavy jobs waiting for their size there. */
export class MachineBalancer {
  static readonly TICK_MS = 10_000;
  private d: BalancerDeps;
  private heavy = new Map<number, Map<string, HeavyJob>>();
  private plans = new Map<number, Plan>();

  constructor(d: BalancerDeps) {
    this.d = d;
  }

  /** The machine's plan now; null where the balancer has no say (no report of its threads yet). */
  plan(machineId: number): Plan | null {
    const input = this.d.input(machineId);
    if (!input || input.threads <= 0) return null;
    return balance({ ...input, heavy: [...(this.heavy.get(machineId)?.values() ?? [])], now: this.d.now() });
  }

  /**
   * A heavy job asks to start there: 'start' (it now holds its size until done()), 'late' (it waited HEAVY_WAIT_MS and
   * starts anyway), or 'wait' (it is held, and no new turn starts there meanwhile). Ask again each tick.
   */
  ask(machineId: number, job: { key: string; label: string; size: number }): 'start' | 'late' | 'wait' {
    const jobs = this.heavy.get(machineId) ?? new Map<string, HeavyJob>();
    this.heavy.set(machineId, jobs);
    const had = jobs.get(job.key);
    if (had?.running) return 'start';
    jobs.set(job.key, { ...job, since: had?.since ?? this.d.now() });
    const plan = this.plan(machineId);
    if (plan) this.plans.set(machineId, plan);
    const go = !plan || plan.start.includes(job.key) ? 'start' : plan.late.includes(job.key) ? 'late' : 'wait';
    if (go !== 'wait') jobs.set(job.key, { ...jobs.get(job.key)!, running: true });
    return go;
  }

  /** A job already running there (found again after a server restart) holds its size, whatever the plan. */
  hold(machineId: number, job: { key: string; label: string; size: number }) {
    const jobs = this.heavy.get(machineId) ?? new Map<string, HeavyJob>();
    this.heavy.set(machineId, jobs);
    if (jobs.get(job.key)?.running) return;
    jobs.set(job.key, { ...job, since: this.d.now(), running: true });
    this.d.changed([machineId]);
  }

  /** Threads that running jobs whose key starts with `prefix` hold there (a role's threads cap, checked at the start). */
  holding(machineId: number, prefix: string): number {
    return [...(this.heavy.get(machineId)?.values() ?? [])].filter((h) => h.running && h.key.startsWith(prefix)).reduce((n, h) => n + h.size, 0);
  }

  /** Every job there whose key starts with `prefix` ended or stopped waiting, but `keep`. */
  release(machineId: number, prefix: string, keep: string | null) {
    const jobs = this.heavy.get(machineId);
    let gone = false;
    for (const key of [...(jobs?.keys() ?? [])]) if (key.startsWith(prefix) && key !== keep) gone = jobs!.delete(key) || gone;
    if (gone) this.d.changed([machineId]);
  }

  /**
   * Threads free there for one more heavy job (freeThreads), and no more than `cap` less what jobs whose key starts with
   * `prefix` hold or wait for there (a role's own threads cap); null where the balancer has no say.
   */
  free(machineId: number, cap: number | null = null, prefix = ''): number | null {
    const input = this.d.input(machineId);
    if (!input || input.threads <= 0) return null;
    const heavy = [...(this.heavy.get(machineId)?.values() ?? [])];
    const free = freeThreads({ ...input, heavy, now: this.d.now() });
    if (cap === null) return free;
    return Math.max(0, Math.min(free, cap - heavy.filter((h) => h.key.startsWith(prefix)).reduce((n, h) => n + h.size, 0)));
  }

  /** The plan as the last step (or a heavy job's ask) left it: what the line reads, many times a second, without asking the store. */
  current(machineId: number): Plan | null {
    return this.plans.get(machineId) ?? null;
  }

  /** It ended, or stopped waiting: its size is free. For jobs run outside the server, which know only their key (M6b). */
  done(key: string) {
    for (const [id, jobs] of this.heavy) if (jobs.delete(key)) this.d.changed([id]);
  }

  /** The 10 s step: each machine's plan again; those whose plan moved are told, and a change of why is logged once. */
  tick() {
    const moved: number[] = [];
    const ids = new Set(this.d.machines());
    // A removed machine's number may come to another one.
    for (const id of [...this.plans.keys()]) if (!ids.has(id)) this.plans.delete(id);
    for (const id of [...this.heavy.keys()]) if (!ids.has(id)) this.heavy.delete(id);
    for (const id of ids) {
      const plan = this.plan(id);
      const was = this.plans.get(id);
      if (!plan) {
        if (was) this.plans.delete(id);
        continue;
      }
      this.plans.set(id, plan);
      if (!was || was.workers !== plan.workers || was.runners !== plan.runners || was.start.join() !== plan.start.join() || was.late.join() !== plan.late.join()) moved.push(id);
      if ((was?.why ?? null) !== plan.why && plan.why) this.d.log?.(`Balancer: machine ${id}: ${plan.workers} workers, ${plan.runners} runners awake: ${plan.why}`);
    }
    if (moved.length) this.d.changed(moved);
  }
}

/** One CI runner agent's part of a plan (M6b): how many of its runners to keep awake, and the repos it wakes one for first. */
export interface RunnerShare {
  runners: number;
  /** Repo -> how many runners it wants up first: the jobs waiting for it, plus one on a later machine for a repo only it has. */
  queued: Record<string, number>;
}

/** A PC with CI runner agents, as the runners' order sees it. */
export interface RunnerPc {
  id: number;
  owner: number;
  priority: number | null;
  /** Its plan's runners. */
  runners: number;
  /** The repos its runner agents have runners for. */
  repos: ReadonlySet<string>;
}

/**
 * Runners awake follow the owner's order (Josh, 2026-11-25: "put work on machine 1 before using machine 2"; the spec's
 * decisions log: runners awake follow it in M6b). A PC whose owner has an earlier machine with room for CI keeps up only
 * what those can't take: a runner for each job still waiting for its repos (a job waits only when no idle runner took
 * it), and one for each repo only it has. A machine with no order stands after every one with an order; machines of
 * the same order keep their whole plan. Busy runners stay up whatever this says.
 */
export function runnerOrder(pcs: readonly RunnerPc[], queued: ReadonlyMap<string, number>): Map<number, RunnerShare> {
  const waiting = Object.fromEntries([...queued].filter(([, n]) => n > 0).map(([repo, n]) => [repo.toLowerCase(), n]));
  const key = (pc: RunnerPc) => pc.priority ?? Infinity;
  return new Map(
    pcs.map((pc) => {
      const before = pcs.filter((o) => o.owner === pc.owner && key(o) < key(pc) && o.runners > 0);
      if (!before.length) return [pc.id, { runners: pc.runners, queued: waiting }];
      const covered = new Set(before.flatMap((o) => [...o.repos]));
      const wanted: Record<string, number> = {};
      for (const repo of pc.repos) {
        const n = (waiting[repo] ?? 0) + (covered.has(repo) ? 0 : 1);
        if (n) wanted[repo] = n;
      }
      return [
        pc.id,
        {
          runners: Math.min(
            pc.runners,
            Object.values(wanted).reduce((a, n) => a + n, 0),
          ),
          queued: wanted,
        },
      ];
    }),
  );
}

/**
 * A PC's runners split among its CI runner agents (a Windows one and a Linux one in WSL can share a PC, M2b), each by
 * the runners wanted for its repos, plus one, so an agent whose runners all sleep (and so leave its samples) still gets
 * its part back; the remainder to the largest fraction, then the most wanted, then by key. No agent gets more than it
 * can wake (`cap`, from its samples; null: it doesn't say): the rest goes to the others. Each hears every repo wanted
 * and wakes its own runners for them first.
 */
export function runnerShares(runners: number, agents: { key: string; repos: ReadonlySet<string>; cap?: number | null }[], queued: Readonly<Record<string, number>>): Map<string, RunnerShare> {
  const weights = agents.map((a) => 1 + Object.entries(queued).reduce((s, [repo, n]) => s + (a.repos.has(repo) ? n : 0), 0));
  const total = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map((w) => (runners * w) / total);
  const parts = exact.map(Math.floor);
  const order = agents.map((_, i) => i).sort((i, j) => exact[j] - parts[j] - (exact[i] - parts[i]) || weights[j] - weights[i] || agents[i].key.localeCompare(agents[j].key));
  const room = (i: number) => (agents[i].cap ?? Infinity) - parts[i];
  let left = runners - parts.reduce((s, n) => s + n, 0);
  for (const [i, a] of agents.entries())
    if (a.cap != null && parts[i] > a.cap) {
      left += parts[i] - a.cap;
      parts[i] = a.cap;
    }
  for (let k = 0; left > 0 && order.some((i) => room(i) > 0); k++) {
    const i = order[k % order.length];
    if (room(i) > 0) {
      parts[i]++;
      left--;
    }
  }
  return new Map(agents.map((a, i) => [a.key, { runners: parts[i], queued }]));
}
