// Where a pool job goes when no machine can take it (Build 11 P5, specs/one-runner-pool.md section 5).
//   - "No room" (machines on, full of jobs) never falls back: the job waits in line, room comes back. Only a job no
//     machine could take (noMachine: none lends its scheme CI, runs what it needs, is on, or has a CI limit it fits
//     before minion turns take their share) for FALLBACK.afterMs moves on.
//   - Then, by Cara's Q3 pick (2026-11-27, #2264's card): "Public repos go to GitHub", "perigee can be a fallback for
//     private repos, just need to load balance and make sure we dont overload it", and for Peek's Windows jobs "maybe we
//     fall back to github minutes?". A public repo's job, and a private repo's Windows job while under 80% of the
//     account's included minutes, are cancelled and started again on the same commit with the workflow's `route` input set
//     to github. A private repo's Linux job goes to perigee, one at a time and only while its load is low, in a rootless
//     podman container (Cara, 2026-11-28, Plot 11's card: "In a podman container"). A job that needs a signed-in session or
//     a GPU waits. The minutes are Citadel's own count of the jobs it sent to GitHub ("Count our own jobs", same card).
//   - The scheme's Taskmaster hears once, at FALLBACK.afterMs: the job, why each machine couldn't take it, and where it went.
// A restart creates the new run before it cancels the old one: both ship scripts follow "the newest run of the workflow on
// this commit" (the kit's land.sh ci_read, Citadel's tools/land/ci.sh ci_run), so they never see the cancelled run as the
// newest, which the kit's script would read as a run with no verdict and start again itself.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Needs, PoolJob, PoolMachine } from './runner-pool.ts';

/** P5's numbers, starting values (#2264), changed only here. */
export const FALLBACK = {
  /** No machine able to take a job for this long sends it on. */
  afterMs: 10 * 60_000,
  /** Private repos' Windows jobs stop going to GitHub once this share of the included minutes is used (specs/ci-hosted-overflow.md's guard). */
  guard: 0.8,
  /** The account's included Actions minutes a month: Pro's 3,000 (specs/ci-hosted-overflow.md). GitHub's API doesn't say it, so Citadel sets it. */
  included: 3000,
  /** How long a repo's visibility and the account's minutes are taken as read. */
  readMs: 60 * 60_000,
  /** How long a restart waits for its new run to show before it leaves the old one be. */
  confirmMs: 60_000,
  confirmPollMs: 5_000,
  /** Perigee's runner: the official image, run rootless through citadel-heavy's slot, started only below this CPU pressure. */
  perigee: { image: 'ghcr.io/actions/actions-runner:latest', cpus: 4, memory: '8g', quietPct: 30, idleMs: 2 * 60_000, pollMs: 30_000, tries: 2 },
  /** At most this many pages of 100 dispatched runs a repo are counted a month; past it the count fails closed. */
  countPages: 10,
};

export type Route = 'github' | 'perigee' | 'wait';

/** The account's Actions minutes this month, Windows minutes counted as GitHub bills them; or why they couldn't be read. */
export type Minutes = { used: number; included: number } | { error: string };

const OS_WORD = { windows: 'Windows', linux: 'Linux' } as const;

/** Where a job no machine can take goes, and the words for why. `pub`: the repo is public (null: unknown). */
export function routeOf(n: Needs, pub: boolean | null, minutes: Minutes | null): { route: Route; why: string } {
  if (n.session) return { route: 'wait', why: "it needs a signed-in session or a GPU, which GitHub's runners and perigee don't have, so it waits for a machine" };
  if (!n.os) return { route: 'wait', why: 'its labels name no Windows or Linux runner, so nothing else can run it either' };
  if (pub === null) return { route: 'wait', why: "Citadel couldn't read whether its repo is public, so it waits for a machine" };
  if (pub) return { route: 'github', why: "its repo is public, so GitHub's runners run it for free" };
  if (n.os === 'linux') return { route: 'perigee', why: 'its repo is private, so it runs on perigee, one such job at a time and only while perigee is quiet' };
  if (!minutes || 'error' in minutes) return { route: 'wait', why: `its repo is private and its Windows job would spend Actions minutes, but Citadel couldn't read how many are used${minutes ? ` (${minutes.error})` : ''}, so it waits for a machine` };
  const left = Math.max(0, Math.round(minutes.included - minutes.used));
  if (minutes.used >= FALLBACK.guard * minutes.included)
    return { route: 'wait', why: `its repo is private, and ${Math.round(minutes.used)} of the account's ${minutes.included} included Actions minutes are used this month (${Math.round(FALLBACK.guard * 100)}% or more), so it waits for a machine instead of spending more` };
  return { route: 'github', why: `its repo is private, so it spends Actions minutes on GitHub's Windows runners (${left} of ${minutes.included} included minutes left this month, Windows minutes counting double)` };
}

/** Why each machine couldn't take the job, one line each ("cara-desktop is offline"). */
type Lender = Pick<PoolMachine, 'name' | 'os' | 'session' | 'schemes' | 'limit' | 'cap' | 'off'>;

/**
 * No machine could take the job at all, as against waiting for room on one that could (Cara: "if a machine doesnt have
 * room, we can wait and load balance"): none lends its scheme CI, runs its OS (a session too, for one that needs it), is
 * on, and has a CI limit it fits before minion turns take their share. Jobs ahead of it in line don't count either.
 */
export function noMachine(job: Pick<PoolJob, 'scheme' | 'needs'>, machines: readonly Lender[]): boolean {
  const n = job.needs;
  return !machines.some((m) => m.schemes.includes(job.scheme) && n.os !== null && m.os.includes(n.os) && (!n.session || m.session) && !m.off && (m.cap ?? m.limit) >= n.size);
}

export function machineReasons(job: Pick<PoolJob, 'scheme' | 'needs'>, machines: readonly Lender[]): string[] {
  const lent = machines.filter((m) => m.schemes.includes(job.scheme));
  if (!lent.length) return ['no machine lends CI to its scheme'];
  const n = job.needs;
  return lent.map((m) => {
    if (n.os && !m.os.includes(n.os)) return `${m.name} doesn't run ${OS_WORD[n.os]}`;
    if (n.session && !m.session) return `${m.name} has nobody signed in`;
    if (m.off) return `${m.name} ${m.off}`;
    if ((m.cap ?? m.limit) < n.size) return `${m.name} lets CI use ${m.cap ?? m.limit} threads at most, and it needs ${n.size}`;
    return `${m.name} could take it`;
  });
}

/** Perigee takes the first job of its line only when none of its own runs and its load is low (one small slot, "dont overload it"). */
export function perigeeNext(line: readonly string[], running: number, quiet: boolean): string | null {
  return running === 0 && quiet ? (line[0] ?? null) : null;
}

/** A GitHub call with the repo's scheme owner's login. */
export type Gh = (method: 'GET' | 'POST', path: string, body?: object) => Promise<{ status: number; body: unknown }>;

type GhRun = { id?: unknown; path?: unknown; head_branch?: unknown; head_sha?: unknown; status?: unknown; conclusion?: unknown; event?: unknown };

/**
 * Cancel the run and start its workflow again on the same commit with `route: github`. The new run is started and seen
 * before the old one is cancelled (the ship scripts follow the newest run). Nothing is cancelled when the restart can't
 * be made, so a refused one leaves the job waiting, never failed (billing blocked hosted CI on Oct 30 and Nov 5).
 */
export async function restartOnGithub(gh: Gh, repo: string, run: number, wait: (ms: number) => Promise<unknown> = (ms) => sleep(ms, undefined, { ref: false })): Promise<{ ok: boolean; why: string }> {
  const r = await gh('GET', `repos/${repo}/actions/runs/${run}`);
  const b = (r.body ?? {}) as GhRun;
  if (r.status !== 200 || typeof b.path !== 'string' || typeof b.head_branch !== 'string' || typeof b.head_sha !== 'string') return { ok: false, why: `GitHub answered ${r.status} for its run` };
  if (b.status === 'completed') return { ok: false, why: 'its run had already ended' };
  // shortcut: a dispatched run's inputs aren't in GitHub's answer, so only a push's run (a ship's land/ branch, a main push) is started again the same way.
  if (b.event !== 'push') return { ok: false, why: `its run came from a ${String(b.event)}, which can't be started again the same way, so it waits for a machine` };
  // Cancelling takes the whole run: never while one of its jobs runs (a sibling on a machine, or this one, picked up meanwhile).
  const js = await gh('GET', `repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`);
  const jobs = (js.body as { jobs?: { status?: unknown }[] } | null)?.jobs;
  if (js.status !== 200 || !Array.isArray(jobs)) return { ok: false, why: `GitHub answered ${js.status} for its run's jobs` };
  if (jobs.some((j) => j.status === 'in_progress')) return { ok: false, why: 'a job of its run is running now, so the run is left as it is' };
  const path = b.path.replace(/@.*$/, '');
  const branch = b.head_branch;
  const ref = await gh('GET', `repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
  const tip = (ref.body as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (ref.status !== 200 || tip !== b.head_sha) return { ok: false, why: `its branch ${branch} has moved past the run's commit, so a restart would test another commit` };
  const file = path.split('/').pop()!;
  const d = await gh('POST', `repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref: branch, inputs: { route: 'github' } });
  if (d.status === 422) return { ok: false, why: `its workflow ${file} takes no \`route\` input yet (the kit's windows.yml and starter ci.yml have it), so it waits for a machine` };
  if (d.status !== 204) return { ok: false, why: `GitHub refused to start ${file} again (${d.status}), so it waits for a machine` };
  for (let waited = 0; waited <= FALLBACK.confirmMs; waited += FALLBACK.confirmPollMs) {
    // A read that fails (gh unreachable for a moment) is one more poll, not a lost restart.
    const l = await gh('GET', `repos/${repo}/actions/runs?head_sha=${b.head_sha}&event=workflow_dispatch&per_page=20`).catch(() => null);
    const runs = ((l?.body as { workflow_runs?: GhRun[] } | null)?.workflow_runs ?? []).filter((x) => typeof x.path === 'string' && x.path.replace(/@.*$/, '') === path && Number(x.id) > run).sort((x, y) => Number(y.id) - Number(x.id));
    const nu = runs[0];
    if (nu) {
      const id = Number(nu.id);
      // One that ended at once (a startup failure, a billing block) mustn't cost the waiting run its chance at a machine.
      if (nu.status === 'completed' && nu.conclusion !== 'success') return { ok: false, why: `GitHub started run ${id} but it ended at once (${String(nu.conclusion)}), so the old run is left waiting for a machine` };
      const c = await gh('POST', `repos/${repo}/actions/runs/${run}/cancel`);
      // The new run is the newest either way; one GitHub's concurrency group holds behind the old one starts once it ends.
      return { ok: true, why: c.status === 202 ? `started again on GitHub's runners as run ${id}` : `started again on GitHub's runners as run ${id}; cancelling the old run answered ${c.status}` };
    }
    await wait(FALLBACK.confirmPollMs);
  }
  return { ok: false, why: `GitHub took the restart of ${file} but no new run showed up in ${FALLBACK.confirmMs / 1000} s, so the old run is left as it is` };
}

/** How many included minutes GitHub bills a minute of each kind of runner as. */
const rateOf = (labels: unknown): number => {
  const l = Array.isArray(labels) ? labels.join(' ').toLowerCase() : '';
  return l.includes('windows') ? 2 : l.includes('macos') ? 10 : 1;
};

/**
 * An account's Actions minutes this month, by Citadel's own count with the repo scope its links have (Cara, 2026-11-28,
 * Plot 11's card: "Count our own jobs": no `user` scope, no billing API read): the jobs of this month's dispatched runs
 * that ran on GitHub's runners, over the owner's private repos a scheme has (public repos' minutes are free), each rounded
 * up to a whole minute and Windows counted double, as GitHub bills. The fallback's restarts are dispatches, so they are
 * all in it (a person's own hosted dispatch too). `counted` keeps each ended run's minutes, so each is read once. Any read
 * that fails fails the count, so the guard holds.
 * shortcut: a hosted job from a push (a repo's CI_RUNNER=github) isn't Citadel's and isn't counted; read GitHub's own
 * account figure here too if links ever ask for the user scope.
 */
export async function actionsMinutes(ghOf: (repo: string) => Gh | null, repos: readonly string[], since: string, counted: Map<string, number>): Promise<Minutes> {
  let used = 0;
  for (const k of counted.keys()) if (!k.startsWith(`${since} `)) counted.delete(k); // last month's
  for (const repo of repos) {
    const gh = ghOf(repo);
    if (!gh) return { error: `no scheme's GitHub login reads ${repo}` };
    const got = async (path: string): Promise<Record<string, unknown>> => {
      const r = await gh('GET', path);
      if (r.status !== 200 || !r.body || typeof r.body !== 'object') throw new Error(`GitHub answered ${r.status} for ${path.replace(/\?.*/, '')}`);
      return r.body as Record<string, unknown>;
    };
    try {
      if ((await got(`repos/${repo}`)).private !== true) continue;
      for (let page = 1; ; page++) {
        if (page > FALLBACK.countPages) throw new Error(`it dispatched more than ${FALLBACK.countPages * 100} runs this month, more than Citadel counts`);
        const runs = ((await got(`repos/${repo}/actions/runs?event=workflow_dispatch&status=completed&created=>=${since}&per_page=100&page=${page}`)).workflow_runs ?? []) as { id?: unknown; run_attempt?: unknown }[];
        for (const run of runs) {
          // A re-run is a new attempt of the same run, with jobs of its own: counted again.
          const key = `${since} ${repo}#${Number(run.id)}.${Number(run.run_attempt ?? 1)}`;
          let mins = counted.get(key);
          if (mins === undefined) {
            const jobs = ((await got(`repos/${repo}/actions/runs/${Number(run.id)}/jobs?filter=all&per_page=100`)).jobs ?? []) as { runner_group_name?: unknown; labels?: unknown; started_at?: unknown; completed_at?: unknown }[];
            mins = 0;
            for (const j of jobs) {
              const ms = Date.parse(String(j.completed_at)) - Date.parse(String(j.started_at));
              if (j.runner_group_name === 'GitHub Actions' && ms > 0) mins += Math.ceil(ms / 60_000) * rateOf(j.labels);
            }
            counted.set(key, mins);
          }
          used += mins;
        }
        if (runs.length < 100) break;
      }
    } catch (e) {
      return { error: `couldn't count the Actions minutes ${repo} used: ${(e as Error).message}` };
    }
  }
  return { used, included: FALLBACK.included };
}

/**
 * citadel-heavy's switches for perigee's runner: it stays on perigee (HERE: never sent to Citadel's CI as a heavy job),
 * always waits for the one plain slot and its load and memory waits (JUDGE=0: a job is light, and runs at once, until it
 * has a history), under one name, so its history is one row of jobs, not one per job.
 */
export const PERIGEE_HEAVY = { CITADEL_HEAVY_HERE: '1', CITADEL_HEAVY_JUDGE: '0', CITADEL_HEAVY_WHAT: 'CI fallback: perigee runner' } as const;

/** What perigee's runner is built from (server.ts gives the real ones; tests, fakes). */
export interface PerigeeDeps {
  /** perigee's CPU pressure now, a whole percent ("some avg60"); null without PSI. */
  pressure(): number | null;
  /** A one-job runner config for the repo with exactly `labels`, and the runner's GitHub id. The config is a credential: never logged. */
  jit(repo: string, name: string, labels: readonly string[]): Promise<{ id: number; config: string }>;
  /** Start the container through citadel-heavy, the config only in its environment; `done` resolves when it exits. */
  run(name: string, config: string): { done: Promise<unknown>; stop(): void };
  /** GitHub's runner `id`: connected yet, on a job or not; null once it's gone (a one-job runner is removed when its job ends). */
  runner(repo: string, id: number): Promise<{ busy: boolean; online: boolean } | null>;
  remove(repo: string, id: number): Promise<void>;
  wait?(ms: number): Promise<unknown>;
  log(line: string): void;
}

/**
 * Perigee as the pool's last machine for private repos' Linux jobs (Cara, 2026-11-28: "In a podman container"; Josh,
 * 2026-11-20: "the goal is to NOT hammer perigee"): one container at a time (Fallbacks keeps the line), started only while
 * its CPU pressure is under FALLBACK.perigee.quietPct, inside citadel-heavy's slot with its own CPU and memory caps. The
 * job can't read Citadel's data or anyone's logins. A runner still on no job after idleMs (its job was cancelled, or a
 * machine took it) is stopped and taken off GitHub, as the pool's own runners are (spec section 3, step 5).
 */
export function perigeeRunner(d: PerigeeDeps): NonNullable<FallbackDeps['perigee']> {
  const wait = d.wait ?? ((ms: number) => sleep(ms, undefined, { ref: false }));
  return {
    quiet: () => (d.pressure() ?? 0) < FALLBACK.perigee.quietPct,
    start: async (job, labels) => {
      const name = `perigee-${job.id}`;
      const { id, config } = await d.jit(job.repo, name, labels);
      const r = d.run(name, config);
      let ended = false;
      const done = r.done.finally(() => {
        ended = true;
      });
      // The idle clock starts once the runner connects: before that the container waits for citadel-heavy's slot.
      void (async () => {
        const P = FALLBACK.perigee;
        for (let idle = 0; !ended; ) {
          await wait(P.pollMs);
          if (ended) return;
          const s = await d.runner(job.repo, id).catch(() => undefined);
          if (s === null || s?.busy) return; // gone, or on its job: it ends with it
          idle = s?.online ? idle + P.pollMs : 0;
          if (idle < P.idleMs) continue;
          d.log(`Runner pool fallback: ${name} took no job in ${P.idleMs / 1000} s; stopping it`);
          r.stop();
          await d.remove(job.repo, id).catch((e: unknown) => d.log(`Runner pool fallback: couldn't take ${name} off GitHub: ${(e as Error).message}`));
          return;
        }
      })();
      return { ok: true, why: `started on perigee as ${name}`, done };
    },
  };
}

export interface FallbackDeps {
  now(): number;
  /** The repo is public; null when GitHub couldn't say. Read at most once per FALLBACK.readMs. */
  isPublic(repo: string): Promise<boolean | null>;
  /** The repo owner's Actions minutes this month. Read at most once per FALLBACK.readMs. */
  minutes(repo: string): Promise<Minutes>;
  /** Cancel and start again on GitHub's runners (restartOnGithub with the repo's login). */
  github(repo: string, run: number): Promise<{ ok: boolean; why: string }>;
  /** Perigee's own runner for one job (perigeeRunner); left out, private Linux jobs wait. `quiet`: its load is low now. */
  perigee?: { quiet(): boolean; start(job: PoolJob, labels: readonly string[]): Promise<{ ok: boolean; why: string; done: Promise<unknown> }> };
  /** One message to the scheme's Taskmaster. */
  tell(repo: string, text: string): void;
  log(line: string): void;
}

/** A pool job no machine has started, as the fallback sees it: no machine could take it now (`none`), and why each couldn't. */
export interface FallbackLook {
  job: PoolJob;
  /** Its runs-on labels, for perigee's runner. */
  labels: readonly string[];
  none: boolean;
  reasons: string[];
}

type Track = { repo: string; run: number; ship: boolean; since: number; told: boolean; route: Route | null; why: string | null };
type Sent = { key: string; job: PoolJob; labels: readonly string[]; t: Track; tries?: number };

export class Fallbacks {
  private d: FallbackDeps;
  private track = new Map<string, Track>();
  private read = new Map<string, { at: number; value: unknown }>();
  /** Perigee's line of job keys, and the one it runs. */
  private perigeeLine: string[] = [];
  private perigeeJobs = new Map<string, Sent>();
  private perigeeRunning: string | null = null;

  constructor(d: FallbackDeps) {
    this.d = d;
  }

  /**
   * Each pool look: the pool's waiting jobs, and the repos whose jobs it read. A job a machine could take (room or not)
   * starts its 10 minutes over; a job missing from a repo that was read has ended. A repo whose read failed keeps its jobs.
   * The jobs of one run that reach 10 minutes together go as one: one restart, one message.
   */
  look(jobs: readonly FallbackLook[], read?: ReadonlySet<string>) {
    const now = this.d.now();
    const seen = new Set<string>();
    const due = new Map<string, { sent: Sent[]; reasons: string[] }>();
    for (const { job, labels, none, reasons } of jobs) {
      const key = `${job.repo}#${job.id}`;
      seen.add(key);
      let t = this.track.get(key);
      if (!none) {
        // Gone to GitHub (or running on perigee) it stays sent. Any other starts over: a machine can take it now, so it
        // leaves perigee's line, and a later 10 minutes with no machine is told again.
        if (t && t.route !== 'github' && key !== this.perigeeRunning) this.track.delete(key);
        this.perigeeJobs.delete(key);
        continue;
      }
      if (!t) this.track.set(key, (t = { repo: job.repo.toLowerCase(), run: job.run, ship: job.ship, since: now, told: false, route: null, why: null }));
      if (t.told || now - t.since < FALLBACK.afterMs) continue;
      t.told = true;
      const run = `${t.repo}#${job.run}`;
      const g = due.get(run) ?? { sent: [], reasons: [] };
      g.sent.push({ key, job, labels, t });
      for (const r of reasons) if (!g.reasons.includes(r)) g.reasons.push(r);
      due.set(run, g);
    }
    const gone = (k: string, repo: string) => !seen.has(k) && (!read || read.has(repo));
    for (const [k, t] of [...this.track]) if (gone(k, t.repo)) this.track.delete(k);
    for (const k of this.perigeeLine) if (gone(k, this.perigeeJobs.get(k)?.t.repo ?? '')) this.perigeeJobs.delete(k);
    this.perigeeLine = this.perigeeLine.filter((k) => this.perigeeJobs.has(k));
    for (const [run, g] of due) void this.send(g.sent, g.reasons).catch((e: unknown) => this.d.log(`Runner pool fallback: ${run}: ${e instanceof Error ? e.message : String(e)}`));
    this.perigeeTick();
  }

  /** A job of the run has had no machine for FALLBACK.afterMs and isn't gone to GitHub or running on perigee: its ship's line reads "waiting for a machine". */
  waiting(repo: string, run: number): boolean {
    return this.stuck(repo, (t) => t.run === run);
  }

  /** A ship job of the repo is waiting for a machine: the ship's line reads so (a repo ships one change at a time). */
  shipWaiting(repo: string): boolean {
    return this.stuck(repo, (t) => t.ship);
  }

  private stuck(repo: string, which: (t: Track) => boolean): boolean {
    const r = repo.toLowerCase();
    return [...this.track].some(([k, t]) => t.told && t.route !== 'github' && k !== this.perigeeRunning && t.repo === r && which(t));
  }

  private async cached<T>(key: string, get: () => Promise<T>): Promise<T> {
    const had = this.read.get(key);
    if (had && this.d.now() - had.at < FALLBACK.readMs) return had.value as T;
    const value = await get();
    this.read.set(key, { at: this.d.now(), value });
    return value;
  }

  /** Route one run's due jobs (all of one repo, run and kind of runner), and tell its Taskmaster once. */
  private async send(sent: Sent[], reasons: string[]) {
    const { job } = sent[0];
    const owner = job.repo.split('/')[0].toLowerCase();
    let route: Route;
    let why: string;
    let outcome = '';
    try {
      const pub = await this.cached(`pub:${job.repo.toLowerCase()}`, () => this.d.isPublic(job.repo));
      const minutes = !pub && job.needs.os === 'windows' && !job.needs.session ? await this.cached(`min:${owner}`, () => this.d.minutes(job.repo)) : null;
      ({ route, why } = routeOf(job.needs, pub, minutes));
      if (route === 'perigee' && !this.d.perigee) ({ route, why } = { route: 'wait', why: "its repo is private, and perigee's own runner isn't set up, so it waits for a machine" });
      // A machine took it while the reads above ran: its track was dropped, and nothing is sent on.
      if (sent.every((s) => this.track.get(s.key) !== s.t)) return;
      if (route === 'github') {
        const r = await this.d.github(job.repo, job.run);
        if (r.ok && minutes && !('error' in minutes)) this.read.delete(`min:${owner}`); // the next read counts this one
        outcome = r.ok ? `: ${r.why}` : `, but it couldn't be: ${r.why}`;
        if (!r.ok) route = 'wait';
      } else if (route === 'perigee') {
        for (const s of sent) {
          this.perigeeLine.push(s.key);
          this.perigeeJobs.set(s.key, s);
        }
        const ahead = this.perigeeLine.length - sent.length + (this.perigeeRunning ? 1 : 0);
        outcome = ahead ? `; ${ahead} ahead of it there` : '';
      }
    } catch (e) {
      ({ route, why } = { route: 'wait', why: `Citadel couldn't send it on (${e instanceof Error ? e.message : String(e)}), so it waits for a machine` });
    }
    for (const s of sent) Object.assign(s.t, { route, why });
    const mins = Math.round(FALLBACK.afterMs / 60_000);
    const names = sent.map((s) => `"${s.job.name}"`).join(', ');
    this.d.tell(job.repo, `CI: no machine could take ${job.repo}'s ${sent.length > 1 ? 'jobs' : 'job'} ${names} (run ${job.run}${job.ship ? ', a ship' : ''}) for ${mins} minutes. ${reasons.map((r) => `${r}.`).join(' ')} So ${why}${outcome}.`);
    this.d.log(`Runner pool fallback: ${job.repo}#${job.run} (${sent.length} job${sent.length > 1 ? 's' : ''}) → ${route}${outcome}`);
    this.perigeeTick();
  }

  private perigeeTick() {
    const p = this.d.perigee;
    if (!p || this.perigeeRunning) return;
    const next = perigeeNext(this.perigeeLine, 0, p.quiet());
    const s = next ? this.perigeeJobs.get(next) : undefined;
    if (!next || !s) return;
    this.perigeeLine.shift();
    this.perigeeJobs.delete(next);
    this.perigeeRunning = next;
    const end = () => {
      if (this.perigeeRunning === next) this.perigeeRunning = null;
    };
    s.tries = (s.tries ?? 0) + 1;
    // Its runner ended and the job still waits (the runner took a sibling job, stopped idle, or couldn't start): back to
    // the front of the line, once; the next look drops it if it ended. A second time, it waits for a machine and says so.
    const ended = () => {
      end();
      if (this.track.get(next) !== s.t) return;
      if (s.tries! >= FALLBACK.perigee.tries) return failed(`its runner ended ${s.tries} times with the job still waiting`);
      this.perigeeLine.unshift(next);
      this.perigeeJobs.set(next, s);
    };
    const failed = (why: string) => {
      end();
      // It stays waiting for a machine, and its Taskmaster hears that once more, with why.
      Object.assign(s.t, { route: 'wait', why });
      this.d.tell(s.job.repo, `CI: perigee couldn't start ${s.job.repo}'s job "${s.job.name}" (run ${s.job.run}): ${why}. It waits for a machine.`);
      this.d.log(`Runner pool fallback: perigee couldn't start ${next}: ${why}`);
    };
    p.start(s.job, s.labels).then(
      (r) => (r.ok ? r.done.then(ended, ended) : failed(r.why)),
      (e: unknown) => failed(e instanceof Error ? e.message : String(e)),
    );
  }
}
