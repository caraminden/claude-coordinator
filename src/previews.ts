// Previews: a minion's branch served for people to try before it merges. The live server runs the
// worktree's server.ts in preview mode (PREVIEW=1, see server.ts) on a copy of the database, on a
// spare local port, and proxies /preview/<ticket id>/ to it behind the live login.
//
// What keeps a preview from acting on the copy is set here, by the live server's code, so it holds
// even if the branch's own preview mode is wrong: no claude to run, no push subscriptions, no secrets.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Auth, type Session } from './auth.ts';
import type { Store, Ticket } from './db.ts';
import { HttpError } from './http.ts';
import { freePort } from './ports.ts';
import { forward } from './proxy.ts';

/** The setting that says a minion offers a preview (its view shows the Open preview button). */
export const previewKey = (ticketId: number) => `preview:${ticketId}`;
/** Where a ticket's preview is served, relative to the app's root. */
export const previewPath = (ticketId: number) => `preview/${ticketId}/`;

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

function head(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** End a preview's process and wait until it has exited, so nothing writes into its folder as we delete it. */
async function end(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  const timer = setTimeout(() => proc.kill('SIGKILL'), KILL_AFTER_MS);
  await exited;
  clearTimeout(timer);
}

export class Previews {
  private store: Store;
  readonly root: string;
  private running = new Map<number, Running>();
  private starting = new Map<number, Promise<Running>>();
  private stopping = new Map<number, Promise<void>>();
  /** A ticket's offer changed (its view's preview flag). */
  onChange: (ticketId: number) => void = () => {};
  idleMs = IDLE_MS;
  max = MAX_RUNNING;

  constructor(store: Store, dataDir: string) {
    this.store = store;
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

  isRunning(ticketId: number): boolean {
    return this.running.has(ticketId);
  }

  /** (Re)start a ticket's preview from its worktree as it is now, and offer it. */
  async start(ticket: Ticket): Promise<void> {
    if (ticket.kind !== 'ticket' || !ticket.cwd || !ticket.branch) throw new PreviewError(400, 'Only a minion with a worktree can have a preview');
    if (ticket.status === 'closed') throw new PreviewError(409, 'This minion is dismissed');
    if (!existsSync(join(ticket.cwd, 'server.ts'))) throw new PreviewError(400, 'This worktree has no server.ts to preview');
    await this.boot(ticket);
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
    const r = this.running.get(ticketId);
    if (r) {
      this.running.delete(ticketId);
      const job = end(r.proc)
        .then(() => rmSync(r.dir, { recursive: true, force: true }))
        .finally(() => this.stopping.delete(ticketId));
      this.stopping.set(ticketId, job);
    }
    if (forget && this.offered(ticketId)) {
      this.store.deleteSetting(previewKey(ticketId));
      this.onChange(ticketId);
    }
    return this.stopping.get(ticketId) ?? Promise.resolve();
  }

  /** Stop previews nobody has used for idleMs; a page load starts them again. */
  async sweep(now = Date.now()) {
    const idle = [...this.running].filter(([, r]) => now - r.lastUsed > this.idleMs);
    await Promise.all(idle.map(([id]) => this.stop(id)));
  }

  /** One boot at a time per ticket: a page load during a start waits for it. */
  private boot(ticket: Ticket): Promise<Running> {
    const pending = this.starting.get(ticket.id);
    if (pending) return pending;
    const job = this.spawnPreview(ticket).finally(() => this.starting.delete(ticket.id));
    this.starting.set(ticket.id, job);
    return job;
  }

  private async spawnPreview(ticket: Ticket): Promise<Running> {
    // Also waits out a stop already under way, which would otherwise delete the new copy.
    await this.stop(ticket.id);
    while (this.running.size >= this.max) {
      const [lru] = [...this.running].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      await this.stop(lru);
    }
    const dir = join(this.root, String(ticket.id));
    rmSync(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // A consistent copy even while this server writes (WAL), minus the push subscriptions, the
    // running turns' records (their systemd units) and the running ultra reviews' (their folders),
    // which only the live server may act on.
    const db = join(dir, 'coordinator.db');
    await backup(this.store.db, db);
    const copy = new DatabaseSync(db);
    copy.exec("DELETE FROM push_subscriptions; DELETE FROM settings WHERE key LIKE 'turn:%' OR key = 'ultrareview_running'");
    copy.close();

    const port = await freePort();
    const password = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const proc = spawn(process.execPath, [join(ticket.cwd, 'server.ts')], {
      cwd: ticket.cwd,
      // Only what it needs: not this server's secrets, MACHINES_URL or Claude's login.
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
        HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dir, PREVIEW: '1', BOOT_CHECK: '1', CLAUDE_BIN: '/bin/false',
        CLAUDE_CONFIG_DIR: join(dir, 'claude'), COORDINATOR_PASSWORD: password, SESSION_SECRET: secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const keep = (d: Buffer) => (log = (log + d).slice(-3000));
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    const r: Running = { proc, port, auth: new Auth(password, secret), dir, head: head(ticket.cwd), lastUsed: Date.now() };
    proc.on('exit', () => {
      if (this.running.get(ticket.id) !== r) return;
      this.running.delete(ticket.id);
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
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => (res.ok ? res.json() : null), () => null);
      if (!health) continue;
      // A branch from before preview mode would serve with turns and pushes switched on.
      if (health.preview !== true) throw await fail('This branch\'s server has no preview mode; rebase it onto main first');
      break;
    }
    this.running.set(ticket.id, r);
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
    let r = this.running.get(ticketId);
    // Only a person's page load starts one; a file token's request reaches a running preview only.
    if (page && session && (!r || r.head !== head(ticket.cwd))) r = await this.boot(ticket);
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
