// CI health (#368; ask C3 of shared/project/specs/native-app-ci-asks-2026-11.md): Citadel watches every scheme's
// GitHub Actions and tells a person, never a minion, when CI is unwell in a way a red test doesn't show:
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_NAME } from './appname.ts';
import { schemeLabels } from './ci-runner.ts';
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
  started_at?: string | null;
  completed_at?: string | null;
  runner_name: string | null;
  labels: string[];
  steps?: unknown[];
}
export interface Runner {
  name: string;
  status: string;
  labels?: { name: string }[];
}
/** Something wrong now: what the alert says, keyed so the same trouble keeps one item. */
export interface Problem {
  key: string;
  title: string;
  /** Informational: a plain item, never an alarm. */
  quiet?: boolean;
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

/**
 * A green run that skipped jobs which ran (passed or failed) in the verdict before it: green that proves less than it
 * says. Quiet, since it is still a green run; its key changed from skipped: when it stopped alarming (#532), so the
 * alarm items already out are cleared.
 */
export function skippedProblem(workflow: { id: number; name: string }, branch: string, latest: Run, latestJobs: Job[], beforeJobs: Job[]): Problem | null {
  const ran = new Set(beforeJobs.filter((j) => RAN.has(j.conclusion ?? '')).map((j) => j.name));
  const skipped = latestJobs.filter((j) => j.conclusion === 'skipped' && ran.has(j.name)).map((j) => j.name);
  if (!skipped.length) return null;
  return { key: `green-skipped:${workflow.id}`, quiet: true, title: `CI: ${workflow.name} on ${branch} (${latest.head_sha.slice(0, 7)}) went green with ${plural(skipped.length, 'job')} skipped that ran the time before: ${skipped.join(', ')}` };
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

/** The one alert's words for every scheme's open problems: led by offline runners and the PC they share, then the rest in full. */
export function bundleTitle(open: { scheme: string; problem: Problem }[]): string {
  const text = (x: { problem: Problem }) => x.problem.title.replace(/^CI: /, '');
  const cut = (s: string) => (s.length > 500 ? `${s.slice(0, 499)}…` : s);
  if (open.length === 1) return cut(`CI, ${open[0].scheme}: ${text(open[0])}`);
  const runners = open.filter((x) => x.problem.key.startsWith('runner:'));
  const others = open.filter((x) => !x.problem.key.startsWith('runner:'));
  const host = sharedHost(runners.map((x) => x.problem.key.slice('runner:'.length)));
  const head = [
    runners.length ? `${plural(runners.length, 'runner')} offline${host ? ` on ${host}` : ''}` : '',
    others.length ? plural(others.length, runners.length ? 'other problem' : 'problem') : '',
  ].filter(Boolean).join(' and ');
  const detail = others.map((x) => `${x.scheme}: ${text(x)}`).join('; ');
  return cut(`CI: ${head} in ${schemesText([...new Set(open.map((x) => x.scheme))])}${detail ? `. ${detail}` : ''}`);
}

/** Who the one alert comes from in Mandate: no scheme of its own, so a switch for CI health alone. */
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

/** The land gate's problems now, for the one alert. */
export function landProblems(s: LandState, now: number): Problem[] {
  const out: Problem[] = [];
  const n = s.fellBack.length;
  if (n >= LAND_STREAK) {
    const named = s.fellBack.slice(-3).map((f) => `${f.name} (${f.why}${f.run ? `, run ${f.run}` : ''})`);
    out.push({ key: 'land:fallback', title: `CI: the land gate fell back to perigee on ${n} lands in a row: ${n > 3 ? `${n - 3} more, then ` : ''}${named.join(', ')}` });
  }
  const slow = Object.values(s.lands).filter((l) => now - l.joined >= LAND_SLOW_MS).sort((a, b) => a.joined - b.joined);
  if (slow.length) {
    const names = slow.map((l) => l.name);
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} have` : `${names[0]} has`;
    out.push({ key: 'land:slow', title: `CI: ${who} been landing since ${clock(slow[0].joined)} (over 30 min)` });
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

class RateLimited extends Error {}

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
}
const LAND_WATCH = 'ci-health:land';

export interface CiHealthDeps {
  /** The GitHub login to read a scheme's repo as: its owner's linked one, or undefined for the box's. */
  as: (project: Project) => GithubEnv;
  /** Put (with `title`) or clear (null) a person's Mandate item from a scheme or CI_SENDER, an alert unless `quiet`; true once Mandate has it settled. */
  mandate: (from: Pick<Project, 'id' | 'name'>, person: User, key: string, title: string | null, quiet?: boolean, link?: string) => Promise<boolean>;
  get?: GhGet;
  /** Message a minion (wake_when_runners_back); no message, no wakes. */
  wake?: (ticketId: number, text: string) => void;
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
  async land(projectId: number, seen: LandSeen[], now = Date.now()) {
    const kept = this.store.getSetting<LandWatch>(LAND_WATCH);
    const w: LandWatch = { project: projectId, state: kept?.state ?? newLandState(), problems: [] };
    const before = JSON.stringify(kept?.state);
    landStep(w.state, seen, now);
    w.problems = landProblems(w.state, now);
    const rang = JSON.stringify([kept?.project, kept?.problems ?? []]) !== JSON.stringify([w.project, w.problems]);
    if (rang || before !== JSON.stringify(w.state)) this.store.setSetting(LAND_WATCH, w);
    if (rang) await this.alert();
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
    for (const u of admins) {
      if (sent[u.id] !== title && (await this.deps.mandate(CI_SENDER, u, BUNDLE_ITEM, title, false, `/c/#/p/${open[0].id}`))) sent[u.id] = title!;
    }
    for (const uid of Object.keys(sent)) {
      if (admins.some((u) => String(u.id) === uid)) continue;
      const u = this.store.getUser(Number(uid));
      if (!u || (await this.deps.mandate(CI_SENDER, u, BUNDLE_ITEM, null))) delete sent[uid];
    }
    this.store.setSetting('ci-health:alert', sent);
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
    if (Array.isArray(runners?.runners)) {
      out.push(...runnerProblems(runners.runners, saved.offline, now));
      this.wakeParked(p, runners.runners);
    } else {
      // Unreadable isn't fine: the runners already alerting stay as they were, and new ones go unseen.
      // Before #540 only the items' titles were kept, so the first round after it reads them back from those.
      const was = saved.problems ?? Object.entries(saved.sent).map(([key, by]) => ({ key, title: Object.values(by)[0] ?? '' }));
      out.push(...was.filter((x) => x.key.startsWith('runner:') && x.title));
      this.sayOnce(`runners:${p.id}`, `CI health: can't list ${slug}'s runners (needs a repo admin's linked GitHub), so offline runners there go unseen.`);
      this.wakeParked(p, null);
    }

    const runs: Run[] = ((await this.read(`repos/${slug}/actions/runs?per_page=${RUNS}`, as))?.workflow_runs ?? [])
      .filter((r: Run) => now - at(r.created_at) <= WINDOW_MS);
    const jobs: Job[] = [];
    const all: Job[] = [];
    for (const r of runs) {
      const its = await this.jobs(slug, r, as);
      all.push(...its);
      // A run under QUEUED_MS old can't have a job waiting too long yet, and an unfinished one has none that died.
      if (r.status === 'completed' || now - at(r.created_at) >= QUEUED_MS) jobs.push(...its);
    }
    this.recent.set(p.id, all);
    this.store.setSetting(`ci-health:recent:${p.id}`, all.map(({ steps, ...j }) => j));
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
  async deliver(p: Project, problems: Problem[], saved: Saved) {
    const admins = this.admins();
    const open = new Map(problems.map((x) => [x.key, x]));
    for (const [key, { title, quiet }] of open) {
      const sent = (saved.sent[key] ??= {});
      for (const u of admins) {
        if (sent[u.id] === title) continue;
        if (await this.deps.mandate(p, u, itemKey(key), title, quiet)) sent[u.id] = title;
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
