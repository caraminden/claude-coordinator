// Claude Coordinator: a shared web UI over headless Claude Code sessions.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileType, findArtifacts, isArtifact, linkedPaths } from './src/artifacts.ts';
import { APP_NAME } from './src/appname.ts';
import { Auth, type Nonces } from './src/auth.ts';
import { branchStatus, shipLine, type BranchStatus } from './src/branch.ts';
import { GITHUB_NAME, GithubWatcher } from './src/github.ts';
import { claudeConfigDir, lastEffort, saveSession } from './src/sessions.ts';
import { Store, type Artifact, type Project, type Ticket, type TicketTag } from './src/db.ts';
import { MachineRelay } from './src/machines.ts';
import { Pusher, loadVapidKeys, type PushTrigger } from './src/push.ts';
import { Runner, slimEvent } from './src/runner.ts';
import { Previews, previewPath } from './src/previews.ts';
import { type Chain, LiveWaiters } from './src/wake.ts';
import { catchUpTicketDir, createTicketDir, projectDir, projectSharedDir } from './src/workspace.ts';
import { describeCron, runBrief, type Schedule } from './src/schedules.ts';
import { keepServing, safely } from './src/safely.ts';
import { acceptsGzip, HttpError, json, requestUrl, router, SECURITY_HEADERS, send, type App } from './src/http.ts';
import { agentRoutes, machineRoutes } from './src/routes/machines.ts';
import { appRoutes } from './src/routes/app.ts';
import { pushRoutes } from './src/routes/push.ts';
import { projectRoutes } from './src/routes/projects.ts';
import { DEPLOY_FAILURE, ticketRoutes } from './src/routes/tickets.ts';
import { fileRoutes } from './src/routes/files.ts';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8573);
// Where machines' agents connect, if not the app's own address: a URL on a private network (the
// tailnet), served by a second listener that takes nothing but agents. The main listener then
// refuses agents, so a leaked token is no use from the public internet.
const MACHINES_URL = process.env.MACHINES_URL ? new URL(process.env.MACHINES_URL) : null;
const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator');
const PUBLIC_DIR = join(import.meta.dirname, 'public');
// Headless turns can't ask for approval, so anything short of full access refuses most shell commands;
// every thread gets full access.
const THREAD_PERMISSION_MODE = 'bypassPermissions';
const LOCAL_HOST = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;

await mkdir(DATA_DIR, { recursive: true });
// The front end as it was when this server started, or last reloaded on SIGHUP. Serving this copy,
// not the files on disk, keeps pages in step with the running server: a deploy that changes the
// server swaps both at the restart, so a tab never gets a new front end that calls API routes the old
// server doesn't have yet. A deploy that changes only public/ sends SIGHUP instead (tools/deploy.sh).
let ASSETS = new Map<string, Buffer>();
// Fingerprint of the front end, so open tabs can tell they are stale after a deploy.
let ASSET_VERSION = '';
let DARK_MANIFEST = Buffer.alloc(0);
async function loadAssets() {
  const assets = new Map<string, Buffer>();
  for (const f of (await readdir(PUBLIC_DIR, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort()) {
    const body = await readFile(join(PUBLIC_DIR, f));
    assets.set(f, /\.(html|js|webmanifest)$/.test(f) ? Buffer.from(body.toString('utf8').replaceAll('%APP_NAME%', SHOWN_NAME)) : body);
  }
  // Built before anything is swapped, so a bad manifest leaves the old front end whole.
  const dark = darkManifest(assets);
  ASSETS = assets;
  ASSET_VERSION = createHash('sha256').update([...assets.values()].join('\0')).digest('hex').slice(0, 12);
  DARK_MANIFEST = dark;
}
// The commit this server's code came from, so a deploy can tell whether the change it ships is
// front end only. null outside a git checkout.
function checkoutHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
const BOOT_COMMIT = checkoutHead();
// Set by tools/deploy.sh when it boots new code on a copy of the database: serve and answer, but
// don't resume interrupted turns or watch GitHub, which would act on the copy's minions for real.
// A preview (src/previews.ts): a minion's branch served on a copy of the database for people to try.
// Everything BOOT_CHECK skips, and more: no turns at all, no new minions or schemes (git in the real
// repos), no pushes, no machines, no startup sweeps.
const PREVIEW = process.env.PREVIEW === '1';
const BOOT_CHECK = process.env.BOOT_CHECK === '1' || PREVIEW;
// The tab title tells a preview from the live app.
const SHOWN_NAME = PREVIEW ? `${APP_NAME} preview` : APP_NAME;
// A preview goes with the server that started it, however that one goes (it is reparented then).
const PARENT = process.ppid;
if (PREVIEW) setInterval(() => process.ppid !== PARENT && process.exit(0), 2000).unref();
await loadAssets();
const store = new Store(join(DATA_DIR, 'coordinator.db'));
// A thread's turn-token nonces live in settings, so turns that run through a restart keep theirs; a closed one's are dead.
const auth = new Auth(process.env.COORDINATOR_PASSWORD ?? '', process.env.SESSION_SECRET ?? '', {
  get: (id) => {
    const ticket = store.getTicket(id);
    return ticket ? { ...(store.getSetting<Nonces>(`agent-nonce:${id}`) ?? { current: null, previous: null }), closed: ticket.status === 'closed' } : null;
  },
  set: (id, nonces) => store.setSetting(`agent-nonce:${id}`, nonces),
});
// Keep secrets out of the environment that claude and its tools inherit.
delete process.env.COORDINATOR_PASSWORD;
delete process.env.SESSION_SECRET;

const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;
const clients = new Set<ServerResponse>();
function broadcast(msg: object) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) {
    // Drop clients that stopped reading rather than buffering for them forever.
    if (res.writableLength > MAX_CLIENT_BACKLOG) {
      clients.delete(res);
      res.destroy();
    } else {
      res.write(data);
    }
  }
}

const runner = new Runner(
  store,
  broadcast,
  (ticket) => ({
    COORDINATOR_API: `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${PORT}`,
    COORDINATOR_TOKEN: auth.turnToken(ticket.id),
    COORDINATOR_PROJECT: String(ticket.project_id),
  }),
  process.env.CLAUDE_BIN ?? 'claude',
);
// Turns run in units of their own when this is the systemd service (systemd sets INVOCATION_ID), so a
// restart doesn't stop them; TURN_UNITS=0 or 1 overrides that.
runner.units = process.env.TURN_UNITS ? process.env.TURN_UNITS === '1' : !!process.env.INVOCATION_ID;
runner.noTurns = PREVIEW;
// Minions' branches served for people to try (src/previews.ts); a preview serves none of its own.
const previews = PREVIEW ? null : new Previews(store, DATA_DIR);
if (previews) {
  previews.onChange = (ticketId) => runner.broadcastTicket(ticketId);
  runner.onClose = (ticketId) => previews.stop(ticketId, true);
}
if (!BOOT_CHECK) runner.recover();
if (runner.units && !BOOT_CHECK) {
  execFile('systemctl', ['--user', 'show', '-p', 'MemoryMax', '--value', 'citadel.slice'], (err, out) => {
    if (err || out.trim() === 'infinity') console.warn('citadel.slice has no MemoryMax, so turns run uncapped: install deploy/citadel.slice (see README).');
  });
}
// Minions that called wake_when_live hear from "Citadel" once the deploy they wait on is live. Sent
// with runner.send, not relay, so the loop guard neither counts nor holds them.
const waiters = new LiveWaiters(store, import.meta.dirname, BOOT_COMMIT, (ticketId, text) => runner.send(ticketId, APP_NAME, text));
/** The server now runs `head`: wake its waiters, and dismiss pending-deploy minions it ships. */
function liveOn(head: string | null) {
  waiters.check(head);
  for (const id of waiters.pendingLive()) runner.deployLive(id);
}
const machines = new MachineRelay(store, () => broadcast({ type: 'machines', machines: machines.list() }));
runner.machines = () => machines.online();

// ---------- push notifications ----------

const pusher = new Pusher(store, loadVapidKeys(DATA_DIR));
// Push services may contact the sender at this address; set from the first subscribe if not given.
pusher.subject = process.env.PUSH_SUBJECT ?? store.getSetting<string>('push_subject') ?? pusher.subject;

/** Ping everyone subscribed to the ticket's project (but `except`) if the trigger warrants it. */
function notify(ticketId: number, trigger: PushTrigger, except: string | null = null) {
  // A boot check's turns and a preview's copy are nobody's news.
  if (BOOT_CHECK) return;
  const ticket = store.getTicket(ticketId);
  if (ticket) pusher.notify(ticket, trigger, except).catch((err) => console.error(`Push for ticket ${ticketId} failed:`, err));
}

runner.onTurnError = (ticketId, text) => notify(ticketId, { kind: 'error', text });

// Chained minions (create_ticket's start_after): one starts with its held brief, on a branch caught
// up to main so it builds on the work it waited for, once its leader's work is in.
async function startChained(c: Chain, why: string) {
  const t = store.getTicket(c.ticket);
  if (!t) return;
  const repo = store.getProject(t.project_id)?.repo_dir ?? null;
  await catchUpTicketDir(t.cwd, repo).catch((err) => console.error(`Catching up #${t.number}'s branch failed:`, err));
  runner.emit(c.ticket, 'note', { text: `${why}, so this minion started.` });
  runner.send(c.ticket, c.from, c.message, [], { brief: true });
}
waiters.start = (c, why) => void startChained(c, why);
// Its leader was dismissed without shipping: it stays parked, and people and the Taskmaster hear once.
waiters.hold = (c, why) => {
  const t = store.getTicket(c.ticket);
  if (!t) return;
  const leader = store.getTicket(c.after);
  store.updateTicket(c.ticket, { state: 'blocked', note: `#${leader?.number ?? c.after} didn't ship: message it to start, or dismiss` });
  runner.emit(c.ticket, 'note', { text: `${why}, so this minion hasn't started. A message to it starts it with its brief; or dismiss it.` });
  runner.broadcastTicket(c.ticket);
  notify(c.ticket, { kind: 'state', state: 'blocked', note: `${why}, so this one is held` });
  const coordinator = store.getCoordinator(t.project_id);
  if (coordinator) runner.send(coordinator.id, APP_NAME, `${why}, so #${t.number} ${t.title}, chained on it, is held and hasn't started. Ask people whether to start it (message_ticket starts it with its brief) or dismiss it.`);
};
if (!BOOT_CHECK) {
  // A dismissal can be what a chained minion waits for.
  const stopPreview = runner.onClose;
  runner.onClose = (ticketId) => {
    stopPreview(ticketId);
    waiters.check();
  };
  liveOn(BOOT_COMMIT);
}

/**
 * A new minion with its properties and its own worktree in the scheme's repo, not started yet: the
 * caller sends its first message. Properties must be checked already. Throws HttpError 500, leaving
 * nothing behind, when the worktree can't be made.
 */
async function newMinion(project: Project, m: { title: string; tag: TicketTag | null; props: Record<string, unknown>; model?: string | null; effort?: string | null }, by: string) {
  const { id, number } = store.createTicket({ project_id: project.id, title: m.title, tag: m.tag, permission_mode: THREAD_PERMISSION_MODE, created_by: by });
  const { notes } = store.props.set('minion', id, project.id, m.props, by);
  store.props.startStage(id);
  if (m.model || m.effort) store.updateTicket(id, { model: m.model ?? null, effort: m.effort ?? null });
  try {
    const dir = await createTicketDir(DATA_DIR, project.id, project.repo_dir, id, number!, m.title);
    store.setTicketDir(id, dir.cwd, dir.branch);
  } catch (err: any) {
    store.deleteTicket(id);
    throw new HttpError(500, `Could not create working directory: ${err.stderr?.trim() || err.message}`);
  }
  return { id, number: number!, notes };
}

// Scheduled minions (src/schedules.ts): each due schedule starts a fresh minion with its brief. Checked
// every half minute; a schedule that came due while the server was down runs once when it is back.
async function runSchedule(s: Schedule, now = Date.now()) {
  await startScheduled(s, now);
  broadcast({ type: 'schedules', projectId: s.project_id });
}
async function startScheduled(s: Schedule, now: number) {
  const project = store.getProject(s.project_id);
  const last = s.last_ticket_id ? store.getTicket(s.last_ticket_id) : null;
  if (!project) return store.schedules.remove(s.id);
  // Two runs at once would step on each other (and double the cost), so a slot is skipped while the last run works.
  if (last?.status === 'running') return store.schedules.ran(s.id, { error: `#${last.number}, the run before, was still working, so this slot was skipped` }, now);
  try {
    const { id, number } = await newMinion(project, { title: s.name, tag: null, props: { type: s.type } }, APP_NAME);
    store.schedules.ran(s.id, { ticketId: id }, now);
    runner.emit(id, 'note', { text: `Started by the schedule "${s.name}" (${describeCron(s.cron)}).` });
    runner.send(id, APP_NAME, runBrief(s, new Date(now).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })), [], { brief: true });
    console.log(`Schedule ${s.id} "${s.name}" started #${number}`);
  } catch (err: any) {
    console.error(`Schedule ${s.id} "${s.name}" didn't start:`, err);
    store.schedules.ran(s.id, { error: err.message }, now);
  }
}
let scheduling = false;
async function runDueSchedules() {
  if (scheduling) return;
  scheduling = true;
  try {
    for (const s of store.schedules.due()) await runSchedule(s);
  } finally {
    scheduling = false;
  }
}
if (!BOOT_CHECK) setInterval(() => void safely('schedules', runDueSchedules), 30_000).unref();

// ---------- artifacts ----------

// Rescan a ticket's folder shortly after it may have written files, at most once per delay.
const SCAN_DELAY_MS = 2000;
const scanTimers = new Map<number, NodeJS.Timeout>();
const scanning = new Map<number, Promise<void>>();

function scheduleScan(ticketId: number) {
  if (scanTimers.has(ticketId)) return;
  scanTimers.set(ticketId, setTimeout(() => {
    scanTimers.delete(ticketId);
    scanArtifacts(ticketId).catch((err) => console.error(`Artifact scan of ticket ${ticketId} failed:`, err));
  }, SCAN_DELAY_MS));
}

/** The documents and pages in a project's shared folder, newest first, paths relative to it. */
async function sharedFiles(projectId: number) {
  const dir = projectSharedDir(DATA_DIR, projectId);
  const files = await findArtifacts(dir, false);
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => ({
    ...f, name: basename(f.path), kind: fileType(f.path)?.kind ?? 'text', display_path: `scheme shared/${f.path}`,
  }));
}

// What each project's shared folder held at the last scan, so a change can tell open pages to refresh.
const sharedSeen = new Map<number, string>();

async function scanShared(projectId: number) {
  const sig = JSON.stringify((await sharedFiles(projectId)).map((f) => [f.path, f.size, f.mtime]));
  if (sharedSeen.get(projectId) === sig) return;
  // The first look after a start only records what is there.
  if (sharedSeen.has(projectId)) broadcast({ type: 'artifacts', projectId });
  sharedSeen.set(projectId, sig);
}

async function scanArtifacts(ticketId: number) {
  // One scan per ticket at a time; a request during a scan waits for it, then rescans.
  while (scanning.has(ticketId)) await scanning.get(ticketId);
  const job = (async () => {
    const ticket = store.getTicket(ticketId);
    if (!ticket?.cwd) return;
    const shared = sharedDir(ticket);
    const found = [
      ...(await findArtifacts(ticket.cwd, !!ticket.branch)),
      // Files in the shared folder are stored by absolute path, since they sit outside the working directory.
      ...(await findArtifacts(shared, false)).map((f) => ({ ...f, path: join(shared, f.path) })),
    ];
    // Only files a reply linked are meant for people; the rest are the ticket's own working files.
    // A pinned file stays listed either way.
    const linked = linkedPaths(store.replyTexts(ticketId), ticket.cwd);
    const pinned = new Set(store.pinnedArtifactPaths(ticketId));
    const shown = found.filter((f) => linked.has(isAbsolute(f.path) ? f.path : join(ticket.cwd, f.path)) || pinned.has(f.path));
    if (store.syncArtifacts(ticket, shown)) broadcast({ type: 'artifacts', projectId: ticket.project_id });
    await scanShared(ticket.project_id);
  })();
  scanning.set(ticketId, job);
  try {
    await job;
  } finally {
    scanning.delete(ticketId);
  }
}

runner.onFilesMayChange = (ticketId) => {
  scheduleScan(ticketId);
  scheduleBranchCheck(ticketId);
};
runner.filesDir = sharedDir;
runner.sharedDir = (project) => projectSharedDir(DATA_DIR, project.id);
runner.ticketsDir = (project) => join(projectDir(DATA_DIR, project.id), 'tickets');
// Threads stored before events were slimmed carry megabytes of thinking and usage data nobody
// reads; slim them once so opening a long thread downloads only what the chat shows.
if (!store.getSetting('events_slimmed')) {
  const { changed, deleted } = store.rewriteClaudeEvents((data) => slimEvent(data, true));
  store.db.exec('VACUUM');
  store.setSetting('events_slimmed', 1);
  console.log(`Slimmed stored events: ${changed} rewritten, ${deleted} dropped.`);
}

// Turns from before each turn's cost was kept: work it out from their stored result events, once.
{
  const added = store.backfillTurns();
  if (added) console.log(`Backfilled the cost of ${added} past turns.`);
}

// Pick up anything made while the server was down (or before artifacts existed), one ticket at a time.
// Rows for file types that no longer count as artifacts go first, pinned or not.
store.pruneArtifacts(isArtifact);
// A preview's copy already holds what these sweeps would find, and they read the live folders.
// The vocabulary docs follow the registry; the first run replaces the hand-written ones (kept aside).
if (!PREVIEW) writeVocabularies().catch((err) => console.error('Could not write the property vocabularies:', err));
if (!PREVIEW) void safely('startup sweep', async () => {
  for (const p of store.listProjects()) {
    for (const t of store.listTickets(p.id)) {
      await scanArtifacts(t.id).catch((err) => console.error(`Artifact scan of ticket ${t.id} failed:`, err));
    }
  }
  // Copy every thread's Claude session into the database (only what changed since last time), so
  // threads from before this existed are covered too. Nothing is pruned here: this config dir may be
  // a fresh one that hasn't had the sessions restored into it yet.
  const configDir = claudeConfigDir(process.env);
  for (const p of store.listProjects()) {
    for (const t of store.listTickets(p.id)) {
      if (!t.session_id || runner.isRunning(t.id)) continue;
      // Threads from before the model picker: fill in what they last ran with.
      if (!t.last_effort || !t.last_model) {
        const init = store.listEvents(t.id).reverse().find((e) => e.kind === 'claude' && e.data.includes('"subtype":"init"'));
        const model = t.last_model ?? (init ? JSON.parse(init.data).model ?? null : null);
        store.updateTicketQuietly(t.id, { last_model: model, last_effort: t.last_effort ?? lastEffort(t, configDir) });
      }
      await saveSession(store, t, p, configDir, false).catch((err) => console.error(`Saving the session of ticket ${t.id} failed:`, err));
    }
  }
});

// ---------- branch and pull request ----------

// gh calls go over the network, so a ticket's PR is looked up at most this often; git is checked every time.
const PR_TTL_MS = 60_000;
const branchCache = new Map<number, { status: BranchStatus | null; prAt: number; json: string }>();
const branchTimers = new Map<number, NodeJS.Timeout>();

/** Where a ticket's branch stands (null for tickets without one); broadcast when it changes. */
async function ticketBranch(ticketId: number, maxPrAge = PR_TTL_MS): Promise<BranchStatus | null> {
  const ticket = store.getTicket(ticketId);
  const project = ticket && store.getProject(ticket.project_id);
  if (!ticket?.branch || !project?.repo_dir) return null;
  const cached = branchCache.get(ticketId);
  const prFresh = cached && Date.now() - cached.prAt < maxPrAge;
  const status = await branchStatus(project.repo_dir, ticket.branch, ticket.created_at, !prFresh, { head: waiters.head, checkoutDir: import.meta.dirname });
  if (status && prFresh) status.pr = cached.status?.pr ?? null;
  const json = JSON.stringify(status);
  branchCache.set(ticketId, { status, prAt: prFresh ? cached.prAt : Date.now(), json });
  if (cached && cached.json !== json) broadcast({ type: 'branch', ticketId, status });
  shipChanged(ticketId);
  return status;
}

// ---------- ship status: where a minion's change is, from branch to live ----------

/** The last deploy report that failed, while the server still runs what it ran then. */
function deployFailure(): string | null {
  const f = store.getSetting<{ text: string; head: string | null }>(DEPLOY_FAILURE);
  return f && f.head === waiters.head ? f.text : null;
}
runner.ship = (ticketId) => {
  const status = branchCache.get(ticketId)?.status;
  return status ? shipLine(status, runner.interruptible(), deployFailure()) : null;
};

/** The ship line each minion's row last showed; a change re-sends the minion. */
const shipShown = new Map<number, string>();
function shipChanged(ticketId: number) {
  const now = JSON.stringify(runner.ship(ticketId));
  if (shipShown.get(ticketId) === now) return;
  const first = !shipShown.has(ticketId);
  shipShown.set(ticketId, now);
  if (!first || now !== 'null') runner.broadcastTicket(ticketId);
}

// Deploys happen in other minions' turns, so merged work that isn't live yet is looked at again every
// SHIP_POLL_MS, and at startup every open minion's branch is, so the list has its badges.
const SHIP_POLL_MS = 15_000;
// Only git reads, so a preview shows the badges too.
if (!BOOT_CHECK || PREVIEW) {
  void safely('branch sweep', async () => {
    for (const p of store.listProjects()) {
      for (const t of store.listTickets(p.id)) {
        if (t.kind === 'ticket' && t.branch && t.status !== 'closed') await ticketBranch(t.id).catch(() => {});
      }
    }
  });
  let polling = false; // a slow git can't stack up rounds
  setInterval(() => void safely('ship poll', async () => {
    if (polling) return;
    polling = true;
    try {
      for (const [id, { status }] of branchCache) {
        if (store.getTicket(id)?.status === 'closed') continue;
        if (status?.deploy && !status.deploy.live) await ticketBranch(id).catch(() => {});
        else shipChanged(id);
      }
    } finally {
      polling = false;
    }
  }), SHIP_POLL_MS).unref();
}

// Tickets hear about their PR's CI, reviews, comments, merge and close as messages from "GitHub".
const github = new GithubWatcher(store, (ticketId, text) => runner.send(ticketId, GITHUB_NAME, text));
if (!BOOT_CHECK) github.start();
runner.onTurnEnd = (ticketId) => github.poke(ticketId);

/** After a turn's tool calls (commits, merges, `gh pr create`), look again shortly. */
function scheduleBranchCheck(ticketId: number) {
  if (branchTimers.has(ticketId)) return;
  branchTimers.set(ticketId, setTimeout(() => {
    branchTimers.delete(ticketId);
    ticketBranch(ticketId, runner.isRunning(ticketId) ? PR_TTL_MS : 0)
      .catch((err) => console.error(`Branch check of ticket ${ticketId} failed:`, err));
  }, SCAN_DELAY_MS));
}

/** Where a ticket keeps files it fetched or made to show people, outside its repo. */
function sharedDir(ticket: Ticket): string {
  return join(projectDir(DATA_DIR, ticket.project_id), 'shared', String(ticket.id));
}

/** Rewrite each scheme's property-vocabulary.md from the registry; a hand-written one is kept aside once. */
async function writeVocabularies(projectIds = store.listProjects().map((p) => p.id)) {
  for (const id of projectIds) {
    const project = store.getProject(id);
    if (!project) continue;
    const dir = projectSharedDir(DATA_DIR, id);
    const path = join(dir, 'property-vocabulary.md');
    const text = store.props.doc(id, project.name);
    const old = await readFile(path, 'utf8').catch(() => null);
    if (old === text) continue;
    await mkdir(dir, { recursive: true });
    if (old && !/^generated: true$/m.test(old)) await writeFile(join(dir, 'property-vocabulary.before-registry.md'), old, { flag: 'wx' }).catch(() => {});
    await writeFile(path, text);
  }
}

/** After a registry change: regenerate the docs it touches (every scheme's for a global key). */
function registryChanged(projectId: number, global: boolean) {
  writeVocabularies(global ? undefined : [projectId]).catch((err) => console.error('Could not write the property vocabulary:', err));
  broadcast({ type: 'properties', projectId: global ? null : projectId });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript; charset=utf-8',
};

// Android colours an installed app's status and navigation bars from the manifest, which can't vary
// by light or dark mode yet (color_scheme_dark is still a proposal). Ask the browser for its colour
// scheme and hand dark-mode devices a manifest with the dark colours, so the app doesn't get a white bar.
const COLOR_SCHEME_HINT = 'Sec-CH-Prefers-Color-Scheme';
function darkManifest(assets: Map<string, Buffer>) {
  const manifest = JSON.parse(assets.get('manifest.webmanifest')!.toString());
  return Buffer.from(JSON.stringify({ ...manifest, ...manifest.color_scheme_dark }, null, 2));
}
async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
  let body = ASSETS.get(name);
  if (!body) throw new HttpError(404, 'Not found');
  const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (name === 'index.html') headers['Accept-CH'] = COLOR_SCHEME_HINT;
  if (name === 'manifest.webmanifest') {
    if (/dark/.test(String(req.headers[COLOR_SCHEME_HINT.toLowerCase()] ?? ''))) body = DARK_MANIFEST;
    headers.Vary = `Accept-Encoding, ${COLOR_SCHEME_HINT}`;
  }
  send(res, 200, headers, body);
}

/** What the route table (src/routes/) reaches of this server. */
const app: App = {
  store, runner, auth, waiters, previews, machines, pusher, clients,
  dataDir: DATA_DIR, preview: PREVIEW, machinesUrl: MACHINES_URL, bootCommit: BOOT_COMMIT,
  get assetVersion() {
    return ASSET_VERSION;
  },
  broadcast, notify, newMinion, startChained, ticketBranch, sharedFiles, sharedDir, registryChanged,
};
const routes = router([...appRoutes, ...projectRoutes, ...ticketRoutes, ...fileRoutes, ...machineRoutes, ...pushRoutes]);

const server = createServer(async (req, res) => {
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
  try {
    const url = requestUrl(req);
    const preview = previews && /^\/preview\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (url.pathname.startsWith('/api/')) {
      await routes(app, req, res, url, auth.session(req));
    } else if (preview) {
      const session = auth.session(req);
      // People only, signed in to the live app; a page load without a login goes to the login.
      if (!session || session.agent !== undefined) {
        if (req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''))) return void res.writeHead(302, { Location: '/' }).end();
        throw new HttpError(401, 'Not logged in');
      }
      // The front end's URLs are relative, so the page itself needs the trailing slash.
      if (!preview[2]) return void res.writeHead(302, { Location: `/${previewPath(Number(preview[1]))}${url.search}` }).end();
      await previews.proxy(req, res, Number(preview[1]), preview[2] + url.search, session);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error' : err.message });
    else res.end();
  }
});

// Node's default 5 minutes to receive a whole request is too short for a 200 MB attachment on a slow
// uplink; headers still have to arrive within headersTimeout.
server.requestTimeout = 30 * 60_000;
// Once up, a stray error is logged rather than fatal. Not before: a failed start (a port in use, a
// database that won't open) must still exit non-zero so systemd restarts it.
server.on('listening', keepServing);

// Under socket activation (deploy/claude-coordinator.socket) systemd holds the listening socket, fd 3,
// across restarts: requests made while the server restarts wait for the next one instead of failing.
if (process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid)) {
  server.listen({ fd: 3 }, () => console.log(`${APP_NAME} listening on the socket systemd holds (${HOST}:${PORT})`));
} else {
  server.listen(PORT, HOST, () => console.log(`${APP_NAME} listening on http://${HOST}:${PORT}`));
}

// A restart: running turns carry on in their units, and the next server re-attaches. Stop taking
// requests, end the ones that never finish (event streams, approval long-polls; their callers come
// back), and give the rest a few seconds.
const SHUTDOWN_GRACE_MS = 5000;
process.on('SIGTERM', () => {
  console.log('SIGTERM: finishing requests, then exiting; running turns carry on.');
  runner.detachAll();
  server.close(() => process.exit(0));
  for (const c of clients) c.end();
  runner.approvals.wakeAll();
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
});

// A front-end-only deploy: re-read public/ and tell open tabs, which reload once nobody is typing.
process.on('SIGHUP', () => {
  const before = ASSET_VERSION;
  loadAssets().then(
    () => {
      console.log(`Reloaded public/ on SIGHUP: front end ${before} → ${ASSET_VERSION}`);
      if (ASSET_VERSION !== before) broadcast({ type: 'hello', version: ASSET_VERSION, usage: runner.usage });
      // tools/deploy.sh sends SIGHUP only for a change to public/ alone, so the checkout's HEAD is now live.
      if (!BOOT_CHECK) liveOn(checkoutHead());
    },
    (err) => console.error('Reloading public/ on SIGHUP failed; still serving the old front end:', err),
  );
});

// The machines-only listener: the agent's two endpoints and the agent script, nothing else.
if (MACHINES_URL) {
  const agentApi = router(agentRoutes.filter((r) => r.path === '/api/machines/connect' || r.path === '/api/machines/send'));
  const agents = createServer(async (req, res) => {
    try {
      const url = requestUrl(req);
      if (agentApi.knows(url.pathname)) await agentApi(app, req, res, url, null);
      else if (url.pathname === '/machine-agent.mjs' && req.method === 'GET') await serveStatic(req, res, url.pathname);
      else throw new HttpError(404, 'Not found');
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error' : err.message });
      else res.end();
    }
  });
  const port = Number(MACHINES_URL.port || 80);
  // The tailnet address may not be up yet at boot; keep trying rather than keep the app from starting.
  const listen = () => agents.listen(port, MACHINES_URL.hostname);
  agents.on('listening', () => console.log(`Machines connect at ${MACHINES_URL.origin}`));
  agents.on('error', (err) => {
    console.error(`Machines listener on ${MACHINES_URL.host}: ${err.message}; retrying in 30s`);
    setTimeout(listen, 30_000).unref();
  });
  listen();
}
