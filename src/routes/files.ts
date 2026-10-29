// Files people see: artifacts minions showed, the scheme's shared folder, a file a reply linked, and
// the images and files people attach to messages.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileTitle, fileType, resolveFile, siblingType } from '../artifacts.ts';
import type { Session } from '../auth.ts';
import type { Artifact, Ticket } from '../db.ts';
import type { MessageFile } from '../runner.ts';
import { isUploadName, MAX_UPLOADS, opensInline } from '../uploads.ts';
import { projectDir, projectSharedDir } from '../workspace.ts';
import { HttpError, json, readJson, SECURITY_HEADERS, str, type App, type Route } from '../http.ts';

export function artifactView(app: App, a: Artifact & { ticket_title?: string; ticket_kind?: string; ticket_number?: number | null }) {
  const ticket = a.ticket_title === undefined ? app.store.getTicket(a.ticket_id) : null;
  const owner = ticket ?? app.store.getTicket(a.ticket_id)!;
  return {
    ...a,
    name: basename(a.path),
    display_path: displayPath(app, owner, a.path),
    abs: isAbsolute(a.path) ? a.path : join(owner.cwd, a.path),
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

/** A path as people should see it: relative to the working directory, or under "shared files". */
function displayPath(app: App, ticket: Ticket, path: string): string {
  const projectShared = projectSharedDir(app.dataDir, ticket.project_id) + sep;
  if (path.startsWith(projectShared)) return `scheme shared/${path.slice(projectShared.length)}`;
  const shared = app.sharedDir(ticket) + sep;
  if (path.startsWith(shared)) return `shared files/${path.slice(shared.length)}`;
  if (ticket.cwd && path.startsWith(ticket.cwd + sep)) return path.slice(ticket.cwd.length + 1);
  return path;
}

/** The folders a ticket may show files from: its working directory, its shared folder and the project's. */
export const ticketRoots = (app: App, ticket: Ticket) => [ticket.cwd, app.sharedDir(ticket), projectSharedDir(app.dataDir, ticket.project_id)];

/** A file a ticket may show (see resolveFile), or null. */
export function resolveTicketFile(app: App, ticket: Ticket, path: string) {
  return resolveFile(path, ticket.cwd, ticketRoots(app, ticket));
}

/**
 * The artifact of scheme `projectId` that `caller` means: by id, or by a path as it linked it (absolute,
 * or relative to its working directory) or as list_artifacts shows it.
 */
function findPinTarget(app: App, projectId: number, caller: Ticket, id: unknown, path: unknown): Artifact {
  if (id != null) {
    const a = Number.isInteger(id) ? app.store.getArtifact(id as number) : undefined;
    if (!a || a.project_id !== projectId) throw new HttpError(404, `No artifact ${id} in this scheme; list_artifacts shows their ids`);
    return a;
  }
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new HttpError(400, 'Give the artifact (its id) or the path you linked');
  const p = path.trim();
  const abs = isAbsolute(p) ? normalize(p) : caller.cwd ? join(caller.cwd, p) : null;
  const views = app.store.listArtifacts(projectId).map((a) => artifactView(app, a));
  // The file the caller linked wins over another minion's that shows under the same path.
  const exact = views.filter((v) => v.abs === abs);
  const hits = exact.length ? exact : views.filter((v) => v.display_path === p);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new HttpError(404, `No artifact at ${p} in this scheme. A file becomes one once a reply links it; list_artifacts shows them`);
  throw new HttpError(409, `${hits.length} artifacts match ${p} (ids ${hits.map((a) => a.id).join(', ')}); give the id`);
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
  // Something people uploaded is only ever saved, never rendered, unless it's an image or a PDF.
  if (download || type.kind === 'download' || (/[/\\]shared[/\\]\d+[/\\]uploads[/\\]/.test(file) && !opensInline(file))) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`;
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

/**
 * The folder a file token reads: `t<minion>-<n>` is that minion's nth root (see ticketRoots),
 * `p<scheme>` the scheme's shared folder. Null when it names nothing.
 */
function scopeRoot(app: App, scope: string): string | null {
  const t = /^t(\d+)-([012])$/.exec(scope);
  if (t) {
    const ticket = app.store.getTicket(Number(t[1]));
    return ticket?.cwd ? ticketRoots(app, ticket)[Number(t[2])] : null;
  }
  const p = /^p(\d+)$/.exec(scope);
  return p && app.store.getProject(Number(p[1])) ? projectSharedDir(app.dataDir, Number(p[1])) : null;
}


/**
 * Serve a file found under `roots` ([scope, folder] pairs). An HTML page a person opens goes to its
 * path under a file token instead: its sandboxed frame sends no cookies, so the token is how the
 * files beside it (`<video src="clip.mp4">`) load.
 */
async function serveFound(ctx: { req: IncomingMessage; res: ServerResponse; url: URL; app: App; session: Session }, found: Awaited<ReturnType<typeof resolveFile>>, path: string, roots: [string, string][]) {
  const { req, res, url, app, session } = ctx;
  const download = url.searchParams.has('download');
  if (found?.type.kind === 'html' && !download && session.agent === undefined) {
    for (const [scope, root] of roots) {
      const real = await realpath(root).catch(() => null);
      if (!real || !found.file.startsWith(real + sep)) continue;
      const rel = found.file.slice(real.length + 1).split(sep).map(encodeURIComponent).join('/');
      // A page under a hidden folder still opens, just without its siblings.
      if (tokenPath(rel) === null) break;
      // Relative, so it stays inside a preview's /preview/N/.
      const location = `${'../'.repeat(url.pathname.split('/').length - 3)}files/${app.auth.fileToken(scope)}/${rel}`;
      return void res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }).end();
    }
  }
  return serveArtifact(req, res, found, path, download);
}

const ticketScopes = (app: App, ticket: Ticket) => ticketRoots(app, ticket).map((root, i): [string, string] => [`t${ticket.id}-${i}`, root]);

/** A path under a file token, as segments decoded one by one; null if one is empty, hidden, `.`/`..` or hides a slash. */
function tokenPath(raw: string): string | null {
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    let part: string;
    try {
      part = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (!part || part.startsWith('.') || /[\/\\\0]/.test(part)) return null;
    parts.push(part);
  }
  return parts.join('/');
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

function uploadsDir(app: App, ticket: Ticket): string {
  return join(projectDir(app.dataDir, ticket.project_id), 'uploads', String(ticket.id));
}

/** Check pasted images (base64 in the request body) and write them to the ticket's uploads folder. */
export async function saveImages(app: App, ticket: Ticket, raw: unknown): Promise<{ name: string; path: string; mediaType: string }[]> {
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
  const dir = uploadsDir(app, ticket);
  await mkdir(dir, { recursive: true });
  return Promise.all(decoded.map(async ({ buf, kind }) => {
    const name = randomBytes(12).toString('hex') + kind.ext;
    const path = join(dir, name);
    await writeFile(path, buf);
    return { name, path, mediaType: kind.type };
  }));
}

/** A thread's attached files: its files folder (COORDINATOR_FILES_DIR), so Claude can read them. */
export const fileUploadsDir = (app: App, ticket: Ticket) => join(app.sharedDir(ticket), 'uploads');

/** An uploaded file by its name in the thread's uploads folder, or null; the name can't leave the folder. */
async function findUpload(app: App, ticket: Ticket, name: unknown) {
  if (typeof name !== 'string' || !isUploadName(name)) return null;
  const dir = fileUploadsDir(app, ticket);
  try {
    const path = await realpath(join(dir, name));
    if (!path.startsWith(await realpath(dir) + sep)) return null;
    const st = await stat(path);
    return st.isFile() ? { name, path, size: st.size } : null;
  } catch {
    return null;
  }
}

/** The files a message names (uploaded beforehand with PUT .../uploads), each with its type for Claude. */
export async function messageFiles(app: App, ticket: Ticket, raw: unknown): Promise<MessageFile[]> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'files must be a list');
  if (raw.length > MAX_UPLOADS) throw new HttpError(400, `At most ${MAX_UPLOADS} files per message`);
  return Promise.all(raw.map(async (f) => {
    const found = await findUpload(app, ticket, f?.name);
    if (!found) throw new HttpError(400, 'An attached file is no longer there; attach it again');
    // The browser's word for the type, only as a hint to Claude.
    const type = typeof f.type === 'string' && /^[\w.+-]{1,60}\/[\w.+-]{1,100}$/.test(f.type) ? f.type : 'application/octet-stream';
    return { ...found, type };
  }));
}

export const fileRoutes: Route[] = [
  {
    method: 'GET', path: '/api/projects/:project/artifacts', who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, project }) {
      const views = app.store.listArtifacts(project.id).map((a) => artifactView(app, a));
      // ?titles reads each document's own title, so an agent can find one by the name people use.
      if (!url.searchParams.has('titles')) return json(res, 200, views);
      return json(res, 200, await Promise.all(views.map(async (v) => ({ ...v, title: v.missing ? null : await fileTitle(v.abs) }))));
    },
  },
  {
    // A Taskmaster or minion pins (or unpins) an artifact of its own scheme because a person asked;
    // people use /api/artifacts/:artifact/pin.
    method: 'POST', path: '/api/projects/:project/artifacts/pin', who: ['taskmaster', 'minion'],
    async handler({ req, res, app, project, caller }) {
      const body = await readJson(req);
      const asker = str(body.requested_by, 'requested_by', 60);
      if (/[\n\r]/.test(asker)) throw new HttpError(400, 'requested_by must be a login name');
      const a = findPinTarget(app, project.id, caller!, body.artifact, body.path);
      const by = `${caller!.kind === 'coordinator' ? 'Taskmaster' : `#${caller!.number}`} for ${asker}`;
      // Pinning one already pinned keeps who pinned it first.
      const already = !!body.pinned && a.pinned_at !== null;
      if (!already) app.store.setArtifactPinned(a.id, body.pinned ? by : null);
      app.broadcast({ type: 'artifacts', projectId: project.id });
      const updated = app.store.getArtifact(a.id);
      return json(res, 200, { artifact: updated ? artifactView(app, updated) : null, removed: !updated, already });
    },
  },
  { method: 'GET', path: '/api/projects/:project/shared', who: ['person'], handler: async ({ res, app, project }) => json(res, 200, await app.sharedFiles(project.id)) },
  {
    method: ['GET', 'HEAD'], path: '/api/projects/:project/shared/file', who: ['person'],
    async handler(ctx) {
      const { url, app, project } = ctx;
      // One file of the folder, by path relative to it (or ?info for its details).
      const dir = projectSharedDir(app.dataDir, project.id);
      const path = url.searchParams.get('path') ?? '';
      const found = await resolveFile(path, dir, [dir]);
      if (!found) throw new HttpError(404, 'That file is no longer there, or is not one that can be shown');
      if (!url.searchParams.has('info')) return serveFound(ctx, found, path, [[`p${project.id}`, dir]]);
      return json(res, 200, {
        path, name: basename(found.abs), display_path: `scheme shared/${path}`, abs: found.abs,
        kind: found.type.kind, size: found.size, mtime: found.mtime,
      });
    },
  },

  {
    method: 'GET', path: '/api/artifacts/:artifact', who: ['person'],
    handler: ({ res, app, artifact }) => json(res, 200, { artifact: artifactView(app, artifact), project: app.store.getProject(artifact.project_id) }),
  },
  {
    method: ['GET', 'HEAD'], path: '/api/artifacts/:artifact/raw', who: ['person'],
    async handler(ctx) {
      const { app, artifact: a } = ctx;
      const ticket = app.store.getTicket(a.ticket_id)!;
      return serveFound(ctx, await resolveTicketFile(app, ticket, a.path), a.path, ticketScopes(app, ticket));
    },
  },
  {
    // An HTML page's file and the files beside it, for its sandboxed frame, which sends no cookies:
    // the token (see serveFound) is the login, and the path can't leave the token's one folder.
    method: ['GET', 'HEAD'], path: '/api/files/:token/*path', who: 'anyone',
    async handler({ req, res, url, app, params }) {
      // The frame's origin is opaque, so fetch() and module scripts need CORS (errors included); no cookies are involved.
      res.setHeader('Access-Control-Allow-Origin', '*');
      const scope = app.auth.fileScope(params.token);
      const named = params.token.split('.')[0];
      if (!scope) {
        // A tab reopened from history after the token expired: a signed-in person gets a fresh one.
        const session = app.auth.session(req);
        if (!session || session.agent !== undefined) throw new HttpError(403, 'This link has expired; open the file from Citadel again');
        if (!scopeRoot(app, named)) throw new HttpError(404, 'Not found');
        const up = '../'.repeat(params.path.split('/').length);
        return void res.writeHead(302, { Location: `${up}${app.auth.fileToken(named)}/${params.path}${url.search}`, 'Cache-Control': 'no-store' }).end();
      }
      const rel = tokenPath(params.path);
      const root = scopeRoot(app, scope);
      if (rel === null || root === null) throw new HttpError(404, 'Not found');
      return serveArtifact(req, res, await resolveFile(rel, root, [root], siblingType), rel, url.searchParams.has('download'));
    },
  },
  {
    method: 'POST', path: '/api/artifacts/:artifact/pin', who: ['person'],
    async handler({ req, res, app, session, artifact: a }) {
      const body = await readJson(req);
      app.store.setArtifactPinned(a.id, body.pinned ? session.name : null);
      app.broadcast({ type: 'artifacts', projectId: a.project_id });
      const updated = app.store.getArtifact(a.id);
      return json(res, 200, updated ? artifactView(app, updated) : null);
    },
  },

  {
    method: ['GET', 'HEAD'], path: '/api/tickets/:ticket/file', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { url, app, ticket } = ctx;
      // A file the ticket linked in its reply: ?path= as written there; ?info for its details.
      const path = url.searchParams.get('path') ?? '';
      if (!url.searchParams.has('info')) return serveFound(ctx, await resolveTicketFile(app, ticket, path), path, ticketScopes(app, ticket));
      const found = await resolveTicketFile(app, ticket, path);
      if (!found) throw new HttpError(404, 'That file is no longer there, or is not one that can be shown');
      const relPath = found.abs.startsWith(ticket.cwd + sep) ? found.abs.slice(ticket.cwd.length + 1) : found.abs;
      const artifact = app.store.findArtifact(ticket.id, [relPath, found.abs]);
      return json(res, 200, {
        path, name: basename(found.abs), display_path: displayPath(app, ticket, found.abs), abs: found.abs,
        kind: found.type.kind, size: found.size, mtime: found.mtime,
        artifact: artifact ? artifactView(app, artifact) : null,
      });
    },
  },
  {
    method: 'GET', path: '/api/tickets/:ticket/images/:name', who: ['person'],
    async handler({ res, app, ticket, params: { name } }) {
      if (!IMAGE_NAME.test(name)) throw new HttpError(404, 'Not found');
      let body: Buffer;
      try {
        body = await readFile(join(uploadsDir(app, ticket), name));
      } catch {
        throw new HttpError(404, 'Not found');
      }
      const type = IMAGE_TYPES.find((t) => name.endsWith(t.ext))!.type;
      // Names are random and never reused, so the browser can keep them.
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(body);
    },
  },
  {
    method: ['GET', 'HEAD'], path: '/api/tickets/:ticket/uploads/:name', who: ['person'],
    async handler({ req, res, app, ticket, params }) {
      let name = '';
      try {
        name = decodeURIComponent(params.name);
      } catch {}
      const found = await findUpload(app, ticket, name);
      if (!found) throw new HttpError(404, 'That file is no longer there');
      // Images and PDFs open in the browser; anything else downloads and is never rendered (see serveArtifact).
      const type = opensInline(name) ? fileType(name)! : { kind: 'download' as const, mime: 'application/octet-stream' };
      return serveArtifact(req, res, { file: found.path, abs: found.path, type, size: found.size, mtime: 0 }, name, false);
    },
  },
];
