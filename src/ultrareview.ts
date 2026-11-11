// Ultra review from Citadel (#432): a person's click runs `claude ultrareview` on their own Claude
// login (their container, or the host for the server login's owner: src/claude-link.ts place), on a
// minion's branch or on an area of the repo, and posts the findings in the chat it came from.
// It's billed per run once an account's 3 free runs are gone, so only a person starts one: its route is
// person-only (src/routes/tickets.ts), no MCP tool reaches it, and the tripwire stops a turn running the CLI.
//
// Area mode: a scratch clone gets a base branch that is the repo minus the area's paths and a branch
// that adds them back, so the diff is just the area while the reviewer still sees the whole repo.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveClaude, stripAnsi, type TurnPlace } from './claude-link.ts';

const run = promisify(execFile);

/** The CLI's default caps on a diff; it refuses a bigger one before any run is used, and says which caps apply. */
export const LIMITS = { files: 500, lines: 8000 };
/** The CLI waits this long for findings (its --timeout); Citadel gives up a few minutes after. */
export const TIMEOUT_MIN = 45;
const KILL_MS = (TIMEOUT_MIN + 5) * 60_000;
const MAX_OUTPUT = 256 * 1024;
/** Where running reviews are listed, so a server that restarted under one can say it was lost. */
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
}

interface Running { ticketId: number; uid: number; id: string; dir: string; container?: string }

export class UltraReviews {
  private live = new Map<string, Running>();
  private deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** Reviews running now (a restart waits for them: runner.hostJobs). */
  running(): number {
    return this.live.size;
  }

  /** Reviews running in a person's container, so a turn starting there doesn't restart it under them. */
  inContainer(name: string): number {
    return [...this.live.values()].filter((r) => r.container === name).length;
  }

  busy(uid: number): boolean {
    return [...this.live.values()].some((r) => r.uid === uid);
  }

  /**
   * After a restart: reviews the last server was running are gone (shortcut: it ran them as children, and
   * a restart waits for them, so only a crash loses one; move them into units if that ever bites).
   */
  recover() {
    for (const r of this.deps.getSetting<Running[]>(RUNNING) ?? []) {
      rmSync(r.dir, { recursive: true, force: true });
      this.deps.emit(r.ticketId, 'ultrareview_result', { id: r.id, ok: false, code: null, text: 'Citadel restarted while this review ran, so its findings were lost. The run may still count against the free runs.' } satisfies ReviewResult);
    }
    this.deps.setSetting(RUNNING, []);
  }

  private save() {
    this.deps.setSetting(RUNNING, [...this.live.values()]);
  }

  /**
   * Start a review for `uid` (a person, never a turn: the route checks) on their own login. Resolves once it
   * has started; the findings land later as an ultrareview_result event. `saveFindings` writes them to a file.
   */
  async start(ticketId: number, uid: number, by: string, spec: ReviewSpec, size: Size, saveFindings?: (text: string) => string | undefined): Promise<ReviewEvent> {
    if (this.busy(uid)) throw new Error('You already have an ultra review running. Wait for its findings first.');
    const place = this.deps.place(uid);
    if (!place) throw new Error('Your Claude plan isn\'t linked (Settings → Your account), so there\'s no login of yours to run it on.');
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const dir = join(this.deps.scratch(uid), `ultrareview-${id}`);
    const r: Running = { ticketId, uid, id, dir, ...(place.host ? {} : { container: place.container }) };
    this.live.set(id, r);
    this.save();
    const event: ReviewEvent = { id, by, mode: spec.mode, base: spec.base, ...(spec.mode === 'branch' ? { branch: spec.branch } : { paths: spec.paths }), size };
    this.deps.emit(ticketId, 'ultrareview', event);
    void this.run(r, place, spec, saveFindings);
    return event;
  }

  private async run(r: Running, place: TurnPlace, spec: ReviewSpec, saveFindings?: (text: string) => string | undefined) {
    let result: ReviewResult;
    try {
      mkdirSync(r.dir, { recursive: true });
      const repo = join(r.dir, 'repo');
      const base = await prepare(spec, repo);
      const args = ['ultrareview', base, '--trust-workspace', '--timeout', String(TIMEOUT_MIN)];
      let child: ChildProcess;
      if (place.host) {
        child = spawn(this.deps.claudeBin, args, { cwd: repo, env: this.deps.hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        await place.ensure();
        // podman exec passes none of the server's environment, so the container's own sign-in is the only login.
        const env = Object.entries(place.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        child = spawn('podman', ['exec', '-w', repo, ...env, place.container, resolveClaude(this.deps.claudeBin), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      }
      const { code, out } = await collect(child, KILL_MS);
      const text = stripAnsi(out).trim();
      result = { id: r.id, ok: code === 0, code, text: text || (code === 0 ? 'The review found nothing to report.' : `The review exited with code ${code} and printed nothing.`) };
      if (code === 0) {
        try {
          const file = saveFindings?.(result.text);
          if (file) result.file = file;
        } catch {}
      }
    } catch (err: any) {
      result = { id: r.id, ok: false, code: null, text: `The review didn't start: ${String(err?.stderr || err?.message || err).trim()}` };
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
      this.live.delete(r.id);
      this.save();
    }
    this.deps.emit(r.ticketId, 'ultrareview_result', result);
  }
}

function collect(child: ChildProcess, killMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const take = (buf: Buffer) => { out = (out + buf.toString()).slice(-MAX_OUTPUT); };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    const timer = setTimeout(() => { out += `\nCitadel stopped waiting after ${killMs / 60_000} minutes.`; child.kill(); }, killMs);
    child.on('error', (err) => { out += `\n${err.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
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
