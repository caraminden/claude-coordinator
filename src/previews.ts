// Previews: a minion's branch served for people to try before it merges. The live server runs the
// worktree's server.ts in preview mode (PREVIEW=1, see server.ts) on a copy of the database, on a
// spare local port, and proxies /preview/<ticket id>/ to it behind the live login. A build's preview
// (build branches, specs/build-branches.md) is the same, keyed by build: /preview/build/<n>/ serves
// the tip of build/<n> from a worktree of the live server's own.
//
// What keeps a preview from acting on the copy is set here, by the live server's code, so it holds
// even if the branch's own preview mode is wrong: no claude to run, no push subscriptions, no secrets.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { Auth, type Session } from './auth.ts';
import type { Project, Store, Ticket } from './db.ts';
import { HttpError } from './http.ts';
import { freePort } from './ports.ts';
import { forward } from './proxy.ts';
import { projectDir } from './workspace.ts';

/** The setting that says a minion offers a preview (its view shows the Open preview button). */
export const previewKey = (ticketId: number) => `preview:${ticketId}`;
/** Where a ticket's preview is served, relative to the app's root. */
export const previewPath = (ticketId: number) => `preview/${ticketId}/`;
/** Where a build's preview is served, relative to the app's root. */
export const buildPreviewPath = (n: number) => `preview/build/${n}/`;

const IDLE_MS = 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const MAX_RUNNING = 5;
const BOOT_TIMEOUT_MS = 30_000;
const KILL_AFTER_MS = 2000;

export class PreviewError extends HttpError {}

interface Running {
  proc: ChildProcess;
  port: number;
  auth: Auth;
  dir: string;
  head: string | null;
  lastUsed: number;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

const head = (cwd: string) => git(['rev-parse', 'HEAD'], cwd);

/** For a checkout, which mustn't hold up the live server's other requests; throws on a failure. */
const gitAsync = promisify(execFile);

/** The commit build/<n> points at in a repo, the local branch first, else origin's; null when there is none. */
export function buildTip(repoDir: string, n: number): string | null {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/build/${n}^{commit}`], repoDir)
    ?? git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/build/${n}^{commit}`], repoDir);
}

const buildKey = (n: number) => `build-${n}`;

/** End a preview's process and wait until it has exited, so nothing writes into its folder as we delete it. */
async function end(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  const timer = setTimeout(() => proc.kill('SIGKILL'), KILL_AFTER_MS);
  await exited;
  clearTimeout(timer);
}

/**
 * Copy the database for a preview that runs on it beside the live one, through the live server's own
 * connection: consistent even while it writes (WAL), and its writes don't restart the backup. Another
 * process copies with copyDb (src/db-copy.ts) and then scrubs, as tools/dev-copy.ts does (#529).
 */
export async function copyData(from: DatabaseSync, to: string): Promise<void> {
  await backup(from, to);
  scrub(to);
}

/**
 * Drop from a copy what only the live server may act on: the push subscriptions, the running turns'
 * records (their systemd units) and the running ultra reviews' (their folders).
 */
export function scrub(to: string): void {
  const copy = new DatabaseSync(to);
  copy.exec("DELETE FROM push_subscriptions; DELETE FROM settings WHERE key LIKE 'turn:%' OR key = 'ultrareview_running'");
  copy.close();
}

/**
 * A preview-mode server.ts's environment, on `port` with its data in `dir`: no turns, no pushes, no
 * new minions. Only what it needs: not this server's secrets, MACHINES_URL or Claude's login.
 */
export function previewEnv(port: number, dir: string, password: string, secret: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
    HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir, PREVIEW: '1', BOOT_CHECK: '1', CLAUDE_BIN: '/bin/false',
    CLAUDE_CONFIG_DIR: join(dir, 'claude'), COORDINATOR_PASSWORD: password, SESSION_SECRET: secret,
  };
}

export class Previews {
  private store: Store;
  readonly root: string;
  private dataDir: string;
  // Keyed by ticket id, or buildKey(n) for a build's.
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<Running>>();
  private stopping = new Map<string, Promise<void>>();
  /** A ticket's offer changed (its view's preview flag). */
  onChange: (ticketId: number) => void = () => {};
  /** The scheme whose code this server runs: only its builds have previews (server.ts sets it). */
  buildScheme: () => Project | null = () => null;
  idleMs = IDLE_MS;
  max = MAX_RUNNING;

  constructor(store: Store, dataDir: string) {
    this.store = store;
    this.dataDir = dataDir;
    this.root = join(dataDir, 'previews');
    // Previews die with the server that started them (same service, same cgroup), so any folder here is stale.
    rmSync(this.root, { recursive: true, force: true });
    setInterval(() => this.sweep(), SWEEP_MS).unref();
    process.on('exit', () => {
      for (const r of this.running.values()) r.proc.kill();
    });
  }

  offered(ticketId: number): boolean {
    return !!this.store.getSetting(previewKey(ticketId));
  }

  /** A running preview by its key (a ticket id, or build-<n> for a build's), with the commit it runs; null when it isn't running. */
  runningAt(key: string): { commit: string | null } | null {
    const r = this.running.get(key);
    return r ? { commit: r.head } : null;
  }

  isRunning(ticketId: number): boolean {
    return this.running.has(String(ticketId));
  }

  /** (Re)start a ticket's preview from its worktree as it is now, and offer it. */
  async start(ticket: Ticket): Promise<void> {
    if (ticket.kind !== 'ticket' || !ticket.cwd || !ticket.branch) throw new PreviewError(400, 'Only a minion with a worktree can have a preview');
    if (ticket.status === 'closed') throw new PreviewError(409, 'This minion is dismissed');
    if (!existsSync(join(ticket.cwd, 'server.ts'))) throw new PreviewError(400, 'This worktree has no server.ts to preview');
    await this.boot(String(ticket.id), ticket.cwd);
    // Dismissed while it booted: runner.onClose's stop came before there was anything to stop.
    const now = this.store.getTicket(ticket.id);
    if (!now || now.status === 'closed') {
      await this.stop(ticket.id, true);
      throw new PreviewError(409, 'This minion is dismissed');
    }
    if (!this.offered(ticket.id)) {
      this.store.setSetting(previewKey(ticket.id), { at: Date.now() });
      this.onChange(ticket.id);
    }
  }

  /**
   * Stop a ticket's preview and, once its process has exited, delete its copy of the data; `forget`
   * also withdraws the offer. Resolves when the folder is gone.
   */
  stop(ticketId: number, forget = false): Promise<void> {
    const job = this.halt(String(ticketId));
    if (forget && this.offered(ticketId)) {
      this.store.deleteSetting(previewKey(ticketId));
      this.onChange(ticketId);
    }
    return job;
  }

  private halt(key: string): Promise<void> {
    const r = this.running.get(key);
    if (r) {
      this.running.delete(key);
      const job = end(r.proc)
        .then(() => rmSync(r.dir, { recursive: true, force: true }))
        .finally(() => this.stopping.delete(key));
      this.stopping.set(key, job);
    }
    return this.stopping.get(key) ?? Promise.resolve();
  }

  /** Stop previews nobody has used for idleMs; a page load starts them again. Drop builds whose branch went. */
  async sweep(now = Date.now()) {
    const idle = [...this.running].filter(([, r]) => now - r.lastUsed > this.idleMs);
    await Promise.all(idle.map(([key]) => this.halt(key)));
    const scheme = this.buildScheme();
    if (!scheme?.repo_dir) return;
    for (const name of existsSync(this.buildsDir(scheme)) ? readdirSync(this.buildsDir(scheme)) : []) {
      const n = Number(name);
      if (!Number.isInteger(n) || n < 1 || !buildTip(scheme.repo_dir, n)) await this.dropBuild(scheme, n, name);
    }
  }

  /** Where a scheme's build previews keep their worktrees: its data folder, as build/<n> is checked out nowhere else. */
  private buildsDir(scheme: Project): string {
    return join(projectDir(this.dataDir, scheme.id), 'build-previews');
  }

  /** A build that landed or was dropped: stop its preview and remove its worktree (its copy of the data goes with the stop). */
  private async dropBuild(scheme: Project, n: number, name = String(n)) {
    // A boot under way would otherwise come up after the halt, on a worktree removed under it.
    await this.starting.get(buildKey(n))?.catch(() => {});
    await this.halt(buildKey(n));
    const dir = join(this.buildsDir(scheme), name);
    if (!existsSync(dir)) return;
    if (scheme.repo_dir) git(['worktree', 'remove', '--force', dir], scheme.repo_dir);
    rmSync(dir, { recursive: true, force: true });
    if (scheme.repo_dir) git(['worktree', 'prune'], scheme.repo_dir);
  }

  /** One boot at a time per preview: a page load during a start waits for it. */
  private boot(key: string, cwd: string, prepare?: () => Promise<void>): Promise<Running> {
    const pending = this.starting.get(key);
    if (pending) return pending;
    const job = this.spawnPreview(key, cwd, prepare).finally(() => this.starting.delete(key));
    this.starting.set(key, job);
    return job;
  }

  /** `prepare` runs once the old process is gone, so a build's worktree moves only under a stopped server. */
  private async spawnPreview(key: string, cwd: string, prepare?: () => Promise<void>): Promise<Running> {
    // Also waits out a stop already under way, which would otherwise delete the new copy.
    await this.halt(key);
    await prepare?.();
    while (this.running.size >= this.max) {
      const [lru] = [...this.running].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      await this.halt(lru);
    }
    const dir = join(this.root, key);
    rmSync(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await copyData(this.store.db, join(dir, 'coordinator.db'));

    const port = await freePort();
    const password = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const proc = spawn(process.execPath, [join(cwd, 'server.ts')], {
      cwd,
      env: previewEnv(port, dir, password, secret),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const keep = (d: Buffer) => (log = (log + d).slice(-3000));
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    const r: Running = { proc, port, auth: new Auth(password, secret), dir, head: head(cwd), lastUsed: Date.now() };
    proc.on('exit', () => {
      if (this.running.get(key) !== r) return;
      this.running.delete(key);
      rmSync(dir, { recursive: true, force: true });
    });
    const fail = async (why: string) => {
      await end(proc);
      rmSync(dir, { recursive: true, force: true });
      return new PreviewError(502, `${why}${log ? `\n--- preview output ---\n${log}` : ''}`);
    };
    for (const deadline = Date.now() + BOOT_TIMEOUT_MS; ; await new Promise((res) => setTimeout(res, 100))) {
      if (proc.exitCode !== null || proc.signalCode) throw await fail(`The preview exited during boot (code ${proc.exitCode})`);
      if (Date.now() > deadline) throw await fail(`The preview did not answer within ${BOOT_TIMEOUT_MS / 1000} s`);
      // A server that accepts and never answers must not hold the loop past its deadline: fetch alone waits 5 minutes.
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }).then((res) => (res.ok ? res.json() : null), () => null);
      if (!health) continue;
      // A branch from before preview mode would serve with turns and pushes switched on.
      if (health.preview !== true) throw await fail('This branch\'s server has no preview mode; rebase it onto main first');
      break;
    }
    this.running.set(key, r);
    return r;
  }

  /**
   * Serve /preview/<id>/... for a signed-in person. A page load starts a stopped preview (or restarts
   * one whose branch moved on); anything else to a stopped one gets a 503, so a forgotten tab's
   * stream doesn't keep it alive.
   */
  async proxy(req: IncomingMessage, res: ServerResponse, ticketId: number, rest: string, session: Session | null) {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket || ticket.status === 'closed' || !this.offered(ticketId)) throw new PreviewError(404, 'There is no preview for this minion');
    const page = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
    let r = this.running.get(String(ticketId));
    // Only a person's page load starts one; a file token's request reaches a running preview only.
    if (page && session && (!r || r.head !== head(ticket.cwd!))) r = await this.boot(String(ticketId), ticket.cwd!);
    this.serve(req, res, r, rest, session);
  }

  /**
   * Serve /preview/build/<n>/... for a signed-in person: build/<n>'s tip, in the scheme whose code this
   * server runs. A page load starts it, and the first one after the tip moved checks out the new tip and
   * restarts it on a fresh copy of the data. A build with no branch has none, and loses what it had.
   */
  async proxyBuild(req: IncomingMessage, res: ServerResponse, n: number, rest: string, session: Session | null) {
    const scheme = this.buildScheme();
    const repo = scheme?.repo_dir;
    const tip = repo ? buildTip(repo, n) : null;
    if (!scheme || !repo || !tip) {
      if (scheme) await this.dropBuild(scheme, n);
      throw new PreviewError(404, `There is no build/${n} branch to preview`);
    }
    const page = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
    const key = buildKey(n);
    let r = this.running.get(key);
    if (page && session && (!r || r.head !== tip)) {
      const cwd = join(this.buildsDir(scheme), String(n));
      r = await this.boot(key, cwd, async () => {
        const opts = { cwd: repo, timeout: 60_000 };
        try {
          // Detached, so build/<n> stays free for the feeders' merges to move; nobody edits this worktree, so --force loses nothing.
          if (existsSync(join(cwd, '.git'))) await gitAsync('git', ['checkout', '--quiet', '--force', '--detach', tip], { ...opts, cwd });
          else {
            rmSync(cwd, { recursive: true, force: true });
            await gitAsync('git', ['worktree', 'prune'], opts);
            await gitAsync('git', ['worktree', 'add', '--quiet', '--detach', cwd, tip], opts);
          }
        } catch (err: any) {
          throw new PreviewError(502, `Could not check out build/${n} for its preview: ${String(err.stderr || err.message).trim()}`);
        }
        if (!existsSync(join(cwd, 'server.ts'))) throw new PreviewError(400, `build/${n} has no server.ts to preview`);
      });
    }
    this.serve(req, res, r, rest, session);
  }

  private serve(req: IncomingMessage, res: ServerResponse, r: Running | undefined, rest: string, session: Session | null) {
    if (!r) throw new PreviewError(503, 'This preview stopped after an hour unused; reload the page to start it again');
    // A file token's request comes from anyone holding the link, so only a person keeps a preview up.
    if (session) r.lastUsed = Date.now();

    const headers = { ...req.headers };
    delete headers.authorization;
    // The live cookie means nothing to the preview; it gets its own, for the same person (none for a file token's request).
    if (session) headers.cookie = r.auth.issueCookie({ id: session.uid ?? -1, name: session.name }, false).split(';')[0];
    else delete headers.cookie;
    // Never let the preview set or clear the live session cookie.
    forward(req, res, r.port, rest, headers, { what: 'The preview', answer: (h) => delete h['set-cookie'] });
  }
}
