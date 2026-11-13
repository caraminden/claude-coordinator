// Releases (#625, specs/release-monitor.md): per scheme, each target it ships to people (a Target), the release
// people have now, the next one on its way and how far along it is, the land line, test copies and the last few
// releases. One shape for every kind of target, filled by one small reader per kind; only Citadel's own server
// has a reader so far (CitadelServer below). Test copies (previews, builds' previews) belong to a target when
// they run its code, else to the scheme, so a scheme with no target still lists them.
// Served at GET /api/releases and sent as a `releases` event per scheme when its part changes. Importing it
// starts nothing: server.ts calls poll() and live().
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeployInfo } from './auto-deploy.ts';
import type { Ship } from './branch.ts';
import type { Project, ReleaseRow, Store } from './db.ts';
import { buildPreviewPath, previewKey, previewPath } from './previews.ts';
import { landPhase, TRACK, type LandTicket, type Wait } from './waits.ts';

export interface Target {
  /** Unique within its scheme: "citadel-server". */
  id: string;
  projectId: number;
  /** Short, as it sits under its scheme's row: "Server". */
  name: string;
  kind: string;
  link: string | null;
}

export interface Release {
  /** A commit (sha) or a version name, shown as a secondary detail. */
  version: string;
  /** What people call it ("Release 14"): its place in its target's releases that went live, counting from 1, or the
   * number the target's own tooling gives it (a CI run's, an APK's versionCode); null for a try that didn't go live. */
  number: number | null;
  /** The release itself: the live site, the file to download; null when there's nothing to open (never a commit). */
  link: string | null;
  changes: { ticketId: number; number: number | null; title: string }[];
  /** When its first change started on its way (ms), and when it went live; null when not known. */
  started: number | null;
  live: number | null;
  outcome: string;
  /** Each stage's length, s. */
  stages: Record<string, number>;
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
  done?: number;
  total?: number;
}

export interface Change extends Progress {
  ticketId: number;
  number: number | null;
  title: string;
}

export interface Next extends Progress {
  /** The number it will have once live, when known. */
  number: number | null;
  /** Something to try it on before it's live (a preview, a signed build), or null. */
  link: string | null;
  /** The kind's stages in order, each with its usual length in s (null: not known, or a wait): the bar's segments. */
  stages: { name: string; usual: number | null }[];
  /** When the whole release should be live (ms), only when the current stage and every one after it have a usual time and none waits. */
  eta: number | null;
  /** The changes on their way, the furthest along first; the release's own stage is the first's. */
  changes: Change[];
}

export interface LineEntry {
  /** "#620", or the label of a run that isn't a minion's ("tools/deploy.sh"). */
  name: string;
  ticketId: number | null;
  /** Holding the lock (true) or waiting for it. */
  holds: boolean;
  stage: string;
  since: number;
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

const RECENT = 5;

/** A releases row as a Release. */
export function releaseOf(row: ReleaseRow, link: string | null, number: number | null): Release {
  const changes = JSON.parse(row.changes) as (Release['changes'][number] & { stages?: unknown })[];
  return {
    version: row.version, number, link, outcome: row.outcome, started: row.started_at, live: row.live_at, stages: JSON.parse(row.stages),
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
    for (const reader of this.d.readers) {
      for (const t of reader.read()) {
        const deploy = this.d.deploy?.(t);
        scheme(t.target.projectId).targets.push({ ...t, testCopies: [], ...(deploy ? { deploy } : {}) });
      }
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

const run = promisify(execFile);
/** git's output, or null when it failed. */
export async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await run('git', args, { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

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
      case 'rebase': return usual('land:rebase');
      case 'test': return usual('land:ci') ?? usual('land:tests');
      case 'deploy': return usual('land:deploy');
      case 'restart': return usual('restart');
      case 'live': return 0;
      default: return null;
    }
  }

  /** Where one change is: from its landing's wait while it's in the land line, else from its ship stage. */
  private progress(id: number, ship: Ship | null, loneDeploy: LandTicket | undefined): Progress | null {
    const w = this.d.wait(id);
    if (w?.kind === 'land') {
      const waits = w.stage === 'line' || (w.stage === 'test' && !!this.d.ciQueued?.(id));
      const p: Progress = { stage: w.stage, since: w.since, usual: waits ? null : w.usual, waitingOn: waits ? w.text : null, text: w.text };
      if (w.total) Object.assign(p, { done: w.done, total: w.total });
      return p;
    }
    if (!ship) return null;
    // Stable while it lasts: when this stage was first seen (track), so a poll doesn't move it.
    const since = (stage: string) => (w?.kind === 'restart' ? w.since : this.tracking[id]?.[stage] ?? this.now());
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
      return { stage: ph.stage, since: loneDeploy.mtime, usual: this.stageUsual(ph.stage), waitingOn: null, text: ph.text };
    }
    const text = 'on main, not deployed yet: the next land takes it live, or the Taskmaster can run a deploy';
    return { stage: 'deploy', since: since('deploy'), usual: null, waitingOn: text, text: ship.text };
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
    const rows = store.listReleases(p.id, CITADEL_TARGET, RECENT + 1);
    const total = store.countReleases(p.id, CITADEL_TARGET);
    const currentRow = head && rows[0]?.version === head ? rows[0] : null;
    // The current release is this site; an older one can't be opened any more.
    const current = currentRow ? releaseOf(currentRow, '/', total)
      : head ? { version: head, number: total + 1, link: '/', changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
    const skip = currentRow ? 1 : 0;
    const recent = rows.slice(skip, skip + RECENT).map((r, i) => releaseOf(r, null, total - skip - i));

    const lineTickets = this.d.line();
    const line: LineEntry[] = lineTickets.map((t) => {
      const id = this.d.ticketFor(t.label);
      const ticket = id != null ? store.getTicket(id) : undefined;
      return {
        name: ticket ? `#${ticket.number ?? ticket.id}` : t.label.replace(/ \(.*\)$/, ''), ticketId: ticket?.id ?? null,
        holds: t.got > 0, stage: t.got > 0 ? landPhase(t.phase).stage : 'line', since: t.mtime,
      };
    });
    // A deploy run alone holding the lock carries whatever is on main.
    const loneDeploy = lineTickets.find((t) => t.got > 0 && t.label === 'tools/deploy.sh');

    const changes: Change[] = [];
    const inLine = new Set(line.flatMap((e) => (e.ticketId != null ? [e.ticketId] : [])));
    for (const t of store.listTickets(p.id)) {
      // A dismissed minion's ship stage isn't looked at again (ShipStatus.poll), so only open ones and the land line count.
      // shortcut: a minion dismissed after landing but before live drops out of next; read its stage afresh if that starts to happen.
      if (t.kind !== 'ticket' || !t.branch || (t.status === 'closed' && !inLine.has(t.id))) continue;
      const ship = this.d.ship(t.id);
      if (!inLine.has(t.id) && !ship) continue;
      const pr = this.progress(t.id, ship, loneDeploy);
      if (pr) changes.push({ ticketId: t.id, number: t.number, title: t.title, ...pr });
    }
    changes.sort((a, b) => TRACK.indexOf(b.stage) - TRACK.indexOf(a.stage) || a.since - b.since);
    this.track(changes);

    let next: Next | null = null;
    if (changes.length) {
      const lead = changes[0];
      const stages = TRACK.map((name) => ({ name, usual: this.stageUsual(name) }));
      const after = stages.slice(TRACK.indexOf(lead.stage) + 1);
      // The idle restart waits on running turns, so with any running no time is promised for a release before it.
      const restartWaits = this.d.interruptible() > 0 && after.some((s) => s.name === 'restart');
      const eta = lead.waitingOn || restartWaits || lead.usual == null || after.some((s) => s.usual == null)
        ? null : lead.since + (lead.usual + after.reduce((sum, s) => sum + s.usual!, 0)) * 1000;
      const { ticketId: _i, number: _n, title: _t, ...at } = lead;
      next = { ...at, number: Math.max(total, current?.number ?? 0) + 1, link: null, stages, eta, changes };
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
      project_id: p.id, target: CITADEL_TARGET, version: head, changes: JSON.stringify(changes),
      started_at: starts.length ? Math.min(...starts) : null, live_at: liveAt, outcome: 'live', stages: JSON.stringify(stages),
    });
    if (landed.length) {
      for (const t of landed) delete this.tracking[t.id];
      store.setSetting(TRACKING, this.tracking);
    }
  }

}

/**
 * The commits in prev..head (sha → commit time, ms), and the scheme's minions whose branch tip is one of them: land.sh
 * rebases a branch and fast-forwards main to it, so a landed branch's tip is on main. A tip committed before its minion
 * started is where a new branch began, not its work. Null when git failed.
 */
export async function landedIn(store: Store, p: Project, prev: string, head: string) {
  const [log, refs] = await Promise.all([
    git(['log', '--format=%H %ct', `${prev}..${head}`], p.repo_dir!),
    git(['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/'], p.repo_dir!),
  ]);
  if (log == null || refs == null) return null;
  const commits = new Map(log.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]).map(([sha, ct]) => [sha, Number(ct) * 1000]));
  const tips = new Map(refs.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]).map(([sha, ref]) => [ref, sha]));
  const tickets = store.listTickets(p.id)
    .filter((t) => t.kind === 'ticket' && t.branch && commits.has(tips.get(t.branch) ?? '') && commits.get(tips.get(t.branch)!)! >= t.created_at - 1000)
    .sort((a, b) => (a.number ?? a.id) - (b.number ?? b.id));
  return { commits, tickets };
}

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
