// Claude Coordinator: a shared web UI over headless Claude Code sessions.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, posix, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { artifactType, findArtifacts } from './src/artifacts.ts';
import { AGENT_NAME, Auth, type Session } from './src/auth.ts';
import { Store, type Artifact, type Project, type Ticket } from './src/db.ts';
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
    const found = await findArtifacts(ticket.cwd, !!ticket.branch);
    if (store.syncArtifacts(ticket, found)) broadcast({ type: 'artifacts', projectId: ticket.project_id });
  })();
  scanning.set(ticketId, job);
  try {
    await job;
  } finally {
    scanning.delete(ticketId);
  }
}

runner.onFilesMayChange = scheduleScan;
// Pick up anything made while the server was down (or before artifacts existed), one ticket at a time.
(async () => {
  for (const p of store.listProjects()) {
    for (const t of store.listTickets(p.id)) {
      await scanArtifacts(t.id).catch((err) => console.error(`Artifact scan of ticket ${t.id} failed:`, err));
    }
  }
})();

function artifactView(a: Artifact & { ticket_title?: string; ticket_kind?: string; ticket_number?: number | null }) {
  const ticket = a.ticket_title === undefined ? store.getTicket(a.ticket_id) : null;
  return {
    ...a,
    name: basename(a.path),
    kind: artifactType(a.path)?.kind ?? 'text',
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

/** Serve a file from a ticket's folder; `path` is relative to it and must be an artifact type. */
async function serveArtifact(req: IncomingMessage, res: ServerResponse, ticket: Ticket, path: string, download: boolean) {
  const type = artifactType(path);
  if (!type) throw new HttpError(404, 'Not found');
  let file: string;
  let size: number;
  try {
    // Resolve symlinks so the file must really be inside the ticket's folder.
    const root = await realpath(ticket.cwd);
    file = await realpath(join(ticket.cwd, path));
    if (!file.startsWith(root + sep)) throw new Error('outside');
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    throw new HttpError(404, 'That file is no longer there');
  }
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

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
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

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
}

function ticketView(id: number) {
  const t = store.getTicket(id);
  if (!t) throw new HttpError(404, 'No such ticket');
  return { ...t, queued: runner.queued(id) };
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
function agentProject(session: Session): number | null {
  if (session.agent === undefined) return null;
  const t = store.getTicket(session.agent);
  if (t?.kind !== 'coordinator') throw new HttpError(403, 'Not a coordinator');
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
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
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
  const scope = agentProject(session);
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
      .map((t) => ({ ...t, queued: runner.queued(t.id) }));
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
    const { id, number } = store.createTicket({ project_id: project.id, title, permission_mode: mode, created_by: session.name });
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
    if (action === '/rel' && (method === 'GET' || method === 'HEAD')) {
      // A file a document links to (e.g. its images), relative to the document. serveArtifact
      // still keeps it inside the ticket's folder and to artifact file types.
      const rel = posix.normalize(posix.join(posix.dirname(a.path), url.searchParams.get('path') ?? ''));
      if (rel.startsWith('../') || rel === '..' || posix.isAbsolute(rel)) throw new HttpError(404, 'Not found');
      return serveArtifact(req, res, store.getTicket(a.ticket_id)!, rel, false);
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
      const body = await readJson(req);
      const title = str(body.title, 'Title', 120);
      if (title !== ticket.title) {
        store.updateTicket(id, { title });
        runner.emit(id, 'note', { text: `${session.name} renamed this ticket from "${ticket.title}" to "${title}".` });
        runner.broadcastTicket(id);
      }
      return json(res, 200, ticketView(id));
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
