// Ultra review from Citadel (#432): a person's click runs `claude ultrareview` on their own Claude
// login (their container, or the host for the server login's owner: src/claude-link.ts place), on a
// minion's branch or on an area of the repo, and posts the findings in the chat it came from.
// It's billed per run once an account's 3 free runs are gone, so only a person starts one: its route is
// person-only (src/routes/tickets.ts), no MCP tool reaches it, and the tripwire stops a turn running the CLI.
//
// Area mode: a scratch clone gets a base branch that is the repo minus the area's paths and a branch
// that adds them back, so the diff is just the area while the reviewer still sees the whole repo.
//
// Draft PRs (#1399): the CLI sends a scratch clone whole, and refuses a big repo ("Repo is too large", before
// any run is used). Then the same pair goes up as a draft pull request, as the clicker's own GitHub login:
// review/<slug> (the area put back: main's tree, so push guards pass) into review/<slug>-base, which the API
// makes at the commit without the area (its tree is broken on purpose, so it is never pushed). Both commits
// say [skip ci]: GitHub runs no push or pull_request workflow for them (Delve's CI runs on every PR).
// The CLI then reviews `<PR#>` from a folder whose remote is the scheme's repo. A batch preps one such PR
// per area ahead of time, and each runs only when its person presses Start. Once the findings are posted, a
// row is discarded or nobody starts it within EXPIRE_DAYS, its PR is closed and both branches deleted.
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AUTH_VARS, resolveClaude, stripAnsi, type TurnPlace } from './claude-link.ts';
import { githubRepo } from './github.ts';
import { HostJobs, type JobState } from './host-job.ts';
import { asEnv, errorText } from './scheme-repo.ts';
import { TURN_SLICE } from './turn-launch.ts';

const run = promisify(execFile);

/** The CLI's default caps on a diff; it refuses a bigger one before any run is used, and says which caps apply. */
export const LIMITS = { files: 500, lines: 8000 };
/** The CLI waits this long for findings (its --timeout); Citadel gives up a few minutes after. */
export const TIMEOUT_MIN = 45;
const KILL_MIN = TIMEOUT_MIN + 5;
const MAX_OUTPUT = 256 * 1024;
/** How often a running review's folder is read for its end. */
const POLL_MS = 2000;
/** Where running reviews are listed, so a server that restarts under one picks it back up. */
const RUNNING = 'ultrareview_running';
/** Where prepped batch rows are kept (BatchRow), so they survive a restart too. */
const BATCH = 'ultrareview_batch';
/** A prepped row nobody starts within this many days is discarded, its PR closed. */
export const EXPIRE_DAYS = 7;
/** The CLI's refusal of a repo too big to send whole: the cue for a draft PR. */
const TOO_LARGE = /Repo is too large/i;
const NO_GITHUB = 'you haven\'t linked GitHub (Settings → Your account), so Citadel can\'t open a draft pull request as you, and it never uses anyone else\'s login';

export type ReviewSpec =
  | { mode: 'branch'; repo: string; base: string; branch: string }
  | { mode: 'area'; repo: string; base: string; paths: string[] };

export interface Size { files: number; lines: number }

/** A review's draft PR on GitHub: `number` and `url` once it is open (the branches are named before that, for clean-up). */
export interface ReviewPr { slug: string; head: string; base: string; number?: number; url?: string }

/** One area of a batch, prepped as a draft PR and waiting for its person's Start. */
export interface BatchRow {
  id: string;
  ticketId: number;
  uid: number;
  by: string;
  name: string;
  paths: string[];
  question?: string;
  repo: string;
  base: string;
  size: Size;
  state: 'prepping' | 'ready' | 'running' | 'failed';
  /** Why its prep or its last run failed. */
  error?: string;
  pr?: ReviewPr;
  /** When it was asked for (ms): EXPIRE_DAYS counts from here. */
  at: number;
}

export interface AreaAsk { repo: string; base: string; name: string; paths: string[]; question?: string; size: Size }

export const overLimit = (s: Size) => s.files > LIMITS.files || s.lines > LIMITS.lines;
const fmt = (n: number) => n.toLocaleString('en-US');
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** A branch-name word from an area's name: review/<this>-<id>. */
export const branchSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'area';

/** Area paths as typed: repo-relative, no `..`, no options, at most 200 of them. Throws a message people can read. */
export function cleanPaths(raw: unknown): string[] {
  const list = typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : null;
  if (!list) throw new Error('paths must be a list of repo paths');
  const paths = [...new Set(list.map((p) => (typeof p === 'string' ? p.trim().replace(/^\.\//, '').replace(/\/+$/, '') : '')).filter(Boolean))];
  if (!paths.length) throw new Error('Name at least one path for the area');
  if (paths.length > 200) throw new Error('At most 200 paths');
  for (const p of paths) {
    if (p.startsWith('/') || p.startsWith('-') || p.split('/').some((s) => s === '..' || s === '.git') || /[\x00-\x1f*?[\]\\:]/.test(p)) throw new Error(`Not a repo path: ${p}`);
  }
  return paths;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** The repo's default branch: origin's HEAD, else main (as src/branch.ts reads it). */
export async function defaultBranch(repo: string): Promise<string> {
  const head = await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '');
  return head.replace(/^origin\//, '') || 'main';
}

export function parseShortstat(s: string): Size {
  const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), lines: n(/(\d+) insertions?/) + n(/(\d+) deletions?/) };
}

/** How big the review's diff will be, read from the repo without cloning. Throws when a path or branch isn't there. */
export async function diffSize(spec: ReviewSpec): Promise<Size> {
  if (spec.mode === 'branch') return parseShortstat(await git(spec.repo, 'diff', '--shortstat', `${spec.base}...${spec.branch}`, '--'));
  // -z: names as they are, not C-quoted ("docs/caf\303\251/a.md").
  const tracked = await git(spec.repo, 'ls-tree', '-r', '-z', '--name-only', spec.base, '--', ...spec.paths);
  const have = tracked.split('\0').filter(Boolean);
  const missing = spec.paths.filter((p) => !have.some((f) => f === p || f.startsWith(`${p}/`)));
  if (missing.length) throw new Error(`Not in ${spec.base}: ${missing.join(', ')}`);
  const empty = await git(spec.repo, 'hash-object', '-t', 'tree', '/dev/null');
  return parseShortstat(await git(spec.repo, 'diff', '--shortstat', empty, spec.base, '--', ...spec.paths));
}

/**
 * Clone the repo into `dir` and check out the branch to review; returns the base branch to review it against.
 * The clone has only commits: nothing uncommitted in a minion's worktree goes into the review.
 */
export async function prepare(spec: ReviewSpec, dir: string): Promise<string> {
  await run('git', ['clone', '-q', '--no-checkout', spec.repo, dir], { timeout: 300_000 });
  if (spec.mode === 'branch') {
    await git(dir, 'checkout', '-q', '-B', spec.base, `origin/${spec.base}`);
    await git(dir, 'checkout', '-q', '-B', spec.branch, `origin/${spec.branch}`);
    return spec.base;
  }
  const commit = (msg: string) => git(dir, '-c', 'user.name=Citadel', '-c', 'user.email=citadel@localhost', 'commit', '-q', '--no-verify', '-m', msg);
  await git(dir, 'checkout', '-q', '-b', 'ultrareview-base', `origin/${spec.base}`);
  await git(dir, 'rm', '-r', '-q', '--', ...spec.paths);
  await commit(`Ultra review base: ${spec.base} without the reviewed area [skip ci]`);
  await git(dir, 'checkout', '-q', '-b', 'ultrareview-area');
  await git(dir, 'checkout', `origin/${spec.base}`, '--', ...spec.paths);
  await commit(`Ultra review area: ${spec.paths.join(' ')} [skip ci]`);
  return 'ultrareview-base';
}

/** The scheme repo's GitHub "owner/name", from its origin. Throws a line people can read when it has none. */
export async function repoOnGithub(repo: string): Promise<string> {
  const slug = githubRepo(await git(repo, 'remote', 'get-url', 'origin').catch(() => ''));
  if (!slug) throw new Error('this scheme\'s repo isn\'t on GitHub, so there\'s nowhere to open a draft pull request');
  return slug;
}

export interface GhRun { gh: string; env: NodeJS.ProcessEnv }

async function ghCall(g: GhRun, args: string[]): Promise<string> {
  const { stdout } = await run(g.gh, args, { env: g.env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Open the area's draft PR (`pr` names its branches): the pair from prepare() in `dir`, the area's branch pushed to
 * `remote`, its base made through the API, then `gh pr create --draft`. A failure deletes what it made and throws
 * GitHub's words. Returns `pr` with its number and URL.
 */
export async function openReviewPr(spec: Extract<ReviewSpec, { mode: 'area' }>, pr: ReviewPr, o: { dir: string; remote: string; g: GhRun; title: string; body: string }): Promise<ReviewPr> {
  await prepare(spec, o.dir);
  const without = await git(o.dir, 'rev-parse', 'ultrareview-base');
  try {
    await run('git', ['push', '--quiet', o.remote, `ultrareview-area:refs/heads/${pr.head}`], { cwd: o.dir, env: o.g.env, timeout: 600_000 });
    await ghCall(o.g, ['api', `repos/${pr.slug}/git/refs`, '-f', `ref=refs/heads/${pr.base}`, '-f', `sha=${without}`]);
    const url = (await ghCall(o.g, ['pr', 'create', '--repo', pr.slug, '--draft', '--head', pr.head, '--base', pr.base, '--title', o.title, '--body', o.body])).split('\n').pop()!.trim();
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!number) throw new Error(`gh made no pull request: ${url}`);
    return { ...pr, number, url };
  } catch (err) {
    await closeReviewPr(pr, o.g);
    throw new Error(errorText(err));
  }
}

/** Close a review's PR and delete both its branches; each step is tried. Returns what failed, '' when all went. */
export async function closeReviewPr(pr: ReviewPr, g: GhRun): Promise<string> {
  const fails: string[] = [];
  const tryIt = async (args: string[], gone: RegExp) => {
    try {
      await ghCall(g, args);
    } catch (err) {
      const why = errorText(err);
      if (!gone.test(why)) fails.push(why);
    }
  };
  if (pr.number) await tryIt(['pr', 'close', String(pr.number), '--repo', pr.slug], /already closed|Could not resolve/i);
  for (const ref of [pr.head, pr.base]) await tryIt(['api', '-X', 'DELETE', `repos/${pr.slug}/git/refs/heads/${ref}`], /Reference does not exist|Not Found|HTTP 422/i);
  return fails.join('; ');
}

export interface ReviewEvent {
  id: string;
  by: string;
  mode: ReviewSpec['mode'];
  base: string;
  branch?: string;
  paths?: string[];
  size: Size;
  /** A batch row's draft PR, and its question (#1399). */
  pr?: { number: number; url: string };
  question?: string;
}
export interface ReviewResult {
  id: string;
  ok: boolean;
  /** The CLI's findings, or why it failed (its own words: a size refusal, credits off, not signed in). */
  text: string;
  code: number | null;
  /** The findings as a file in the chat's shared folder, for the minion to read when asked. */
  file?: string;
  /** The draft PR it reviewed, when it went through one (#1399). */
  pr?: { number: number; url: string };
}

interface Deps {
  claudeBin: string;
  /** Where the clicker's turns run: the only login a review may use. */
  place: (uid: number) => TurnPlace | null;
  /** The person's own scratch space, which their container mounts (ClaudeLink.turnsDir). */
  scratch: (uid: number) => string;
  emit: (ticketId: number, kind: 'ultrareview' | 'ultrareview_result', data: unknown) => void;
  getSetting: <T>(key: string) => T | undefined;
  setSetting: (key: string, value: unknown) => void;
  /** The host's turn environment (turn-launch.ts turnEnv), for the server login's owner. */
  hostEnv: Record<string, string>;
  /** Where each review's job keeps its pid, output and exit code (src/host-job.ts): private to the server. */
  jobsDir: string;
  /** Whether a review's CLI runs in a unit of its own (the runner's `units`). */
  units?: () => boolean;
  /** A person's own GitHub token (src/github-link.ts token), or null: draft PRs go out only as the person who asked. */
  github: (uid: number) => { token: string; login: string } | null;
  /** The gh binary (tests stub it). */
  gh?: string;
  /** Where a review branch is pushed for a repo "owner/name" (tests point it at a bare repo). */
  remoteUrl?: (slug: string) => string;
}

/** A review the server follows; saved, so the next server picks it back up. */
interface Running {
  ticketId: number; uid: number; id: string;
  /** Its scratch clone, in the person's own space. */
  dir: string;
  container?: string;
  /** The chat's shared folder its findings go to, and what it reviewed (writeFindings). */
  findings?: { dir: string; ev: Pick<ReviewEvent, 'mode' | 'base' | 'branch' | 'paths'> };
  /** Set once its CLI has started as a job. */
  job?: true;
  /** Who started it, and the area it reviews: a "too large" refusal makes a draft PR of it (#1399). */
  by?: string;
  spec?: ReviewSpec;
  /** Reviewing through this draft PR; closed once the findings are in unless a batch row keeps it for a retry. */
  pr?: ReviewPr;
  /** The batch row it runs for. */
  row?: string;
}

export class UltraReviews {
  private live = new Map<string, Running>();
  private timers = new Map<string, NodeJS.Timeout>();
  private deps: Deps;
  private jobs: HostJobs;

  constructor(deps: Deps) {
    this.deps = deps;
    // oomd's last pick, as the minion turns beside it are (#1338): a person asked and pays for it.
    this.jobs = new HostJobs(deps.units, TURN_SLICE, ['-p', 'ManagedOOMPreference=avoid']);
  }

  /** Reviews a restart would cut off (runner.hostJobs): ones still cloning, and ones whose CLI fell back to the server's child. */
  running(): number {
    return this.jobs.running() + [...this.live.values()].filter((r) => !r.job).length;
  }

  /** Reviews running in a person's container, so a turn starting there doesn't restart it under them. */
  inContainer(name: string): number {
    return [...this.live.values()].filter((r) => r.container === name).length;
  }

  /** A single review of theirs is running. Batch rows run side by side: each row's own state stops a double click. */
  busy(uid: number): boolean {
    return [...this.live.values()].some((r) => r.uid === uid && !r.row);
  }

  /**
   * After a restart: a review whose CLI had started runs on in its unit (#508), so this server follows it to
   * its findings. One cut off before that (still cloning) or with its CLI as the server's child is lost.
   * Batch rows come back as they were; one cut off while prepping is marked failed and its branches deleted.
   */
  recover() {
    for (const r of this.deps.getSetting<Running[]>(RUNNING) ?? []) {
      if (r.job && this.jobs.state(this.jobDir(r.id), 0)) {
        this.live.set(r.id, r);
        this.follow(r);
        continue;
      }
      this.live.set(r.id, r);
      this.finish(r, { id: r.id, ok: false, code: null, text: 'Citadel restarted while this review ran, so its findings were lost. The run may still count against the free runs.' });
    }
    this.save();
    const rows = this.batch();
    for (const row of rows) {
      if (row.state === 'prepping') {
        if (row.pr) this.cleanUp(row.uid, row.ticketId, row.pr);
        Object.assign(row, { state: 'failed', error: 'Citadel restarted while it prepped this one. Discard it and prep it again.', pr: undefined });
      } else if (row.state === 'running' && ![...this.live.values()].some((r) => r.row === row.id)) row.state = 'ready';
    }
    this.saveBatch(rows);
    this.sweep();
    setInterval(() => this.sweep(), 3600_000).unref();
  }

  private jobDir(id: string): string {
    return join(this.deps.jobsDir, id);
  }

  private save() {
    this.deps.setSetting(RUNNING, [...this.live.values()]);
  }

  private batch(): BatchRow[] {
    return this.deps.getSetting<BatchRow[]>(BATCH) ?? [];
  }

  private saveBatch(rows: BatchRow[]) {
    this.deps.setSetting(BATCH, rows);
  }

  /** Change one batch row in place (read, edit, write: the list is small and this is synchronous). */
  private editRow(id: string, edit: (row: BatchRow) => void): BatchRow | undefined {
    const rows = this.batch();
    const row = rows.find((x) => x.id === id);
    if (row) {
      edit(row);
      this.saveBatch(rows);
    }
    return row;
  }

  /** A person's gh and git env: their token alone, an empty gh config, no prompts. */
  private ghRun(token: string, dir: string): GhRun {
    const config = join(dir, 'gh');
    mkdirSync(config, { recursive: true, mode: 0o700 });
    return { gh: this.deps.gh ?? 'gh', env: asEnv({ GH_TOKEN: token, GH_CONFIG_DIR: config, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' })! };
  }

  /** Open a draft PR for an area as `uid`. Throws a line people can read. */
  private async openPr(uid: number, spec: Extract<ReviewSpec, { mode: 'area' }>, pr: ReviewPr, what: { name: string; question?: string; by: string }): Promise<ReviewPr> {
    const gh = this.deps.github(uid);
    if (!gh) throw new Error(NO_GITHUB);
    const dir = join(this.deps.scratch(uid), `ultrareview-pr-${newId()}`);
    try {
      const body = [
        `Made by Citadel for ${what.by}'s ultra review of ${spec.paths.map((p) => `\`${p}\``).join(', ')}.`,
        what.question ? `\n**Question for the review:** ${what.question}` : '',
        `\nDon't merge it: its base branch is \`${spec.base}\` without these files, so the diff is the whole area. Citadel closes it and deletes both branches once the review is done.`,
      ].join('\n');
      return await openReviewPr(spec, pr, { dir: join(dir, 'repo'), remote: this.deps.remoteUrl?.(pr.slug) ?? `https://github.com/${pr.slug}`, g: this.ghRun(gh.token, dir), title: `Ultra review: ${what.name} [skip ci]`, body });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Close a PR and delete its branches behind the caller; a chat note says so only when something is left on GitHub. */
  private cleanUp(uid: number, ticketId: number, pr: ReviewPr) {
    const gh = this.deps.github(uid);
    const left = (why: string) => this.deps.emit(ticketId, 'note', { text: `Couldn't clean up the ultra review's draft PR${pr.number ? ` #${pr.number}` : ''} (branches ${pr.head} and ${pr.base}): ${why}. Close it and delete them on GitHub.` });
    if (!gh) return left(NO_GITHUB.replace(', so Citadel can\'t open a draft pull request as you', ''));
    const dir = join(this.deps.scratch(uid), `ultrareview-gh-${newId()}`);
    void closeReviewPr(pr, this.ghRun(gh.token, dir))
      .then((why) => why && left(why), (err) => left(errorText(err)))
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  /**
   * Start a review for `uid` (a person, never a turn: the route checks) on their own login. Resolves once it
   * has started; the findings land later as an ultrareview_result event, and in a file in `findingsDir` (writeFindings).
   * `via`: a batch row's prepped PR, reviewed as it is.
   */
  async start(ticketId: number, uid: number, by: string, spec: ReviewSpec, size: Size, findingsDir?: string, via?: { pr: ReviewPr; row: string; question?: string }): Promise<ReviewEvent> {
    if (!via && this.busy(uid)) throw new Error('You already have an ultra review running. Wait for its findings first.');
    const place = this.deps.place(uid);
    if (!place) throw new Error('Your Claude plan isn\'t linked (Settings → Your account), so there\'s no login of yours to run it on.');
    const id = newId();
    const dir = join(this.deps.scratch(uid), `ultrareview-${id}`);
    const event: ReviewEvent = {
      id, by, mode: spec.mode, base: spec.base, ...(spec.mode === 'branch' ? { branch: spec.branch } : { paths: spec.paths }), size,
      ...(via ? { pr: { number: via.pr.number!, url: via.pr.url! }, ...(via.question ? { question: via.question } : {}) } : {}),
    };
    const { mode, base, branch, paths } = event;
    const r: Running = {
      ticketId, uid, id, dir, by, spec, ...(via ? { pr: via.pr, row: via.row } : {}),
      ...(place.host ? {} : { container: place.container }), ...(findingsDir ? { findings: { dir: findingsDir, ev: { mode, base, branch, paths } } } : {}),
    };
    this.live.set(id, r);
    this.save();
    this.deps.emit(ticketId, 'ultrareview', event);
    void this.run(r, place, spec);
    return event;
  }

  /** Clone (or, for a PR, a folder whose remote is the repo), then start the CLI as a job of its own (src/host-job.ts) and follow it to its end. */
  private async run(r: Running, place: TurnPlace, spec: ReviewSpec) {
    try {
      mkdirSync(r.dir, { recursive: true });
      const repo = join(r.dir, 'repo');
      let target: string;
      if (r.pr) {
        // The CLI reads which repo the PR is in from the folder's GitHub remote, and clones it in the cloud itself.
        await run('git', ['clone', '-q', '--no-checkout', '--depth', '1', `file://${spec.repo}`, repo], { timeout: 300_000 });
        await git(repo, 'remote', 'set-url', 'origin', `https://github.com/${r.pr.slug}`);
        target = String(r.pr.number);
      } else target = await prepare(spec, repo);
      const args = ['ultrareview', target, '--trust-workspace', '--timeout', String(TIMEOUT_MIN)];
      // `timeout` ends it a few minutes after the CLI's own limit, wherever it runs.
      const limit = ['timeout', `${KILL_MIN}m`];
      let argv: string[];
      let env: Record<string, string>;
      if (place.host) {
        argv = [...limit, this.deps.claudeBin, ...args];
        env = this.deps.hostEnv;
        // The server login's extra account (#779): its own config folder, and none of the host login's variables.
        if (place.env) env = { ...Object.fromEntries(Object.entries(env).filter(([k]) => !AUTH_VARS.includes(k))), ...place.env };
      } else {
        await place.ensure();
        // podman exec passes none of the server's environment, so the container's own sign-in is the only login.
        const cenv = Object.entries(place.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        argv = [...limit, 'podman', 'exec', '-w', repo, ...cenv, place.container, resolveClaude(this.deps.claudeBin), ...args];
        // podman itself gets the server's environment, as it did as the server's child.
        env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
      }
      this.jobs.start({ dir: this.jobDir(r.id), cwd: repo, argv, env, unit: `citadel-ultrareview-${r.id}`, description: `Ultra review ${r.id} for minion ${r.ticketId}`, ticketId: r.ticketId, onChildEnd: () => this.check(r) });
      r.job = true;
      this.save();
      this.follow(r);
    } catch (err: any) {
      this.finish(r, { id: r.id, ok: false, code: null, text: `The review didn't start: ${String(err?.stderr || err?.message || err).trim()}` });
    }
  }

  private follow(r: Running) {
    const timer = setInterval(() => this.check(r), POLL_MS);
    timer.unref();
    this.timers.set(r.id, timer);
  }

  /** Report the review once its job has ended. */
  private check(r: Running) {
    if (!this.live.has(r.id) || !r.job) return;
    const job = this.jobs.state(this.jobDir(r.id), MAX_OUTPUT);
    if (!job) return this.finish(r, { id: r.id, ok: false, code: null, text: 'The review\'s run folder is gone, so its findings were lost.' });
    if (job.code === null) return;
    if (job.code !== 0 && r.spec?.mode === 'area' && !r.pr && TOO_LARGE.test(job.output)) return void this.viaPr(r, r.spec, stripAnsi(job.output).trim());
    this.finish(r, this.result(r, job));
  }

  /** The CLI refused the scratch clone as too large: open the same area as a draft PR and review that instead. */
  private async viaPr(r: Running, spec: Extract<ReviewSpec, { mode: 'area' }>, said: string) {
    clearInterval(this.timers.get(r.id));
    this.timers.delete(r.id);
    rmSync(this.jobDir(r.id), { recursive: true, force: true });
    rmSync(r.dir, { recursive: true, force: true });
    delete r.job;
    try {
      const head = `review/${branchSlug(spec.paths.join('-'))}-${r.id.slice(-6)}`;
      r.pr = { slug: await repoOnGithub(spec.repo), head, base: `${head}-base` };
      this.save();
      r.pr = await this.openPr(r.uid, spec, r.pr, { name: spec.paths.join(', ').slice(0, 80), by: r.by ?? 'someone' });
      this.save();
    } catch (err: any) {
      if (r.pr && !r.pr.number) delete r.pr;
      return this.finish(r, { id: r.id, ok: false, code: null, text: `${said}\n\nCitadel tried a draft pull request instead, but ${err?.message ?? err}.` });
    }
    const place = this.deps.place(r.uid);
    if (!place) return this.finish(r, { id: r.id, ok: false, code: null, text: 'Your Claude plan isn\'t linked any more, so the review stopped.' });
    await this.run(r, place, spec);
  }

  private result(r: Running, job: JobState): ReviewResult {
    const code = job.code === -1 ? null : job.code;
    let out = job.output;
    if (code === 124) out += `\nCitadel stopped waiting after ${KILL_MIN} minutes.`;
    if (job.code === -1) out += '\nThe review ended without an exit code: it was stopped, or a restart cut it off.';
    const text = stripAnsi(out).trim();
    const result: ReviewResult = { id: r.id, ok: code === 0, code, text: text || (code === 0 ? 'The review found nothing to report.' : `The review exited with code ${code} and printed nothing.`) };
    if (r.pr?.number) result.pr = { number: r.pr.number, url: r.pr.url! };
    if (code === 0 && r.findings) {
      try {
        result.file = writeFindings(r.findings.dir, r.findings.ev, result.text);
      } catch {}
    }
    return result;
  }

  private finish(r: Running, result: ReviewResult) {
    clearInterval(this.timers.get(r.id));
    this.timers.delete(r.id);
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(this.jobDir(r.id), { recursive: true, force: true });
    this.live.delete(r.id);
    this.save();
    this.deps.emit(r.ticketId, 'ultrareview_result', result);
    if (r.row) {
      // Findings in: the row is done. A failed run keeps its PR, so the person can press Start again or discard it.
      if (result.ok) this.removeRow(r.row, true);
      else this.editRow(r.row, (row) => Object.assign(row, { state: 'ready', error: result.text.split('\n').filter(Boolean).pop()?.slice(0, 300) }));
    } else if (r.pr) this.cleanUp(r.uid, r.ticketId, r.pr);
  }

  // ---------- batches (#1399) ----------

  /** A person's batch rows in one chat, oldest first. */
  rows(ticketId: number, uid: number): BatchRow[] {
    return this.batch().filter((x) => x.ticketId === ticketId && x.uid === uid);
  }

  /**
   * Prep one area as a draft PR for `uid`. Resolves with its row (state prepping) once its branch names are
   * set; the push and PR run behind it. Throws, with a line people can read, for an area over the CLI's caps
   * or a person with no GitHub login of their own. Person-only, like start (the route checks).
   */
  async prep(ticketId: number, uid: number, by: string, a: AreaAsk): Promise<BatchRow> {
    if (overLimit(a.size)) throw new Error(`${a.name}: ${fmt(a.size.files)} files, ${fmt(a.size.lines)} lines, over the CLI's limit of ${fmt(LIMITS.files)} files and ${fmt(LIMITS.lines)} lines. Split it.`);
    if (!this.deps.github(uid)) throw new Error(`${a.name}: ${NO_GITHUB}`);
    const slug = await repoOnGithub(a.repo);
    const id = newId();
    const head = `review/${branchSlug(a.name)}-${id.slice(-6)}`;
    const row: BatchRow = {
      id, ticketId, uid, by, name: a.name, paths: a.paths, ...(a.question ? { question: a.question } : {}),
      repo: a.repo, base: a.base, size: a.size, state: 'prepping', pr: { slug, head, base: `${head}-base` }, at: Date.now(),
    };
    this.saveBatch([...this.batch(), row]);
    void this.openPr(uid, { mode: 'area', repo: a.repo, base: a.base, paths: a.paths }, row.pr!, { name: a.name, question: a.question, by }).then(
      (pr) => {
        // Discarded while it prepped: close what it just made.
        if (!this.editRow(id, (x) => Object.assign(x, { state: 'ready', pr }))) this.cleanUp(uid, ticketId, pr);
      },
      (err) => this.editRow(id, (x) => Object.assign(x, { state: 'failed', error: String(err?.message ?? err).slice(0, 500), pr: undefined })),
    );
    return row;
  }

  /** Start a ready row's review on its person's own login. Throws a line people can read. */
  startRow(id: string, uid: number, by: string, findingsDir?: string): Promise<ReviewEvent> {
    const row = this.batch().find((x) => x.id === id);
    if (!row) throw new Error('No such prepped review: it may have been discarded');
    if (row.uid !== uid) throw new Error('That prepped review is not yours: a review runs on the login of whoever prepped it');
    if (row.state === 'running') throw new Error('It is already running');
    if (row.state !== 'ready' || !row.pr?.number) throw new Error(row.state === 'prepping' ? 'It is still prepping its draft PR' : 'Its draft PR didn\'t open: discard it and prep it again');
    this.editRow(id, (x) => Object.assign(x, { state: 'running', error: undefined }));
    return this.start(row.ticketId, uid, by, { mode: 'area', repo: row.repo, base: row.base, paths: row.paths }, row.size, findingsDir, { pr: row.pr, row: id, question: row.question })
      .catch((err) => {
        this.editRow(id, (x) => Object.assign(x, { state: 'ready' }));
        throw err;
      });
  }

  /** Drop a row now and close its PR behind it. A running row can't be discarded. */
  discard(id: string, uid: number) {
    const row = this.batch().find((x) => x.id === id);
    if (!row) return;
    if (row.uid !== uid) throw new Error('That prepped review is not yours');
    if (row.state === 'running') throw new Error('It is running: wait for its findings');
    this.removeRow(id, true);
  }

  private removeRow(id: string, close: boolean) {
    const rows = this.batch();
    const row = rows.find((x) => x.id === id);
    if (!row) return;
    this.saveBatch(rows.filter((x) => x !== row));
    // A row still prepping has nothing to close yet: prep's own end sees the row gone and closes what it made.
    if (close && row.pr && row.state !== 'prepping') this.cleanUp(row.uid, row.ticketId, row.pr);
  }

  /** Discard rows nobody started within EXPIRE_DAYS, closing their PRs, and tell each chat in one line. */
  sweep(now = Date.now()) {
    const old = this.batch().filter((x) => (x.state === 'ready' || x.state === 'failed') && now - x.at > EXPIRE_DAYS * 86_400_000);
    for (const row of old) this.removeRow(row.id, true);
    const byChat = new Map<number, BatchRow[]>();
    for (const row of old) byChat.set(row.ticketId, [...(byChat.get(row.ticketId) ?? []), row]);
    for (const [ticketId, list] of byChat) {
      const prs = list.filter((x) => x.pr?.number).length;
      const one = list.length === 1;
      this.deps.emit(ticketId, 'note', { text: `Discarded ${list.length} prepped ultra review${one ? '' : 's'} nobody started in ${EXPIRE_DAYS} days (${list.map((x) => x.name).join(', ')})${prs ? ` and closed ${prs === 1 ? 'its' : 'their'} draft PR${prs === 1 ? '' : 's'}` : ''}.` });
    }
  }
}

/** Findings as a markdown file for a chat's shared folder; returns its path. */
export function writeFindings(dir: string, ev: Pick<ReviewEvent, 'mode' | 'base' | 'branch' | 'paths'>, text: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const file = join(dir, `ultrareview-${stamp}.md`);
  const what = ev.mode === 'branch' ? `branch \`${ev.branch}\` against \`${ev.base}\`` : `area ${ev.paths!.map((p) => `\`${p}\``).join(', ')}`;
  writeFileSync(file, `# Ultra review: ${what}\n\n${now.toISOString()}\n\n\`\`\`\`\n${text}\n\`\`\`\`\n`);
  return file;
}
