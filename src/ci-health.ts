// CI health (#368; ask C3 of shared/project/specs/native-app-ci-asks-2026-11.md): Citadel watches every scheme's
// GitHub Actions and tells a person, never a minion, when CI is unwell in a way a red test doesn't show:
//   - a runner offline (GitHub's own runner list, so session runners too);
//   - jobs that never started (0 steps, no runner: a billing block) or sat queued with no runner to take them;
//   - a green run on main that skipped jobs which ran the time before;
//   - no verdict on main for hours while runs keep coming.
// Each open problem is one Mandate alert item for every admin (Cara, 2026-11-07: "Send a mandate alert to
// admins"), put from the scheme so its chip names it, and cleared when the problem is. It polls with the scheme
// owner's linked GitHub (as the PR watcher and runner list do; the box's login without one), every 5 minutes,
// with ETags so an unchanged answer (a 304) costs no rate limit.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, Store, User } from './db.ts';
import { repoSlug } from './prlinks.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);

const POLL_MS = 5 * 60_000;
const RATE_LIMITED_MS = 15 * 60_000;
// Runs looked at for jobs that didn't start or wait for a runner; older ones are history.
const RUNS = 50;
const WINDOW_MS = 24 * 3600_000;
export const OFFLINE_MS = 15 * 60_000;
export const QUEUED_MS = 30 * 60_000;
export const VERDICT_MS = 4 * 3600_000;
// A workflow with no run on main this long is a manual or retired one, never "missing a verdict".
const ACTIVE_MS = 7 * 24 * 3600_000;
const VERDICTS = new Set(['success', 'failure']);
const RAN = new Set(['success', 'failure']);
// A run whose jobs were all skipped (a job-level `if:`), or neutral, was never meant to give a verdict.
const NO_VERDICT = new Set(['skipped', 'neutral']);

export interface Run {
  id: number;
  name: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_attempt?: number;
}
export interface Job {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  runner_name: string | null;
  labels: string[];
  steps?: unknown[];
}
export interface Runner {
  name: string;
  status: string;
}
/** Something wrong now: what the alert says, keyed so the same trouble keeps one item. */
export interface Problem {
  key: string;
  title: string;
}

const at = (s: string) => Date.parse(s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Nov 5 18:31" in the server's zone. Always dated: a title that dropped it for today would change at midnight and re-send the alert (#509). */
export function clock(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/** Runners offline for OFFLINE_MS or more. `offline` (runner name → first seen offline) is updated in place. */
export function runnerProblems(runners: Runner[], offline: Record<string, number>, now: number): Problem[] {
  const out: Problem[] = [];
  const names = new Set(runners.map((r) => r.name));
  for (const name of Object.keys(offline)) if (!names.has(name)) delete offline[name];
  for (const r of runners) {
    if (r.status !== 'offline') {
      delete offline[r.name];
      continue;
    }
    const since = (offline[r.name] ??= now);
    if (now - since >= OFFLINE_MS) out.push({ key: `runner:${r.name}`, title: `CI: runner ${r.name} has been offline since ${clock(since)}` });
  }
  return out;
}

/** A job that ended without starting: no steps ran and no runner took it (a billing block, or a runner that never came). */
export const neverStarted = (j: Job) => j.status === 'completed' && j.conclusion === 'failure' && !j.runner_name && !j.steps?.length;
const labelsOf = (j: Job) => (j.labels.length ? j.labels.join(', ') : 'no labels');

/**
 * Jobs, per set of runs-on labels, that never started since the last one with those labels that did; the newest
 * dead job of each group is the one whose GitHub annotation says why.
 */
export function deadGroups(jobs: Job[]): { labels: string; dead: Job[] }[] {
  const groups = new Map<string, Job[]>();
  for (const j of [...jobs].sort((a, b) => at(a.created_at) - at(b.created_at))) {
    const key = labelsOf(j);
    if (neverStarted(j)) groups.set(key, [...(groups.get(key) ?? []), j]);
    else if (j.runner_name) groups.delete(key);
  }
  return [...groups].map(([labels, dead]) => ({ labels, dead }));
}

export function deadProblem(g: { labels: string; dead: Job[] }, reason: string | null): Problem {
  const n = g.dead.length;
  const why = reason ? ` GitHub says: "${reason.length > 300 ? `${reason.slice(0, 299)}…` : reason}"` : '';
  return { key: `nostart:${g.labels}`, title: `CI: ${plural(n, 'job')} on ${g.labels} didn't start since ${clock(at(g.dead[0].created_at))}, so ${n === 1 ? "it isn't a test failure" : "they aren't test failures"}.${why}` };
}

/** Jobs waiting QUEUED_MS or more for a runner, per set of labels. */
export function queuedProblems(jobs: Job[], now: number): Problem[] {
  const groups = new Map<string, Job[]>();
  for (const j of jobs) if (j.status === 'queued' && now - at(j.created_at) >= QUEUED_MS) groups.set(labelsOf(j), [...(groups.get(labelsOf(j)) ?? []), j]);
  return [...groups].map(([labels, waiting]) => {
    const since = Math.min(...waiting.map((j) => at(j.created_at)));
    return { key: `queued:${labels}`, title: `CI: ${plural(waiting.length, 'job')} on ${labels} ${waiting.length === 1 ? 'has' : 'have'} waited for a runner since ${clock(since)}` };
  });
}

/**
 * A workflow on the default branch whose last verdict (success or failure; cancelled isn't one) is older than the
 * runs after it by VERDICT_MS: measured from the first run that hasn't got one, so a stream of runs each cancelling
 * the last still counts. `runs` is the workflow's runs on that branch, newest first.
 */
export function verdictProblem(workflow: { id: number; name: string }, branch: string, all: Run[], now: number): Problem | null {
  const runs = all.filter((r) => !(r.status === 'completed' && NO_VERDICT.has(r.conclusion ?? '')));
  if (!runs.length || now - at(runs[0].created_at) > ACTIVE_MS) return null;
  const v = runs.findIndex((r) => r.status === 'completed' && VERDICTS.has(r.conclusion ?? ''));
  if (v === 0) return null;
  const waiting = v < 0 ? runs : runs.slice(0, v);
  const since = at(waiting.at(-1)!.created_at);
  if (now - since < VERDICT_MS) return null;
  const last = v < 0 ? `none in its last ${plural(runs.length, 'run')}` : `the last was ${runs[v].conclusion} on ${runs[v].head_sha.slice(0, 7)}`;
  return { key: `verdict:${workflow.id}`, title: `CI: no ${workflow.name} verdict on ${branch} since ${clock(since)} (${last}; ${plural(waiting.length, 'run')} since)` };
}

/** The newest two verdict runs of a workflow's runs on the default branch (newest first): the one to check, and the one before. */
export function verdictPair(runs: Run[]): [Run, Run] | null {
  const v = runs.filter((r) => r.status === 'completed' && VERDICTS.has(r.conclusion ?? ''));
  return v.length >= 2 && v[0].conclusion === 'success' ? [v[0], v[1]] : null;
}

/** A green run that skipped jobs which ran (passed or failed) in the verdict before it: green that proves less than it says. */
export function skippedProblem(workflow: { id: number; name: string }, branch: string, latest: Run, latestJobs: Job[], beforeJobs: Job[]): Problem | null {
  const ran = new Set(beforeJobs.filter((j) => RAN.has(j.conclusion ?? '')).map((j) => j.name));
  const skipped = latestJobs.filter((j) => j.conclusion === 'skipped' && ran.has(j.name)).map((j) => j.name);
  if (!skipped.length) return null;
  return { key: `skipped:${workflow.id}`, title: `CI: ${workflow.name} on ${branch} (${latest.head_sha.slice(0, 7)}) went green with ${plural(skipped.length, 'job')} skipped that ran the time before: ${skipped.join(', ')}` };
}

/** A Mandate item key for a problem (Mandate allows A-Z a-z 0-9 . _ : - and 128 characters). */
export const itemKey = (key: string) => `ci.${key.replace(/[^A-Za-z0-9._:-]+/g, '_')}`.slice(0, 128);

// ---------- GitHub ----------

export interface GhAnswer {
  status: number;
  etag: string | null;
  body: any;
}
export type GhGet = (path: string, etag: string | null, as: GithubEnv) => Promise<GhAnswer>;

/** One REST GET through the gh CLI, conditional on `etag`; any HTTP status comes back, only a failure to ask throws. */
export async function ghGet(path: string, etag: string | null, as: GithubEnv): Promise<GhAnswer> {
  let out: string;
  try {
    ({ stdout: out } = await run('gh', ['api', '-i', path, ...(etag ? ['-H', `If-None-Match: ${etag}`] : [])], { env: asEnv(as), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (err: any) {
    // gh exits 1 on a 304 or an error status, but still prints the answer.
    out = typeof err?.stdout === 'string' ? err.stdout : '';
    if (!/^HTTP\/\S+ \d+/.test(out)) throw err;
  }
  const split = /\r?\n\r?\n/.exec(out);
  const head = split ? out.slice(0, split.index) : out;
  const rest = split ? out.slice(split.index + split[0].length) : '';
  const status = Number(/^HTTP\/\S+ (\d+)/.exec(head)?.[1] ?? 0);
  let body: any = null;
  try {
    body = rest.trim() ? JSON.parse(rest) : null;
  } catch {}
  return { status, etag: /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null, body };
}

class RateLimited extends Error {}

// ---------- the poller ----------

/** What is kept across restarts, per scheme: runners first seen offline, and which item titles each admin has. */
interface Saved {
  offline: Record<string, number>;
  /** Problem key → user id → the title their Mandate item has. */
  sent: Record<string, Record<string, string>>;
}

export interface CiHealthDeps {
  /** The GitHub login to read a scheme's repo as: its owner's linked one, or undefined for the box's. */
  as: (project: Project) => GithubEnv;
  /** Put (with `title`) or clear (null) a person's Mandate alert item for a scheme; true once Mandate has it settled. */
  mandate: (project: Project, person: User, key: string, title: string | null) => Promise<boolean>;
  get?: GhGet;
}

export class CiHealth {
  private store: Store;
  private deps: CiHealthDeps;
  private get: GhGet;
  private cache = new Map<string, { etag: string | null; body: any }>();
  // Finished runs' jobs and annotations don't change.
  private jobsOf = new Map<string, Job[]>();
  private reasons = new Map<number, string | null>();
  private pausedUntil = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private said = new Set<string>();

  constructor(store: Store, deps: CiHealthDeps) {
    this.store = store;
    this.deps = deps;
    this.get = deps.get ?? ghGet;
  }

  /** The first look comes a poll after start, so a restart (or a test's short-lived server) doesn't ask GitHub at once. */
  start() {
    this.timer ??= setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    if (this.busy || now < this.pausedUntil) return;
    this.busy = true;
    try {
      for (const p of this.store.listProjects()) {
        const slug = repoSlug(p.repo_url);
        if (!slug) continue;
        try {
          await this.check(p, slug, now);
        } catch (err: any) {
          if (err instanceof RateLimited) {
            this.pausedUntil = now + RATE_LIMITED_MS;
            console.error('GitHub rate limit reached; pausing CI health checks.');
            return;
          }
          this.sayOnce(`fail:${p.id}:${err?.message}`, `CI health check of ${p.name} failed (said once until a restart): ${err?.message ?? err}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** One scheme: what's wrong now, then its admins' Mandates brought in line. */
  async check(p: Project, slug: string, now: number) {
    const saved: Saved = { offline: {}, sent: {}, ...this.store.getSetting<Saved>(`ci-health:${p.id}`) };
    const problems = await this.problems(p, slug, saved, now);
    await this.deliver(p, problems, saved);
    this.store.setSetting(`ci-health:${p.id}`, saved);
  }

  async problems(p: Project, slug: string, saved: Saved, now: number): Promise<Problem[]> {
    const as = this.deps.as(p);
    const workflows = ((await this.read(`repos/${slug}/actions/workflows?per_page=100`, as))?.workflows ?? []).filter((w: any) => w.state === 'active');
    // A repo with no CI costs one conditional request a poll.
    if (!workflows.length) {
      saved.offline = {};
      return [];
    }
    const out: Problem[] = [];

    const runners = await this.read(`repos/${slug}/actions/runners?per_page=100`, as, true);
    if (Array.isArray(runners?.runners)) out.push(...runnerProblems(runners.runners, saved.offline, now));
    else this.sayOnce(`runners:${p.id}`, `CI health: can't list ${slug}'s runners (needs a repo admin's linked GitHub), so offline runners there go unseen.`);

    const runs: Run[] = ((await this.read(`repos/${slug}/actions/runs?per_page=${RUNS}`, as))?.workflow_runs ?? [])
      .filter((r: Run) => now - at(r.created_at) <= WINDOW_MS);
    const jobs: Job[] = [];
    for (const r of runs) {
      // A run under QUEUED_MS old can't have a job waiting too long yet, and an unfinished one has none that died.
      if (r.status !== 'completed' && now - at(r.created_at) < QUEUED_MS) continue;
      jobs.push(...(await this.jobs(slug, r, as)));
    }
    for (const g of deadGroups(jobs)) out.push(deadProblem(g, await this.reason(slug, g.dead.at(-1)!, as)));
    out.push(...queuedProblems(jobs, now));

    const branch = (await this.read(`repos/${slug}`, as))?.default_branch ?? 'main';
    for (const w of workflows) {
      const mainRuns: Run[] = (await this.read(`repos/${slug}/actions/workflows/${w.id}/runs?branch=${encodeURIComponent(branch)}&per_page=${RUNS}`, as))?.workflow_runs ?? [];
      const v = verdictProblem(w, branch, mainRuns, now);
      if (v) out.push(v);
      const pair = verdictPair(mainRuns);
      if (pair) {
        const s = skippedProblem(w, branch, pair[0], await this.jobs(slug, pair[0], as), await this.jobs(slug, pair[1], as));
        if (s) out.push(s);
      }
    }
    return out;
  }

  /** Every admin with Mandate on gets each problem's item, updated when its words change, and cleared once it's gone. */
  async deliver(p: Project, problems: Problem[], saved: Saved) {
    const admins = this.store.listUsers().filter((u) => u.admin && !u.disabled_at && this.store.contraptionEnabled('mandate', u.id));
    const open = new Map(problems.map((x) => [x.key, x.title]));
    for (const [key, title] of open) {
      const sent = (saved.sent[key] ??= {});
      for (const u of admins) {
        if (sent[u.id] === title) continue;
        if (await this.deps.mandate(p, u, itemKey(key), title)) sent[u.id] = title;
      }
    }
    for (const [key, sent] of Object.entries(saved.sent)) {
      if (open.has(key)) continue;
      for (const uid of Object.keys(sent)) {
        const u = this.store.getUser(Number(uid));
        if (!u || (await this.deps.mandate(p, u, itemKey(key), null))) delete sent[uid];
      }
      if (!Object.keys(sent).length) delete saved.sent[key];
    }
  }

  /** A GitHub answer's body, from cache on a 304; null for a 404 or 403 when `quiet`; anything else throws. */
  private async read(path: string, as: GithubEnv, quiet = false): Promise<any> {
    const had = this.cache.get(path);
    const r = await this.get(path, had?.etag ?? null, as);
    if (r.status === 304 && had) return had.body;
    if (r.status === 200) {
      this.cache.set(path, { etag: r.etag, body: r.body });
      return r.body;
    }
    if (r.status === 429 || (r.status === 403 && /rate limit/i.test(String(r.body?.message ?? '')))) throw new RateLimited();
    if (quiet && (r.status === 403 || r.status === 404)) return null;
    // Anything else skips this scheme's round: an answer GitHub didn't give mustn't read as "all clear" and clear alerts.
    throw new Error(`GitHub answered ${r.status} for ${path}`);
  }

  private async jobs(slug: string, r: Run, as: GithubEnv): Promise<Job[]> {
    const key = `${slug}:${r.id}:${r.run_attempt ?? 1}`;
    const kept = this.jobsOf.get(key);
    if (kept) return kept;
    const body = await this.read(`repos/${slug}/actions/runs/${r.id}/jobs?per_page=100`, as);
    const jobs: Job[] = Array.isArray(body?.jobs) ? body.jobs : [];
    if (r.status === 'completed' && Array.isArray(body?.jobs)) {
      this.jobsOf.set(key, jobs);
      this.cache.delete(`repos/${slug}/actions/runs/${r.id}/jobs?per_page=100`);
      if (this.jobsOf.size > 2000) this.jobsOf.delete(this.jobsOf.keys().next().value!);
    }
    return jobs;
  }

  /** GitHub's own words on why a job didn't start: its check run's first annotation. */
  private async reason(slug: string, j: Job, as: GithubEnv): Promise<string | null> {
    if (!this.reasons.has(j.id)) {
      const notes = await this.read(`repos/${slug}/check-runs/${j.id}/annotations`, as, true);
      this.reasons.set(j.id, Array.isArray(notes) && typeof notes[0]?.message === 'string' ? notes[0].message.replace(/\s+/g, ' ').trim() : null);
      this.cache.delete(`repos/${slug}/check-runs/${j.id}/annotations`);
      if (this.reasons.size > 500) this.reasons.delete(this.reasons.keys().next().value!);
    }
    return this.reasons.get(j.id) ?? null;
  }

  private sayOnce(key: string, text: string) {
    if (this.said.has(key)) return;
    this.said.add(key);
    console.warn(text);
  }
}
