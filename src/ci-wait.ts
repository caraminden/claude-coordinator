// CI runs as a minion's wait (#546): the jobs and steps of a run in flight, polled from GitHub about every 20 s
// for a minion's open PR (the PR watcher, src/github.ts, names its runs) and for a landing's own CI gate
// (tools/land.sh pushes land/<branch> and waits for tests.yml there). Stops once the run ends. "Usual" is the median
// of the workflow's last five green runs. Cost: one jobs call per run per poll, conditional on its ETag, read as the
// login the PR watcher uses (the box's own for a landing, as land.sh's), never from a turn.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ghGet, type GhGet, type Job } from './ci-health.ts';
import { median } from './waits.ts';
import type { PrSnapshot } from './github.ts';
import type { GithubEnv } from './scheme-repo.ts';

export const POLL_MS = 20_000;
/** Past this many runs in flight, each is looked at every SLOW_MS instead. */
export const BUSY = 10;
export const SLOW_MS = 60_000;
/** A finished run's pass or fail stays this long, until its minion hears of it. */
export const KEEP_MS = 5 * 60_000;
const RATE_LIMITED_MS = 15 * 60_000;
const USUAL_MS = 60 * 60_000;
/** land.sh's CI workflow (CI_WORKFLOW there). */
export const LAND_WORKFLOW = 'tests.yml';

/** Where a CI run stands, in words for a wait. */
export interface CiNow {
  /** queued (no job started), jobs (some running), passed, skipped (every job, so nothing tested), failed, cancelled. */
  stage: string;
  /** The shortest form: "queued", "1/3 jobs", "step 5/8", "passed". */
  short: string;
  /** "test-linux step 5 of 8: the full suite (cara-desktop-2)". */
  text: string;
  since: number;
  ended?: number;
  done?: number;
  total?: number;
}

const at = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const PASSED = new Set(['success', 'skipped', 'neutral']);
interface Step { name: string; status: string; conclusion: string | null }

/** A job's place in its steps: the one running (or next), of how many. */
function stepOf(j: Job): { n: number; of: number; name: string } {
  const steps = (j.steps ?? []) as Step[];
  let i = steps.findIndex((s) => s.status === 'in_progress');
  if (i < 0) i = Math.min(steps.filter((s) => s.status === 'completed').length, steps.length - 1);
  return { n: i + 1, of: steps.length, name: steps[i]?.name ?? '' };
}

/**
 * A run's (or a PR's runs') jobs as where CI stands; null with no jobs yet. `over` once the runs themselves have
 * ended: until then, jobs that wait on others may not be listed yet, so all listed ones done isn't a verdict.
 */
export function ciNow(jobs: Job[], over = true): CiNow | null {
  const since = Math.min(...jobs.map((j) => at(j.created_at)).filter((t) => !Number.isNaN(t)));
  if (!Number.isFinite(since)) return null;
  const done = jobs.filter((j) => j.status === 'completed');
  if (over && done.length === jobs.length) {
    const ended = Math.max(...jobs.map((j) => at(j.completed_at)).filter((t) => !Number.isNaN(t)));
    const failed = jobs.filter((j) => !PASSED.has(j.conclusion ?? ''));
    // Every job skipped or neutral (a draft's PR CI, #558) tested nothing: not green.
    const stage = !failed.length ? (jobs.some((j) => j.conclusion === 'success') ? 'passed' : 'skipped') : failed.every((j) => j.conclusion === 'cancelled') ? 'cancelled' : 'failed';
    const bad = failed.filter((j) => j.conclusion !== 'cancelled');
    const text = stage === 'passed' ? `passed, ${jobs.length === 1 ? 'its job' : `all ${jobs.length} jobs`} green`
      : stage === 'skipped' ? `ran nothing, ${jobs.length === 1 ? 'its job' : `all ${jobs.length} jobs`} skipped`
      : stage === 'cancelled' ? 'cancelled'
        : `failed in ${bad.map((j) => { const s = ((j.steps ?? []) as Step[]).find((x) => x.conclusion === 'failure'); return s ? `${j.name} (${s.name})` : j.name; }).join(', ')}`;
    return { stage, short: stage, text, since, ended: Number.isFinite(ended) ? ended : undefined };
  }
  const running = jobs.filter((j) => j.status === 'in_progress');
  if (!running.length && !done.length) {
    const labels = [...new Set(jobs.flatMap((j) => j.labels ?? []).filter((l) => l !== 'self-hosted'))];
    return { stage: 'queued', short: 'queued', text: `queued for a runner${labels.length ? ` (${labels.join(', ')})` : ''}`, since };
  }
  const where = running.map((j) => {
    const s = stepOf(j);
    return `${j.name} step ${s.n} of ${s.of}${s.name ? `: ${s.name}` : ''}${j.runner_name ? ` (${j.runner_name})` : ''}`;
  });
  const red = done.filter((j) => !PASSED.has(j.conclusion ?? '') && j.conclusion !== 'cancelled').map((j) => `${j.name} failed`);
  const text = [...red, ...where].join(', ') || `${done.length} of ${jobs.length} jobs done, the next not started yet`;
  // One job says more by its steps; several, by how many are done.
  if (jobs.length === 1) {
    const s = stepOf(jobs[0]);
    return { stage: 'jobs', short: `step ${s.n}/${s.of}`, text, since, done: s.n - 1, total: s.of };
  }
  return { stage: 'jobs', short: `${done.length}/${jobs.length} jobs`, text, since, done: done.length, total: jobs.length };
}

/** The Actions runs a PR's pending checks belong to, by their details links. */
export function pendingRuns(pr: PrSnapshot): number[] {
  const ids = pr.checks.filter((c) => c.status === 'pending').map((c) => /\/actions\/runs\/(\d+)\//.exec(c.url ?? '')?.[1]).filter(Boolean);
  return [...new Set(ids.map(Number))];
}

interface Watch {
  slug: string;
  as: GithubEnv;
  /** "PR #88", or "" for a landing. */
  what: string;
  runs: number[];
  /** A landing's: its branch, worktree and head commit, and when its CI phase began (its run is found by these). */
  branch?: string;
  cwd?: string;
  sha?: string;
  since?: number;
  /** Run id → its workflow's usual, s (null while unknown). */
  usual: Map<number, number | null>;
  /** Run id → its jobs as last read. */
  jobs: Map<number, Job[]>;
  ended?: number;
  lastAt: number;
  /** While its run is queued: how many of the repo's queued runs are older (Josh, 2026-11-11: "Count from GitHub"). */
  ahead?: number;
}

export interface CiRunsDeps {
  /** Called with a minion whose CI changed, to re-send its row (Waits.check). */
  changed: (ticketId: number) => void;
  get?: GhGet;
  now?: () => number;
  /** A worktree's head commit, or null. */
  head?: (cwd: string) => Promise<string | null>;
}

const run = promisify(execFile);
async function gitHead(cwd: string): Promise<string | null> {
  try {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd, timeout: 15_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The CI run each minion waits on, polled from GitHub while in flight. */
export class CiRuns {
  private watches = new Map<number, Watch>();
  private cache = new Map<string, { etag: string | null; body: any }>();
  private usuals = new Map<string, { at: number; usual: number | null }>();
  /** Each repo's queued runs, read once a poll while one of its watched runs is queued. */
  private queues = new Map<string, { id: number; created_at: string }[] | null>();
  private shown = new Map<number, string>();
  private pausedUntil = 0;
  private busy = false;
  private said = new Set<string>();
  private d: CiRunsDeps;
  private get: GhGet;
  constructor(d: CiRunsDeps) {
    this.d = d;
    this.get = d.get ?? ghGet;
  }

  private now = () => (this.d.now ?? Date.now)();

  start() {
    setInterval(() => void this.tick(), POLL_MS).unref();
  }

  /** What the PR watcher saw of a minion's PR: its runs in flight are watched; a closed PR or one without is let go. */
  pr(ticketId: number, slug: string, as: GithubEnv, pr: PrSnapshot | null) {
    const w = this.watches.get(ticketId);
    if (w?.branch) return; // its landing's run says more
    const runs = pr?.state === 'OPEN' ? pendingRuns(pr) : [];
    if (!runs.length) {
      // A run this side saw end stays until KEEP_MS; one the watcher saw end first is over too.
      if (w && (!pr || pr.state !== 'OPEN' || !w.ended)) this.drop(ticketId);
      return;
    }
    // The watcher looks every 2 min, so it may still call a run pending that ended here.
    if (w && runs.every((r) => w.runs.includes(r))) return;
    this.watches.set(ticketId, { slug, as, what: `PR #${pr!.number}`, runs, usual: new Map(), jobs: new Map(), lastAt: 0 });
  }

  /** The minions whose landing waits for CI now, by id: their branch and when that wait began (Waits.poll). */
  landings(slug: string | null, now: Map<number, { branch: string; cwd: string | null; since: number }>) {
    for (const [id, w] of this.watches) if (w.branch && !now.has(id)) this.drop(id);
    if (!slug) return;
    for (const [id, { branch, cwd, since }] of now) {
      const w = this.watches.get(id);
      if (!branch || (w?.branch === branch && w.since === since)) continue;
      this.watches.set(id, { slug, as: undefined, what: '', runs: [], branch, cwd: cwd ?? undefined, since, usual: new Map(), jobs: new Map(), lastAt: 0 });
    }
  }

  private drop(id: number) {
    this.watches.delete(id);
    this.check(id);
  }

  /** Where a minion's CI stands, with what it is for ("PR #88", "" for a landing) and the usual length in s. */
  view(ticketId: number): (CiNow & { what: string; usual: number | null }) | null {
    const w = this.watches.get(ticketId);
    if (!w) return null;
    const c = ciNow([...w.jobs.values()].flat(), !!w.ended);
    if (!c) return null;
    const usuals = [...w.usual.values()].filter((u): u is number => u != null);
    if (c.stage === 'queued' && w.ahead != null) {
      c.short = w.ahead ? `${w.ahead} ahead` : 'queued';
      c.text += w.ahead ? `, ${w.ahead} run${w.ahead === 1 ? '' : 's'} ahead` : ', none ahead';
    }
    return { ...c, what: w.what, usual: usuals.length ? Math.max(...usuals) : null };
  }

  private check(id: number) {
    const json = JSON.stringify(this.view(id));
    if (this.shown.get(id) === json) return;
    if (json === 'null') this.shown.delete(id);
    else this.shown.set(id, json);
    this.d.changed(id);
  }

  async tick() {
    const now = this.now();
    if (this.busy || now < this.pausedUntil) return;
    this.busy = true;
    this.queues.clear();
    try {
      const inFlight = [...this.watches.values()].reduce((n, w) => n + (w.ended ? 0 : Math.max(1, w.runs.length)), 0);
      for (const [id, w] of [...this.watches]) {
        if (w.ended) {
          if (now - w.ended >= KEEP_MS) this.drop(id);
          continue;
        }
        if (inFlight > BUSY && now - w.lastAt < SLOW_MS) continue;
        w.lastAt = now;
        try {
          await this.poll(w);
        } catch (err: any) {
          if (err?.rateLimited) {
            this.pausedUntil = now + RATE_LIMITED_MS;
            console.error('GitHub rate limit reached; pausing CI waits.');
            return;
          }
          this.sayOnce(`${w.slug}:${err?.message}`, `CI wait poll of ${w.slug} failed (said once until a restart): ${err?.message ?? err}`);
        }
        if (this.watches.get(id) === w) this.check(id);
      }
    } finally {
      this.busy = false;
    }
  }

  private async poll(w: Watch) {
    if (w.branch && !w.runs.length) {
      // As land.sh finds it: the newest run of the commit it lands (its worktree's head once past the rebase), which may
      // be an earlier try's. Without the commit, the newest run of the land/<branch> it pushes, since this wait began.
      if (w.sha === undefined) w.sha = (w.cwd && (await (this.d.head ?? gitHead)(w.cwd))) || '';
      const runs = `repos/${w.slug}/actions/workflows/${LAND_WORKFLOW}/runs?per_page=5&`;
      const body = await this.read(runs + (w.sha ? `head_sha=${w.sha}` : `branch=${encodeURIComponent(`land/${w.branch}`)}`), w.as);
      const run = (body?.workflow_runs ?? []).find((r: any) => w.sha || at(r.created_at) >= w.since! - 60_000);
      if (!run) return;
      w.runs = [run.id]; // its usual is the landing's own CI stage's (Waits)
      w.usual.set(run.id, null);
    }
    let complete = true;
    for (const id of w.runs) {
      const body = await this.read(`repos/${w.slug}/actions/runs/${id}/jobs?per_page=100`, w.as);
      if (Array.isArray(body?.jobs)) w.jobs.set(id, body.jobs);
      const jobs = w.jobs.get(id) ?? [];
      if (!w.usual.has(id)) w.usual.set(id, await this.usual(w, id));
      // Jobs that wait on others may not be listed yet, so the run itself says when it's over.
      if (!jobs.length || jobs.some((j) => j.status !== 'completed')) complete = false;
      else if ((await this.read(`repos/${w.slug}/actions/runs/${id}`, w.as))?.status !== 'completed') complete = false;
    }
    const c = ciNow([...w.jobs.values()].flat(), false);
    w.ahead = c?.stage === 'queued' ? await this.ahead(w, c.since) : undefined;
    if (complete) {
      w.ended = this.now();
      for (const id of w.runs) this.cache.delete(`repos/${w.slug}/actions/runs/${id}/jobs?per_page=100`);
    }
  }

  /**
   * How many of the repo's queued runs are older than this one: its runners are the repo's own, so other repos'
   * runs don't hold them. shortcut: counts runs, not jobs, and every queued workflow whatever its runner labels;
   * count queued jobs by label if a repo's workflows come to use different runners.
   */
  private async ahead(w: Watch, since: number): Promise<number | undefined> {
    let runs = this.queues.get(w.slug);
    if (runs === undefined) {
      try {
        const body = await this.read(`repos/${w.slug}/actions/runs?status=queued&per_page=100`, w.as);
        runs = body?.workflow_runs ?? [];
        // More than one page: the oldest may be missing, so no count rather than a wrong one.
        if ((body?.total_count ?? 0) > runs!.length) runs = null;
      } catch (err: any) {
        if (err?.rateLimited) throw err;
        runs = null;
      }
      this.queues.set(w.slug, runs!);
    }
    if (!runs) return undefined; // "queued" alone
    const mine = runs!.filter((r) => w.runs.includes(r.id)).map((r) => at(r.created_at));
    const from = mine.length ? Math.min(...mine) : since;
    return runs!.filter((r) => !w.runs.includes(r.id) && at(r.created_at) < from).length;
  }

  /** The median length of a run's workflow's last five green runs, s; the workflow's read at most hourly. */
  private async usual(w: Watch, runId: number): Promise<number | null> {
    let body, key = '';
    try {
      const workflow = (await this.read(`repos/${w.slug}/actions/runs/${runId}`, w.as))?.workflow_id;
      if (!workflow) return null;
      key = `${w.slug}:${workflow}`;
      const had = this.usuals.get(key);
      if (had && this.now() - had.at < USUAL_MS) return had.usual;
      body = await this.read(`repos/${w.slug}/actions/workflows/${workflow}/runs?status=success&per_page=5`, w.as);
    } catch (err: any) {
      if (err?.rateLimited) throw err;
      return null; // the run still shows, with elapsed alone
    }
    const took = (body?.workflow_runs ?? []).map((r: any) => (at(r.updated_at) - at(r.created_at)) / 1000).filter((s: number) => s > 0);
    const usual = median(took.map(Math.round));
    this.usuals.set(key, { at: this.now(), usual });
    return usual;
  }

  /** A GitHub answer's body, from cache on a 304; anything but a 200 or 304 throws. */
  private async read(path: string, as: GithubEnv): Promise<any> {
    const had = this.cache.get(path);
    const r = await this.get(path, had?.etag ?? null, as);
    if (r.status === 304 && had) return had.body;
    if (r.status === 200) {
      this.cache.set(path, { etag: r.etag, body: r.body });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
      return r.body;
    }
    if (r.status === 429 || (r.status === 403 && /rate limit/i.test(String(r.body?.message ?? '')))) throw Object.assign(new Error('rate limited'), { rateLimited: true });
    throw new Error(`GitHub answered ${r.status} for ${path}`);
  }

  private sayOnce(key: string, text: string) {
    if (this.said.has(key)) return;
    this.said.add(key);
    console.warn(text);
  }
}
