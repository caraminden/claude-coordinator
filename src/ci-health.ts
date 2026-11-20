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
// would; a failed one on the default branch, like a failed scheduled run, wakes the Taskmaster as any red on main does (#968, #983), and the
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
// #983 (Cara, 2026-11-18: "CI alerts need to wake their respective taskmasters to fix the issue"): every problem that rings
// also wakes its scheme's Taskmaster once as it opens (wakeFor; the land gate wakes the live checkout's scheme), so a ring
// is never the first anyone hears of it. The person ring stays the backup, and the #869 wake no longer sends CI's bundle to Citadel's.
// #1017: in a scheme in fast mode, a land's push going red on main is fast mode's to handle (src/fast-mode.ts), not an alert.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { quietUntil, type AlertPart } from './alert-wakes.ts';
import { lines } from './approvals.ts';
import { APP_NAME } from './appname.ts';
import { schemeLabels } from './ci-runner.ts';
import type { Project, Store, Ticket, User } from './db.ts';
import type { GreenRun } from './last-green.ts';
import { repoSlug } from './prlinks.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { pacific } from './pacific.ts';

import { VERDICTS, WAIT_MS, HUNG_MS, RED_FIX_MS, type Problem, type WakeAt, WAKE_AT, problemLink, WAKE_STEPS, itemText, at, short, runUrl, workflowFile, quietWorkflow, HEAVY_WORKFLOW, DISPATCH_SINCE, trackOffline, servers, stuckProblems, hungProblems, deadGroups, deadProblem, orphanRuns, place, type RedMark, type Fix, redProblem, verdictPair, skippedJobs, bundleTitle, ciPage, CI_SENDER, BUNDLE_ITEM, itemKey } from './ci-problems.ts';
export { WAIT_MS, HUNG_MS, RED_FIX_MS, ORPHAN_MS, type Problem, type ProblemLink, type WakeAt, problemLink, itemText, clock, trackOffline, servers, stuckProblems, hungProblems, neverStarted, deadGroups, deadProblem, orphanRuns, type RedMark, type Fix, redProblem, verdictPair, skippedJobs, computerOf, sharedHost, bundleTitle, ciPage, CI_SENDER, itemKey } from './ci-problems.ts';
import { LAND_RING_STREAK, LAND_RING_MS, type LandSeen, type LandState, newLandState, landStep, landProblems } from './ci-land-gate.ts';
export { LAND_STREAK, LAND_SLOW_MS, LAND_RING_STREAK, LAND_RING_MS, type LandSeen, type LandState, newLandState, landStep, landProblems } from './ci-land-gate.ts';
import { type GhGet, ghGet, ghPost, RateLimited, GhError } from './gh-api.ts';
export { type GhAnswer, type GhGet, ghGet, ghPost } from './gh-api.ts';
const run = promisify(execFile);

const POLL_MS = 5 * 60_000;
const RATE_LIMITED_MS = 15 * 60_000;
/** The soonest a fresh start reads GitHub, so a restart (or a test's short-lived server) doesn't ask at once. */
export const START_DELAY_MS = 45_000;
const LAST_TICK = 'ci-health:lastTick';
const PAUSED_UNTIL = 'ci-health:pausedUntil';
/** #1005: when a start's first read comes. The last read and the rate-limit pause survive restarts, so lands that restart the server every few minutes can't push reads later than one poll past the previous. */
export function firstTickDelay(lastTick: number | undefined, pausedUntil: number | undefined, now: number): number {
  return Math.max(START_DELAY_MS, (lastTick ?? 0) + POLL_MS - now, (pausedUntil ?? 0) - now);
}
// Runs looked at for jobs that didn't start or wait for a runner; older ones are history.
const RUNS = 50;
const WINDOW_MS = 24 * 3600_000;
// A workflow with no run on main this long is a manual or retired one, never "missing a verdict".
const ACTIVE_MS = 7 * 24 * 3600_000;

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
const viewRun = (slug: string, r: Run, minion: (r: Run) => number | null = () => null): ViewRun => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.created_at, url: r.html_url ?? runUrl(slug, r), minion: minion(r) });

/**
 * The minion a run tests (#1019, Cara 2026-11-18: "These lines in CI should link to the minions whose tests they are for"): the one whose
 * branch it ran on (a land's CI copy runs on land/<branch>), else the one whose branch tip is its commit (a land's push to the default branch).
 * shortcut: a branch that moved on after its land no longer tops the commit, so that push reads as the default branch's own; upgrade if lands start recording their commit.
 */
export function runMinion(branch: string, sha: string, tickets: Pick<Ticket, 'number' | 'branch' | 'kind'>[], tips: Map<string, string[]>): number | null {
  const of = (b: string) => tickets.find((t) => t.kind === 'ticket' && t.branch === b)?.number ?? null;
  return of(branch.replace(/^land\//, '')) ?? (tips.get(sha) ?? []).map(of).find((n) => n != null) ?? null;
}

/** The view's running jobs and its queue per set of labels, so a long queue reads "1 runner, 9 queued". */
export function runningNow(all: Job[], runs: Run[], runners: Runner[] | null, minion: (r: Run) => number | null): Pick<CiView, 'running' | 'queues'> {
  const ofRun = (j: Job) => {
    const r = runs.find((x) => x.id === j.run_id);
    return r ? { branch: r.head_branch, event: r.event, minion: minion(r) } : {};
  };
  const running = all.filter((j) => j.status === 'in_progress' && j.runner_name)
    .map((j) => ({ name: j.name, runner: j.runner_name!, since: j.started_at ?? j.created_at, run: j.run_id, ...ofRun(j) }));
  const groups = new Map<string, Job[]>();
  for (const j of all.filter((x) => x.status === 'queued' || x.status === 'waiting')) {
    const key = [...j.labels].sort().join(',');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(j);
  }
  const queues = [...groups.values()].map((js) => ({
    labels: [...js[0].labels].sort(), jobs: js.length,
    runners: runners && servers(runners, js[0]).filter((r) => r.status === 'online').length,
  })).sort((a, b) => b.jobs - a.jobs);
  return { running, queues };
}

/** What a run with no minion is, for the CI page: a schedule, a run by hand, the default branch itself, or its branch. */
export function runKind(r: { branch?: string; event?: string }, main: string): string {
  if (r.event === 'schedule') return 'scheduled run';
  if (r.event === 'workflow_dispatch') return `run by hand on ${r.branch ?? main}`;
  return r.branch === main ? `${main} itself` : r.branch ?? '';
}

/** A repo's branch tips, commit → branch names; empty with no repo on this box or when git fails. */
async function branchTips(dir: string | null | undefined): Promise<Map<string, string[]>> {
  const tips = new Map<string, string[]>();
  if (!dir) return tips;
  try {
    const { stdout } = await run('git', ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/'], { cwd: dir });
    for (const [sha, ref] of stdout.split('\n').filter(Boolean).map((l) => l.split(' '))) (tips.get(sha) ?? tips.set(sha, []).get(sha)!).push(ref);
  } catch { /* no tips: runs on minion branches still link */ }
  return tips;
}
/** Something wrong now: what the alert says, keyed so the same trouble keeps one item. */


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
  /** A REST POST (the sweep's cancel, a red's re-run with `fields`); the gh CLI by default. */
  post?: (path: string, as: GithubEnv, fields?: Record<string, string>) => Promise<{ status: number }>;
  /** #1074: the fix minion's branch tip when its work is in `sha` (the default branch's tip on GitHub), else null; none, and no re-run starts. */
  shipped?: (project: Project, ticket: Ticket, sha: string) => Promise<string | null>;
  /** Show a held fix minion as waiting on its re-run (`note`), or (null) clear that as it is woken. */
  held?: (ticketId: number, note: string | null) => void;
  /** Dismiss a fix minion whose re-run went green, the way a live deploy does. */
  dismiss?: (ticketId: number, text: string) => void;
  /** Message a minion (wake_when_runners_back, a run it dispatched); `fyi` for news that needs nothing: a dispatched run that passed, which also runs at low effort (#951). No message, no wakes. */
  wake?: (ticketId: number, text: string, fyi?: boolean) => void;
  /** Held mail for a scheme's Taskmaster (a failed scheduled run), or a message that wakes it (`wake`: a watched workflow gone red); false (no Taskmaster) or none at all, and those wait untold. */
  tell?: (project: Project, text: string, wake?: boolean) => boolean | number;
  /** The scheme whose Taskmaster hears problems that aren't one scheme's (#983): the live checkout's. */
  home?: () => Project | undefined;
  /** Each poll's runs of a scheme (all branches, newest first) with its default branch, for its last green (src/last-green.ts, #1016). */
  green?: (project: Project, runs: GreenRun[], branch: string) => void;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
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

  /** The first look comes at firstTickDelay (not at once), then every poll. */
  start() {
    if (this.timer) return;
    this.pausedUntil = Math.max(this.pausedUntil, this.store.getSetting<number>(PAUSED_UNTIL) ?? 0);
    const arm = (ms: number) => {
      this.timer = setTimeout(async () => {
        await this.tick().catch(() => {});
        if (this.timer) arm(POLL_MS);
      }, ms);
      this.timer.unref?.();
    };
    arm(firstTickDelay(this.store.getSetting<number>(LAST_TICK), this.pausedUntil, Date.now()));
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
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
      this.wakeShared(now);
      await this.alert();
    } finally {
      this.busy = false;
      this.store.setSetting(LAST_TICK, now);
      this.store.setSetting(PAUSED_UNTIL, this.pausedUntil);
    }
  }

  /** One scheme: what's wrong now, kept for the one alert, and its quiet items brought in line. A round that throws keeps the last. */
  async check(p: Project, slug: string, now: number) {
    const saved: Saved = { offline: {}, sent: {}, ...this.store.getSetting<Saved>(`ci-health:${p.id}`) };
    saved.problems = await this.problems(p, slug, saved, now);
    await this.wakeFor(p, saved.problems, `ci-health:woke:${p.id}`, now);
    await this.deliver(p, saved.problems.filter((x) => x.quiet), saved);
    this.store.setSetting(`ci-health:${p.id}`, saved);
  }

  /**
   * #983 (Cara, 2026-11-18: "CI alerts need to wake their respective taskmasters to fix the issue"): each problem that
   * rings a person wakes the scheme's Taskmaster once, as it opens (a wake, so a cold one runs too), and again only
   * after it clears and comes back. A problem is recorded as woken once the send went through, so no Taskmaster waits untold.
   * Not overnight (#869's pick, 2-9 AM Pacific): the first poll after 9 sends it. Shared problems wait for wakeShared.
   */
  private async wakeFor(p: Project, problems: Problem[], key: string, now: number) {
    if (!this.deps.tell) return;
    const ringing = problems.filter((x) => !x.quiet && !x.shared);
    const woke = (this.store.getSetting<string[]>(key) ?? []).filter((k) => ringing.some((x) => x.key === k));
    if (quietUntil(now) === null) {
      for (const x of ringing.filter((x) => !woke.includes(x.key))) if (this.say(p, x.key, await this.wakeText(p, x), true, (e) => this.wokeAt(`${p.id}:${x.key}`, p.id, e))) woke.push(x.key);
    }
    this.store.setSetting(key, woke);
  }

  /**
   * Problems tagged shared (a computer's runners, billing), after every scheme's check: one touching several schemes (billing
   * always) wakes Citadel's Taskmaster once, naming them; a computer only one scheme uses wakes that scheme's.
   */
  private wakeShared(now: number) {
    const home = this.deps.home?.();
    if (!this.deps.tell) return;
    const open = new Map<string, { to: Project | undefined; schemes: string[]; problem: Problem }>();
    const by = new Map<string, { p: Project; problem: Problem }[]>();
    for (const p of this.store.listProjects()) {
      for (const x of this.store.getSetting<Saved>(`ci-health:${p.id}`)?.problems ?? []) {
        if (!x.quiet && x.shared) by.set(x.shared, [...(by.get(x.shared) ?? []), { p, problem: x }]);
      }
    }
    for (const [k, list] of by) {
      if (k.startsWith('host:') && list.length === 1) open.set(`${k}#${list[0].p.id}`, { to: list[0].p, schemes: [list[0].p.name], problem: list[0].problem });
      else open.set(k, { to: home, schemes: list.map((e) => e.p.name), problem: list[0].problem });
    }
    const key = 'ci-health:woke:shared';
    const woke = (this.store.getSetting<string[]>(key) ?? []).filter((k) => open.has(k));
    if (quietUntil(now) === null) {
      for (const [k, { to, schemes, problem }] of open) {
        if (woke.includes(k) || !to) continue;
        const touches = schemes.length > 1 || !k.includes('#') ? `\nIt touches ${schemes.join(', ')}.` : '';
        if (this.say(to, k, `${to.name}: ${itemText(problem)}${touches}\n${WAKE_STEPS}`, true, (e) => this.wokeAt(k, to.id, e))) woke.push(k);
      }
    }
    this.store.setSetting(key, woke);
  }

  /** Keep the chat entry a wake became, for the CI page's link (#992). */
  private wokeAt(key: string, project: number, entry: number) {
    const all = this.store.getSetting<WakeAt>(WAKE_AT) ?? {};
    all[key] = { project, entry };
    this.store.setSetting(WAKE_AT, all);
  }

  /** A ringing problem as its Taskmaster's wake: what, why and the fix, then what to do about it; the land gate adds its fallen-back runs' facts. */
  private async wakeText(p: Project, x: Problem): Promise<string> {
    const run = x.key.startsWith('red:') ? x.title.match(/run (\d+)/)?.[1] : undefined;
    const facts = x.key === 'land:fallback' ? (await this.parts([{ scheme: p.name, problem: x, id: p.id }], this.store.getSetting<LandWatch>(LAND_WATCH)))[0]?.facts : undefined;
    return `${p.name}: ${itemText(x)}${facts ? `\nRuns: ${facts}` : ''}\n${WAKE_STEPS.replace('name this problem in its brief', run ? `put run ${run} in its brief` : 'name this problem in its brief')} The CI page: ${ciPage(p.id)}`;
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
    if (p) {
      await this.deliver(p, w.problems.filter((x) => x.quiet), w as Required<LandWatch>);
    }
    if (changed || before !== JSON.stringify([w.state, w.sent])) this.store.setSetting(LAND_WATCH, w);
    // After the save: the wake's text reads the fallen-back runs from it.
    if (p) await this.wakeFor(p, w.problems, 'ci-health:woke:land', now);
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
    const parts: AlertPart[] = []; // the Taskmaster is woken by wakeFor (#983), not by the alert
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
    this.deps.green?.(p, runs.filter((r) => !quietWorkflow(p, r)).map((r) => ({ head_sha: r.head_sha, workflow_id: r.workflow_id, status: r.status, conclusion: r.conclusion, created_at: r.created_at, file: workflowFile(r) })), branch);
    const onMain = new Map<number, Run[]>();
    for (const w of workflows) {
      const mainRuns: Run[] = (await this.read(`repos/${slug}/actions/workflows/${w.id}/runs?branch=${encodeURIComponent(branch)}&per_page=${RUNS}`, as))?.workflow_runs ?? [];
      onMain.set(w.id, mainRuns);
    }
    out.push(...(await this.outsideRuns(p, slug, branch, onMain, as, now)));
    const [tickets, tips] = [this.store.listTickets(p.id), await branchTips(p.repo_dir)];
    const minion = (r: Run) => runMinion(r.head_branch, r.head_sha, tickets, tips);
    const shown: CiView['workflows'] = [];
    for (const w of workflows) {
      if (String(w.path ?? '').endsWith(`/${HEAVY_WORKFLOW}`)) continue; // minions' own commands: no verdict on main to show
      const mainRuns = onMain.get(w.id) ?? [];
      const verdict = mainRuns.find((r) => r.status === 'completed' && VERDICTS.has(r.conclusion ?? ''));
      const pair = verdictPair(mainRuns);
      const skipped = pair ? skippedJobs(await this.jobs(slug, pair[0], as), await this.jobs(slug, pair[1], as)) : [];
      shown.push({ name: w.name, file: String(w.path ?? '').split('/').pop() ?? '', verdict: verdict ? viewRun(slug, verdict, minion) : null, skipped });
    }
    this.store.setSetting<CiView>(`ci-health:view:${p.id}`, {
      at: now, slug, branch,
      runners: runners && runners.map((r) => ({
        name: r.name, status: r.status, busy: !!r.busy, labels: (r.labels ?? []).map((l) => l.name),
        job: all.find((j) => j.status === 'in_progress' && j.runner_name === r.name)?.name ?? null, offlineSince: saved.offline[r.name] ?? null,
      })),
      waiting: all.filter((j) => j.status === 'queued' || j.status === 'waiting').map((j) => {
        const r = runs.find((x) => x.id === j.run_id);
        return { name: j.name, labels: j.labels, since: j.created_at, run: j.run_id, ...(r && { branch: r.head_branch, event: r.event, minion: minion(r) }) };
      }),
      ...runningNow(all, runs, runners, minion),
      workflows: shown,
      runs: runs.slice(0, 30).map((r) => viewRun(slug, r, minion)),
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
      const wakes = this.store.getSetting<WakeAt>(WAKE_AT) ?? {};
      const problems = [...(this.store.getSetting<Saved>(`ci-health:${p.id}`)?.problems ?? []), ...(land?.project === p.id ? land.problems : [])]
        .map((x) => ({ ...x, link: problemLink(x, p.id, wakes, (n) => this.store.getTicketByNumber(p.id, n)?.title) }));
      // Each run's and queued job's minion (#1019), its title read now so a renamed minion reads right: a link, else what the run is.
      const who = (r: { minion?: number | null; branch?: string; event?: string }) => r.minion
        ? { href: `#/p/${p.id}/t/${r.minion}`, label: `#${r.minion} ${this.store.getTicketByNumber(p.id, r.minion)?.title ?? ''}`.trim() }
        : { label: runKind(r, view.branch) };
      const quiet = new Set(lines(p.ci_quiet)), watch = new Set(lines(p.ci_watch ?? ''));
      const shown = {
        ...view,
        waiting: view.waiting.map((j) => ({ ...j, who: who(j) })),
        running: (view.running ?? []).map((j) => ({ ...j, who: who(j) })),
        workflows: view.workflows.map((w) => ({ ...w, quiet: quiet.has(w.file) && !watch.has(w.file), verdict: w.verdict && { ...w.verdict, who: who(w.verdict) } })),
        runs: view.runs.map((r) => ({ ...r, who: who(r) })),
      };
      return [{ id: p.id, name: p.name, view: shown, problems }];
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
    // Fast mode (#1017; Cara, 2026-11-18: "We should also not send Mandate alerts for CI failures in fast mode, they are
    // expected to some extent"): a land's push red on main is src/fast-mode.ts's to pin and hand out, so it neither wakes
    // the Taskmaster nor makes an item. Scheduled and dispatched reds still do, and so does a workflow the scheme watches.
    const landed = (r: Run) => p.land_mode === 'fast' && r.event === 'push';
    // A heavy job's red is the minion's own (its command failed), not main's, even if ci_watch lists it.
    const watched = (r: Run) => workflowFile(r) !== HEAVY_WORKFLOW && (watch.has(workflowFile(r)) || (!landed(r) && !quiet.has(workflowFile(r))));
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
      if (!this.say(p, r.id, text, true, (e) => this.wokeAt(`${p.id}:red:${w}`, p.id, e))) {
        delete red[String(w)]; // no Taskmaster yet: the next poll tries again
        save();
        continue;
      }
      this.texts.delete(r.id);
    }
    // A workflow quieted since it went red: its mark goes, with no message (the scheme said the red is expected).
    for (const w of Object.keys(red)) {
      const r = newest(w);
      if (r && !watched(r)) delete red[w];
    }
    save();
    // Back to green: the first green run on the branch after the red one (or the red one re-run green), a push's or a PR merge's too.
    for (const [w, was] of Object.entries(red)) {
      const green = [...(onMain.get(Number(w)) ?? []), ...listed.filter((r) => String(r.workflow_id) === w && r.head_branch === branch)]
        .filter((r) => r.status === 'completed' && r.conclusion === 'success' && (at(r.created_at) > at(was.at) || r.id === was.run)).sort((a, b) => at(a.created_at) - at(b.created_at))[0];
      if (!green) continue;
      if (watched(green) && !this.say(p, green.id, `${p.name}'s ${green.name} is back to green on ${branch}: ${runUrl(slug, green)} (${short(green.head_sha)}, ${pacific(ended(green))}), after run ${was.run} failed.`)) continue;
      delete red[w];
      save();
      // #1074: its fix minion was held open on this; deleted first, so the hold is gone as it closes.
      const fix = was.rerun?.ticket ?? this.heldFix(p, was);
      if (fix != null) this.dismissFix(fix, `${workflowFile(green)} is green on ${branch} again (${runUrl(slug, green)}, on ${short(green.head_sha)}), so it dismissed this fix minion.`);
    }
    for (const [w, mark] of Object.entries(red)) await this.rerun(p, slug, branch, Number(w), mark, onMain.get(Number(w)) ?? [], as, now, save);
    if (pruned) save();
    const out: Problem[] = [];
    for (const [w, mark] of Object.entries(red)) {
      const r = newest(w);
      if (!r) continue;
      if (mark.told == null) {
        mark.told = now; // a mark from before #968: its hour starts now
        save();
      }
      const x = redProblem(workflowFile(r), branch, mark, r, this.fixMinion(p, mark), now, slug);
      if (x) out.push(x);
    }
    return out;
  }

  /** The minion fixing a red: the one its re-run is for (#1074), else of the scheme's made since its Taskmaster heard whose title or brief names the run, the first open one, else the newest. */
  private fixMinion(p: Project, mark: RedMark): Fix | null {
    const t = this.fixTicket(p, mark);
    return t ? { number: t.number!, closedAt: t.status === 'closed' ? t.updated_at : null } : null;
  }
  private fixTicket(p: Project, mark: RedMark): Ticket | null {
    const held = mark.rerun ? this.store.getTicket(mark.rerun.ticket) : null;
    if (held && held.project_id === p.id && held.number != null) return held;
    const id = String(mark.run);
    // The first open one, else the newest (Josh, 2026-11-19): a second fix after the first closed is the one at work, and a
    // later minion that only quotes the run (a review) can't take the hold from the open one.
    const named = this.store.listTickets(p.id).filter((x) => x.number != null && x.created_at >= (mark.told ?? 0) - 60_000).sort((a, b) => a.created_at - b.created_at)
      .filter((x) => x.title.includes(id) || (this.store.eventsOfKinds(x.id, ['user_message'])[0]?.data ?? '').includes(id));
    return named.find((x) => x.status !== 'closed') ?? named.at(-1) ?? null;
  }

  /**
   * #1074 (Josh, 2026-11-19, "Yes, automate it"): why a minion must stay open, or null. A red's fix minion (fixMinion)
   * isn't done until its workflow is green on the default branch again: neither its live deploy nor close_self dismisses
   * it while the red is open. Its re-run is started by the poll once its fix is on the branch (rerun); green dismisses it.
   */
  hold(ticketId: number): string | null {
    const t = this.store.getTicket(ticketId);
    const p = t && t.number != null && t.status !== 'closed' ? this.store.getProject(t.project_id) : null;
    if (!t || !p) return null;
    for (const mark of Object.values(this.store.getSetting<Record<string, RedMark>>(`ci-health:red:${p.id}`) ?? {})) {
      if (this.fixTicket(p, mark)?.id !== t.id) continue;
      return `it fixes the red CI run ${mark.run}, which isn't green again yet (Citadel re-runs it once the fix is live)`;
    }
    return null;
  }

  private soonAt = new Map<number, ReturnType<typeof setTimeout>[]>();
  /**
   * Look at a scheme again soon (#1074): a held fix minion's deploy just went live, and its re-run needn't wait for the
   * next poll. Twice, as the deploy pushes the branch to GitHub once it's live; once at a time per scheme.
   */
  soon(projectId: number) {
    if (this.soonAt.has(projectId) || !this.timer) return;
    const look = async () => {
      const p = this.store.getProject(projectId);
      const slug = p && repoSlug(p.repo_url);
      if (!p || !slug || this.busy || Date.now() < this.pausedUntil) return;
      this.busy = true;
      try {
        await this.check(p, slug, Date.now());
      } catch (err: any) {
        if (err instanceof RateLimited) this.pausedUntil = Date.now() + RATE_LIMITED_MS;
      } finally {
        this.busy = false;
      }
    };
    const timers = [30_000, 150_000].map((ms, i) => setTimeout(() => {
      if (i === 1) this.soonAt.delete(projectId);
      void look();
    }, ms));
    for (const x of timers) x.unref?.();
    this.soonAt.set(projectId, timers);
  }

  /**
   * #1074: the run that tests a red's fix. Once the fix minion's work is on GitHub's `branch` (deps.shipped), its
   * workflow is dispatched there once, unless a run on that tip is there already (queued, running or done: a push's
   * own CI), or its jobs run on GitHub's own runners (Actions minutes: a person's call). A tip with no new work of the
   * minion's (another land on top) starts nothing. A re-run gone red wakes the minion; green is the back-to-green loop's.
   */
  private async rerun(p: Project, slug: string, branch: string, w: number, mark: RedMark, runs: Run[], as: GithubEnv, now: number, save: () => void) {
    const t = this.fixTicket(p, mark);
    if (!t || t.status === 'closed') return;
    const file = workflowFile(runs.find((r) => r.id === mark.run) ?? runs[0] ?? ({ name: 'its workflow' } as Run));
    const re = mark.rerun?.ticket === t.id ? mark.rerun : undefined;
    if (re && !re.failed) {
      // Ours is the first dispatched run since: GitHub runs the branch's tip when it starts it, which can be past re.sha.
      const seen = re.dispatched
        ? runs.filter((r) => r.event === 'workflow_dispatch' && at(r.created_at) >= re.at - 60_000).sort((a, b) => at(a.created_at) - at(b.created_at))[0]
        : runs.filter((r) => r.head_sha === re.sha).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
      if (seen && (seen.id !== re.run || seen.head_sha !== re.sha)) {
        re.run = seen.id;
        re.sha = seen.head_sha;
        save();
      }
      // Cancelled or timed out counts too: the minion hears, rather than waiting on a run that never goes green.
      if (seen?.status === 'completed' && seen.conclusion !== 'success') {
        const text = await this.runText(p, slug, seen, as, 'minion');
        re.failed = true;
        save(); // before sending, so a restart can't wake it twice
        this.deps.held?.(t.id, null);
        this.deps.wake?.(t.id, `The ${file} re-run on ${branch} after your fix went live ended ${seen.conclusion ?? 'without a verdict'}, so ${branch} is still red and this minion stays open until it's green. Fix it and ship again; Citadel re-runs ${file} once that's live.
${text}`);
        return;
      }
    }
    if (!this.deps.shipped) return;
    const head: string | undefined = (await this.read(`repos/${slug}/branches/${encodeURIComponent(branch)}`, as))?.commit?.sha;
    if (!head || head === re?.sha) return;
    const tip = await this.deps.shipped(p, t, head);
    // Nothing of its own in the tip, or no new fix since the last re-run: someone else's land, not its fix.
    if (!tip || (mark.rerun?.ticket === t.id && mark.rerun.tip === tip && !mark.rerun.error)) return;
    const next: NonNullable<RedMark['rerun']> = { ticket: t.id, sha: head, tip, at: now };
    const there = runs.filter((r) => r.head_sha === head).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
    const red = runs.find((r) => r.id === mark.run) ?? ({ id: mark.run, workflow_id: w } as Run);
    const jobs = there ? [] : await this.jobs(slug, red, as);
    // CI_RUNNER=github moves a workflow onto GitHub's runners (the kit's convention), which the red's own jobs can't show.
    const toGithub = !there && String((await this.read(`repos/${slug}/actions/variables/CI_RUNNER`, as, true))?.value ?? '').toLowerCase() === 'github';
    if (there) next.run = there.id;
    else if (toGithub || !jobs.length || jobs.some((j) => !j.labels.some((l) => l.toLowerCase() === 'self-hosted'))) next.hosted = true;
    else next.dispatched = true;
    mark.rerun = next;
    save(); // before dispatching, so a restart can't dispatch twice
    if (next.dispatched) {
      try {
        const { status } = await (this.deps.post ?? ghPost)(`repos/${slug}/actions/workflows/${w}/dispatches`, as, { ref: branch });
        if (status < 200 || status >= 300) next.error = status === 422 ? `HTTP 422 (${file} may have no workflow_dispatch trigger)` : `HTTP ${status}`;
      } catch (err: any) {
        next.error = String(err?.message ?? err).slice(0, 200);
      }
      save();
    }
    this.deps.held?.(t.id, next.hosted || next.error ? `waiting on a person to re-run ${file} on ${branch}` : `waiting on the ${file} re-run on ${branch} (${short(head)})`);
  }

  /** The fix minion its live deploy held (runner's deployLive note) before any re-run was recorded, or null. */
  private heldFix(p: Project, mark: RedMark): number | null {
    const t = this.fixTicket(p, mark);
    return t && t.status !== 'closed' && t.state === 'outside' && /waiting on .*re-run/.test(t.note ?? '') ? t.id : null;
  }

  /** A fix minion's re-run went green: dismiss it (deps.dismiss decides when, as a deploy's dismissal does). */
  private dismissFix(ticketId: number, text: string) {
    try {
      this.deps.dismiss?.(ticketId, text);
    } catch (err) {
      console.error(`Dismissing fix minion ${ticketId} failed:`, err);
    }
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
  private say(p: Project, run: number | string, text: string, wake = false, entry?: (id: number) => void): boolean {
    try {
      const told = this.deps.tell!(p, text, wake);
      if (typeof told === 'number' && told > 0) entry?.(told);
      return !!told;
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
