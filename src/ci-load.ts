// The CI desktop's load (#534; Josh, 2026-11-11: "can we also monitor the performance impact on my desktop? I want
// to make sure of two things: 1. we are[n't] slamming my PC 2. we arent doing less than we could on my machine in
// parallel"). The runner agents on the PC that hosts the CI runners post a sample every 30 seconds
// (public/runner-agent.mjs); CI health already reads every scheme's jobs from GitHub. This joins the two into one
// view per PC: what it is doing now, the last 24 hours, each pool of runners (a repo's runners with the same labels)
// with its queue, and a verdict: fine, could do more (add a runner), overloading (take one away), crashed under
// load, or full. A verdict that holds becomes one quiet Mandate item per admin, never an alarm, cleared when it ends.
// Nothing here changes a runner: it advises.
import { clock, type Job as CiJob } from './ci-health.ts';
import type { Project, Store, User } from './db.ts';
import { HttpError } from './http.ts';
import { repoSlug } from './prlinks.ts';
import { every, type Job } from './every.ts';
import { thrown } from './thrown.ts';

const MIN = 60_000;
export const KEEP_MS = 14 * 24 * 3600_000;
/** How long a sample waits in memory before it is written. */
export const FLUSH_MS = 5000;
const DAY_MS = 24 * 3600_000;
const BUCKET_MS = 5 * MIN;
// A sample older than this isn't "now": the agent posts every 30 seconds.
const STALE_MS = 3 * MIN;

// The rule's starting values (Josh approved the plan, 2026-11-11). Looked at over WINDOW_MS:
export const WINDOW_MS = 15 * MIN;
/** Someone is at the PC if their last input was under this long ago; an agent that can't tell says null, read as there. */
export const PRESENT_SEC = 5 * 60;
/** Overloading: CPU at or over this, with someone there, for OVER_SHARE of the window. */
export const OVER_CPU = 90;
export const OVER_SHARE = 2 / 3;
/** Or free memory under this share of the PC's. */
export const LOW_MEM = 0.1;
/** Could do more: a job has waited this long with every runner of its pool busy, and the PC averaged under MORE_CPU. */
export const WAIT_MS = 2 * MIN;
export const MORE_CPU = 60;
/** A hard restart with CI jobs running holds its verdict this long; no "add a runner" while it does. */
export const CRASH_HOLD_MS = DAY_MS;
/** How long a verdict holds before its Mandate item goes out (a crash goes at once). */
export const TELL_AFTER_MS = 30 * MIN;
/** The first look at each PC's verdict after a start. */
const FIRST_TICK_MS = 60_000;

export interface RunnerUse {
  name: string;
  repo: string;
  dir: string;
  cpu: number;
  mem: number;
}
/** One look at a PC, as its agent sent it and cleanSample checked it. Percentages are of the whole PC. */
export interface Sample {
  at: number;
  host: string;
  os: 'windows' | 'linux';
  cores: number;
  cpu: number;
  mem_total: number;
  mem_free: number;
  disk_total: number | null;
  disk_free: number | null;
  /** Threads waiting for a core (Windows). */
  queue: number | null;
  /** Linux's CPU pressure, the share of the last minute some task waited for a core. */
  pressure: number | null;
  /** Seconds since the last input of whoever is at the PC; null when the agent can't tell. */
  idle_sec: number | null;
  temp: number | null;
  /** With Hyper-V on: the PC's true CPU %, and each guest's virtual processors' percentages added up. */
  hv: { total: number; vms: Record<string, number> } | null;
  runners: RunnerUse[];
  /** When the PC came back from a restart with no clean shutdown, as ms. */
  restarts: number[];
}

const num = (v: unknown, what: string, max: number, min = 0): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${what} must be a number from ${min} to ${max}`);
  return v;
};
const maybe = (v: unknown, what: string, max: number, min = 0) => (v === null || v === undefined ? null : num(v, what, max, min));
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '');

/** An agent's sample, field by field: anything that isn't a number in range is refused. The time is the server's: a PC's clock can be off. */
export function cleanSample(raw: unknown, now: number): Sample {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'A sample is an object');
  const body = raw as Record<string, unknown>;
  if (body.os !== 'windows' && body.os !== 'linux') throw new HttpError(400, 'os must be windows or linux');
  const host = text(body.host, 100);
  if (!host) throw new HttpError(400, 'host is required');
  if (!Array.isArray(body.runners) || body.runners.length > 64) throw new HttpError(400, 'runners must be a list of at most 64');
  let hv: Sample['hv'] = null;
  if (body.hv && typeof body.hv === 'object' && 'total' in body.hv && typeof body.hv.total === 'number') {
    const guests = 'vms' in body.hv ? body.hv.vms : null;
    const vms: Record<string, number> = {};
    for (const [name, pct] of Object.entries(guests && typeof guests === 'object' ? guests : {}).slice(0, 32)) vms[text(name, 100) || 'vm'] = num(pct, "a VM's CPU", 1e5);
    hv = { total: num(body.hv.total, 'hv.total', 100), vms };
  }
  const restarts = (Array.isArray(body.restarts) ? body.restarts : [])
    .slice(0, 50)
    .map((r: unknown) => Date.parse(String(r)))
    .filter((t: number) => Number.isFinite(t) && t <= now);
  return {
    at: now,
    host,
    os: body.os,
    cores: num(body.cores, 'cores', 4096, 1),
    cpu: num(body.cpu, 'cpu', 100),
    mem_total: num(body.mem_total, 'mem_total', 1e15),
    mem_free: num(body.mem_free, 'mem_free', 1e15),
    disk_total: maybe(body.disk_total, 'disk_total', 1e18),
    disk_free: maybe(body.disk_free, 'disk_free', 1e18),
    queue: maybe(body.queue, 'queue', 1e6),
    pressure: maybe(body.pressure, 'pressure', 100),
    idle_sec: maybe(body.idle_sec, 'idle_sec', 1e9),
    temp: maybe(body.temp, 'temp', 200, -100),
    hv,
    runners: body.runners.map((r: Record<string, unknown>) => ({ name: text(r?.name, 100), repo: text(r?.repo, 200).toLowerCase(), dir: text(r?.dir, 300), cpu: num(r?.cpu, "a runner's cpu", 100), mem: num(r?.mem, "a runner's mem", 1e15) })),
    restarts,
  };
}

/** The PC's true CPU %: Hyper-V's own count where there is one, since a host's counters leave its guests out. */
export const trueCpu = (s: Sample) => Math.max(s.cpu, s.hv?.total ?? 0);
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const avg = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const round = (n: number) => Math.round(n * 10) / 10;
const mins = (ms: number) => `${Math.max(1, Math.round(ms / MIN))} min`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A job with its repo, and its times as ms (NaN where GitHub has none yet). */
export interface LoadJob {
  repo: string;
  name: string;
  status: string;
  runner: string;
  labels: string;
  created: number;
  started: number;
  ended: number;
}
export function loadJob(repo: string, j: CiJob): LoadJob {
  return {
    repo,
    name: j.name,
    status: j.status,
    runner: j.runner_name ?? '',
    labels: (j.labels ?? []).filter((l) => l !== 'self-hosted').join(','),
    created: at(j.created_at),
    started: j.runner_name ? at(j.started_at) : NaN,
    ended: at(j.completed_at),
  };
}

export interface Pool {
  key: string;
  repo: string;
  /** The scheme's name where a scheme has this repo, else the repo. */
  title: string;
  project: number | null;
  labels: string;
  runners: string[];
  busy: number;
  /** Jobs waiting for a runner now, and how long the oldest has. */
  waiting: number;
  oldest_ms: number;
  /** Over the last 24 hours. */
  jobs: number;
  wait_p50_ms: number;
  wait_max_ms: number;
  /** Its runners' share of the PC's CPU over the rule's window; null without samples. */
  cpu: number | null;
}

export type Kind = 'none' | 'fine' | 'more' | 'over' | 'crash' | 'full';
export interface Verdict {
  kind: Kind;
  text: string;
  pool: string | null;
}

/** The pools of runners on a PC, from the jobs GitHub knows and the runners the agents saw. */
export function pools(host: string, jobs: LoadJob[], recent: Sample[], projects: Pick<Project, 'id' | 'name' | 'repo_url'>[], now: number): Pool[] {
  // A runner's name is its own only within its repo: two schemes' runners on one PC can both be called <PC>.
  const sampled = new Map<string, { name: string; repo: string }>();
  const names = new Set<string>();
  for (const s of recent)
    for (const r of s.runners)
      if (r.name) {
        sampled.set(`${r.repo}/${r.name}`, r);
        names.add(r.name);
      }
  // GitHub names a runner after its PC unless told otherwise, and Citadel's scripts keep that: <PC>, <PC>-2, <PC>-linux.
  const here = (name: string) => !!name && (names.has(name) || name.toLowerCase().startsWith(host.toLowerCase()));
  const out = new Map<string, Pool>();
  const poolOf = new Map<string, Pool>();
  const pool = (repo: string, labels: string) => {
    const key = `${repo}|${labels}`;
    if (!out.has(key)) {
      const p = projects.find((x) => repoSlug(x.repo_url) === repo);
      out.set(key, { key, repo, title: p?.name ?? repo, project: p?.id ?? null, labels, runners: [], busy: 0, waiting: 0, oldest_ms: 0, jobs: 0, wait_p50_ms: 0, wait_max_ms: 0, cpu: null });
    }
    return out.get(key)!;
  };
  const waits = new Map<string, number[]>();
  for (const j of jobs) {
    if (!here(j.runner)) continue;
    const p = pool(j.repo, j.labels);
    // A runner with several labels (#1240's side runner) takes jobs from more than one pool: it is in each.
    if (!p.runners.includes(j.runner)) p.runners.push(j.runner);
    poolOf.set(`${j.repo}/${j.runner}`, p);
    if (j.status === 'in_progress') p.busy++;
    if (now - j.created > DAY_MS || !Number.isFinite(j.started)) continue;
    p.jobs++;
    // A re-run keeps its first created time, so its wait can read negative: nothing waited.
    (waits.get(p.key) ?? waits.set(p.key, []).get(p.key)!).push(Math.max(0, j.started - j.created));
  }
  // A runner the agents saw that ran nothing in the jobs read: it is idle, in its repo's pool where the repo has
  // just one here; with several (or none yet) its labels aren't known, so it stands alone under its repo.
  for (const [key, { name, repo }] of sampled) {
    if (poolOf.has(key) || !repo) continue;
    const same = [...out.values()].filter((p) => p.repo === repo && p.labels);
    (same.length === 1 ? same[0] : pool(repo, '')).runners.push(name);
  }
  for (const j of jobs) {
    if (j.status !== 'queued' || j.runner) continue;
    const p = out.get(`${j.repo}|${j.labels}`);
    if (!p || !Number.isFinite(j.created)) continue;
    p.waiting++;
    p.oldest_ms = Math.max(p.oldest_ms, now - j.created);
  }
  const window = recent.filter((s) => now - s.at <= WINDOW_MS);
  for (const p of out.values()) {
    const w = (waits.get(p.key) ?? []).sort((a, b) => a - b);
    p.wait_p50_ms = w[Math.floor(w.length / 2)] ?? 0;
    p.wait_max_ms = w.at(-1) ?? 0;
    p.runners.sort();
    // Each agent's samples on their own clock: a PC's Windows and WSL agents see different runners.
    const shares = new Map<string, number[]>();
    for (const s of window) {
      const mine = s.runners.filter((r) => (!r.repo || r.repo === p.repo) && p.runners.includes(r.name));
      // A WSL agent's percentages are of the cores WSL sees, the same count as the PC's unless .wslconfig caps it.
      if (mine.length) (shares.get(s.os) ?? shares.set(s.os, []).get(s.os)!).push(mine.reduce((a, r) => a + r.cpu, 0));
    }
    if (shares.size) p.cpu = round([...shares.values()].reduce((a, list) => a + avg(list), 0));
  }
  return [...out.values()].filter((p) => p.runners.length).sort((a, b) => a.title.localeCompare(b.title) || a.labels.localeCompare(b.labels));
}

/** What the last WINDOW_MS says. `samples` are the PC's own (its Windows agent's, or its only agent's), any age. */
export function verdict(samples: Sample[], all: Pool[], jobs: LoadJob[], now: number): Verdict {
  const window = samples.filter((s) => now - s.at <= WINDOW_MS);
  const latest = window.at(-1);
  if (!latest || now - latest.at > STALE_MS) return { kind: 'none', text: samples.length ? `No samples since ${clock(samples.at(-1)!.at)}: the PC is off, or its runner agent stopped.` : 'No samples yet: the runner agent on this PC needs its update (tools/ci-runner/README.md, "Load samples").', pool: null };
  const cpu = Math.round(avg(window.map(trueCpu)));
  const waiting = all.reduce((a, p) => a + p.waiting, 0);
  // Under 1% of the PC is a runner waiting for work, not a cause.
  const top = all.filter((p) => p.cpu !== null && p.cpu >= 1).sort((a, b) => b.cpu! - a.cpu!)[0];

  // Crashed under load: a hard restart in the last day with CI jobs running when the samples stopped.
  const restart = [...new Set(samples.flatMap((s) => s.restarts))].filter((t) => now - t <= CRASH_HOLD_MS).sort((a, b) => b - a)[0];
  if (restart !== undefined) {
    // The event is written as the PC comes back: it went down at its last sample before that, where there is one.
    const down = samples.filter((s) => s.at < restart && restart - s.at < 30 * MIN).at(-1)?.at ?? restart;
    const running = jobs.filter((j) => j.started <= down && !(j.ended < down - MIN) && all.some((p) => p.repo === j.repo && p.runners.includes(j.runner)));
    if (running.length) {
      const names = [...new Set(running.map((j) => all.find((p) => p.repo === j.repo && p.runners.includes(j.runner))!.title))].join(', ');
      return { kind: 'crash', pool: null, text: `Crashed under load: the PC restarted without a clean shutdown at about ${clock(down)}, with ${plural(running.length, 'CI job')} running (${names}). Add no runners until that's explained.` };
    }
  }

  const there = (s: Sample) => s.idle_sec === null || s.idle_sec < PRESENT_SEC;
  const hot = window.filter((s) => there(s) && trueCpu(s) >= OVER_CPU).length;
  const queued = window.filter((s) => there(s) && s.queue !== null && s.queue > s.cores).length;
  const lowMem = latest.mem_free < latest.mem_total * LOW_MEM;
  // One hot sample just after an agent starts is not a busy quarter of an hour.
  const share = Math.max(4, window.length * OVER_SHARE);
  if (hot >= share || queued >= share || lowMem) {
    const why = lowMem
      ? `only ${Math.round((latest.mem_free / latest.mem_total) * 100)}% of its memory is free`
      : hot >= share
        ? `CPU was at ${OVER_CPU}% or more for ${mins((hot / window.length) * WINDOW_MS)} of the last ${mins(WINDOW_MS)} with someone at the PC`
        : `more threads waited for a core than it has (${latest.queue} now) with someone at the PC`;
    return { kind: 'over', pool: top?.key ?? null, text: `Overloading: ${why}.${top ? ` ${top.title} uses the most (${Math.round(top.cpu!)}% of the PC): take a runner from it.` : " CI isn't the cause: no runner is busy."}` };
  }

  const stuck = all.filter((p) => p.waiting && p.oldest_ms >= WAIT_MS && p.busy >= p.runners.length).sort((a, b) => b.oldest_ms - a.oldest_ms)[0];
  if (stuck && cpu < MORE_CPU) {
    return { kind: 'more', pool: stuck.key, text: `Could do more: ${plural(stuck.waiting, `${stuck.title} job`)} waited up to ${mins(stuck.oldest_ms)} with all ${stuck.runners.length} of its runners busy, while the PC averaged ${cpu}% CPU. Add a runner to ${stuck.title}.` };
  }
  if (stuck) return { kind: 'full', pool: stuck.key, text: `Full: ${plural(waiting, 'job')} waiting and the PC averaged ${cpu}% CPU over the last ${mins(WINDOW_MS)}. Nothing to add.` };
  return { kind: 'fine', pool: null, text: `Fine: CPU averaged ${cpu}% over the last ${mins(WINDOW_MS)}${waiting ? `, ${plural(waiting, 'job')} waiting under ${mins(WAIT_MS)}` : ', nothing is waiting'}.` };
}

export interface PcView {
  host: string;
  /** The schemes with runners here, for who may see it. */
  projects: number[];
  now: null | {
    at: number;
    cores: number;
    cpu: number;
    mem_total: number;
    mem_free: number;
    disk_total: number | null;
    disk_free: number | null;
    queue: number | null;
    idle_sec: number | null;
    temp: number | null;
    /** Shares of the PC's CPU: its CI runners, WSL as a whole, and each Hyper-V guest. */
    runners: number;
    wsl: number | null;
    vms: Record<string, number>;
  };
  /** The last 24 hours in 5-minute steps: [time, average CPU % or null, peak, jobs running, jobs waiting]. */
  series: [number, number | null, number | null, number, number][];
  restarts: number[];
  pools: Pool[];
  verdict: Verdict;
}

/** One PC's view. `samples` are every agent's on that PC over the last day, oldest first. */
export function pcView(host: string, samples: Sample[], jobs: LoadJob[], projects: Pick<Project, 'id' | 'name' | 'repo_url'>[], now: number): PcView {
  const own = samples.some((s) => s.os === 'windows') ? samples.filter((s) => s.os === 'windows') : samples;
  const wsl = own === samples ? [] : samples.filter((s) => s.os === 'linux');
  const all = pools(host, jobs, samples, projects, now);
  const mine = jobs.filter((j) => all.some((p) => (p.repo === j.repo && p.runners.includes(j.runner)) || (!j.runner && p.key === `${j.repo}|${j.labels}`)));
  const latest = own.at(-1);
  const lastWsl = wsl.at(-1);
  const fresh = latest && now - latest.at <= STALE_MS ? latest : null;

  const start = Math.floor((now - DAY_MS) / BUCKET_MS) * BUCKET_MS + BUCKET_MS;
  const buckets = new Map<number, number[]>();
  for (const s of own) {
    const t = Math.floor(s.at / BUCKET_MS) * BUCKET_MS;
    (buckets.get(t) ?? buckets.set(t, []).get(t)!).push(trueCpu(s));
  }
  const series: PcView['series'] = [];
  for (let t = start; t <= now; t += BUCKET_MS) {
    const mid = Math.min(now, t + BUCKET_MS / 2);
    const cpu = buckets.get(t);
    series.push([t, cpu ? round(avg(cpu)) : null, cpu ? round(Math.max(...cpu)) : null, mine.filter((j) => j.started <= mid && !(j.ended <= mid) && j.status !== 'queued').length, mine.filter((j) => j.created <= mid && !(j.started <= mid) && !(j.ended <= mid)).length]);
  }
  return {
    host,
    projects: [...new Set(all.map((p) => p.project).filter((id): id is number => id !== null))],
    now: fresh && {
      at: fresh.at,
      cores: fresh.cores,
      cpu: round(trueCpu(fresh)),
      mem_total: fresh.mem_total,
      mem_free: fresh.mem_free,
      disk_total: fresh.disk_total,
      disk_free: fresh.disk_free,
      queue: fresh.queue,
      idle_sec: fresh.idle_sec,
      temp: fresh.temp,
      runners: round(fresh.runners.reduce((a, r) => a + r.cpu, 0) + (lastWsl && now - lastWsl.at <= STALE_MS ? lastWsl.runners.reduce((a, r) => a + r.cpu, 0) * (lastWsl.cores / fresh.cores) : 0)),
      wsl: lastWsl && now - lastWsl.at <= STALE_MS ? round(lastWsl.cpu * (lastWsl.cores / fresh.cores)) : null,
      vms: Object.fromEntries(Object.entries(fresh.hv?.vms ?? {}).map(([name, pct]) => [name, round(pct / fresh.cores)])),
    },
    series,
    restarts: [...new Set(samples.flatMap((s) => s.restarts))].filter((t) => now - t <= DAY_MS).sort((a, b) => a - b),
    pools: all,
    verdict: verdict(own, all, mine, now),
  };
}

export interface CiLoadDeps {
  /** Every scheme's jobs of the last day, as CI health last read them. */
  jobs: () => { project: Project; jobs: CiJob[] }[];
  /** The host names of the CI runner agents connected now. */
  hosts: () => string[];
  /** Put (with `title`) or clear (null) a person's quiet Mandate item from a scheme; true once Mandate has it settled. */
  mandate: (project: Project, person: User, key: string, title: string | null) => Promise<boolean>;
}
/** What is kept per PC between looks: the verdict that holds, since when, and who has its item (and from which scheme). */
type Held = { kind: Kind; since: number; sent: Record<string, number>; stale?: boolean };

export class CiLoad {
  private store: Store;
  private deps: CiLoadDeps;
  private kept: { at: number; views: PcView[] } | null = null;
  // The last day's samples, oldest first: read once, then kept as they come in (add), so views never reads runner_load
  // again (a day is ~4.6 MB, scattered through the database: 0.5 s held cold on live, #613).
  private recent: { machine: number; at: number; s: Sample }[] | null = null;
  // Samples not yet in runner_load: written together every FLUSH_MS, not one commit per agent's request (#791).
  private pending: { machine: number; at: number; data: string }[] = [];
  private timer: Job | null = null;
  private flusher: Job | null = null;
  private busy = false;
  // Each agent's newest sample since the server started: which repos have runners on its PC (runnerRepos).
  private latest = new Map<number, Sample>();

  constructor(store: Store, deps: CiLoadDeps) {
    this.store = store;
    this.deps = deps;
  }

  start() {
    // A deploy restarts the server several times a day: waiting a full 5 minutes for the first look let the held verdict go stale (#1085).
    this.timer ??= every('ci load', 5 * MIN, () => this.tick(), FIRST_TICK_MS);
    this.flusher ??= every('ci load flush', FLUSH_MS, () => this.flush());
  }

  stop() {
    this.timer?.stop();
    this.flusher?.stop();
    this.timer = this.flusher = null;
    this.flush();
  }

  /** Write the samples that came in since the last flush, as one commit. A failed write loses them: the next ones still land. */
  flush() {
    if (!this.pending.length) return;
    const rows = this.pending;
    this.pending = [];
    try {
      this.store.addRunnerLoads(rows);
    } catch (err) {
      console.error(`CI load: ${rows.length} sample(s) not saved: ${thrown(err).message ?? err}`);
    }
  }

  /** A runner agent's sample, kept for 14 days. */
  add(machineId: number, body: unknown, now = Date.now()) {
    const data = JSON.stringify(cleanSample(body, now));
    this.latest.set(machineId, JSON.parse(data));
    this.pending.push({ machine: machineId, at: now, data });
    if (this.recent) {
      this.recent.push({ machine: machineId, at: now, s: JSON.parse(data) });
      if (this.recent.length > 1 && this.recent.at(-2)!.at > now) this.recent.sort((a, b) => a.at - b.at);
    }
    this.kept = null;
  }

  /** The repos (owner/name, lowercase) whose runners an agent's newest sample in the last 10 minutes lists (#1268). */
  runnerRepos(now = Date.now()): string[] {
    return [
      ...new Set(
        [...this.latest.values()]
          .filter((s) => now - s.at < 10 * MIN)
          .flatMap((s) => s.runners.map((r) => r.repo))
          .filter(Boolean),
      ),
    ];
  }

  /** A deleted machine's samples go with it (its rows cascade). */
  forget(machineId: number) {
    this.latest.delete(machineId);
    this.recent = this.recent?.filter((r) => r.machine !== machineId) ?? null;
    this.pending = this.pending.filter((r) => r.machine !== machineId);
    this.kept = null;
  }

  /** Every PC with a runner agent, online now or heard from in the last day. Worked out at most every 20 seconds. */
  views(now = Date.now()): PcView[] {
    if (this.kept && now - this.kept.at < 20_000 && now >= this.kept.at) return this.kept.views;
    const projects = this.store.listProjects();
    const jobs = this.deps.jobs().flatMap(({ project, jobs }) => {
      const repo = repoSlug(project.repo_url);
      return repo ? jobs.map((j) => loadJob(repo, j)) : [];
    });
    const byHost = new Map<string, Sample[]>(
      this.deps
        .hosts()
        .filter(Boolean)
        .map((h) => [h.toLowerCase(), []]),
    );
    const since = now - DAY_MS;
    if (!this.recent) this.flush(); // the read below must see them
    this.recent ??= this.store.runnerLoadSince(since).map((r) => ({ machine: r.machine_id, at: r.at, s: JSON.parse(r.data) as Sample }));
    const old = this.recent.findIndex((r) => r.at >= since);
    if (old > 0) this.recent.splice(0, old);
    for (const { at, s } of this.recent) {
      if (at < since) continue; // every sample, when none is from the last day (old = -1)
      (byHost.get(s.host.toLowerCase()) ?? byHost.set(s.host.toLowerCase(), []).get(s.host.toLowerCase())!).push(s);
    }
    const views = [...byHost].sort(([a], [b]) => a.localeCompare(b)).map(([host, samples]) => pcView(samples.at(-1)?.host ?? host, samples, jobs, projects, now));
    this.kept = { at: now, views };
    return views;
  }

  /** Old samples go, and each PC's verdict is brought in line with its admins' Mandates. */
  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.flush();
      this.store.pruneRunnerLoad(now - KEEP_MS);
      const admins = this.store.listUsers().filter((u) => u.admin && !u.disabled_at && this.store.contraptionEnabled('mandate', u.id));
      for (const v of this.views(now)) {
        const key = `ci-load:${v.host.toLowerCase()}`;
        const held: Held = { kind: 'none', since: now, sent: {}, ...this.store.getSetting<Held>(key) };
        const item = `ciload.${v.host.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')}`.slice(0, 128);
        if (held.kind !== v.verdict.kind) {
          held.kind = v.verdict.kind;
          held.since = now;
          held.stale = true;
        }
        const tell = held.kind === 'crash' || ((held.kind === 'over' || held.kind === 'more') && now - held.since >= TELL_AFTER_MS);
        // A new verdict is a new item: the old one's words no longer hold. A take-back that fails is tried again next time.
        if (held.stale || !tell) {
          for (const [uid, pid] of Object.entries(held.sent)) {
            const u = this.store.getUser(Number(uid));
            const p = this.store.getProject(pid);
            if (!u || !p || (await this.deps.mandate(p, u, item, null))) delete held.sent[uid];
          }
          if (!Object.keys(held.sent).length) held.stale = false;
        }
        // From the scheme the verdict names, or any with runners there.
        const project = this.store.getProject(v.pools.find((p) => p.key === v.verdict.pool)?.project ?? v.projects[0] ?? -1);
        if (tell && project) {
          for (const u of admins) {
            if (held.sent[u.id] === undefined && (await this.deps.mandate(project, u, item, `CI desktop ${v.host}: ${v.verdict.text}`))) held.sent[u.id] = project.id;
          }
        }
        this.store.setSetting(key, held);
      }
    } finally {
      this.busy = false;
    }
  }
}
