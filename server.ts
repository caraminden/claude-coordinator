// Claude Coordinator: a shared web UI over headless Claude Code sessions.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gzip } from 'node:zlib';
import { homedir } from 'node:os';
import { fileType, findArtifacts, isArtifact } from './src/artifacts.ts';
import { AGENT_NAME, Auth, type Session } from './src/auth.ts';
import { branchStatus, type BranchStatus } from './src/branch.ts';
import { claudeConfigDir, saveSession } from './src/sessions.ts';
import { Store, TICKET_STATES, TICKET_TAGS, type Artifact, type Project, type Ticket, type TicketState, type TicketTag } from './src/db.ts';
import { Runner } from './src/runner.ts';
import { cloneProject, createTicketDir, projectDir, removeProjectDir } from './src/workspace.ts';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8573);
const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator');
const PUBLIC_DIR = join(import.meta.dirname, 'public');
const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'plan', 'default'];
// Headless turns can't ask for approval, so anything short of full access refuses most shell commands.
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
// The coordinator only reads and calls its MCP tools; the work happens in the tickets it creates.
const COORDINATOR_PERMISSION_MODE = 'acceptEdits';
const LOCAL_HOST = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;

await mkdir(DATA_DIR, { recursive: true });
// Fingerprint of the front end, so open tabs can tell they are stale after a deploy.
const ASSET_VERSION = createHash('sha256')
  .update((await Promise.all((await readdir(PUBLIC_DIR)).sort().map((f) => readFile(join(PUBLIC_DIR, f))))).join('\0'))
  .digest('hex')
  .slice(0, 12);
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
runner.recover();

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
    if (store.syncArtifacts(ticket, found)) broadcast({ type: 'artifacts', projectId: ticket.project_id });
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
// Pick up anything made while the server was down (or before artifacts existed), one ticket at a time.
// Rows for file types that no longer count as artifacts go first, pinned or not.
store.pruneArtifacts(isArtifact);
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
  const shared = sharedDir(ticket) + sep;
  if (path.startsWith(shared)) return `shared files/${path.slice(shared.length)}`;
  if (ticket.cwd && path.startsWith(ticket.cwd + sep)) return path.slice(ticket.cwd.length + 1);
  return path;
}

/**
 * Find a file a ticket may show: `path` is absolute or relative to its working directory, and must
 * resolve (symlinks included) to a servable file type inside the working directory or shared folder.
 */
async function resolveTicketFile(ticket: Ticket, path: string) {
  const type = fileType(path);
  if (!type || !ticket.cwd || path.includes('\0')) return null;
  try {
    const file = await realpath(isAbsolute(path) ? path : join(ticket.cwd, path));
    for (const root of [ticket.cwd, sharedDir(ticket)]) {
      const real = await realpath(root).catch(() => null);
      if (!real || !file.startsWith(real + sep)) continue;
      const st = await stat(file);
      if (!st.isFile()) return null;
      // The path the ticket used, made absolute, so artifact rows and links agree.
      const abs = isAbsolute(path) ? normalize(path) : join(ticket.cwd, path);
      return { file, abs, type, size: st.size, mtime: Math.round(st.mtimeMs) };
    }
  } catch {}
  return null;
}

/** Serve a file a ticket may show (see resolveTicketFile), with byte ranges and a sandboxing CSP. */
async function serveArtifact(req: IncomingMessage, res: ServerResponse, ticket: Ticket, path: string, download: boolean) {
  const found = await resolveTicketFile(ticket, path);
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
    res.writeHead(status, { ...headers, Vary: 'Accept-Encoding' });
    return res.end(buf);
  }
  gzip(buf, { level: 6 }, (err, zipped) => {
    if (res.destroyed) return;
    if (err) {
      res.writeHead(status, { ...headers, Vary: 'Accept-Encoding' });
      return res.end(buf);
    }
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
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
  return name.slice(0, 40);
}

function isSecure(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}

/** One of a fixed set of values, or null when empty. */
function oneOf(v: unknown, allowed: readonly string[], field: string): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
}

function ticketView(id: number) {
  const t = store.getTicket(id);
  if (!t) throw new HttpError(404, 'No such ticket');
  return runner.view(t);
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
  if (!t) throw new HttpError(403, 'No such ticket');
  // A ticket's own token may only read and update that ticket (its title, tag, state and note).
  if (t.kind !== 'coordinator') {
    if (pathname !== `/api/tickets/${t.id}` || (method !== 'GET' && method !== 'PATCH')) throw new HttpError(403, 'A thread may only update itself');
    return t.project_id;
  }
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
};

async function serveStatic(res: ServerResponse, path: string) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
  try {
    const body = await readFile(file);
    send(res, 200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }, body);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, session: Session | null) {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const body = await readJson(req);
    const name = cleanName(body.name);
    if (name.toLowerCase() === AGENT_NAME.toLowerCase()) throw new HttpError(400, 'That name is reserved');
    // Checked right before the password (no await in between) so parallel bursts are counted.
    if (auth.limited(ip)) throw new HttpError(429, 'Too many attempts; try again later');
    if (!auth.checkPassword(ip, String(body.password ?? ''))) throw new HttpError(401, 'Wrong password');
    return json(res, 200, { name }, { 'Set-Cookie': auth.issueCookie(name, isSecure(req)) });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return json(res, 200, {}, { 'Set-Cookie': auth.clearCookie() });
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

  // A coordinator may only touch its own project's tickets, and not itself.
  const scope = agentProject(session, method, pathname);
  const inScope = (projectId: number) => {
    if (scope !== null && scope !== projectId) throw new HttpError(403, 'Outside this coordinator\'s project');
  };
  if (scope !== null && !/^\/api\/(projects\/\d+(\/tickets)?|tickets\/\d+(\/[a-z]+)?)$/.test(pathname)) {
    throw new HttpError(403, 'Not available to the coordinator');
  }

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
        throw new HttpError(409, 'A project with that name already exists');
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
    if (!project) throw new HttpError(404, 'No such project');
    inScope(project.id);
    const coordinator = await ensureCoordinator(project);
    const tickets = store
      .listTickets(project.id)
      .filter((t) => t.kind === 'ticket')
      .map((t) => runner.view(t));
    return json(res, 200, { project, coordinator: ticketView(coordinator.id), tickets });
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/tickets$/);
  if (m && method === 'POST') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such project');
    inScope(project.id);
    const body = await readJson(req);
    const title = str(body.title, 'Title', 120);
    const message = str(body.message, 'First message', 100_000);
    const mode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : DEFAULT_PERMISSION_MODE;
    // Insert first so concurrent creates get distinct ids, then build the working dir.
    const tag = oneOf(body.tag ?? null, TICKET_TAGS, 'Tag') as TicketTag | null;
    const { id, number } = store.createTicket({ project_id: project.id, title, tag, permission_mode: mode, created_by: session.name });
    try {
      const dir = await createTicketDir(DATA_DIR, project.id, project.repo_dir, id, number!, title);
      store.setTicketDir(id, dir.cwd, dir.branch);
    } catch (err: any) {
      store.deleteTicket(id);
      throw new HttpError(500, `Could not create working directory: ${err.stderr?.trim() || err.message}`);
    }
    runner.send(id, session.name, message);
    return json(res, 201, ticketView(id));
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/search$/);
  if (m && method === 'GET') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such project');
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    return json(res, 200, q.length < 2 ? [] : searchProject(project.id, q));
  }

  m = pathname.match(/^\/api\/projects\/(\d+)\/artifacts$/);
  if (m && method === 'GET') {
    const project = store.getProject(Number(m[1]));
    if (!project) throw new HttpError(404, 'No such project');
    return json(res, 200, store.listArtifacts(project.id).map(artifactView));
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
      return serveArtifact(req, res, store.getTicket(a.ticket_id)!, a.path, url.searchParams.has('download'));
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
    if (scope !== null && method !== 'GET' && ticket.kind === 'coordinator') {
      throw new HttpError(403, 'The coordinator cannot act on itself');
    }
    if (action === '' && method === 'GET') {
      return json(res, 200, { ticket, project: store.getProject(ticket.project_id) });
    }
    if (action === '' && method === 'PATCH') {
      // Any of title, tag, state and note; null (or "") clears tag, state and note.
      const body = await readJson(req);
      const fields: Partial<Pick<Ticket, 'title' | 'tag' | 'state' | 'note'>> = {};
      if (body.title !== undefined) fields.title = str(body.title, 'Title', 120);
      if (body.tag !== undefined) fields.tag = oneOf(body.tag, TICKET_TAGS, 'Tag') as TicketTag | null;
      if (body.state !== undefined) fields.state = oneOf(body.state, TICKET_STATES, 'State') as TicketState | null;
      if (body.note !== undefined) fields.note = body.note ? str(body.note, 'Note', 60) : null;
      for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === ticket[k]) delete fields[k];
      if (Object.keys(fields).length) {
        store.updateTicket(id, fields);
        const who = session.agent === id ? 'Claude' : session.name;
        if (fields.title) runner.emit(id, 'note', { text: `${who} renamed this ticket from "${ticket.title}" to "${fields.title}".` });
        runner.broadcastTicket(id);
      }
      return json(res, 200, ticketView(id));
    }
    if (action === '/branch' && method === 'GET') {
      return json(res, 200, { status: await ticketBranch(id) });
    }
    if (action === '/file' && (method === 'GET' || method === 'HEAD')) {
      // A file the ticket linked in its reply: ?path= as written there; ?info for its details.
      const path = url.searchParams.get('path') ?? '';
      if (!url.searchParams.has('info')) return serveArtifact(req, res, ticket, path, url.searchParams.has('download'));
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
      runner.send(id, session.name, text, await saveImages(ticket, body.images));
      return json(res, 202, ticketView(id));
    }
    if (action === '/stop' && method === 'POST') {
      return json(res, 200, { stopped: runner.stop(id) });
    }
    if (action === '/status' && method === 'POST') {
      const body = await readJson(req);
      if (body.status !== 'closed' && body.status !== 'idle') throw new HttpError(400, 'Status must be closed or idle');
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'The coordinator cannot be closed');
      if (runner.isRunning(id)) throw new HttpError(409, 'Stop the ticket before closing it');
      store.updateTicket(id, { status: body.status });
      runner.emit(id, 'note', { text: `${session.name} ${body.status === 'closed' ? 'closed' : 'reopened'} this ticket.` });
      runner.broadcastTicket(id);
      return json(res, 200, ticketView(id));
    }
  }

  throw new HttpError(404, 'Not found');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
  try {
    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url, auth.session(req));
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error' : err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Claude Coordinator listening on http://${HOST}:${PORT}`));
