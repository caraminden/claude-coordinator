// Files people see: artifacts minions showed, the scheme's shared folder, a file a reply linked, and
// the images and files people attach to messages.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileType, resolveFile } from '../artifacts.ts';
import type { Artifact, Ticket } from '../db.ts';
import type { MessageFile } from '../runner.ts';
import { isUploadName, MAX_UPLOADS, opensInline } from '../uploads.ts';
import { projectDir, projectSharedDir } from '../workspace.ts';
import { HttpError, json, readJson, SECURITY_HEADERS, type App, type Route } from '../http.ts';

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
    method: 'GET', path: '/api/projects/:project/artifacts', who: ['person'],
    handler: ({ res, app, project }) => json(res, 200, app.store.listArtifacts(project.id).map((a) => artifactView(app, a))),
  },
  { method: 'GET', path: '/api/projects/:project/shared', who: ['person'], handler: async ({ res, app, project }) => json(res, 200, await app.sharedFiles(project.id)) },
  {
    method: ['GET', 'HEAD'], path: '/api/projects/:project/shared/file', who: ['person'],
    async handler({ req, res, url, app, project }) {
      // One file of the folder, by path relative to it (or ?info for its details).
      const dir = projectSharedDir(app.dataDir, project.id);
      const path = url.searchParams.get('path') ?? '';
      const found = await resolveFile(path, dir, [dir]);
      if (!found) throw new HttpError(404, 'That file is no longer there, or is not one that can be shown');
      if (!url.searchParams.has('info')) return serveArtifact(req, res, found, path, url.searchParams.has('download'));
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
    handler: async ({ req, res, url, app, artifact: a }) =>
      serveArtifact(req, res, await resolveTicketFile(app, app.store.getTicket(a.ticket_id)!, a.path), a.path, url.searchParams.has('download')),
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
    async handler({ req, res, url, app, ticket }) {
      // A file the ticket linked in its reply: ?path= as written there; ?info for its details.
      const path = url.searchParams.get('path') ?? '';
      if (!url.searchParams.has('info')) return serveArtifact(req, res, await resolveTicketFile(app, ticket, path), path, url.searchParams.has('download'));
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
