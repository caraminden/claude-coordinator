// Deploys first on the CI desktop (#1902; Josh, 2026-11-24, approved: "Deploys first: while a ship is in line, nothing
// optional runs on the CI desktop"). Every HOLD_POLL_MS this reads Citadel's ship line and the runs on the PC's repos:
//  - Optional runs (citadel-heavy jobs, the suite started by hand on a branch) are stopped while a ship is
//    in line or testing, or main's full run is queued or running. A stop is a cancel on GitHub; Citadel starts the same
//    run again (its rerun, so from the start) once the line has been empty for a settle time.
//  - Main's full run waits for a gap in the ships, MAIN_WAIT_MS at most (Josh, 2026-11-25, picked "Wait for a gap, max 4 h"), and goes before anything optional.
//  - A ship's run (land/) is never touched.
// One job at a time (#1906; Josh, 2026-11-24, picked "One Citadel job, one Peek build": "Citadel never runs two heavy jobs at
// once"): the runs of Citadel's own repo go one by one, in the order ship, main's full run, a ship's own check (check/, a
// light check's heavy job) or the early next train (early/), then optional work. A run takes the slot when it asks and is let
// in. A ship stops whatever holds it. A check or early run starts only when nothing else of Citadel's runs or is queued (a
// ship in line with no run doesn't count: that is when it is worth running), is never waited for, and comes back only while
// its branch is there (land.sh deletes it when its ship goes on). A job that ran SLOT_HOLD_MS
// keeps no other waiting, and none waits behind lower ones past SLOT_WAIT_MS.
// One flake proof beside ships (Josh, 2026-11-25, picked "Let them run, one at a time"): a proof starts and runs on whatever the
// ship line does, never two at once, the longest held first. A ship, its own check and the early next train never wait for one; main's run still stops one
// once it may start, and heavy jobs and suites still wait for it to end, but go before the next proof when they may start. No proof starts
// while a ship's red tests run again alone (one already running goes on).
// Left out: desktop.yml (a release build), other schemes' push-started builds, which the runner agents squeeze (src/ci-ships.ts).
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
export const MAIN_WAIT_MS = 4 * 3600_000;
/** A gap in the ships must last this long before main's stopped run starts again: in most the next ship is a minute off (the replay of Nov 22 to 25: 105 stops without it). A starting value. */
export const MAIN_SETTLE_MS = 2 * 60_000;
/** The most another scheme's job waits (a starting value). */
export const OTHERS_CAP_MS = 4 * 3600_000;
/** A starting value: a job that has run this long keeps no other waiting, so a hung one can't hold the line. */
export const SLOT_HOLD_MS = 4 * 3600_000;
/** A starting value: the most a job waits behind lower jobs of Citadel's, from the first time it did (ships still go first): a long queue can't hold it for ever. */
export const SLOT_WAIT_MS = 24 * 3600_000;
/** A run seen on a runner this long without having been let in (its workflow asks nothing) is stopped when another has the slot. */
const UNASKED_MS = 2 * 60_000;
/** A stopped check or early run that can't start again this long is let go: its ship went on without it. */
const CHECK_WAIT_MS = 30 * 60_000;
/** A run let in or started again holds the slot at least this long before a look may find it gone. */
const SLOT_GRACE_MS = 60_000;
/** A run started again that no runner takes gives the slot up. */
const QUEUED_MS = 10 * 60_000;
export const REPORT_MS = 24 * 3600_000;
const KEY = 'ci-hold';
const RECANCEL_MS = 60_000;
const RATE_LIMITED_MS = 5 * 60_000;
/** A ship's run counts this long: GitHub keeps some abandoned runs "queued" for good. */
const SHIP_RUN_MS = 60 * 60_000;
/** Reruns that failed in a row, RECANCEL_MS apart, before the job is given up and its minion (or Taskmaster) told: an hour. */
const MAX_MISSES = 60;
/** tests.yml's step that runs a ship's red test files again, alone (land.sh's CI_RERUN_STEP). */
const RETRY_STEP = 'rerun failed files alone';
const STATUSES = ['queued', 'in_progress', 'pending'];

export type HoldKind = 'proof' | 'heavy' | 'suite' | 'main' | 'check' | 'early';
/** Order among runs that aren't a ship's: main's, then a ship's checks, then optional work, proofs last: they have the ships' time too. */
const RANK: Record<HoldKind, number> = { main: 1, check: 2, early: 2, heavy: 3, suite: 3, proof: 4 };
const sideRun = (kind: HoldKind) => RANK[kind] === 2;
interface Slot {
  run: number;
  kind: HoldKind;
  what: string;
  at: number;
}
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
  /** A check's or early run's branch: the run comes back only while it is there. */
  branch?: string;
  /** Since when only another lower job (no ship) has been in its way. */
  behind?: number;
}
/** What runs on the desktop now, for the CI page. */
export interface RunningRow {
  kind: HoldKind | 'ship';
  what: string;
  url: string | null;
  ticket: number | null;
}
export interface HoldState {
  off: boolean;
  /** Why optional work may not start now, in plain words; null when it may. */
  why: string | null;
  /** The repos with runners on that PC; another repo's jobs are never held. */
  repos: string[];
  /** Citadel's own repo, lowercase; its jobs also wait for `busy`. */
  own: string | null;
  /** The lower Citadel job running now, in words; null when none is. */
  busy: string | null;
  running: RunningRow[];
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
  if (file === 'citadel-heavy.yml') return !/^heavy ship/.test(run.display_title ?? '') ? 'heavy' : own ? 'check' : null;
  if (!own) return null;
  if (file === 'flake-proof.yml') return 'proof';
  if (file !== 'tests.yml') return null;
  const b = run.head_branch ?? '';
  if (/^land\//.test(b)) return 'ship';
  if (/^check\//.test(b)) return 'check';
  if (/^early\//.test(b)) return 'early';
  return b === 'main' ? 'main' : 'suite';
}

/** Runs of one group can't wait side by side on GitHub: a second waiting run cancels the first (the workflows' `concurrency`). */
const groupOf = (repo: string, kind: HoldKind, what: string) => (kind === 'heavy' || kind === 'early' ? null : kind === 'check' ? `${repo} check` : kind === 'proof' ? `${repo} ${what}` : `${repo} suite`);
const heavyId = (kind: HoldKind, title: string) => (kind === 'heavy' ? (/^heavy (\S+)$/.exec(title)?.[1] ?? null) : null);
const NAMES: Record<HoldKind, string> = { proof: 'flake proof', heavy: 'heavy job', suite: 'test run', main: "main's full run", check: "ship's own check", early: "next ship's early tests" };

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
  const running = state.running.filter((r) => {
    const t = r.ticket === null ? undefined : store.getTicket(r.ticket);
    return !t || canSee(t.project_id);
  });
  return { off: state.off, why: state.why, busy: state.busy && running.length < state.running.length ? 'another Citadel job is running' : state.busy, running, held };
}

export class CiHold {
  private d: HoldDeps;
  private held: Map<number, HeldRun>;
  private cache = new Map<string, { etag: string | null; body: RunList }>();
  private pausedUntil = 0;
  private busy = false;
  private offNow = false;
  /** Since when no ship holds the desktop, as of the last look. */
  private shipFree: number | null = null;
  private job: Job | null = null;
  private said = '';
  private publishing: Promise<unknown> = Promise.resolve();
  /** Ship and main runs at the last good look, and when that was. */
  private seen = { at: 0, ship: 0, main: false };
  /** What was running at the last good look (the ships' runs by id), and the queued runs that aren't a check's or a proof's. */
  private running: RunningRow[] = [];
  private ships: number[] = [];
  private queued = new Set<number>();
  /** The lower Citadel job that may run now, and when it was let in. */
  private slot: Slot | null = null;
  /** The one flake proof that may run now. */
  private proof: Slot | null = null;
  private looked = false;
  /** When each run was first seen on a runner. */
  private running0 = new Map<number, number>();
  /** Runs told to go, and when: those stay, whatever is found beside them later. */
  private letIn = new Map<number, number>();
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
    return { off, why: off ? null : this.gate(now), repos: this.repos(), own: this.d.own()?.toLowerCase() ?? null, busy: off ? null : this.taken('heavy', null, now), running: this.fresh(now) ? this.running : [], held: [...this.held.values()].filter((h) => this.isHeld(h.run, now)) };
  }

  /** Why optional work of this repo may not start now, or null; a repo with no runners on that PC is never held. */
  why(repo: string, since?: number, now = Date.now()): string | null {
    const r = repo.toLowerCase();
    if (!this.repos().includes(r) || this.capped(r, since, now)) return null;
    const { why, busy } = this.state(now);
    return why ?? (r === this.d.own()?.toLowerCase() && !(since !== undefined && now - since >= SLOT_WAIT_MS) ? busy : null);
  }

  private repos(): string[] {
    const own = this.d.own()?.toLowerCase();
    return own ? [...new Set([own, ...this.d.repos().map((r) => r.toLowerCase())])] : [];
  }

  /** Why a ship holds the desktop now, for what else gives way to one (src/runner-cap.ts); null with the hold off. */
  shipNow(now = Date.now()): string | null {
    return this.offNow ? null : this.shipWhy(now);
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
    return this.mainWhy(now);
  }

  private mainWhy(now: number): string | null {
    const mainWaits = [...this.held.values()].some((h) => h.kind === 'main' && h.phase !== 'resumed' && now - h.since < MAIN_WAIT_MS + SHIP_RUN_MS);
    return mainWaits || (this.fresh(now) && this.seen.main) ? "main's full test run goes first" : null;
  }

  /** The lower Citadel job in this run's way, in words, or null. An old look at GitHub doesn't count: it goes ahead. */
  private taken(kind: HoldKind, run: number | null, now: number): string | null {
    const there = (s: Slot | null) => (s && s.run !== run && this.fresh(now) && now - s.at < SLOT_HOLD_MS ? s : null);
    const proof = sideRun(kind) ? null : there(this.proof);
    if (proof && kind === 'proof') return `another flake proof is running (${proof.what}), and they run one at a time on the CI desktop`;
    const s = there(this.slot) ?? proof;
    return s ? `a ${NAMES[s.kind]} is running (${s.what}), and Citadel runs one job at a time on the CI desktop`.replace(/^a (main's|next)/, '$1') : null;
  }

  private has(run: number) {
    return this.slot?.run === run || this.proof?.run === run;
  }

  private give(s: Slot) {
    if (s.kind === 'proof') this.proof = s;
    else this.slot = s;
  }

  /** Why no proof starts just now: a ship's red tests run again alone, with nothing optional beside them. GitHub not read: it starts. */
  private async retryWhy(as: GithubEnv): Promise<string | null> {
    for (const id of this.ships) {
      const r = await (this.d.get ?? ghGet)(`repos/${this.d.own()}/actions/runs/${id}/jobs?per_page=10`, null, as).catch(() => null);
      const jobs = (r?.status === 200 ? (r.body as { jobs?: { steps?: { name?: string; status?: string }[] }[] } | null)?.jobs : null) ?? [];
      if (jobs.some((j) => j.steps?.some((s) => s.name === RETRY_STEP && s.status === 'in_progress'))) return "a ship's failed tests are running again alone";
    }
    return null;
  }

  /** On a runner a while without having been let in; one that ran past SLOT_HOLD_MS is left to end. */
  private unasked(run: number, now: number) {
    const on = now - (this.running0.get(run) ?? now);
    return on >= UNASKED_MS && on < SLOT_HOLD_MS && !this.letIn.has(run);
  }

  private slotPast(h: HeldRun | undefined, now: number) {
    return h?.behind !== undefined && h.kind !== 'proof' && now - h.behind >= SLOT_WAIT_MS; // never two proofs
  }

  /** Why this run must not be running now for a ship's or main's sake, or null. `start`: optional work also waits the settle time. */
  private shipsFirst(kind: HoldKind, h: HeldRun | undefined, start: boolean, now: number): string | null {
    if (kind === 'main') {
      if (this.mainPast(h, now)) return null;
      return this.shipWhy(now) ?? (start && h && !this.gap(now) ? 'the ship line only just emptied' : null);
    }
    // No ship stops a proof; main's run does, as it stops any lower job, once it may go itself.
    if (kind === 'proof') return this.mainMay(now) && (start || this.seen.main || this.gap(now) || this.mainDue(now)) ? this.mainWhy(now) : null;
    if (!sideRun(kind)) return start ? this.gate(now, h?.stops) : this.stopWhy(now);
    if (!this.fresh(now)) return null;
    // While main's run waits for ships it keeps no ship's own check or early run from starting (hours, at most).
    return this.seen.ship ? "a ship's tests are running" : start && this.mainMay(now) ? this.mainWhy(now) : null;
  }

  /** Whether a main run that waits may go itself: no ship, or one held its full time. */
  private mainMay(now: number) {
    return !this.shipWhy(now) || this.mainDue(now);
  }

  private mainDue(now: number) {
    return [...this.held.values()].some((m) => m.kind === 'main' && this.mainPast(m, now));
  }

  /** Whether no ship has held the desktop for MAIN_SETTLE_MS: a shorter gap starts no stopped main run, so it stops no proof for one. */
  private gap(now: number) {
    return this.shipFree !== null && now - this.shipFree >= MAIN_SETTLE_MS;
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
    const running: RunningRow[] = [];
    const ships: number[] = [];
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
            if (repo === own && run.status === 'in_progress')
              running.push({ kind, what: kind === 'ship' ? "a ship's tests" : run.display_title || NAMES[kind], url: run.html_url ?? null, ticket: kind === 'proof' || kind === 'heavy' ? this.d.ticket(repo, run.head_branch ?? '', heavyId(kind, run.display_title ?? '')) : null });
            if (kind === 'ship') {
              ship++;
              if (run.status === 'in_progress') ships.push(run.id);
            } else active.set(run.id, { repo, run, kind });
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
    const unseen = !this.fresh(now); // looks failed: a ship may have come and gone
    this.seen = { at: now, ship, main };
    this.shipFree = this.shipWhy(now) ? null : unseen ? now : (this.shipFree ?? now);
    this.running = running;
    this.ships = ships;
    this.takeSlot(own, [...active.values()], now);

    if (!off) {
      const why = this.stopWhy(now);
      for (const a of active.values()) {
        const h = this.held.get(a.run.id);
        if (h?.phase === 'stopping') continue;
        const runs = a.run.status === 'in_progress';
        if (a.repo === own) {
          // A queued check or early run takes no runner's time: it asks when it starts. Main's running one yields to a ship (#1906).
          const first = a.kind !== 'main' && a.kind !== 'proof' && !sideRun(a.kind) ? why : runs || a.kind === 'proof' || a.kind === 'main' ? this.shipsFirst(a.kind, h, false, now) : null;
          if (first) await this.hold(a.repo, a.run, a.kind, first, now);
          else if (runs && !this.has(a.run.id) && this.unasked(a.run.id, now) && !this.slotPast(h, now)) {
            const taken = this.taken(a.kind, a.run.id, now);
            if (taken) await this.hold(a.repo, a.run, a.kind, taken, now, true);
          }
        } else if (why && !this.capped(a.repo, this.since(h, a.kind, a.run), now)) await this.hold(a.repo, a.run, a.kind, why, now);
      }
    }
    if (!off) this.gate(now); // keeps the quiet spell's start
    const groups = new Set<string | null>();
    for (const a of active.values()) groups.add(groupOf(a.repo, a.kind, a.run.display_title || NAMES[a.kind]));
    for (const h of this.held.values()) if (h.phase === 'resumed' && now - h.at <= RECANCEL_MS) groups.add(groupOf(h.repo, h.kind, h.what));
    let failed = false;
    // In order: main's run first (it and the suites share a group), then a ship's checks, then the longest held.
    for (const h of [...this.held.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.since - b.since)) {
      try {
        await this.follow(h, active.has(h.run), off, now, groups);
      } catch (err) {
        failed = true; // one run's trouble keeps no other from coming back
        this.say(`CI hold: run ${h.run}: ${(err as Error)?.message ?? err}`);
      }
    }
    if (!failed) this.said = '';
  }

  /** Who has the slot: the run let in while it is there, else the first one found on a runner (one that asked nothing, or a restart). */
  private takeSlot(own: string, active: { repo: string; run: GhRun; kind: HoldKind }[], now: number) {
    const mine = active.filter((a) => a.repo === own);
    const on = mine.filter((a) => a.run.status === 'in_progress' && !this.stopped(a.run.id));
    // On the first look after a restart GitHub says since when; later a run was first seen now (its start counts its queue).
    for (const a of on) if (!this.running0.has(a.run.id)) this.running0.set(a.run.id, this.looked ? now : Date.parse(a.run.run_started_at ?? '') || now);
    // What runs at a restart was let in by the old server, or started before this rule: it ends by itself.
    if (!this.looked) for (const a of on) this.letIn.set(a.run.id, now);
    this.looked = true;
    for (const [id, at] of this.letIn) if (now - at > 2 * SLOT_HOLD_MS) this.letIn.delete(id);
    for (const id of this.running0.keys()) if (!on.some((a) => a.run.id === id)) this.running0.delete(id);
    this.queued = new Set(
      mine
        .filter((a) => a.run.status !== 'in_progress' && !sideRun(a.kind) && a.kind !== 'proof' && !this.stopped(a.run.id) && now - Date.parse(a.run.run_started_at ?? '') < SHIP_RUN_MS) /* longer, GitHub left it there (ci_busy, land.sh) */
        .map((a) => a.run.id),
    );
    for (const s of [this.slot, this.proof]) {
      if (!s) continue;
      const age = now - s.at;
      const run = mine.find((a) => a.run.id === s.run);
      // A proof keeps its turn while it waits for a runner: no other proof could go ahead of it.
      const there = run && (run.run.status === 'in_progress' || s.kind === 'proof' || age < QUEUED_MS);
      if (there || age < SLOT_GRACE_MS) continue;
      if (s === this.proof) this.proof = null;
      else this.slot = null;
    }
    const found = on.filter((x) => now - this.running0.get(x.run.id)! < SLOT_HOLD_MS).sort((x, y) => RANK[x.kind] - RANK[y.kind] || x.run.id - y.run.id);
    const take = (a: (typeof mine)[number] | undefined) => a && this.give({ run: a.run.id, kind: a.kind, what: a.run.display_title || NAMES[a.kind], at: this.running0.get(a.run.id) ?? now });
    if (!this.slot) take(found.find((x) => x.kind !== 'proof'));
    // After a restart: the one running, else the one started again that still waits for a runner.
    if (!this.proof) take(found.find((x) => x.kind === 'proof') ?? mine.find((x) => x.kind === 'proof' && x.run.status !== 'in_progress' && this.held.get(x.run.id)?.phase === 'resumed'));
  }

  private stopped(run: number) {
    const h = this.held.get(run);
    return !!h && h.phase !== 'resumed';
  }

  /** A held run that would start now were it looked at, before the one that asks. */
  private nextUp(kind: HoldKind, now: number): HeldRun | undefined {
    const own = this.d.own()?.toLowerCase();
    return [...this.held.values()].find((h) => h.phase === 'held' && h.repo === own && RANK[h.kind] <= RANK[kind] && !sideRun(h.kind) && !h.misses && !this.shipsFirst(h.kind, h, true, now) && (heavyId(h.kind, h.what) === null || (this.d.mayResume?.(heavyId(h.kind, h.what)!) ?? true)));
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
      const own = this.d.own()?.toLowerCase() === h.repo;
      if (sideRun(h.kind)) {
        // Its ship went on (or it is a light check, whose ship never waits): nobody would read it.
        const there = h.branch && now - h.since < CHECK_WAIT_MS ? (await (this.d.get ?? ghGet)(`repos/${h.repo}/git/ref/heads/${h.branch}`, null, as)).status : 404;
        if (there === 404) return this.drop(h);
      }
      if (own && !off) {
        const ship = this.shipsFirst(h.kind, h, true, now);
        const taken = ship ? null : (this.taken(h.kind, h.run, now) ?? (h.kind === 'proof' ? await this.retryWhy(as) : null));
        if (taken && (h.why !== taken || h.behind === undefined)) {
          Object.assign(h, { why: taken, behind: h.behind ?? now });
          this.save();
        }
        if (ship && h.kind === 'proof' && h.why !== ship) {
          h.why = ship;
          this.save();
        }
        if (taken && !this.slotPast(h, now)) return;
        if (sideRun(h.kind) && this.queued.size) return;
      }
      const clear = sideRun(h.kind) || h.kind === 'proof' || h.kind === 'main' ? !this.shipsFirst(h.kind, h, true, now) : (!this.gate(now, h.stops) || this.capped(h.repo, h.since, now)) && (id === null || (this.d.mayResume?.(id) ?? true));
      if ((!off && !clear) || (group && groups.has(group)) || (h.misses && now - h.at < RECANCEL_MS)) return;
      const { status } = await post('rerun');
      if (status >= 200 && status < 300) {
        groups.add(group);
        if (own && !this.slotPast(h, now)) this.give({ run: h.run, kind: h.kind, what: h.what, at: now });
        return this.phase(h, 'resumed', now);
      }
      h.misses = (h.misses ?? 0) + 1;
      h.at = now;
      if (h.misses >= MAX_MISSES || status === 404) {
        const refused = `GitHub refused to start ${h.ticket === null ? 'a' : 'your'} ${NAMES[h.kind]} again (${h.what}, ${h.url}, HTTP ${status}) after Citadel held it.`;
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
  private async hold(repo: string, run: GhRun, kind: HoldKind, why: string, now: number, taken = false) {
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
      stops: (had?.stops ?? 0) + (taken ? 0 : 1),
      reported: had?.reported,
      ...(/^(check|early)\//.test(run.head_branch ?? '') ? { branch: run.head_branch as string } : {}),
      ...(taken ? { behind: had?.behind ?? now } : {}),
    };
    this.held.set(run.id, h);
    if (this.slot?.run === run.id) this.slot = null; // its cancel takes seconds
    if (this.proof?.run === run.id) this.proof = null;
    this.letIn.delete(run.id);
    this.save();
    await this.publish(now); // before the cancel: citadel-heavy must never see the cancelled run without its hold
    if (!had && h.ticket !== null && !sideRun(kind))
      this.d.tell(
        h.ticket,
        taken || kind === 'proof'
          ? `Your ${NAMES[kind]} (${what}, ${h.url}) is waiting: ${why}. Citadel starts it again by itself${kind === 'proof' ? ', its clean runs counted from zero,' : ' from the start'} once that has ended. Nothing to do; don't start it again, and the cancelled run isn't a failure.`
          : `Your ${NAMES[kind]} (${what}, ${h.url}) is waiting: ${why} on the CI desktop, and ships go first. Citadel starts it again by itself from the start once the line has been empty for 5 minutes (1 minute between 11 PM and 6 AM Pacific; longer each time it is stopped again). Nothing to do; don't start it again, and the cancelled run isn't a failure.`,
      );
    await (this.d.post ?? ghPost)(`repos/${repo}/actions/runs/${run.id}/cancel`, this.d.as(repo) ?? {}).catch((err) => this.say(`CI hold: cancel of run ${run.id}: ${err?.message ?? err}`));
  }

  /** A run asks, from its own runner, whether it may start. Anything that can't be told is a yes. */
  async ask(repo: string, runId: number, now = Date.now()): Promise<{ go: boolean; why: string | null }> {
    const own = this.d.own()?.toLowerCase();
    const as = this.d.as(repo.toLowerCase());
    const yes = { go: true, why: null };
    if (!own || !as || (this.offNow = await this.d.off())) return yes;
    let run: GhRun | null;
    try {
      run = await this.one(`repos/${repo}/actions/runs/${runId}`, as);
    } catch {
      this.letIn.set(runId, now);
      return yes;
    }
    const kind = run ? kindOf(run, repo.toLowerCase() === own) : null;
    if (!run || !kind || kind === 'ship') return yes;
    const h = this.held.get(runId);
    if (h?.phase === 'stopping') return { go: false, why: h.why };
    const mine = repo.toLowerCase() === own;
    // Another scheme's job asks about ships alone; one that came back asks again without the settle time.
    const first = mine ? this.shipsFirst(kind, h, h?.phase !== 'resumed', now) : this.capped(repo.toLowerCase(), this.since(h, kind, run), now) ? null : h?.phase === 'resumed' ? this.stopWhy(now) : this.gate(now);
    const retry = mine && kind === 'proof' && !first ? await this.retryWhy(as) : null;
    const taken = first || !mine || this.slotPast(h, now) ? null : (this.slotWhy(kind, runId, now) ?? retry);
    if (!first && !taken) {
      // A proof counts from its start, not from its wait for a runner.
      if (mine && (kind === 'proof' || !this.has(runId)) && !this.taken(kind, runId, now)) this.give({ run: runId, kind, what: run.display_title || NAMES[kind], at: now });
      this.letIn.set(runId, now);
      return yes;
    }
    const why = (first ?? taken)!;
    await this.hold(repo.toLowerCase(), run, kind, why, now, !first);
    return { go: false, why };
  }

  /** Why a run that asks may not start though no ship is in its way, or null. */
  private slotWhy(kind: HoldKind, run: number, now: number): string | null {
    const taken = this.taken(kind, run, now);
    if (taken || this.has(run)) return taken;
    const up = this.nextUp(kind, now);
    if (up && up.run !== run) return `a ${NAMES[up.kind]} waited longer and goes first`;
    return sideRun(kind) && this.fresh(now) && [...this.queued].some((id) => id !== run) ? 'another Citadel job is queued, and a check starts only on an idle CI desktop' : null;
  }

  /** A job held over a day is told to its scheme's Taskmaster, once. */
  private report(now: number) {
    for (const h of this.held.values()) {
      if (h.reported || h.phase === 'resumed' || now - h.since < REPORT_MS) continue;
      h.reported = true;
      this.save();
      this.d.report(
        h.repo,
        `A ${NAMES[h.kind]} has been held off the CI desktop for over 24 hours (${h.what}, ${h.url}): ${h.why}. ${h.kind === 'proof' ? 'Flake proofs run one at a time, the longest held first; it' : 'Ships go first, so it starts once the line is empty; it'} is never forced. The CI page lists what is held.`,
      );
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
