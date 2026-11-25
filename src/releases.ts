// Releases (#625, specs/release-monitor.md): per scheme, each target it ships to people (a Target), the release
// people have now, the next one on its way and how far along it is, the land line, test copies and the last few
// releases. One shape for every kind of target, filled by one small reader per kind; only Citadel's own server
// has a reader so far (CitadelServer below). Test copies (previews, builds' previews) belong to a target when
// they run its code, else to the scheme, so a scheme with no target still lists them.
// Served at GET /api/releases and sent as a `releases` event per scheme when its part changes. Importing it
// starts nothing: server.ts calls poll() and live().
import { placedKey, readState, shipLineKey, type Placed } from './ship-line-state.ts';
import type { DeployInfo } from './auto-deploy.ts';
import type { RollbackInfo } from './rollback.ts';
import type { Ship } from './branch.ts';
import type { NewsItem } from './land-news.ts';
import type { FailureDetail, FailureNext, LastTry } from './ship-failures.ts';
import type { Project, ReleaseRow, Store } from './db.ts';
import type { Frozen } from './frozen-ships.ts';
import { fixLineIn } from './fix-proof.ts';
import { gitOut } from './git.ts';
import { buildPreviewPath, previewKey, previewPath } from './previews.ts';
import { behindOld, landPhase, ordinal, ridingOf, TRACK, type EarlyTest, type LandTicket, type Wait } from './waits.ts';

export interface Target {
  /** Unique within its scheme: "citadel-server". */
  id: string;
  projectId: number;
  /** Short, as it sits under its scheme's row: "Server". */
  name: string;
  kind: string;
  link: string | null;
  /** Its own release names (#764, citadel-app.json `release`): `name` a template ("Build {n}"), `number` where n comes
   * from: `run` its CI run's number, `count` its releases that went live (the default; an APK's is its versionCode). */
  numbering?: { name?: string; number?: 'run' | 'count' };
}

export interface Release {
  /** A commit (sha) or a version name, shown as a secondary detail. */
  version: string;
  /** What people call it ("Release 14"): its place in its target's releases that went live, counting from 1, or the
   * number the target's own tooling gives it (a CI run's, an APK's versionCode); null for a try that didn't go live. */
  number: number | null;
  /** The release itself: the live site, the file to download; null when there's nothing to open (never a commit). */
  link: string | null;
  /** Its name from its target's own numbering ("Build 997", Target.numbering); absent: "Release <number>". */
  name?: string;
  /** fix (#1398): the line of a change that shipped as a fix without a go, put on at read time. */
  changes: { ticketId: number; number: number | null; title: string; fix?: string }[];
  /** When its first change started on its way (ms), and when it went live; null when not known. */
  started: number | null;
  live: number | null;
  outcome: string;
  /** Each stage's length, s. */
  stages: Record<string, number>;
  /** The commit it was built from when `version` is a version name (a CI-signed APK's): what a roll back compares. */
  commit?: string;
  /** A failed ship try's saved detail and what happened next (src/ship-failures.ts, #1375); absent on old rows. */
  failure?: FailureDetail & { next: FailureNext };
}

/** Where a change, or a whole next release, is: its stage, since when, its usual length, and what it waits on. */
export interface Progress {
  stage: string;
  since: number;
  /** The stage's usual length, s; null when not known or while it waits. */
  usual: number | null;
  /** What it waits on outside the pipeline ("2nd in line, behind #620"): no estimate then. */
  waitingOn: string | null;
  text: string;
  /** The short words for a list that already shows the order (Josh, 2026-11-13: "the line should be apparent from the list
   *  you are looking at"): a line place ("2nd"), or a landing's short detail ("CI: the full suite", waits.ts, #630). */
  brief?: string;
  /** The stage's name when finer than the track's: "Boot check", "CI · started early" (waits.ts landPhase, #1566). */
  label?: string;
  done?: number;
  total?: number;
  /** A waiting ship's early test (#1905): running, passed, failed or dropped, with its words. */
  early?: EarlyTest;
  /** Its ship train (Citadel's land line): the front with its riders, a rider, or a waiter's train ("Releasing next"). */
  train?: { role: 'front' | 'rider' | 'waiting'; label: string; size?: number; front?: string; members?: string[] };
}

export interface Change extends Progress {
  ticketId: number;
  number: number | null;
  title: string;
  /** Citadel's own changes: its minion is open with a worktree, so a person can start its preview from the list (#638). */
  canPreview?: boolean;
  /** Not in the release under way (#764): it landed after that build started, so it goes out in the one after. */
  later?: boolean;
  /** Nothing is running or scheduled for it (an APK change waiting on a version bump): a minion row doesn't call it deploying. */
  idle?: boolean;
  /** Back in line after a failed ship try: that try (#1375). */
  lastTry?: LastTry;
  /** It shipped as a fix without a go (#1398): the line its shipped line had. */
  fix?: string;
}

export interface Next extends Progress {
  /** The number it will have once live, when known. */
  number: number | null;
  /** Its name from its target's own numbering ("Build 997", "Next build" before its number is known); absent: "Release <number>". */
  name?: string;
  /** Something to try it on before it's live (a preview, a signed build), or null. */
  link: string | null;
  /** The kind's stages in order, each with its usual length in s (null: not known, or a wait): the bar's segments. */
  stages: { name: string; usual: number | null }[];
  /** When the whole release should be live (ms), only when the current stage and every one after it have a usual time and none waits. */
  eta: number | null;
  /** What happened so far in the ship under way (Citadel's own: its land.sh lines, #1368), oldest first. */
  news?: NewsItem[];
  /** The changes on their way, the furthest along first; the release's own stage is the first's. */
  changes: Change[];
}

/** Why a waiting landing can't be moved (#1002, #1007): its branch's land script predates reordering. */
export const OLD_LAND = "Can't move: it started from a branch whose land script is older than reordering, so it ships in its turn";
/** Why a Regenerate ship can't be moved (#1827): it goes first among the waiters until it ships, behind only ships people placed. */
export const HOLDS_LINE = 'It declares files its ship makes again (Regenerate), so it holds the line: it goes first among the waiters, behind only ships a person placed';
/** Why one behind such a landing can't move (#1020): nobody who arrived after that one goes ahead of it. */
export const BEHIND_OLD = "Can't move yet: a change ahead of it started from a branch whose land script is older than reordering, and nobody behind that one can pass it";

export interface LineEntry {
  /** "#620", or the label of a run that isn't a minion's ("tools/deploy.sh"). */
  name: string;
  ticketId: number | null;
  /** Holding the lock (true) or waiting for it. */
  holds: boolean;
  /** Its stage's own name while it holds the lock ("Boot check", #1566). */
  label?: string;
  /** Its place as the line's waits say it: "next", "2nd". */
  place: string;
  /** Its ticket in the line (tools/deploy-queue.sh): what the Releases page sends to reorder the waiters (#1002). */
  seq: number;
  /** Waiting, and its landing follows the order set on the Releases page (one from an older branch doesn't). */
  movable: boolean;
  /** Why a waiting one can't move (#1007), shown on its row. */
  why?: string;
  /** Who last placed it (#1358): a person's drag (pinned: a Taskmaster won't move it) or a Taskmaster's move with its reason. */
  placed?: Placed;
  stage: string;
  since: number;
  /** Back in line after a failed ship try: that try (#1375). */
  lastTry?: LastTry;
  /** Its process sits in a frozen cgroup (#1881): since when Citadel saw it, the unit and the command that thaws it. */
  frozen?: Frozen;
}

export interface TestCopy {
  /** preview, build-preview: Citadel's; download: a build a minion left in its files; site: a preview site on a port; debug-apk: CI's newest debug APK. */
  kind: 'preview' | 'build-preview' | 'download' | 'site' | 'debug-apk';
  /** The target whose code it runs, or null for the scheme's own list. */
  target: string | null;
  name: string;
  /** preview, build-preview: relative to the app's root, as previewPath gives it. */
  path?: string;
  /** download: the file, absolute, in its minion's files folder (opened as the minion's file). */
  file?: string;
  /** site: its port on this host. */
  port?: number;
  /** debug-apk: its run's page, with the APK among its artifacts. */
  link?: string;
  /** download, debug-apk: when it was made (ms). */
  at?: number;
  ticketId?: number;
  /** download: its minion's number. */
  number?: number;
  build?: number;
  running: boolean;
  /** The commit it runs, while it runs. */
  commit: string | null;
}

export interface TargetView {
  target: Target;
  current: Release | null;
  next: Next | null;
  line: LineEntry[];
  testCopies: TestCopy[];
  /** The releases before the current one, newest first. */
  recent: Release[];
  /** Its deploy button and auto-deploy (src/auto-deploy.ts, #629); absent when its kind has no release step Citadel starts. */
  deploy?: DeployInfo;
  /** A Capacitor app with no release key yet (#837): its contraption's name, for the card's Make release key button. */
  releaseKey?: string;
  /** Its Roll back to last green button and pin (src/rollback.ts, #1016); absent when its kind can't or there's no last green. */
  rollback?: RollbackInfo;
}

export interface SchemeReleases {
  projectId: number;
  targets: TargetView[];
  /** Test copies of no target. */
  testCopies: TestCopy[];
}

/** One kind of target's reader: its targets now (it may find none). */
export interface Reader {
  read(): Omit<TargetView, 'testCopies'>[];
  /** Read what read() needs from git, files or GitHub again (read() itself must answer at once). */
  refresh?(): Promise<void>;
}

/** How many earlier releases a card lists under Previous releases. */
export const PREVIOUS = 10;

/** A releases row as a Release. */
export function releaseOf(row: ReleaseRow, link: string | null, number: number | null): Release {
  const changes = JSON.parse(row.changes) as (Release['changes'][number] & { stages?: unknown })[];
  return {
    version: row.version,
    number,
    link,
    outcome: row.outcome,
    started: row.started_at,
    live: row.live_at,
    stages: JSON.parse(row.stages),
    changes: changes.map(({ ticketId, number, title }) => ({ ticketId, number, title })),
  };
}

export interface ReleasesDeps {
  store: Store;
  readers: Reader[];
  /** Every scheme's test copies. */
  testCopies: () => Map<number, TestCopy[]>;
  broadcast: (msg: object) => void;
  /** Find every scheme's targets again (src/release-targets.ts), before the readers read theirs. */
  scan?: () => Promise<void>;
  /** A target's deploy button and auto-deploy (src/auto-deploy.ts), or null when it has no release step. */
  deploy?: (tv: Omit<TargetView, 'testCopies'>) => DeployInfo | null;
  /** The app a target's card offers to make a release key for (#837), or null. */
  releaseKey?: (tv: Omit<TargetView, 'testCopies'>) => string | null;
  /** A target's Roll back to last green (src/rollback.ts), or null. */
  rollback?: (tv: Omit<TargetView, 'testCopies'>, views: Omit<TargetView, 'testCopies'>[]) => RollbackInfo | null;
  /** Put each scheme's changes still on their way to main (open PRs) on its targets (PrsInFlight.attach, #655). */
  inFlight?: (views: Omit<TargetView, 'testCopies'>[]) => void;
}

/** A target's releases named by its own template (#764): "Build {n}" → "Build 997"; a next with no number yet "Next build". */
export function named(tv: Pick<TargetView, 'target' | 'current' | 'next' | 'recent'>) {
  const tpl = tv.target.numbering?.name;
  if (!tpl) return;
  const name = (n: number | null) => (n == null ? null : tpl.replace(/\{n\}/g, String(n)));
  for (const r of [tv.current, ...tv.recent]) if (r && r.number != null) r.name = name(r.number)!;
  if (tv.next) tv.next.name = name(tv.next.number) ?? `Next ${tpl.replace(/\{n\}/g, '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

export class Releases {
  private d: ReleasesDeps;
  private shown = new Map<number, string>();
  private polled = false;
  private last: SchemeReleases[] = [];
  constructor(d: ReleasesDeps) {
    this.d = d;
  }

  /** Every scheme with a target or a test copy, read afresh. */
  read(): SchemeReleases[] {
    const copies = this.d.testCopies();
    const byScheme = new Map<number, SchemeReleases>();
    const scheme = (id: number) => byScheme.get(id) ?? byScheme.set(id, { projectId: id, targets: [], testCopies: [] }).get(id)!;
    const views = this.d.readers.flatMap((r) => r.read());
    this.d.inFlight?.(views);
    for (const t of views) named(t);
    for (const t of views) {
      const deploy = this.d.deploy?.(t);
      const releaseKey = this.d.releaseKey?.(t);
      const rollback = this.d.rollback?.(t, views);
      scheme(t.target.projectId).targets.push({ ...t, testCopies: [], ...(deploy ? { deploy } : {}), ...(releaseKey ? { releaseKey } : {}), ...(rollback ? { rollback } : {}) });
    }
    // Who placed the waiting ships (#1358), for the line's rows.
    for (const s of byScheme.values()) {
      const state = readState(this.d.store, s.projectId);
      const { placed } = state;
      // A ship that left the line (shipped) lets go of its pin at once, so a follow-up from the same minion starts unpinned.
      const here = new Set(s.targets.flatMap((tv) => tv.line.map(placedKey)));
      const gone = Object.keys(placed).filter((k) => !here.has(k));
      if (gone.length && s.targets.length) {
        for (const k of gone) delete placed[k];
        this.d.store.setSetting(shipLineKey(s.projectId), state);
      }
      for (const tv of s.targets) tv.line = tv.line.map((e) => (!e.holds && placed[placedKey(e)] ? { ...e, placed: placed[placedKey(e)] } : e));
    }
    for (const [id, list] of copies) {
      for (const c of list) {
        const own = c.target ? byScheme.get(id)?.targets.find((t) => t.target.id === c.target) : undefined;
        (own ? own.testCopies : scheme(id).testCopies).push(own ? c : { ...c, target: null });
      }
    }
    // An upcoming release with nothing of its own to try links a test copy of a change it carries, a running one first.
    for (const s of byScheme.values()) {
      for (const tv of s.targets) {
        if (!tv.next || tv.next.link) continue;
        const ids = new Set(tv.next.changes.map((c) => c.ticketId));
        const mine = tv.testCopies.filter((c) => c.ticketId != null && ids.has(c.ticketId));
        const copy = mine.find((c) => c.running) ?? mine[0];
        if (copy) tv.next.link = `/${copy.path}`;
      }
    }
    // A fix that shipped without a go says so on its row (#1398), where members already look: from its newest shipped line,
    // so a change still in the land line shows nothing yet. shortcut: a minion that ships twice shows its newest ship's
    // line on both releases; key it by commit if that starts to happen.
    for (const s of byScheme.values()) {
      for (const tv of s.targets) {
        for (const c of [...(tv.next?.changes ?? []), ...[tv.current, ...tv.recent].flatMap((r) => r?.changes ?? [])]) {
          const fix = fixLineIn(this.d.store.lastShippedNote(c.ticketId) ?? '');
          if (fix) c.fix = fix;
        }
      }
    }
    return [...byScheme.values()].sort((a, b) => a.projectId - b.projectId);
  }

  /** Read again, and send each scheme whose part changed (an empty one when it has nothing any more). */
  poll() {
    this.last = this.read();
    const now = new Map(this.last.map((s) => [s.projectId, s]));
    for (const id of new Set([...this.shown.keys(), ...now.keys()])) {
      const s = now.get(id) ?? { projectId: id, targets: [], testCopies: [] };
      const json = JSON.stringify(s);
      if (this.shown.get(id) === json) continue;
      if (now.has(id)) this.shown.set(id, json);
      else this.shown.delete(id);
      // The first poll sends nothing: a page asks GET /api/releases when it opens.
      if (this.polled) this.d.broadcast({ type: 'releases', projectId: id, releases: s });
    }
    this.polled = true;
  }

  private refreshing: Promise<void> | null = null;
  /** Each reader's slow part read again (one at a time), with every scheme's targets found again first when `scan`, then poll. */
  refresh(scan = false): Promise<void> {
    // A scan asked for while a refresh without one runs waits for it, then runs its own.
    if (this.refreshing && scan) return this.refreshing.then(() => this.refresh(true));
    this.refreshing ??= (async () => {
      if (scan) await this.d.scan?.().catch((err) => console.error('Finding release targets failed:', err));
      for (const r of this.d.readers) await r.refresh?.().catch((err) => console.error('Reading release targets failed:', err));
      this.poll();
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** The schemes `visible` allows (null: all), as the last poll read them, or afresh before the first. */
  view(visible: (projectId: number) => boolean): SchemeReleases[] {
    if (!this.polled) this.last = this.read();
    return this.last.filter((s) => visible(s.projectId));
  }
}

/** git's output as it came (untrimmed: file contents), or null when it failed. */
export const git = (args: string[], cwd: string) => gitOut(args, cwd, { trim: false });

export const CITADEL_TARGET = 'citadel-server';
/** When each change in flight first reached each stage: { [ticket id]: { [stage]: ms } }. Kept, as the restart that makes it live restarts this server. */
const TRACKING = 'releases-tracking';
const TRACKING_MAX_AGE = 24 * 60 * 60_000;

export interface CitadelDeps {
  store: Store;
  /** The scheme whose repo the live checkout is, or null before it's known. */
  scheme: () => Project | null;
  /** The commit the server runs. */
  head: () => string | null;
  /** The land line, as Waits last read it. */
  line: () => LandTicket[];
  ticketFor: (label: string) => number | null;
  /** A minion's wait (Waits.wait): its landing's stage, or the idle restart. */
  wait: (ticketId: number) => Wait | null;
  ship: (ticketId: number) => Ship | null;
  /** A stage's usual length in s (Waits.usual, the wait-usual setting). */
  usual: (key: string) => number | null;
  /** Running turns the restart waits for. */
  interruptible: () => number;
  /** Whether a minion's landing waits for a CI runner to take its run. */
  ciQueued?: (ticketId: number) => boolean;
  /** What happened so far in a minion's ship, from its land.sh output (src/land-news.ts, #1368); `name`: a branch's #N. */
  news?: (ticketId: number, name: (branch: string) => string) => NewsItem[];
  now?: () => number;
}

/**
 * Citadel's own server (tools/land.sh → tools/deploy.sh): a release is the commit the server runs. Its next release
 * is every change in the land line, or on main and not live yet; its stages are the land track's (TRACK). A release
 * row is written when the server sees a new commit running (live, from liveOn in server.ts), with the minions whose
 * branch tips landed since the last row.
 */
export class CitadelServer implements Reader {
  private d: CitadelDeps;
  private tracking: Record<string, Record<string, number>>;
  private writing: Promise<void> = Promise.resolve();
  constructor(d: CitadelDeps) {
    this.d = d;
    this.tracking = d.store.getSetting(TRACKING) ?? {};
  }

  private now = () => (this.d.now ?? Date.now)();

  /** The usual length of each stage of the track, s; the line is a wait, so it has none. */
  private stageUsual(stage: string): number | null {
    const { usual } = this.d;
    switch (stage) {
      case 'rebase':
        return usual('land:rebase');
      case 'test':
        return usual('land:ci') ?? usual('land:tests');
      case 'deploy':
        return usual('land:deploy');
      case 'restart':
        return usual('restart');
      case 'live':
        return 0;
      default:
        return null;
    }
  }

  /** Where one change is: from its landing's wait while it's in the land line, else from its ship stage. */
  private progress(id: number, ship: Ship | null, loneDeploy: LandTicket | undefined): Progress | null {
    const w = this.d.wait(id);
    if (w?.kind === 'land') {
      const waits = w.stage === 'line' || (w.stage === 'test' && !!this.d.ciQueued?.(id));
      const p: Progress = { stage: w.stage, since: w.since, usual: waits ? null : w.usual, waitingOn: waits ? w.text : null, text: w.text, ...(w.brief && { brief: w.brief }), ...(w.label && { label: w.label }), ...(w.train && { train: w.train }), ...(w.early && { early: w.early }) };
      if (w.total) Object.assign(p, { done: w.done, total: w.total });
      return p;
    }
    if (!ship) return null;
    // Stable while it lasts: when this stage was first seen (track), so a poll doesn't move it.
    const since = (stage: string) => (w?.kind === 'restart' ? w.since : (this.tracking[id]?.[stage] ?? this.now()));
    if (ship.stage === 'deploying') {
      const n = this.d.interruptible();
      const text = n ? `the restart waits for ${n} running turn${n === 1 ? '' : 's'} to end` : 'restarting';
      return { stage: 'restart', since: since('restart'), usual: n ? null : this.stageUsual('restart'), waitingOn: n ? text : null, text };
    }
    if (ship.stage === 'failed') return { stage: 'deploy', since: since('deploy'), usual: null, waitingOn: ship.text, text: ship.text };
    if (ship.stage !== 'main') return null;
    // On main and not live: a deploy run alone (tools/deploy.sh) may be carrying it; else nothing is yet.
    if (loneDeploy) {
      const ph = landPhase(loneDeploy.phase);
      return { stage: ph.stage, since: loneDeploy.mtime, usual: this.stageUsual(ph.stage), waitingOn: null, text: ph.text, label: ph.label };
    }
    const text = 'on main, not deployed yet: the next change to ship takes it live, or the Taskmaster can run a deploy';
    return { stage: 'deploy', since: since('deploy'), usual: null, waitingOn: text, text: ship.text, brief: 'on main, waits for the next ship' };
  }

  /** Note when each change first reached each stage, for the release's stage times; a change that went back starts afresh. */
  private track(changes: Change[]) {
    const now = this.now();
    let dirty = false;
    for (const c of changes) {
      const had = this.tracking[c.ticketId] ?? {};
      const latest = Math.max(-1, ...Object.keys(had).map((s) => TRACK.indexOf(s)));
      const t = TRACK.indexOf(c.stage) < latest ? {} : { ...had };
      if (!(c.stage in t)) {
        t[c.stage] = c.since;
        this.tracking[c.ticketId] = t;
        dirty = true;
      }
    }
    for (const [id, t] of Object.entries(this.tracking)) {
      if (now - Math.max(...Object.values(t)) > TRACKING_MAX_AGE) {
        delete this.tracking[id];
        dirty = true;
      }
    }
    if (dirty) this.d.store.setSetting(TRACKING, this.tracking);
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const p = this.d.scheme();
    if (!p) return [];
    const { store } = this.d;
    const head = this.d.head();
    const rows = store.listReleases(p.id, CITADEL_TARGET, PREVIOUS + 1);
    const total = store.countReleases(p.id, CITADEL_TARGET);
    const currentRow = head && rows[0]?.version === head ? rows[0] : null;
    // The current release is this site; an older one can't be opened any more.
    const current = currentRow ? releaseOf(currentRow, '/', total) : head ? { version: head, number: total + 1, link: '/', changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
    const skip = currentRow ? 1 : 0;
    const recent = rows.slice(skip, skip + PREVIOUS).map((r, i) => releaseOf(r, null, total - skip - i));

    const lineTickets = this.d.line();
    const line: LineEntry[] = lineTickets.map((t, i) => {
      const id = this.d.ticketFor(t.label);
      const ticket = id != null ? store.getTicket(id) : undefined;
      return {
        name: ticket ? `#${ticket.number ?? ticket.id}` : t.label.replace(/ \(.*\)$/, ''),
        ticketId: ticket?.id ?? null,
        holds: t.got > 0,
        place: ordinal(i + 1),
        seq: t.seq,
        movable: t.got === 0 && !t.holds && !ridingOf(t.phase) && !!t.orders && !behindOld(lineTickets, t),
        stage: t.got > 0 ? landPhase(t.phase).stage : 'line',
        since: t.mtime,
        ...(t.frozen && { frozen: t.frozen }),
        ...(t.got > 0 && { label: (id != null ? this.d.wait(id)?.label : undefined) ?? landPhase(t.phase).label }),
        ...(t.got === 0 && t.holds ? { why: HOLDS_LINE } : t.got === 0 && !t.orders ? { why: OLD_LAND } : t.got === 0 && behindOld(lineTickets, t) ? { why: BEHIND_OLD } : {}),
      };
    });
    // A deploy run alone holding the lock carries whatever is on main.
    const loneDeploy = lineTickets.find((t) => t.got > 0 && t.label === 'tools/deploy.sh');

    const changes: Change[] = [];
    const inLine = new Set(line.flatMap((e) => (e.ticketId != null ? [e.ticketId] : [])));
    const tickets = store.listTickets(p.id);
    for (const t of tickets) {
      // A dismissed minion's ship stage isn't looked at again (ShipStatus.poll), so only open ones and the land line count.
      // shortcut: a minion dismissed after landing but before live drops out of next; read its stage afresh if that starts to happen.
      if (t.kind !== 'ticket' || !t.branch || (t.status === 'closed' && !inLine.has(t.id))) continue;
      const ship = this.d.ship(t.id);
      if (!inLine.has(t.id) && !ship) continue;
      const pr = this.progress(t.id, ship, loneDeploy);
      const at = line.find((e) => e.ticketId === t.id);
      if (pr?.stage === 'line' && at && !pr.train) pr.brief = at.place;
      if (pr) changes.push({ ticketId: t.id, number: t.number, title: t.title, ...pr, ...(t.status !== 'closed' && t.cwd ? { canPreview: true } : {}) });
    }
    changes.sort((a, b) => TRACK.indexOf(b.stage) - TRACK.indexOf(a.stage) || a.since - b.since);
    // A train's riders sit right behind their front (they are in the release it carries), in line order.
    const lineAt = (c: Change) => line.findIndex((e) => e.ticketId === c.ticketId);
    const front = changes.find((c) => c.train?.role === 'front');
    if (front) {
      const rs = changes.filter((c) => c.train?.role === 'rider').sort((a, b) => lineAt(a) - lineAt(b));
      const rest = changes.filter((c) => c !== front && !rs.includes(c));
      const at = changes.indexOf(front) - changes.slice(0, changes.indexOf(front)).filter((c) => rs.includes(c)).length;
      changes.splice(0, changes.length, ...rest.slice(0, at), front, ...rs, ...rest.slice(at));
    }
    // Lands go one at a time and each starts its own deploy, so only the lead is in the release under way (#888).
    changes.forEach((c, i) => {
      if (i > 0 && c.stage === 'line') c.later = true;
    });
    this.track(changes);

    let next: Next | null = null;
    if (changes.length) {
      const lead = changes[0];
      const stages = TRACK.map((name) => ({ name, usual: this.stageUsual(name) }));
      const after = stages.slice(TRACK.indexOf(lead.stage) + 1);
      // The idle restart waits on running turns, so with any running no time is promised for a release before it.
      const restartWaits = this.d.interruptible() > 0 && after.some((s) => s.name === 'restart');
      const eta = lead.waitingOn || restartWaits || lead.usual == null || after.some((s) => s.usual == null) ? null : lead.since + (lead.usual + after.reduce((sum, s) => sum + s.usual!, 0)) * 1000;
      const { ticketId: _i, number: _n, title: _t, ...at } = lead;
      next = { ...at, number: Math.max(total, current?.number ?? 0) + 1, link: null, stages, eta, changes };
      // The ship holding the line: its land.sh lines say what happened so far (riders, flakes, the bisect).
      const holder = line.find((e) => e.holds)?.ticketId;
      if (holder != null && this.d.news) {
        const names = new Map(tickets.flatMap((t) => (t.branch ? [[t.branch, `#${t.number ?? t.id}`] as const] : [])));
        const news = this.d.news(holder, (b) => names.get(b) ?? b.replace(/^ticket\//, ''));
        // The files failed so far, live from CI's job (POST /api/ci-tests) or perigee's run (its progress file), before land.sh hears of them.
        const failed = this.d.wait(holder)?.failed;
        if (failed?.length)
          news.push({
            tone: 'bad',
            text: `Failed so far: ${failed
              .slice(0, 3)
              .map((f) => f.replace(/^.*\//, ''))
              .join(', ')}${failed.length > 3 ? ` +${failed.length - 3} more` : ''}`,
          });
        const ids = new Map(tickets.map((t) => [`#${t.number ?? t.id}`, t.id]));
        for (const n of news) {
          const refs = Object.fromEntries((n.text.match(/#\d+/g) ?? []).flatMap((r) => (ids.has(r) ? [[r, ids.get(r)!]] : [])));
          if (Object.keys(refs).length) n.refs = refs;
        }
        if (news.length) next.news = news.slice(-6); // land-news's SHOWN, with the live line counted (a value import would loop back here)
      }
    }
    return [{ target: { id: CITADEL_TARGET, projectId: p.id, name: 'Server', kind: CITADEL_TARGET, link: null }, current, next, line, recent }];
  }

  /** The server now runs `head`: write its release row once, with the changes that landed since the last one. */
  live(head: string | null): Promise<void> {
    this.writing = this.writing.then(() => this.write(head)).catch((err) => console.error('Writing the release row failed:', err));
    return this.writing;
  }

  private async write(head: string | null) {
    const p = this.d.scheme();
    if (!head || !p?.repo_dir) return;
    const { store } = this.d;
    const last = store.listReleases(p.id, CITADEL_TARGET, 1)[0];
    if (last?.version === head) return;
    const landed = last ? (await landedIn(store, p, last.version, head))?.tickets : [];
    // git failed: no row, rather than a release with its changes lost; the next head's row takes them in.
    if (!landed) return console.error(`Reading what landed in ${head.slice(0, 7)} failed: no release row for it`);
    const liveAt = this.now();
    const changes = landed.map((t) => ({ ticketId: t.id, number: t.number, title: t.title, stages: this.tracking[t.id] ?? {} }));
    // The stage lengths of the change whose deploy carried the release live: the latest to start deploying.
    const carrier = changes.filter((c) => c.stages.deploy != null).sort((a, b) => b.stages.deploy! - a.stages.deploy!)[0];
    const stages: Record<string, number> = {};
    if (carrier) {
      const seen = TRACK.filter((s) => carrier.stages[s] != null);
      seen.forEach((s, i) => (stages[s] = Math.max(0, Math.round(((i + 1 < seen.length ? carrier.stages[seen[i + 1]] : liveAt) - carrier.stages[s]) / 1000))));
    }
    const starts = changes.flatMap((c) => Object.values(c.stages));
    store.addRelease({
      project_id: p.id,
      target: CITADEL_TARGET,
      version: head,
      changes: JSON.stringify(changes),
      started_at: starts.length ? Math.min(...starts) : null,
      live_at: liveAt,
      outcome: 'live',
      stages: JSON.stringify(stages),
    });
    if (landed.length) {
      for (const t of landed) delete this.tracking[t.id];
      store.setSetting(TRACKING, this.tracking);
    }
  }
}

/**
 * The commits in prev..head (sha → commit time, ms), and the scheme's minions whose branch tip is one of them: land.sh
 * rebases a branch and fast-forwards main to it, so a landed branch's tip is on main. A batch member under the kit's
 * core land.sh moves its branch only once the head's deploy ends, so until then refs/shipping/<branch> names it
 * (tools/land.local.sh's land_deploy, #1323). A tip committed before its minion started is where a new branch began,
 * not its work. Null when git failed.
 */
export async function landedIn(store: Store, p: Project, prev: string, head: string) {
  const [log, refs] = await Promise.all([git(['log', '--format=%x01%H %ct', '--name-only', `${prev}..${head}`], p.repo_dir!), git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/shipping/'], p.repo_dir!)]);
  if (log == null || refs == null) return null;
  const commits = new Map<string, number>();
  /** The files each commit touched (#764), so a change can be put on the target that ships them. */
  const files = new Map<string, string[]>();
  for (const chunk of log.split('\x01').slice(1)) {
    const [line, ...names] = chunk.split('\n');
    const [sha, ct] = line.split(' ');
    commits.set(sha, Number(ct) * 1000);
    files.set(sha, names.filter(Boolean));
  }
  const lines = refs
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' ') as [string, string]);
  const tips = new Map(lines.filter(([, ref]) => ref.startsWith('refs/heads/')).map(([sha, ref]) => [ref.slice(11), sha]));
  // A batch member's refs/shipping name counts while its branch's tip isn't in the range yet.
  for (const [sha, ref] of lines) if (ref.startsWith('refs/shipping/') && commits.has(sha) && !commits.has(tips.get(ref.slice(14)) ?? '')) tips.set(ref.slice(14), sha);
  const tickets = store
    .listTickets(p.id)
    .filter((t) => t.kind === 'ticket' && t.branch && commits.has(tips.get(t.branch) ?? '') && commits.get(tips.get(t.branch)!)! >= t.created_at - 1000)
    .sort((a, b) => (a.number ?? a.id) - (b.number ?? b.id));
  // A minion's files: its commits, oldest first up to its branch's tip, since the tip before it (history is linear).
  const at = new Map<string, number[]>();
  for (const t of tickets) (at.get(tips.get(t.branch!)!) ?? at.set(tips.get(t.branch!)!, []).get(tips.get(t.branch!)!)!).push(t.id);
  const ticketFiles = new Map<number, string[]>();
  let run = new Set<string>();
  for (const sha of [...commits.keys()].reverse()) {
    for (const f of files.get(sha)!) run.add(f);
    const ids = at.get(sha);
    if (!ids) continue;
    for (const id of ids) ticketFiles.set(id, [...run]);
    run = new Set();
  }
  return { commits, tickets, files, ticketFiles };
}

/**
 * When `sha` reached `branch` (ms): the time of the earliest move of the branch whose result had it, from its reflog. A
 * commit's own time is when it was written, which a kit sync or a long-lived branch makes hours earlier than its ship.
 * Falls back to `fallback` (the commit's time) when there is no reflog (a fresh clone, a pruned log).
 */
export async function reachedMain(repo: string, branch: string, sha: string, fallback: number): Promise<number> {
  const log = await git(['reflog', 'show', '--date=unix', '--format=%H %gd', '-n', '200', `refs/heads/${branch}`], repo);
  let at = fallback;
  for (const line of (log ?? '').split('\n').filter(Boolean)) {
    const [head, sel] = line.split(' ');
    const when = Number(/@\{(\d+)\}/.exec(sel ?? '')?.[1]) * 1000;
    if (!when) break;
    if (head !== sha && (await git(['merge-base', '--is-ancestor', sha, head], repo)) == null) break;
    at = Math.max(fallback, when);
  }
  return at;
}

export type Landed = NonNullable<Awaited<ReturnType<typeof landedIn>>>;

/** Every scheme's previews that people were offered, and the builds' previews of the scheme whose code this server runs. */
export function previewCopies(store: Store, d: { own: () => Project | null; running: (key: string) => { commit: string | null } | null; builds: (projectId: number) => number[] }): Map<number, TestCopy[]> {
  const out = new Map<number, TestCopy[]>();
  const own = d.own();
  const add = (id: number, c: TestCopy) => (out.get(id) ?? out.set(id, []).get(id)!).push(c);
  for (const key of store.settingKeys(previewKey(0).replace(/0$/, ''))) {
    const t = store.getTicket(Number(key.split(':')[1]));
    if (!t || t.status === 'closed') continue;
    const r = d.running(String(t.id));
    // A preview runs this server's code from the minion's branch.
    add(t.project_id, { kind: 'preview', target: own?.id === t.project_id ? CITADEL_TARGET : null, name: `#${t.number ?? t.id} ${t.title}`, path: previewPath(t.id), ticketId: t.id, running: !!r, commit: r?.commit ?? null });
  }
  if (own) {
    for (const n of d.builds(own.id)) {
      const r = d.running(`build-${n}`);
      add(own.id, { kind: 'build-preview', target: CITADEL_TARGET, name: `Build ${n}`, path: buildPreviewPath(n), build: n, running: !!r, commit: r?.commit ?? null });
    }
  }
  return out;
}
