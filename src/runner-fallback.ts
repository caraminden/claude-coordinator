// Where a pool job goes when no machine can take it (Build 11 P5, specs/one-runner-pool.md section 5).
//   - "No room" (machines on, full of jobs) never falls back: the job waits in line, room comes back. Only a job no
//     machine could take (runner-pool.ts place()'s `none`) for FALLBACK.afterMs moves on.
//   - Then, by Cara's Q3 pick (2026-11-27, #2264's card): "Public repos go to GitHub", "perigee can be a fallback for
//     private repos, just need to load balance and make sure we dont overload it", and for Peek's Windows jobs "maybe we
//     fall back to github minutes?". A public repo's job, and a private repo's Windows job while under 80% of the
//     account's included minutes, are cancelled and started again on the same commit with the workflow's `route` input set
//     to github. A private repo's Linux job goes to perigee, one at a time and only while its load is low. A job that
//     needs a signed-in session or a GPU waits.
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
export function machineReasons(job: Pick<PoolJob, 'scheme' | 'needs'>, machines: readonly Pick<PoolMachine, 'name' | 'os' | 'session' | 'schemes' | 'limit' | 'off'>[]): string[] {
  const lent = machines.filter((m) => m.schemes.includes(job.scheme));
  if (!lent.length) return ['no machine lends CI to its scheme'];
  const n = job.needs;
  return lent.map((m) => {
    if (n.os && !m.os.includes(n.os)) return `${m.name} doesn't run ${OS_WORD[n.os]}`;
    if (n.session && !m.session) return `${m.name} has nobody signed in`;
    if (m.off) return `${m.name} ${m.off}`;
    if (m.limit < n.size) return `${m.name} lets CI use ${m.limit} threads at most, and it needs ${n.size}`;
    return `${m.name} could take it`;
  });
}

/** Perigee takes the first job of its line only when none of its own runs and its load is low (one small slot, "dont overload it"). */
export function perigeeNext(line: readonly string[], running: number, quiet: boolean): string | null {
  return running === 0 && quiet ? (line[0] ?? null) : null;
}

/** A GitHub call with the repo's scheme owner's login. */
export type Gh = (method: 'GET' | 'POST', path: string, body?: object) => Promise<{ status: number; body: unknown }>;

type GhRun = { id?: unknown; path?: unknown; head_branch?: unknown; head_sha?: unknown; status?: unknown; event?: unknown };

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
    const l = await gh('GET', `repos/${repo}/actions/runs?head_sha=${b.head_sha}&event=workflow_dispatch&per_page=20`);
    const runs = ((l.body as { workflow_runs?: GhRun[] } | null)?.workflow_runs ?? []).filter((x) => typeof x.path === 'string' && x.path.replace(/@.*$/, '') === path && Number(x.id) > run);
    if (runs.length) {
      const c = await gh('POST', `repos/${repo}/actions/runs/${run}/cancel`);
      // The new run is the newest either way; one GitHub's concurrency group holds behind the old one starts once it ends.
      return { ok: true, why: c.status === 202 ? `started again on GitHub's runners as run ${Number(runs[0].id)}` : `started again on GitHub's runners as run ${Number(runs[0].id)}; cancelling the old run answered ${c.status}` };
    }
    await wait(FALLBACK.confirmPollMs);
  }
  return { ok: false, why: `GitHub took the restart of ${file} but no new run showed up in ${FALLBACK.confirmMs / 1000} s, so the old run is left as it is` };
}

/** How many included minutes GitHub bills a minute of each kind of runner as. */
const RATE = { UBUNTU: 1, WINDOWS: 2, MACOS: 10 } as const;
const rateOf = (labels: unknown): number => {
  const l = Array.isArray(labels) ? labels.join(' ').toLowerCase() : '';
  return l.includes('windows') ? RATE.WINDOWS : l.includes('macos') ? RATE.MACOS : RATE.UBUNTU;
};

/**
 * An account's Actions minutes used this month, by Citadel's own count with the repo scope its links have (the Overseer's
 * pick on P5's ask 17, 2026-11-28: no new login scope, against 3,000 included). The higher of two reads over the owner's
 * private repos Citadel knows (public repos' minutes are free): GitHub's billable time per workflow for the current billing
 * cycle, and this month's workflow_dispatch runs' jobs on GitHub's runners (the fallback's own restarts), each rounded up
 * to a whole minute as GitHub bills. Windows counts double. Any read that fails fails the count, so the guard holds.
 * shortcut: misses minutes spent in repos no scheme has and reads only the newest 100 dispatches a repo; GitHub's own
 * account figure needs the user scope, so read it here too once links ask for it.
 */
export async function actionsMinutes(ghOf: (repo: string) => Gh | null, repos: readonly string[], since: string): Promise<Minutes> {
  let billed = 0;
  let ours = 0;
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
      const flows = ((await got(`repos/${repo}/actions/workflows?per_page=100`)).workflows ?? []) as { id?: unknown }[];
      for (const f of flows) {
        const b = ((await got(`repos/${repo}/actions/workflows/${Number(f.id)}/timing`)).billable ?? {}) as Record<string, { total_ms?: unknown }>;
        for (const [os, rate] of Object.entries(RATE)) billed += ((Number(b[os]?.total_ms) || 0) / 60_000) * rate;
      }
      const runs = ((await got(`repos/${repo}/actions/runs?event=workflow_dispatch&status=completed&created=>=${since}&per_page=100`)).workflow_runs ?? []) as { id?: unknown }[];
      for (const run of runs) {
        const jobs = ((await got(`repos/${repo}/actions/runs/${Number(run.id)}/jobs?per_page=100`)).jobs ?? []) as { runner_group_name?: unknown; labels?: unknown; started_at?: unknown; completed_at?: unknown }[];
        for (const j of jobs) {
          const ms = Date.parse(String(j.completed_at)) - Date.parse(String(j.started_at));
          if (j.runner_group_name === 'GitHub Actions' && ms > 0) ours += Math.ceil(ms / 60_000) * rateOf(j.labels);
        }
      }
    } catch (e) {
      return { error: `couldn't count the Actions minutes ${repo} used: ${(e as Error).message}` };
    }
  }
  return { used: Math.max(billed, ours), included: FALLBACK.included };
}

export interface FallbackDeps {
  now(): number;
  /** The repo is public; null when GitHub couldn't say. Read at most once per FALLBACK.readMs. */
  isPublic(repo: string): Promise<boolean | null>;
  /** The repo owner's Actions minutes this month. Read at most once per FALLBACK.readMs. */
  minutes(repo: string): Promise<Minutes>;
  /** Cancel and start again on GitHub's runners (restartOnGithub with the repo's login). */
  github(repo: string, run: number): Promise<{ ok: boolean; why: string }>;
  /** Perigee's own runner for one job; left out, private Linux jobs wait. `quiet`: its load is low now. */
  perigee?: { quiet(): boolean; start(job: PoolJob): Promise<{ ok: boolean; why: string; done: Promise<unknown> }> };
  /** One message to the scheme's Taskmaster. */
  tell(repo: string, text: string): void;
  log(line: string): void;
}

/** A pool job as the fallback sees it: no machine could take it now (`none`), and why each couldn't. */
export interface FallbackLook {
  job: PoolJob;
  none: boolean;
  reasons: string[];
}

type Track = { repo: string; run: number; since: number; told: boolean; route: Route | null; why: string | null };

export class Fallbacks {
  private d: FallbackDeps;
  private track = new Map<string, Track>();
  private read = new Map<string, { at: number; value: unknown }>();
  /** Perigee's line of job keys, and the one it runs. */
  private perigeeLine: string[] = [];
  private perigeeJobs = new Map<string, PoolJob>();
  private perigeeRunning: string | null = null;

  constructor(d: FallbackDeps) {
    this.d = d;
  }

  /** Each pool look: the pool's own waiting jobs. A job a machine could take (room or not) starts its 10 minutes over. */
  look(jobs: readonly FallbackLook[]) {
    const now = this.d.now();
    const seen = new Set<string>();
    for (const { job, none, reasons } of jobs) {
      const key = `${job.repo}#${job.id}`;
      seen.add(key);
      let t = this.track.get(key);
      if (!none) {
        // Once sent on (to GitHub, perigee's line), it stays sent; only one never sent starts over.
        if (t && !t.route) this.track.delete(key);
        continue;
      }
      if (!t) this.track.set(key, (t = { repo: job.repo.toLowerCase(), run: job.run, since: now, told: false, route: null, why: null }));
      if (t.told || now - t.since < FALLBACK.afterMs) continue;
      t.told = true;
      void this.send(key, job, reasons, t).catch((e: unknown) => this.d.log(`Runner pool fallback: ${key}: ${e instanceof Error ? e.message : String(e)}`));
    }
    for (const k of [...this.track.keys()]) if (!seen.has(k)) this.track.delete(k);
    this.perigeeLine = this.perigeeLine.filter((k) => seen.has(k));
    this.perigeeTick();
  }

  /** A job of the run has had no machine for FALLBACK.afterMs and isn't gone to GitHub: its ship's line reads "waiting for a machine". */
  waiting(repo: string, run: number): boolean {
    const r = repo.toLowerCase();
    return [...this.track.values()].some((t) => t.told && t.route !== 'github' && t.repo === r && t.run === run);
  }

  private async cached<T>(key: string, get: () => Promise<T>): Promise<T> {
    const had = this.read.get(key);
    if (had && this.d.now() - had.at < FALLBACK.readMs) return had.value as T;
    const value = await get();
    this.read.set(key, { at: this.d.now(), value });
    return value;
  }

  private async send(key: string, job: PoolJob, reasons: string[], t: Track) {
    const pub = await this.cached(`pub:${job.repo}`, () => this.d.isPublic(job.repo));
    const owner = job.repo.split('/')[0];
    const minutes = !pub && job.needs.os === 'windows' && !job.needs.session ? await this.cached(`min:${owner}`, () => this.d.minutes(job.repo)) : null;
    let { route, why } = routeOf(job.needs, pub, minutes);
    if (route === 'perigee' && !this.d.perigee) ({ route, why } = { route: 'wait', why: "its repo is private, and perigee's own runner isn't set up, so it waits for a machine" });
    let outcome = '';
    if (route === 'github') {
      const r = await this.d.github(job.repo, job.run);
      if (r.ok && minutes && !('error' in minutes)) this.read.delete(`min:${owner}`); // the next read counts this one
      outcome = r.ok ? `: ${r.why}` : `, but it couldn't be: ${r.why}`;
      if (!r.ok) route = 'wait';
    } else if (route === 'perigee') {
      this.perigeeLine.push(key);
      this.perigeeJobs.set(key, job);
      const ahead = this.perigeeLine.length - 1 + (this.perigeeRunning ? 1 : 0);
      outcome = ahead ? `; ${ahead} ahead of it there` : '';
    }
    t.route = route;
    t.why = why;
    const mins = Math.round(FALLBACK.afterMs / 60_000);
    this.d.tell(job.repo, `CI: no machine could take ${job.repo}'s job "${job.name}" (run ${job.run}${job.ship ? ', a ship' : ''}) for ${mins} minutes. ${reasons.map((r) => `${r}.`).join(' ')} So ${why}${outcome}.`);
    this.d.log(`Runner pool fallback: ${key} → ${route}${outcome}`);
    this.perigeeTick();
  }

  private perigeeTick() {
    const p = this.d.perigee;
    if (!p) return;
    const next = perigeeNext(this.perigeeLine, this.perigeeRunning ? 1 : 0, this.perigeeRunning ? false : p.quiet());
    const job = next ? this.perigeeJobs.get(next) : undefined;
    if (!next || !job) return;
    this.perigeeLine.shift();
    this.perigeeJobs.delete(next);
    this.perigeeRunning = next;
    const end = () => {
      if (this.perigeeRunning === next) this.perigeeRunning = null;
    };
    p.start(job).then(
      (r) => {
        if (!r.ok) {
          this.d.log(`Runner pool fallback: perigee couldn't start ${next}: ${r.why}`);
          return end();
        }
        r.done.then(end, end);
      },
      (e: unknown) => {
        this.d.log(`Runner pool fallback: perigee couldn't start ${next}: ${e instanceof Error ? e.message : String(e)}`);
        end();
      },
    );
  }
}
