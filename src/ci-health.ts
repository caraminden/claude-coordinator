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
//   - the land gate ("Quiet, ring after 1 h"): since #1662 it waits, like the rest.
// Jobs that never started (a billing block) still ring.
// #983 (Cara, 2026-11-18: "CI alerts need to wake their respective taskmasters to fix the issue"): every problem that rings
// also wakes its scheme's Taskmaster once as it opens (wakeFor; the land gate wakes the live checkout's scheme), so a ring
// is never the first anyone hears of it. The person ring stays the backup, and the #869 wake no longer sends CI's bundle to Citadel's.
// #1017: in a scheme in fast mode, a land's push going red on main is fast mode's to handle (src/fast-mode.ts), not an alert.
// #1662 (Cara, 2026-11-22: "I need to be alerted when there is something actually wrong and then I need to be able to see
// what it is and that it is being fixed"; her picks that day on the shared alerts-takes page, "Silent unless you're needed"):
//   - nothing goes to Mandate while minions handle it: no quiet items (deliver only clears the ones an older build sent);
//   - a red, a fix that didn't hold, a hung runner and the land gate wait (`held`: "After the wait, if nobody's on it", the
//     wait "Keep 1 h"): their Taskmaster is woken at once, and they ring RED_FIX_MS after they opened if still open; a
//     runner that's off with jobs waiting, a billing block and a fix's re-run only a person can start ring at once;
//   - the one alert is sticky: a problem that rang stays in it, worded as who is fixing it, with no new ring, until it's
//     green; new trouble rings again as a new item (Mandate pushes only new ones); it links Home's "Broken now" list.
import { createHash } from 'node:crypto';
import { quietUntil, type AlertPart } from './alert-wakes.ts';
import { breather } from './breathe.ts';
import { briefNumbers } from './ci-brief.ts';
import { lines } from './approvals.ts';
import { APP_NAME } from './appname.ts';
import { runnerLabel, schemeLabels } from './ci-runner.ts';
import { deliveriesOf, type Outbox } from './outbox.ts';
import type { Project, Store, Ticket, User } from './db.ts';
import type { GreenRun } from './last-green.ts';
import { repoSlug } from './prlinks.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { pacific } from './pacific.ts';
import { failuresIn, ghText } from './flake-evidence.ts';

import { thrown } from './thrown.ts';
import type { LongJob } from './long-jobs.ts';
import {
  clock,
  humanText,
  VERDICTS,
  redRun,
  WAIT_MS,
  HUNG_MS,
  RED_FIX_MS,
  type Problem,
  type WakeAt,
  WAKE_AT,
  problemLink,
  WAKE_STEPS,
  itemText,
  at,
  short,
  runUrl,
  workflowFile,
  quietWorkflow,
  HEAVY_WORKFLOW,
  DISPATCH_SINCE,
  trackOffline,
  stuckProblems,
  hungProblems,
  deadGroups,
  deadProblem,
  orphanRuns,
  place,
  type RedMark,
  type Fix,
  redProblem,
  startedRed,
  verdictPair,
  skippedJobs,
  bundleTitle,
  ciPage,
  CI_SENDER,
  BUNDLE_ITEM,
  itemKey,
  asleepRunners,
} from './ci-problems.ts';
import type { Slept } from './ci-load.ts';
export {
  humanText,
  WAIT_MS,
  HUNG_MS,
  RED_FIX_MS,
  ORPHAN_MS,
  type Problem,
  type ProblemLink,
  type WakeAt,
  problemLink,
  itemText,
  clock,
  trackOffline,
  servers,
  stuckProblems,
  hungProblems,
  neverStarted,
  deadGroups,
  deadProblem,
  orphanRuns,
  type RedMark,
  type Fix,
  redProblem,
  verdictPair,
  skippedJobs,
  computerOf,
  sharedHost,
  bundleTitle,
  ciPage,
  CI_SENDER,
  itemKey,
} from './ci-problems.ts';
import { branchTips, type CiView, fallbackStreak, fallbacksOf, type GhBody, type GhNote, type Job, movedRuns, type Run, type Runner, runKind, runMinion, runningNow, type ShipTime, shipTimes, viewRun } from './ci-view.ts';
import type { RetroLine } from './land-reds.ts';
export { type CiView, type Job, type Run, type Runner, runKind, runMinion, runningNow, type ViewRun } from './ci-view.ts';
import { type LandSeen, type LandState, newLandState, landStep, landProblems, ownFallbackProblems } from './ci-land-gate.ts';
export { LAND_STREAK, LAND_SLOW_MS, type LandSeen, type LandState, newLandState, landStep, landProblems } from './ci-land-gate.ts';
import { type GhGet, ghGet, ghPost, RateLimited, rateLimited, GhError } from './gh-api.ts';
export { type GhAnswer, type GhGet, ghGet, ghPost } from './gh-api.ts';

const POLL_MS = 5 * 60_000;
const RATE_LIMITED_MS = 15 * 60_000;
/** A dispatched re-run GitHub hasn't listed this long after it was asked for was lost (a restart before the request, or GitHub's). */
export const LOST_MS = 15 * 60_000;
/** The soonest a fresh start reads GitHub, so a restart (or a test's short-lived server) doesn't ask at once. */
export const START_DELAY_MS = 45_000;
const LAST_TICK = 'ci-health:lastTick';
const PAUSED_UNTIL = 'ci-health:pausedUntil';
/** #1005: when a start's first read comes. The last read and the rate-limit pause survive restarts, so lands that restart the server every few minutes can't push reads later than one poll past the previous. */
export function firstTickDelay(lastTick: number | null | undefined, pausedUntil: number | undefined, now: number): number {
  return Math.max(START_DELAY_MS, (lastTick ?? 0) + POLL_MS - now, (pausedUntil ?? 0) - now);
}
// Runs looked at for jobs that didn't start or wait for a runner; older ones are history.
const RUNS = 50;
/** How many event ids one step of a red's chat search covers, the loop yielding between steps (#1974). */
export const CHAT_STEP = 2000;
const WINDOW_MS = 24 * 3600_000;
// A workflow with no run on main this long is a manual or retired one, never "missing a verdict".
const ACTIVE_MS = 7 * 24 * 3600_000;

/** Something wrong now: what the alert says, keyed so the same trouble keeps one item. */

// ---------- wake_when_runners_back (#541) ----------
// A landing whose CI gate got no verdict (the kit's land.sh exits 75: no runner took the run, nearly always the
// desktop off) seals its minion. Its CI ran on a scratch branch the PR watcher never sees, so this poll wakes it:
// once one of its scheme's runners (labelled <scheme>-ci or <scheme>-ci-linux, as ci_runners adds them) is online.

/** A minion sealed until its scheme's runners are back; in the settings table, so it outlives a restart. */
export interface RunnerWaiter {
  ticket: number;
  reason: string;
}
export const RUNNER_WAITERS = 'wake-runners-back';

export function runnerWaiters(store: Store): RunnerWaiter[] {
  return store.getSetting<RunnerWaiter[]>(RUNNER_WAITERS) ?? [];
}

/** Wait for `ticket`'s scheme's runners; a second call replaces the first. With the outbox (the server's) the wait is a row (ADR 0021, step 4). */
export function addRunnerWaiter(store: Store, ticket: number, reason: string, outbox?: Outbox): void {
  if (outbox) {
    const project_id = store.getTicket(ticket)?.project_id ?? 0;
    outbox.add({ project_id, kind: 'runners_back', to_kind: 'minion', to_id: ticket, when_kind: 'runners', when_arg: runnerLabel(store.getProject(project_id)?.name ?? ''), payload: { reason }, set_by: `minion:${ticket}`, dedupe_key: String(ticket) });
    return;
  }
  store.setSetting(RUNNER_WAITERS, [...runnerWaiters(store).filter((w) => w.ticket !== ticket), { ticket, reason }]);
}

/** The `runners_back` kind (ADR 0021, step 4): registered with the outbox before it boots, so a row a killed server left sending is sent again. */
export function registerRunnersBack(store: Store, outbox: Outbox): void {
  outbox.register({
    kind: 'runners_back',
    // The dual read: move the old key's waits into the table, in one transaction that empties the key: none dropped.
    migrate: () => {
      const old = store.getSetting<RunnerWaiter[]>(RUNNER_WAITERS);
      if (!old?.length) return;
      store.importDeliveries(
        RUNNER_WAITERS,
        old.map((w) => {
          const t = store.getTicket(w.ticket);
          return {
            project_id: t?.project_id ?? 0,
            kind: 'runners_back',
            to_kind: 'minion' as const,
            to_id: w.ticket,
            when_kind: 'runners',
            when_arg: runnerLabel(store.getProject(t?.project_id ?? 0)?.name ?? ''),
            payload: { reason: w.reason },
            set_by: `minion:${w.ticket}`,
            dedupe_key: String(w.ticket),
            origin: `${RUNNER_WAITERS}:${createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16)}`,
          };
        }),
        outbox.clock(),
      );
    },
    describe: (r) => `wake_when_runners_back: ${r.payload.reason}`,
    // A wait the poll already met (its send is being retried) keeps the text it saved.
    merge: (row, incoming) => (row.met_at != null ? row.payload : incoming.payload),
    // The poll saved the text when it met the row (an unreadable list: ask a person); a row without one was never met.
    deliver: (rows, ctx) => rows.map((r) => ctx.send(r, r.payload.text ?? r.payload.reason)),
  });
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
/** A row of Home's "Broken now" (#1662). `who.kind`: a fix minion on it, its Taskmaster, or nobody (a person must act). */
export interface BrokenRow {
  scheme: string;
  schemeId: number;
  key: string;
  what: string;
  next?: string;
  since: number | null;
  ringing: boolean;
  ringsAt?: number;
  who: { kind: 'minion' | 'taskmaster' | 'person'; label: string; href: string };
}
/** The one alert (#1662): its key's generation, the problems it holds (`<scheme>:<key>`), the ones ringing at the last send, and each admin's item. */
interface AlertState {
  gen: number;
  rung: string[];
  loud: string[];
  sent: Record<string, string>;
}
const ALERT = 'ci-health:alert';
const bundleKey = (gen: number) => (gen ? `${BUNDLE_ITEM}.${gen}` : BUNDLE_ITEM);
/** Where the one alert opens (#1662, Cara's pick "A strip on Citadel's front page, opening the list"): Home, with "Broken now" open. */
export const BROKEN_PAGE = '/c/#/home/broken';
/** Each problem with when it opened (#1662's "since"): its own, else the last round's for its key, else now. */
const opened = (problems: Problem[], before: Problem[] | undefined, now: number): Problem[] => problems.map((x) => ({ ...x, since: x.since ?? before?.find((b) => b.key === x.key)?.since ?? now }));

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
  /** #1491: a CI job's raw log, or null; gh by default. */
  log?: (slug: string, jobId: number, as: GithubEnv) => Promise<string | null>;
  /** #1491: the commits on the scheme's default `branch` since `since` (ms) touching one of `files`, newest first; none, and no minion is credited by its shipped fix. */
  touched?: (project: Project, branch: string, files: string[], since: number) => Promise<{ sha: string; subject: string; files: string[] }[]>;
  /** Show a held fix minion as waiting on its re-run (`note`), or (null) clear that as it is woken. */
  held?: (ticketId: number, note: string | null) => void;
  /** Dismiss a fix minion whose re-run went green, the way a live deploy does. */
  dismiss?: (ticketId: number, text: string) => void;
  /** Message a minion (wake_when_runners_back, a run it dispatched); `fyi` for news that needs nothing: a dispatched run that passed, which also runs at low effort (#951). No message, no wakes. */
  wake?: (ticketId: number, text: string, fyi?: boolean, run?: Run) => void;
  /** #2239: the runners each PC's agent keeps asleep on Citadel's plan (src/ci-load.ts asleep); none, and every offline runner reads offline. */
  asleep?: () => Slept[];
  /** Held mail for a scheme's Taskmaster (a failed scheduled run), or a message that wakes it (`wake`: a watched workflow gone red); false (no Taskmaster) or none at all, and those wait untold. */
  /** `people`: the admins its alert rings, whose own Taskmasters in the scheme hear of it (taskmastersFor). */
  tell?: (project: Project, text: string, wake?: boolean, people?: number[]) => boolean | number;
  /** The scheme whose Taskmaster hears problems that aren't one scheme's (#983): the live checkout's. */
  home?: () => Project | undefined;
  /** The server's outbox: waits on runners are rows in it (ADR 0021, step 4); without one they stay in the old key. */
  outbox?: Outbox;
  /** Each poll's runs of a scheme (all branches, newest first) with its default branch, for its last green (src/last-green.ts, #1016). */
  green?: (project: Project, runs: GreenRun[], branch: string) => void;
  /** The long jobs (citadel-heavy --long) on record: one running inside its deadline is not a hung runner. */
  longs?: () => LongJob[];
  /** A scheme on the runner pool (Build 11 P3): the machines that could take its jobs now (src/runner-pool.ts able); null for a scheme on standing runners. With one, it has no runner to be offline: it's fine, and minions waiting on its runners wake. */
  pool?: (p: Project) => string[] | null;
  /** #2231: a scheme's retro-log lines from `since` (its ship script's fallbacks); none, and no fallbacks show or ring. */
  retro?: (project: Project, since: number, now: number) => Promise<RetroLine[]>;
  /** #2231: each poll's ship runs' push-to-verdict, for the Numbers tab (CiNumbers.own); none, and they aren't kept. */
  shipTimes?: (project: Project, times: ShipTime[]) => void;
}

/**
 * #1659 (Cara, 2026-11-22: a CI alert should wake "the appropriate taskmaster" so she finds it already looked at): who hears of a problem
 * in a scheme: the own Taskmaster of each person its alert rings, else the scheme's Overlord (a scheme with one Taskmaster is that one).
 * Peek's red on Nov 22 woke only its Overlord while Cara's own Taskmaster, the chat she opened, never heard.
 */
export function taskmastersFor(store: Pick<Store, 'getOverlord' | 'coordinatorFor'>, projectId: number, people: number[] = []): Ticket[] {
  const found = people.map((id) => store.coordinatorFor(projectId, id)).filter((t): t is Ticket => !!t);
  const all = found.length ? found : [store.getOverlord(projectId)].filter((t): t is Ticket => !!t);
  return all.filter((t, i) => all.findIndex((u) => u.id === t.id) === i);
}

export class CiHealth {
  private store: Store;
  private deps: CiHealthDeps;
  private get: GhGet;
  private cache = new Map<string, { etag: string | null; body: unknown }>();
  // Finished runs' jobs and annotations don't change.
  private jobsOf = new Map<string, Job[]>();
  /** Each scheme's self-hosted runners GitHub listed at its last read, by name. */
  private registered = new Map<number, string[]>();
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
        } catch (err) {
          if (err instanceof RateLimited) {
            this.pausedUntil = now + RATE_LIMITED_MS;
            console.error('GitHub rate limit reached; pausing CI health checks.');
            break;
          }
          this.sayOnce(`fail:${p.id}:${thrown(err).message}`, `CI health check of ${p.name} failed (said once until a restart): ${thrown(err).message ?? err}`);
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

  /** One scheme: what's wrong now, kept for the one alert, and the quiet items an older build sent cleared. A round that throws keeps the last. */
  async check(p: Project, slug: string, now: number) {
    const saved: Saved = { offline: {}, sent: {}, ...this.store.getSetting<Saved>(`ci-health:${p.id}`) };
    saved.problems = opened(await this.problems(p, slug, saved, now), saved.problems, now);
    await this.wakeFor(p, saved.problems, `ci-health:woke:${p.id}`, now);
    await this.deliver(p, [], saved);
    this.store.setSetting(`ci-health:${p.id}`, saved);
  }

  /**
   * #983 (Cara, 2026-11-18: "CI alerts need to wake their respective taskmasters to fix the issue"): each problem that
   * rings a person wakes the scheme's Taskmaster once, as it opens (a wake, so a cold one runs too), and again only
   * after it clears and comes back. A problem is recorded as woken once the send went through, so no Taskmaster waits untold.
   * Not overnight (#869's pick, 2-9 AM Pacific): the first poll after 9 sends it. Shared problems wait for wakeShared.
   * A problem that waits (#1662, `held`) wakes it as it opens, an hour before anyone's phone.
   */
  private async wakeFor(p: Project, problems: Problem[], key: string, now: number) {
    if (!this.deps.tell) return;
    const ringing = problems.filter((x) => (!x.quiet || x.held != null) && !x.shared);
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
    const steps = WAKE_STEPS.replace('name this problem in its brief', run ? `put run ${run} in its brief` : 'name this problem in its brief');
    const rings = x.held != null ? steps.replace("People's phones ring for this.", `People's phones ring for this at ${clock(x.held)} if it's still open${x.key.startsWith('red:') ? ' and no minion names the run' : ''}.`) : steps;
    return `${p.name}: ${itemText(x)}${facts ? `\nRuns: ${facts}` : ''}\n${rings} The CI page: ${ciPage(p.id)}`;
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
    w.problems = opened(landProblems(w.state, now), kept?.problems, now);
    const changed = JSON.stringify([kept?.project, kept?.problems ?? []]) !== JSON.stringify([w.project, w.problems]);
    // Every call, not only on a change: a put Mandate refused is tried again on the next (sent entries make it a no-op).
    const p = this.store.getProject(projectId);
    if (p) await this.deliver(p, [], w as Required<LandWatch>);
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

  /**
   * #1662 (Cara's pick, 2026-11-22, "Silent unless you're needed"): the one alert holds the problems ringing now and the ones
   * that rang and are still open, each saying who is on it ("#881 is fixing it"). Those words change in place, with no new
   * ring, and its alarm mark goes once none rings; a problem that starts ringing (again) is new trouble, so the item is
   * cleared and put under its next key, which Mandate pushes. Cleared, and the rung ones forgotten, once none is open.
   */
  private async sendAlert() {
    const all: { scheme: string; problem: Problem; id: number; key: string }[] = [];
    const land = this.store.getSetting<LandWatch>(LAND_WATCH);
    for (const p of this.store.listProjects()) {
      if (!repoSlug(p.repo_url)) continue;
      const mine = [...(this.store.getSetting<Saved>(`ci-health:${p.id}`)?.problems ?? []), ...(land?.project === p.id ? land.problems : [])];
      for (const x of mine) all.push({ scheme: p.name, problem: { ...x, onIt: this.onIt(p, x) }, id: p.id, key: `${p.id}:${x.key}` });
    }
    const loud = all.filter((x) => !x.problem.quiet).map((x) => x.key);
    const kept = this.store.getSetting<AlertState | Record<string, string>>(ALERT) ?? {};
    // A build before #1662 kept only user id → title: what rings now is what that item said, so it changes in place.
    const s: AlertState = 'gen' in kept && typeof kept.gen === 'number' ? (kept as AlertState) : { gen: 0, rung: loud, loud, sent: kept as Record<string, string> };
    const fresh = loud.some((k) => !s.loud.includes(k));
    s.rung = [...new Set([...s.rung, ...loud])].filter((k) => all.some((x) => x.key === k));
    s.loud = loud;
    const shown = all.filter((x) => s.rung.includes(x.key));
    if (fresh && Object.keys(s.sent).length) s.gen++;
    const key = bundleKey(s.gen),
      quiet = !loud.length;
    const title = shown.length ? bundleTitle(shown) : null;
    // What a person's item is: its key, alarm or not, and its words; an older build's was the words alone, under BUNDLE_ITEM.
    const sig = title && `${key}\n${quiet ? 'quiet' : 'alarm'}\n${title}`;
    const keyOf = (had: string) => (had.includes('\n') ? had.split('\n')[0] : BUNDLE_ITEM);
    const admins = title ? this.admins() : [];
    const parts: AlertPart[] = []; // the Taskmaster is woken by wakeFor (#983), not by the alert
    for (const u of admins) {
      const had = s.sent[u.id];
      if (had === sig) continue;
      if (had && keyOf(had) !== key) {
        if (!(await this.deps.mandate(CI_SENDER, u, keyOf(had), null))) continue;
        delete s.sent[u.id];
      }
      if (await this.deps.mandate(CI_SENDER, u, key, title, quiet, BROKEN_PAGE, parts)) s.sent[u.id] = sig!;
    }
    for (const [uid, had] of Object.entries(s.sent)) {
      if (admins.some((u) => String(u.id) === uid)) continue;
      const u = this.store.getUser(Number(uid));
      if (!u || (await this.deps.mandate(CI_SENDER, u, keyOf(had), null))) delete s.sent[uid];
    }
    this.store.setSetting(ALERT, s);
  }

  /**
   * #1659 (Cara, 2026-11-22: when a CI alert rings, "I find it is already being investigated"): who is on a ringing problem,
   * for its line in the alert, from what was actually sent: its open fix minion, else the Taskmaster its wake reached. Nothing when neither.
   */
  private onIt(p: Project, x: Problem): string | undefined {
    if (x.fixMinion && !x.fixMinion.closed) return `#${x.fixMinion.number} is fixing it`;
    const woke = (k: string) => this.store.getSetting<string[]>(`ci-health:woke:${k}`) ?? [];
    // Only a wake that went out counts: none overnight or with nobody to tell.
    const own = (x.key.startsWith('red:') && x.quiet) || woke(String(p.id)).includes(x.key) || woke('land').includes(x.key);
    const poss = (n: string) => (n.endsWith('s') ? `${n}'` : `${n}'s`);
    if (own) return `${poss(p.name)} Taskmaster has been woken`;
    const home = this.deps.home?.();
    const shared = x.shared && (woke('shared').includes(x.shared) ? home : woke('shared').includes(`${x.shared}#${p.id}`) ? p : undefined);
    return shared ? `${poss(shared.name)} Taskmaster has been woken` : undefined;
  }

  /** The one alert's problems as the Taskmaster's wake tells them (#869): the land alarm with each fallen-back run's link, failed step and runner. */
  private async parts(open: { scheme: string; problem: Problem; id: number }[], land: LandWatch | null | undefined): Promise<AlertPart[]> {
    return Promise.all(
      open.map(async ({ scheme, problem, id }) => {
        const part: AlertPart = { id: `${id}:${problem.key}`, title: `${scheme}: ${itemText(problem).replace(/^CI: /, '')}` };
        const p = this.store.getProject(id);
        const slug = p && repoSlug(p.repo_url);
        if (problem.key !== 'land:fallback' || !p || !slug || !land) return part;
        const runs = land.state.fellBack
          .slice(-3)
          .map((f) => f.run)
          .filter((r): r is number => !!r);
        const said = await Promise.all(
          runs.map(async (run) => {
            const jobs = await this.guarded(Date.now(), () => this.jobs(slug, { id: run } as Run, this.deps.as(p)));
            const j = jobs?.find((x) => x.conclusion === 'failure');
            const step = (j?.steps as { name?: string; conclusion?: string }[] | undefined)?.find((x) => x.conclusion === 'failure')?.name;
            return `https://github.com/${slug}/actions/runs/${run}: ${j ? `${j.name}${step ? ` › ${step}` : ''} failed${j.runner_name ? ` on ${j.runner_name}` : ''}` : 'no failed job'}`;
          }),
        );
        return said.length ? { ...part, facts: said.join('; ') } : part;
      }),
    );
  }

  async problems(p: Project, slug: string, saved: Saved, now: number): Promise<Problem[]> {
    const as = this.deps.as(p);
    const answer = await this.listWorkflows(p, slug, as);
    const workflows = (answer?.workflows ?? []).filter((w) => w.state === 'active');
    // Only a whole list (one page) says a workflow is gone.
    if (Array.isArray(answer?.workflows) && (answer.total_count ?? 0) <= answer.workflows.length) this.dropGone(p, new Set(workflows.map((w) => String(w.id))));
    // A repo with no CI costs one conditional request a poll.
    if (!workflows.length) {
      saved.offline = {};
      return [];
    }
    const out: Problem[] = [];

    const listed = await this.read(`repos/${slug}/actions/runners?per_page=100`, as, true);
    const runners: Runner[] | null = Array.isArray(listed?.runners) ? listed.runners : null;
    if (runners) trackOffline(runners, saved.offline, now);
    if (runners)
      this.registered.set(
        p.id,
        runners.map((r) => r.name),
      );
    else this.sayOnce(`runners:${p.id}`, `CI health: can't list ${slug}'s runners (needs a repo admin's linked GitHub), so work stuck on offline runners there goes unseen.`);
    this.wakeParked(p, runners);

    const runs: Run[] = ((await this.read(`repos/${slug}/actions/runs?per_page=${RUNS}`, as))?.workflow_runs ?? []).filter((r: Run) => now - at(r.created_at) <= WINDOW_MS);
    const all: Job[] = [];
    for (const r of runs) all.push(...(await this.jobs(slug, r, as)));
    await this.sweepOrphans(p, slug, runs, as, now);
    this.recent.set(p.id, all);
    this.store.setSetting(
      `ci-health:recent:${p.id}`,
      all.map(({ steps, ...j }) => j),
    );
    for (const g of deadGroups(all)) out.push(deadProblem(g, await this.reason(slug, g.dead.at(-1)!, as)));
    // A runner list it can't read keeps the stuck items as they were: it can't tell, so it neither clears nor rings anew.
    // A pool scheme a machine can take jobs for has no runner whose being offline strands them: the pool's line says why each waits.
    if (!this.deps.pool?.(p)?.length) out.push(...(runners ? stuckProblems(runners, all, saved.offline, now) : (saved.problems ?? []).filter((x) => x.key.startsWith('stuck:'))));
    out.push(...hungProblems(all, now, this.deps.longs?.() ?? []));

    const branch = (await this.read(`repos/${slug}`, as))?.default_branch ?? 'main';
    this.deps.green?.(
      p,
      runs.filter((r) => !quietWorkflow(p, r)).map((r) => ({ head_sha: r.head_sha, workflow_id: r.workflow_id, status: r.status, conclusion: r.conclusion, created_at: r.created_at, file: workflowFile(r) })),
      branch,
    );
    const onMain = new Map<number, Run[]>();
    for (const w of workflows) {
      const mainRuns: Run[] = (await this.read(`repos/${slug}/actions/workflows/${w.id}/runs?branch=${encodeURIComponent(branch)}&per_page=${RUNS}`, as))?.workflow_runs ?? [];
      onMain.set(w.id, mainRuns);
    }
    out.push(...(await this.outsideRuns(p, slug, branch, onMain, as, now)));
    const [tickets, tips] = [this.store.listTickets(p.id), await branchTips(p.repo_dir)];
    const minion = (r: Run) => runMinion(r.head_branch, r.head_sha, tickets, tips);
    // #2231: the ship script's fallbacks off GitHub, a streak of them rings; each ship's push-to-verdict goes to the Numbers tab.
    // The retro log comes in whole UTC days: only the window's lines count.
    const fallbacks = fallbacksOf(((await this.deps.retro?.(p, now - WINDOW_MS, now).catch(() => [])) ?? []).filter((l) => l.at >= now - WINDOW_MS)).map((f) => ({ ...f, minion: runMinion(f.branch, '', tickets, new Map()) }));
    out.push(...ownFallbackProblems(fallbackStreak(runs, all, fallbacks), now));
    const times = shipTimes(runs, all, fallbacks, now);
    const moved = movedRuns(runs, fallbacks);
    if (times.length) this.deps.shipTimes?.(p, times);
    const shown: CiView['workflows'] = [];
    for (const w of workflows) {
      if (String(w.path ?? '').endsWith(`/${HEAVY_WORKFLOW}`)) continue; // minions' own commands: no verdict on main to show
      const mainRuns = onMain.get(w.id) ?? [];
      const verdict = mainRuns.find((r) => r.status === 'completed' && VERDICTS.has(r.conclusion ?? ''));
      const pair = verdictPair(mainRuns);
      const skipped = pair ? skippedJobs(await this.jobs(slug, pair[0], as), await this.jobs(slug, pair[1], as)) : [];
      shown.push({
        name: w.name,
        file:
          String(w.path ?? '')
            .split('/')
            .pop() ?? '',
        // The page knows failure as red: a run that couldn't start reads the same.
        verdict: verdict ? viewRun(slug, redRun(verdict) ? { ...verdict, conclusion: 'failure' } : verdict, minion) : null,
        skipped,
      });
    }
    this.store.setSetting(`ci-health:view:${p.id}`, {
      at: now,
      slug,
      branch,
      runners:
        runners &&
        runners.map((r) => ({
          name: r.name,
          status: r.status,
          busy: !!r.busy,
          labels: (r.labels ?? []).map((l) => l.name),
          job: all.find((j) => j.status === 'in_progress' && j.runner_name === r.name)?.name ?? null,
          offlineSince: saved.offline[r.name] ?? null,
        })),
      waiting: all
        .filter((j) => j.status === 'queued' || j.status === 'waiting')
        .map((j) => {
          const r = runs.find((x) => x.id === j.run_id);
          return { name: j.name, labels: j.labels, since: j.created_at, run: j.run_id, ...(r && { branch: r.head_branch, event: r.event, minion: minion(r) }) };
        }),
      ...runningNow(all, runs, runners, minion),
      workflows: shown,
      runs: runs.slice(0, 30).map((r) => ({ ...viewRun(slug, r, minion, all), ...(moved.has(r.id) && { moved: moved.get(r.id)?.why }) })),
      fallbacks,
    });
    return out;
  }

  /** Every scheme with CI that `canSee` allows, with its last view and its open problems (the land gate's in the live checkout's scheme), for GET /api/ci. */
  /** The scheme's standing runners GitHub listed at the last read (the runner pool's one-job ones left out); [] when unread. */
  standingRegistered(projectId: number): string[] {
    return (this.registered.get(projectId) ?? []).filter((n) => !/^pool-/i.test(n));
  }

  snapshot(canSee: (projectId: number) => boolean) {
    const land = this.store.getSetting<LandWatch>(LAND_WATCH);
    // `deps` is absent where a reader thread calls this on a bare { store } (src/reader.ts).
    const slept = this.deps?.asleep?.() ?? [];
    // A scheme whose repo has no workflows has no view, so isn't listed.
    return this.store.listProjects().flatMap((p) => {
      const view = repoSlug(p.repo_url) && canSee(p.id) ? this.store.getSetting<CiView>(`ci-health:view:${p.id}`) : undefined;
      if (!view) return [];
      const wakes = this.store.getSetting<WakeAt>(WAKE_AT) ?? {};
      const problems = [...(this.store.getSetting<Saved>(`ci-health:${p.id}`)?.problems ?? []), ...(land?.project === p.id ? land.problems : [])].map((x) => ({ ...x, link: problemLink(x, p.id, wakes, (n) => this.store.getTicketByNumber(p.id, n)?.title) }));
      // Each run's and queued job's minion (#1019), its title read now so a renamed minion reads right: a link, else what the run is.
      const who = (r: { minion?: number | null; branch?: string; event?: string }) => (r.minion ? { href: `#/p/${p.id}/t/${r.minion}`, label: `#${r.minion} ${this.store.getTicketByNumber(p.id, r.minion)?.title ?? ''}`.trim() } : { label: runKind(r, view.branch) });
      const quiet = new Set(lines(p.ci_quiet)),
        watch = new Set(lines(p.ci_watch ?? ''));
      // #2239: the runners a PC's agent keeps asleep on Citadel's plan read as asleep, not offline.
      const asleep = view.runners
        ? asleepRunners(
            view.runners,
            slept.filter((x) => x.repo === view.slug.toLowerCase()),
          )
        : new Set<string>();
      const shown = {
        ...view,
        runners: view.runners && view.runners.map((r) => (asleep.has(r.name) ? { ...r, asleep: true as const } : r)),
        waiting: view.waiting.map((j) => ({ ...j, who: who(j) })),
        running: (view.running ?? []).map((j) => ({ ...j, who: who(j) })),
        workflows: view.workflows.map((w) => ({ ...w, quiet: quiet.has(w.file) && !watch.has(w.file), verdict: w.verdict && { ...w.verdict, who: who(w.verdict) } })),
        runs: view.runs.map((r) => ({ ...r, who: who(r) })),
      };
      return [{ id: p.id, name: p.name, view: shown, problems }];
    });
  }

  /**
   * #1662 (Cara's pick, 2026-11-22: "A strip on Citadel's front page, opening the list"): every open problem in the schemes
   * `canSee` allows, for Home's "Broken now": what is wrong in plain words, since when, and who is on it (the fix minion,
   * else the Taskmaster's wake), or that it needs a person (it rings, and no fix minion is on it).
   */
  broken(canSee: (projectId: number) => boolean): BrokenRow[] {
    return this.snapshot(canSee).flatMap((s) =>
      s.problems.map((x) => {
        const fixing = x.fixMinion && !x.fixMinion.closed;
        const rerun = x.rerun && { running: 'shipped, re-running', failed: 'its re-run failed too', manual: 'shipped, needs a re-run by hand' }[x.rerun.state];
        const who: BrokenRow['who'] = fixing ? { kind: 'minion', label: `#${x.fixMinion!.number} fixing${rerun ? ` · ${rerun}` : ''}`, href: x.link!.href } : x.quiet ? { kind: 'taskmaster', label: 'Taskmaster looking', href: x.link!.href } : { kind: 'person', label: 'Needs you', href: x.link!.href };
        return {
          scheme: s.name,
          schemeId: s.id,
          key: x.key,
          what: x.plain?.what ?? x.title.replace(/^CI: /, ''),
          next: x.plain?.next,
          since: x.since ?? null,
          // A red waiting on its first fix minion rings at noFix.ringsAt; every other quiet one at `held`.
          ringing: !x.quiet,
          ...(x.quiet && (x.held ?? (x.noFix && !x.noFix.late ? x.noFix.ringsAt : null)) != null && { ringsAt: x.held ?? x.noFix!.ringsAt }),
          who,
        };
      }),
    );
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

  /**
   * The runs created since `since` (rounded down to the hour, so the read costs a 304 inside the hour), every workflow and
   * branch, oldest pages last: the Test health tab's land reds (#1607, src/land-reds.ts). At most `pages` pages of 100.
   */
  async runsSince(p: Project, since: number, pages = 5, now = Date.now()): Promise<{ runs: Run[]; partial: boolean } | null> {
    const slug = repoSlug(p.repo_url);
    if (!slug || now < this.pausedUntil) return null;
    const from = new Date(Math.floor(since / 3_600_000) * 3_600_000).toISOString().replace('.000Z', 'Z');
    return this.guarded(now, async () => {
      const all: Run[] = [];
      for (let page = 1; page <= pages; page++) {
        // Not quiet: a 403 or 404 throws, so the tab reads "not read", never a short day as a whole one.
        const got: Run[] = (await this.read(`repos/${slug}/actions/runs?created=%3E%3D${from}&per_page=100&page=${page}`, this.deps.as(p)))?.workflow_runs ?? [];
        all.push(...got);
        if (got.length < 100) return { runs: all, partial: false };
      }
      return { runs: all, partial: true };
    });
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
      } catch (err) {
        console.error(`CI sweep: could not cancel run ${r.id} (${r.head_branch}) on ${slug}: ${thrown(err).message ?? err}`);
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
    // #1521 (CA2): quieted is the workflow's setting, never a run's trigger, so a land's push in fast mode can't wipe a scheduled red's mark.
    const quieted = (r: Run) => workflowFile(r) === HEAVY_WORKFLOW || (!watch.has(workflowFile(r)) && quiet.has(workflowFile(r)));
    const watched = (r: Run) => !quieted(r) && (watch.has(workflowFile(r)) || !landed(r));
    // A newest verdict over a week old is a retired or manual workflow's.
    const startsStreak = (r: Run | undefined): r is Run => !!r && redRun(r) && watched(r) && now - at(r.created_at) <= ACTIVE_MS;
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
        this.deps.wake(minion.id, text, r.conclusion === 'success', r);
      } catch (err) {
        console.error(`Waking #${minion.number} for run ${r.id} failed:`, err);
      }
    }
    if (!this.deps.tell) {
      if (pruned) save();
      return [];
    }
    const newestOf = (rs: Run[]) => rs.filter((x) => x.status === 'completed' && VERDICTS.has(x.conclusion ?? '')).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
    // A workflow whose run name shows its inputs (flake-proof.yml) isn't one verdict: each name is.
    const perInput = new Set<string>();
    for (const [w, rs] of onMain) if (await this.perInput(slug, branch, rs, as)) perInput.add(String(w));
    const titleOf = (w: string, mark: RedMark) => mark.title ?? (perInput.has(w) ? onMain.get(Number(w))?.find((r) => r.id === mark.run)?.display_title : undefined);
    /** The runs of `rs` that count for a mark: all of its workflow's, or only those of its name. */
    const own = (w: string, mark: RedMark, rs = onMain.get(Number(w)) ?? []) => {
      const title = titleOf(w, mark);
      return title == null ? rs : rs.filter((r) => r.display_title === title);
    };
    const newest = (w: string) => (red[w] ? newestOf(own(w, red[w])) : newestOf(onMain.get(Number(w)) ?? []));
    // A re-run is its fix minion's alone: closed, the next one starts its own (marks kept from before are cleared here too).
    for (const mark of Object.values(red)) if (mark.rerun && (this.store.getTicket(mark.rerun.ticket)?.status ?? 'closed') === 'closed') delete mark.rerun;
    // A workflow quieted since it went red: its mark goes, with no message (the scheme said the red is expected).
    for (const w of Object.keys(red)) {
      const r = newest(w);
      if (r && quieted(r)) delete red[w];
    }
    save();
    // Back to green: the first green run on the branch after the red one (or the red one re-run green), a push's or a PR merge's too.
    const between = new Map<string, string>();
    for (const [w, was] of Object.entries(red)) {
      const green = own(w, was, [...(onMain.get(Number(w)) ?? []), ...listed.filter((r) => String(r.workflow_id) === w && r.head_branch === branch)])
        .filter((r) => r.status === 'completed' && r.conclusion === 'success' && (at(r.created_at) > at(was.at) || r.id === was.run))
        .sort((a, b) => at(a.created_at) - at(b.created_at))[0];
      if (!green) continue;
      const text = `${runUrl(slug, green)} (${short(green.head_sha)}, ${pacific(ended(green))}), after run ${was.run} failed`;
      // Red again since, in the same read: the streak that starts below says so, and "back to green" would be false.
      const last = newest(w);
      const again = startsStreak(last) && at(last.created_at) > at(green.created_at);
      if (again) between.set(w, `It was green in between: ${text}.`);
      else if (!quieted(green) && !this.say(p, green.id, `${p.name}'s ${green.name} is back to green on ${branch}: ${text}.`)) continue;
      // #1074: its fix minion was held open on this; deleted first, so the hold is gone as it closes.
      delete red[w];
      save();
      this.freeFix(p, was, `${workflowFile(green)} ${again ? 'went green' : 'is green'} on ${branch}${again ? '' : ' again'} (${runUrl(slug, green)}, on ${short(green.head_sha)}), so it dismissed this fix minion.`);
    }
    // A red with no red mark yet starts a streak.
    for (const w of onMain.keys()) {
      if (red[String(w)]) continue;
      const rs = onMain.get(w) ?? [];
      // shortcut: one mark a workflow, so a second input's red waits until the first one's clears; key marks by name if two are ever red at once.
      const verdicts = perInput.has(String(w)) ? [...new Set(rs.map((r) => r.display_title))].map((t) => newestOf(rs.filter((r) => r.display_title === t))) : [newestOf(rs)];
      const r = verdicts.filter(startsStreak).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
      if (!r) continue;
      const text = this.texts.get(r.id) ?? (await this.runText(p, slug, r, as, 'watch'));
      this.texts.set(r.id, text);
      if (this.texts.size > 200) this.texts.delete(this.texts.keys().next().value!);
      red[String(w)] = { run: r.id, at: r.created_at, told: now, where: await this.failedAt(slug, r, as), ...(perInput.has(String(w)) && { title: r.display_title }) };
      save(); // before sending, so a restart can't send it twice
      if (!this.say(p, r.id, between.has(String(w)) ? `${text}\n${between.get(String(w))}` : text, true, (e) => this.wokeAt(`${p.id}:red:${w}`, p.id, e))) {
        delete red[String(w)]; // no Taskmaster yet: the next poll tries again
        save();
        continue;
      }
      this.texts.delete(r.id);
    }
    for (const [w, mark] of Object.entries(red)) await this.noteRed(p, slug, branch, mark, own(w, mark), as, save);
    for (const [w, mark] of Object.entries(red)) await this.rerun(p, slug, branch, Number(w), mark, own(w, mark), titleOf(w, mark) != null, as, now, save);
    if (pruned) save();
    const out: Problem[] = [];
    for (const [w, mark] of Object.entries(red)) {
      const r = newest(w);
      if (!r) continue;
      if (mark.told == null) {
        mark.told = now; // a mark from before #968: its hour starts now
        save();
      }
      const fix = this.fixMinion(p, mark);
      if (this.afterClose(mark, fix, own(w, mark))) save();
      // The re-run of another minion than the red's (one a named brief took the hold from) says nothing of this one's fix.
      const shown = mark.rerun && mark.rerun.ticket !== this.fixTicket(p, mark)?.id ? { ...mark, rerun: undefined } : mark;
      const x = redProblem(workflowFile(r), branch, shown, r, fix, now, slug);
      if (x) out.push(x);
    }
    return out;
  }

  /**
   * The minion fixing a red: the one its re-run is for (#1074), else of the scheme's made since its Taskmaster heard whose title,
   * brief or chat (mark.chat) names a run of the streak, the first open one, else the newest; else (#1491) the one credited by its shipped fix.
   */
  private fixMinion(p: Project, mark: RedMark): Fix | null {
    const t = this.fixTicket(p, mark);
    if (t) return { number: t.number!, closedAt: t.status === 'closed' ? t.updated_at : null };
    const c = mark.fixer ? this.store.getTicket(mark.fixer.ticket) : null;
    return c && c.project_id === p.id && c.number != null ? { number: c.number, closedAt: c.status === 'closed' ? c.updated_at : null, via: `shipped ${short(mark.fixer!.sha)} touching ${mark.fixer!.file}` } : null;
  }

  /** The minions that could be fixing a red: made since its Taskmaster heard of it, or naming it in their chat. */
  private candidates(p: Project, mark: RedMark): Ticket[] {
    return this.store.listTickets(p.id).filter((x) => x.number != null && (mark.chat?.ids.includes(x.id) || x.created_at >= (mark.told ?? 0) - 60_000));
  }

  /** The red's named fix minion: only these are held open and re-run for (#1074); a credited fixer (mark.fixer) only touched the file. */
  fixTicket(p: Project, mark: RedMark): Ticket | null {
    const held = mark.rerun ? this.store.getTicket(mark.rerun.ticket) : null;
    const holder = held && held.project_id === p.id && held.number != null && held.status !== 'closed' ? held : null;
    // #1491: any red run of the streak, not only its first: a minion started later names the newest.
    const ids = [mark.run, ...(mark.runs ?? [])].map(String);
    // #1849: a title or brief naming a run is the strong claim; a chat mention alone only counts when no strong one is open.
    const cands = this.candidates(p, mark)
      .sort((a, b) => a.created_at - b.created_at)
      .map((x) => ({ x, strong: ids.some((id) => x.title.includes(id) || briefNumbers(this.store, x).includes(id)) }))
      .filter((c) => c.strong || mark.chat?.ids.includes(c.x.id));
    const open = (c: { x: Ticket }) => c.x.status !== 'closed';
    // First open strong one (Josh, 2026-11-19), then an open holder, then an open chat-named one; else the newest closed one.
    const pick = cands.find((c) => c.strong && open(c))?.x ?? holder ?? cands.find(open)?.x;
    return pick ?? cands.filter((c) => c.strong).at(-1)?.x ?? cands.at(-1)?.x ?? null;
  }

  /**
   * #1491 (Cara, 2026-11-21, "Credit the real fixer"): what a red needs to find its fixer: the streak's later red runs, its
   * failing tests (read once), and, while no minion names a run, the first minion after the red whose shipped commit touched
   * one of those test files: by its "#N" subject, else as the commit a land of the scheme's moved the branch to.
   * shortcut: a land of several commits with no "#N" subjects is only seen when the touching commit is its last; read the land's range if one is missed.
   */
  private async noteRed(p: Project, slug: string, branch: string, mark: RedMark, runs: Run[], as: GithubEnv, save: () => void) {
    const later = runs
      .filter((r) => r.status === 'completed' && redRun(r) && r.id !== mark.run && at(r.created_at) > at(mark.at) && !mark.runs?.includes(r.id))
      .sort((a, b) => at(a.created_at) - at(b.created_at))
      .map((r) => r.id);
    if (later.length) {
      mark.runs = [...(mark.runs ?? []), ...later].slice(-20);
      save();
    }
    if (!mark.file && runs[0]) {
      mark.file = workflowFile(runs[0]);
      save();
    }
    // Her pick's words: a minion that "names the run anywhere in its chat"; read from where the last poll stopped.
    // A run can't be named before it exists, so any minion counts, however old (#1336 started the run it fixed), from the red on.
    // In steps, the loop yielding between them (#1974): a red's first search can cover hours of every chat.
    const breathe = breather();
    const needles = [mark.run, ...(mark.runs ?? [])].map(String);
    let from = mark.chat?.upTo ?? this.store.eventIdAt(at(mark.at)) - 1;
    const found = new Set(mark.chat?.ids);
    let upTo: number;
    for (;;) {
      const chat = this.store.minionsNaming(p.id, needles, from, from + CHAT_STEP);
      for (const id of chat.ids) found.add(id);
      upTo = chat.upTo;
      if (upTo !== from + CHAT_STEP) break;
      from = upTo;
      await breathe();
    }
    // Saved once, whole: a press of Investigate between steps must not see a half-done search.
    if (upTo !== mark.chat?.upTo) {
      mark.chat = { ids: [...found], upTo };
      save();
    }
    // The briefs fixTicket reads (src/ci-brief.ts), in the same paced way: after a restart that is every candidate's.
    for (const t of this.candidates(p, mark)) {
      briefNumbers(this.store, t);
      await breathe();
    }
    if (!mark.failures) {
      const failures = await this.failuresOf(slug, runs.find((r) => r.id === mark.run) ?? ({ id: mark.run } as Run), as);
      if (!failures) return; // GitHub didn't answer: the next poll tries again
      mark.failures = failures;
      save();
    }
    if (mark.fixer || !this.deps.touched || this.fixTicket(p, mark)) return;
    const files = [...new Set(mark.failures.map((f) => f.file))];
    if (!files.length) return;
    const commits = await this.deps.touched(p, branch, files, at(mark.at));
    if (!commits.length) return;
    const mine = this.store.listTickets(p.id).filter((t) => t.number != null);
    const ships = this.store.shippedSince(at(mark.at)).filter((s) => mine.some((t) => t.id === s.ticket_id));
    for (const c of [...commits].reverse()) {
      const n = Number(/^#(\d+)\b/.exec(c.subject)?.[1]);
      const t = mine.find((x) => x.number === n) ?? mine.find((x) => ships.some((s) => s.ticket_id === x.id && c.sha.startsWith(s.commit)));
      if (!t) continue;
      mark.fixer = { ticket: t.id, sha: c.sha, file: c.files[0] ?? files[0] };
      save();
      return;
    }
  }

  /** #1491: a failed run's failing tests from its failed jobs' logs (at most 10), with the test files its run name gives (flake-proof's input) when no log names one; null when GitHub didn't answer. */
  private async failuresOf(slug: string, r: Run, as: GithubEnv): Promise<RedMark['failures'] | null> {
    let jobs: Job[];
    try {
      jobs = (await this.jobs(slug, r, as)).filter((j) => j.conclusion === 'failure');
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      return null;
    }
    const out: NonNullable<RedMark['failures']> = [];
    for (const j of jobs.slice(0, 5)) {
      const log = await (this.deps.log ?? ((s: string, id: number, a: GithubEnv) => ghText(a)(`repos/${s}/actions/jobs/${id}/logs`)))(slug, j.id, as);
      if (log) out.push(...failuresIn(log));
    }
    // shortcut: only node's test runner's failures are read; another runner's red names its files only through its run name.
    if (!out.length) for (const file of new Set(r.display_title?.match(/[\w./-]+\.test\.[cm]?[jt]sx?\b/g) ?? [])) out.push({ file, name: '', message: '' });
    return out.slice(0, 10);
  }

  /**
   * #1491 (Cara, 2026-11-21, "Investigate button"): the brief of a fix minion for the scheme's red `workflow`, from its mark: the run
   * and its link, the streak's later runs, the failing tests and their first error lines. Its title names the run, so the poll's
   * fixTicket finds it. `open`: an open minion that already names a run of it, so a second press starts none. Null when it isn't red.
   */
  redBrief(p: Project, workflow: number, by: string): { title: string; message: string; open: Ticket | null } | null {
    const mark = this.store.getSetting<Record<string, RedMark>>(`ci-health:red:${p.id}`)?.[String(workflow)];
    const slug = repoSlug(p.repo_url);
    if (!mark || !slug) return null;
    const named = this.fixTicket(p, mark);
    const branch = this.store.getSetting<CiView>(`ci-health:view:${p.id}`)?.branch ?? 'main';
    const file = mark.file ?? 'a workflow';
    const url = runUrl(slug, { id: mark.run } as Run);
    const fails = mark.failures ?? [];
    const tests = fails.length
      ? fails
          .map(
            (f) =>
              `- ${f.file}${f.name ? ` › ${f.name}` : ''}${
                f.message
                  ? `\n${f.message
                      .split('\n')
                      .map((l) => `    ${l}`)
                      .join('\n')}`
                  : ''
              }`,
          )
          .join('\n')
      : '- none read yet from its job logs';
    const message = [
      `${p.name}'s ${file} is red on ${branch}: run ${mark.run} (${url}), ${pacific(at(mark.at))}${mark.where ? `, at ${mark.where}` : ''}.`,
      ...(mark.runs?.length ? [`Later red runs of the same streak: ${mark.runs.join(', ')}.`] : []),
      '',
      "Failing tests, from the run's failed job logs:",
      tests,
      '',
      `\`ci-failures ${mark.run} -R ${slug}\` prints them in full.`,
      '',
      `${by} pressed Investigate on this red on the CI page. Find the cause and fix it (the citadel:bug-fixing skill: a failing test first), then ship it. If the red is CI itself (a runner, GitHub) rather than the code, say so and stop. The red clears once ${file} runs green on ${branch} again.`,
    ].join('\n');
    return { title: `Fix the red ${file} on ${branch} (run ${mark.run})`, message, open: named?.status !== 'closed' ? named : null };
  }

  /** #1491: the red names minion #`n`, started by Investigate, at once; the check in 30 s (soon) then finds it by its title. */
  named(p: Project, workflow: number, n: number) {
    const saved = this.store.getSetting<Saved>(`ci-health:${p.id}`);
    const i = saved?.problems?.findIndex((x) => x.key === `red:${workflow}`) ?? -1;
    if (!saved || i < 0) return;
    saved.problems![i] = startedRed(saved.problems![i], n);
    this.store.setSetting(`ci-health:${p.id}`, saved);
    this.soon(p.id);
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
      } catch (err) {
        if (err instanceof RateLimited) this.pausedUntil = Date.now() + RATE_LIMITED_MS;
      } finally {
        this.busy = false;
      }
    };
    const timers = [30_000, 150_000].map((ms, i) =>
      setTimeout(() => {
        if (i === 1) this.soonAt.delete(projectId);
        void look();
      }, ms),
    );
    for (const x of timers) x.unref?.();
    this.soonAt.set(projectId, timers);
  }

  /**
   * #1074: the run that tests a red's fix. Once the fix minion's work is on GitHub's `branch` (deps.shipped), its
   * workflow is dispatched there once, unless a run on that tip is there already (queued, running or done: a push's
   * own CI), or its jobs run on GitHub's own runners (they may cost Actions minutes: a person's call). A tip with no new work of the
   * minion's (another land on top) starts nothing. A re-run gone red wakes the minion; green is the back-to-green loop's.
   */
  private async rerun(p: Project, slug: string, branch: string, w: number, mark: RedMark, runs: Run[], inputs: boolean, as: GithubEnv, now: number, save: () => void) {
    const t = this.fixTicket(p, mark);
    if (!t || t.status === 'closed') return;
    const file = workflowFile(runs.find((r) => r.id === mark.run) ?? runs[0] ?? ({ name: 'its workflow' } as Run));
    const re = mark.rerun?.ticket === t.id ? mark.rerun : undefined;
    if (re && !re.failed) {
      // Ours is the first run started since (the daily one tests the tip too): GitHub runs the branch's tip when it starts it, which can be past re.sha.
      const started = runs.filter((r) => /^(workflow_dispatch|schedule)$/.test(r.event ?? '') && at(r.created_at) >= re.at - 60_000).sort((a, b) => at(a.created_at) - at(b.created_at));
      // A cancelled one gave way to a later one (the CI desktop hold keeps main's newest).
      const seen = re.dispatched || re.inputs ? (started.find((r) => r.conclusion !== 'cancelled') ?? started[0]) : runs.filter((r) => r.head_sha === re.sha).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
      if (seen && (seen.id !== re.run || seen.head_sha !== re.sha)) {
        re.run = seen.id;
        re.sha = seen.head_sha;
        save();
      }
      if (seen && (re.error || re.inputs)) {
        // A person (or a late GitHub) started it after all.
        delete re.error;
        delete re.inputs;
        re.dispatched = true;
        save();
      }
      if (!seen && re.dispatched && !re.error && now - (re.resent ?? re.at) >= LOST_MS) {
        if (re.resent) {
          re.error = `GitHub took Citadel's request twice, at ${clock(re.at)} and ${clock(re.resent)}, and never listed a run`;
          save();
          this.deps.held?.(t.id, `waiting on a person to re-run ${file} on ${branch}`);
        } else {
          re.resent = now;
          save(); // before dispatching, so a restart can't dispatch again at once
          await this.dispatch(slug, branch, w, file, re, as);
          save();
          if (re.error) this.deps.held?.(t.id, `waiting on a person to re-run ${file} on ${branch}`);
        }
        return;
      }
      // Cancelled or timed out counts too: the minion hears, rather than waiting on a run that never goes green.
      if (seen?.status === 'completed' && seen.conclusion !== 'success') {
        const text = await this.runText(p, slug, seen, as, 'minion');
        re.failed = true;
        save(); // before sending, so a restart can't wake it twice
        this.deps.held?.(t.id, null);
        this.deps.wake?.(
          t.id,
          `The ${file} re-run on ${branch} after your fix went live ended ${seen.conclusion ?? 'without a verdict'}, so ${branch} is still red and this minion stays open until it's green. Fix it and ship again; Citadel re-runs ${file} once that's live.
${text}`,
        );
        return;
      }
    }
    if (!this.deps.shipped) return;
    const head: string | undefined = (await this.read(`repos/${slug}/branches/${encodeURIComponent(branch)}`, as))?.commit?.sha;
    if (!head || head === re?.sha) return;
    const tip = await this.deps.shipped(p, t, head);
    // Nothing of its own in the tip, or no new fix since the last re-run: someone else's land, not its fix.
    const same = re?.tip === tip;
    if (!tip || (same && !re?.error)) return;
    const next: NonNullable<RedMark['rerun']> = { ticket: t.id, sha: head, tip, at: now };
    const there = runs.filter((r) => r.head_sha === head).sort((a, b) => at(b.created_at) - at(a.created_at))[0];
    if (same && re?.resent && !there) return; // lost twice: a person starts it, whatever lands on top
    const red = runs.find((r) => r.id === mark.run) ?? ({ id: mark.run, workflow_id: w } as Run);
    // A red that couldn't start has no jobs to read its runners from: the newest run that has some stands in.
    let jobs = there || inputs ? [] : await this.jobs(slug, red, as);
    if (!there && !inputs) for (const r of runs.slice(0, 10)) jobs = jobs.length ? jobs : await this.jobs(slug, r, as);
    // CI_RUNNER=github moves a workflow onto GitHub's runners (the kit's convention), which the red's own jobs can't show.
    const toGithub = !there && !inputs && String((await this.read(`repos/${slug}/actions/variables/CI_RUNNER`, as, true))?.value ?? '').toLowerCase() === 'github';
    if (there) next.run = there.id;
    else if (inputs) next.inputs = true;
    else if (toGithub || !jobs.length || jobs.some((j) => !j.labels.some((l) => l.toLowerCase() === 'self-hosted'))) next.hosted = true;
    else next.dispatched = true;
    if (mark.rerun && mark.rerun.ticket !== t.id) mark.waited = [...(mark.waited ?? []), mark.rerun.ticket];
    mark.rerun = next;
    save(); // before dispatching, so a restart can't dispatch twice
    if (next.dispatched) {
      await this.dispatch(slug, branch, w, file, next, as);
      save();
    }
    this.deps.held?.(t.id, next.hosted || next.inputs || next.error ? `waiting on a person to re-run ${file} on ${branch}` : `waiting on the ${file} re-run on ${branch} (${short(head)})`);
  }

  private async dispatch(slug: string, branch: string, w: number, file: string, re: NonNullable<RedMark['rerun']>, as: GithubEnv) {
    try {
      const { status } = await (this.deps.post ?? ghPost)(`repos/${slug}/actions/workflows/${w}/dispatches`, as, { ref: branch });
      if (status < 200 || status >= 300) re.error = status === 422 ? `HTTP 422 (${file} may have no workflow_dispatch trigger, or need an input)` : `HTTP ${status}`;
    } catch (err) {
      re.error = String(thrown(err).message ?? err).slice(0, 200);
    }
  }

  /** Whether each run of a workflow (its `runs`) takes an input that its run name shows: read from its file, and only when a dispatched run has a name of its own. */
  private async perInput(slug: string, branch: string, runs: Run[], as: GithubEnv): Promise<boolean> {
    const r = runs.find((x) => x.event === 'workflow_dispatch' && x.display_title && x.display_title !== x.name && x.path);
    if (!r) return false;
    const file = await this.read(`repos/${slug}/contents/${r.path!.split('@')[0]}?ref=${encodeURIComponent(branch)}`, as, true);
    if (typeof file?.content !== 'string') return false;
    return /^run-name:.*(?:\n[ \t]+.*)*?\binputs\./m.test(Buffer.from(file.content, 'base64').toString());
  }

  /** Keep when the first red after a closed fix minion ended (RedMark.after); true when it changed. */
  private afterClose(mark: RedMark, fix: Fix | null, runs: Run[]): boolean {
    if (fix?.closedAt == null) return !!mark.after && delete mark.after;
    if (mark.after?.fix === fix.number && mark.after.at >= fix.closedAt) return false; // an older one is from before it was reopened and closed again
    const first = runs.filter((r) => redRun(r) && at(r.created_at) > fix.closedAt!).sort((a, b) => at(a.created_at) - at(b.created_at))[0];
    if (!first) return !!mark.after && delete mark.after;
    mark.after = { fix: fix.number, at: at(first.updated_at ?? first.created_at) };
    return true;
  }

  /** The marks of workflows no longer `active` (deleted or disabled) go, freeing their fix minions: no run of theirs will ever be green. */
  private dropGone(p: Project, active: Set<string>) {
    const key = `ci-health:red:${p.id}`;
    const red = this.store.getSetting<Record<string, RedMark>>(key) ?? {};
    for (const [w, mark] of Object.entries(red)) {
      if (active.has(w)) continue;
      delete red[w];
      this.store.setSetting(key, red); // first, so the hold is gone as its minion closes
      const gone = `${mark.file ?? 'The workflow'} was deleted or disabled on GitHub, so its red (run ${mark.run}) is over`;
      if (this.deps.tell) this.say(p, mark.run, `${p.name}: ${gone}.`);
      this.freeFix(p, mark, `${gone}, so it dismissed this fix minion.`);
    }
  }

  /** Dismiss who was held open on a red that is over: its re-run's minion, those still waiting from re-runs before it, and the one its live deploy held. */
  private freeFix(p: Project, mark: RedMark, text: string) {
    const waited = (mark.waited ?? []).filter((id) => this.waits(this.store.getTicket(id)));
    for (const id of new Set([mark.rerun?.ticket, ...waited, this.heldFix(p, mark)])) if (id != null) this.dismissFix(id, text);
  }

  /** The fix minion its live deploy held (runner's deployLive note) before any re-run was recorded, or null. */
  private heldFix(p: Project, mark: RedMark): number | null {
    const t = this.fixTicket(p, mark);
    return this.waits(t) ? t!.id : null;
  }

  private waits(t: Ticket | null | undefined): boolean {
    return !!t && t.status !== 'closed' && t.state === 'outside' && /waiting on .*re-run/.test(t.note ?? '');
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
      const told = this.deps.tell!(
        p,
        text,
        wake,
        this.admins().map((u) => u.id),
      );
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
      files.length
        ? `Its files in ${APP_NAME}'s CI store (ci_files with run: ${r.id}): ${files
            .slice(0, 5)
            .map((f) => `${f.name} (${f.kind})`)
            .join(', ')}${files.length > 5 ? `, ${files.length - 5} more` : ''}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const finished = `finished ${pacific(at(r.updated_at ?? r.created_at))}`;
    const failures = `\`ci-failures ${r.id} -R ${slug}\` prints its failing tests.`;
    if (to === 'minion') {
      const how = r.conclusion === 'success' ? 'passed' : r.conclusion === 'failure' ? `failed${where}` : `ended ${r.conclusion}`;
      return `Your dispatched ${r.name} run on ${r.head_branch} ${how} (${short(r.head_sha)}, ${finished}): ${runUrl(slug, r)}${extra ? `\n${extra}` : ''}${r.conclusion === 'failure' ? `\n${failures}` : ''}`;
    }
    const by = r.triggering_actor?.login ? ` by ${r.triggering_actor.login}` : '';
    const file = workflowFile(r);
    const jobs = failed.length ? `\nFailing jobs: ${failed.slice(0, 8).join('; ')}${failed.length > 8 ? `; ${failed.length - 8} more` : ''}` : '';
    return `${p.name}'s ${r.head_branch} went red: ${file} (${r.name}) run ${r.id} failed on ${short(r.head_sha)} (${r.event ?? 'a run'}${by}, ${finished}${r.conclusion === 'startup_failure' ? ", and never started: look at the workflow file's `uses:` and permissions" : ''}): ${runUrl(slug, r)}${jobs}${extra ? `\n${extra}` : ''}\n${failures} Later red runs of ${file} won't message you again; you'll hear when it's back to green. Start a fix minion now and put run ${r.id} in its brief: people get a quiet item naming it, and their phone rings if no minion names the run within an hour or ${r.head_branch} is still red after it closes. If it's CI itself (a runner, GitHub) rather than the code, ask people. To stop these for ${file}, add it to the scheme's quiet CI workflows (set_project_settings quiet_workflows).`;
  }

  /** A failed job's error annotations, the generic "Process completed with exit code" left out: at most 5, each cut short. */
  private async errorLines(slug: string, j: Job, as: GithubEnv): Promise<string[]> {
    const path = `repos/${slug}/check-runs/${j.id}/annotations`;
    const notes = await this.read<GhNote[]>(path, as, true);
    this.cache.delete(path);
    if (!Array.isArray(notes)) return [];
    return notes
      .filter((n) => n?.annotation_level === 'failure' && typeof n.message === 'string' && !/^Process completed with exit code \d+\.?$/.test(n.message.trim()))
      .slice(0, 5)
      .map((n) => {
        const m = n.message!.replace(/\s+/g, ' ').trim();
        return m.length > 200 ? `${m.slice(0, 199)}…` : m;
      });
  }

  /** The scheme's runners online, or for a pool scheme the machines that could take its jobs, as runners by name; null when the list can't be read. */
  private upFor(p: Project, runners: Runner[] | null): { name: string }[] | null {
    const able = this.deps.pool?.(p);
    if (able?.length) return able.map((name) => ({ name }));
    return runners && onlineRunners(runners, p.name);
  }

  /** The outbox's rows waiting on this scheme's runners: met once one is online, or when the list can't be read (they are told to ask). The outbox sends, retries and holds them for a dismissed minion. */
  private meetRunners(p: Project, runners: Runner[] | null) {
    const outbox = this.deps.outbox;
    if (!outbox) return;
    const up = this.upFor(p, runners);
    if (up && !up.length) return;
    const names = up?.map((r) => r.name).join(', ');
    for (const r of deliveriesOf(this.store, 'runners_back', { states: ['waiting'] })) {
      if (r.project_id !== p.id || r.met_at != null) continue;
      const reason = String(r.payload.reason).replace(/[.\s]+$/, '');
      const text = !up
        ? `${APP_NAME} can't read ${p.name}'s CI runners with the scheme's GitHub login, so it can't tell when they are back: ask a person whether they are, then ${reason}.`
        : `${p.name}'s CI runners are back (${names} online): ${reason}. If land seals again on no runner while they're online, the workflow's runs-on may not match them: ask a person instead of sealing again.`;
      outbox.meet(r.id, { text });
    }
  }

  /**
   * Message (once) and drop the scheme's minions sealed on its runners, once one of them is online; dismissed ones are dropped.
   * `runners` null: the list can't be read, so nothing would ever say they're back, and the minions hear that instead.
   */
  wakeParked(p: Project, runners: Runner[] | null) {
    this.meetRunners(p, runners);
    const all = runnerWaiters(this.store);
    const mine = (w: RunnerWaiter) => this.store.getTicket(w.ticket)?.project_id === p.id;
    const gone = (w: RunnerWaiter) => {
      const t = this.store.getTicket(w.ticket);
      return !t || t.status === 'closed';
    };
    const up = this.upFor(p, runners);
    const woken = (!up || up.length) && this.deps.wake ? all.filter((w) => mine(w) && !gone(w)) : [];
    if (!woken.length && !all.some(gone)) return;
    // Dropped before sending, so a send that throws can't wake anyone twice.
    this.store.setSetting(
      RUNNER_WAITERS,
      all.filter((w) => !gone(w) && !woken.includes(w)),
    );
    const names = up?.map((r) => r.name).join(', ');
    for (const w of woken) {
      const reason = w.reason.replace(/[.\s]+$/, '');
      try {
        if (!up) this.deps.wake!(w.ticket, `${APP_NAME} can't read ${p.name}'s CI runners with the scheme's GitHub login, so it can't tell when they are back: ask a person whether they are, then ${reason}.`);
        else this.deps.wake!(w.ticket, `${p.name}'s CI runners are back (${names} online): ${reason}. If land seals again on no runner while they're online, the workflow's runs-on may not match them: ask a person instead of sealing again.`);
      } catch (err) {
        console.error(`Waking #${w.ticket} for its runners failed:`, err); // the others still get theirs
      }
    }
  }

  /**
   * A scheme's own items: every admin with Mandate on gets each, updated when its words change, and cleared once it's gone.
   * Since #1662 nothing goes out quiet (Cara: "Silent unless you're needed"), so callers pass none and this clears what an older build sent.
   */
  async deliver(p: Project, problems: Problem[], saved: Pick<Saved, 'sent'>) {
    const admins = this.admins();
    const open = new Map(problems.map((x) => [x.key, x]));
    for (const [key, x] of open) {
      const title = humanText(p.name, { ...x, onIt: this.onIt(p, x) }),
        quiet = x.quiet;
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
  private async listWorkflows(p: Project, slug: string, as: GithubEnv): Promise<GhBody | null> {
    try {
      return await this.read(`repos/${slug}/actions/workflows?per_page=100`, as);
    } catch (err) {
      if (!(err instanceof GhError) || err.status !== 404) throw err;
      const owner = as && p.owner_id != null ? this.store.getUser(p.owner_id) : null;
      const who = !as ? "the box's GitHub login" : `${owner?.name ?? 'the scheme owner'}'s linked GitHub`;
      throw new Error(`${who} can't see ${slug} (GitHub answers 404): it has no access to the repo or its invite is still waiting to be accepted, or the repo isn't at that address (deleted, or repo_url is wrong).`);
    }
  }

  /** A GitHub answer's body, from cache on a 304; null for a 404 or 403 when `quiet`; anything else throws. */
  private async read<T = GhBody>(path: string, as: GithubEnv, quiet = false): Promise<T | null> {
    const had = this.cache.get(path);
    const r = await this.get(path, had?.etag ?? null, as);
    if (r.status === 304 && had) return had.body as T;
    if (r.status === 200) {
      this.cache.set(path, { etag: r.etag, body: r.body });
      return r.body as T;
    }
    if (rateLimited(r)) throw new RateLimited();
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
      const notes = await this.read<GhNote[]>(`repos/${slug}/check-runs/${j.id}/annotations`, as, true);
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
