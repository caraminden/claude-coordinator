// CI health (#368; ask C3 of shared/project/specs/native-app-ci-asks-2026-11.md): Citadel watches every scheme's
// GitHub Actions and tells a person when CI is unwell in a way a red test doesn't show:
//   - a runner offline (GitHub's own runner list, so session runners too);
//   - jobs that never started (0 steps, no runner: a billing block) or sat queued with no runner to take them;
//   - a green run on main that skipped jobs which ran the time before (a quiet item, not an alert: below);
//   - no verdict on main for hours while runs keep coming.
// Every admin gets one Mandate alert item for all the open problems of every scheme (Cara, 2026-11-07: "Send a
// mandate alert to admins"; 2026-11-11: "bundle the CI failure alerts from mandate into one instead of me getting
// like 10 when CI is down"), from a CI health sender of its own. It rings once when it opens (Mandate pushes only a
// new item, #540), takes new words quietly while problems come and go, and is cleared when the last one is, so the
// next outage rings again. A green run never
// alarms (Cara, 2026-11-11: "I also definitely don't need alerts when CI goes green"): alert items ring like
// an alarm on her phone (Mandate #75), so only real trouble is one, and anything informational is quiet. It polls with the scheme
// owner's linked GitHub (as the PR watcher and runner list do; the box's login without one), every 5 minutes,
// with ETags so an unchanged answer (a 304) costs no rate limit.
// One exception tells a Taskmaster, not a person (#588, Josh's pick on #581's card, 2026-11-12: "CI health tells
// it"): a scheduled run on the default branch that failed. It tests main as it is, so no land saw the break (Citadel's
// nightly runs the pipeline tests lands leave out); the scheme's Taskmaster hears once per run, to start a bug minion.
// #678 (Cara's pick on Peek Auras #355's card, 2026-11-14: "Ask Citadel to watch it") widens that to every run no PR
// started: a workflow_dispatch run on a minion's branch wakes that minion with its result, red or green, as a PR's CI
// would; a failed one on the default branch, like a failed scheduled run, is held mail for the Taskmaster, and the
// next green run of that workflow says it's back to green. A scheme quiets a workflow in its settings (ci_quiet).
// #774 (Cara's pick on a Peek card, 2026-11-15: "Land, then alert"): a scheme also lists workflows to watch (ci_watch).
// When one's newest verdict on the default branch, from any trigger (a land's push too), is red, the Taskmaster is
// woken once for that red streak, sharing the red mark above, so later red runs say nothing until it's back to green.
// #968 (Cara, 2026-11-18: "alerts should only happen when something is broken and needs fixing, and there should be
// more insight into what happened and why and how we can fix it"; her picks on #968's card the same day) narrows what
// rings to what needs a person, and every item says what, why and the fix and links the CI page (#/p/N/ci):
//   - a red on main ("Quiet item, Taskmaster fixes"): every workflow not in ci_quiet is watched as #774's were, its
//     Taskmaster woken to start a fix minion, and the scheme gets a quiet item; it rings only when no minion naming the
//     run starts within RED_FIX_MS, or the newest verdict after that minion closed is still red;
//   - an offline runner ("Ring when work waits"): only once a job has waited WAIT_MS on labels only offline runners serve;
//   - a busy queue ("Nothing; page only"): rings only for a runner on one job over HUNG_MS, which is probably hung;
//   - no verdict for hours ("Drop it") and green with jobs skipped ("Page only"): the CI page shows them, no item;
//   - the land gate ("Quiet, ring after 1 h"): a quiet item at the old thresholds, ringing at LAND_RING_MS or LAND_RING_STREAK.
// Jobs that never started (a billing block) still ring.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AlertPart } from './alert-wakes.ts';
import { lines } from './approvals.ts';
import { APP_NAME } from './appname.ts';
import { schemeLabels } from './ci-runner.ts';
import type { Project, Store, Ticket, User } from './db.ts';
import { repoSlug } from './prlinks.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';
import { pacific } from './pacific.ts';

const run = promisify(execFile);

const POLL_MS = 5 * 60_000;
const RATE_LIMITED_MS = 15 * 60_000;
// Runs looked at for jobs that didn't start or wait for a runner; older ones are history.
const RUNS = 50;
const WINDOW_MS = 24 * 3600_000;
/** A job waiting this long on labels only offline runners serve rings. */
export const WAIT_MS = 10 * 60_000;
/** A runner on one job this long is probably hung. */
export const HUNG_MS = 2 * 3600_000;
/** A red on main with no minion naming its run this long after the Taskmaster heard rings. */
export const RED_FIX_MS = 3600_000;
// A land/** run still queued this long has no landing waiting on it (a gate gives up after minutes): GitHub lost it.
export const ORPHAN_MS = 3600_000;
// A workflow with no run on main this long is a manual or retired one, never "missing a verdict".
const ACTIVE_MS = 7 * 24 * 3600_000;
const VERDICTS = new Set(['success', 'failure']);
const RAN = new Set(['success', 'failure']);

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
}
/** A scheme's CI as the last poll read it, for the CI page (#968): runners, the queue, each workflow's verdict on main, recent runs. */
export interface CiView {
  at: number;
  slug: string;
  branch: string;
  /** Null when its runners can't be listed (no repo admin's linked GitHub). */
  runners: { name: string; status: string; busy: boolean; labels: string[]; job: string | null; offlineSince: number | null }[] | null;
  waiting: { name: string; labels: string[]; since: string; run: number }[];
  workflows: { name: string; file: string; verdict: ViewRun | null; skipped: string[] }[];
  runs: ViewRun[];
}
const viewRun = (slug: string, r: Run): ViewRun => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.created_at, url: r.html_url ?? runUrl(slug, r) });
/** Something wrong now: what the alert says, keyed so the same trouble keeps one item. */
export interface Problem {
  key: string;
  /** What happened, starting "CI: ". */
  title: string;
  /** Why it happened, as far as Citadel can tell. */
  why?: string;
  /** What fixes it, and who. */
  fix?: string;
  /** Informational: a plain item, never an alarm. */
  quiet?: boolean;
}

const cap = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A problem's words for an item: what, then why and the fix (Mandate keeps 500 characters). */
export const itemText = (x: Problem, lead = x.title) => cap([lead.replace(/\.$/, ''), x.why && `Why: ${x.why.replace(/\.$/, '')}`, x.fix && `Fix: ${x.fix.replace(/\.$/, '')}`].filter(Boolean).join('. ') + '.');

const at = (s: string) => Date.parse(s);
const short = (sha: string) => sha.slice(0, 7);
const runUrl = (slug: string, r: Run) => `https://github.com/${slug}/actions/runs/${r.id}`;
/** A run's workflow file name, as a scheme's ci_quiet lists it. */
const workflowFile = (r: Run) => (r.path ?? '').split('/').pop() || r.name;
/** When dispatched runs started counting (#678), so the deploy that brought them told none from before. */
const DISPATCH_SINCE = 'ci-health:dispatch-since';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Nov 5, 10:31 PST". Always dated: a title that dropped it for today would change at midnight and re-send the alert (#509). */
export const clock = pacific;

/** Keep `offline` (runner name → first seen offline) in step with the runner list, in place. */
export function trackOffline(runners: Runner[], offline: Record<string, number>, now: number): void {
  const names = new Set(runners.map((r) => r.name));
  for (const name of Object.keys(offline)) if (!names.has(name)) delete offline[name];
  for (const r of runners) {
    if (r.status !== 'offline') delete offline[r.name];
    else offline[r.name] ??= now;
  }
}

/** The repo's runners that can take a job: they carry every label it asks for (GitHub matches them case-blind). */
export function servers(runners: Runner[], j: Pick<Job, 'labels'>): Runner[] {
  const want = j.labels.map((l) => l.toLowerCase());
  return runners.filter((r) => want.every((l) => r.labels?.some((x) => x.name.toLowerCase() === l)));
}

/**
 * Work stuck on dead runners: jobs queued WAIT_MS or more whose labels only offline runners serve, per set of labels.
 * A queue behind busy online runners, or on GitHub's hosted runners (none of the repo's serve it), is the page's.
 */
export function stuckProblems(runners: Runner[], jobs: Job[], offline: Record<string, number>, now: number): Problem[] {
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    if (j.status !== 'queued' || now - at(j.created_at) < WAIT_MS) continue;
    const can = servers(runners, j);
    if (can.length && can.every((r) => r.status === 'offline')) groups.set(labelsOf(j), [...(groups.get(labelsOf(j)) ?? []), j]);
  }
  return [...groups].map(([labels, waiting]) => {
    const can = servers(runners, waiting[0]);
    const names = can.map((r) => r.name);
    const host = sharedHost(names) ?? (names.length === 1 ? names[0].replace(/(-linux)?(-\d+)?$/i, '') : null);
    const down = Math.min(...can.map((r) => offline[r.name] ?? now));
    const since = Math.min(...waiting.map((j) => at(j.created_at)));
    return {
      key: `stuck:${labels}`,
      title: `CI: ${plural(waiting.length, 'job')} on ${labels} ${waiting.length === 1 ? 'has' : 'have'} waited for a runner since ${clock(since)}`,
      why: `every runner that serves ${labels} (${names.join(', ')}) is offline, since ${clock(down)}`,
      fix: host ? `turn on ${host} or restart its runner service; once one is online the jobs start by themselves` : `bring one of those runners back online; the jobs start by themselves`,
    };
  });
}

/** Runners on one job HUNG_MS or more: no job here runs that long, so it is probably hung. */
export function hungProblems(jobs: Job[], now: number): Problem[] {
  return jobs.filter((j) => j.status === 'in_progress' && j.runner_name && j.started_at && now - at(j.started_at) >= HUNG_MS).map((j) => ({
    key: `hung:${j.runner_name}`,
    title: `CI: runner ${j.runner_name} has run ${j.name} (run ${j.run_id}) since ${clock(at(j.started_at!))}`,
    why: 'over 2 h on one job is far past a normal run, so it is probably hung (a test waiting forever, or its PC asleep mid-job), and jobs queued for it wait',
    fix: `cancel run ${j.run_id} on GitHub, then restart the runner if it stays busy`,
  }));
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
  const billing = !!reason && /billing|spending limit|payment|budget/i.test(reason);
  return {
    key: `nostart:${g.labels}`,
    title: `CI: ${plural(n, 'job')} on ${g.labels} didn't start since ${clock(at(g.dead[0].created_at))}, so ${n === 1 ? "it isn't a test failure" : "they aren't test failures"}`,
    why: reason ? `GitHub says: "${cap(reason, 300)}"` : 'no runner took them and GitHub gave no reason',
    fix: billing ? "raise the Actions spending limit or fix the payment in the repo owner's GitHub billing settings, then re-run them"
      : `check that a runner carries ${g.labels} and is online, then re-run them`,
  };
}

/**
 * Queued land/** runs older than ORPHAN_MS that no landing in the line waits on: not a run id a landing holds, nor a
 * branch of a landing's ticket (land/ticket/551-…), so a landing that hasn't read its run yet keeps it.
 */
export function orphanRuns(runs: Run[], line: Record<string, { name: string; run?: number | null; ciSince?: number; tests?: boolean; green?: boolean }>, now: number): Run[] {
  const held = Object.values(line);
  // A landing in its CI wait whose run we haven't read may be about to take any run of its commit (land.sh finds one by SHA, whatever its branch).
  if (held.some((l) => l.ciSince != null && !l.run && !l.tests && !l.green)) return [];
  return runs.filter((r) => r.status === 'queued' && r.head_branch.startsWith('land/') && now - at(r.created_at) >= ORPHAN_MS
    && !held.some((l) => l.run === r.id || (/^#(\d+)$/.test(l.name) && r.head_branch.includes(`/${l.name.slice(1)}-`))));
}

/** Where a failed job failed: "job › step". */
const place = (job: Job) => {
  const step = (job.steps as { name?: string; conclusion?: string }[] | undefined)?.find((x) => x.conclusion === 'failure')?.name;
  return `${job.name}${step ? ` › ${step}` : ''}`;
};

/** A red on the default branch as kept until it's back to green: its first red run, when its Taskmaster heard, where it failed. */
export interface RedMark {
  run: number;
  at: string;
  told?: number;
  where?: string;
}
/** The minion fixing a red, and when it closed (null while open). */
export interface Fix {
  number: number;
  closedAt: number | null;
}

/**
 * A red on main (#968, Cara: "Quiet item, Taskmaster fixes"): a quiet item while a fix is on its way, ringing when none
 * started within RED_FIX_MS of the Taskmaster hearing, or the newest verdict, made after the fix minion closed, is still
 * red, or that minion closed RED_FIX_MS ago with no newer run. `newest` is the workflow's newest verdict there; green, and there is nothing to say.
 */
export function redProblem(file: string, branch: string, mark: RedMark, newest: Run, fix: Fix | null, now: number): Problem | null {
  if (newest.conclusion !== 'failure') return null;
  const told = mark.told ?? now;
  const key = `red:${newest.workflow_id}`;
  const what = `CI: ${file} failed on ${branch} (run ${mark.run}${mark.where ? `, at ${mark.where}` : ''})`;
  if (fix?.closedAt != null && at(newest.created_at) > fix.closedAt) {
    return { key, title: `${what}, and is still red after fix minion #${fix.number} closed`,
      why: `run ${newest.id} on ${short(newest.head_sha)}, made after #${fix.number} closed at ${clock(fix.closedAt)}, failed too, so the fix didn't hold`,
      fix: `reopen #${fix.number} or start another fix minion naming run ${newest.id}; if it's CI itself (a runner, GitHub), add ${file} to the scheme's quiet CI workflows` };
  }
  // Closed an hour with no newer run: it landed nothing that ran CI, so main is still red with nobody on it.
  if (fix?.closedAt != null && now - fix.closedAt >= RED_FIX_MS) {
    return { key, title: `${what}, and is still red an hour after fix minion #${fix.number} closed`,
      why: `no ${file} run on ${branch} has gone green since #${fix.number} closed at ${clock(fix.closedAt)}`,
      fix: `reopen #${fix.number} or start another fix minion naming run ${mark.run}; if a fix landed, re-run ${file} on ${branch} to check it` };
  }
  if (fix) {
    return { key, quiet: true, title: `${what}: fix minion #${fix.number} ${fix.closedAt == null ? 'started' : 'closed, waiting on the next run'}`,
      why: `the newest ${file} verdict on ${branch} is red`, fix: `#${fix.number} is on it; this clears when ${file} is back to green` };
  }
  const late = now - told >= RED_FIX_MS;
  return { key, quiet: !late, title: `${what}${late ? ': no fix minion started' : ''}`,
    why: late ? `its Taskmaster heard at ${clock(told)} and no minion naming run ${mark.run} has started since` : `the newest ${file} verdict on ${branch} is red; its Taskmaster heard at ${clock(told)}`,
    fix: late ? `ask the Taskmaster to start a fix minion naming run ${mark.run}, or add ${file} to the scheme's quiet CI workflows if the red is expected`
      : `the Taskmaster starts a fix minion naming run ${mark.run}; this rings at ${clock(told + RED_FIX_MS)} if none has` };
}

/** The newest two verdict runs of a workflow's runs on the default branch (newest first): the one to check, and the one before. */
export function verdictPair(runs: Run[]): [Run, Run] | null {
  const v = runs.filter((r) => r.status === 'completed' && VERDICTS.has(r.conclusion ?? ''));
  return v.length >= 2 && v[0].conclusion === 'success' ? [v[0], v[1]] : null;
}

/**
 * The jobs a green run skipped that ran (passed or failed) in the verdict before it: green that proves less than it
 * says. The CI page shows them (#968, Cara: "Page only"), as a docs-only land skips them on purpose.
 */
export function skippedJobs(latestJobs: Job[], beforeJobs: Job[]): string[] {
  const ran = new Set(beforeJobs.filter((j) => RAN.has(j.conclusion ?? '')).map((j) => j.name));
  return latestJobs.filter((j) => j.conclusion === 'skipped' && ran.has(j.name)).map((j) => j.name);
}

/** The schemes named, up to three, or counted. */
const schemesText = (names: string[]) => (names.length > 3 ? `${names.length} schemes` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

/**
 * The PC a set of runners share, if they do: runner names are its computer name, with -2, -perf or -linux and the
 * like after it (tools/ci-runner/add-runner.*).
 */
export function sharedHost(names: string[]): string | null {
  if (names.length < 2) return null;
  const host = names.map((n) => n.replace(/(-linux)?(-\d+)?$/i, '')).sort((a, b) => a.length - b.length)[0];
  const h = host.toLowerCase();
  return names.every((n) => n.toLowerCase() === h || n.toLowerCase().startsWith(`${h}-`)) ? host : null;
}

/**
 * The one alert's words for every scheme's open problems: one in full (what, why, fix); several counted, then each in
 * turn, cut to Mandate's 500 characters. The CI page it links has them all.
 */
export function bundleTitle(open: { scheme: string; problem: Problem }[]): string {
  const what = (x: { problem: Problem }) => x.problem.title.replace(/^CI: /, '');
  if (open.length === 1) return itemText(open[0].problem, `CI, ${open[0].scheme}: ${what(open[0])}`);
  const each = open.map((x) => itemText(x.problem, `${x.scheme}: ${what(x)}`).replace(/\.$/, ''));
  return cap(`CI: ${plural(open.length, 'problem')} in ${schemesText([...new Set(open.map((x) => x.scheme))])}. ${each.join('; ')}.`);
}
/** Who the one alert comes from in Mandate: no scheme of its own, so a switch for CI health alone. */
/** The CI page's address (#968), which every CI item links. */

export const ciPage = (projectId: number) => `/c/#/p/${projectId}/ci`;
export const CI_SENDER = { id: 0, name: 'CI health' };
const BUNDLE_ITEM = 'ci.open';

/** A Mandate item key for a problem (Mandate allows A-Z a-z 0-9 . _ : - and 128 characters). */
export const itemKey = (key: string) => `ci.${key.replace(/[^A-Za-z0-9._:-]+/g, '_')}`.slice(0, 128);

// ---------- the land gate (#561) ----------
// Josh's pick, 2026-11-11 ("Add the live alarm"): the CI gate that tools/land.sh waits on hung for hours on 11-11 and
// nobody heard. So the one alert also says when the gate fell back to perigee on LAND_STREAK lands in a row (cleared by
// the next land whose gate is green), or a land has been in the line LAND_SLOW_MS (cleared when it leaves). Read from
// what Waits.poll already sees every 2 s, the land line and ci-wait's view of each gate run: no GitHub calls of its own.
// On 11-10 and 11-11, 130 lands: 30 min was passed once outside the outage; 2 fallbacks in a row only in it, and
// while Cara's desktop was off, which isn't the gate failing (the runner-offline alert says it), so a land that never
// reached the CI wait (no runner online, LAND_CI=0, GitHub not answering) neither counts nor clears.
export const LAND_STREAK = 2;
export const LAND_SLOW_MS = 30 * 60_000;
// #968 (Cara: "Quiet, ring after 1 h"): those make a quiet item; these ring.
export const LAND_RING_STREAK = 4;
export const LAND_RING_MS = 3600_000;
// land.sh's CI_LIMIT is 360 s: a run still going this far into the CI wait was cut off by it.
const LAND_CAP_MS = 5 * 60_000;

/** A landing in the line as Waits.poll sees it. */
export interface LandSeen {
  /** Its ticket's number in the line (tools/deploy-queue.sh). */
  seq: number;
  /** "#551", or its label. */
  name: string;
  /** landPhase's key while it holds the lock (rebase, ci, tests, deploy); 'line' while it waits. */
  phase: string;
  /** Its gate run's stage as ci-wait last read it (CiNow's), and the run's id. */
  ci: string | null;
  run: number | null;
}
interface Landing {
  name: string;
  joined: number;
  ciSince?: number;
  ci?: string | null;
  run?: number | null;
  tests?: boolean;
  green?: boolean;
}
export interface LandState {
  /** By seq: the landings in the line now. */
  lands: Record<string, Landing>;
  /** The fallbacks since the last green gate, oldest first. */
  fellBack: { name: string; why: string; run: number | null }[];
}
export const newLandState = (): LandState => ({ lands: {}, fellBack: [] });

/** Why a land's gate fell back, from what CI said while it waited. shortcut: a rate-limited ci-wait reads as GitHub's; land.sh's own reason would need it to say so in the line. */
function fellBackWhy(l: Landing, now: number): string {
  if (!l.ci) return 'GitHub never started its run';
  if (l.ci === 'queued') return 'no runner started its job';
  if (l.ci === 'failed') return 'its run failed before the tests ran';
  if (l.ci === 'jobs' && now - (l.ciSince ?? now) >= LAND_CAP_MS) return 'the desktop suite hit the 6-min cap';
  return 'CI gave no verdict';
}

/** One look at the line: landings join and leave, a fallback adds to the count, a green gate ends it. Updates `s` in place. */
export function landStep(s: LandState, seen: LandSeen[], now: number): LandState {
  const here = new Set<string>();
  for (const x of seen) {
    if (x.name === 'tools/deploy.sh') continue; // a deploy on its own isn't a land
    const key = String(x.seq);
    here.add(key);
    const l = (s.lands[key] ??= { name: x.name, joined: now });
    if (x.phase === 'ci') {
      l.ciSince ??= now;
      if (x.ci) l.ci = x.ci;
      if (x.run) l.run = x.run;
    } else if (x.phase === 'tests' && !l.tests) {
      l.tests = true;
      if (l.ciSince != null) s.fellBack.push({ name: l.name, why: fellBackWhy(l, now), run: l.run ?? null });
    } else if (x.phase === 'deploy' && !l.tests && !l.green) {
      l.green = true;
      s.fellBack = [];
    }
  }
  for (const key of Object.keys(s.lands)) if (!here.has(key)) delete s.lands[key];
  return s;
}

/** The land gate's problems now: quiet items, ringing at LAND_RING_STREAK fallbacks or LAND_RING_MS in the line. */
export function landProblems(s: LandState, now: number): Problem[] {
  const out: Problem[] = [];
  const n = s.fellBack.length;
  if (n >= LAND_STREAK) {
    const named = s.fellBack.slice(-3).map((f) => `${f.name} (${f.why}${f.run ? `, run ${f.run}` : ''})`);
    const whys = [...new Set(s.fellBack.slice(-3).map((f) => f.why))];
    out.push({
      key: 'land:fallback', quiet: n < LAND_RING_STREAK,
      title: `CI: the land gate fell back to perigee on ${n} lands in a row: ${n > 3 ? `${n - 3} more, then ` : ''}${named.join(', ')}`,
      why: `${whys.join('; ')}, so each land ran the full suite on perigee instead of waiting on CI`,
      fix: whys.some((w) => /runner/.test(w)) ? "check the desktop's Linux runners are online (the CI page's Runners tab); lands go back to CI by themselves"
        : 'open the fallen-back runs on the CI page and fix what stopped them; the next land with a green gate clears this',
    });
  }
  const slow = Object.values(s.lands).filter((l) => now - l.joined >= LAND_SLOW_MS).sort((a, b) => a.joined - b.joined);
  if (slow.length) {
    const names = slow.map((l) => l.name);
    const ring = now - slow[0].joined >= LAND_RING_MS;
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} have` : `${names[0]} has`;
    out.push({
      key: 'land:slow', quiet: !ring,
      title: `CI: ${who} been landing since ${clock(slow[0].joined)} (over ${ring ? '1 h' : '30 min'})`,
      why: 'a land normally takes under 15 min, so its CI run, the suite or the deploy is stuck',
      fix: "read the landing minion's land output for its last queue: line; if nothing has moved for 15 min, tell the Citadel Taskmaster the land is jammed",
    });
  }
  return out;
}

// ---------- wake_when_runners_back (#541) ----------
// A landing whose CI gate got no verdict (the kit's land.sh exits 75: no runner took the run, nearly always the
// desktop off) parks its minion. Its CI ran on a scratch branch the PR watcher never sees, so this poll wakes it:
// once one of its scheme's runners (labelled <scheme>-ci or <scheme>-ci-linux, as ci_runners adds them) is online.

/** A minion parked until its scheme's runners are back; in the settings table, so it outlives a restart. */
export interface RunnerWaiter {
  ticket: number;
  reason: string;
}
export const RUNNER_WAITERS = 'wake-runners-back';

export function runnerWaiters(store: Store): RunnerWaiter[] {
  return store.getSetting<RunnerWaiter[]>(RUNNER_WAITERS) ?? [];
}

/** Wait for `ticket`'s scheme's runners; a second call replaces the first. */
export function addRunnerWaiter(store: Store, ticket: number, reason: string): void {
  store.setSetting(RUNNER_WAITERS, [...runnerWaiters(store).filter((w) => w.ticket !== ticket), { ticket, reason }]);
}

/** The online runners carrying a scheme's label: Windows or Linux, or its session runner's (add-runner.ps1 -Session). */
export function onlineRunners(runners: Runner[], schemeName: string): Runner[] {
  const labels = schemeLabels(schemeName);
  return runners.filter((r) => r.status === 'online' && r.labels?.some((l) => labels.includes(l.name)));
}

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

/** One REST POST through the gh CLI; the status of the answer, 0 when gh printed none. */
export async function ghPost(path: string, as: GithubEnv): Promise<{ status: number }> {
  try {
    const { stdout } = await run('gh', ['api', '-i', '-X', 'POST', path], { env: asEnv(as), timeout: 30_000 });
    return { status: Number(/^HTTP\/\S+ (\d+)/.exec(stdout)?.[1] ?? 0) };
  } catch (err: any) {
    const out = typeof err?.stdout === 'string' ? err.stdout : '';
    if (!/^HTTP\/\S+ \d+/.test(out)) throw err;
    return { status: Number(/^HTTP\/\S+ (\d+)/.exec(out)![1]) };
  }
}

class RateLimited extends Error {}

/** A status GitHub answered that skips the scheme's round. */
class GhError extends Error {
  status: number;
  constructor(status: number, path: string) {
    super(`GitHub answered ${status} for ${path}`);
    this.status = status;
  }
}

// ---------- the poller ----------

/** What is kept across restarts, per scheme: runners first seen offline, its open problems, and its own items' titles. */
interface Saved {
  offline: Record<string, number>;
  /** What was wrong at the last round GitHub fully answered: the one alert is made from these. */
  problems?: Problem[];
  /** Quiet problem key → user id → the title their Mandate item has (alarm keys only until an older build's are cleared). */
  sent: Record<string, Record<string, string>>;
}

/** The land gate's alarm (#561) as kept: whose scheme it is, the line, and its problems. */
interface LandWatch {
  project: number;
  state: LandState;
  problems: Problem[];
  /** The quiet land items each admin has (#968), as `Saved.sent`. */
  sent?: Saved['sent'];
}
const LAND_WATCH = 'ci-health:land';

export interface CiHealthDeps {
  /** The GitHub login to read a scheme's repo as: its owner's linked one, or undefined for the box's. */
  as: (project: Project) => GithubEnv;
  /** Put (with `title`) or clear (null) a person's Mandate item from a scheme or CI_SENDER, an alert unless `quiet`; true once Mandate has it settled. `parts`: the one alert's problems, for the Taskmaster's wake (#869). */
  mandate: (from: Pick<Project, 'id' | 'name'>, person: User, key: string, title: string | null, quiet?: boolean, link?: string, parts?: AlertPart[]) => Promise<boolean>;
  get?: GhGet;
  /** A REST POST (the sweep's cancel); the gh CLI by default. */
  post?: (path: string, as: GithubEnv) => Promise<{ status: number }>;
  /** Message a minion (wake_when_runners_back, a run it dispatched); `fyi` for news that needs nothing: a dispatched run that passed, which also runs at low effort (#951). No message, no wakes. */
  wake?: (ticketId: number, text: string, fyi?: boolean) => void;
  /** Held mail for a scheme's Taskmaster (a failed scheduled run), or a message that wakes it (`wake`: a watched workflow gone red); false (no Taskmaster) or none at all, and those wait untold. */
  tell?: (project: Project, text: string, wake?: boolean) => boolean;
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
  /** Each scheme's jobs of the last day as last read, running and waiting ones too: the CI desktop's load reads them (#534, src/ci-load.ts). */
  recent = new Map<number, Job[]>();

  constructor(store: Store, deps: CiHealthDeps) {
    this.store = store;
    this.deps = deps;
    this.get = deps.get ?? ghGet;
    // The last read survives a restart: without it the CI desktop's view (#534) knew of no job until the first poll.
    for (const p of store.listProjects()) {
      const kept = store.getSetting<Job[]>(`ci-health:recent:${p.id}`);
      if (Array.isArray(kept)) this.recent.set(p.id, kept);
    }
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
            break;
          }
          this.sayOnce(`fail:${p.id}:${err?.message}`, `CI health check of ${p.name} failed (said once until a restart): ${err?.message ?? err}`);
        }
      }
      await this.alert();
    } finally {
      this.busy = false;
    }
  }

  /** One scheme: what's wrong now, kept for the one alert, and its quiet items brought in line. A round that throws keeps the last. */
  async check(p: Project, slug: string, now: number) {
    const saved: Saved = { offline: {}, sent: {}, ...this.store.getSetting<Saved>(`ci-health:${p.id}`) };
    saved.problems = await this.problems(p, slug, saved, now);
    await this.deliver(p, saved.problems.filter((x) => x.quiet), saved);
    this.store.setSetting(`ci-health:${p.id}`, saved);
  }

  private admins() {
    return this.store.listUsers().filter((u) => u.admin && !u.disabled_at && this.store.contraptionEnabled('mandate', u.id));
  }

  /**
   * The land line as Waits.poll saw it (#561), for the live checkout's scheme: the gate's alarm, kept across restarts,
   * goes into the one alert as soon as its words change rather than at the next poll.
   */
  land(projectId: number, seen: LandSeen[], now = Date.now()): Promise<void> {
    // One at a time: the line's calls come every 2 s, and a slow Mandate put mustn't let the next one send it twice.
    const next = this.landing.then(() => this.landNow(projectId, seen, now));
    this.landing = next.catch(() => {});
    return next;
  }
  private landing: Promise<void> = Promise.resolve();

  private async landNow(projectId: number, seen: LandSeen[], now: number) {
    const kept = this.store.getSetting<LandWatch>(LAND_WATCH);
    const w: LandWatch = { project: projectId, state: kept?.state ?? newLandState(), problems: [], sent: kept?.sent ?? {} };
    const before = JSON.stringify([kept?.state, kept?.sent]);
    landStep(w.state, seen, now);
    w.problems = landProblems(w.state, now);
    const changed = JSON.stringify([kept?.project, kept?.problems ?? []]) !== JSON.stringify([w.project, w.problems]);
    // Every call, not only on a change: a put Mandate refused is tried again on the next (sent entries make it a no-op).
    const p = this.store.getProject(projectId);
    if (p) await this.deliver(p, w.problems.filter((x) => x.quiet), w as Required<LandWatch>);
    if (changed || before !== JSON.stringify([w.state, w.sent])) this.store.setSetting(LAND_WATCH, w);
    if (changed) await this.alert();
  }

  private alerting: Promise<void> = Promise.resolve();
  /** Every admin's one alert, from every scheme's open problems: put when its words change, cleared when none are left. One at a time, as the land line's calls come between polls. */
  alert(): Promise<void> {
    const next = this.alerting.then(() => this.sendAlert());
    this.alerting = next.catch(() => {});
    return next;
  }

  private async sendAlert() {
    const open: { scheme: string; problem: Problem; id: number }[] = [];
    const land = this.store.getSetting<LandWatch>(LAND_WATCH);
    for (const p of this.store.listProjects()) {
      if (!repoSlug(p.repo_url)) continue;
      const mine = [...(this.store.getSetting<Saved>(`ci-health:${p.id}`)?.problems ?? []), ...(land?.project === p.id ? land.problems : [])];
      for (const x of mine) if (!x.quiet) open.push({ scheme: p.name, problem: x, id: p.id });
    }
    // User id → the title their item has.
    const sent = this.store.getSetting<Record<string, string>>('ci-health:alert') ?? {};
    const title = open.length ? bundleTitle(open) : null;
    const admins = title ? this.admins() : [];
    const parts = admins.some((u) => sent[u.id] !== title) ? await this.parts(open, land) : [];
    for (const u of admins) {
      if (sent[u.id] !== title && (await this.deps.mandate(CI_SENDER, u, BUNDLE_ITEM, title, false, ciPage(open[0].id), parts))) sent[u.id] = title!;
    }
    for (const uid of Object.keys(sent)) {
      if (admins.some((u) => String(u.id) === uid)) continue;
      const u = this.store.getUser(Number(uid));
      if (!u || (await this.deps.mandate(CI_SENDER, u, BUNDLE_ITEM, null))) delete sent[uid];
    }
    this.store.setSetting('ci-health:alert', sent);
  }

  /** The one alert's problems as the Taskmaster's wake tells them (#869): the land alarm with each fallen-back run's link, failed step and runner. */
  private async parts(open: { scheme: string; problem: Problem; id: number }[], land: LandWatch | undefined): Promise<AlertPart[]> {
    return Promise.all(open.map(async ({ scheme, problem, id }) => {
      const part: AlertPart = { id: `${id}:${problem.key}`, title: `${scheme}: ${itemText(problem).replace(/^CI: /, '')}` };
      const p = this.store.getProject(id);
      const slug = p && repoSlug(p.repo_url);
      if (problem.key !== 'land:fallback' || !p || !slug || !land) return part;
      const runs = land.state.fellBack.slice(-3).map((f) => f.run).filter((r): r is number => !!r);
      const said = await Promise.all(runs.map(async (run) => {
        const jobs = await this.guarded(Date.now(), () => this.jobs(slug, { id: run } as Run, this.deps.as(p)));
        const j = jobs?.find((x) => x.conclusion === 'failure');
        const step = (j?.steps as { name?: string; conclusion?: string }[] | undefined)?.find((x) => x.conclusion === 'failure')?.name;
        return `https://github.com/${slug}/actions/runs/${run}: ${j ? `${j.name}${step ? ` › ${step}` : ''} failed${j.runner_name ? ` on ${j.runner_name}` : ''}` : 'no failed job'}`;
      }));
      return said.length ? { ...part, facts: said.join('; ') } : part;
    }));
  }

  async problems(p: Project, slug: string, saved: Saved, now: number): Promise<Problem[]> {
    const as = this.deps.as(p);
    const workflows = ((await this.listWorkflows(p, slug, as))?.workflows ?? []).filter((w: any) => w.state === 'active');
    // A repo with no CI costs one conditional request a poll.
    if (!workflows.length) {
      saved.offline = {};
      return [];
    }
    const out: Problem[] = [];

    const listed = await this.read(`repos/${slug}/actions/runners?per_page=100`, as, true);
    const runners: Runner[] | null = Array.isArray(listed?.runners) ? listed.runners : null;
    if (runners) trackOffline(runners, saved.offline, now);
    else this.sayOnce(`runners:${p.id}`, `CI health: can't list ${slug}'s runners (needs a repo admin's linked GitHub), so work stuck on offline runners there goes unseen.`);
    this.wakeParked(p, runners);

    const runs: Run[] = ((await this.read(`repos/${slug}/actions/runs?per_page=${RUNS}`, as))?.workflow_runs ?? [])
      .filter((r: Run) => now - at(r.created_at) <= WINDOW_MS);
    const all: Job[] = [];
    for (const r of runs) all.push(...(await this.jobs(slug, r, as)));
    await this.sweepOrphans(p, slug, runs, as, now);
    this.recent.set(p.id, all);
    this.store.setSetting(`ci-health:recent:${p.id}`, all.map(({ steps, ...j }) => j));
    for (const g of deadGroups(all)) out.push(deadProblem(g, await this.reason(slug, g.dead.at(-1)!, as)));
    // A runner list it can't read keeps the stuck items as they were: it can't tell, so it neither clears nor rings anew.
    out.push(...(runners ? stuckProblems(runners, all, saved.offline, now) : (saved.problems ?? []).filter((x) => x.key.startsWith('stuck:'))));
    out.push(...hungProblems(all, now));

    const branch = (await this.read(`repos/${slug}`, as))?.default_branch ?? 'main';
    const onMain = new Map<number, Run[]>();
    for (const w of workflows) {
      const mainRuns: Run[] = (await this.read(`repos/${slug}/actions/workflows/${w.id}/runs?branch=${encodeURIComponent(branch)}&per_page=${RUNS}`, as))?.workflow_runs ?? [];
      onMain.set(w.id, mainRuns);
    }
    out.push(...(await this.outsideRuns(p, slug, branch, onMain, as, now)));
    const shown: CiView['workflows'] = [];
    for (const w of workflows) {
      const mainRuns = onMain.get(w.id) ?? [];
      const verdict = mainRuns.find((r) => r.status === 'completed' && VERDICTS.has(r.conclusion ?? ''));
      const pair = verdictPair(mainRuns);
      const skipped = pair ? skippedJobs(await this.jobs(slug, pair[0], as), await this.jobs(slug, pair[1], as)) : [];
      shown.push({ name: w.name, file: String(w.path ?? '').split('/').pop() ?? '', verdict: verdict ? viewRun(slug, verdict) : null, skipped });
    }
    this.store.setSetting<CiView>(`ci-health:view:${p.id}`, {
      at: now, slug, branch,
      runners: runners && runners.map((r) => ({
        name: r.name, status: r.status, busy: !!r.busy, labels: (r.labels ?? []).map((l) => l.name),
        job: all.find((j) => j.status === 'in_progress' && j.runner_name === r.name)?.name ?? null, offlineSince: saved.offline[r.name] ?? null,
      })),
      waiting: all.filter((j) => j.status === 'queued' || j.status === 'waiting').map((j) => ({ name: j.name, labels: j.labels, since: j.created_at, run: j.run_id })),
      workflows: shown,
      runs: runs.slice(0, 30).map((r) => viewRun(slug, r)),
    });
    return out;
  }

  /** Every scheme with CI that `canSee` allows, with its last view and its open problems (the land gate's in the live checkout's scheme), for GET /api/ci. */
  snapshot(canSee: (projectId: number) => boolean) {
    const land = this.store.getSetting<LandWatch>(LAND_WATCH);
    // A scheme whose repo has no workflows has no view, so isn't listed.
    return this.store.listProjects().flatMap((p) => {
      const view = repoSlug(p.repo_url) && canSee(p.id) ? this.store.getSetting<CiView>(`ci-health:view:${p.id}`) : undefined;
      if (!view) return [];
      const problems = [...(this.store.getSetting<Saved>(`ci-health:${p.id}`)?.problems ?? []), ...(land?.project === p.id ? land.problems : [])];
      return [{ id: p.id, name: p.name, view, problems }];
    });
  }

  /**
   * A workflow's runs on `branch`, newest first, through this poller's cache, so the release monitor's reads (#627,
   * src/release-readers.ts) cost a 304 when nothing moved. Null while rate limited or when GitHub won't answer.
   */
  async workflowRuns(p: Project, workflow: string, branch: string, now = Date.now()): Promise<Run[] | null> {
    const slug = repoSlug(p.repo_url);
    if (!slug || now < this.pausedUntil) return null;
    return this.guarded(now, async () => (await this.read(`repos/${slug}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=20`, this.deps.as(p), true))?.workflow_runs ?? null);
  }

  /** A run's jobs (a finished run's are kept), or null as workflowRuns. */
  async runJobs(p: Project, run: Run, now = Date.now()): Promise<Job[] | null> {
    const slug = repoSlug(p.repo_url);
    if (!slug || now < this.pausedUntil) return null;
    return this.guarded(now, () => this.jobs(slug, run, this.deps.as(p)));
  }

  /** The files a run uploaded (the release monitor's download links), or null as workflowRuns. */
  async runArtifacts(p: Project, run: Run, now = Date.now()): Promise<{ id: number; name: string; expired: boolean; expires_at?: string | null }[] | null> {
    const slug = repoSlug(p.repo_url);
    if (!slug || now < this.pausedUntil) return null;
    return this.guarded(now, async () => (await this.read(`repos/${slug}/actions/runs/${run.id}/artifacts?per_page=100`, this.deps.as(p), true))?.artifacts ?? null);
  }

  private async guarded<T>(now: number, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof RateLimited) this.pausedUntil = now + RATE_LIMITED_MS;
      return null;
    }
  }

  private swept = new Set<number>();
  /** Red runs' texts not yet told (#678). */
  private texts = new Map<number, string>();

  /**
   * Cancel the orphans among `runs` (see orphanRuns), logging each. Only for the scheme whose land line we keep (the
   * live checkout's): without the line we can't tell an orphan from a landing's run. Each run is tried once per start:
   * GitHub answers some stuck runs "cannot cancel" (no job, "not queued yet"), and asking again every poll won't change it.
   */
  private async sweepOrphans(p: Project, slug: string, runs: Run[], as: GithubEnv, now: number) {
    const watch = this.store.getSetting<LandWatch>(LAND_WATCH);
    if (!watch || watch.project !== p.id) return;
    for (const r of orphanRuns(runs, watch.state.lands, now)) {
      if (this.swept.has(r.id)) continue;
      // A landing may have joined since the list was made (each cancel awaits GitHub): ask again, with the line as it is now.
      const fresh = this.store.getSetting<LandWatch>(LAND_WATCH);
      if (!fresh || !orphanRuns([r], fresh.state.lands, now).length) continue;
      this.swept.add(r.id);
      try {
        const a = await (this.deps.post ?? ghPost)(`repos/${slug}/actions/runs/${r.id}/cancel`, as);
        console.log(`CI sweep: cancelled orphan run ${r.id} (${r.head_branch}, queued since ${r.created_at}) on ${slug}: HTTP ${a.status}${a.status >= 300 ? ' (not cancelled)' : ''}`);
      } catch (err: any) {
        console.error(`CI sweep: could not cancel run ${r.id} (${r.head_branch}) on ${slug}: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * Dispatched runs (#678), each told once, oldest first: one on an open minion's branch wakes it with its result. And
   * reds on `branch` (#774, every workflow since #968 but ci_quiet's, unless ci_watch lists it): a workflow whose newest
   * verdict there (`onMain`: each workflow's runs on `branch`, any trigger) is red wakes the Taskmaster once for that red
   * streak, to start a fix minion; the first green run after it says it's back to green. Returns each red's problem: a
   * quiet item, or an alarm once the fix is late or didn't hold (redProblem).
   */
  private async outsideRuns(p: Project, slug: string, branch: string, onMain: Map<number, Run[]>, as: GithubEnv, now: number): Promise<Problem[]> {
    if (!this.deps.tell && !this.deps.wake) return [];
    const dispatched = (await this.read(`repos/${slug}/actions/runs?event=workflow_dispatch&per_page=50`, as))?.workflow_runs;
    const listed: Run[] = Array.isArray(dispatched) ? dispatched : [];
    const key = `ci-health:scheduled:${p.id}`;
    const told = new Set(this.store.getSetting<number[]>(key) ?? []);
    const redKey = `ci-health:red:${p.id}`;
    // Workflow → the red run its Taskmaster was told of, until a newer green one.
    const red = this.store.getSetting<Record<string, RedMark>>(redKey) ?? {};
    // Dispatched runs count from the first poll that read them, so a deploy doesn't tell a day of old ones.
    const since = this.store.getSetting<number>(DISPATCH_SINCE) ?? (this.store.setSetting(DISPATCH_SINCE, now), now);
    const quiet = new Set(lines(p.ci_quiet));
    const watch = new Set(lines(p.ci_watch ?? ''));
    const watched = (r: Run) => watch.has(workflowFile(r)) || !quiet.has(workflowFile(r));
    const save = () => {
      // Ids GitHub no longer lists are dropped, but only when the list was read, so a bad answer can't forget them.
      this.store.setSetting(key, Array.isArray(dispatched) ? [...told].filter((id) => listed.some((r) => r.id === id)) : [...told]);
      this.store.setSetting(redKey, red);
    };
    // Aged by when it ended, so a run that sat queued for most of a day still counts.
    const ended = (r: Run) => at(r.updated_at ?? r.created_at);
    const done = listed.filter((r) => r.status === 'completed' && r.conclusion && now - ended(r) <= WINDOW_MS).sort((a, b) => at(a.created_at) - at(b.created_at));
    const open = this.deps.wake ? this.store.listTickets(p.id).filter((t) => t.status !== 'closed') : [];
    const pruned = Array.isArray(dispatched) && [...told].some((id) => !listed.some((r) => r.id === id));
    for (const r of done) {
      if (told.has(r.id) || ended(r) < since || r.head_branch === branch) continue;
      // Branch names repeat across schemes (ticket/12-… in each), so only this scheme's open minions.
      const minion = open.find((t) => t.branch === r.head_branch);
      if (!minion || !this.deps.wake) continue;
      const text = await this.runText(p, slug, r, as, 'minion');
      told.add(r.id);
      save(); // before sending, so a restart can't send it twice
      try {
        this.deps.wake(minion.id, text, r.conclusion === 'success');
      } catch (err) {
        console.error(`Waking #${minion.number} for run ${r.id} failed:`, err);
      }
    }
    if (!this.deps.tell) {
      if (pruned) save();
      return [];
    }
    const newest = (w: string) => (onMain.get(Number(w)) ?? []).filter((x) => x.status === 'completed' && VERDICTS.has(x.conclusion ?? '')).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
    // A red with no red mark yet starts a streak; a newest verdict over a week old is a retired or manual workflow's.
    for (const w of onMain.keys()) {
      const r = newest(String(w));
      if (!r || r.conclusion !== 'failure' || !watched(r) || red[String(w)] || now - at(r.created_at) > ACTIVE_MS) continue;
      const text = this.texts.get(r.id) ?? (await this.runText(p, slug, r, as, 'watch'));
      this.texts.set(r.id, text);
      if (this.texts.size > 200) this.texts.delete(this.texts.keys().next().value!);
      red[String(w)] = { run: r.id, at: r.created_at, told: now, where: await this.failedAt(slug, r, as) };
      save(); // before sending, so a restart can't send it twice
      if (!this.say(p, r.id, text, true)) {
        delete red[String(w)]; // no Taskmaster yet: the next poll tries again
        save();
        continue;
      }
      this.texts.delete(r.id);
    }
    // Back to green: the first green run on the branch after the red one (or the red one re-run green), a push's or a PR merge's too.
    for (const [w, was] of Object.entries(red)) {
      const green = [...(onMain.get(Number(w)) ?? []), ...listed.filter((r) => String(r.workflow_id) === w && r.head_branch === branch)]
        .filter((r) => r.status === 'completed' && r.conclusion === 'success' && (at(r.created_at) > at(was.at) || r.id === was.run)).sort((a, b) => at(a.created_at) - at(b.created_at))[0];
      if (!green) continue;
      if (watched(green) && !this.say(p, green.id, `${p.name}'s ${green.name} is back to green on ${branch}: ${runUrl(slug, green)} (${short(green.head_sha)}, ${pacific(ended(green))}), after run ${was.run} failed.`)) continue;
      delete red[w];
      save();
    }
    if (pruned) save();
    const out: Problem[] = [];
    for (const [w, mark] of Object.entries(red)) {
      const r = newest(w);
      if (!r) continue;
      if (mark.told == null) {
        mark.told = now; // a mark from before #968: its hour starts now
        save();
      }
      const x = redProblem(workflowFile(r), branch, mark, r, this.fixMinion(p, mark), now);
      if (x) out.push(x);
    }
    return out;
  }

  /** The minion fixing a red: the first of the scheme's made since its Taskmaster heard whose title or brief names the run. */
  private fixMinion(p: Project, mark: RedMark): Fix | null {
    const id = String(mark.run);
    const t = this.store.listTickets(p.id).filter((x) => x.number != null && x.created_at >= (mark.told ?? 0) - 60_000).sort((a, b) => a.created_at - b.created_at)
      .find((x) => x.title.includes(id) || (this.store.eventsOfKinds(x.id, ['user_message'])[0]?.data ?? '').includes(id));
    return t ? { number: t.number!, closedAt: t.status === 'closed' ? t.updated_at : null } : null;
  }

  /** Where a failed run failed, "job › step", or undefined. */
  private async failedAt(slug: string, r: Run, as: GithubEnv): Promise<string | undefined> {
    try {
      const j = (await this.jobs(slug, r, as)).find((x) => x.conclusion === 'failure');
      return j && place(j);
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      return undefined;
    }
  }

  /** Held mail for the Taskmaster about `run`: true once it has it; false (no Taskmaster yet, or the send threw) to try again next poll. */
  private say(p: Project, run: number, text: string, wake = false): boolean {
    try {
      return this.deps.tell!(p, text, wake);
    } catch (err) {
      console.error(`Telling ${p.name}'s Taskmaster of run ${run} failed:`, err);
      return false;
    }
  }

  /**
   * What a finished run says to the minion that dispatched it, or (`watch`) to the Taskmaster about a workflow gone red
   * on main: where it failed, GitHub's error lines, its CI-store files.
   */
  private async runText(p: Project, slug: string, r: Run, as: GithubEnv, to: 'minion' | 'watch'): Promise<string> {
    let where = '';
    let errors: string[] = [];
    let failed: string[] = [];
    if (r.conclusion === 'failure') {
      try {
        const jobs = (await this.jobs(slug, r, as)).filter((j) => j.conclusion === 'failure');
        failed = jobs.map(place);
        if (jobs[0]) {
          where = `, at ${failed[0]}`;
          errors = await this.errorLines(slug, jobs[0], as);
        }
      } catch (err) {
        if (err instanceof RateLimited) throw err; // these are niceties: any other failure to read them still tells
      }
    }
    const files = this.store.ciFiles(p.id).filter((f) => f.run_id === r.id);
    const extra = [
      // GitHub's API has no way to read a job's step summary, so its error annotations (::error:: lines) stand in.
      errors.length ? `GitHub's error lines:\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
      files.length ? `Its files in ${APP_NAME}'s CI store (ci_files with run: ${r.id}): ${files.slice(0, 5).map((f) => `${f.name} (${f.kind})`).join(', ')}${files.length > 5 ? `, ${files.length - 5} more` : ''}.` : '',
    ].filter(Boolean).join('\n');
    const finished = `finished ${pacific(at(r.updated_at ?? r.created_at))}`;
    const failures = `\`ci-failures ${r.id} -R ${slug}\` prints its failing tests.`;
    if (to === 'minion') {
      const how = r.conclusion === 'success' ? 'passed' : r.conclusion === 'failure' ? `failed${where}` : `ended ${r.conclusion}`;
      return `Your dispatched ${r.name} run on ${r.head_branch} ${how} (${short(r.head_sha)}, ${finished}): ${runUrl(slug, r)}${extra ? `\n${extra}` : ''}${r.conclusion === 'failure' ? `\n${failures}` : ''}`;
    }
    const by = r.triggering_actor?.login ? ` by ${r.triggering_actor.login}` : '';
    const file = workflowFile(r);
    const jobs = failed.length ? `\nFailing jobs: ${failed.slice(0, 8).join('; ')}${failed.length > 8 ? `; ${failed.length - 8} more` : ''}` : '';
    return `${p.name}'s ${r.head_branch} went red: ${file} (${r.name}) run ${r.id} failed on ${short(r.head_sha)} (${r.event ?? 'a run'}${by}, ${finished}): ${runUrl(slug, r)}${jobs}${extra ? `\n${extra}` : ''}\n${failures} Later red runs of ${file} won't message you again; you'll hear when it's back to green. Start a fix minion now and put run ${r.id} in its brief: people get a quiet item naming it, and their phone rings if no minion names the run within an hour or ${r.head_branch} is still red after it closes. If it's CI itself (a runner, GitHub) rather than the code, ask people. To stop these for ${file}, add it to the scheme's quiet CI workflows (set_project_settings quiet_workflows).`;
  }

  /** A failed job's error annotations, the generic "Process completed with exit code" left out: at most 5, each cut short. */
  private async errorLines(slug: string, j: Job, as: GithubEnv): Promise<string[]> {
    const path = `repos/${slug}/check-runs/${j.id}/annotations`;
    const notes = await this.read(path, as, true);
    this.cache.delete(path);
    if (!Array.isArray(notes)) return [];
    return notes.filter((n) => n?.annotation_level === 'failure' && typeof n.message === 'string' && !/^Process completed with exit code \d+\.?$/.test(n.message.trim()))
      .slice(0, 5).map((n) => { const m = n.message.replace(/\s+/g, ' ').trim(); return m.length > 200 ? `${m.slice(0, 199)}…` : m; });
  }

  /**
   * Message (once) and drop the scheme's minions parked on its runners, once one of them is online; dismissed ones are dropped.
   * `runners` null: the list can't be read, so nothing would ever say they're back, and the minions hear that instead.
   */
  wakeParked(p: Project, runners: Runner[] | null) {
    const all = runnerWaiters(this.store);
    const mine = (w: RunnerWaiter) => this.store.getTicket(w.ticket)?.project_id === p.id;
    const gone = (w: RunnerWaiter) => { const t = this.store.getTicket(w.ticket); return !t || t.status === 'closed'; };
    const up = runners && onlineRunners(runners, p.name);
    const woken = (!up || up.length) && this.deps.wake ? all.filter((w) => mine(w) && !gone(w)) : [];
    if (!woken.length && !all.some(gone)) return;
    // Dropped before sending, so a send that throws can't wake anyone twice.
    this.store.setSetting(RUNNER_WAITERS, all.filter((w) => !gone(w) && !woken.includes(w)));
    const names = up?.map((r) => r.name).join(', ');
    for (const w of woken) {
      const reason = w.reason.replace(/[.\s]+$/, '');
      try {
        if (!up) this.deps.wake!(w.ticket, `${APP_NAME} can't read ${p.name}'s CI runners with the scheme's GitHub login, so it can't tell when they are back: ask a person whether they are, then ${reason}.`);
        else this.deps.wake!(w.ticket, `${p.name}'s CI runners are back (${names} online): ${reason}. If land parks again on no runner while they're online, the workflow's runs-on may not match them: ask a person instead of parking again.`);
      } catch (err) {
        console.error(`Waking #${w.ticket} for its runners failed:`, err); // the others still get theirs
      }
    }
  }

  /**
   * A scheme's own items, quiet ones only: every admin with Mandate on gets each, updated when its words change, and
   * cleared once it's gone; an alarm item an older build put here is cleared, as the one alert stands for it now.
   */
  async deliver(p: Project, problems: Problem[], saved: Pick<Saved, 'sent'>) {
    const admins = this.admins();
    const open = new Map(problems.map((x) => [x.key, x]));
    for (const [key, x] of open) {
      const title = itemText(x), quiet = x.quiet;
      const sent = (saved.sent[key] ??= {});
      for (const u of admins) {
        if (sent[u.id] === title) continue;
        if (await this.deps.mandate(p, u, itemKey(key), title, quiet, ciPage(p.id))) sent[u.id] = title;
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

  /**
   * The scheme's workflows, its first read. A 404 here is the whole repo hidden from the login it reads as (a private
   * repo whose invite that login hasn't accepted: FuckSpamTexts after its move, #607), so it says that, not a bare path.
   */
  private async listWorkflows(p: Project, slug: string, as: GithubEnv): Promise<any> {
    try {
      return await this.read(`repos/${slug}/actions/workflows?per_page=100`, as);
    } catch (err) {
      if (!(err instanceof GhError) || err.status !== 404) throw err;
      const owner = as && p.owner_id != null ? this.store.getUser(p.owner_id) : null;
      const who = !as ? "the box's GitHub login" : `${owner?.name ?? "the scheme owner"}'s linked GitHub`;
      throw new Error(`${who} can't see ${slug} (GitHub answers 404): it has no access to the repo or its invite is still waiting to be accepted, or the repo isn't at that address (deleted, or repo_url is wrong).`);
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
    throw new GhError(r.status, path);
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
