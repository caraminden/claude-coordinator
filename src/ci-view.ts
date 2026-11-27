// What GitHub's answers hold and how the CI page shows them (#968, #1019): runs, jobs, runners, the saved view, whose
// minion a run tests. Moved out of src/ci-health.ts (#1954). No GitHub calls of its own.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runUrl, servers } from './ci-problems.ts';
import type { Ticket } from './db.ts';
const run = promisify(execFile);

export interface Run {
  id: number;
  name: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at?: string;
  run_attempt?: number;
  run_number?: number;
  run_started_at?: string;
  html_url?: string;
  /** What started it: push, pull_request, schedule, workflow_dispatch… */
  event?: string;
  /** Its workflow file, ".github/workflows/drift.yml". */
  path?: string;
  /** The run name: a workflow with a run-name shows its inputs here (flake-proof.yml: "flake-proof test/x.test.ts"). */
  display_title?: string;
  triggering_actor?: { login?: string } | null;
}
export interface Job {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  runner_name: string | null;
  labels: string[];
  steps?: unknown[];
}
/** The parts of a GitHub list answer this file reads (the others are left out). */
export interface GhBody {
  workflows?: { id: number; name: string; path?: string; state?: string }[];
  workflow_runs?: Run[];
  runners?: Runner[];
  jobs?: Job[];
  artifacts?: { id: number; name: string; expired: boolean; expires_at?: string | null }[];
  default_branch?: string;
  commit?: { sha?: string };
  value?: unknown;
  total_count?: number;
  /** A file's bytes, base64. */
  content?: string;
  message?: string;
}
/** One annotation on a check run. */
export interface GhNote {
  annotation_level?: string;
  message?: string;
}
export interface Runner {
  name: string;
  status: string;
  busy?: boolean;
  labels?: { name: string }[];
}
/** A run as the CI page lists it. */
export interface ViewRun {
  id: number;
  name: string;
  branch: string;
  event?: string;
  status: string;
  conclusion: string | null;
  at: string;
  url: string;
  /** The minion whose change it tests (#1019, runMinion), when one is. */
  minion?: number | null;
  /** #2231: where its jobs ran (GitHub's runners, or the scheme's own), how long from its push to its last job once done, and its split on GitHub's runners. Absent in older views. */
  where?: Where | null;
  secs?: number | null;
  shards?: Shards | null;
  /** Why the ship script moved this run off GitHub (#2231): the run after it on its branch took over. */
  moved?: string;
}
export type Where = 'github' | 'own';
/** A run's matrix on GitHub's runners (a ship's 20 shards, ADR 0043): how many, started, green, red and still waiting for a slot. */
export interface Shards {
  n: number;
  started: number;
  done: number;
  red: number;
  queued: number;
}
/** A ship's CI gone somewhere else (#2231), from the ship script's retro log: off GitHub to the scheme's own runners (`ci to desktop`), or to perigee's suite (`ci fallback`). */
export interface Fallback {
  at: number;
  to: 'own' | 'perigee';
  branch: string;
  why: string;
  minion?: number | null;
}
/** A scheme's CI as the last poll read it, for the CI page (#968): runners, the queue, each workflow's verdict on main, recent runs. */
export interface CiView {
  at: number;
  slug: string;
  branch: string;
  /** Null when its runners can't be listed (no repo admin's linked GitHub). */
  runners: { name: string; status: string; busy: boolean; labels: string[]; job: string | null; offlineSince: number | null }[] | null;
  waiting: { name: string; labels: string[]; since: string; run: number; branch?: string; event?: string; minion?: number | null }[];
  /** Jobs running now, on which runner, since when and for which minion (Cara, 2026-11-18: "show what is running on the CI"); absent in older views. */
  running?: { name: string; runner: string; since: string; run: number; branch?: string; event?: string; minion?: number | null }[];
  /** The queue per set of runner labels, with how many online runners serve it (null when they can't be listed). */
  queues?: { labels: string[]; jobs: number; runners: number | null }[];
  /** `quiet`: in the scheme's ci_quiet and not its ci_watch, so its red rings no one (TWIReader #990); set by snapshot from the settings now. */
  workflows: { name: string; file: string; verdict: ViewRun | null; skipped: string[]; quiet?: boolean }[];
  runs: ViewRun[];
  /** The last day's ship CI fallbacks, oldest first (#2231); absent in older views and for a scheme whose ship script writes no retro log. */
  fallbacks?: Fallback[];
}
export const viewRun = (slug: string, r: Run, minion: (r: Run) => number | null = () => null, jobs?: Job[]): ViewRun => ({
  id: r.id,
  name: r.name,
  branch: r.head_branch,
  event: r.event,
  status: r.status,
  conclusion: r.conclusion,
  at: r.created_at,
  url: r.html_url ?? runUrl(slug, r),
  minion: minion(r),
  ...(jobs && runShape(r, jobs)),
});

const selfHosted = (j: Job) => j.labels.some((l) => /^self-hosted$/i.test(l));
const RED_JOB = new Set(['failure', 'timed_out']);
/**
 * #2231: where a run's jobs ran, how long from its push to its last job, and its matrix on GitHub's runners. A job GitHub skipped
 * ran nowhere (a ship's run on GitHub skips the desktop's `test` job; a desktop run skips `times`). Any job on the scheme's own
 * runners makes it theirs. The shards are the biggest matrix (jobs named `name (…)`) on GitHub's runners, two jobs at least.
 */
export function runShape(r: Run, jobs: Job[]): Pick<ViewRun, 'where' | 'secs' | 'shards'> {
  const ran = jobs.filter((j) => j.run_id === r.id && j.conclusion !== 'skipped');
  const where: Where | null = ran.some(selfHosted) ? 'own' : ran.length ? 'github' : null;
  const ends = ran.map((j) => Date.parse(j.completed_at ?? '')).filter(Number.isFinite);
  const end = ends.length ? Math.max(...ends) : Date.parse(r.updated_at ?? '');
  const secs = r.status === 'completed' && Number.isFinite(end) ? Math.max(0, Math.round((end - Date.parse(r.created_at)) / 1000)) : null;
  const groups = Map.groupBy(
    ran.filter((j) => !selfHosted(j) && / \(.+\)$/.test(j.name)),
    (j) => j.name.replace(/ \(.+\)$/, ''),
  );
  const biggest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  const shards =
    biggest && biggest.length >= 2
      ? {
          n: biggest.length,
          started: biggest.filter((j) => j.status === 'in_progress' || j.status === 'completed').length,
          done: biggest.filter((j) => j.conclusion === 'success').length,
          red: biggest.filter((j) => RED_JOB.has(j.conclusion ?? '')).length,
          queued: biggest.filter((j) => j.status === 'queued' || j.status === 'waiting' || j.status === 'pending').length,
        }
      : null;
  return { where, secs, shards };
}

/** The ship script's fallback lines (#2231) as the CI page lists them: `ci to desktop · <branch> · <why>` and `ci fallback · <branch> · <why>[ · …]`. */
export function fallbacksOf(lines: { at: number; kind: string; parts: string[] }[]): Fallback[] {
  return lines
    .filter((l) => (l.kind === 'ci to desktop' || l.kind === 'ci fallback') && l.parts[0])
    .map((l) => ({ at: l.at, to: l.kind === 'ci to desktop' ? ('own' as const) : ('perigee' as const), branch: l.parts[0], why: l.parts[1] ?? '' }))
    .sort((a, b) => a.at - b.at);
}

/** A ship run on GitHub that the ship script moved off it (#2231): a `ci to desktop` line for its branch from its push until shortly after it stopped (land.sh cancels it, dispatches the desktop run, then writes the line, so the dispatched take-over is never the moved one). */
export const MOVED_TAIL_MS = 3 * 60_000;
export function movedOff(r: { head_branch: string; created_at: string; updated_at?: string; event?: string }, fallbacks: Fallback[]): Fallback | undefined {
  if (!r.head_branch.startsWith('land/') || r.event === 'workflow_dispatch') return undefined;
  const branch = r.head_branch.slice('land/'.length);
  const from = Date.parse(r.created_at),
    to = Date.parse(r.updated_at ?? r.created_at) + MOVED_TAIL_MS;
  return fallbacks.find((f) => f.to === 'own' && f.branch === branch && f.at >= from && f.at <= to);
}

/** One push-to-verdict reading (#2231): a ship run with a verdict, from its push (a fallback's: the GitHub run's push) to its last job. */
export interface ShipTime {
  runId: number;
  sha: string;
  branch: string;
  workflow: string;
  at: number;
  value: number;
}
/**
 * The last day's ship runs' push-to-verdict, for the Numbers tab: each `land/` run that ended green or red, on GitHub or the
 * scheme's own runners. A run moved off GitHub has no verdict of its own; the run that took it over (the next on its branch,
 * within FALLBACK_MS) counts from the first run's push. `runs` newest first, as GitHub lists them.
 */
const FALLBACK_MS = 15 * 60_000;
export function shipTimes(runs: Run[], jobs: Job[], fallbacks: Fallback[]): ShipTime[] {
  const out: ShipTime[] = [];
  const land = runs.filter((r) => r.head_branch.startsWith('land/')).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const [i, r] of land.entries()) {
    if (r.status !== 'completed' || !(r.conclusion === 'success' || RED_JOB.has(r.conclusion ?? ''))) continue;
    if (movedOff(r, fallbacks)) continue;
    const shape = runShape(r, jobs);
    if (shape.secs == null || !shape.where) continue;
    const prev = land.slice(0, i).findLast((x) => x.head_branch === r.head_branch);
    const from = prev && movedOff(prev, fallbacks) && Date.parse(r.created_at) - Date.parse(prev.created_at) <= FALLBACK_MS ? Date.parse(prev.created_at) : Date.parse(r.created_at);
    const end = Date.parse(r.created_at) + shape.secs * 1000;
    out.push({ runId: r.id, sha: r.head_sha, branch: r.head_branch, workflow: `${r.name} on ${shape.where === 'github' ? 'GitHub' : 'own runners'}`, at: end, value: Math.round((end - from) / 1000) });
  }
  return out;
}

/**
 * The minion a run tests (#1019, Cara 2026-11-18: "These lines in CI should link to the minions whose tests they are for"): the one whose
 * branch it ran on (a land's CI copy runs on land/<branch>, a ship's own check on check/<branch>, #1567, an early next train's on early/<branch>, #1568, a pre-ship run's on pre/<branch>, #2210), else the one whose branch tip is its commit (a land's push to the default branch).
 * shortcut: a branch that moved on after its land no longer tops the commit, so that push reads as the default branch's own; upgrade if lands start recording their commit.
 */
export function runMinion(branch: string, sha: string, tickets: Pick<Ticket, 'number' | 'branch' | 'kind'>[], tips: Map<string, string[]>): number | null {
  const of = (b: string) => tickets.find((t) => t.kind === 'ticket' && t.branch === b)?.number ?? null;
  return of(branch.replace(/^(land|check|early|pre)\//, '')) ?? (tips.get(sha) ?? []).map(of).find((n) => n != null) ?? null;
}

/** The view's running jobs and its queue per set of labels, so a long queue reads "1 runner, 9 queued". */
export function runningNow(all: Job[], runs: Run[], runners: Runner[] | null, minion: (r: Run) => number | null): Pick<CiView, 'running' | 'queues'> {
  const ofRun = (j: Job) => {
    const r = runs.find((x) => x.id === j.run_id);
    return r ? { branch: r.head_branch, event: r.event, minion: minion(r) } : {};
  };
  const running = all.filter((j) => j.status === 'in_progress' && j.runner_name).map((j) => ({ name: j.name, runner: j.runner_name!, since: j.started_at ?? j.created_at, run: j.run_id, ...ofRun(j) }));
  const groups = new Map<string, Job[]>();
  for (const j of all.filter((x) => x.status === 'queued' || x.status === 'waiting')) {
    const key = [...j.labels].sort().join(',');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(j);
  }
  const queues = [...groups.values()]
    .map((js) => ({
      labels: [...js[0].labels].sort(),
      jobs: js.length,
      runners: runners && servers(runners, js[0]).filter((r) => r.status === 'online').length,
    }))
    .sort((a, b) => b.jobs - a.jobs);
  return { running, queues };
}

/** What a run with no minion is, for the CI page: a schedule, a run by hand, the default branch itself, or its branch. */
export function runKind(r: { branch?: string; event?: string }, main: string): string {
  if (r.event === 'schedule') return 'scheduled run';
  if (r.event === 'workflow_dispatch') return `run by hand on ${r.branch ?? main}`;
  return r.branch === main ? `${main} itself` : (r.branch ?? '');
}

/** A repo's branch tips, commit → branch names; empty with no repo on this box or when git fails. */
export async function branchTips(dir: string | null | undefined): Promise<Map<string, string[]>> {
  const tips = new Map<string, string[]>();
  if (!dir) return tips;
  try {
    const { stdout } = await run('git', ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/'], { cwd: dir });
    for (const [sha, ref] of stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')))
      (tips.get(sha) ?? tips.set(sha, []).get(sha)!).push(ref);
  } catch {
    /* no tips: runs on minion branches still link */
  }
  return tips;
}

/**
 * #2231: the fallbacks off GitHub since the last ship run on GitHub that reached its own verdict, oldest first: the streak the
 * CI page rings on (ownFallbackProblems), as the perigee one rings on the land gate's. A ship still running clears nothing.
 */
export function fallbackStreak(runs: Run[], jobs: Job[], fallbacks: Fallback[]): Fallback[] {
  const onGithub = runs.filter((r) => r.head_branch.startsWith('land/') && runShape(r, jobs).where === 'github').sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let since = -Infinity;
  for (const r of onGithub) if (r.status === 'completed' && (r.conclusion === 'success' || RED_JOB.has(r.conclusion ?? '')) && !movedOff(r, fallbacks)) since = Date.parse(r.created_at);
  return fallbacks.filter((f) => f.to === 'own' && f.at > since);
}
