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
}
export const viewRun = (slug: string, r: Run, minion: (r: Run) => number | null = () => null): ViewRun => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.created_at, url: r.html_url ?? runUrl(slug, r), minion: minion(r) });

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
