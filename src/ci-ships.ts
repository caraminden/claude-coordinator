// Ships go first on the CI desktop (#1268; Cara, 2026-11-20, "Plan approved: build it this way"): every SHIP_POLL_MS
// this asks GitHub which ship runs (a `land/…` branch) are going in each repo with runners on a runner agent's PC, and
// which runner each of their jobs is on, and sends that list to the runner agents. While a list names runners, the
// agents squeeze every other runner on the PC; a list that stops coming (2 minutes) lifts it (runner-agent.mjs).
// Citadel's own ships go first (Cara, 2026-11-21, picked "Citadel's ship goes first" on #1268's card): while one runs,
// other schemes' ships are left off the list, so they are squeezed like any other runner.
import { type GhGet, ghGet, RateLimited } from './gh-api.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { every, type Job } from './every.ts';
import { thrown } from './thrown.ts';
import type { GhErrorBody, GhJobsBody, GhRunsBody } from './gh-bodies.ts';

export const SHIP_POLL_MS = 15_000;
const RATE_LIMITED_MS = 5 * 60_000;
/** How long a repo whose reads fail keeps its last ships: the agents' own hold, so a ship that ended unseen lifts. */
const KEEP_FAILED_MS = 2 * 60_000;
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

export interface ShipWatchDeps {
  /** owner/name, lowercase, of every repo with runners on a runner agent's PC (repeats are fine). */
  repos: () => string[];
  /** The GitHub login that reads a repo: its scheme's; null when no scheme has it, so it isn't read. */
  as: (repo: string) => GithubEnv | null;
  send: (ships: Ship[]) => void;
  /** owner/name, lowercase, of the repo whose ships go first (Citadel's own); null when unknown. */
  first?: () => string | null;
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

  /** One look: the runners on a ship's job now, sent to the agents. Nothing is sent while GitHub says to wait. */
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
      for (const path of this.cache.keys()) if (!used.has(path)) this.cache.delete(path);
      const all = [...this.last.values()].flatMap((l) => l.ships);
      const first = this.deps.first?.()?.toLowerCase();
      const ships = first && all.some((s) => s.repo === first) ? all.filter((s) => s.repo === first) : all;
      // Citadel's own ships carry first: true, so a keeper that squeezes harder for them can tell them from another scheme's.
      this.deps.send(ships.map((s) => (first && s.repo === first ? { ...s, first: true } : s)));
      if (!failed) this.said = '';
      return ships;
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
      this.pausedUntil = now + RATE_LIMITED_MS;
      // An empty list now, so the agents lift at once and one connecting meanwhile isn't handed the old list.
      this.last.clear();
      this.deps.send([]);
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
      // shortcut: any self-hosted runner counts, as every one is on Cara's desktop today; send each PC only its own ships once another PC has runners.
      for (const j of jobs) if (j?.status === 'in_progress' && typeof j.runner_name === 'string' && j.runner_name && Array.isArray(j.labels) && j.labels.includes('self-hosted')) out.push({ repo, runner: j.runner_name });
    }
    return out;
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
    if (r.status === 429 || (r.status === 403 && /rate limit/i.test(String((r.body as GhErrorBody | null)?.message ?? '')))) throw new RateLimited();
    throw new Error(`GitHub answered ${r.status} for ${path}`);
  }

  /** A problem is logged once until a look goes through. */
  private say(line: string) {
    if (line === this.said) return;
    this.said = line;
    (this.deps.log ?? console.error)(line);
  }
}
