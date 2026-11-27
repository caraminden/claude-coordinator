// Ships go first on the CI desktop (#1268; Cara, 2026-11-20, "Plan approved: build it this way"): every SHIP_POLL_MS
// this asks GitHub which ship runs (a `land/…` branch) are going in each repo with runners on a runner agent's PC, and
// which runner each of their jobs is on, and sends each PC's agents the ships on that PC's own runners (shipsOn, #1934).
// While a list names runners, the agents squeeze every other runner on the PC; a list that stops coming (2 minutes) lifts
// it (runner-agent.mjs). Citadel's own ships go first (Cara, 2026-11-21, picked "Citadel's ship goes first" on #1268's
// card): while one runs on a PC, other schemes' ships there are left off its list, so they are squeezed like any other runner.
import { type GhGet, ghGet, RateLimited, rateLimited } from './gh-api.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { every, type Job } from './every.ts';
import { thrown } from './thrown.ts';
import type { GhJobsBody, GhRunsBody } from './gh-bodies.ts';
import { heavyKind, type QueuedHeavy } from './heavy-place.ts';

export const SHIP_POLL_MS = 15_000;
const RATE_LIMITED_MS = 5 * 60_000;
/** How long a repo whose reads fail keeps its last ships: the agents' own hold, so a ship that ended unseen lifts. */
const KEEP_FAILED_MS = 2 * 60_000;
/** Queued runs read for their jobs each look, the newest first: the rest wait behind them anyway. */
const QUEUED_RUNS = 5;
/** A ship run's branch: what every scheme's land.sh pushes (Cara, 2026-11-20: "No, ship branches only"). */
export const SHIP_BRANCH = /^land\//;
/** An early next train's run (#1568, tools/land.sh's early_next): low priority beside a ship's, so squeezed while one runs. */
const EARLY_BRANCH = /^early\//;

export interface Ship {
  repo: string;
  runner: string;
  /** Set on Citadel's own ships (the repo whose ships go first). */
  first?: true;
}

/** Each CI PC by its hostname, with its runners as `owner/name/runner`, all lowercase. Windows' agent and WSL's share a hostname, so they are one PC. */
export type Pcs = Map<string, Set<string>>;

export function pcOf(ship: Pick<Ship, 'repo' | 'runner'>, pcs: Pcs): string | undefined {
  const name = ship.runner.toLowerCase();
  for (const [host, runners] of pcs) if (runners.has(`${ship.repo.toLowerCase()}/${name}`)) return host;
  // No sample lists it (a server just started, a runner just added): a runner's name starts with its PC's hostname, unless two do (DESK-2 is DESK's second runner, or a PC).
  const hosts = [...pcs.keys()].filter((h) => name === h || name.startsWith(`${h}-`));
  return hosts.length === 1 ? hosts[0] : undefined;
}

/** The ships the PC `host` squeezes for: those on its own runners, or only Citadel's own while one of them is. */
export function shipsOn(host: string, ships: Ship[], pcs: Pcs): Ship[] {
  const here = ships.filter((s) => pcOf(s, pcs) === host.toLowerCase());
  return here.some((s) => s.first) ? here.filter((s) => s.first) : here;
}

/** The CI jobs waiting for the PC `host`'s runners: each repo's queued jobs, shared evenly among the PCs with runners for it (rounded up). */
export function queuedOn(host: string, byRepo: Map<string, number>, pcs: Pcs): number {
  let n = 0;
  for (const [repo, jobs] of byRepo) {
    if (!jobs) continue;
    const serving = [...pcs].filter(([, runners]) => [...runners].some((r) => r.startsWith(`${repo.toLowerCase()}/`))).map(([h]) => h);
    if (serving.includes(host.toLowerCase())) n += Math.ceil(jobs / serving.length);
  }
  return n;
}

export interface ShipWatchDeps {
  /** owner/name, lowercase, of every repo with runners on a runner agent's PC (repeats are fine). */
  repos: () => string[];
  /** The GitHub login that reads a repo: its scheme's; null when no scheme has it, so it isn't read. */
  as: (repo: string) => GithubEnv | null;
  /** Every ship running now, whichever PC it is on: shipsOn picks a PC's own. */
  send: (ships: Ship[]) => void;
  /** owner/name, lowercase, of the repo whose ships go first (Citadel's own); null when unknown. */
  first?: () => string | null;
  /** Each repo's CI jobs queued for self-hosted runners (Build 7 M6: waiting CI shrinks the workers), and the labels those jobs ask for (#2064: a label no runner has gets one); left out, they aren't read. */
  queued?: (byRepo: Map<string, number>, labels: Map<string, Set<string>>, jobs?: Map<string, string[][]>) => void;
  /** The queued jobs asking for a heavy label (src/heavy-place.ts, #2120), and the repos whose queued runs were read; read only with `queued`. */
  heavy?: (jobs: QueuedHeavy[], read: Set<string>) => void;
  get?: GhGet;
  log?: (line: string) => void;
}

export class ShipWatch {
  private deps: ShipWatchDeps;
  private get: GhGet;
  private cache = new Map<string, { etag: string | null; body: unknown }>();
  // Each repo's ships at its last good read: a read that fails keeps them, so a GitHub hiccup doesn't lift a squeeze.
  private last = new Map<string, { ships: Ship[]; at: number }>();
  private pausedUntil = 0;
  private busy = false;
  private timer: Job | null = null;
  private said = '';

  constructor(deps: ShipWatchDeps) {
    this.deps = deps;
    this.get = deps.get ?? ghGet;
  }

  start() {
    this.timer ??= every('ci ships', SHIP_POLL_MS, () => this.tick());
  }

  stop() {
    this.timer?.stop();
    this.timer = null;
  }

  /** One look: the runners on a ship's job now, sent on. Nothing is sent while GitHub says to wait. */
  async tick(now = Date.now()): Promise<Ship[] | null> {
    if (this.busy || now < this.pausedUntil) return null;
    this.busy = true;
    const used = new Set<string>();
    let failed = false;
    try {
      const repos = new Set(this.deps.repos().map((r) => r.toLowerCase()));
      for (const repo of [...this.last.keys()]) if (!repos.has(repo)) this.last.delete(repo);
      for (const repo of repos) {
        const as = this.deps.as(repo);
        if (as === null) continue;
        try {
          this.last.set(repo, { ships: await this.ships(repo, as, used), at: now });
        } catch (err) {
          if (err instanceof RateLimited) throw err;
          failed = true;
          if (now - (this.last.get(repo)?.at ?? now) >= KEEP_FAILED_MS) this.last.delete(repo);
          this.say(`Ship watch: ${repo}: ${thrown(err).message ?? err}`);
        }
      }
      if (this.deps.queued) {
        const queued = new Map<string, number>();
        const labels = new Map<string, Set<string>>();
        const jobs = new Map<string, string[][]>();
        const heavy: QueuedHeavy[] = [];
        for (const repo of repos) {
          const as = this.deps.as(repo);
          if (as === null) continue;
          try {
            const w = await this.waiting(repo, as, used);
            queued.set(repo, w.n);
            if (w.labels.size) labels.set(repo, w.labels);
            if (w.jobs.length) jobs.set(repo, w.jobs);
            heavy.push(...w.heavy);
          } catch (err) {
            if (err instanceof RateLimited) throw err;
            this.say(`Ship watch: ${repo}'s queued jobs: ${thrown(err).message ?? err}`);
          }
        }
        this.deps.queued(queued, labels, jobs);
        this.deps.heavy?.(heavy, new Set(queued.keys()));
      }
      for (const path of this.cache.keys()) if (!used.has(path)) this.cache.delete(path);
      const first = this.deps.first?.()?.toLowerCase();
      // Citadel's own ships carry first: true, so shipsOn, and a keeper that squeezes harder for them, can tell them from another scheme's.
      const ships = [...this.last.values()].flatMap((l) => l.ships).map((s) => (first && s.repo === first ? { ...s, first: true as const } : s));
      this.deps.send(ships);
      if (!failed) this.said = '';
      return ships;
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
      this.pausedUntil = now + RATE_LIMITED_MS;
      // An empty list now, so the agents lift at once and one connecting meanwhile isn't handed the old list.
      this.last.clear();
      this.deps.send([]);
      this.deps.queued?.(new Map(), new Map());
      this.say('Ship watch: GitHub says to slow down; looking again in 5 minutes (the agents lift any squeeze meanwhile).');
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async ships(repo: string, as: GithubEnv, used: Set<string>): Promise<Ship[]> {
    const runs = ((await this.read(`repos/${repo}/actions/runs?status=in_progress&per_page=50`, as, used)) as GhRunsBody | null)?.workflow_runs ?? [];
    const out: Ship[] = [];
    const on = (re: RegExp) => runs.filter((r) => re.test(String(r?.head_branch ?? '')) && Number.isInteger(r?.id));
    // With no land/ run going, the oldest early one is a train's own CI (its early run counted): the next train's is younger.
    const early = on(EARLY_BRANCH)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, 1);
    const land = on(SHIP_BRANCH);
    for (const r of land.length ? land : early) {
      const jobs = ((await this.read(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`, as, used)) as GhJobsBody | null)?.jobs ?? [];
      for (const j of jobs) if (j?.status === 'in_progress' && typeof j.runner_name === 'string' && j.runner_name && Array.isArray(j.labels) && j.labels.includes('self-hosted')) out.push({ repo, runner: j.runner_name });
    }
    return out;
  }

  /** Jobs waiting for a self-hosted runner in the repo's queued runs. shortcut: a queued job inside a run already going isn't counted; read in_progress runs' jobs too if workers grow over waiting CI. */
  // Heavy jobs (src/heavy-place.ts, #2120) come back on their own: they wait for Citadel to place them, so they count as heavy, not as waiting CI.
  private async waiting(repo: string, as: GithubEnv, used: Set<string>): Promise<{ n: number; labels: Set<string>; jobs: string[][]; heavy: QueuedHeavy[] }> {
    const runs = ((await this.read(`repos/${repo}/actions/runs?status=queued&per_page=20`, as, used)) as GhRunsBody | null)?.workflow_runs ?? [];
    let n = 0;
    const labels = new Set<string>();
    const jobLabels: string[][] = [];
    const heavy: QueuedHeavy[] = [];
    for (const r of runs.filter((r) => Number.isInteger(r?.id)).slice(0, QUEUED_RUNS)) {
      const jobs = ((await this.read(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`, as, used)) as GhJobsBody | null)?.jobs ?? [];
      for (const j of jobs) {
        if (j?.status !== 'queued' || !Array.isArray(j.labels) || !j.labels.includes('self-hosted')) continue;
        const asks = j.labels.filter((l) => typeof l === 'string');
        const kind = heavyKind(asks);
        // Its other labels still ask for runners (#2064); the heavy one is Citadel's to hand out.
        for (const l of asks) if (l !== 'self-hosted' && l.toLowerCase() !== kind?.label) labels.add(l.toLowerCase());
        if (kind) {
          if (Number.isSafeInteger(j.id)) heavy.push({ repo, id: Number(j.id), run: Number(r.id), name: String(j.name ?? ''), labels: asks });
          continue;
        }
        n++;
        // What this job asks of a runner, by label, so a runner that has them can be woken for it.
        jobLabels.push(asks.map((l) => l.toLowerCase()).filter((l) => l !== 'self-hosted'));
      }
    }
    return { n, labels, jobs: jobLabels, heavy };
  }

  private async read(path: string, as: GithubEnv, used: Set<string>): Promise<unknown> {
    used.add(path);
    const had = this.cache.get(path);
    const r = await this.get(path, had?.etag ?? null, as);
    if (r.status === 304 && had) return had.body;
    if (r.status === 200) {
      this.cache.set(path, { etag: r.etag, body: r.body });
      return r.body;
    }
    if (rateLimited(r)) throw new RateLimited();
    throw new Error(`GitHub answered ${r.status} for ${path}`);
  }

  /** A problem is logged once until a look goes through. */
  private say(line: string) {
    if (line === this.said) return;
    this.said = line;
    (this.deps.log ?? console.error)(line);
  }
}
