// A reader per kind of found target (#627, src/release-targets.ts finds them), each filling src/releases.ts's shape.
// read() answers from what refresh() last read (git, files, GitHub), so the 2-second poll costs nothing.
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeployView } from './app-services.ts';
import type { Job, Run } from './ci-health.ts';
import type { CiMirror } from './ci-mirror.ts';
import type { Kind } from './ci-store.ts';
import { ciRun, desktopPaths, NO_FILE, type DesktopBuild, type DesktopIndex, type DesktopTarget } from './desktop-feed.ts';
import type { Contains, Green, Pin } from './last-green.ts';
import type { ContraptionDeployRow, ContraptionRow, Project, Store, Ticket } from './db.ts';
import { verdict, type PrSnapshot } from './github.ts';
import { BEHIND_OLD, CITADEL_TARGET, HOLDS_LINE, git, landedIn, OLD_LAND, reachedMain, releaseOf, type Change, type LineEntry, type Landed, type Next, type Progress, type Reader, type Release, type TargetView, type TestCopy } from './releases.ts';
import { holds, shipsTo, type BuildFile, type Found, type TargetFinder } from './release-targets.ts';
import { repoSlug } from './prlinks.ts';
import { frozenChip, frozenWords, type Frozen } from './frozen-ships.ts';
import { behindOld, median, ordinal, readQueue, readQueueA, type HeavyJobs, type LandTicket } from './waits.ts';
import { ciState, ciVerdict } from './ci-verdict.ts';

const RECENT = 5;
/** How many earlier releases a card lists under Previous releases (Cara, 2026-11-12: "Previous releases could have links to old builds"). */
const PREVIOUS = 10;

/** A whole next release from its lead's progress: the track's stages with their usual times, and when it should be live. */
export function nextOf(track: string[], usual: (stage: string) => number | null, lead: Progress, changes: Change[], number: number | null, link: string | null = null): Next {
  const stages = track.map((name) => ({ name, usual: name === 'live' ? 0 : usual(name) }));
  const after = stages.slice(track.indexOf(lead.stage) + 1);
  const eta = lead.waitingOn || lead.usual == null || after.some((s) => s.usual == null) ? null : lead.since + (lead.usual + after.reduce((sum, s) => sum + s.usual!, 0)) * 1000;
  return { ...lead, number, link, stages, eta, changes };
}

/** Each stage's length in s, from when each began (ms) up to the next one, the last up to `end`. */
export function lengths(starts: Record<string, number>, end: number): Record<string, number> {
  const seen = Object.entries(starts).sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(seen.map(([s, at], i) => [s, Math.max(0, Math.round(((seen[i + 1]?.[1] ?? end) - at) / 1000))]));
}

/** The median of each stage's length over the newest RECENT rows that went live. */
export function usualOf(rows: { stages: string }[]): (stage: string) => number | null {
  const all = rows.slice(0, RECENT).map((r) => JSON.parse(r.stages) as Record<string, number>);
  return (stage) => median(all.flatMap((s) => (typeof s[stage] === 'number' ? [s[stage]] : [])));
}

/** The target as served: the finder's own fields stay here. */
export const targetOf = (t: Found) => ({ id: t.id, projectId: t.projectId, name: t.name, kind: t.kind, link: t.link, ...(t.numbering ? { numbering: t.numbering } : {}) });

/** Whether files ship on `t` among its scheme's targets (#764, shipsTo); a scheme with one target takes everything its paths hold (all, with none). */
export function shipsOnTarget(t: Found, all: Found[]): (files: string[] | null | undefined) => boolean {
  if (t.own) return (files) => !files || files.some((f) => holds(t, f));
  const scheme = all.filter((x) => x.projectId === t.projectId);
  // A lone target takes everything, unless a push `paths:` filter says what its build ships (the desktop zip, #1300).
  if (scheme.length < 2) return t.paths?.length ? (files) => !files || files.some((f) => holds(t, f)) : () => true;
  return (files) => shipsTo(files, scheme).includes(t.id);
}

/** What landed that ships on `t`: its commits and minions by the files they touched. */
export function landedOn(landed: Landed, on: (files: string[] | null | undefined) => boolean): Landed {
  return { ...landed, commits: new Map([...landed.commits].filter(([sha]) => on(landed.files.get(sha)))), tickets: landed.tickets.filter((x) => on(landed.ticketFiles.get(x.id))) };
}

/** What of `landed` changes the app itself: files in its folder but Markdown, as Mandate's own bump rule counts (android/README.md ships in no APK). */
export function appChanges(t: Found, landed: Landed | null): Landed | null {
  const app = (files: string[] | null | undefined) => !t.paths?.length || !files || files.some((f) => holds(t, f) && !f.endsWith('.md'));
  return landed && { ...landed, commits: new Map([...landed.commits].filter(([sha]) => app(landed.files.get(sha)))), tickets: landed.tickets.filter((x) => app(landed.ticketFiles.get(x.id))) };
}

const asChange = (x: { id: number; number: number | null; title: string }) => ({ ticketId: x.id, number: x.number, title: x.title });

/** A contraption's stages: main waits for someone to call deploy_contraption, then the deploy's own steps. */
export const CONTRAPTION_TRACK = ['call', 'build', 'drain', 'restart', 'live'];

interface AppState {
  /** The commit checked out in its folder. */
  deployed: string | null;
  /** Commits on the repo's branch not deployed (null: not known), the oldest's time, and the minions in them. */
  ahead: number | null;
  oldest: number | null;
  changes: { ticketId: number; number: number | null; title: string }[];
}

export interface ContraptionDeps {
  store: Store;
  finder: Pick<TargetFinder, 'list'>;
  /** Where its repo is checked out. */
  folder: (row: ContraptionRow) => string;
  /** Its deploy running now. */
  running: (name: string) => DeployView | null;
  /** The heavy queue's holders and waiters (citadel-heavy's files), to tell a build waiting in line from one running long. */
  heavy?: () => HeavyJobs;
  now?: () => number;
}

/** What a deploy's build is waiting on in the heavy queue (waiter "<app> deploy"), in words; null when it isn't waiting. */
export function buildWait(heavy: HeavyJobs, who: string): string | null {
  const i = heavy.waiters.findIndex((w) => w.who === who);
  if (i < 0) return null;
  if (heavy.waiters[i].reason === 'load') return 'perigee is busy · waiting for load to ease';
  if (heavy.waiters[i].reason === 'memory') return 'perigee is short on memory · waiting for room';
  return i === 0 ? 'in line for a build slot · next' : `in line for a build slot · ${i} ahead`;
}

/**
 * A contraption (deploy_contraption): a release is the commit checked out in its folder, recorded per deploy in
 * contraption_deploys. Its next release is its scheme's main ahead of that, which waits on a deploy call until someone
 * makes one, then follows the deploy's stages.
 */
export class ContraptionReader implements Reader {
  private d: ContraptionDeps;
  private state = new Map<string, AppState>();
  constructor(d: ContraptionDeps) {
    this.d = d;
  }

  /** The scheme whose clone has the contraption's repo, so main's commits and minions can be read there. */
  private scheme(t: Found, row: ContraptionRow): Project | null {
    const p = this.d.store.getProject(t.projectId);
    return p?.repo_dir && row.repo && repoSlug(p.repo_url) === row.repo.toLowerCase() ? p : null;
  }

  async refresh() {
    const next = new Map<string, AppState>();
    for (const t of this.d.finder.list('contraption')) {
      const row = this.d.store.getContraption(t.contraption!);
      if (!row) continue;
      // Until a deploy ends, what was read before it started stands: the folder only flips to the new build at its restart.
      const kept = this.state.get(t.id);
      if (kept && this.d.running(row.name)) {
        next.set(t.id, kept);
        continue;
      }
      const deployed = (await git(['rev-parse', 'HEAD'], this.d.folder(row)))?.trim() || null;
      const s: AppState = { deployed, ahead: null, oldest: null, changes: [] };
      const p = this.scheme(t, row);
      const main = p && (await git(['rev-parse', '--verify', '--quiet', `${row.branch ?? t.branch}^{commit}`], p.repo_dir!))?.trim();
      if (p && deployed && main) {
        const all = deployed === main ? null : await landedIn(this.d.store, p, deployed, main);
        // Only what ships on this app: a scheme's other targets' folders (an APK's android/) don't wait on its deploy.
        const landed = deployed === main ? { commits: new Map(), tickets: [] } : all && landedOn(all, shipsOnTarget(t, this.d.finder.list()));
        if (landed) {
          s.ahead = landed.commits.size;
          // When the oldest of them reached main, not when it was written: a kit sync commit is hours older than its ship.
          const [oldSha, oldAt] = [...landed.commits].sort((a, b) => a[1] - b[1])[0] ?? [];
          s.oldest = oldSha ? await reachedMain(p.repo_dir!, row.branch ?? t.branch, oldSha, oldAt!) : null;
          s.changes = landed.tickets.map((x) => ({ ticketId: x.id, number: x.number, title: x.title }));
        }
      }
      next.set(t.id, s);
    }
    this.state = next;
  }

  /** A finished deploy's row: its stage lengths, and the minions whose work it took live. */
  async record(view: DeployView) {
    const { store } = this.d;
    const row = store.getContraption(view.name);
    const t = this.d.finder.list('contraption').find((x) => x.contraption === view.name);
    const p = row && t ? this.scheme(t, row) : null;
    const all = p && view.from && view.to && view.from !== view.to ? await landedIn(store, p, view.from, view.to) : null;
    const landed = all && t ? landedOn(all, shipsOnTarget(t, this.d.finder.list())) : null;
    const end = view.finished_at ?? (this.d.now ?? Date.now)();
    store.addContraptionDeploy({
      name: view.name,
      from_sha: view.from,
      to_sha: view.to,
      by: view.by,
      started_at: view.started_at,
      finished_at: end,
      outcome: view.state,
      stages: JSON.stringify(lengths(view.stages, end)),
      changes: JSON.stringify((landed?.tickets ?? []).map((x) => ({ ticketId: x.id, number: x.number, title: x.title }))),
    });
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const out: Omit<TargetView, 'testCopies'>[] = [];
    for (const t of this.d.finder.list('contraption')) {
      const row = this.d.store.getContraption(t.contraption!);
      if (!row) continue;
      const s = this.state.get(t.id);
      const rows = this.d.store.listContraptionDeploys(row.name, PREVIOUS + 1);
      const live = this.d.store.listContraptionDeploys(row.name, RECENT, 'deployed');
      const total = this.d.store.contraptionReleases(row.name);
      const usual = usualOf(live);
      const run = this.d.running(row.name);
      // Each deploy that went live is numbered by its place among them; rows are newest first, so count down.
      const numbers = new Map<number, number>();
      let k = 0;
      for (const r of rows) if (r.outcome === 'deployed') numbers.set(r.id, total - k++);
      for (const [i, r] of live.entries()) numbers.set(r.id, total - i);
      const release = (r: ContraptionDeployRow, link: string | null = null): Release => ({
        version: r.to_sha ?? r.from_sha ?? '',
        number: numbers.get(r.id) ?? null,
        link,
        changes: JSON.parse(r.changes),
        started: r.started_at,
        live: r.outcome === 'deployed' ? r.finished_at : null,
        outcome: r.outcome === 'deployed' ? 'live' : r.outcome,
        stages: JSON.parse(r.stages),
      });
      // While a deploy runs, the commit it started from still serves.
      const version = (run ? run.from : null) ?? s?.deployed ?? live[0]?.to_sha ?? null;
      const mine = live.find((r) => r.to_sha === version);
      // The current release is the app as it serves now; an older one can't be opened any more.
      const current: Release | null = mine ? release(mine, t.link) : version ? { version, number: live.length ? total + 1 : Math.max(total, 1), link: t.link, changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
      const recent = rows
        .filter((r) => r.id !== mine?.id)
        .slice(0, PREVIOUS)
        .map((r) => release(r));

      let lead: Progress | null = null;
      if (run) {
        const [stage, since] = Object.entries(run.stages).sort((a, b) => b[1] - a[1])[0] ?? ['build', run.started_at];
        // The drain waits for the app's running agent turns (up to 3 min): outside the pipeline, so no estimate.
        const queued = stage === 'build' && this.d.heavy ? buildWait(this.d.heavy(), `${row.name} deploy`) : null;
        const waits = stage === 'drain' ? 'its running agent turns to end' : queued;
        lead = { stage, since, usual: waits ? null : usual(stage), waitingOn: waits, text: waits ?? run.said.at(-1) ?? 'deploying' };
      } else if (s?.ahead) {
        // Say what sends it out (#629's Deploy button and auto-deploy) rather than "a deploy call" (Cara, 2026-11-12: "What does 'waiting for a deploy call' mean?").
        const what = s.ahead === 1 ? "1 change on main isn't" : `${s.ahead} changes on main aren't`;
        const text = `${what} live yet: they go out with the next deploy, from the Deploy button or by auto-deploy, at once unless more ships are coming`;
        lead = { stage: 'call', since: s.oldest ?? (this.d.now ?? Date.now)(), usual: null, waitingOn: text, text };
      }
      const changes: Change[] = lead ? (s?.changes ?? []).map((c) => ({ ...c, ...lead })) : [];
      const number = Math.max(total, current?.number ?? 0) + 1;
      out.push({ target: targetOf(t), current, next: lead ? nextOf(CONTRAPTION_TRACK, usual, lead, changes, number) : null, line: [], recent });
    }
    return out;
  }
}

/** A run's uploaded file, as GitHub's artifacts API lists it. */
export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  expires_at?: string | null;
  size_in_bytes?: number;
}

/** GitHub Actions as the release monitor reads it: CiHealth's cached reads (src/ci-health.ts). */
export interface Actions {
  workflowRuns(p: Project, workflow: string, branch: string): Promise<Run[] | null>;
  runJobs(p: Project, run: Run): Promise<Job[] | null>;
  runArtifacts?(p: Project, run: Run): Promise<Artifact[] | null>;
}

/**
 * What a run shipped, among its GitHub artifacts: the one named for the repo ("peek-auras-<sha>", "mandate-release-apk"),
 * or its only one; null when it has none left (they expire), or several and none named so.
 */
export function shippedArtifact(slug: string, list: Artifact[]): Artifact | null {
  const repo = slug.replace(/^.*\//, '').toLowerCase();
  const kept = list.filter((a) => !a.expired);
  return kept.find((x) => x.name.toLowerCase().startsWith(repo)) ?? (kept.length === 1 ? kept[0] : null);
}

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : null);
const SHA = /^[0-9a-f]{40}$/;
const secs = (from: number | null, to: number | null) => (from != null && to != null ? Math.max(0, Math.round((to - from) / 1000)) : null);
/** A target's key in the readers' maps: target ids (apk:android-release) repeat across schemes. */
const tkey = (t: Found) => `${t.projectId}:${t.id}`;
/** How long after Citadel starts a release run it waits to see it listed before it would start another. */
const SENT_MS = 3 * 60_000;

/** Re-read a workflow that isn't moving this often; one that is, every refresh. */
const IDLE_MS = 5 * 60_000;
/** Main moved past every run seen in the last FRESH_MS: its run should be listed soon, so look again this often (#764). */
const EARLY_MS = 30_000;
const FRESH_MS = 10 * 60_000;

interface RunJobs {
  run: Run;
  /** The job that ships (a ci target's), or every job (an apk's). */
  jobs: Job[];
}

/** When a run's shipping part started and ended: its job's, or the run's own for a whole-workflow target. */
function span(r: RunJobs): { start: number | null; started: number | null; end: number | null } {
  const j = r.jobs[0];
  return {
    start: ms(r.run.created_at),
    started: j ? ms(j.started_at) : ms(r.run.run_started_at ?? r.run.created_at),
    end: j ? ms(j.completed_at) : r.run.status === 'completed' ? ms(r.run.updated_at) : null,
  };
}

/** A run that shipped: completed, and its job (or the run, for a whole-workflow target) succeeded. */
const shipped = (r: RunJobs) => r.run.status === 'completed' && (r.jobs.length ? r.jobs[0].conclusion === 'success' : r.run.conclusion === 'success');
/** A needed workflow's run (Found.needs) that ran every job and each passed: a run that skipped some (NOT RUN) still says success. */
const allGreen = (r: RunJobs) =>
  r.run.status === 'completed' &&
  r.run.conclusion === 'success' &&
  r.jobs.length > 0 &&
  ciVerdict(
    r.jobs.map((j) => ciState(j.status, j.conclusion)),
    { skipBlocks: true },
  ) === 'green';
/** A needed workflow's short name, its stage on the track: "desktop.yml" → "desktop". */
const needName = (w: string) => w.replace(/^.*\//, '').replace(/\.ya?ml$/, '');

/** A run that tried to ship and didn't: its job ran (not skipped) and failed. */
const failedShip = (r: RunJobs) => r.run.status === 'completed' && (r.jobs.length ? r.jobs[0].conclusion === 'failure' : r.run.conclusion === 'failure');

/** A run as a release: linked to the file it shipped when that is in Citadel's CI store (never GitHub, which members may have no access to, #673), with its CI and package times. */
function runRelease(r: RunJobs, outcome: string, changes: Release['changes'] = [], file: string | null = null, number: number | null = null): Release {
  const s = span(r);
  const stages: Record<string, number> = {};
  const ci = secs(s.start, s.started),
    pkg = secs(s.started, s.end);
  if (ci != null) stages.ci = ci;
  if (pkg != null) stages.package = pkg;
  return { version: r.run.head_sha, number, link: file, changes, started: s.start, live: outcome === 'live' ? s.end : null, outcome, stages };
}

/** The build a desktop feed names when it is none of the target's listed runs: a by-hand one as itself, a CI one by its commit. */
function feedRelease(b: DesktopBuild, link: string): Release {
  const name = ciRun(b.source) === null ? { name: `Build ${b.build}, by hand` } : {};
  return { version: b.commit ?? b.version ?? '', number: null, ...name, link, changes: [], started: null, live: b.at, outcome: 'live', stages: {}, ...(b.commit && SHA.test(b.commit) ? { commit: b.commit } : {}) };
}

/** The usual CI and package time of the newest shipped runs. */
function runUsual(runs: RunJobs[]): (stage: string) => number | null {
  const ok = runs
    .filter(shipped)
    .slice(0, RECENT)
    .map((r) => runRelease(r, 'live'));
  return (stage) => median(ok.flatMap((r) => (typeof r.stages[stage] === 'number' ? [r.stages[stage]] : [])));
}

/** A run in flight as the lead of a next release: waiting for a runner, in CI, or packaging. */
function runProgress(r: RunJobs, usual: (stage: string) => number | null, now: number): Progress {
  const s = span(r);
  const j = r.jobs[0];
  if (j?.status === 'in_progress') return { stage: 'package', since: s.started ?? now, usual: usual('package'), waitingOn: null, text: `${j.name} running` };
  const queued = r.run.status === 'queued' || r.run.status === 'waiting' || r.run.status === 'pending';
  const text = queued ? 'waiting for a CI runner' : `${r.run.name} running`;
  return { stage: 'ci', since: s.start ?? now, usual: queued ? null : usual('ci'), waitingOn: queued ? text : null, text };
}

export interface ActionsDeps {
  store: Store;
  finder: Pick<TargetFinder, 'list'>;
  actions: Actions;
  /** Copies a shipped run's GitHub artifact into the CI store when its workflow didn't put it there (#673). */
  mirror?: Pick<CiMirror, 'want'>;
  now?: () => number;
}

/** Each workflow target's runs on main, read again every refresh while one runs and every IDLE_MS otherwise. */
class RunsCache {
  private d: ActionsDeps;
  runs = new Map<string, RunJobs[]>();
  private readAt = new Map<string, number>();
  /** What each run's commits carry since the release before it (the commit it was read from), with their files, by run id. */
  private landed = new Map<number, { from: string | null; landed: Landed | null }>();
  /** The minions in a run's commits since the shipped run before it that ship on `t` (#764). */
  changes(t: Found, r: RunJobs): Release['changes'] {
    const l = this.landed.get(r.run.id)?.landed;
    return l ? landedOn(l, shipsOnTarget(t, this.d.finder.list())).tickets.map(asChange) : [];
  }
  /** The download of what each shipped run made, in Citadel's CI store, by run id: looked up each read, since the store sweeps. */
  file(id: number): string | null {
    return this.files.get(id) ?? null;
  }
  private files = new Map<number, string>();
  /** The GitHub artifact each shipped run with nothing in the store has to mirror (null: none), by run id; listed once per run. */
  private artifacts = new Map<number, Artifact | null>();
  /** How many of the newest shipped runs get a download, and the store kind a mirrored one is filed as. */
  private keep: number;
  private kind: Kind;
  constructor(d: ActionsDeps, keep = PREVIOUS + 1, kind: Kind = 'release') {
    this.d = d;
    this.keep = keep;
    this.kind = kind;
  }

  /** Whether commit `head` touched a file in the target's folders (its workflow's push filter): one git call per head. */
  private touched = new Map<string, boolean>();
  private async touches(t: Found, head: string, dir: string): Promise<boolean> {
    const key = `${tkey(t)} ${head}`;
    if (!this.touched.has(key)) {
      if (this.touched.size > 64) this.touched.clear();
      const files = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', head], dir))?.split('\n').filter(Boolean) ?? [];
      this.touched.set(
        key,
        files.some((f) => holds(t, f)),
      );
    }
    return this.touched.get(key)!;
  }

  /** The runs of each workflow a target needs (Found.needs, #1019) on its branch, with their jobs, newest first, by target. */
  private needRuns = new Map<string, Map<string, RunJobs[]>>();

  /**
   * A run that went out to people: it shipped, and every workflow its target needs ran every job green on its commit (Peek
   * Auras' companion takes a Windows build only then: a build whose desktop tests haven't passed reaches no PC).
   */
  released(t: Found, r: RunJobs): boolean {
    if (!shipped(r)) return false;
    const need = this.needRuns.get(tkey(t));
    return !t.needs?.length || (!!need && t.needs.every((w) => (need.get(w) ?? []).some((d) => d.run.head_sha === r.run.head_sha && allGreen(d))));
  }

  /**
   * A run that reached people: released, and for a target with a desktop app, on its feed too ("Released means released",
   * Cara, 2026-11-18): the feed holds it now, or it was counted as a release once (the feed keeps only its newest few).
   */
  out(t: Found, r: RunJobs): boolean {
    if (!this.released(t, r)) return false;
    if (!this.gated(t)) return true;
    return this.onFeed(t, r.run.id) || !!this.feeds.get(tkey(t))?.counted.has(runKey(r));
  }
  /** A desktop target whose feed was read, so its runs wait for the feed; with no publisher (a dev copy) nothing is read. */
  gated(t: Found): boolean {
    return !!t.desktop && this.feeds.has(tkey(t));
  }
  /** Whether a desktop target's feed holds run `id`'s build now. */
  onFeed(t: Found, id: number): boolean {
    return !!this.feeds.get(tkey(t))?.runs.has(id);
  }
  /** A desktop target's feed, read each refresh (feed()): the CI runs it holds, the build it names, the run it followed last, and the runs counted as the target's releases. */
  private feeds = new Map<string, { runs: Set<number>; named: DesktopBuild | null; followed: number | null; failed: Record<string, string>; counted: Set<number> }>();
  feed(t: Found, index: DesktopIndex | null) {
    const builds = index?.builds ?? [];
    this.feeds.set(tkey(t), { runs: new Set(builds.flatMap((b) => ciRun(b.source) ?? [])), named: builds.find((b) => b.build === index!.current) ?? null, followed: ciRun(index?.ci), failed: index?.failed ?? {}, counted: new Set(this.recorded(t)) });
  }
  /** The build a desktop target's feed names now, what PCs get (2RE2); null for any other target, and with no build on it. */
  named(t: Found): DesktopBuild | null {
    return this.feeds.get(tkey(t))?.named ?? null;
  }
  /** The CI run a desktop target's feed followed last: a by-hand publish stands over it until CI moves on. */
  followed(t: Found): number | null {
    return this.feeds.get(tkey(t))?.followed ?? null;
  }
  /** Why a run couldn't be published, as its feed's index keeps it through a restart (2RE4). */
  kept(t: Found, run: number): string | null {
    return this.feeds.get(tkey(t))?.failed[run] ?? null;
  }
  /** The run people have now: the one a desktop feed names (undefined for a by-hand build), else the newest that went out. */
  current(t: Found): RunJobs | undefined {
    const runs = this.runs.get(tkey(t)) ?? [];
    const named = this.named(t);
    return runs.find((r) => (named ? r.run.id === ciRun(named.source) : this.out(t, r)));
  }

  /** Where a shipped run that isn't released yet is: the first workflow it needs that hasn't passed on its commit. */
  needProgress(t: Found, r: RunJobs, now: number): Progress {
    const need = this.needRuns.get(tkey(t));
    const w = t.needs!.find((x) => !(need?.get(x) ?? []).some((d) => d.run.head_sha === r.run.head_sha && allGreen(d))) ?? t.needs![0];
    const name = needName(w);
    const d = (need?.get(w) ?? []).find((x) => x.run.head_sha === r.run.head_sha);
    const wait = (text: string, since: number): Progress => ({ stage: name, since, usual: null, waitingOn: text, text });
    if (!d) return wait(`${name} not started yet`, span(r).end ?? now);
    const st = d.run.status;
    if (st === 'queued' || st === 'waiting' || st === 'pending' || st === 'requested') return wait(`${name} waiting for a CI runner`, ms(d.run.created_at) ?? now);
    if (st !== 'completed') {
      const done = d.jobs.filter((j) => j.status === 'completed').length;
      return { stage: name, since: ms(d.run.run_started_at ?? d.run.created_at) ?? now, usual: null, waitingOn: null, text: `${name} running`, ...(d.jobs.length ? { done, total: d.jobs.length } : {}) };
    }
    const why = d.run.conclusion === 'cancelled' ? 'was cancelled' : d.run.conclusion === 'success' ? "didn't run every job" : 'failed';
    return wait(`${name} ${why}: it waits on a fix`, ms(d.run.updated_at) ?? now);
  }

  /** Read a target's runs again on the next refresh, moving or not (a run was just started for it). */
  forget(t: Found) {
    this.readAt.delete(tkey(t));
  }

  async read(t: Found) {
    const p = this.d.store.getProject(t.projectId);
    if (!p || !t.workflow) return;
    const now = (this.d.now ?? Date.now)();
    const had = this.runs.get(tkey(t));
    // A needed workflow still running on a build that hasn't gone out keeps it moving too.
    const moving = had?.some((r) => r.run.status !== 'completed') || [...(this.needRuns.get(tkey(t))?.values() ?? [])].some((l) => l.some((d) => d.run.status !== 'completed'));
    const age = now - (this.readAt.get(tkey(t)) ?? 0);
    if (had && !moving && age < IDLE_MS) {
      const [head, ct] = (p.repo_dir ? (await git(['log', '-1', '--format=%H %ct', t.branch], p.repo_dir))?.trim().split(' ') : null) ?? [];
      // Early only for a push-built CI job whose filter takes the new commit: an APK's runs are Citadel's to start (it forgets them then).
      if (t.kind !== 'ci' || age < EARLY_MS || !head || had.some((r) => r.run.head_sha === head) || now - Number(ct) * 1000 > FRESH_MS) return;
      if (t.paths?.length && !(await this.touches(t, head, p.repo_dir!))) return;
    }
    const runs = await this.d.actions.workflowRuns(p, t.workflow.replace(/^.*\//, ''), t.branch);
    if (!runs) return;
    this.readAt.set(tkey(t), now);
    const out: RunJobs[] = [];
    // The newest page of runs: enough for the current, the usual times and Previous releases.
    for (const run of runs) {
      if (!t.job) {
        out.push({ run, jobs: [] });
        continue;
      }
      const jobs = await this.d.actions.runJobs(p, run);
      if (!jobs) return; // a half-read list would drop the current release: keep the last whole one
      // The API calls a job by its `name:` (its id when it has none), "name (matrix values)" for a matrix, and a name
      // built from ${{ }} by what comes before it.
      const want = (t.jobName ?? t.job).split('${{')[0].trim() || t.job;
      const job = jobs.find((j) => j.name === want || j.name.startsWith(`${want} (`)) ?? jobs.find((j) => j.name.toLowerCase().startsWith(want.toLowerCase()) || j.name === t.job);
      // A run whose job is missing or skipped (a light lane, a gate that didn't pass) shipped nothing.
      if (job && job.conclusion !== 'skipped') out.push({ run, jobs: [job] });
      else if (run.status !== 'completed') out.push({ run, jobs: [] });
    }
    if (t.needs?.length) {
      const need = new Map<string, RunJobs[]>();
      for (const w of t.needs) {
        const list = await this.d.actions.workflowRuns(p, w, t.branch);
        if (!list) return;
        const read: RunJobs[] = [];
        for (const run of list) {
          // Only the commits this target's runs built matter, and a finished run's jobs are kept by the poller.
          if (!out.some((r) => r.run.head_sha === run.head_sha)) continue;
          const jobs = await this.d.actions.runJobs(p, run);
          if (!jobs) return;
          read.push({ run, jobs });
        }
        need.set(w, read);
      }
      this.needRuns.set(tkey(t), need);
    }
    this.runs.set(tkey(t), out);
    const kept = new Set([...this.runs.values()].flat().map((r) => r.run.id));
    for (const id of this.landed.keys()) if (!kept.has(id)) this.landed.delete(id);
    for (const id of this.files.keys()) if (!kept.has(id)) this.files.delete(id);
    for (const id of this.artifacts.keys()) if (!kept.has(id)) this.artifacts.delete(id);
    const slug = repoSlug(p.repo_url);
    // The runs a page can show a download for: the newest few that shipped (a release target's current and Previous).
    // A run's build or release in Citadel's own CI store (#658) is its download, read each time since the store sweeps.
    const stored = this.d.store.ciFiles(p.id).filter((f) => f.kind !== 'report');
    for (const r of out.filter(shipped).slice(0, this.keep)) {
      const mine = stored.find((f) => f.run_id === r.run.id && f.kind === 'release') ?? stored.find((f) => f.run_id === r.run.id);
      if (mine) {
        this.files.set(r.run.id, `/api/projects/${p.id}/ci-files/${mine.id}/${encodeURIComponent(mine.name)}`);
        continue;
      }
      this.files.delete(r.run.id);
      // Not in the store (its workflow uploads only to GitHub, or it was swept): mirror its artifact while GitHub keeps it.
      if (!slug || !this.d.mirror || !this.d.actions.runArtifacts) continue;
      if (!this.artifacts.has(r.run.id)) {
        const list = await this.d.actions.runArtifacts(p, r.run);
        if (!list) continue;
        this.artifacts.set(r.run.id, shippedArtifact(slug, list));
      }
      const a = this.artifacts.get(r.run.id);
      if (!a || (a.expires_at && Date.parse(a.expires_at) <= now)) continue;
      this.d.mirror.want({ project: p, slug, run: r.run, artifact: a, workflow: t.workflow.replace(/^.*\//, ''), kind: this.kind, target: t.job ?? '', done: () => this.forget(t) });
    }
    // What each run carries since the run before it that went out (read again only when that one changes): a build
    // that shipped but never went out (its needed workflow cancelled) hands what it carried on to the next.
    if (p.repo_dir) {
      for (const [i, r] of out.entries()) {
        // shortcut: with no release in the page of runs, read from the oldest run listed; misses what landed before it.
        const prev = out.slice(i + 1).find((x) => this.out(t, x)) ?? (t.needs?.length ? out.at(-1) : undefined);
        const from = prev && prev !== r && prev.run.head_sha !== r.run.head_sha ? prev.run.head_sha : null;
        const had = this.landed.get(r.run.id);
        if (had && had.from === from && r.run.status === 'completed') continue;
        this.landed.set(r.run.id, { from, landed: from ? await landedIn(this.d.store, p, from, r.run.head_sha) : null });
      }
    }
  }

  /**
   * Write a releases row for each shipped run newer than the last one written (only the newest, the first time), so a
   * target counts its releases from 1 with no gaps, rather than by GitHub's run number, which counts every run.
   */
  record(t: Found) {
    const seen = new Set(this.recorded(t));
    // Every shipped run in view is counted, those from before counting began too (Cara, 2026-11-12: "This should say
    // the build number, not "earlier release""); they're numbered by run, so a late one slots into its place.
    for (const r of (this.runs.get(tkey(t)) ?? []).filter((r) => this.out(t, r) && !seen.has(runKey(r))).reverse()) {
      const s = span(r);
      // Live once the last workflow it needs finished, when that was after its own job.
      const gated = [...(this.needRuns.get(tkey(t))?.values() ?? [])].flatMap((l) => l.filter((d) => d.run.head_sha === r.run.head_sha && allGreen(d)).map((d) => ms(d.run.updated_at) ?? 0));
      const live = Math.max(s.end ?? 0, ...gated) || s.end;
      this.d.store.addRelease({ project_id: t.projectId, target: t.id, version: `run:${runKey(r)}`, changes: '[]', started_at: s.start, live_at: live, outcome: 'live', stages: '{}' });
    }
  }

  /** The runs counted as releases, newest first: by run, since the ones from before counting began were added after. */
  private recorded(t: Found): number[] {
    return this.d.store
      .listReleases(t.projectId, t.id, -1)
      .map((r) => Number(r.version.replace(/^run:/, '')))
      .sort((a, b) => b - a);
  }

  /** What is on `t`'s branch since commit `from` and ships on `t`, read again when either end moves (#764); null: not known. */
  async since(t: Found, from: string | null): Promise<Landed | null> {
    const p = this.d.store.getProject(t.projectId);
    const head = p?.repo_dir && from ? (await git(['rev-parse', '--verify', '--quiet', `${t.branch}^{commit}`], p.repo_dir))?.trim() : null;
    if (!p || !from || !head) return null;
    const key = `${from}..${head}`;
    const had = this.ahead.get(tkey(t));
    if (had?.key === key) return had.landed;
    const all = head === from ? { commits: new Map(), tickets: [], files: new Map(), ticketFiles: new Map() } : await landedIn(this.d.store, p, from, head);
    const landed = all && landedOn(all, shipsOnTarget(t, this.d.finder.list()));
    this.ahead.set(tkey(t), { key, landed });
    return landed;
  }
  private ahead = new Map<string, { key: string; landed: Landed | null }>();

  /** The release number of each recorded run, and how many there are: the newest's number; by GitHub's run number for a target numbered so. */
  numbers(t: Found): { of: (r: RunJobs) => number | null; total: number } {
    if (t.numbering?.number === 'run') return { of: (r) => r.run.run_number ?? null, total: 0 };
    const runs = this.recorded(t);
    const by = new Map(runs.map((run, i) => [run, runs.length - i]));
    return { of: (r) => by.get(runKey(r)) ?? null, total: runs.length };
  }
}

/** A run's key in the releases table: its run number. */
const runKey = (r: RunJobs) => r.run.run_number ?? r.run.id;

export const CI_TRACK = ['ci', 'package', 'live'];

export interface CiPackageDeps extends ActionsDeps {
  /** Each scheme's last green and the roll back pins (src/last-green.ts, ADR 0012). */
  lastGreen?: { get: (projectId: number) => Green | null; pinned: (projectId: number, target: string) => Pin | null };
  contains?: Contains;
  /** Publish a run's build to the target's desktop feed (src/desktop-feed.ts ciPublisher), and why a run's publish failed. */
  desktop?: ((t: Found & { desktop: DesktopTarget }, run: { id: number; sha: string }) => unknown) & { failed?: (projectId: number, app: string, run: number) => string | null };
  /** A desktop app's feed (src/desktop-feed.ts DesktopFeeds): a desktop target's run is live only once the feed has it. */
  feeds?: { index: (projectId: number, app: string) => Promise<DesktopIndex | null> };
}

/** A CI package (Peek Auras' Windows build): a release is the newest run on main whose shipping job passed; the next is a run in flight. */
export class CiPackageReader implements Reader {
  private d: CiPackageDeps;
  private cache: RunsCache;
  /** What is on main past the current release and ships on it (#764), by target. */
  private pending = new Map<string, Landed | null>();
  /** Last green's build by target: the newest released run with a download whose commit last green holds. */
  private greens = new Map<string, { run: number; sha: string; workflow: string }>();
  /** Whether a run's commit is in last green's history, by "<green> <commit>": answers don't change. */
  private inGreen = new Map<string, boolean>();
  constructor(d: CiPackageDeps) {
    this.d = d;
    this.cache = new RunsCache(d);
  }

  async refresh() {
    for (const t of this.d.finder.list('ci')) {
      // A desktop target's build is out once its feed has it, not when CI ships it (#1522): read the feed first.
      if (t.desktop && this.d.desktop) {
        const index = await this.d.feeds?.index(t.projectId, t.desktop.app).catch(() => null);
        this.cache.feed(t, index ?? null);
      }
      await this.cache.read(t);
      this.cache.record(t);
      const runs = this.cache.runs.get(tkey(t)) ?? [];
      const cur = this.cache.current(t);
      const made = this.cache.named(t)?.commit;
      // A by-hand build that doesn't say its whole commit: what is on main since the newest run that went out.
      const base = cur ?? runs.find((r) => this.cache.out(t, r)) ?? (t.needs?.length ? runs.at(-1) : undefined);
      this.pending.set(tkey(t), await this.cache.since(t, !cur && made && SHA.test(made) ? made : (base?.run.head_sha ?? null)));
      // A desktop app's feed follows what CI ships: the pinned build in a roll back, else the newest released one (#1148).
      const pin = this.d.lastGreen?.pinned(t.projectId, t.id)?.build;
      const shippedRun = runs.find((r) => this.cache.released(t, r));
      const out = pin ? { id: pin.run, sha: pin.sha } : shippedRun ? { id: shippedRun.run.id, sha: shippedRun.run.head_sha } : null;
      if (t.desktop && out) void this.d.desktop?.({ ...t, desktop: t.desktop }, out);
      await this.findGreen(t, runs);
    }
  }

  /** Find last green's build of `t` among its runs (ADR 0012): the build a roll back holds it at. */
  private async findGreen(t: Found, runs: RunJobs[]) {
    const green = this.d.lastGreen?.get(t.projectId);
    const dir = this.d.store.getProject(t.projectId)?.repo_dir;
    if (!green || !dir || !this.d.contains || !t.workflow) return void this.greens.delete(tkey(t));
    for (const r of runs) {
      if (!this.cache.released(t, r) || !this.cache.file(r.run.id)) continue;
      const key = `${green.sha} ${r.run.head_sha}`;
      if (!this.inGreen.has(key)) {
        if (this.inGreen.size > 500) this.inGreen.clear();
        const yes = await this.d.contains(dir, r.run.head_sha, green.sha);
        // git couldn't tell: keep what it found before (the CI store keeps that build meanwhile) and ask again next refresh
        if (yes === null) return;
        this.inGreen.set(key, yes);
      }
      if (this.inGreen.get(key)) return void this.greens.set(tkey(t), { run: r.run.id, sha: r.run.head_sha, workflow: t.workflow.replace(/^.*\//, '') });
    }
    this.greens.delete(tkey(t));
  }

  /** Last green's build of a target, with a download in the CI store; null when none is in view. */
  greenBuild(projectId: number, target: string): { run: number; sha: string; workflow: string } | null {
    return this.greens.get(`${projectId}:${target}`) ?? null;
  }

  /** The runs the CI store keeps whatever its rules say, as "<projectId>/<run id>": each target's last green build and pinned build. */
  keeps(): Set<string> {
    const out = new Set<string>();
    for (const [k, g] of this.greens) out.add(`${k.split(':')[0]}/${g.run}`);
    for (const t of this.d.finder.list('ci')) {
      const b = this.d.lastGreen?.pinned(t.projectId, t.id)?.build;
      if (b) out.add(`${t.projectId}/${b.run}`);
    }
    return out;
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const now = (this.d.now ?? Date.now)();
    return this.d.finder.list('ci').map((t) => {
      const runs = this.cache.runs.get(tkey(t)) ?? [];
      const ch = (r: RunJobs) => this.cache.changes(t, r);
      const file = (r: RunJobs) => this.cache.file(r.run.id);
      const num = this.cache.numbers(t);
      // A desktop app's current build links its first install (the launcher and that build), not the bare build (#1148).
      const installs = (r: RunJobs | undefined) => (r && t.desktop ? desktopPaths(t.projectId, t.desktop.app).install : r ? file(r) : null);
      const out = (r: RunJobs) => this.cache.out(t, r);
      // A desktop target's run CI released that its feed hasn't taken: on its way, or refused (#1522).
      const gated = this.cache.gated(t);
      const why = (run: number) => (gated && !this.cache.onFeed(t, run) ? (this.d.desktop?.failed?.(t.projectId, t.desktop!.app, run) ?? this.cache.kept(t, run)) : null);
      const publishFailed = (r: RunJobs) => this.cache.released(t, r) && why(r.run.id) !== null;
      const refusal = (run: number, what: string) => `${why(run) === NO_FILE ? `${what} isn't in the CI store` : `the desktop feed couldn't take ${what}`}: it waits on a fix`;
      const tried = (r: RunJobs) => out(r) || failedShip(r) || publishFailed(r);
      const was = (r: RunJobs) => runRelease(r, out(r) ? 'live' : 'failed', ch(r), out(r) || !t.desktop ? file(r) : null, num.of(r));
      // Held at last green's build by a roll back (ADR 0012): that build is what people get until the pin goes, and its
      // card's roll back line says what waits. A desktop app's pinned build is that only once its feed has it.
      const pinned = this.d.lastGreen?.pinned(t.projectId, t.id)?.build;
      const heldRun = pinned && runs.find((r) => r.run.id === pinned.run);
      const named = this.cache.named(t);
      const held = pinned && (named ? ciRun(named.source) === pinned.run : !gated || (heldRun && out(heldRun))) ? pinned : null;
      if (held) {
        const recent = runs
          .filter((r) => r !== heldRun && tried(r))
          .slice(0, PREVIOUS)
          .map(was);
        // Newer runs can push the held one out of the page GitHub lists: it is still what people get, so show it from the pin.
        const current = heldRun ? runRelease(heldRun, 'live', ch(heldRun), installs(heldRun), num.of(heldRun)) : { version: held.sha, number: null, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} };
        return { target: targetOf(t), current, next: null, line: [], recent };
      }
      const cur = this.cache.current(t);
      const current = cur ? runRelease(cur, 'live', ch(cur), installs(cur), num.of(cur)) : named ? feedRelease(named, desktopPaths(t.projectId, t.desktop!.app).install) : null;
      // A build that shipped but never went out (its needed workflow didn't pass) reached no one: not a release, nor a failed one.
      const recent = runs
        .filter((r) => r !== cur && tried(r))
        .slice(0, PREVIOUS)
        .map(was);
      const ciUsual = runUsual(runs);
      // Publishing takes seconds: no stage of its own to wait out in an estimate.
      const usual = (stage: string) => (stage === 'publish' ? 0 : ciUsual(stage));
      const track = [...CI_TRACK.slice(0, -1), ...(t.needs ?? []).map(needName), ...(gated ? ['publish'] : []), 'live'];
      const publishing = (since: number, what: string): Progress => ({ stage: 'publish', since, usual: 0, waitingOn: null, text: `publishing ${what}to the desktop feed` });
      if (pinned && gated) {
        // The feed doesn't name the roll back's build: on its way, refused, or a by-hand build went out over it.
        const since = this.d.lastGreen!.pinned(t.projectId, t.id)!.at;
        const text = why(pinned.run) === null ? null : refusal(pinned.run, "the roll back's build");
        const lead = text ? { stage: 'publish', since, usual: null, waitingOn: text, text } : publishing(since, "the roll back's build ");
        return { target: targetOf(t), current, next: this.cache.followed(t) === pinned.run ? null : nextOf(track, usual, lead, [], null), line: [], recent };
      }
      // The newest run in flight leads, or one that shipped and waits on a workflow it needs; a run older than the current release can't be its next.
      const place = cur ? runs.indexOf(cur) : runs.findIndex((r) => (named ? r.run.id === this.cache.followed(t) : out(r)));
      const newer = (r: RunJobs) => place < 0 || runs.indexOf(r) < place;
      // Only the newest released run is ever put on the feed (2RE4): an older one that isn't there is superseded.
      const top = runs.find((r) => this.cache.released(t, r));
      const toPublish = gated && top && top !== cur && this.cache.followed(t) !== top.run.id ? top : null;
      const moving = runs.slice(0, top ? runs.indexOf(top) + 1 : undefined).find((r) => newer(r) && (r.run.status !== 'completed' || (r === top ? r === toPublish && !publishFailed(r) : !!t.needs?.length && shipped(r))));
      const running = !moving ? null : moving.run.status !== 'completed' ? runProgress(moving, usual, now) : moving === toPublish ? publishing(span(moving).end ?? now, '') : this.cache.needProgress(t, moving, now);
      // On main past the current release and not in a run in flight (#764): waiting for CI to build it, or for a fix
      // when the newest run after the current release failed.
      const ahead = this.pending.get(tkey(t));
      const failed = runs.find((r) => r.run.status === 'completed' && newer(r));
      const text = failed && failedShip(failed) ? 'CI failed on main: it waits on a fix' : failed && publishFailed(failed) ? refusal(failed.run.id, 'its build') : 'on main: it goes out with the next build CI ships';
      const waiting: Progress | null = ahead?.commits.size ? { stage: 'ci', since: Math.min(...ahead.commits.values()), usual: null, waitingOn: text, text } : null;
      const inRun = new Set(moving ? ch(moving).map((c) => c.ticketId) : []);
      const changes: Change[] = [
        ...(running ? ch(moving!).map((c) => ({ ...c, ...running })) : []),
        // Past the run in flight: not in its build, so not under its number.
        ...(waiting ? (ahead?.tickets ?? []).filter((x) => !inRun.has(x.id)).map((x) => ({ ...asChange(x), ...waiting, ...(moving ? { later: true } : {}) })) : []),
      ];
      const lead = running ?? waiting;
      // A target numbered by run knows its number once its run exists.
      const number = t.numbering?.number === 'run' ? (moving?.run.run_number ?? null) : num.total + 1;
      return { target: targetOf(t), current, next: lead ? nextOf(track, usual, lead, changes, number) : null, line: [], recent };
    });
  }
}

export const APK_TRACK = ['sign', 'publish', 'live'];

/** A release workflow's run as a signed APK: signing is the whole run. */
function apkRun(r: RunJobs, outcome: string, file: string | null = null, number: number | null = null): Release {
  const s = span(r);
  const sign = secs(s.start, s.end);
  return { ...runRelease(r, outcome, [], file, number), live: outcome === 'live' ? s.end : null, stages: sign != null ? { sign } : {} };
}

/** latest.json, as its app's update banner reads it. */
interface Feed {
  versionCode: number;
  apk?: string;
  versionName?: string;
  /** When it was written (ms). */
  at: number;
}

export interface ApkDeps extends ActionsDeps {
  /** The contraption's latest.json, or null when it has none. */
  feed: (contraption: string) => Promise<Feed | null>;
  /** A target's roll back pin (src/last-green.ts): one with a `code` has a release run signing last green (ADR 0012). */
  pinned?: (projectId: number, target: string) => Pin | null;
  /** That run signed an APK: publish it (as `current`'s next, `code`). Called once per run. */
  rolledBack?: (t: Found, run: Run, current: number, code: number) => void;
  /** That run failed: the roll back didn't go out. */
  rollbackFailed?: (t: Found, why: string) => void;
}

/** The branch a CI-signed APK's roll back signs last green on: Citadel's own, pointed at the commit each time (ADR 0012). */
export const ROLLBACK_BRANCH = 'citadel/rollback';

/** The versionCode and versionName in an app/build.gradle's text. */
export function gradleVersion(text: string): { code: number; name: string | null } | null {
  const code = /versionCode\s*=?\s*(\d+)/.exec(text)?.[1];
  return code ? { code: Number(code), name: /versionName\s*=?\s*["']([^"']+)["']/.exec(text)?.[1] ?? null } : null;
}

/**
 * An Android app people install (Mandate's): a release is what its app serves in latest.json. A version bumped on main
 * is its next release: waiting for someone to start the release workflow, signing on CI, then waiting for someone to
 * publish the APK (android/README.md, "Publishing an APK"). With no latest.json, its runs stand in for releases.
 */
export class ApkReader implements Reader {
  private d: ApkDeps;
  private cache: RunsCache;
  private feeds = new Map<string, Feed | null>();
  /** The version on main: its gradle file's, read again when main moves. */
  private mains = new Map<string, { head: string; code: number; name: string | null } | null>();
  /** Signed runs whose APK turned out no newer than the published one: not a release to publish (#629). */
  private old = new Set<number>();
  /** When Citadel last started a release run: GitHub can take a while to list it, and till then it would look unstarted. */
  private sent = new Map<string, number>();
  /** What is on main since the published APK's commit and touches the app's folder (#764), by target. */
  private ahead = new Map<string, Landed | null>();
  /** The commit the published APK was built from, by target. */
  private builtAt = new Map<string, string>();
  /** Roll back runs already handed on (published or failed), by run id. */
  private handled = new Set<number>();
  /** A target's runs on the roll back branch, as a target of their own in the runs cache. */
  private rb = (t: Found): Found => ({ ...t, id: `${t.id}#rollback`, branch: ROLLBACK_BRANCH });
  constructor(d: ApkDeps) {
    this.d = d;
    this.cache = new RunsCache(d);
  }

  async refresh() {
    for (const t of this.d.finder.list('apk')) {
      await this.cache.read(t);
      if (t.contraption) this.feeds.set(tkey(t), await this.d.feed(t.contraption));
      // With no latest.json its signed runs are its releases, numbered as a CI package's.
      const feed = this.feeds.get(tkey(t));
      if (!feed) this.cache.record(t);
      // The published APK's commit: the run Citadel published it from, else (a hand publish) the newest signed run from before
      // latest.json was written.
      const runs = this.cache.runs.get(tkey(t)) ?? [];
      // Held by a roll back that signs last green again (ADR 0012): its run on the roll back branch, read while pinned.
      const pin = this.d.pinned?.(t.projectId, t.id);
      const pub = feed && t.contraption ? this.d.store.lastApkPublish(t.projectId, t.contraption) : null;
      // Also after the pin ends, while the published APK is still the roll back's: its card names that run's commit.
      const fromBack = !!pub && pub.version_code === feed?.versionCode && !runs.some((r) => r.run.id === pub.run_id);
      if ((pin?.code || fromBack) && t.workflow) {
        // Read every refresh until it is published: GitHub can take a while to list a dispatched run.
        if (pin?.code && feed && feed.versionCode < pin.code) this.cache.forget(this.rb(t));
        await this.cache.read(this.rb(t));
      }
      const back = this.cache.runs.get(tkey(this.rb(t))) ?? [];
      const built = !feed ? null : ((pub?.version_code === feed.versionCode ? [...runs, ...back].find((r) => r.run.id === pub.run_id) : null) ?? runs.find((r) => shipped(r) && (ms(r.run.created_at) ?? Infinity) <= feed.at));
      if (built) this.builtAt.set(tkey(t), built.run.head_sha);
      else this.builtAt.delete(tkey(t));
      if (pin?.code && feed) {
        // The newest run of last green there since the press: published once signed, or the roll back ends if it failed.
        const r = this.backRun(t, pin);
        if (r && r.run.status === 'completed' && !this.handled.has(r.run.id) && feed.versionCode < pin.code) {
          this.handled.add(r.run.id);
          if (shipped(r)) this.d.rolledBack?.(t, r.run, feed.versionCode, pin.code);
          else this.d.rollbackFailed?.(t, `its release run on ${ROLLBACK_BRANCH} ${r.run.conclusion ?? 'ended'}${r.run.html_url ? `: ${r.run.html_url}` : ''}`);
        }
      }
      this.ahead.set(tkey(t), appChanges(t, await this.cache.since(t, built?.run.head_sha ?? null)));
      const p = this.d.store.getProject(t.projectId);
      if (!p?.repo_dir) continue;
      const head = (await git(['rev-parse', '--verify', '--quiet', `${t.branch}^{commit}`], p.repo_dir))?.trim();
      if (!head || this.mains.get(tkey(t))?.head === head) continue;
      const files = (await git(['ls-tree', '-r', '--name-only', head], p.repo_dir)) ?? '';
      const gradle = files.split('\n').find((f) => /(^|\/)app\/build\.gradle(\.kts)?$/.test(f));
      const v = gradle ? gradleVersion((await git(['show', `${head}:${gradle}`], p.repo_dir)) ?? '') : null;
      this.mains.set(tkey(t), v && { head, ...v });
    }
  }

  /**
   * What its next release waits on that Citadel can do itself (#629): a version bumped on main with no signed APK of
   * it yet waits for a release run (`dispatch`, at main's head); a signed one waits to be published (`publish`, the
   * newest signed run). Null while a run is moving, with nothing waiting, or with no latest.json to publish into.
   */
  pending(t: Found): { step: 'dispatch'; head: string } | { step: 'publish'; run: Run; current: number; main: { code: number; name: string | null } } | null {
    const feed = this.feeds.get(tkey(t));
    const main = this.mains.get(tkey(t));
    const runs = this.cache.runs.get(tkey(t)) ?? [];
    if (!feed || !main || main.code <= feed.versionCode || runs.some((r) => r.run.status !== 'completed')) return null;
    if ((this.d.now ?? Date.now)() - (this.sent.get(tkey(t)) ?? -Infinity) < SENT_MS) return null;
    const signed = runs.find((r) => shipped(r) && !this.old.has(r.run.id) && (ms(r.run.created_at) ?? 0) > feed.at);
    return signed ? { step: 'publish', run: signed.run, current: feed.versionCode, main: { code: main.code, name: main.name } } : { step: 'dispatch', head: main.head };
  }

  /** The newest release run of a roll back's commit on the roll back branch since it was pressed (a minute's clock slack). */
  private backRun(t: Found, pin: Pin): RunJobs | null {
    return (this.cache.runs.get(tkey(this.rb(t))) ?? []).find((x) => x.run.head_sha === pin.sha && (ms(x.run.created_at) ?? 0) >= pin.at - 60_000) ?? null;
  }

  /** A roll back's release run is signing or waits to be published (ADR 0012). */
  rollingBack(projectId: number, target: string): boolean {
    const t = this.d.finder.list('apk').find((f) => f.projectId === projectId && f.id === target);
    const pin = t && this.d.pinned?.(projectId, target);
    if (!t || !pin?.code) return false;
    const feed = this.feeds.get(tkey(t));
    return !!feed && feed.versionCode < pin.code;
  }

  /** The versionCode its app serves now; null until its feed and its roll back's runs were read since the start (2RE1). */
  published(projectId: number, target: string): number | null {
    const t = this.d.finder.list('apk').find((f) => f.projectId === projectId && f.id === target);
    if (!t || (t.workflow && !this.cache.runs.has(tkey(this.rb(t))))) return null;
    return this.feeds.get(tkey(t))?.versionCode ?? null;
  }

  /** A release run was just started for it: read its runs again on the next refresh, and start no other for a while. */
  started(t: Found) {
    this.cache.forget(t);
    this.cache.forget(this.rb(t));
    this.sent.set(tkey(t), (this.d.now ?? Date.now)());
  }

  /** Run `runId` signed an APK no newer than the published one (built before the bump): it waits for a new run instead. */
  tooOld(runId: number) {
    this.old.add(runId);
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const now = (this.d.now ?? Date.now)();
    return this.d.finder.list('apk').map((t) => {
      const runs = this.cache.runs.get(tkey(t)) ?? [];
      const signs = runs
        .filter(shipped)
        .slice(0, RECENT)
        .flatMap((r) => apkRun(r, 'live').stages.sign ?? []);
      const usual = (s: string) => (s === 'sign' ? median(signs) : null);
      const feed = this.feeds.get(tkey(t));
      const main = this.mains.get(tkey(t));
      const file = (r: RunJobs) => this.cache.file(r.run.id);
      const moving = runs.find((r) => r.run.status !== 'completed');
      /** The run in flight, signing; waiting while no runner has it. */
      const signing = (r: RunJobs): Progress => {
        const p = runProgress(r, usual, now);
        return { ...p, stage: 'sign', usual: p.waitingOn ? null : usual('sign'), text: p.waitingOn ? p.text : 'signing on CI' };
      };
      if (!feed) {
        // No feed to read: the newest signed run is the release, as for a CI package.
        const num = this.cache.numbers(t);
        const cur = runs.find(shipped);
        const recent = runs
          .filter((r) => r !== cur && (shipped(r) || failedShip(r)))
          .slice(0, PREVIOUS)
          .map((r) => apkRun(r, shipped(r) ? 'live' : 'failed', file(r), num.of(r)));
        const lead = moving && (!cur || runs.indexOf(moving) < runs.indexOf(cur)) ? signing(moving) : null;
        return { target: targetOf(t), current: cur ? apkRun(cur, 'live', file(cur), num.of(cur)) : null, next: lead ? nextOf(APK_TRACK, usual, lead, [], num.total + 1) : null, line: [], recent };
      }
      // Numbered by its versionCode, the counter its app's update banner reads; the versionName stays as the detail.
      const version = main?.code === feed.versionCode && main.name ? main.name : (feed.versionName ?? String(feed.versionCode));
      const link = feed.apk && t.contraption ? `/apps/${t.contraption}/android/${feed.apk}` : t.link;
      const at = this.builtAt.get(tkey(t));
      const current: Release = { version, number: feed.versionCode, link, changes: [], started: null, live: feed.at, outcome: 'live', stages: {}, ...(at ? { commit: at } : {}) };
      // Its signed runs, as the APKs people could have been given: not releases, so no release number.
      const recent = runs
        .filter((r) => shipped(r) || failedShip(r))
        .slice(0, PREVIOUS)
        .map((r) => apkRun(r, shipped(r) ? 'signed' : 'failed', file(r)));
      let lead: Progress | null = null;
      let tryIt: string | null = null;
      const ahead = this.ahead.get(tkey(t));
      const bumped = !!main && main.code > feed.versionCode;
      const pin = this.d.pinned?.(t.projectId, t.id);
      if (pin?.code && feed.versionCode < pin.code) {
        // A roll back signing last green again as build pin.code (ADR 0012).
        const r = this.backRun(t, pin);
        if (r && r.run.status !== 'completed') lead = signing(r);
        else {
          const text = r && shipped(r) ? `Last green is signed as build ${pin.code}: Citadel publishes it within a minute` : `Last green's release run on ${ROLLBACK_BRANCH} hasn't started yet`;
          lead = { stage: r && shipped(r) ? 'publish' : 'sign', since: (r && span(r).end) ?? pin.at, usual: null, waitingOn: text, text };
          if (r && shipped(r)) tryIt = file(r);
        }
        return { target: targetOf(t), current, next: nextOf(APK_TRACK, usual, lead, [], pin.code, tryIt), line: [], recent };
      }
      if (bumped) {
        const signed = runs.find((r) => shipped(r) && !this.old.has(r.run.id) && (ms(r.run.created_at) ?? 0) > feed.at);
        const name = main.name ?? `Release ${main.code}`;
        if (moving) lead = signing(moving);
        else if (signed) {
          const text = `${name} is signed: it goes out with the Deploy button, or by auto-deploy, at once unless more ships are coming`;
          lead = { stage: 'publish', since: span(signed).end ?? now, usual: null, waitingOn: text, text };
          tryIt = file(signed);
        } else {
          const text = `${name} is on main, but its release run hasn't started: the Deploy button starts it, or auto-deploy, at once unless more ships are coming`;
          lead = { stage: 'sign', since: feed.at, usual: null, waitingOn: text, text };
        }
      } else if (ahead?.commits.size) {
        // Changes to the app on main with the version unchanged: no release run builds them until it is bumped (#764).
        const what = ahead.commits.size === 1 ? '1 change to the app on main waits' : `${ahead.commits.size} changes to the app on main wait`;
        const text = `${what} on a version bump: a release needs a higher versionCode`;
        lead = { stage: 'sign', since: Math.min(...ahead.commits.values()), usual: null, waitingOn: text, text };
      }
      const changes: Change[] = lead ? (ahead?.tickets ?? []).map((x) => ({ ...asChange(x), ...lead, ...(!bumped ? { idle: true } : {}) })) : [];
      return { target: targetOf(t), current, next: lead ? nextOf(APK_TRACK, usual, lead, changes, bumped ? main!.code : null, tryIt) : null, line: [], recent };
    });
  }
}

export const MAIN_TRACK = ['checks', 'merge', 'live'];
/** The stages a change goes through before it is on main: an open PR's checks, then a person's go to land (the stage key stays merge; the page says Land). */
const PR_STAGES = ['checks', 'merge'];
/** Each kind's own stages, after a PR's, for a target whose next release is only PRs. */
const TRACKS: Record<string, string[]> = { contraption: CONTRAPTION_TRACK, ci: CI_TRACK, apk: APK_TRACK };

export interface PrDeps {
  store: Store;
  /** A minion's PR as the PR watcher last saw it (src/github.ts), or null. */
  pr: (ticketId: number) => PrSnapshot | null;
  /** Its PR's CI in flight (src/ci-wait.ts CiRuns.view): since when, and the usual length. */
  ci?: (ticketId: number) => { since: number; usual: number | null; text: string } | null;
  now?: () => number;
}

export interface MainDeps extends PrDeps {
  finder: Pick<TargetFinder, 'list'>;
}

/**
 * A scheme's changes on their way to main: its minions' open PRs, their checks running or failed, then waiting for a
 * go to merge. Main shows them as its next release; any other scheme's first target takes them in ahead of its own
 * stages (attach), since what merges is what it ships next (#655).
 */
export class PrsInFlight {
  private d: PrDeps;
  /** When each change was first seen at its stage ("<ticket>:<stage>" → ms), so a poll doesn't move it. */
  private seen = new Map<string, number>();
  constructor(d: PrDeps) {
    this.d = d;
  }

  private since(id: number, stage: string, now: number): number {
    const key = `${id}:${stage}`;
    // A PR back at its checks (a new push) starts them again.
    for (const s of ['checks', 'failed', 'merge']) if (s !== stage) this.seen.delete(`${id}:${s}`);
    if (!this.seen.has(key)) this.seen.set(key, now);
    return this.seen.get(key)!;
  }

  /** Where one open PR is: its checks running or failed, or waiting for a go to land. */
  private progress(id: number, pr: PrSnapshot, now: number): Progress {
    const v = verdict(pr.checks);
    if (v === 'pending') {
      const ci = this.d.ci?.(id);
      const queued = pr.checks.some((c) => c.status === 'pending' && c.queued);
      const text = queued ? 'its checks wait for a CI runner' : (ci?.text ?? 'checks running');
      return { stage: 'checks', since: ci?.since ?? this.since(id, 'checks', now), usual: queued ? null : (ci?.usual ?? null), waitingOn: queued ? text : null, text };
    }
    if (v === 'failed') {
      const text = 'its checks failed: the minion fixes them';
      return { stage: 'checks', since: this.since(id, 'failed', now), usual: null, waitingOn: text, text };
    }
    const text = `PR #${pr.number} waits for a go to ship`;
    return { stage: 'merge', since: this.since(id, 'merge', now), usual: null, waitingOn: text, text };
  }

  /** A scheme's open PRs (not drafts) of minions still open, the furthest along first. */
  changes(projectId: number): Change[] {
    const now = (this.d.now ?? Date.now)();
    const changes: Change[] = [];
    for (const x of this.d.store.listTickets(projectId)) {
      const pr = x.kind === 'ticket' && x.status !== 'closed' && x.branch ? this.d.pr(x.id) : null;
      if (pr?.state !== 'OPEN' || pr.draft) {
        for (const s of ['checks', 'failed', 'merge']) this.seen.delete(`${x.id}:${s}`);
        continue;
      }
      changes.push({ ticketId: x.id, number: x.number, title: x.title, ...this.progress(x.id, pr, now) });
    }
    return changes.sort((a, b) => MAIN_TRACK.indexOf(b.stage) - MAIN_TRACK.indexOf(a.stage) || a.since - b.since);
  }

  /**
   * Each scheme's open PRs, on the first of its targets as the readers list them (its contraption, else its CI
   * package, else its APK; a file target only when it has nothing else), so All shows each PR once (#655). Main reads
   * its own, and Citadel's server its land line.
   */
  attach(views: Omit<TargetView, 'testCopies'>[]) {
    const schemes = new Map<number, Omit<TargetView, 'testCopies'>[]>();
    for (const v of views) (schemes.get(v.target.projectId) ?? schemes.set(v.target.projectId, []).get(v.target.projectId)!).push(v);
    for (const [projectId, list] of schemes) {
      if (list.some((v) => v.target.kind === 'main' || v.target.id === CITADEL_TARGET)) continue;
      const tv = list.find((v) => v.target.kind !== 'file') ?? list[0];
      const has = new Set(tv.next?.changes.map((c) => c.ticketId));
      const prs = this.changes(projectId).filter((c) => !has.has(c.ticketId));
      if (!prs.length) continue;
      const checks = { name: 'checks', usual: prs.find((c) => c.stage === 'checks')?.usual ?? null };
      if (tv.next) {
        // Its own release leads: it is further along than anything not yet on main.
        tv.next = { ...tv.next, stages: [checks, { name: 'merge', usual: null }, ...tv.next.stages], changes: [...tv.next.changes, ...prs] };
        continue;
      }
      const { ticketId: _i, number: _n, title: _t, ...lead } = prs[0];
      // An APK's is its versionCode, not known before the bump; a run-numbered target's, not before its run.
      const number = tv.target.kind === 'apk' || tv.target.numbering?.number === 'run' || tv.current?.number == null ? null : tv.current.number + 1;
      tv.next = nextOf([...PR_STAGES, ...(TRACKS[tv.target.kind] ?? ['live'])], (s) => (s === 'checks' ? checks.usual : null), lead, prs, number);
    }
  }
}

export interface LandDeps {
  store: Store;
  finder: Pick<TargetFinder, 'list'>;
  /** Handed-off lands (src/land.ts Landings): which minions have one, and its output so far (code null while it runs). */
  landings: { handoffs(): number[]; look(ticketId: number): Promise<{ output: string; code: number | null } | null>; lastLook(ticketId: number): { output: string; code: number | null } | null | undefined };
  now?: () => number;
}

/** A land's place in the line as a number: landing (no place) is 0, "next" 1, "2nd" 2, and so on. */
export const placeRank = (brief: string | undefined): number => (brief == null ? 0 : brief === 'next' ? 1 : parseInt(brief, 10) || 1);

/** Where a land stands from land.sh's `queue:` lines: in line for the lock (its place), or landing. */
export function landProgress(output: string, since: number): Progress {
  // The newest line that says where it stands: others ("the wait has no time limit") come after it.
  const place = [...output.matchAll(/^queue: (?:(next|\d+(?:st|nd|rd|th)) in line for the land lock|got the land lock)/gm)].at(-1)?.[1];
  if (place) {
    const text = `in line to ship (${place})`;
    return { stage: 'land', since, usual: null, waitingOn: text, text, brief: place };
  }
  return { stage: 'land', since, usual: null, waitingOn: null, text: 'shipping: tests, then onto main' };
}

/** A frozen ship's progress says so in place of waiting or shipping (#1881), what it was doing after. */
const frozenLead = (lead: Progress, f: Frozen): Partial<Progress> => ({ waitingOn: frozenChip(f), text: `${frozenWords(f)}. It was: ${lead.text}`, brief: frozenChip(f) });

/** A scheme's land line: the kit's land template's tickets, in its main checkout's git folder (#1007). */
export const landQueue = (repo: string) => join(repo, '.git', 'land-queue');
/** That line's tickets, in its order: their 8th line (index 7) is "order" when their land.sh follows .order. */
export const schemeLine = (repo: string) => readQueue(landQueue(repo), 7);
const landScript = (repo: string) => join(repo, 'tools', 'land.sh');
/** A scheme's line, and whether its own land.sh follows .order yet: until it does, no landing in its line can move. */
type LineRead = { line: LandTicket[]; current: boolean };
const lineRead = (line: LandTicket[], script: string): LineRead => ({ line, current: /^queue_order\(\)/m.test(script) });

/** Why no landing in a scheme's line can move yet (#1007): the land.sh on its main predates reordering. */
export const OLD_SCHEME_LAND = "Can't move yet: this scheme's land script is older than reordering, so its changes ship in turn until it copies the kit's newer one";

/**
 * Minions handed off to land (#764), on their way before they reach main: in line for the land lock, then landing.
 * Each goes on the targets its branch's files ship on, ahead of their own stages, from the hand-off until main has it
 * (then a reader has it as on main). Not for Citadel's own scheme (its land line has them) or Main (it ships at merge).
 */
export class LandsInFlight {
  private d: LandDeps;
  /** When each was first seen landing (ms), so a poll doesn't move it. */
  private seen = new Map<number, number>();
  /** Each landing branch's files against its scheme's branch (null while read), filled behind the poll. */
  private files = new Map<number, string[] | null>();
  constructor(d: LandDeps) {
    this.d = d;
  }

  /** The files a minion's branch changed; null until read (git runs behind the poll, never in it). */
  private filesOf(t: Ticket, base: string, dir: string): string[] | null {
    if (!this.files.has(t.id)) {
      this.files.set(t.id, null);
      void git(['diff', '--name-only', `${base}...${t.branch}`], dir).then((out) => {
        if (out != null) this.files.set(t.id, out.split('\n').filter(Boolean));
        else this.files.delete(t.id);
      });
    }
    return this.files.get(t.id) ?? null;
  }

  /** Each scheme's line as last read off the server's thread (#1980), for the polls that only show it. */
  private lines = new Map<number, LineRead>();
  /** Goes up at each fresh read: a refresh that began before one is older than it. */
  private reads = 0;
  private reading: Promise<void> | null = null;

  /** Read the line of every scheme with a landing, off the server's thread; one read at a time. */
  refresh(): Promise<void> {
    return (this.reading ??= this.readLines().finally(() => {
      this.reading = null;
    }));
  }

  private async readLines() {
    const at = this.reads;
    const repos = new Map<number, string>();
    // Each landing's look also feeds attach()'s rows (Landings.lastLook) between these reads.
    const ids = this.d.landings.handoffs();
    const runs = await Promise.all(ids.map((id) => this.d.landings.look(id)));
    for (const [i, id] of ids.entries()) {
      const t = runs[i]?.code === null ? this.d.store.getTicket(id) : undefined;
      const p = t?.branch ? this.d.store.getProject(t.project_id) : null;
      if (p?.repo_dir) repos.set(p.id, p.repo_dir);
    }
    const read = await Promise.all(
      [...repos].map(async ([id, repo]) => {
        const [line, script] = await Promise.all([readQueueA(landQueue(repo), 7), readFile(landScript(repo), 'utf8').catch(() => '')]);
        return [id, lineRead(line, script)] as const;
      }),
    );
    if (at === this.reads) this.lines = new Map(read);
  }

  /** `fresh` reads each line in the thread, for a person's or a Taskmaster's own move; else the line is refresh()'s. */
  attach(views: Omit<TargetView, 'testCopies'>[], fresh = true) {
    const now = (this.d.now ?? Date.now)();
    const { store } = this.d;
    // Each scheme's land line (the kit's land template's <.git>/land-queue, #1007), read once: a landing's ticket in it
    // (by its branch) gives its place, and each target's part of the line is what the Releases page reorders.
    if (fresh) {
      this.reads++;
      this.lines = new Map();
    }
    const lineOf = (p: Project) => {
      if (fresh && !this.lines.has(p.id)) {
        let script = '';
        try {
          script = readFileSync(landScript(p.repo_dir!), 'utf8');
        } catch {
          /* none: no line to read either */
        }
        this.lines.set(p.id, lineRead(schemeLine(p.repo_dir!), script));
      }
      return this.lines.get(p.id) ?? lineRead([], '');
    };
    const landing = this.d.landings
      .handoffs()
      .map((id) => ({ id, run: this.d.landings.lastLook(id) }))
      .filter((x) => x.run?.code === null)
      .map((x) => {
        const t = store.getTicket(x.id);
        const p = t?.branch ? store.getProject(t.project_id) : null;
        const q = p?.repo_dir ? lineOf(p) : null;
        const at = q ? q.line.findIndex((l) => l.label === t!.branch) : -1;
        return { ...x, t, p, q, at };
      });
    // Rows go the way the line does (the one landing first, then each place in turn), whatever order the hand-offs came
    // in: by the line itself where the landing is in it, else by the place its output last said.
    const rank = new Map(landing.map((x) => [x.id, x.at >= 0 ? x.at : placeRank(landProgress(x.run!.output, 0).brief)]));
    landing.sort((a, b) => rank.get(a.id)! - rank.get(b.id)! || a.id - b.id);
    const ids = new Set(landing.map((x) => x.id));
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
    for (const id of this.files.keys()) if (!ids.has(id)) this.files.delete(id);
    const all = this.d.finder.list();
    for (const { id, run, t, p, q, at } of landing) {
      const mine = views.filter((v) => v.target.projectId === t?.project_id);
      if (!t || !p?.repo_dir || !mine.length || mine.some((v) => v.target.kind === 'main' || v.target.id === CITADEL_TARGET)) continue;
      const targets = all.filter((x) => x.projectId === t.project_id);
      const on = new Set(shipsTo(this.filesOf(t, targets[0]?.branch ?? 'main', p.repo_dir), targets));
      if (!this.seen.has(id)) this.seen.set(id, now);
      const lead = landProgress(run!.output, this.seen.get(id)!);
      const change: Change = { ...asChange(t), ...lead, ...(q && at >= 0 && q.line[at]?.frozen && frozenLead(lead, q.line[at].frozen!)) };
      const l = q && at >= 0 ? q.line[at] : null;
      const waits = l?.got === 0;
      const entry: LineEntry | null = l && {
        name: `#${t.number ?? t.id}`,
        ticketId: t.id,
        holds: !waits,
        place: ordinal(at + 1),
        seq: l.seq,
        movable: waits && !l.holds && !!l.orders && q!.current && !behindOld(q!.line, l),
        stage: waits ? 'line' : 'land',
        since: l.mtime,
        ...(l.frozen && { frozen: l.frozen }),
        ...(waits && !q!.current ? { why: OLD_SCHEME_LAND } : waits && l.holds ? { why: HOLDS_LINE } : waits && !l.orders ? { why: OLD_LAND } : waits && behindOld(q!.line, l) ? { why: BEHIND_OLD } : {}),
      };
      for (const tv of mine.filter((v) => on.has(v.target.id))) {
        const listed = tv.next?.changes.some((c) => c.ticketId === id);
        // A second ship while the first waits to go out (2RE5): its place in the line shows, the change is listed already.
        if (entry && (!listed || waits)) tv.line = [...tv.line, entry];
        if (listed) continue;
        if (tv.next) {
          // Its own release leads: what is on main is further along than a land. A release already building can't take it.
          const stages = tv.next.stages.some((s) => s.name === 'land') ? tv.next.stages : [{ name: 'land', usual: null }, ...tv.next.stages];
          // A land in the line is one at a time: the one landing (or any build's change not waiting) leads, so the rest go out after it.
          const later = tv.next.changes.some((c) => !c.later && (!c.waitingOn || c.stage === 'land'));
          tv.next = { ...tv.next, stages, changes: [...tv.next.changes, later ? { ...change, later } : change] };
          continue;
        }
        // An APK's number is its versionCode, a run-numbered target's its run's: neither known yet.
        const number = tv.target.kind === 'apk' || tv.target.numbering?.number === 'run' || tv.current?.number == null ? null : tv.current.number + 1;
        tv.next = nextOf(['land', ...(TRACKS[tv.target.kind] ?? ['live'])], () => null, lead, [change], number);
      }
    }
  }
}

/**
 * Main, for a scheme that ships by merging (Delve, Vexavault) or landing straight on main: a release is main's head,
 * recorded in the releases table each time it moves, with the minions whose work it took in. Its next release is the
 * scheme's open PRs: their checks, then a person's go to merge.
 */
export class MainReader implements Reader {
  private d: MainDeps;
  private heads = new Map<string, string>();
  private prs: PrsInFlight;
  constructor(d: MainDeps) {
    this.d = d;
    this.prs = new PrsInFlight(d);
  }

  async refresh() {
    const { store } = this.d;
    for (const t of this.d.finder.list('main')) {
      const p = store.getProject(t.projectId);
      if (!p?.repo_dir) continue;
      const head = (await git(['rev-parse', '--verify', '--quiet', `${t.branch}^{commit}`], p.repo_dir))?.trim();
      if (!head) continue;
      this.heads.set(`${t.projectId}:${t.id}`, head);
      const last = store.listReleases(p.id, t.id, 1)[0];
      if (last?.version === head) continue;
      const at = Number((await git(['log', '-1', '--format=%ct', head], p.repo_dir))?.trim()) * 1000 || (this.d.now ?? Date.now)();
      // History rewritten under it (a force push) reads as nothing landed, rather than no row ever again.
      const landed = last ? await landedIn(store, p, last.version, head) : null;
      store.addRelease({
        project_id: p.id,
        target: t.id,
        version: head,
        outcome: 'live',
        stages: '{}',
        live_at: at,
        started_at: landed?.commits.size ? Math.min(...landed.commits.values()) : null,
        changes: JSON.stringify((landed?.tickets ?? []).map((x) => ({ ticketId: x.id, number: x.number, title: x.title }))),
      });
    }
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const { store } = this.d;
    return this.d.finder.list('main').map((t) => {
      const head = this.heads.get(`${t.projectId}:${t.id}`) ?? null;
      const rows = store.listReleases(t.projectId, t.id, PREVIOUS + 1);
      const total = store.countReleases(t.projectId, t.id);
      const mine = head && rows[0]?.version === head ? rows[0] : null;
      // Main is the release: there's no site or file of it to open, so no link (never a commit, Cara 2026-11-12).
      const current = mine ? releaseOf(mine, null, total) : head ? { version: head, number: total + 1, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
      const skip = mine ? 1 : 0;
      const recent = rows.slice(skip, skip + PREVIOUS).map((r, i) => releaseOf(r, null, total - skip - i));
      const changes = this.prs.changes(t.projectId);
      let next: Next | null = null;
      if (changes.length) {
        const { ticketId: _i, number: _n, title: _t, ...lead } = changes[0];
        next = nextOf(MAIN_TRACK, (s) => (s === 'checks' ? lead.usual : null), lead, changes, Math.max(total, current?.number ?? 0) + 1);
      }
      return { target: targetOf(t), current, next, line: [], recent };
    });
  }
}

/** A file a minion left in its files folder that people run: an APK, or an archive named like a build. Only types the file route serves (src/artifacts.ts FILE_TYPES). */
// shortcut: an archive counts by its name (a platform, "build", or a commit sha in it); one of anything else named so shows too, until builds say what they are.
const DOWNLOAD = /\.apk$|(windows|win64|macos|linux|android|build|-[0-9a-f]{7,40})[^/]*\.(zip|7z|tgz|tar\.gz)$/i;
/** A scheme's downloads shown at most, newest first. */
const DOWNLOADS = 8;

export interface CopyDeps extends ActionsDeps {
  finder: Pick<TargetFinder, 'list' | 'copySources' | 'releaseFiles'>;
  /** A minion's files folder. */
  sharedDir: (t: Ticket) => string | null;
  /** Whether something listens on this host's port. */
  listening: (port: number) => Promise<boolean>;
}

/**
 * Every scheme's test copies besides Citadel's previews, read on the slow poll: the builds open minions left in their
 * files folders (Delve's Windows zips), a repo's preview site (poe2's deploy/preview.sh) and up or not, and CI's newest
 * debug APK, under its scheme's Android target.
 */
export class TestCopyReader {
  private d: CopyDeps;
  private cache: RunsCache;
  private copies = new Map<number, TestCopy[]>();
  constructor(d: CopyDeps) {
    this.d = d;
    this.cache = new RunsCache(d, 1, 'build'); // only the newest debug APK shows
  }

  list(): Map<number, TestCopy[]> {
    return this.copies;
  }

  async scan() {
    const { store } = this.d;
    const out = new Map<number, TestCopy[]>();
    const add = (id: number, c: TestCopy) => (out.get(id) ?? out.set(id, []).get(id)!).push(c);
    // A build that is a file target's release shows there, not again as a test copy.
    const released = this.d.finder.releaseFiles();
    for (const p of store.listProjects()) {
      const files: TestCopy[] = [];
      for (const t of store.listTickets(p.id)) {
        if (t.kind !== 'ticket' || t.status === 'closed') continue;
        const dir = this.d.sharedDir(t);
        if (!dir) continue;
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names.filter((n) => DOWNLOAD.test(n))) {
          const file = join(dir, name);
          const st = await stat(file).catch(() => null);
          if (!st?.isFile() || released.has(file)) continue;
          const sha = /-([0-9a-f]{7,40})(?=[-.])/.exec(name)?.[1] ?? null;
          files.push({ kind: 'download', target: null, name, file, ticketId: t.id, number: t.number ?? t.id, running: false, commit: sha, at: st.mtimeMs });
        }
      }
      for (const c of files.sort((a, b) => b.at! - a.at!).slice(0, DOWNLOADS)) add(p.id, c);
    }
    for (const s of this.d.finder.copySources()) {
      if (s.kind === 'site') {
        add(s.projectId, { kind: 'site', target: null, name: s.name, port: s.port, running: await this.d.listening(s.port), commit: null });
        continue;
      }
      await this.cache.read(s.run);
      const r = (this.cache.runs.get(tkey(s.run)) ?? []).find(shipped);
      if (r) add(s.projectId, { kind: 'debug-apk', target: s.target, name: `build ${r.run.run_number ?? r.run.id}`, link: this.cache.file(r.run.id) ?? undefined, running: false, commit: r.run.head_sha, at: span(r).end ?? undefined });
    }
    this.copies = out;
  }
}

/** Where a shared file downloads from: the minion file route, which serves a closed minion's files too. */
export const fileLink = (b: BuildFile) => `/api/tickets/${b.ticketId}/file?path=${encodeURIComponent(b.path)}&download`;

/**
 * Builds minions handed people as files, for a platform nothing else ships (FuckSpamTexts' APK and Chrome extension,
 * Delve's Windows zip): each file is a release, numbered from the oldest, linked to its download. With no pipeline to
 * watch, there is no next release.
 */
export class FileReader implements Reader {
  private d: { finder: Pick<TargetFinder, 'list'> };
  constructor(d: { finder: Pick<TargetFinder, 'list'> }) {
    this.d = d;
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    return this.d.finder.list('file').map((t) => {
      const files = t.files ?? [];
      const releases: Release[] = files.map((b, i) => ({ version: b.version, number: files.length - i, link: fileLink(b), changes: [], started: null, live: b.at, outcome: 'live', stages: {} }));
      return { target: targetOf(t), current: releases[0] ?? null, next: null, line: [], recent: releases.slice(1, PREVIOUS + 1) };
    });
  }
}
