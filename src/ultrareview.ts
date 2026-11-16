// Ultra review from Citadel (#432): a person's click runs `claude ultrareview` on their own Claude
// login (their container, or the host for the server login's owner: src/claude-link.ts place), on a
// minion's branch or on an area of the repo, and posts the findings in the chat it came from.
// It's billed per run once an account's 3 free runs are gone, so only a person starts one: its route is
// person-only (src/routes/tickets.ts), no MCP tool reaches it, and the tripwire stops a turn running the CLI.
//
// Area mode: a scratch clone gets a base branch that is the repo minus the area's paths and a branch
// that adds them back, so the diff is just the area while the reviewer still sees the whole repo.
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AUTH_VARS, resolveClaude, stripAnsi, type TurnPlace } from './claude-link.ts';
import { HostJobs, type JobState } from './host-job.ts';

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

export type ReviewSpec =
  | { mode: 'branch'; repo: string; base: string; branch: string }
  | { mode: 'area'; repo: string; base: string; paths: string[] };

export interface Size { files: number; lines: number }

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
  await commit(`Ultra review base: ${spec.base} without the reviewed area`);
  await git(dir, 'checkout', '-q', '-b', 'ultrareview-area');
  await git(dir, 'checkout', `origin/${spec.base}`, '--', ...spec.paths);
  await commit(`Ultra review area: ${spec.paths.join(' ')}`);
  return 'ultrareview-base';
}

export interface ReviewEvent {
  id: string;
  by: string;
  mode: ReviewSpec['mode'];
  base: string;
  branch?: string;
  paths?: string[];
  size: Size;
}
export interface ReviewResult {
  id: string;
  ok: boolean;
  /** The CLI's findings, or why it failed (its own words: a size refusal, credits off, not signed in). */
  text: string;
  code: number | null;
  /** The findings as a file in the chat's shared folder, for the minion to read when asked. */
  file?: string;
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
}

export class UltraReviews {
  private live = new Map<string, Running>();
  private timers = new Map<string, NodeJS.Timeout>();
  private deps: Deps;
  private jobs: HostJobs;

  constructor(deps: Deps) {
    this.deps = deps;
    this.jobs = new HostJobs(deps.units);
  }

  /** Reviews a restart would cut off (runner.hostJobs): ones still cloning, and ones whose CLI fell back to the server's child. */
  running(): number {
    return this.jobs.running() + [...this.live.values()].filter((r) => !r.job).length;
  }

  /** Reviews running in a person's container, so a turn starting there doesn't restart it under them. */
  inContainer(name: string): number {
    return [...this.live.values()].filter((r) => r.container === name).length;
  }

  busy(uid: number): boolean {
    return [...this.live.values()].some((r) => r.uid === uid);
  }

  /**
   * After a restart: a review whose CLI had started runs on in its unit (#508), so this server follows it to
   * its findings. One cut off before that (still cloning) or with its CLI as the server's child is lost.
   */
  recover() {
    for (const r of this.deps.getSetting<Running[]>(RUNNING) ?? []) {
      if (r.job && this.jobs.state(this.jobDir(r.id), 0)) {
        this.live.set(r.id, r);
        this.follow(r);
        continue;
      }
      rmSync(r.dir, { recursive: true, force: true });
      rmSync(this.jobDir(r.id), { recursive: true, force: true });
      this.deps.emit(r.ticketId, 'ultrareview_result', { id: r.id, ok: false, code: null, text: 'Citadel restarted while this review ran, so its findings were lost. The run may still count against the free runs.' } satisfies ReviewResult);
    }
    this.save();
  }

  private jobDir(id: string): string {
    return join(this.deps.jobsDir, id);
  }

  private save() {
    this.deps.setSetting(RUNNING, [...this.live.values()]);
  }

  /**
   * Start a review for `uid` (a person, never a turn: the route checks) on their own login. Resolves once it
   * has started; the findings land later as an ultrareview_result event, and in a file in `findingsDir` (writeFindings).
   */
  async start(ticketId: number, uid: number, by: string, spec: ReviewSpec, size: Size, findingsDir?: string): Promise<ReviewEvent> {
    if (this.busy(uid)) throw new Error('You already have an ultra review running. Wait for its findings first.');
    const place = this.deps.place(uid);
    if (!place) throw new Error('Your Claude plan isn\'t linked (Settings → Your account), so there\'s no login of yours to run it on.');
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const dir = join(this.deps.scratch(uid), `ultrareview-${id}`);
    const event: ReviewEvent = { id, by, mode: spec.mode, base: spec.base, ...(spec.mode === 'branch' ? { branch: spec.branch } : { paths: spec.paths }), size };
    const { mode, base, branch, paths } = event;
    const r: Running = { ticketId, uid, id, dir, ...(place.host ? {} : { container: place.container }), ...(findingsDir ? { findings: { dir: findingsDir, ev: { mode, base, branch, paths } } } : {}) };
    this.live.set(id, r);
    this.save();
    this.deps.emit(ticketId, 'ultrareview', event);
    void this.run(r, place, spec);
    return event;
  }

  /** Clone, then start the CLI as a job of its own (src/host-job.ts) and follow it to its end. */
  private async run(r: Running, place: TurnPlace, spec: ReviewSpec) {
    try {
      mkdirSync(r.dir, { recursive: true });
      const repo = join(r.dir, 'repo');
      const base = await prepare(spec, repo);
      const args = ['ultrareview', base, '--trust-workspace', '--timeout', String(TIMEOUT_MIN)];
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
    if (!this.live.has(r.id)) return;
    const job = this.jobs.state(this.jobDir(r.id), MAX_OUTPUT);
    if (!job) return this.finish(r, { id: r.id, ok: false, code: null, text: 'The review\'s run folder is gone, so its findings were lost.' });
    if (job.code === null) return;
    this.finish(r, this.result(r, job));
  }

  private result(r: Running, job: JobState): ReviewResult {
    const code = job.code === -1 ? null : job.code;
    let out = job.output;
    if (code === 124) out += `\nCitadel stopped waiting after ${KILL_MIN} minutes.`;
    if (job.code === -1) out += '\nThe review ended without an exit code: it was stopped, or a restart cut it off.';
    const text = stripAnsi(out).trim();
    const result: ReviewResult = { id: r.id, ok: code === 0, code, text: text || (code === 0 ? 'The review found nothing to report.' : `The review exited with code ${code} and printed nothing.`) };
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
