// A reader per kind of found target (#627, src/release-targets.ts finds them), each filling src/releases.ts's shape.
// read() answers from what refresh() last read (git, files, GitHub), so the 2-second poll costs nothing.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeployView } from './app-services.ts';
import type { Job, Run } from './ci-health.ts';
import type { ContraptionDeployRow, ContraptionRow, Project, Store, Ticket } from './db.ts';
import { verdict, type PrSnapshot } from './github.ts';
import { git, landedIn, releaseOf, type Change, type Next, type Progress, type Reader, type Release, type TargetView, type TestCopy } from './releases.ts';
import type { Found, TargetFinder } from './release-targets.ts';
import { repoSlug } from './prlinks.ts';
import { median } from './waits.ts';

const RECENT = 5;
/** How many earlier releases a card lists under Previous releases (Cara, 2026-11-12: "Previous releases could have links to old builds"). */
const PREVIOUS = 10;

/** A whole next release from its lead's progress: the track's stages with their usual times, and when it should be live. */
export function nextOf(track: string[], usual: (stage: string) => number | null, lead: Progress, changes: Change[], number: number | null, link: string | null = null): Next {
  const stages = track.map((name) => ({ name, usual: name === 'live' ? 0 : usual(name) }));
  const after = stages.slice(track.indexOf(lead.stage) + 1);
  const eta = lead.waitingOn || lead.usual == null || after.some((s) => s.usual == null)
    ? null : lead.since + (lead.usual + after.reduce((sum, s) => sum + s.usual!, 0)) * 1000;
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
export const targetOf = (t: Found) => ({ id: t.id, projectId: t.projectId, name: t.name, kind: t.kind, link: t.link });

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
  now?: () => number;
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
      // A deploy fast-forwards the folder before it builds: until it ends, what was read before it started stands.
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
        const landed = deployed === main ? { commits: new Map(), tickets: [] } : await landedIn(this.d.store, p, deployed, main);
        if (landed) {
          s.ahead = landed.commits.size;
          s.oldest = landed.commits.size ? Math.min(...landed.commits.values()) : null;
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
    const landed = p && view.from && view.to && view.from !== view.to ? await landedIn(store, p, view.from, view.to) : null;
    const end = view.finished_at ?? (this.d.now ?? Date.now)();
    store.addContraptionDeploy({
      name: view.name, from_sha: view.from, to_sha: view.to, by: view.by, started_at: view.started_at, finished_at: end, outcome: view.state,
      stages: JSON.stringify(lengths(view.stages, end)), changes: JSON.stringify((landed?.tickets ?? []).map((x) => ({ ticketId: x.id, number: x.number, title: x.title }))),
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
        version: r.to_sha ?? r.from_sha ?? '', number: numbers.get(r.id) ?? null, link, changes: JSON.parse(r.changes),
        started: r.started_at, live: r.outcome === 'deployed' ? r.finished_at : null, outcome: r.outcome === 'deployed' ? 'live' : r.outcome, stages: JSON.parse(r.stages),
      });
      // While a deploy runs, the commit it started from still serves.
      const version = (run ? run.from : null) ?? s?.deployed ?? live[0]?.to_sha ?? null;
      const mine = live.find((r) => r.to_sha === version);
      // The current release is the app as it serves now; an older one can't be opened any more.
      const current: Release | null = mine ? release(mine, t.link)
        : version ? { version, number: live.length ? total + 1 : Math.max(total, 1), link: t.link, changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
      const recent = rows.filter((r) => r.id !== mine?.id).slice(0, PREVIOUS).map((r) => release(r));

      let lead: Progress | null = null;
      if (run) {
        const [stage, since] = Object.entries(run.stages).sort((a, b) => b[1] - a[1])[0] ?? ['build', run.started_at];
        // The drain waits for the app's running agent turns (up to 3 min): outside the pipeline, so no estimate.
        const waits = stage === 'drain' ? 'its running agent turns to end' : null;
        lead = { stage, since, usual: waits ? null : usual(stage), waitingOn: waits, text: waits ?? run.said.at(-1) ?? 'deploying' };
      } else if (s?.ahead) {
        // Say what sends it out (#629's Deploy button and auto-deploy) rather than "a deploy call" (Cara, 2026-11-12: "What does 'waiting for a deploy call' mean?").
        const what = s.ahead === 1 ? '1 change on main isn\'t' : `${s.ahead} changes on main aren't`;
        const text = `${what} live yet: they go out with the next deploy, from the Deploy button or by auto-deploy once main sits still for 5 minutes`;
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
}

/** GitHub Actions as the release monitor reads it: CiHealth's cached reads (src/ci-health.ts). */
export interface Actions {
  workflowRuns(p: Project, workflow: string, branch: string): Promise<Run[] | null>;
  runJobs(p: Project, run: Run): Promise<Job[] | null>;
  runArtifacts?(p: Project, run: Run): Promise<Artifact[] | null>;
}

/**
 * The download of what a run shipped: its artifact named for the repo ("peek-auras-<sha>", "mandate-release-apk"), or
 * its only one; null when it has none left (they expire), or several and none named so.
 */
export function shippedFile(slug: string, run: Run, list: Artifact[]): ShippedFile | null {
  const repo = slug.replace(/^.*\//, '').toLowerCase();
  const kept = list.filter((a) => !a.expired);
  const a = kept.find((x) => x.name.toLowerCase().startsWith(repo)) ?? (kept.length === 1 ? kept[0] : undefined);
  return a ? { url: `https://github.com/${slug}/actions/runs/${run.id}/artifacts/${a.id}`, expires: ms(a.expires_at) } : null;
}

/** A shipped run's download, and when GitHub drops it (the link is cached, so it goes back to the run page then). */
export interface ShippedFile { url: string; expires: number | null }

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : null);
const secs = (from: number | null, to: number | null) => (from != null && to != null ? Math.max(0, Math.round((to - from) / 1000)) : null);
/** A target's key in the readers' maps: target ids (apk:android-release) repeat across schemes. */
const tkey = (t: Found) => `${t.projectId}:${t.id}`;
/** How long after Citadel starts a release run it waits to see it listed before it would start another. */
const SENT_MS = 3 * 60_000;

/** Re-read a workflow that isn't moving this often; one that is, every refresh. */
const IDLE_MS = 5 * 60_000;

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
/** A run that tried to ship and didn't: its job ran (not skipped) and failed. */
const failedShip = (r: RunJobs) => r.run.status === 'completed' && (r.jobs.length ? r.jobs[0].conclusion === 'failure' : r.run.conclusion === 'failure');

/** A run as a release: linked to the file it shipped or else its run page (where its files are), with its CI and package times. */
function runRelease(r: RunJobs, outcome: string, changes: Release['changes'] = [], file: string | null = null, number: number | null = null): Release {
  const s = span(r);
  const stages: Record<string, number> = {};
  const ci = secs(s.start, s.started), pkg = secs(s.started, s.end);
  if (ci != null) stages.ci = ci;
  if (pkg != null) stages.package = pkg;
  return { version: r.run.head_sha, number, link: file ?? r.run.html_url ?? null, changes, started: s.start, live: outcome === 'live' ? s.end : null, outcome, stages };
}

/** The usual CI and package time of the newest shipped runs. */
function runUsual(runs: RunJobs[]): (stage: string) => number | null {
  const ok = runs.filter(shipped).slice(0, RECENT).map((r) => runRelease(r, 'live'));
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
  now?: () => number;
}

/** Each workflow target's runs on main, read again every refresh while one runs and every IDLE_MS otherwise. */
class RunsCache {
  private d: ActionsDeps;
  runs = new Map<string, RunJobs[]>();
  private readAt = new Map<string, number>();
  /** The minions in each run's commits since the shipped run before it, by run id. */
  changes = new Map<number, Release['changes']>();
  /** The download of what each shipped run made (shippedFile), by run id; read once per run. */
  file(id: number, now: number): string | null {
    const f = this.files.get(id);
    return f && (f.expires == null || f.expires > now) ? f.url : null;
  }
  files = new Map<number, ShippedFile | null>();
  constructor(d: ActionsDeps) {
    this.d = d;
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
    const moving = had?.some((r) => r.run.status !== 'completed');
    if (had && !moving && now - (this.readAt.get(tkey(t)) ?? 0) < IDLE_MS) return;
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
    this.runs.set(tkey(t), out);
    const kept = new Set([...this.runs.values()].flat().map((r) => r.run.id));
    for (const id of this.changes.keys()) if (!kept.has(id)) this.changes.delete(id);
    for (const id of this.files.keys()) if (!kept.has(id)) this.files.delete(id);
    const slug = repoSlug(p.repo_url);
    // The runs a page can show a download for: the newest few that shipped.
    for (const r of out.filter(shipped).slice(0, PREVIOUS + 1)) { // the current and its Previous releases
      if (this.files.has(r.run.id) || !slug || !this.d.actions.runArtifacts) continue;
      const list = await this.d.actions.runArtifacts(p, r.run);
      if (list) this.files.set(r.run.id, shippedFile(slug, r.run, list));
    }
    // What each run carries since the run before it that shipped (read once a run is done).
    if (p.repo_dir) {
      for (const [i, r] of out.entries()) {
        if (this.changes.has(r.run.id) && r.run.status === 'completed') continue;
        const prev = out.slice(i + 1).find(shipped);
        const landed = prev && prev.run.head_sha !== r.run.head_sha ? await landedIn(this.d.store, p, prev.run.head_sha, r.run.head_sha) : null;
        this.changes.set(r.run.id, (landed?.tickets ?? []).map((x) => ({ ticketId: x.id, number: x.number, title: x.title })));
      }
    }
  }

  /**
   * Write a releases row for each shipped run newer than the last one written (only the newest, the first time), so a
   * target counts its releases from 1 with no gaps, rather than by GitHub's run number, which counts every run.
   */
  record(t: Found) {
    const { store } = this.d;
    const key = (r: RunJobs) => r.run.run_number ?? r.run.id;
    const last = store.listReleases(t.projectId, t.id, 1)[0];
    const done = last ? Number(last.version.replace(/^run:/, '')) : null;
    const fresh = (this.runs.get(tkey(t)) ?? []).filter((r) => shipped(r) && (done == null || key(r) > done));
    for (const r of (done == null ? fresh.slice(0, 1) : fresh).reverse()) {
      const s = span(r);
      store.addRelease({ project_id: t.projectId, target: t.id, version: `run:${key(r)}`, changes: '[]', started_at: s.start, live_at: s.end, outcome: 'live', stages: '{}' });
    }
  }

  /** The release number of each recorded run (by run number), and how many there are: the newest's number. */
  numbers(t: Found): { of: (r: RunJobs) => number | null; total: number } {
    const total = this.d.store.countReleases(t.projectId, t.id);
    const rows = this.d.store.listReleases(t.projectId, t.id, PREVIOUS * 2 + 1);
    const by = new Map(rows.map((row, i) => [row.version, total - i]));
    return { of: (r) => by.get(`run:${r.run.run_number ?? r.run.id}`) ?? null, total };
  }
}

export const CI_TRACK = ['ci', 'package', 'live'];

/** A CI package (Peek Auras' Windows build): a release is the newest run on main whose shipping job passed; the next is a run in flight. */
export class CiPackageReader implements Reader {
  private d: ActionsDeps;
  private cache: RunsCache;
  constructor(d: ActionsDeps) {
    this.d = d;
    this.cache = new RunsCache(d);
  }

  async refresh() {
    for (const t of this.d.finder.list('ci')) {
      await this.cache.read(t);
      this.cache.record(t);
    }
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const now = (this.d.now ?? Date.now)();
    return this.d.finder.list('ci').map((t) => {
      const runs = this.cache.runs.get(tkey(t)) ?? [];
      const ch = (r: RunJobs) => this.cache.changes.get(r.run.id) ?? [];
      const file = (r: RunJobs) => this.cache.file(r.run.id, now);
      const num = this.cache.numbers(t);
      const cur = runs.find(shipped);
      const recent = runs.filter((r) => r !== cur && (shipped(r) || failedShip(r))).slice(0, PREVIOUS).map((r) => runRelease(r, shipped(r) ? 'live' : 'failed', ch(r), file(r), num.of(r)));
      const usual = runUsual(runs);
      // The newest run in flight leads; a run older than the current release can't be its next.
      const moving = runs.find((r) => r.run.status !== 'completed');
      const lead = moving && (!cur || runs.indexOf(moving) < runs.indexOf(cur)) ? runProgress(moving, usual, now) : null;
      const changes: Change[] = lead ? ch(moving!).map((c) => ({ ...c, ...lead })) : [];
      return { target: targetOf(t), current: cur ? runRelease(cur, 'live', ch(cur), file(cur), num.of(cur)) : null, next: lead ? nextOf(CI_TRACK, usual, lead, changes, num.total + 1) : null, line: [], recent };
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
}

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
  constructor(d: ApkDeps) {
    this.d = d;
    this.cache = new RunsCache(d);
  }

  async refresh() {
    for (const t of this.d.finder.list('apk')) {
      await this.cache.read(t);
      if (t.contraption) this.feeds.set(tkey(t), await this.d.feed(t.contraption));
      // With no latest.json its signed runs are its releases, numbered as a CI package's.
      if (!this.feeds.get(tkey(t))) this.cache.record(t);
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

  /** A release run was just started for it: read its runs again on the next refresh, and start no other for a while. */
  started(t: Found) {
    this.cache.forget(t);
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
      const signs = runs.filter(shipped).slice(0, RECENT).flatMap((r) => apkRun(r, 'live').stages.sign ?? []);
      const usual = (s: string) => (s === 'sign' ? median(signs) : null);
      const feed = this.feeds.get(tkey(t));
      const main = this.mains.get(tkey(t));
      const file = (r: RunJobs) => this.cache.file(r.run.id, now);
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
        const recent = runs.filter((r) => r !== cur && (shipped(r) || failedShip(r))).slice(0, PREVIOUS).map((r) => apkRun(r, shipped(r) ? 'live' : 'failed', file(r), num.of(r)));
        const lead = moving && (!cur || runs.indexOf(moving) < runs.indexOf(cur)) ? signing(moving) : null;
        return { target: targetOf(t), current: cur ? apkRun(cur, 'live', file(cur), num.of(cur)) : null, next: lead ? nextOf(APK_TRACK, usual, lead, [], num.total + 1) : null, line: [], recent };
      }
      // Numbered by its versionCode, the counter its app's update banner reads; the versionName stays as the detail.
      const version = main?.code === feed.versionCode && main.name ? main.name : feed.versionName ?? String(feed.versionCode);
      const link = feed.apk && t.contraption ? `/apps/${t.contraption}/android/${feed.apk}` : t.link;
      const current: Release = { version, number: feed.versionCode, link, changes: [], started: null, live: feed.at, outcome: 'live', stages: {} };
      // Its signed runs, as the APKs people could have been given: not releases, so no release number.
      const recent = runs.filter((r) => shipped(r) || failedShip(r)).slice(0, PREVIOUS).map((r) => apkRun(r, shipped(r) ? 'signed' : 'failed', file(r)));
      let lead: Progress | null = null;
      let tryIt: string | null = null;
      if (main && main.code > feed.versionCode) {
        const signed = runs.find((r) => shipped(r) && !this.old.has(r.run.id) && (ms(r.run.created_at) ?? 0) > feed.at);
        const name = main.name ?? `Release ${main.code}`;
        if (moving) lead = signing(moving);
        else if (signed) {
          const text = `${name} is signed: it goes out with the Deploy button, or by auto-deploy within 5 minutes`;
          lead = { stage: 'publish', since: span(signed).end ?? now, usual: null, waitingOn: text, text };
          tryIt = file(signed);
        } else {
          const text = `${name} is on main, but its release run hasn't started: the Deploy button starts it, or auto-deploy once main sits still for 5 minutes`;
          lead = { stage: 'sign', since: feed.at, usual: null, waitingOn: text, text };
        }
      }
      return { target: targetOf(t), current, next: lead ? nextOf(APK_TRACK, usual, lead, [], main?.code ?? null, tryIt) : null, line: [], recent };
    });
  }
}

export const MAIN_TRACK = ['checks', 'merge', 'live'];

export interface MainDeps {
  store: Store;
  finder: Pick<TargetFinder, 'list'>;
  /** A minion's PR as the PR watcher last saw it (src/github.ts), or null. */
  pr: (ticketId: number) => PrSnapshot | null;
  /** Its PR's CI in flight (src/ci-wait.ts CiRuns.view): since when, and the usual length. */
  ci?: (ticketId: number) => { since: number; usual: number | null; text: string } | null;
  now?: () => number;
}

/**
 * Main, for a scheme that ships by merging (Delve, Vexavault) or landing straight on main: a release is main's head,
 * recorded in the releases table each time it moves, with the minions whose work it took in. Its next release is the
 * scheme's open PRs: their checks, then a person's go to merge.
 */
export class MainReader implements Reader {
  private d: MainDeps;
  private heads = new Map<string, string>();
  /** When each change was first seen at its stage ("<ticket>:<stage>" → ms), so a poll doesn't move it. */
  private seen = new Map<string, number>();
  constructor(d: MainDeps) {
    this.d = d;
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
        project_id: p.id, target: t.id, version: head, outcome: 'live', stages: '{}', live_at: at,
        started_at: landed?.commits.size ? Math.min(...landed.commits.values()) : null,
        changes: JSON.stringify((landed?.tickets ?? []).map((x) => ({ ticketId: x.id, number: x.number, title: x.title }))),
      });
    }
  }

  private since(id: number, stage: string, now: number): number {
    const key = `${id}:${stage}`;
    // A PR back at its checks (a new push) starts them again.
    for (const s of ['checks', 'failed', 'merge']) if (s !== stage) this.seen.delete(`${id}:${s}`);
    if (!this.seen.has(key)) this.seen.set(key, now);
    return this.seen.get(key)!;
  }

  /** Where one open PR is: its checks running or failed, or waiting for a go to merge. */
  private progress(id: number, pr: PrSnapshot, now: number): Progress {
    const v = verdict(pr.checks);
    if (v === 'pending') {
      const ci = this.d.ci?.(id);
      const queued = pr.checks.some((c) => c.status === 'pending' && c.queued);
      const text = queued ? 'its checks wait for a CI runner' : ci?.text ?? 'checks running';
      return { stage: 'checks', since: ci?.since ?? this.since(id, 'checks', now), usual: queued ? null : ci?.usual ?? null, waitingOn: queued ? text : null, text };
    }
    if (v === 'failed') {
      const text = 'its checks failed: the minion fixes them';
      return { stage: 'checks', since: this.since(id, 'failed', now), usual: null, waitingOn: text, text };
    }
    const text = `PR #${pr.number} waits for a go to merge`;
    return { stage: 'merge', since: this.since(id, 'merge', now), usual: null, waitingOn: text, text };
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const { store } = this.d;
    const now = (this.d.now ?? Date.now)();
    const open = new Set<number>();
    const out = this.d.finder.list('main').map((t) => {
      const head = this.heads.get(`${t.projectId}:${t.id}`) ?? null;
      const rows = store.listReleases(t.projectId, t.id, PREVIOUS + 1);
      const total = store.countReleases(t.projectId, t.id);
      const mine = head && rows[0]?.version === head ? rows[0] : null;
      // Main is the release: there's no site or file of it to open, so no link (never a commit, Cara 2026-11-12).
      const current = mine ? releaseOf(mine, null, total)
        : head ? { version: head, number: total + 1, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
      const skip = mine ? 1 : 0;
      const recent = rows.slice(skip, skip + PREVIOUS).map((r, i) => releaseOf(r, null, total - skip - i));
      const changes: Change[] = [];
      for (const x of store.listTickets(t.projectId)) {
        if (x.kind !== 'ticket' || x.status === 'closed' || !x.branch) continue;
        const pr = this.d.pr(x.id);
        if (pr?.state !== 'OPEN' || pr.draft) continue;
        open.add(x.id);
        changes.push({ ticketId: x.id, number: x.number, title: x.title, ...this.progress(x.id, pr, now) });
      }
      changes.sort((a, b) => MAIN_TRACK.indexOf(b.stage) - MAIN_TRACK.indexOf(a.stage) || a.since - b.since);
      let next: Next | null = null;
      if (changes.length) {
        const { ticketId: _i, number: _n, title: _t, ...lead } = changes[0];
        next = nextOf(MAIN_TRACK, (s) => (s === 'checks' ? lead.usual : null), lead, changes, Math.max(total, current?.number ?? 0) + 1);
      }
      return { target: targetOf(t), current, next, line: [], recent };
    });
    for (const k of this.seen.keys()) if (!open.has(Number(k.split(':')[0]))) this.seen.delete(k);
    return out;
  }
}

/** A file a minion left in its files folder that people run: an APK, or an archive named like a build. Only types the file route serves (src/artifacts.ts FILE_TYPES). */
// shortcut: an archive counts by its name (a platform, "build", or a commit sha in it); one of anything else named so shows too, until builds say what they are.
const DOWNLOAD = /\.apk$|(windows|win64|macos|linux|android|build|-[0-9a-f]{7,40})[^/]*\.(zip|7z|tgz|tar\.gz)$/i;
/** A scheme's downloads shown at most, newest first. */
const DOWNLOADS = 8;

export interface CopyDeps extends ActionsDeps {
  finder: Pick<TargetFinder, 'list' | 'copySources'>;
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
    this.cache = new RunsCache(d);
  }

  list(): Map<number, TestCopy[]> {
    return this.copies;
  }

  async scan() {
    const { store } = this.d;
    const out = new Map<number, TestCopy[]>();
    const add = (id: number, c: TestCopy) => (out.get(id) ?? out.set(id, []).get(id)!).push(c);
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
          if (!st?.isFile()) continue;
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
      if (r) add(s.projectId, { kind: 'debug-apk', target: s.target, name: `build ${r.run.run_number ?? r.run.id}`, link: r.run.html_url ?? s.run.link ?? undefined, running: false, commit: r.run.head_sha, at: span(r).end ?? undefined });
    }
    this.copies = out;
  }
}
