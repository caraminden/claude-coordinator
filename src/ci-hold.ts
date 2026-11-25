// Deploys first on the CI desktop (#1902; Josh, 2026-11-24, approved: "Deploys first: while a ship is in line, nothing
// optional runs on the CI desktop"). Every HOLD_POLL_MS this reads Citadel's ship line and the runs on the PC's repos:
//  - Optional runs (flake proofs, citadel-heavy jobs, the suite started by hand on a branch) are stopped while a ship is
//    in line or testing, or main's full run is queued or running. A stop is a cancel on GitHub; Citadel starts the same
//    run again (its rerun, so from the start) once the line has been empty for a settle time.
//  - Main's full run waits for ships, MAIN_WAIT_MS at most, and goes before anything optional.
//  - A ship's own runs (land/, check/, a light check's heavy job) are never touched.
// Early next-train runs (early/) are optional too: tools/land.sh's early_next pushes none while the hold is on. Left out:
// desktop.yml (a release build), and other schemes' push-started builds, which the runner agents squeeze (src/ci-ships.ts).
// A job asks before it starts (POST /api/ci-hold; citadel-heavy reads hold.json). Fails open: a job that can't ask, or a
// GitHub this can't read, means optional work goes ahead; nothing here is asked by a ship. Off switch: <deploy state>/hold-off.
import { type GhGet, ghGet, ghPost, RateLimited } from './gh-api.ts';
import type { GithubEnv } from './scheme-repo.ts';
import type { Store } from './db.ts';
import { every, type Job } from './every.ts';
import { ZONE } from './pacific.ts';

export const HOLD_POLL_MS = 15_000;
/** How long the line must stay empty before optional work starts: by day ships follow each other in minutes. */
export const SETTLE_DAY_MS = 5 * 60_000;
export const SETTLE_NIGHT_MS = 60_000;
/** The night window, Pacific hours (Josh's starting values). At night a ship still stops optional work. */
export const NIGHT = { from: 23, until: 6 };
/** A run stopped again after it came back needs twice the quiet before it starts again, up to 8 times: in a busy day a long
 *  job would otherwise be started and stopped in every gap (38 times for one run, the replay of Nov 22 to 24). */
export const MAX_BACKOFF = 8;
export const MAIN_WAIT_MS = 30 * 60_000;
/** The most another scheme's job waits (a starting value). */
export const OTHERS_CAP_MS = 4 * 3600_000;
export const REPORT_MS = 24 * 3600_000;
const KEY = 'ci-hold';
const RECANCEL_MS = 60_000;
const RATE_LIMITED_MS = 5 * 60_000;
/** A ship's run counts this long: GitHub keeps some abandoned runs "queued" for good. */
const SHIP_RUN_MS = 60 * 60_000;
/** Reruns that failed in a row, RECANCEL_MS apart, before the job is given up and its minion (or Taskmaster) told: an hour. */
const MAX_MISSES = 60;
const STATUSES = ['queued', 'in_progress', 'pending'];

export type HoldKind = 'proof' | 'heavy' | 'suite' | 'main';
export interface HeldRun {
  repo: string;
  run: number;
  kind: HoldKind;
  /** The run's title on GitHub. */
  what: string;
  url: string;
  ticket: number | null;
  /** When it was first held: a job stopped again after it came back keeps it. */
  since: number;
  why: string;
  phase: 'stopping' | 'held' | 'resumed';
  /** When this phase began, or its cancel was last sent. */
  at: number;
  attempt: number;
  /** How often it was stopped. */
  stops?: number;
  misses?: number;
  reported?: boolean;
}
export interface HoldState {
  off: boolean;
  /** Why optional work may not start now, in plain words; null when it may. */
  why: string | null;
  /** The repos with runners on that PC; another repo's jobs are never held. */
  repos: string[];
  held: HeldRun[];
}
interface RunList {
  workflow_runs?: GhRun[];
  message?: string;
}
interface GhRun {
  id: number;
  path?: string;
  display_title?: string;
  html_url?: string;
  head_branch?: string | null;
  status?: string;
  conclusion?: string | null;
  run_attempt?: number;
  created_at?: string;
  run_started_at?: string;
}

export interface HoldDeps {
  /** Citadel's own repo, owner/name, lowercase; null when no scheme runs this server (then nothing is held). */
  own: () => string | null;
  /** Every repo with runners on that PC, lowercase: Citadel's jobs are all held, another's only its citadel-heavy jobs. */
  repos: () => string[];
  as: (repo: string) => GithubEnv | null;
  /** The ships in line now; a deploy run alone isn't one. */
  line: () => number;
  off: () => boolean | Promise<boolean>;
  /** The open minion a run is for, by its branch or (a citadel-heavy run) its job's id. */
  ticket: (repo: string, branch: string, heavyId: string | null) => number | null;
  closed: (ticket: number) => boolean;
  /** Whether a stopped citadel-heavy job may start again now: a long one only at night. */
  mayResume?: (heavyId: string) => boolean;
  /** Since when a citadel-heavy job Citadel dispatched was held before it had a run: its wait isn't counted from zero. */
  heldSince?: (heavyId: string) => number | undefined;
  tell: (ticket: number, text: string) => void;
  report: (repo: string, text: string) => void;
  store: { getSetting<T>(key: string): T | null; setSetting(key: string, value: unknown): void };
  /** Where citadel-heavy reads the hold, after every look. */
  publish?: (state: HoldState & { at: number }) => void | Promise<void>;
  get?: GhGet;
  post?: typeof ghPost;
  log?: (line: string) => void;
}

const HOUR = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' });
export function isNight(now: number): boolean {
  const h = Number(HOUR.format(now));
  return h >= NIGHT.from || h < NIGHT.until;
}

/** What a run is to the hold; null when the hold leaves it alone. */
export function kindOf(run: GhRun, own: boolean): HoldKind | 'ship' | null {
  const file = String(run.path ?? '')
    .split('@')[0]
    .split('/')
    .pop();
  // A ship's own light check (#1620) is named "heavy ship…" by heavy-ci.ts.
  if (file === 'citadel-heavy.yml') return /^heavy ship/.test(run.display_title ?? '') ? null : 'heavy';
  if (!own) return null;
  if (file === 'flake-proof.yml') return 'proof';
  if (file !== 'tests.yml') return null;
  const b = run.head_branch ?? '';
  if (/^(land|check)\//.test(b)) return 'ship';
  if (/^early\//.test(b)) return null;
  return b === 'main' ? 'main' : 'suite';
}

/** Runs of one group can't wait side by side on GitHub: a second waiting run cancels the first (the workflows' `concurrency`). */
const groupOf = (repo: string, kind: HoldKind, what: string) => (kind === 'heavy' ? null : kind === 'proof' ? `${repo} ${what}` : `${repo} suite`);
const heavyId = (kind: HoldKind, title: string) => (kind === 'heavy' ? (/^heavy (\S+)$/.exec(title)?.[1] ?? null) : null);
const NAMES: Record<HoldKind, string> = { proof: 'flake proof', heavy: 'heavy job', suite: 'test run', main: "main's full run" };

/** CI health's GitHub reads without the held runs: a run stopped for a ship starts again, so its cancel is nobody's red. */
export function withoutHeld(get: GhGet, isHeld: (run: number) => boolean): GhGet {
  return async (path, etag, as) => {
    const r = await get(path, etag, as);
    const body = r.body as RunList | null;
    const runs = body?.workflow_runs;
    if (!Array.isArray(runs) || !runs.some((run) => isHeld(run.id))) return r;
    return { ...r, body: { ...body, workflow_runs: runs.filter((run) => !isHeld(run.id)) } };
  };
}

/** The CI page's list: each held run with its minion and scheme, longest first, only what this person sees. */
export function heldRows(state: HoldState, store: Pick<Store, 'getTicket' | 'getProject'>, canSee: (project: number) => boolean) {
  const held = [...state.held]
    .sort((a, b) => a.since - b.since)
    .map((r) => {
      const t = r.ticket === null ? undefined : store.getTicket(r.ticket);
      return { ...r, number: t?.number, schemeId: t?.project_id, scheme: t && store.getProject(t.project_id)?.name };
    })
    .filter((r) => r.schemeId === undefined || canSee(r.schemeId));
  return { off: state.off, why: state.why, held };
}

export class CiHold {
  private d: HoldDeps;
  private held: Map<number, HeldRun>;
  private cache = new Map<string, { etag: string | null; body: RunList }>();
  private pausedUntil = 0;
  private busy = false;
  private offNow = false;
  private job: Job | null = null;
  private said = '';
  private publishing: Promise<unknown> = Promise.resolve();
  /** Ship and main runs at the last good look, and when that was. */
  private seen = { at: 0, ship: 0, main: false };
  /** Since when nothing has stood in optional work's way; null while something does. */
  private quietSince: number | null = null;

  constructor(d: HoldDeps) {
    this.d = d;
    this.held = new Map((d.store.getSetting<HeldRun[]>(KEY) ?? []).map((h) => [h.run, h]));
  }

  start() {
    this.job ??= every('ci hold', HOLD_POLL_MS, () => this.tick(), 0);
  }

  stop() {
    this.job?.stop();
    this.job = null;
  }

  /** A run this stopped and will start again: its cancelled end isn't news. */
  isHeld(run: number, now = Date.now()): boolean {
    const h = this.held.get(run);
    // GitHub still shows the old end for a moment after a re-run is taken.
    return !!h && (h.phase !== 'resumed' || now - h.at < 60_000);
  }

  state(now = Date.now()): HoldState {
    const off = this.offNow;
    return { off, why: off ? null : this.gate(now), repos: this.repos(), held: [...this.held.values()].filter((h) => this.isHeld(h.run, now)) };
  }

  /** Why optional work of this repo may not start now, or null; a repo with no runners on that PC is never held. */
  why(repo: string, since?: number, now = Date.now()): string | null {
    return this.repos().includes(repo.toLowerCase()) && !this.capped(repo.toLowerCase(), since, now) ? this.state(now).why : null;
  }

  private repos(): string[] {
    const own = this.d.own()?.toLowerCase();
    return own ? [...new Set([own, ...this.d.repos().map((r) => r.toLowerCase())])] : [];
  }

  /** Why a ship holds the desktop now, or null. An old look at GitHub doesn't count: the line alone does. */
  private shipWhy(now: number): string | null {
    const n = this.d.line();
    if (n) return n === 1 ? 'a ship is in line' : `${n} ships are in line`;
    return this.fresh(now) && this.seen.ship ? "a ship's tests are running" : null;
  }

  private fresh(now: number) {
    return now - this.seen.at < 2 * 60_000;
  }

  /** Why optional work must not be running now, or null. */
  private stopWhy(now: number): string | null {
    const ship = this.shipWhy(now);
    if (ship) return ship;
    const mainWaits = [...this.held.values()].some((h) => h.kind === 'main' && h.phase !== 'resumed' && now - h.since < SHIP_RUN_MS);
    return mainWaits || (this.fresh(now) && this.seen.main) ? "main's full test run goes first" : null;
  }

  /** Why optional work must not start now: as stopWhy, or the line only just emptied. */
  private gate(now: number, stops = 1): string | null {
    const why = this.stopWhy(now);
    if (why) {
      this.quietSince = null;
      return why;
    }
    this.quietSince ??= now;
    const settle = isNight(now) ? SETTLE_NIGHT_MS : SETTLE_DAY_MS;
    return now - this.quietSince >= settle * Math.min(MAX_BACKOFF, 2 ** Math.max(0, stops - 1)) ? null : 'the ship line only just emptied';
  }

  /** Another scheme's job held this long goes ahead whatever the line does: a hung line can't hold it for ever (Josh, 2026-11-24). */
  private capped(repo: string, since: number | undefined, now: number) {
    return since !== undefined && repo !== this.d.own()?.toLowerCase() && now - since >= OTHERS_CAP_MS;
  }

  private mainPast(h: HeldRun | undefined, now: number) {
    return !!h && now - h.since >= MAIN_WAIT_MS;
  }

  /** One look: stop what must not run, start again what may, tell who waits. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.offNow = await this.d.off();
      const own = this.d.own()?.toLowerCase();
      if (own && now >= this.pausedUntil) await this.look(own, now);
    } catch (err) {
      if (err instanceof RateLimited) this.pausedUntil = now + RATE_LIMITED_MS;
      this.say(`CI hold: ${err instanceof RateLimited ? 'GitHub says to slow down; looking again in 5 minutes' : String((err as Error)?.message ?? err)}`);
    } finally {
      this.busy = false;
      this.report(now);
      await this.publish(now);
    }
  }

  /** One write at a time, each of the state as it is then. */
  private publish(now: number) {
    this.publishing = this.publishing.then(() => this.d.publish?.({ at: now, ...this.state(now) })).catch((err) => this.say(`CI hold: ${err?.message ?? err}`));
    return this.publishing;
  }

  private async look(own: string, now: number) {
    const off = this.offNow;
    const active = new Map<number, { repo: string; run: GhRun; kind: HoldKind }>();
    const used = new Set<string>();
    let ship = 0;
    let main = false;
    for (const repo of this.repos()) {
      const as = this.d.as(repo);
      if (!as) continue;
      try {
        for (const status of STATUSES) {
          const list: GhRun[] = (await this.read(`repos/${repo}/actions/runs?status=${status}&per_page=100`, as, used))?.workflow_runs ?? [];
          for (const run of list) {
            const kind = Number.isInteger(run?.id) ? kindOf(run, repo === own) : null;
            const old = now - Date.parse(run.run_started_at ?? run.created_at ?? '') >= SHIP_RUN_MS;
            if (!kind || ((kind === 'ship' || kind === 'main') && old)) continue;
            if (kind === 'ship') ship++;
            else active.set(run.id, { repo, run, kind });
            if (kind === 'main') main = true;
          }
        }
      } catch (err) {
        // Another scheme's repo that can't be read holds up nothing of Citadel's.
        if (repo === own || err instanceof RateLimited) throw err;
        this.say(`CI hold: ${repo}: ${(err as Error).message}`);
      }
    }
    for (const path of this.cache.keys()) if (!used.has(path) && path.includes('?status=')) this.cache.delete(path);
    this.seen = { at: now, ship, main };

    if (!off) {
      const why = this.stopWhy(now);
      const shipWhy = this.shipWhy(now);
      for (const a of active.values()) {
        const h = this.held.get(a.run.id);
        if (h?.phase === 'stopping') continue;
        if (a.kind === 'main') {
          // A running main run is left alone (it asked before it started); a queued one waits its turn off the runner.
          if (shipWhy && a.run.status !== 'in_progress' && !this.mainPast(h, now)) await this.hold(a.repo, a.run, a.kind, shipWhy, now);
        } else if (why && !this.capped(a.repo, this.since(h, a.kind, a.run), now)) await this.hold(a.repo, a.run, a.kind, why, now);
      }
    }
    if (!off) this.gate(now); // keeps the quiet spell's start
    const groups = new Set<string | null>();
    for (const a of active.values()) groups.add(groupOf(a.repo, a.kind, a.run.display_title || NAMES[a.kind]));
    for (const h of this.held.values()) if (h.phase === 'resumed' && now - h.at <= RECANCEL_MS) groups.add(groupOf(h.repo, h.kind, h.what));
    let failed = false;
    // Main's run first: it and the suites share a group.
    for (const h of [...this.held.values()].sort((a, b) => Number(b.kind === 'main') - Number(a.kind === 'main'))) {
      try {
        await this.follow(h, active.has(h.run), off, now, groups);
      } catch (err) {
        failed = true; // one run's trouble keeps no other from coming back
        this.say(`CI hold: run ${h.run}: ${(err as Error)?.message ?? err}`);
      }
    }
    if (!failed) this.said = '';
  }

  /** One held run's next step. */
  private async follow(h: HeldRun, isActive: boolean, off: boolean, now: number, groups: Set<string | null>) {
    const as = this.d.as(h.repo);
    if (!as) return;
    const path = `repos/${h.repo}/actions/runs/${h.run}`;
    const post = (what: string) =>
      (this.d.post ?? ghPost)(`${path}/${what}`, as).catch((err) => {
        this.say(`CI hold: ${what} of run ${h.run}: ${err?.message ?? err}`);
        return { status: 0 };
      });
    if (h.phase === 'stopping') {
      if (isActive) {
        if (off || now - h.at < RECANCEL_MS) return;
        const force = (h.misses ?? 0) >= 2; // the third ask, about 3 minutes on
        h.misses = (h.misses ?? 0) + 1;
        h.at = now;
        this.save();
        await post(force ? 'force-cancel' : 'cancel');
        return;
      }
      const run = await this.one(path, as);
      if (!run) return this.drop(h); // deleted on GitHub
      if (run.status !== 'completed') return;
      // It ended by itself before the cancel reached it: its result stands.
      if (run.conclusion !== 'cancelled') return this.drop(h);
      Object.assign(h, { phase: 'held', at: now, attempt: run.run_attempt ?? h.attempt, misses: 0 });
      this.save();
    }
    if (h.phase === 'held') {
      if (isActive) return this.phase(h, 'resumed', now); // started again by hand
      const id = heavyId(h.kind, h.what);
      if (id) h.ticket ??= this.d.ticket(h.repo, '', id); // a job stopped in its turn is queued only after
      if (h.ticket !== null && this.d.closed(h.ticket)) return this.drop(h);
      const group = groupOf(h.repo, h.kind, h.what);
      const clear = h.kind === 'main' ? !this.shipWhy(now) || this.mainPast(h, now) : (!this.gate(now, h.stops) || this.capped(h.repo, h.since, now)) && (id === null || (this.d.mayResume?.(id) ?? true));
      if ((!off && !clear) || (group && groups.has(group)) || (h.misses && now - h.at < RECANCEL_MS)) return;
      const { status } = await post('rerun');
      if (status >= 200 && status < 300) {
        groups.add(group);
        return this.phase(h, 'resumed', now);
      }
      h.misses = (h.misses ?? 0) + 1;
      h.at = now;
      if (h.misses >= MAX_MISSES || status === 404) {
        const refused = `GitHub refused to start ${h.ticket === null ? 'a' : 'your'} ${NAMES[h.kind]} again (${h.what}, ${h.url}, HTTP ${status}) after ships held it.`;
        if (h.ticket !== null) this.d.tell(h.ticket, `${refused} Start it again yourself.`);
        else this.d.report(h.repo, `${refused} Nothing starts it again now.`);
        return this.drop(h);
      }
      this.save();
      return;
    }
    if (h.phase === 'resumed' && !isActive && now - h.at > RECANCEL_MS) {
      const run = await this.one(path, as);
      // Ended on its own after it came back, or GitHub never showed the new attempt, or it was deleted.
      if (!run) return this.drop(h);
      if (run.status === 'completed' && ((run.run_attempt ?? 0) > h.attempt || now - h.at > 10 * 60_000)) this.drop(h);
    }
  }

  private since(h: HeldRun | undefined, kind: HoldKind, run: GhRun): number | undefined {
    const id = heavyId(kind, run.display_title ?? '');
    return h?.since ?? (id ? this.d.heldSince?.(id) : undefined);
  }

  private phase(h: HeldRun, phase: HeldRun['phase'], now: number) {
    Object.assign(h, { phase, at: now, misses: 0 });
    this.save();
  }

  private drop(h: HeldRun) {
    this.held.delete(h.run);
    this.save();
  }

  /** Stop a run and keep it to start again: written down before the cancel, so a restart can't lose it. */
  private async hold(repo: string, run: GhRun, kind: HoldKind, why: string, now: number) {
    const had = this.held.get(run.id);
    const what = run.display_title || NAMES[kind];
    const h: HeldRun = {
      repo,
      run: run.id,
      kind,
      what,
      url: run.html_url ?? `https://github.com/${repo}/actions/runs/${run.id}`,
      ticket: had?.ticket ?? (kind === 'main' ? null : this.d.ticket(repo, run.head_branch ?? '', heavyId(kind, what))),
      since: this.since(had, kind, run) ?? now,
      why,
      phase: 'stopping',
      at: now,
      attempt: run.run_attempt ?? 1,
      stops: (had?.stops ?? 0) + 1,
      reported: had?.reported,
    };
    this.held.set(run.id, h);
    this.save();
    await this.publish(now); // before the cancel: citadel-heavy must never see the cancelled run without its hold
    if (!had && h.ticket !== null)
      this.d.tell(
        h.ticket,
        `Your ${NAMES[kind]} (${what}, ${h.url}) is waiting: ${why} on the CI desktop, and ships go first. Citadel starts it again by itself${kind === 'proof' ? ', its clean runs counted from zero,' : ' from the start'} once the line has been empty for 5 minutes (1 minute between 11 PM and 6 AM Pacific; longer each time it is stopped again). Nothing to do; don't start it again, and the cancelled run isn't a failure.`,
      );
    await (this.d.post ?? ghPost)(`repos/${repo}/actions/runs/${run.id}/cancel`, this.d.as(repo) ?? {}).catch((err) => this.say(`CI hold: cancel of run ${run.id}: ${err?.message ?? err}`));
  }

  /** A run asks, from its own runner, whether it may start. Anything that can't be told is a yes. */
  async ask(repo: string, runId: number, now = Date.now()): Promise<{ go: boolean; why: string | null }> {
    const own = this.d.own()?.toLowerCase();
    const as = this.d.as(repo.toLowerCase());
    const yes = { go: true, why: null };
    if (!own || !as || (this.offNow = await this.d.off())) return yes;
    const why = this.held.get(runId)?.phase === 'resumed' ? this.stopWhy(now) : this.gate(now);
    if (!why) return yes;
    let run: GhRun | null;
    try {
      run = await this.one(`repos/${repo}/actions/runs/${runId}`, as);
    } catch {
      return yes;
    }
    const kind = run ? kindOf(run, repo.toLowerCase() === own) : null;
    if (!run || !kind || kind === 'ship') return yes;
    const h = this.held.get(runId);
    if (h?.phase === 'stopping') return { go: false, why: h.why };
    const held = kind === 'main' ? (this.mainPast(h, now) ? null : this.shipWhy(now)) : this.capped(repo.toLowerCase(), this.since(h, kind, run), now) ? null : why;
    if (!held) return yes;
    await this.hold(repo.toLowerCase(), run, kind, held, now);
    return { go: false, why: held };
  }

  /** A job held over a day is told to its scheme's Taskmaster, once. */
  private report(now: number) {
    for (const h of this.held.values()) {
      if (h.reported || h.phase === 'resumed' || now - h.since < REPORT_MS) continue;
      h.reported = true;
      this.save();
      this.d.report(h.repo, `A ${NAMES[h.kind]} has been held off the CI desktop for over 24 hours (${h.what}, ${h.url}): ${h.why}. Ships go first, so it starts once the line is empty; it is never forced. The CI page lists what is held.`);
    }
  }

  private save() {
    this.d.store.setSetting(KEY, [...this.held.values()]);
  }

  /** A run as it is now, never from a cached list; null when it was deleted. */
  private async one(path: string, as: GithubEnv): Promise<GhRun | null> {
    const r = await (this.d.get ?? ghGet)(path, null, as);
    if (r.status === 200) return r.body as GhRun | null;
    if (r.status === 404) return null;
    throw new Error(`GitHub answered ${r.status} for ${path}`);
  }

  private async read(path: string, as: GithubEnv, used: Set<string>): Promise<RunList> {
    used.add(path);
    const had = this.cache.get(path);
    const r = await (this.d.get ?? ghGet)(path, had?.etag ?? null, as);
    if (r.status === 304 && had) return had.body;
    if (r.status === 200) {
      const body = r.body as RunList;
      this.cache.set(path, { etag: r.etag, body });
      return body;
    }
    if (r.status === 429 || (r.status === 403 && /rate limit/i.test(String((r.body as { message?: unknown } | null)?.message ?? '')))) throw new RateLimited();
    throw new Error(`GitHub answered ${r.status} for ${path}`);
  }

  /** A problem is logged once until a look goes through. */
  private say(line: string) {
    if (line === this.said) return;
    this.said = line;
    (this.d.log ?? console.error)(line);
  }
}
