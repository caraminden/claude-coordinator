// Claude Coordinator: a shared web UI over headless Claude Code sessions.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gzip } from 'node:zlib';
import { homedir } from 'node:os';
import { commentMessage, fileType, findArtifacts, isArtifact, linkedPaths, optionImageProblem, resolveFile } from './src/artifacts.ts';
import { APP_NAME } from './src/appname.ts';
import { AGENT_NAME, Auth, looksLikeUrl, threadMayCall, type Session } from './src/auth.ts';
import { branchStatus, type BranchStatus } from './src/branch.ts';
import { GITHUB_NAME, GithubWatcher } from './src/github.ts';
import { claudeConfigDir, lastEffort, saveSession } from './src/sessions.ts';
import { EFFORTS, MAX_INSTRUCTIONS, MODELS, Store, TICKET_STATES, TICKET_TAGS, type Artifact, type Project, type Ticket, type TicketState, type TicketTag } from './src/db.ts';
import { cleanPluginDirs, cleanRules, lines } from './src/approvals.ts';
import { instructionSources } from './src/instructions.ts';
import { MACHINE_NAME, MachineRelay, RESERVED_NAMES, hashToken, newToken } from './src/machines.ts';
import { NOTIFY_STATES, Pusher, loadVapidKeys, validSubscription, type PushTrigger } from './src/push.ts';
import { Runner, slimEvent } from './src/runner.ts';
import { GLOBAL_OWNER, PropertyError, type Actor } from './src/properties.ts';
import { TAG_TO_TYPE } from './src/property-seed.ts';
import { cloneProject, createTicketDir, projectDir, projectSharedDir, removeProjectDir } from './src/workspace.ts';

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
// The coordinator only reads and calls its MCP tools; the work happens in the tickets it creates.
const COORDINATOR_PERMISSION_MODE = 'acceptEdits';
// How long one wait for an approval card's outcome holds the request open.
const APPROVAL_POLL_MS = 25_000;
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
    assets.set(f, /\.(html|js|webmanifest)$/.test(f) ? Buffer.from(body.toString('utf8').replaceAll('%APP_NAME%', APP_NAME)) : body);
  }
  // Built before anything is swapped, so a bad manifest leaves the old front end whole.
  const dark = darkManifest(assets);
  ASSETS = assets;
  ASSET_VERSION = createHash('sha256').update([...assets.values()].join('\0')).digest('hex').slice(0, 12);
  DARK_MANIFEST = dark;
}
// The commit this server's code came from, so a deploy can tell whether the change it ships is
// front end only. null outside a git checkout.
const BOOT_COMMIT = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
})();
// Set by tools/deploy.sh when it boots new code on a copy of the database: serve and answer, but
// don't resume interrupted turns or watch GitHub, which would act on the copy's minions for real.
const BOOT_CHECK = process.env.BOOT_CHECK === '1';
await loadAssets();
const store = new Store(join(DATA_DIR, 'coordinator.db'));
const auth = new Auth(process.env.COORDINATOR_PASSWORD ?? '', process.env.SESSION_SECRET ?? '');
// Keep secrets out of the environment that claude and its tools inherit.
delete process.env.COORDINATOR_PASSWORD;
delete process.env.SESSION_SECRET;

const MAX_CLIENTS = 100;
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

const SECURITY_HEADERS = {
  // blob: lets the composer preview pasted images before they are sent.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

const runner = new Runner(
  store,
  broadcast,
  (ticket) => ({
    COORDINATOR_API: `http://${LOCAL_HOST.includes(':') ? `[${LOCAL_HOST}]` : LOCAL_HOST}:${PORT}`,
    COORDINATOR_TOKEN: auth.agentToken(ticket.id),
    COORDINATOR_PROJECT: String(ticket.project_id),
  }),
  process.env.CLAUDE_BIN ?? 'claude',
);
if (!BOOT_CHECK) runner.recover();
const machines = new MachineRelay(store, () => broadcast({ type: 'machines', machines: machines.list() }));
runner.machines = (project) => machines.online(project.id);

// ---------- push notifications ----------

const pusher = new Pusher(store, loadVapidKeys(DATA_DIR));
// Push services may contact the sender at this address; set from the first subscribe if not given.
pusher.subject = process.env.PUSH_SUBJECT ?? store.getSetting<string>('push_subject') ?? pusher.subject;

/** Ping everyone subscribed to the ticket's project (but `except`) if the trigger warrants it. */
function notify(ticketId: number, trigger: PushTrigger, except: string | null = null) {
  const ticket = store.getTicket(ticketId);
  if (ticket) pusher.notify(ticket, trigger, except).catch((err) => console.error(`Push for ticket ${ticketId} failed:`, err));
}

runner.onTurnError = (ticketId, text) => notify(ticketId, { kind: 'error', text });

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

// Pick up anything made while the server was down (or before artifacts existed), one ticket at a time.
// Rows for file types that no longer count as artifacts go first, pinned or not.
store.pruneArtifacts(isArtifact);
// The vocabulary docs follow the registry; the first run replaces the hand-written ones (kept aside).
writeVocabularies().catch((err) => console.error('Could not write the property vocabularies:', err));
(async () => {
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
})();

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
  const status = await branchStatus(project.repo_dir, ticket.branch, ticket.created_at, !prFresh);
  if (status && prFresh) status.pr = cached.status?.pr ?? null;
  const json = JSON.stringify(status);
  branchCache.set(ticketId, { status, prAt: prFresh ? cached.prAt : Date.now(), json });
  if (cached && cached.json !== json) broadcast({ type: 'branch', ticketId, status });
  return status;
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

function artifactView(a: Artifact & { ticket_title?: string; ticket_kind?: string; ticket_number?: number | null }) {
  const ticket = a.ticket_title === undefined ? store.getTicket(a.ticket_id) : null;
  return {
    ...a,
    name: basename(a.path),
    display_path: displayPath(ticket ?? store.getTicket(a.ticket_id)!, a.path),
    kind: fileType(a.path)?.kind ?? 'text',
    ticket_title: a.ticket_title ?? ticket?.title ?? '',
    ticket_kind: a.ticket_kind ?? ticket?.kind ?? 'ticket',
    ticket_number: a.ticket_number ?? ticket?.number ?? null,
  };
}

/** Content-Security-Policy for an artifact opened directly or framed by the app. */
function artifactCsp(kind: string): string {
  // Tickets write these files, so never let them run as the app: sandboxed pages get an opaque
  // origin with no cookies or API access. HTML may still run its own scripts (canvases, demos).
  if (kind === 'html') return "sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'";
  // Chrome's PDF viewer refuses to load in a sandbox; PDFs can't script the page anyway.
  if (kind === 'pdf') return "frame-ancestors 'self'";
  return "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
}

/** Where a ticket keeps files it fetched or made to show people, outside its repo. */
function sharedDir(ticket: Ticket): string {
  return join(projectDir(DATA_DIR, ticket.project_id), 'shared', String(ticket.id));
}

/** A path as people should see it: relative to the working directory, or under "shared files". */
function displayPath(ticket: Ticket, path: string): string {
  const projectShared = projectSharedDir(DATA_DIR, ticket.project_id) + sep;
  if (path.startsWith(projectShared)) return `scheme shared/${path.slice(projectShared.length)}`;
  const shared = sharedDir(ticket) + sep;
  if (path.startsWith(shared)) return `shared files/${path.slice(shared.length)}`;
  if (ticket.cwd && path.startsWith(ticket.cwd + sep)) return path.slice(ticket.cwd.length + 1);
  return path;
}

/** The folders a ticket may show files from: its working directory, its shared folder and the project's. */
const ticketRoots = (ticket: Ticket) => [ticket.cwd, sharedDir(ticket), projectSharedDir(DATA_DIR, ticket.project_id)];

/** A file a ticket may show (see resolveFile), or null. */
function resolveTicketFile(ticket: Ticket, path: string) {
  return resolveFile(path, ticket.cwd, ticketRoots(ticket));
}

/** Serve a file found by resolveFile, with byte ranges and a sandboxing CSP. */
async function serveArtifact(req: IncomingMessage, res: ServerResponse, found: Awaited<ReturnType<typeof resolveFile>>, path: string, download: boolean) {
  if (!found) throw new HttpError(404, 'That file is no longer there');
  const { file, type, size } = found;
  const headers: Record<string, string | number> = {
    'Content-Type': type.mime,
    'Content-Security-Policy': artifactCsp(type.kind),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'private, no-cache',
    'Accept-Ranges': 'bytes',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`;
  // Byte ranges, so videos can seek (Safari won't play them without).
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
  }
  if (req.method === 'HEAD' || size === 0) return res.end();
  await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Responses to browsers that accept gzip. Caddy passes bodies through as they are, and a long
// thread's history is megabytes of JSON that gzips about 4x.
const acceptsGzip = new WeakSet<ServerResponse>();
const MIN_GZIP_BYTES = 1400;

/** Send a whole body, gzipped when the browser accepts it and it is big enough to be worth it. */
function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  if (buf.length < MIN_GZIP_BYTES || !acceptsGzip.has(res)) {
    res.writeHead(status, { Vary: 'Accept-Encoding', ...headers });
    return res.end(buf);
  }
  gzip(buf, { level: 6 }, (err, zipped) => {
    if (res.destroyed) return;
    if (err) {
      res.writeHead(status, { Vary: 'Accept-Encoding', ...headers });
      return res.end(buf);
    }
    res.writeHead(status, { Vary: 'Accept-Encoding', ...headers, 'Content-Encoding': 'gzip' });
    res.end(zipped);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  send(res, status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function clientIp(req: IncomingMessage): string {
  // Caddy appends the real client address, so only the right-most entry is trustworthy.
  const fwd = req.headers['x-forwarded-for'];
  const last = typeof fwd === 'string' ? fwd.split(',').pop()!.trim() : '';
  return last || req.socket.remoteAddress || '?';
}

/** Display names end up in prompts as "[Name]: ...", so keep them plain. */
function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f\[\]:]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new HttpError(400, 'Name is required');
  if (looksLikeUrl(name)) throw new HttpError(400, 'That looks like a web address. Type your name.');
  return name.slice(0, 40);
}

function isSecure(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}

/**
 * A question card from Claude: 1 to 4 questions, each with 2 to 6 options. An option's image must
 * be a picture or video the ticket may show, so a card can't reach files outside its folders.
 */
async function cleanQuestions(ticket: Ticket, raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new HttpError(400, 'questions must be a list of 1 to 4 questions');
  const questions = raw.map((q: any, i: number) => {
    const n = `Question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new HttpError(400, `${n} must be an object`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw new HttpError(400, `${n} needs 2 to 6 options`);
    const options = q.options.map((o: any, j: number) => ({
      label: str(o?.label, `${n} option ${j + 1} label`, 80),
      ...(o?.description ? { description: str(o.description, `${n} option ${j + 1} description`, 300) } : {}),
      ...(o?.image ? { image: str(o.image, `${n} option ${j + 1} image`, 1000) } : {}),
    }));
    if (new Set(options.map((o: any) => o.label)).size !== options.length) throw new HttpError(400, `${n} has duplicate option labels`);
    return {
      question: str(q.question, n, 500),
      ...(q.header ? { header: str(q.header, `${n} header`, 24) } : {}),
      multiSelect: q.multiSelect === true,
      options,
    };
  });
  for (const [i, q] of questions.entries()) {
    for (const [j, o] of q.options.entries()) {
      const problem = o.image && await optionImageProblem(o.image, ticket.cwd, ticketRoots(ticket));
      if (problem) throw new HttpError(400, `Question ${i + 1} option ${j + 1} image ${problem}`);
    }
  }
  return questions;
}

/** A person's picks for each question of a card: chosen option labels, plus optional free text. */
function cleanAnswers(questions: any[], raw: unknown) {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new HttpError(400, 'Answer every question on the card');
  return questions.map((q, i) => {
    const a: any = raw[i] ?? {};
    const selected = Array.isArray(a.selected) ? [...new Set(a.selected.filter((l: unknown) => q.options.some((o: any) => o.label === l)))] as string[] : [];
    const other = typeof a.other === 'string' ? a.other.trim().slice(0, 2000) : '';
    if (!q.multiSelect && selected.length > 1) throw new HttpError(400, `Pick one answer for question ${i + 1}`);
    if (!selected.length && !other) throw new HttpError(400, `Answer question ${i + 1}`);
    return other ? { selected, other } : { selected };
  });
}

/** One of a fixed set of values, or null when empty. */
/** "Opus 5.5" for "claude-opus-5-5". */
function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

function oneOf(v: unknown, allowed: readonly string[], field: string): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

function buildNumber(v: unknown): number | null {
  if (v === null || v === '') return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 9999) throw new HttpError(400, 'Build must be a whole number from 1 to 9999');
  return v as number;
}

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
}

/** A stand-in title from the start of a first message, cut at a word near 40 characters. */
function provisionalTitle(message: string): string {
  const line = message.split('\n').find((l) => l.trim())!.replace(/\s+/g, ' ').trim();
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`;
}

/** Who is changing properties: a person, a scheme's Taskmaster, or a minion. */
function actorFor(session: Session): Actor {
  if (session.agent === undefined) return { kind: 'person', name: session.name };
  const t = store.getTicket(session.agent)!;
  const kind = t.kind === 'coordinator' ? 'coordinator' : 'thread';
  return { kind, name: kind === 'coordinator' ? AGENT_NAME : `#${t.number} ${t.title}`, projectId: t.project_id, ticketId: t.id };
}

/** Run a registry call, turning its refusals into HTTP errors. */
function registry<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PropertyError) throw new HttpError(err.status, err.message);
    throw err;
  }
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

function ticketView(id: number) {
  const t = store.getTicket(id);
  if (!t) throw new HttpError(404, 'No such minion');
  return runner.view(t);
}

/**
 * A person wrote into a chat, which counts as continuing the loop guard there: for a minion's chat,
 * that minion; for the Taskmaster's, every minion of its scheme.
 */
function personWrote(ticket: Ticket, session: Session) {
  if (session.agent !== undefined) return;
  const minions = ticket.kind === 'coordinator' ? store.listTickets(ticket.project_id).filter((t) => t.kind !== 'coordinator') : [ticket];
  for (const t of minions) runner.continueLoop(t.id, session.name);
}

/** The project's coordinator ticket, created the first time someone opens the project. */
async function ensureCoordinator(project: Project): Promise<Ticket> {
  const existing = store.getCoordinator(project.id);
  if (existing) return existing;
  const cwd = join(projectDir(DATA_DIR, project.id), 'coordinator');
  await mkdir(cwd, { recursive: true });
  try {
    const t = store.createTicket({
      project_id: project.id,
      kind: 'coordinator',
      title: 'Coordinator',
      permission_mode: COORDINATOR_PERMISSION_MODE,
      created_by: AGENT_NAME,
    });
    store.setTicketDir(t.id, cwd, null);
  } catch {
    // Lost a race with a concurrent request; the unique index kept a single coordinator.
  }
  return store.getCoordinator(project.id)!;
}

/** The project a coordinator's token may act on, or null for a signed-in person. */
function agentProject(session: Session, method: string, pathname: string): number | null {
  if (session.agent === undefined) return null;
  const t = store.getTicket(session.agent);
  if (!t) throw new HttpError(403, 'No such minion');
  // A ticket's own token may only read and update that ticket (its title, tag, state and note),
  // ask a question card in its chat, and close itself.
  if (t.kind !== 'coordinator' && !threadMayCall(t.id, method, pathname, t.project_id)) throw new HttpError(403, 'A minion may only update itself');
  return t.project_id;
}

// Images people paste into a chat. 5 MB is the API's per-image limit.
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: { type: string; ext: string; magic: (b: Buffer) => boolean }[] = [
  { type: 'image/png', ext: '.png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: '.gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { type: 'image/webp', ext: '.webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
const IMAGE_NAME = /^[0-9a-f]{24}\.(png|jpg|gif|webp)$/;

function uploadsDir(ticket: Ticket): string {
  return join(projectDir(DATA_DIR, ticket.project_id), 'uploads', String(ticket.id));
}

/** Check pasted images (base64 in the request body) and write them to the ticket's uploads folder. */
async function saveImages(ticket: Ticket, raw: unknown): Promise<{ name: string; path: string; mediaType: string }[]> {
  if (raw == null || (Array.isArray(raw) && !raw.length)) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'images must be a list');
  if (raw.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per message`);
  const decoded = raw.map((img) => {
    const buf = Buffer.from(typeof img?.data === 'string' ? img.data : '', 'base64');
    if (!buf.length) throw new HttpError(400, 'Empty image');
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Images must be under 5 MB each');
    // Trust the bytes, not the declared type, since these get served back to browsers.
    const kind = IMAGE_TYPES.find((t) => t.magic(buf));
    if (!kind) throw new HttpError(415, 'Images must be PNG, JPEG, GIF or WebP');
    return { buf, kind };
  });
  const dir = uploadsDir(ticket);
  await mkdir(dir, { recursive: true });
  return Promise.all(decoded.map(async ({ buf, kind }) => {
    const name = randomBytes(12).toString('hex') + kind.ext;
    const path = join(dir, name);
    await writeFile(path, buf);
    return { name, path, mediaType: kind.type };
  }));
}

// ---------- search ----------

/** What people and Claude said in an event, for searching (not tool calls or their output). */
function spokenText(kind: string, data: any): string {
  if (kind === 'user_message') return typeof data?.text === 'string' ? data.text : '';
  if (data?.type !== 'assistant') return '';
  return (data.message?.content ?? []).filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

/** Threads in a project whose conversation mentions the text: the newest match per thread, with a snippet. */
function searchProject(projectId: number, q: string) {
  const needle = q.toLowerCase();
  const hits = new Map<number, { ticketId: number; eventId: number; at: number; snippet: string; matches: number }>();
  // SQL narrows by the raw JSON; the check below keeps only real hits in the spoken text.
  for (const ev of store.findEvents(projectId, q)) {
    let text: string;
    try {
      text = spokenText(ev.kind, JSON.parse(ev.data));
    } catch {
      continue;
    }
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const hit = hits.get(ev.ticket_id);
    if (hit) {
      hit.matches++;
      continue;
    }
    const start = Math.max(0, at - 50);
    const end = Math.min(text.length, at + needle.length + 70);
    const snippet = (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
    hits.set(ev.ticket_id, { ticketId: ev.ticket_id, eventId: ev.id, at: ev.created_at, snippet, matches: 1 });
  }
  return [...hits.values()].slice(0, 100);
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

async function api(req: IncomingMessage, res: ServerResponse, url: URL, session: Session | null) {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const body = await readJson(req);
    const name = cleanName(body.name);
    if ([AGENT_NAME, 'Coordinator', GITHUB_NAME].some((n) => n.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'That name is reserved');
    // Checked right before the password (no await in between) so parallel bursts are counted.
    if (auth.limited(ip)) throw new HttpError(429, 'Too many attempts; try again later');
    if (!auth.checkPassword(ip, String(body.password ?? ''))) throw new HttpError(401, 'Wrong password');
    return json(res, 200, { name }, { 'Set-Cookie': auth.issueCookie(name, isSecure(req)) });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return json(res, 200, {}, { 'Set-Cookie': auth.clearCookie() });
  }
  // For tools/deploy.sh, so no login: is this server up, which code it booted from, which front end
  // it serves, and that it reloads public/ on SIGHUP (an older server would exit on one).
  if (pathname === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, commit: BOOT_COMMIT, version: ASSET_VERSION, reload: 'sighup' });
  }
  // A machine's agent signs in with its own token, which reaches nothing else.
  if (pathname === '/api/machines/connect' || pathname === '/api/machines/send') {
    if (MACHINES_URL) throw new HttpError(403, `Machines connect at ${MACHINES_URL.origin}, not here`);
    return machineAgentApi(req, res, url);
  }
  if (!session) throw new HttpError(401, 'Not logged in');

  // Reject cross-site writes (SameSite=Lax and the JSON content type cover most of this already).
  if (method !== 'GET') {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      throw new HttpError(403, 'Cross-origin request');
    }
    if (origin && originHost !== host) throw new HttpError(403, 'Cross-origin request');
  }

  if (pathname === '/api/me') return json(res, 200, { name: session.name });

  if (pathname === '/api/machines' || pathname.startsWith('/api/machines/')) return machinesApi(req, res, pathname, method, session);

  // A coordinator may only touch its own project's tickets, and not itself.
  const scope = agentProject(session, method, pathname);
  const inScope = (projectId: number) => {
    if (scope !== null && scope !== projectId) throw new HttpError(403, 'Outside this Taskmaster\'s scheme');
  };
  if (scope !== null && !/^\/api\/(projects\/\d+(\/tickets|\/properties(\/[a-z]+)?)?|tickets\/\d+(\/[a-z]+)?)$/.test(pathname)) {
    throw new HttpError(403, 'Not available to the Taskmaster');
  }

  if (pathname.startsWith('/api/push/')) return pushApi(req, res, pathname, method, session);

  if (pathname === '/api/stream') {
    if (clients.size >= MAX_CLIENTS) throw new HttpError(503, 'Too many open streams');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'hello', version: ASSET_VERSION, usage: runner.usage })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (pathname === '/api/projects') {
    if (method === 'GET') {
      return json(res, 200, store.listProjects().map((p) => ({ ...p, tickets: store.listTickets(p.id).filter((t) => t.kind === 'ticket').length })));
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name, 'Name', 80);
      const repoUrl = typeof body.repoUrl === 'string' && body.repoUrl.trim() ? body.repoUrl.trim() : null;
      if (repoUrl && !/^(https:\/\/|git@)/.test(repoUrl)) throw new HttpError(400, 'Repo URL must be https:// or git@');
      let project;
      try {
        project = store.createProject(name, repoUrl);
      } catch {
        throw new HttpError(409, 'A scheme with that name already exists');
      }
      if (repoUrl) {
        try {
          store.setProjectRepoDir(project.id, await cloneProject(DATA_DIR, project.id, repoUrl));
        } catch (err: any) {
          store.deleteProject(project.id);
          await removeProjectDir(DATA_DIR, project.id);
          throw new HttpError(400, `Could not clone repo: ${err.stderr?.trim() || err.message}`);
        }
      }
      return json(res, 201, store.getProject(project.id));
    }
  }

  let m = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (m && method === 'GET') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    inScope(project.id);
    const coordinator = await ensureCoordinator(project);
    const tickets = store
      .listTickets(project.id)
      .filter((t) => t.kind === 'ticket')
      .map((t) => runner.view(t));
    // When this person last looked at each thread, so rows they have already seen can be shown quieter.
    const seen = session.agent === undefined ? store.seenTimes(session.name, project.id) : {};
    return json(res, 200, { project, coordinator: ticketView(coordinator.id), tickets, seen });
  }

  if (m && method === 'PATCH') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    inScope(project.id);
    // Any of name, instructions, approval_rules, plugin_dirs and default_effort; what is left out stays.
    const body = await readJson(req);
    if (body.name === undefined && body.instructions === undefined && body.approval_rules === undefined && body.plugin_dirs === undefined && body.default_effort === undefined) {
      throw new HttpError(400, 'Nothing to change');
    }
    const name = body.name === undefined ? project.name : str(body.name, 'Name', 80);
    const settings: Partial<Pick<Project, 'approval_rules' | 'plugin_dirs' | 'default_effort'>> = {};
    // null or "" leaves effort to Claude Code's default.
    if (body.default_effort !== undefined) settings.default_effort = oneOf(body.default_effort || null, EFFORTS, 'Default effort') ?? '';
    try {
      if (body.approval_rules !== undefined) settings.approval_rules = cleanRules(body.approval_rules);
      if (body.plugin_dirs !== undefined) settings.plugin_dirs = cleanPluginDirs(body.plugin_dirs);
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new HttpError(400, 'instructions must be text');
    const instructions = body.instructions === undefined ? project.instructions : body.instructions.replace(/\r\n/g, '\n').trim();
    if (instructions.length > MAX_INSTRUCTIONS) {
      throw new HttpError(400, `Instructions are ${instructions.length.toLocaleString('en')} characters; the limit is ${MAX_INSTRUCTIONS.toLocaleString('en')}`);
    }
    // Renamed first: it is the only change that can still be refused (a taken name).
    if (name !== project.name) {
      try {
        store.renameProject(project.id, name);
      } catch (err: any) {
        throw new HttpError(409, err.message);
      }
      const coordinator = store.getCoordinator(project.id);
      if (coordinator) runner.emit(coordinator.id, 'note', { text: `${session.name} renamed the scheme from "${project.name}" to "${name}".` });
    }
    for (const k of Object.keys(settings) as (keyof typeof settings)[]) if (settings[k] === project[k]) delete settings[k];
    if (Object.keys(settings).length) {
      store.setProjectSettings(project.id, settings);
      // Who changed what gets a permanent line in the coordinator's chat, since rules decide what needs a person's OK.
      const coordinator = store.getCoordinator(project.id);
      const shown = (text: string) => (text ? lines(text).join(', ') : 'none');
      if (coordinator && settings.approval_rules !== undefined) {
        runner.emit(coordinator.id, 'note', { text: `${session.name} set the approval rules to: ${shown(settings.approval_rules)}. They apply from each minion's next turn.` });
      }
      if (coordinator && settings.plugin_dirs !== undefined) {
        runner.emit(coordinator.id, 'note', { text: `${session.name} set the plugin folders to: ${shown(settings.plugin_dirs)}. They apply from each minion's next turn.` });
      }
      if (coordinator && settings.default_effort !== undefined) {
        runner.emit(coordinator.id, 'note', { text: `${session.name} set the scheme's default effort to ${settings.default_effort || "Claude Code's default"}. It applies from each minion's next turn.` });
      }
    }
    if (instructions !== project.instructions) {
      store.setProjectInstructions(project.id, instructions, session.name);
      const coordinator = store.getCoordinator(project.id);
      if (coordinator) {
        runner.emit(coordinator.id, 'note', {
          text: `${session.name} ${instructions ? 'updated' : 'cleared'} the scheme instructions; they apply from each minion's next turn.`,
        });
      }
    }
    const saved = store.getProject(project.id)!;
    broadcast({ type: 'project', project: saved });
    return json(res, 200, saved);
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/instructions\/sources$/);
  if (m && method === 'GET') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    return json(res, 200, { sources: await instructionSources(project, claudeConfigDir(process.env), DATA_DIR), max: MAX_INSTRUCTIONS });
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/tickets$/);
  if (m && method === 'POST') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    inScope(project.id);
    const body = await readJson(req);
    const message = str(body.message, 'First message', 100_000);
    // Without a title (the New thread form sends none) start from the message's opening words;
    // the thread renames itself once it knows what the work is.
    const title = body.title === undefined ? provisionalTitle(message) : str(body.title, 'Title', 120);
    // Insert first so concurrent creates get distinct ids, then build the working dir.
    const tag = oneOf(body.tag ?? null, TICKET_TAGS, 'Tag') as TicketTag | null;
    const model = oneOf(body.model ?? null, MODELS, 'Model');
    const effort = oneOf(body.effort ?? null, EFFORTS, 'Effort');
    // Properties are checked before the minion exists, so a bad one doesn't leave half a minion.
    const props: Record<string, unknown> = body.properties == null ? {} : body.properties;
    if (typeof props !== 'object' || Array.isArray(props)) throw new HttpError(400, 'properties must be an object of key: value');
    const given = (key: string) => Object.keys(props).some((k) => k.toLowerCase() === key.toLowerCase());
    if (tag && !given('type')) props.type = TAG_TO_TYPE[tag];
    if (session.agent === undefined && !given('requestedBy')) props.requestedBy = session.name;
    const planned = registry(() => store.props.check(project.id, props));
    if (scope !== null && !planned.type?.length) {
      throw new HttpError(400, 'Every new minion needs a type in properties (e.g. properties: { type: "feature" }). If none fits, use "other" and ask people where it belongs.');
    }
    const { id, number } = store.createTicket({ project_id: project.id, title, tag, permission_mode: THREAD_PERMISSION_MODE, created_by: session.name });
    const { notes } = store.props.set('minion', id, project.id, props, session.name);
    store.props.startStage(id);
    if (model || effort) store.updateTicket(id, { model, effort });
    try {
      const dir = await createTicketDir(DATA_DIR, project.id, project.repo_dir, id, number!, title);
      store.setTicketDir(id, dir.cwd, dir.branch);
    } catch (err: any) {
      store.deleteTicket(id);
      throw new HttpError(500, `Could not create working directory: ${err.stderr?.trim() || err.message}`);
    }
    runner.send(id, session.name, message);
    return json(res, 201, { ...ticketView(id), notes });
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/properties(\/[a-z]+)?$/);
  if (m) {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    inScope(project.id);
    const action = m[2] ?? '';
    if (action === '' && method === 'GET') return json(res, 200, { keys: store.props.list(project.id), globalOwner: GLOBAL_OWNER });
    if (method !== 'POST') throw new HttpError(404, 'Not found');
    const body = await readJson(req);
    const actor = actorFor(session);
    if (action === '/keys') {
      const r = registry(() => store.props.registerKey(project.id, body, actor));
      if (r.registered) registryChanged(project.id, r.scope === 'global');
      return json(res, r.registered ? 201 : 200, r);
    }
    if (action === '/values') {
      const r = registry(() => store.props.registerValues(project.id, body.key, body.values, actor, !!body.force));
      if (r.added.length || r.updated.length) registryChanged(project.id, store.props.isGlobal(project.id, body.key));
      if (r.unreviewed) {
        const coordinator = store.getCoordinator(project.id);
        if (coordinator) runner.emit(coordinator.id, 'note', { text: `${actor.name} added ${r.added.map((v) => `${body.key}: ${v}`).join(', ')} to the registry. It's live now; review it in Settings → Properties.` });
      }
      return json(res, 200, r);
    }
    if (action === '/review') {
      const global = store.props.isGlobal(project.id, body.key);
      const r = registry(() => store.props.review(project.id, body, actor));
      registryChanged(project.id, global);
      return json(res, 200, r);
    }
    if (action === '/proposals') {
      if (actor.kind !== 'thread') throw new HttpError(403, 'Taskmasters and people register keys and values directly; proposals are for minions');
      const r = registry(() => store.props.propose(project.id, body, actor));
      if (r.proposed) {
        registryChanged(project.id, false);
        const what = body.value === undefined ? `a new key \`${body.key}\`` : `\`${body.key}: ${body.value}\``;
        const coordinator = await ensureCoordinator(project);
        runner.send(coordinator.id, actor.name, `Property proposal: ${what}. Reason: ${body.reason}\n\nApprove or reject it with review_property (new keys need a person: ask them).`, []);
      }
      return json(res, 200, r);
    }
    throw new HttpError(404, 'Not found');
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/search$/);
  if (m && method === 'GET') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    return json(res, 200, q.length < 2 ? [] : searchProject(project.id, q));
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/artifacts$/);
  if (m && method === 'GET') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    return json(res, 200, store.listArtifacts(project.id).map(artifactView));
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/shared(\/file)?$/);
  if (m && (method === 'GET' || (method === 'HEAD' && m[2]))) {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such scheme');
    if (!m[2]) return json(res, 200, await sharedFiles(project.id));
    // One file of the folder, by path relative to it (or ?info for its details).
    const dir = projectSharedDir(DATA_DIR, project.id);
    const path = url.searchParams.get('path') ?? '';
    const found = await resolveFile(path, dir, [dir]);
    if (!found) throw new HttpError(404, 'That file is no longer there, or is not one that can be shown');
    if (!url.searchParams.has('info')) return serveArtifact(req, res, found, path, url.searchParams.has('download'));
    return json(res, 200, {
      path, name: basename(found.abs), display_path: `scheme shared/${path}`,
      kind: found.type.kind, size: found.size, mtime: found.mtime,
    });
  }

  m = pathname.match(/^\/api\/artifacts\/(\d+)(\/[a-z]+)?$/);
  if (m) {
    const a = store.getArtifact(Number(m[1]));
    if (!a) throw new HttpError(404, 'No such artifact');
    const action = m[2] ?? '';
    if (action === '' && method === 'GET') {
      return json(res, 200, { artifact: artifactView(a), project: store.getProject(a.project_id) });
    }
    if (action === '/raw' && (method === 'GET' || method === 'HEAD')) {
      return serveArtifact(req, res, await resolveTicketFile(store.getTicket(a.ticket_id)!, a.path), a.path, url.searchParams.has('download'));
    }
    if (action === '/pin' && method === 'POST') {
      const body = await readJson(req);
      store.setArtifactPinned(a.id, body.pinned ? session.name : null);
      broadcast({ type: 'artifacts', projectId: a.project_id });
      const updated = store.getArtifact(a.id);
      return json(res, 200, updated ? artifactView(updated) : null);
    }
  }

  m = pathname.match(/^\/api\/tickets\/(\d+)\/images\/([^/]+)$/);
  if (m && method === 'GET') {
    const ticket = ticketView(Number(m[1]));
    inScope(ticket.project_id);
    if (!IMAGE_NAME.test(m[2])) throw new HttpError(404, 'Not found');
    let body: Buffer;
    try {
      body = await readFile(join(uploadsDir(ticket), m[2]));
    } catch {
      throw new HttpError(404, 'Not found');
    }
    const type = IMAGE_TYPES.find((t) => m![2].endsWith(t.ext))!.type;
    // Names are random and never reused, so the browser can keep them.
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(body);
  }

  m = pathname.match(/^\/api\/tickets\/(\d+)(\/[a-z]+)?$/);
  if (m) {
    const id = Number(m[1]);
    const action = m[2] ?? '';
    const ticket = ticketView(id);
    inScope(ticket.project_id);
    // (Asking people a question card in its own chat is the one thing it may do to itself.)
    if (scope !== null && method !== 'GET' && ticket.kind === 'coordinator' && !(action === '/questions' && session.agent === id)) {
      throw new HttpError(403, 'The Taskmaster cannot act on itself');
    }
    if (action === '' && method === 'GET') {
      return json(res, 200, { ticket, project: store.getProject(ticket.project_id) });
    }
    if (action === '' && method === 'PATCH') {
      // Any of title, tag, state, note, build, model and effort; null (or "") clears all but the title.
      const body = await readJson(req);
      const fields: Partial<Pick<Ticket, 'title' | 'tag' | 'state' | 'note' | 'build' | 'model' | 'effort'>> = {};
      if (body.model !== undefined) fields.model = oneOf(body.model, MODELS, 'Model');
      if (body.effort !== undefined) fields.effort = oneOf(body.effort, EFFORTS, 'Effort');
      if (body.title !== undefined) fields.title = str(body.title, 'Title', 120);
      if (body.tag !== undefined) fields.tag = oneOf(body.tag, TICKET_TAGS, 'Tag') as TicketTag | null;
      if (body.state !== undefined) fields.state = oneOf(body.state, TICKET_STATES, 'State') as TicketState | null;
      if (body.note !== undefined) fields.note = body.note ? str(body.note, 'Note', 60) : null;
      if (body.build !== undefined) fields.build = buildNumber(body.build);
      for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === ticket[k]) delete fields[k];
      if (Object.keys(fields).length) {
        store.updateTicket(id, fields);
        if ('tag' in fields) store.props.setTypeFromTag(id, fields.tag ?? null, session.name);
        const who = session.agent === id ? 'Claude' : session.name;
        if (fields.title) runner.emit(id, 'note', { text: `${who} renamed this minion from "${ticket.title}" to "${fields.title}".` });
        const next = runner.isRunning(id) ? 'from the next turn' : 'from now on';
        if ('model' in fields) runner.emit(id, 'note', { text: `${who} set this minion to ${fields.model ? modelName(fields.model) : 'the default model'} ${next}.` });
        if ('effort' in fields) runner.emit(id, 'note', { text: `${who} set this minion to ${fields.effort ? `${fields.effort} effort` : 'the default effort'} ${next}.` });
        runner.broadcastTicket(id);
        // A result or a blocker is worth a ping; whoever set it by hand already knows.
        if (fields.state && NOTIFY_STATES[fields.state]) {
          const after = store.getTicket(id)!;
          notify(id, { kind: 'state', state: after.state, note: after.note }, session.agent === undefined ? session.name : null);
        }
      }
      return json(res, 200, ticketView(id));
    }
    if (action === '/seen' && method === 'POST') {
      if (session.agent !== undefined) throw new HttpError(403, 'Only people mark minions seen');
      return json(res, 200, { seen_at: store.markSeen(session.name, id) });
    }
    if (action === '/branch' && method === 'GET') {
      return json(res, 200, { status: await ticketBranch(id) });
    }
    if (action === '/file' && (method === 'GET' || method === 'HEAD')) {
      // A file the ticket linked in its reply: ?path= as written there; ?info for its details.
      const path = url.searchParams.get('path') ?? '';
      if (!url.searchParams.has('info')) return serveArtifact(req, res, await resolveTicketFile(ticket, path), path, url.searchParams.has('download'));
      const found = await resolveTicketFile(ticket, path);
      if (!found) throw new HttpError(404, 'That file is no longer there, or is not one that can be shown');
      const relPath = found.abs.startsWith(ticket.cwd + sep) ? found.abs.slice(ticket.cwd.length + 1) : found.abs;
      const artifact = store.findArtifact(ticket.id, [relPath, found.abs]);
      return json(res, 200, {
        path, name: basename(found.abs), display_path: displayPath(ticket, found.abs),
        kind: found.type.kind, size: found.size, mtime: found.mtime,
        artifact: artifact ? artifactView(artifact) : null,
      });
    }
    if (action === '/events' && method === 'GET') {
      return json(res, 200, store.listEvents(id, Number(url.searchParams.get('after') ?? 0)));
    }
    if (action === '/messages' && method === 'POST') {
      // Room for MAX_IMAGES images at 5 MB each, base64-encoded.
      const body = await readJson(req, 45_000_000);
      const hasImages = Array.isArray(body.images) && body.images.length > 0;
      const text = hasImages && (typeof body.text !== 'string' || !body.text.trim()) ? '' : str(body.text, 'Message', 100_000);
      // The Taskmaster's messages to a minion go through the loop guard; a person's never wait.
      if (session.agent !== undefined && ticket.kind !== 'coordinator') {
        return json(res, 202, { ...ticketView(id), held: runner.relay(id, id, session.name, text) });
      }
      runner.send(id, session.name, text, await saveImages(ticket, body.images));
      personWrote(ticket, session);
      return json(res, 202, ticketView(id));
    }
    if (action === '/continue' && method === 'POST') {
      // Continue button on a loop-guard pause: the minion's held messages go through.
      if (session.agent !== undefined) throw new HttpError(403, 'Only people continue a paused minion');
      return json(res, 200, { released: runner.continueLoop(id, session.name) });
    }
    if (action === '/comments' && method === 'POST') {
      // A comment from a file's viewer: a chat message to the ticket that made the file, saying which file.
      if (session.agent !== undefined) throw new HttpError(403, 'Only people comment on files');
      const body = await readJson(req);
      const found = typeof body.path === 'string' && await resolveTicketFile(ticket, body.path);
      if (!found) throw new HttpError(404, 'That file is no longer there');
      const quote = typeof body.quote === 'string' ? body.quote.slice(0, 2000) : '';
      // Named as the ticket would write it: relative to its working directory, else in full.
      const path = found.abs.startsWith(ticket.cwd + sep) ? found.abs.slice(ticket.cwd.length + 1) : found.abs;
      const { about, text } = commentMessage(path, str(body.text, 'Comment', 10_000), quote);
      runner.send(id, session.name, text, [], { comment: { path: body.path, about } });
      personWrote(ticket, session);
      return json(res, 202, ticketView(id));
    }
    if (action === '/questions' && method === 'POST') {
      // Claude asks people multiple-choice questions; the card shows in the chat until someone answers.
      if (session.agent !== id) throw new HttpError(403, 'Only the minion itself can ask in its chat');
      const questions = await cleanQuestions(ticket, (await readJson(req)).questions);
      const questionId = randomBytes(6).toString('hex');
      runner.emit(id, 'question', { id: questionId, questions });
      notify(id, { kind: 'question', questions });
      return json(res, 201, { id: questionId });
    }
    if (action === '/answer' && method === 'POST') {
      if (session.agent !== undefined) throw new HttpError(403, 'Only people answer question cards');
      const body = await readJson(req);
      const events = store.listEvents(id);
      const card = events.find((e) => e.kind === 'question' && JSON.parse(e.data).id === body.questionId);
      if (!card) throw new HttpError(404, 'No such question');
      if (events.some((e) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId === body.questionId)) {
        throw new HttpError(409, 'That question has already been answered');
      }
      const { questions } = JSON.parse(card.data);
      const answers = cleanAnswers(questions, body.answers);
      const text = questions.map((q: any, i: number) => {
        const picked = [...answers[i].selected, ...(answers[i].other ? [`Other: ${answers[i].other}`] : [])];
        return `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}\n→ ${picked.join('; ')}`;
      }).join('\n\n');
      runner.send(id, session.name, `My answers to your question card:\n\n${text}`, [], { answer: { questionId: body.questionId, answers } });
      personWrote(ticket, session);
      return json(res, 202, ticketView(id));
    }
    if (action === '/approvals' && method === 'POST') {
      // Claude Code wants to run a tool that matches an approval rule; show an Approve / Deny card.
      if (session.agent !== id) throw new HttpError(403, 'Only the minion itself can ask for approval in its chat');
      if (!runner.isRunning(id)) throw new HttpError(409, 'The minion is not mid-turn');
      const body = await readJson(req);
      const tool = str(body.tool_name, 'Tool name', 300);
      return json(res, 201, { id: runner.approvals.request(id, tool, body.input ?? {}) });
    }
    if (action === '/approvals' && method === 'GET') {
      // The thread's MCP server waits here for the card's outcome, half a minute at a time.
      if (session.agent !== id) throw new HttpError(403, 'Only the minion itself can wait on its approvals');
      return json(res, 200, await runner.approvals.wait(id, url.searchParams.get('id') ?? '', APPROVAL_POLL_MS));
    }
    if (action === '/approve' && method === 'POST') {
      // Only a signed-in person's click settles a card; the coordinator and threads cannot.
      if (session.agent !== undefined) throw new HttpError(403, 'Only people approve tool calls');
      const body = await readJson(req);
      if (typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
      const approvalId = String(body.approvalId ?? '');
      const before = runner.approvals.get(id, approvalId);
      if (before.state === 'expired') throw new HttpError(409, 'This request expired; the turn that asked has ended');
      if (before.state !== 'pending') throw new HttpError(409, `${before.by} already ${before.state === 'allowed' ? 'approved' : 'denied'} this`);
      return json(res, 200, runner.approvals.decide(id, approvalId, body.allow, session.name));
    }
    if (action === '/properties' && method === 'PUT') {
      // On the minion itself, or with `file` on one of the files it showed people (an artifact).
      const body = await readJson(req);
      if (body.file != null) {
        const file = str(body.file, 'file', 4096);
        const a = store.findArtifact(id, [isAbsolute(file) ? file : join(ticket.cwd, file), join(sharedDir(ticket), file)]);
        if (!a) throw new HttpError(404, `#${ticket.number} has shown no file ${file}; link it in a reply first`);
        return json(res, 200, registry(() => store.props.set('artifact', a.id, a.project_id, body.properties, session.name)));
      }
      const r = registry(() => store.props.set('minion', id, ticket.project_id, body.properties, session.name));
      runner.broadcastTicket(id);
      return json(res, 200, r);
    }
    if (action === '/stop' && method === 'POST') {
      return json(res, 200, { stopped: runner.stop(id) });
    }
    if (action === '/status' && method === 'POST') {
      const body = await readJson(req);
      if (body.status !== 'closed' && body.status !== 'idle') throw new HttpError(400, 'Status must be closed or idle');
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'The Taskmaster cannot be dismissed');
      if (runner.isRunning(id)) throw new HttpError(409, 'Stop the minion before dismissing it');
      if (body.status === 'closed') {
        runner.close(id, `${session.name} dismissed this minion.`);
      } else {
        store.updateTicket(id, { status: body.status });
        runner.emit(id, 'note', { text: `${session.name} reopened this minion.` });
        runner.broadcastTicket(id);
      }
      return json(res, 200, ticketView(id));
    }
    if (action === '/coordinator' && method === 'POST') {
      // A thread asks its project's coordinator for something only the coordinator can do (message_coordinator).
      if (session.agent !== id || ticket.kind === 'coordinator') throw new HttpError(403, 'Only a minion can message its Taskmaster');
      const text = str((await readJson(req)).text, 'Message', 10_000);
      const coordinator = await ensureCoordinator(store.getProject(ticket.project_id)!);
      if (runner.relay(id, coordinator.id, `#${ticket.number} ${ticket.title}`, text)) return json(res, 202, { sent: false, held: true });
      runner.emit(id, 'note', { text: `Sent the Taskmaster: ${text.length > 200 ? text.slice(0, 200) + '…' : text}` });
      return json(res, 202, { sent: true });
    }
    if (action === '/deploy' && method === 'POST') {
      // tools/deploy.sh, run for this minion, reports how its queued restart went. A failure shows as
      // an error and pushes, so a deploy that rolled back or gave up is never silent.
      if (session.agent !== id) throw new HttpError(403, 'Only the deploying minion can report its deploy');
      const body = await readJson(req);
      const text = str(body.text, 'Report', 4000);
      const failed = body.ok === false;
      (failed ? console.error : console.log)(`Deploy report for minion ${id}: ${text}`);
      runner.emit(id, failed ? 'error' : 'note', { text });
      if (failed) notify(id, { kind: 'error', text });
      // A failed deploy leaves the minion in pending-deploy, so the error stays in view.
      const dismissed = !failed && runner.deployLive(id);
      return json(res, 201, { dismissed });
    }
    if (action === '/close' && method === 'POST') {
      // A thread closes itself once its current turn ends (close_self); the token decides which thread.
      if (session.agent !== id) throw new HttpError(403, 'A minion may only be dismissed by itself');
      const body = await readJson(req);
      const reason = typeof body.reason === 'string' && body.reason.trim() ? str(body.reason.trim(), 'Reason', 500) : null;
      if (!runner.closeAfterTurn(id, reason)) throw new HttpError(409, 'The minion is not mid-turn');
      return json(res, 202, ticketView(id));
    }
  }

  throw new HttpError(404, 'Not found');
}

// ---------- push subscriptions ----------

/** This browser's subscription as the account panel needs it. */
const pushView = (endpoint: string) => {
  const row = store.getPushSubscription(endpoint);
  return { subscribed: !!row, muted: row ? JSON.parse(row.muted) as number[] : [] };
};

/** Each signed-in person turns notifications on per browser, and can mute projects there. */
async function pushApi(req: IncomingMessage, res: ServerResponse, pathname: string, method: string, session: Session) {
  if (session.agent !== undefined) throw new HttpError(403, 'Only people get notifications');
  if (pathname === '/api/push/key' && method === 'GET') return json(res, 200, { publicKey: pusher.publicKey });
  if (pathname !== '/api/push/subscription') throw new HttpError(404, 'Not found');
  const body = await readJson(req, 10_000);
  if (method === 'PUT') {
    if (!validSubscription(body.subscription)) throw new HttpError(400, 'Not a usable push subscription');
    const { endpoint, keys } = body.subscription;
    store.savePushSubscription(session.name, endpoint, keys.p256dh, keys.auth);
    if (!process.env.PUSH_SUBJECT && !store.getSetting('push_subject')) {
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      pusher.subject = `https://${host}`;
      store.setSetting('push_subject', pusher.subject);
    }
    return json(res, 200, pushView(endpoint));
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const row = store.getPushSubscription(endpoint);
  // Only the person a browser is subscribed for may change or see it.
  if (row && row.name !== session.name) return json(res, 200, { subscribed: false, muted: [] });
  if (method === 'POST') return json(res, 200, pushView(endpoint));
  if (method === 'PATCH') {
    if (!row) throw new HttpError(404, 'This browser is not subscribed');
    const projectId = Number(body.projectId);
    const muted = new Set<number>(JSON.parse(row.muted));
    if (body.muted) muted.add(projectId);
    else muted.delete(projectId);
    store.setPushMuted(endpoint, [...muted].filter((id) => store.getProject(id)));
    return json(res, 200, pushView(endpoint));
  }
  if (method === 'DELETE') {
    if (row) store.deletePushSubscription(endpoint);
    return json(res, 200, pushView(endpoint));
  }
  throw new HttpError(405, 'Method not allowed');
}

// ---------- machines ----------

/** What a machine's agent calls: hold its stream open, or pass on a message from its MCP server. */
async function machineAgentApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const machine = machines.authenticate(req);
  if (!machine) throw new HttpError(401, 'Unknown machine token; make a new one in the Machines panel');
  if (url.pathname === '/api/machines/connect' && req.method === 'GET') {
    const info = (k: string) => (url.searchParams.get(k) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
    return machines.connectAgent(machine, res, { host: info('host'), command: info('command') });
  }
  if (url.pathname === '/api/machines/send' && req.method === 'POST') {
    // Room for screenshots, which MCP servers send as base64 images.
    const body = await readJson(req, 50_000_000);
    if (typeof body.session !== 'string') throw new HttpError(400, 'session is required');
    // A gone session tells the agent to stop that copy of its MCP server.
    if (!machines.fromAgent(machine, body.session, body)) throw new HttpError(410, 'No such session');
    return json(res, 202, {});
  }
  throw new HttpError(404, 'Not found');
}

// Notes go into every thread's system prompt while the machine is online, so keep them short.
const MAX_MACHINE_NOTES = 2000;

function machineName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!MACHINE_NAME.test(name)) throw new HttpError(400, 'Use 1 to 30 lowercase letters, digits and dashes, like godot-laptop');
  if (RESERVED_NAMES.has(name)) throw new HttpError(400, 'That name is taken by the app\'s own tools');
  return name;
}

/** People list and manage machines; a thread's MCP proxy opens a session to one and sends it messages. */
async function machinesApi(req: IncomingMessage, res: ServerResponse, pathname: string, method: string, session: Session) {
  let m = pathname.match(/^\/api\/machines\/(\d+)\/session(?:\/([0-9a-f]{24}))?$/);
  if (m) {
    const ticket = session.agent === undefined ? null : store.getTicket(session.agent);
    if (ticket?.kind !== 'ticket') throw new HttpError(403, 'Only a minion\'s turn can use a machine');
    const machineId = Number(m[1]);
    if (!m[2] && method === 'GET') {
      const opened = machines.openSession(machineId, ticket, res);
      if (opened === 'not granted') throw new HttpError(403, 'That machine isn\'t granted to this scheme');
      if (opened === 'offline') throw new HttpError(503, 'That machine is offline');
      return;
    }
    if (m[2] && method === 'POST') {
      const body = await readJson(req, 50_000_000);
      if (!machines.fromSession(m[2], ticket.id, body.message)) throw new HttpError(503, 'That machine went offline');
      return json(res, 202, {});
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (session.agent !== undefined) throw new HttpError(403, 'Only people manage machines');

  if (pathname === '/api/machines' && method === 'GET') return json(res, 200, machines.list());
  if (pathname === '/api/machines' && method === 'POST') {
    const body = await readJson(req);
    const name = machineName(body.name);
    let machine;
    try {
      // The real hash goes in once the id (part of the token) is known.
      machine = store.createMachine(name, '', session.name);
    } catch {
      throw new HttpError(409, 'A machine with that name already exists');
    }
    const token = newToken(machine.id);
    store.updateMachine(machine.id, { token_hash: hashToken(token) });
    // Granted to the scheme it was added from; other schemes need a toggle on the Machines page.
    if (Number.isInteger(body.project_id) && store.getProject(body.project_id)) store.setMachineGrant(machine.id, body.project_id, true);
    broadcast({ type: 'machines', machines: machines.list() });
    // The only time the token is shown; the app keeps just its hash.
    return json(res, 201, { machine: machines.view(store.getMachine(machine.id)!), token, agent_url: MACHINES_URL?.origin ?? null });
  }

  m = pathname.match(/^\/api\/machines\/(\d+)(\/token|\/projects\/(\d+))?$/);
  const machine = m && store.getMachine(Number(m[1]));
  if (!m || !machine) throw new HttpError(404, 'No such machine');
  if (m[3]) {
    // PUT lets the scheme's minions use the machine, DELETE stops them.
    if (method !== 'PUT' && method !== 'DELETE') throw new HttpError(405, 'Method not allowed');
    if (!store.getProject(Number(m[3]))) throw new HttpError(404, 'No such scheme');
    machines.setGrant(machine.id, Number(m[3]), method === 'PUT');
    return json(res, 200, machines.view(store.getMachine(machine.id)!));
  }
  if (m[2] && method === 'POST') {
    // A new token locks out whoever holds the old one, the connected agent included.
    const token = newToken(machine.id);
    store.updateMachine(machine.id, { token_hash: hashToken(token) });
    machines.disconnect(machine.id);
    return json(res, 200, { machine: machines.view(store.getMachine(machine.id)!), token, agent_url: MACHINES_URL?.origin ?? null });
  }
  if (!m[2] && method === 'PATCH') {
    // Any of name and notes.
    const body = await readJson(req);
    const fields: { name?: string; notes?: string } = {};
    if (body.name !== undefined) fields.name = machineName(body.name);
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') throw new HttpError(400, 'notes must be text');
      fields.notes = body.notes.replace(/\r\n/g, '\n').trim();
      if (fields.notes.length > MAX_MACHINE_NOTES) throw new HttpError(400, `Notes are limited to ${MAX_MACHINE_NOTES.toLocaleString('en')} characters`);
    }
    try {
      store.updateMachine(machine.id, fields);
    } catch {
      throw new HttpError(409, 'A machine with that name already exists');
    }
    broadcast({ type: 'machines', machines: machines.list() });
    return json(res, 200, machines.view(store.getMachine(machine.id)!));
  }
  if (!m[2] && method === 'DELETE') {
    store.deleteMachine(machine.id);
    machines.disconnect(machine.id);
    broadcast({ type: 'machines', machines: machines.list() });
    return json(res, 200, {});
  }
  throw new HttpError(405, 'Method not allowed');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
  try {
    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url, auth.session(req));
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

server.listen(PORT, HOST, () => console.log(`${APP_NAME} listening on http://${HOST}:${PORT}`));

// A front-end-only deploy: re-read public/ and tell open tabs, which reload once nobody is typing.
process.on('SIGHUP', () => {
  const before = ASSET_VERSION;
  loadAssets().then(
    () => {
      console.log(`Reloaded public/ on SIGHUP: front end ${before} → ${ASSET_VERSION}`);
      if (ASSET_VERSION !== before) broadcast({ type: 'hello', version: ASSET_VERSION, usage: runner.usage });
    },
    (err) => console.error('Reloading public/ on SIGHUP failed; still serving the old front end:', err),
  );
});

// The machines-only listener: the agent's two endpoints and the agent script, nothing else.
if (MACHINES_URL) {
  const agents = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/machines/connect' || url.pathname === '/api/machines/send') await machineAgentApi(req, res, url);
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
