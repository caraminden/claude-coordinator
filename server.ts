// Claude Coordinator: a shared web UI over headless Claude Code sessions.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import { isArtifact } from './src/artifacts.ts';
import { APP_NAME } from './src/appname.ts';
import { versionIcons } from './src/icons.ts';
import { claudeRefusal, lendsMachine, machinesFor, mayReceive, ownerAsked, messagePerson, messageScope, turnRefusal } from './src/access.ts';
import { ClaudeLink } from './src/claude-link.ts';
import { CodexLink } from './src/codex-link.ts';
import { Landings } from './src/land.ts';
import { watchLoopLag } from './src/loop-lag.ts';
import { UltraReviews } from './src/ultrareview.ts';
import { Auth, type Nonces, type Session } from './src/auth.ts';
import { GITHUB_NAME, GithubWatcher, originRepo } from './src/github.ts';
import { claudeConfigDir, lastEffort } from './src/sessions.ts';
import { Store, type Artifact, type Project, type User } from './src/db.ts';
import { MachineRelay } from './src/machines.ts';
import { Pusher, loadVapidKeys, type PushTrigger } from './src/push.ts';
import { Runner, slimEvent } from './src/runner.ts';
import { pinTurnFiles, turnEnv } from './src/turn-launch.ts';
import { buildPreviewPath, Previews, previewPath } from './src/previews.ts';
import { AppProxy } from './src/apps.ts';
import { isBackupPath, serveBackup } from './src/backup.ts';
import { type Chain, githubPrs, LiveWaiters, runsRepo, startChained } from './src/wake.ts';
import { errorText, followOrigins } from './src/scheme-repo.ts';
import { createTicketDir, mainSync, projectDir, projectSharedDir, syncMain } from './src/workspace.ts';
import { ScheduledRuns } from './src/schedules.ts';
import { keepServing, safely } from './src/safely.ts';
import { acceptsGzip, HttpError, isSecure, json, ownPath, requestUrl, router, SECURITY_HEADERS, send, type App } from './src/http.ts';
import { agentRoutes, machineRoutes } from './src/routes/machines.ts';
import { appRoutes } from './src/routes/app.ts';
import { pushRoutes } from './src/routes/push.ts';
import { peopleRoutes } from './src/routes/people.ts';
import { Credentials } from './src/credentials.ts';
import { Contraptions, DEFAULT_CONTRAPTIONS_DIR } from './src/contraptions.ts';
import { AppServices, serviceOptions } from './src/app-services.ts';
import { contraptionRoutes } from './src/routes/contraptions.ts';
import { ContraptionTurns } from './src/contraption-turns.ts';
import { GithubLink, schemeGithub } from './src/github-link.ts';
import { RepoAccess } from './src/repo-access.ts';
import { RunnerJobs, RunnerTokens } from './src/ci-runner.ts';
import { CiHealth } from './src/ci-health.ts';
import { repoSlug } from './src/prlinks.ts';
import { CiLoad } from './src/ci-load.ts';
import { callMandate } from './src/mandate-items.ts';
import { adminAlert, adminClear, fallbacks } from './src/fallbacks.ts';
import { TimerAlerts } from './src/timer-alerts.ts';
import { projectRoutes } from './src/routes/projects.ts';
import { llamaEmbed, MemoryIndexer } from './src/memory.ts';
import { ticketRoutes } from './src/routes/tickets.ts';
import { ArtifactScanner } from './src/artifact-scan.ts';
import { ShipStatus } from './src/ship-status.ts';
import { Builds } from './src/builds.ts';
import { Waits } from './src/waits.ts';
import { CiRuns } from './src/ci-wait.ts';
import { fileRoutes } from './src/routes/files.ts';
import { themeCss } from './src/theme.ts';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8573);
// The port actually bound: PORT=0 (tests, boot checks) lets the kernel pick one, reported on stdout.
let boundPort = PORT;
// Where machines' agents connect, if not the app's own address: a URL on a private network (the
// tailnet), served by a second listener that takes nothing but agents. The main listener then
// refuses agents, so a leaked token is no use from the public internet.
const MACHINES_URL = process.env.MACHINES_URL ? new URL(process.env.MACHINES_URL) : null;
const DEFAULT_DATA_DIR = join(homedir(), '.local/share/claude-coordinator');
const DATA_DIR = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
const PUBLIC_DIR = join(import.meta.dirname, 'public');
// Headless turns can't ask for approval, so anything short of full access refuses most shell commands;
// every thread gets full access.
const THREAD_PERMISSION_MODE = 'bypassPermissions';
const LOCAL_HOST = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;

await mkdir(DATA_DIR, { recursive: true });
// The copies of the server files turns run (src/turn-launch.ts): taken first, before a later deploy can move the
// checkout under a server that is still starting, and before any turn starts or is picked up again.
pinTurnFiles(DATA_DIR);
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
  // public/ and its ui/ folder (Citadel UI, the modules apps import from /apps/_citadel/ui/).
  const files = async (sub: string) => (await readdir(join(PUBLIC_DIR, sub), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => sub + e.name);
  for (const f of [...(await files('')), ...(await files('ui/'))].sort()) {
    const body = await readFile(join(PUBLIC_DIR, f));
    assets.set(f, /\.(html|js|webmanifest)$/.test(f) ? Buffer.from(body.toString('utf8').replaceAll('%APP_NAME%', SHOWN_NAME)) : body);
  }
  versionIcons(assets);
  // Contraptions' copy of Citadel's colours, built from style.css (src/theme.ts).
  assets.set('theme.css', Buffer.from(themeCss(assets.get('style.css')!.toString('utf8'))));
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
// Stalls of the event loop are named in the journal (#526), the start's own synchronous work included.
if (!BOOT_CHECK) watchLoopLag();
await loadAssets();
const store = new Store(join(DATA_DIR, 'coordinator.db'));
// A thread's turn-token nonces live in settings, so turns that run through a restart keep theirs; a closed one's are dead.
const auth = new Auth(process.env.COORDINATOR_PASSWORD ?? '', process.env.SESSION_SECRET ?? '', {
  get: (id) => {
    const ticket = store.getTicket(id);
    return ticket ? { ...(store.getSetting<Nonces>(`agent-nonce:${id}`) ?? { current: null, previous: null }), closed: ticket.status === 'closed' } : null;
  },
  set: (id, nonces) => store.setSetting(`agent-nonce:${id}`, nonces),
}, store);
// The first start with per-person logins (or any with no admin) makes the admin, whom COORDINATOR_PASSWORD
// signs in until they set a password, and every scheme from before owners becomes theirs.
if (!store.listUsers().some((u) => u.admin)) {
  const name = process.env.COORDINATOR_ADMIN?.trim() || 'Cara';
  store.createUser({ name, login: name.toLowerCase().replace(/[^a-z0-9._-]/g, ''), admin: true, server_login: true });
}
store.adoptOwnerless(store.listUsers().find((u) => u.admin)!.id);
// Before anything reads repo_url: a scheme whose repo moved on GitHub follows its checkout's origin (#456).
await safely('follow repo moves', () => followOrigins(store));
const credentials = new Credentials(store, process.env.SESSION_SECRET ?? '');
// Only the live data dir writes the real key folders: a dev copy registering "mandate" mustn't overwrite the live one's files.
const contraptions = new Contraptions(store, process.env.SESSION_SECRET ?? '',
  process.env.CITADEL_CONTRAPTIONS_DIR || (DATA_DIR === DEFAULT_DATA_DIR ? DEFAULT_CONTRAPTIONS_DIR : join(DATA_DIR, 'contraptions')));
// Contraptions' systemd user services (#266): only the live server touches systemd, never a boot check or preview.
const services = new AppServices(serviceOptions(process.env, DATA_DIR === DEFAULT_DATA_DIR, BOOT_CHECK, {
  keysDir: (name) => contraptions.folder(name),
  citadelUrl: () => `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`,
  logDir: join(DATA_DIR, 'contraption-deploys'),
}));
const githubLink = new GithubLink(store, credentials, process.env.GITHUB_CLIENT_ID ?? '', process.env.GITHUB_CLIENT_SECRET ?? '', undefined, {
  clientId: process.env.GITHUB_APP_CLIENT_ID ?? '', clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? '', slug: process.env.GITHUB_APP_SLUG ?? '',
});
// A boot check or preview runs on a copy of the data: it leaves GitHub alone.
const repoAccess = new RepoAccess(store, githubLink, !BOOT_CHECK);
const runnerTokens = new RunnerTokens(store, githubLink, !BOOT_CHECK);
// People's own Claude plans (#213). A dev copy tags its containers so it never shares the live server's.
const claudeLink = new ClaudeLink(store, credentials, DATA_DIR, process.env.CLAUDE_BIN ?? 'claude', undefined, DATA_DIR === DEFAULT_DATA_DIR ? 'citadel-claude-' : `citadel-claude-${createHash('sha256').update(DATA_DIR).digest('hex').slice(0, 6)}-`);
// Keep secrets out of the environment that claude and its tools inherit.
delete process.env.COORDINATOR_PASSWORD;
delete process.env.SESSION_SECRET;
delete process.env.GITHUB_CLIENT_SECRET;
delete process.env.GITHUB_APP_CLIENT_SECRET;

const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;
const clients = new Map<ServerResponse, Session>();
function broadcast(msg: object) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  const scope = messageScope(store, msg);
  // The machines list goes to everyone, each person's cut to the machines they manage (#306).
  const machineList = (msg as { type?: string }).type === 'machines' ? (msg as { machines: ReturnType<MachineRelay['list']> }).machines : null;
  for (const [res, who] of clients) {
    // Drop clients that stopped reading rather than buffering for them forever.
    if (res.writableLength > MAX_CLIENT_BACKLOG) {
      clients.delete(res);
      res.destroy();
    } else if (mayReceive(store, who, scope) && (!('payer' in msg) || runner.payerOf(who.uid) === (msg as { payer: number | null }).payer) && (!('to' in msg) || who.uid === (msg as { to: number }).to)) {
      res.write(machineList && !who.admin ? `data: ${JSON.stringify({ ...msg, machines: machinesFor(who, machineList) })}\n\n` : data);
    }
  }
}

const runner = new Runner(
  store,
  broadcast,
  (ticket, token) => ({
    COORDINATOR_API: `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`,
    COORDINATOR_TOKEN: token ?? auth.turnToken(ticket.id),
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
  // Builds' previews are of this server's own code, so only its own scheme has them; checked again once a deploy moves the live commit.
  let own: { head: string | null; id: number | null } | null = null;
  previews.buildScheme = () => {
    if (own?.head !== waiters.head) own = { head: waiters.head, id: store.listProjects().find((p) => runsRepo(p.repo_dir, waiters.head))?.id ?? null };
    return own.id === null ? null : store.getProject(own.id) ?? null;
  };
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
// The server reads a scheme's GitHub (PRs, merges, fetches) as its owner (#321): a private repo may let no one else in.
const githubOf = (repoDir: string) => schemeGithub(store, githubLink, repoDir, DATA_DIR);
waiters.prs = githubPrs(githubOf);
mainSync.as = githubOf;
runner.liveHead = () => waiters.head;
// Semantic memory (#331): llama-server on this box embeds the chats (deploy/citadel-embed.service).
const EMBED_MODEL = process.env.CITADEL_EMBED_MODEL || 'Qwen3-Embedding-0.6B-Q8_0';
const embed = llamaEmbed(process.env.CITADEL_EMBED_URL || 'http://127.0.0.1:21434');
const MEMORY_SCHEMES = process.env.CITADEL_MEMORY_SCHEMES?.split(',').map(Number);
// Every scheme is indexed (#488); CITADEL_MEMORY_SCHEMES narrows it to some, for tests or a box that can't keep up.
const memoryScheme = (id: number) => !MEMORY_SCHEMES || MEMORY_SCHEMES.includes(id);
runner.memoryScheme = memoryScheme;
/** Fetch a scheme's origin and fast-forward its main if it can (#208), then look at the waiters again: a merge on GitHub can be what they wait on (#229). */
function catchUp(repoDir: string) {
  void syncMain(repoDir)
    .catch((err) => console.error(`Catching up main in ${repoDir} failed:`, err))
    .then(() => {
      waiters.prs.forget?.();
      return waiters.check();
    })
    .catch((err) => console.error('Checking waiters after a merge failed:', err));
}
/** The server now runs `head`: wake its waiters, and dismiss pending-deploy minions it ships. */
function liveOn(head: string | null) {
  // Not waited for (#526): its git and gh calls take seconds, and the server answers meanwhile.
  void (async () => {
    await waiters.check(head);
    for (const id of await waiters.pendingLive()) runner.deployLive(id);
  })().catch((err) => console.error('Checking waiters after a deploy failed:', err));
}
const machines = new MachineRelay(store, () => broadcast({ type: 'machines', machines: machines.list() }));
const runnerJobs = new RunnerJobs(store, runnerTokens, machines);
runner.machines = (project, askers) => machines.online().filter((m) => lendsMachine(store, m, project, askers));
runner.refuseTurn = (ticket, author, from) => turnRefusal(store, ticket, author, (uid) => claudeLink.linked(uid), from);
// Sender pays (#213): the server login's owner runs on the host, everyone else in their own container.
runner.placeFor = (person) => {
  const user = person ? store.getUser(person) : undefined;
  if (!user) return { host: true };
  return claudeLink.place(user.id) ?? { refused: claudeRefusal(user, (uid) => claudeLink.linked(uid)) ?? `${user.name}'s Claude isn't ready, so this message waits here.` };
};
runner.onAuthFailure = (person) => claudeLink.expire(person);
const codexLink = new CodexLink(claudeLink);
// Codex turns (#337) run only in a person's own container, once they've signed in to Codex there (the server login's: #341).
const codexReady = (uid: number) => {
  const state = codexLink.status(uid).state;
  return state === 'linked' ? null : state === 'no container' ? 'Codex runs in your own Claude container, so link your Claude in Settings first' : 'you are not signed in to Codex (Settings → Your account)';
};
runner.codexReady = codexReady;
// The server login's owner signs in to Codex in a container of its own, and its Codex turns run there (#341).
runner.codexPlaceFor = (uid) => claudeLink.codexPlace(uid);
// Its host turns' Codex reviews run in that container too (#398), so a host turn starts it if it isn't running.
runner.wakeCodex = (uid) => void claudeLink.wakeCodex(uid).catch((err) => console.error(`Starting the Codex container for a review failed: ${err.message}`));
// Contraptions' turns (the turn API): on the same Claude a person's minion turns use, never anyone else's.
const contraptionTurns = new ContraptionTurns(store, contraptions, claudeLink, { dataDir: DATA_DIR, claudeBin: process.env.CLAUDE_BIN ?? 'claude' });
contraptionTurns.noTurns = PREVIEW;
contraptionTurns.codexWhy = (uid) => runner.codexWhy(uid);
contraptionTurns.onCodexUsage = (uid, limits) => runner.updateCodexUsage(limits, uid);
services.drain = (row) => contraptionTurns.drain(row.id);
// A contraption turn gets its person's own machines that are online (#306), never a shared one.
contraptionTurns.machines = (person) => machines.online().filter((m) => m.owner_id !== null && m.servers.includes('mcp') && ownerAsked(store, m.owner_id, [person], null));
contraptionTurns.apiUrl = () => `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${boundPort}`;
const ultrareviews = new UltraReviews({
  claudeBin: process.env.CLAUDE_BIN ?? 'claude', place: (uid) => claudeLink.place(uid), scratch: (uid) => claudeLink.turnsDir(uid),
  emit: (ticketId, kind, data) => runner.emit(ticketId, kind, data), getSetting: (k) => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v), hostEnv: turnEnv(process.env),
  jobsDir: join(DATA_DIR, 'run', 'ultrareviews'), units: () => runner.units,
});
// A boot check's or preview's copy names the live reviews' folders: only the live server may clear them.
if (!BOOT_CHECK) ultrareviews.recover();
claudeLink.busy = (container) => runner.inContainer(container) + contraptionTurns.inContainer(container) + ultrareviews.inContainer(container);
// Landings run in units of their own when turns do (src/land.ts); only ones that fell back to the server's child count here.
const landings = new Landings(DATA_DIR, () => runner.units);
// Contraption turns and app deploys run as the server's children: a restart waits for them. Ultra reviews
// run in units of their own as landings do; only ones that fell back to a child count.
runner.hostJobs = () => landings.running() + contraptionTurns.running() + services.jobs() + ultrareviews.running();
// Whose turn a message starts: a person by name, or for a relay the person of the turn that sent it.
runner.personOf = messagePerson(store);
runner.githubFor = (person, dir) => githubLink.forTurn(person ? store.getUser(person) ?? null : null, dir);

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

runner.onTurnError = (ticketId, text, eventId) => notify(ticketId, { kind: 'error', text, eventId });

// Chained minions (create_ticket's start_after): one starts with its held brief once its leader's work is in (src/wake.ts startChained).
const startChain = (c: Chain, why: string) => startChained(c, why, { store, runner, waiters });
waiters.start = (c, why) => void startChain(c, why).catch((err) => console.error(`Starting chained #${c.ticket} failed:`, err));
runner.heldFor = (id) => waiters.heldFor(id);
// Its leader was dismissed without shipping: it stays parked, and people and the Taskmaster hear once.
waiters.hold = (c, why) => {
  const t = store.getTicket(c.ticket);
  if (!t) return;
  const leader = store.getTicket(c.after);
  store.updateTicket(c.ticket, { state: 'blocked', note: `#${leader?.number ?? c.after} didn't ship: Start now, or dismiss` });
  runner.emit(c.ticket, 'note', { text: `${why}, so this minion hasn't started. Start now starts it with its brief; or dismiss it.` });
  runner.broadcastTicket(c.ticket);
  notify(c.ticket, { kind: 'state', state: 'blocked', note: `${why}, so this one is held` });
  const coordinator = store.getCoordinator(t.project_id);
  if (coordinator) runner.send(coordinator.id, APP_NAME, `${why}, so #${t.number} ${t.title}, chained on it, is held and hasn't started. Ask people whether to start it (message_ticket with start_now starts it with its brief) or dismiss it.`);
};
if (!BOOT_CHECK) {
  // A dismissal can be what a chained minion waits for.
  const stopPreview = runner.onClose;
  runner.onClose = (ticketId) => {
    const stopped = stopPreview(ticketId);
    // Asked afresh (#321): a minion that merged its PR and dismissed itself may have read "not merged" a moment ago.
    waiters.prs.forget?.();
    void waiters.check().catch((err) => console.error('Checking waiters after a dismissal failed:', err));
    // Its PR may have merged on GitHub with the watcher never seeing it (it watches open minions only).
    const repoDir = store.getProject(store.getTicket(ticketId)?.project_id ?? -1)?.repo_dir;
    if (repoDir) catchUp(repoDir);
    return stopped;
  };
  liveOn(BOOT_COMMIT);
}

/**
 * A new minion with its properties and its own worktree in the scheme's repo, not started yet: the
 * caller sends its first message. Properties must be checked already. Throws HttpError 500, leaving
 * nothing behind, when the worktree can't be made.
 */
async function newMinion(project: Project, m: { title: string; props: Record<string, unknown>; model?: string | null; effort?: string | null; build?: number | null }, by: string) {
  const { id, number } = store.createTicket({ project_id: project.id, title: m.title, permission_mode: THREAD_PERMISSION_MODE, created_by: by });
  const { notes } = store.props.set('minion', id, project.id, m.props, by);
  store.props.startStage(id);
  if (m.model || m.effort) store.updateTicket(id, { model: m.model ?? null, effort: m.effort ?? null });
  // Its build before its worktree: a build with a branch is what it branches from (build branches).
  if (m.build) {
    store.updateTicket(id, { build: m.build });
    store.props.setBuild(id, m.build, by);
  }
  try {
    const dir = await createTicketDir(DATA_DIR, project.id, project.repo_dir, id, number!, m.title, store.getTicket(id)?.build ?? null);
    store.setTicketDir(id, dir.cwd, dir.branch);
  } catch (err: any) {
    store.deleteTicket(id);
    throw new HttpError(500, `Could not create working directory: ${errorText(err)}`);
  }
  return { id, number: number!, notes };
}

// Scheduled minions (src/schedules.ts): each due schedule starts a fresh minion with its brief. Checked
// every half minute; a schedule that came due while the server was down runs once when it is back.
const scheduledRuns = new ScheduledRuns({ store, newMinion, runner, broadcast, by: APP_NAME });
if (!BOOT_CHECK) setInterval(() => void safely('schedules', () => scheduledRuns.runDue()), 30_000).unref();
// Idle Taskmasters with a long context start fresh sessions while their prompt cache is still warm (#406).
if (!BOOT_CHECK && !PREVIEW) setInterval(() => void safely('fresh sessions', () => runner.freshSweep()), 60_000).unref();
if (!BOOT_CHECK && !PREVIEW) setInterval(() => void safely('cold mail', () => runner.coldSweep()), 60_000).unref();
// Dismissed minions' build output (#336): those dismissed before clearing on dismissal, or whose clearing
// failed. Off the boot's hot path, then daily. A preview's rows point at the live worktrees, so never there.
if (!BOOT_CHECK && !PREVIEW) {
  const sweepBuild = () => void safely('build output sweep', () => runner.sweepBuildOutput());
  setTimeout(sweepBuild, 10 * 60_000).unref();
  setInterval(sweepBuild, 24 * 60 * 60_000).unref();
}

// Steps' times from before step_times (#571), once, a minute after boot.
if (!BOOT_CHECK) setTimeout(() => void safely('step times backfill', () => runner.backfillStepTimes()), 60_000).unref();

// Embed what was said since the last pass, a little at a time, never in a request (src/memory.ts).
const memoryIndexer = new MemoryIndexer(store, embed, EMBED_MODEL, memoryScheme);
if (!BOOT_CHECK) setInterval(() => void safely('memory', () => memoryIndexer.run()), Number(process.env.CITADEL_MEMORY_EVERY_MS) || 60_000).unref();

// ---------- artifacts, branch and ship status (src/artifact-scan.ts, src/ship-status.ts) ----------

const artifacts = new ArtifactScanner(store, DATA_DIR, broadcast);
const sharedDir = artifacts.sharedDir;
const ships = new ShipStatus({ store, runner, broadcast, liveHead: () => waiters.head, checkoutDir: import.meta.dirname });
const ticketBranch = ships.branch;
// Each build branch's header in the minions list (src/builds.ts): feeders folded in and open, commits behind main.
const builds = new Builds({ store, broadcast });
runner.ship = ships.ship;

// What each minion waits on (#544): the land line in this checkout's git dir (tools/deploy-queue.sh), the heavy slots.
const deployState = (() => {
  try {
    return join(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'cc-deploy');
  } catch {
    return null;
  }
})();
// CI runs in flight (#546): a minion's PR (the PR watcher below names its runs) and a landing's CI gate, every 20 s.
const ciRuns = new CiRuns({ changed: (id) => waits.check(id) });
let liveSlug: string | null = null;
void originRepo(import.meta.dirname).then((slug) => (liveSlug = slug));
const waits = new Waits({ store, deployState, heavyDir: join(DATA_DIR, 'projects', '.heavy'), ship: ships.ship, interruptible: () => runner.interruptible(), changed: (id) => runner.broadcastTicket(id), ci: ciRuns, ciSlug: () => liveSlug,
  // The land gate's alarm (#561), under the scheme whose repo the live checkout is.
  // Not before the live repo is known: a guess of no scheme would clear the alarm, and a restart would ring it again.
  landLine: (seen, now) => {
    const live = liveSlug && store.listProjects().find((p) => repoSlug(p.repo_url) === liveSlug);
    if (live) ciHealth.land(live.id, seen, now).catch((err) => console.error(`Land alarm: ${err?.message ?? err}`));
  },
});
runner.wait = waits.wait;

runner.onFilesMayChange = (ticketId) => {
  artifacts.schedule(ticketId);
  ships.scheduleCheck(ticketId);
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
      await artifacts.scan(t.id).catch((err) => console.error(`Artifact scan of ticket ${t.id} failed:`, err));
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
      // On its lane, so a turn a message starts meanwhile waits for it (#259); errors are logged there.
      await runner.saveIdleSession(t.id, configDir);
    }
  }
});

// Deploys happen in other minions' turns, so merged work that isn't live yet is looked at again every
// SHIP_POLL_MS, and at startup every open minion's branch is, so the list has its badges.
const SHIP_POLL_MS = 15_000;
// Only git reads, so a preview shows the badges too.
if (!BOOT_CHECK || PREVIEW) {
  void safely('branch sweep', () => ships.sweep());
  setInterval(() => void safely('ship poll', () => ships.poll()), SHIP_POLL_MS).unref();
  void safely('builds', () => builds.poll());
  setInterval(() => void safely('builds', () => builds.poll()), 2 * SHIP_POLL_MS).unref();
  // A few small files, so every 2 s: a landing's phases last tens of seconds.
  setInterval(() => void safely('waits', () => waits.poll()), 2_000).unref();
  ciRuns.start();
}

// Tickets hear about their PR's CI, reviews, comments, merge and close as messages from "GitHub".
const github = new GithubWatcher(store, (ticketId, text) => runner.send(ticketId, GITHUB_NAME, text));
github.as = githubOf;
github.onPr = (id, repo, as, pr) => ciRuns.pr(id, repo, as, pr);
if (!BOOT_CHECK) github.start();
/** Put (with `title`) or clear (null) a Mandate item for `person`, from `project`, an alert unless `quiet`; true once Mandate has it settled. `what` names the sender in the log. */
async function mandateAlert(what: string, project: Pick<Project, 'id' | 'name'>, person: User, key: string, title: string | null, link = `/c/#/p/${project.id}`, quiet = false): Promise<boolean> {
  const c = store.getContraption('mandate');
  const identity = c && contraptions.signIdentity(c.name, person, { name: `scheme-${project.id}`, title: project.name });
  if (!c || !identity) return false;
  try {
    const { status, answer } = await callMandate(c, identity, key, title === null ? undefined : { title, alert: !quiet, link });
    // 403: she switched the scheme off in Mandate, which keeps it off; asking again won't change that.
    if (status === 200 || status === 403) return true;
    console.error(`${what}: Mandate answered ${status} for ${person.name}'s ${key}:`, JSON.stringify(answer).slice(0, 300));
  } catch (err: any) {
    console.error(`${what}: ${err?.message ?? err}`);
  }
  return false;
}
// CI health (#368): runners offline, jobs that never started, or no verdict on main for hours, in every scheme, make
// one Mandate alert for every admin (#540), cleared when it's all over (green that skipped jobs, a quiet item from
// its scheme); no turn runs.
const ciHealth = new CiHealth(store, {
  as: (p) => (p.repo_dir ? githubOf(p.repo_dir) : undefined),
  mandate: (from, person, key, title, quiet, link) => mandateAlert('CI health', from, person, key, title, link, quiet),
  wake: (ticketId, text) => runner.send(ticketId, APP_NAME, text),
  // A failed scheduled run (#588) goes to the scheme's Taskmaster, to start a bug minion.
  tell: (project, text) => {
    const coordinator = store.getCoordinator(project.id);
    if (coordinator) runner.send(coordinator.id, APP_NAME, text);
    return !!coordinator;
  },
});
if (!BOOT_CHECK) ciHealth.start();
// The CI desktop's load (#534): the runner agents' samples and CI health's jobs become a verdict per PC; one that
// holds is a quiet Mandate item for every admin, cleared when it ends.
const ciLoad = new CiLoad(store, {
  jobs: () => store.listProjects().map((project) => ({ project, jobs: ciHealth.recent.get(project.id) ?? [] })),
  hosts: () => machines.list().filter((m) => m.runners && m.online).map((m) => m.host ?? ''),
  mandate: (project, person, key, title) => mandateAlert('CI load', project, person, key, title, undefined, true),
});
if (!BOOT_CHECK) ciLoad.start();
// A job that ran in the server because systemd-run failed (#519): the first of each cause each day is a Mandate
// alert for every admin, from the job's scheme, linking its minion, cleared once a job gets its own unit again (#532).
fallbacks.alert = adminAlert(store, (project, person, key, title, link) => mandateAlert('In-server fallback', project, person, key, title, link));
fallbacks.clear = adminClear(store, (project, person, key) => mandateAlert('In-server fallback', project, person, key, null));
// Contraptions' timer jobs (#555): a failed run is one Mandate alert for every admin and the app's home-scheme owner,
// cleared once a run of that job succeeds. Only a server that manages app services reads them.
const timerAlerts = new TimerAlerts(store, {
  runs: (rows) => services.timerRuns(rows),
  journal: (unit) => services.journalTail(unit),
  mandate: (from, person, key, title, link) => mandateAlert('Timer alerts', from, person, key, title, link),
});
if (!BOOT_CHECK && !services.opts.off) timerAlerts.start();
// Members already in schemes get their invites, and leavers' are withdrawn (#310); it settles, so later boots only retry what failed.
if (!BOOT_CHECK) void safely('repo access sweep', () => repoAccess.sweep());
runner.onTurnEnd = (ticketId) => github.poke(ticketId);
// A merged PR catches its scheme's main up, and chains and commit waiters look again.
github.onMerged = (repoDir) => catchUp(repoDir);

// Each CI runner token handed out (#320) is told in the scheme Taskmaster's chat, without waking it.
// One fetched by a runner agent job's scripts goes under that job's note instead (#339).
runnerTokens.onFetched = (project, text, machine) => {
  if (runnerJobs.absorb(project, machine, text)) return;
  const coordinator = store.getCoordinator(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { text });
};
// So is each runner agent add or remove (#328), once, when it ends, its output collapsed under it (#339); a list isn't.
runnerJobs.onNote = (project, text, detail) => {
  const coordinator = store.getCoordinator(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { text, detail });
};

// A scheme's main that can't follow origin's (#208) is told in its Taskmaster's chat, once per reason.
mainSync.stuck = (repoDir, why) => {
  if (!why) return;
  console.warn(`Not fast-forwarding main in ${repoDir}: ${why}`);
  const project = store.listProjects().find((p) => p.repo_dir === repoDir);
  const coordinator = project && store.getCoordinator(project.id);
  if (coordinator) runner.emit(coordinator.id, 'note', { text: `This scheme's main checkout (${repoDir}) isn't level with GitHub's main, and ${APP_NAME} didn't fast-forward it: ${why}. A person needs to look.` });
};

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
  '.ts': 'text/plain; charset=utf-8', // public/ui/*.d.ts, the types apps read
};

// Android colours an installed app's status and navigation bars from the manifest, which can't vary
// by light or dark mode yet (color_scheme_dark is still a proposal). Ask the browser for its colour
// scheme and hand dark-mode devices a manifest with the dark colours, so the app doesn't get a white bar.
const COLOR_SCHEME_HINT = 'Sec-CH-Prefers-Color-Scheme';
function darkManifest(assets: Map<string, Buffer>) {
  const manifest = JSON.parse(assets.get('manifest.webmanifest')!.toString());
  return Buffer.from(JSON.stringify({ ...manifest, ...manifest.color_scheme_dark }, null, 2));
}
// The CI runner agent's installer and scripts (#328), which Cara's one-time install downloads: read from tools/ci-runner/
// at each request, so they are always the deployed checkout's. Nothing in them is secret.
const RUNNER_FILES = new Set(['install-runner-agent.ps1', 'add-runner.ps1', 'list-runners.ps1', 'remove-runner.ps1', 'start-runner.ps1', 'sample-load.ps1',
  // The Linux agent in WSL (#510).
  'install-runner-agent.sh', 'add-runner.sh', 'list-runners.sh', 'remove-runner.sh', 'keep-wsl-up.ps1', 'keep-runners.ps1']);
// The same for the Android emulator's distro on that desktop (#533): deploy/desktop/android/setup.sh and what it downloads.
const ANDROID_FILES: Record<string, string> = { 'setup.sh': 'deploy/desktop/android/setup.sh', 'citadel-android': 'tools/citadel-android', 'install-sdk.sh': 'tools/android/install-sdk.sh' };
const SETUP_PATH = /^\/(ci-runner|android-desktop)\//;
async function serveRunnerFile(res: ServerResponse, path: string) {
  const name = path.replace(SETUP_PATH, '');
  const file = path.startsWith('/ci-runner/') ? RUNNER_FILES.has(name) && join('tools', 'ci-runner', name) : Object.hasOwn(ANDROID_FILES, name) && ANDROID_FILES[name];
  if (!file) throw new HttpError(404, 'Not found');
  const body = await readFile(join(import.meta.dirname, file));
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}
async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, etag = false) {
  const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
  let body = ASSETS.get(name);
  if (!body) throw new HttpError(404, 'Not found');
  const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
  // Contraptions' pages load these on every page: a 304 until a deploy changes them.
  if (etag) {
    headers.ETag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
    const asked = String(req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (asked.includes(headers.ETag) || asked.includes('*')) return void res.writeHead(304, headers).end();
  }
  if (name === 'index.html') headers['Accept-CH'] = COLOR_SCHEME_HINT;
  if (name === 'manifest.webmanifest') {
    if (/dark/.test(String(req.headers[COLOR_SCHEME_HINT.toLowerCase()] ?? ''))) body = DARK_MANIFEST;
    headers.Vary = `Accept-Encoding, ${COLOR_SCHEME_HINT}`;
  }
  send(res, 200, headers, body);
}

/** What the route table (src/routes/) reaches of this server. */
const app: App = {
  store, runner, auth, waiters, previews, machines, pusher, clients, github: githubLink, repoAccess, runnerTokens, runnerJobs, ciLoad, claude: claudeLink, codex: codexLink, contraptions, contraptionTurns, landings, services, ultrareviews,
  memory: { embed, model: EMBED_MODEL, indexed: memoryScheme },
  dataDir: DATA_DIR, preview: PREVIEW, machinesUrl: MACHINES_URL, liveCommit: BOOT_COMMIT,
  get assetVersion() {
    return ASSET_VERSION;
  },
  broadcast, notify, newMinion, startChained: startChain, ticketBranch, builds, sharedFiles: artifacts.sharedFiles, sharedDir, registryChanged,
};
const routes = router([...appRoutes, ...peopleRoutes, ...projectRoutes, ...ticketRoutes, ...fileRoutes, ...machineRoutes, ...pushRoutes, ...contraptionRoutes]);

// The scheme the backup chat at /backup talks to: Citadel's own.
const BACKUP_SCHEME = 2;

// Contraptions' own services under /apps/<name>/ (src/apps.ts).
const apps = new AppProxy(store, contraptions, auth);

// Only /apps/ requests are upgraded (contraptions' websockets); anything else asking is served as usual.
const server = createServer({ shouldUpgradeCallback: (req) => (req.url ?? '').startsWith('/apps/') }, async (req, res) => {
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
  try {
    const own = ownPath(req.url ?? '/');
    if (own && 'redirect' in own) {
      if (req.method === 'GET' || req.method === 'HEAD') return void res.writeHead(302, { Location: own.redirect }).end();
    } else if (own) req.url = own.url;
    const url = requestUrl(req);
    // /preview/<ticket id>/ or a build's /preview/build/<n>/: the id is digits only, so "build" never reads as one.
    const preview = previews && /^\/preview\/(build\/)?(\d+)(\/.*)?$/.exec(url.pathname);
    // The frozen backup chat with the Citadel scheme's (2) Taskmaster, ahead of everything else (src/backup.ts).
    if (isBackupPath(url.pathname)) {
      await serveBackup(app, BACKUP_SCHEME, req, res, url);
    } else if (url.pathname.startsWith('/api/')) {
      const session = auth.session(req);
      // A route's own Set-Cookie (logout's clearing one) goes in writeHead, which wins over this.
      const renewed = auth.renewal(session, isSecure(req));
      if (renewed) res.setHeader('Set-Cookie', renewed);
      await routes(app, req, res, url, session);
    } else if (/^\/apps\/_citadel\/((rail|drawers)\.(js|d\.ts)|appswitch\.js|theme\.css|ui\/[a-z][a-z0-9-]*\.(js|css|d\.ts))$/.test(url.pathname)) {
      // The app rail, phone drawers (and their types), the Alt+` switcher the rail loads, colours and Citadel UI (public/ui/) for contraptions' pages (public/, src/theme.ts); no contraption can be called _citadel.
      await serveStatic(req, res, url.pathname.slice('/apps/_citadel'.length), true);
    } else if (url.pathname.startsWith('/apps/')) {
      apps.serve(req, res);
    } else if (preview) {
      const session = auth.session(req);
      // An HTML page's files under its file token come from a frame that sends no cookies; the preview checks the token.
      const [, build, id, rest] = preview;
      const tokened = /^\/(c\/)?api\/files\//.test(rest ?? '') && (req.method === 'GET' || req.method === 'HEAD');
      // People only, signed in to the live app; a page load without a login goes to the login.
      if (!tokened && (!session || session.agent !== undefined)) {
        if (req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''))) return void res.writeHead(302, { Location: '/' }).end();
        throw new HttpError(401, 'Not logged in');
      }
      // Only for people in the minion's scheme, or for a build, the scheme whose code this server runs.
      const shownIn = build ? previews.buildScheme()?.id : store.getTicket(Number(id))?.project_id;
      if (session && session.agent === undefined && (shownIn === undefined || !store.canSee(session, shownIn))) throw new HttpError(404, build ? 'There is no preview for this build' : 'There is no preview for this minion');
      // The front end's URLs are relative, so the page itself needs the trailing slash.
      if (!rest) return void res.writeHead(302, { Location: `/${build ? buildPreviewPath(Number(id)) : previewPath(Number(id))}${url.search}` }).end();
      const who = session?.agent === undefined ? session : null;
      if (build) await previews.proxyBuild(req, res, Number(id), rest + url.search, who);
      else await previews.proxy(req, res, Number(id), rest + url.search, who);
    } else if (SETUP_PATH.test(url.pathname)) {
      await serveRunnerFile(res, url.pathname);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    // An HttpError's words were written for the caller, a 500 too; only an unexpected throw stays vague.
    if (!res.headersSent) json(res, status, { error: err instanceof HttpError ? err.message : 'Internal error' });
    else res.end();
  }
});

// Contraptions' websockets, which a restart ends (their pages reconnect): open ones never let server.close finish.
const upgraded = new Set<Duplex>();
server.on('upgrade', (req, socket, head) => {
  upgraded.add(socket);
  socket.once('close', () => upgraded.delete(socket));
  try {
    apps.upgrade(req, socket, head);
  } catch (err) {
    console.error(err);
    socket.destroy();
  }
});

// Node's default 5 minutes to receive a whole request is too short for a 200 MB attachment on a slow
// uplink; headers still have to arrive within headersTimeout.
server.requestTimeout = 30 * 60_000;
// Once up, a stray error is logged rather than fatal. Not before: a failed start (a port in use, a
// database that won't open) must still exit non-zero so systemd restarts it.
server.on('listening', keepServing);
server.on('listening', () => (boundPort = (server.address() as AddressInfo).port));

// Under socket activation (deploy/claude-coordinator.socket) systemd holds the listening socket, fd 3,
// across restarts: requests made while the server restarts wait for the next one instead of failing.
if (process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid)) {
  server.listen({ fd: 3 }, () => console.log(`${APP_NAME} listening on the socket systemd holds (${HOST}:${PORT})`));
} else {
  server.listen(PORT, HOST, () => console.log(`${APP_NAME} listening on http://${HOST}:${boundPort}`));
}

// A restart: running turns carry on in their units, and the next server re-attaches. Stop taking
// requests, end the ones that never finish (event streams, approval long-polls, websockets; their
// callers come back), and exit once the rest are answered, a few seconds at most. Requests made
// meanwhile wait in systemd's socket for the next server, so every second spent here is a stall (#493).
const SHUTDOWN_GRACE_MS = 5000;
process.on('SIGTERM', () => {
  console.log('SIGTERM: finishing requests, then exiting; running turns carry on.');
  claudeLink.close(); // before detachAll: a turn's start still in flight must not see its container idle and replace it
  runner.detachAll();
  server.close(() => process.exit(0));
  for (const c of clients.keys()) c.end();
  for (const s of upgraded) s.destroy();
  runner.approvals.wakeAll();
  // A kept-alive connection (Caddy's) stays open after answering a request that was running at close(),
  // until its keep-alive timeout: close each one as soon as it goes idle.
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 50).unref();
  setTimeout(() => {
    server.getConnections((_err, n) => {
      console.log(`SIGTERM: exiting with ${n} connection(s) still open after ${SHUTDOWN_GRACE_MS / 1000} s`);
      process.exit(0);
    });
  }, SHUTDOWN_GRACE_MS).unref();
});

// A front-end-only deploy: re-read public/ and tell open tabs, which reload once nobody is typing.
process.on('SIGHUP', () => {
  const before = ASSET_VERSION;
  loadAssets().then(
    () => {
      console.log(`Reloaded public/ on SIGHUP: front end ${before} → ${ASSET_VERSION}`);
      if (ASSET_VERSION !== before) broadcast({ type: 'hello', version: ASSET_VERSION });
      // tools/deploy.sh sends SIGHUP only for a change to public/ alone, so the checkout's HEAD is now live.
      app.liveCommit = checkoutHead();
      if (!BOOT_CHECK) liveOn(app.liveCommit);
    },
    (err) => console.error('Reloading public/ on SIGHUP failed; still serving the old front end:', err),
  );
});

// The machines-only listener: every agent route (connect, send, info, upload) and the agents' scripts, nothing else.
if (MACHINES_URL) {
  const agentApi = router(agentRoutes);
  const agents = createServer(async (req, res) => {
    try {
      const url = requestUrl(req);
      if (agentApi.knows(url.pathname)) await agentApi(app, req, res, url, null);
      else if ((url.pathname === '/machine-agent.mjs' || url.pathname === '/runner-agent.mjs') && req.method === 'GET') await serveStatic(req, res, url.pathname);
      else if (SETUP_PATH.test(url.pathname) && req.method === 'GET') await serveRunnerFile(res, url.pathname);
      else throw new HttpError(404, 'Not found');
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      // An HttpError's words were written for the caller, a 500 too; only an unexpected throw stays vague.
    if (!res.headersSent) json(res, status, { error: err instanceof HttpError ? err.message : 'Internal error' });
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
