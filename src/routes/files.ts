// Files people see: artifacts minions showed, the scheme's shared folder, a file a reply linked, and
// the images and files people attach to messages.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { cleanEntries, entriesView, injectBridge, LIMITS, storeId, writeStore } from '../artifact-data.ts';
import { DocPreviews } from '../doc-preview.ts';
import { commentMessage, fileTitle, fileType, isArtifact, resolveFile, resolveLink, sharedListable, siblingType } from '../artifacts.ts';
import type { Session } from '../auth.ts';
import type { Artifact, Project, Ticket } from '../db.ts';
import type { MessageFile } from '../runner.ts';
import { place } from '../chunked-uploads.ts';
import { isUploadName, MAX_UPLOAD_BYTES, MAX_UPLOADS, opensInline, saveUpload, uploadFolder } from '../uploads.ts';
import { projectDir, projectSharedDir } from '../workspace.ts';
import { HttpError, json, readJson, SECURITY_HEADERS, str, type App, type Route, type SharedFile } from '../http.ts';
import { imageSize } from '../image-size.ts';
import { MAX_LABEL, MAX_MARKS, marksTitle, parseMarks } from '../../public/ui/marks.js';

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
  // origin with no cookies or API access. HTML may still run its own scripts (canvases, demos). A
  // link it opens in a new tab leaves the sandbox, or a site like a cloud console couldn't sign in (#440).
  if (kind === 'html') return "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; frame-ancestors 'self'";
  // Chrome's PDF viewer refuses to load in a sandbox; PDFs can't script the page anyway.
  if (kind === 'pdf') return "frame-ancestors 'self'";
  return "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
}

/** A path as people should see it: relative to the working directory, or under "shared files". */
export function displayPath(app: App, ticket: Ticket, path: string): string {
  const projectShared = projectSharedDir(app.dataDir, ticket.project_id) + sep;
  if (path.startsWith(projectShared)) return `scheme shared/${path.slice(projectShared.length)}`;
  const shared = app.sharedDir(ticket) + sep;
  if (path.startsWith(shared)) return `shared files/${path.slice(shared.length)}`;
  if (ticket.cwd && path.startsWith(ticket.cwd + sep)) return path.slice(ticket.cwd.length + 1);
  // Another minion's shared folder (a file it made, shown under this one): still never the server's absolute path.
  const other = /\/shared\/(\d+)\/(.+)$/.exec(path);
  if (other) return `shared files/${other[2]}`;
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

/**
 * The path, relative to scheme `projectId`'s shared folder, that `abs` names there, or null if it is
 * outside it. Pinning needs a file the Shared list shows; unpinning also takes a pinned path whose
 * file is gone.
 */
async function sharedPinPath(app: App, projectId: number, abs: string, pinning: boolean): Promise<string | null> {
  const dir = projectSharedDir(app.dataDir, projectId);
  if (!abs.startsWith(dir + sep)) return null;
  const rel = abs.slice(dir.length + 1).split(sep).join('/');
  if (!pinning && app.store.sharedPins(projectId).some((p) => p.path === rel)) return rel;
  const found = sharedListable(rel) ? await resolveFile(rel, dir, [dir]) : null;
  // The scan skips symlinks, so the path must be the file itself.
  if (!found || found.file !== join(await realpath(dir), rel)) throw new HttpError(404, `No file at scheme shared/${rel} that the Shared list shows`);
  return rel;
}

/** Pin or unpin a shared-folder file; `already` when pinning one already pinned, which keeps who pinned it first. */
async function pinShared(app: App, projectId: number, rel: string, by: string | null) {
  const already = !!by && app.store.sharedPins(projectId).some((p) => p.path === rel);
  app.store.setSharedPin(projectId, rel, by);
  app.broadcast({ type: 'artifacts', projectId });
  const file = (await app.sharedFiles(projectId)).find((f) => f.path === rel);
  return { file, already };
}

/** Each folder on the way must be a real folder (or not there yet), not a link that leads out of the shared folder. */
async function realFolders(root: string, folder: string[]) {
  for (let i = 1; i <= folder.length; i++) {
    const st = await lstat(join(root, ...folder.slice(0, i))).catch(() => null);
    if (!st) break;
    if (!st.isDirectory()) throw new HttpError(400, `${folder.slice(0, i).join('/')} is not a folder`);
  }
}

/** Who a chunked upload belongs to: a person with a user id (sessions from the shared-password days have none). */
export function uploader(session: Session) {
  if (session.uid === undefined) throw new HttpError(403, 'Sign in again to upload');
  return { uid: session.uid, login: session.name };
}

/** A shared-folder file for an agent: marked as Shared, with its absolute path. */
const sharedView = (app: App, projectId: number, f: SharedFile) => ({ ...f, shared: true, abs: join(projectSharedDir(app.dataDir, projectId), f.path) });

// Bigger pages are served as they are, without the bridge.
const MAX_BRIDGED_BYTES = 20 * 1024 * 1024;

/**
 * Serve a file found by resolveFile, with byte ranges and a sandboxing CSP. An HTML page given `bridge`
 * (scheme `projectId`, served at token path `page`) gets the artifact bridge and what it saved inlined.
 */
async function serveArtifact(req: IncomingMessage, res: ServerResponse, found: Awaited<ReturnType<typeof resolveFile>>, path: string, download: boolean, app?: App, bridge?: { projectId: number; page: string }) {
  if (!found) throw new HttpError(404, 'That file is no longer there');
  const { file, type } = found;
  let { size } = found;
  let body: Buffer | null = null;
  if (bridge && app && type.kind === 'html' && !download && size <= MAX_BRIDGED_BYTES) {
    body = injectBridge(await readFile(file), { page: bridge.page, entries: entriesView(app.store.artifactData(bridge.projectId, file)) });
    size = body.length;
  }
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
  if (body) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
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
  const tokened = found?.type.kind === 'html' && !download && session.agent === undefined ? await tokenedPath(app, found.file, roots) : null;
  // Relative, so it stays inside a preview's /preview/N/.
  if (tokened) return void res.writeHead(302, { Location: `${'../'.repeat(url.pathname.split('/').length - 3)}files/${tokened}`, 'Cache-Control': 'no-store' }).end();
  return serveArtifact(req, res, found, path, download);
}

/** `<file token>/<path>` of a file under one of `roots`, as /api/files/ serves it; null under a hidden folder (it opens without its siblings). */
async function tokenedPath(app: App, file: string, roots: [string, string][]): Promise<string | null> {
  for (const [scope, root] of roots) {
    const real = await realpath(root).catch(() => null);
    if (!real || !file.startsWith(real + sep)) continue;
    const rel = file.slice(real.length + 1).split(sep).map(encodeURIComponent).join('/');
    return tokenPath(rel) === null ? null : `${app.auth.fileToken(scope)}/${rel}`;
  }
  return null;
}

const docPreviews = new Map<string, DocPreviews>();

/** The scheme a file token's scope belongs to. */
function scopeProject(app: App, scope: string): number | null {
  const t = /^t(\d+)-[012]$/.exec(scope);
  if (t) return app.store.getTicket(Number(t[1]))?.project_id ?? null;
  const p = /^p(\d+)$/.exec(scope);
  return p ? Number(p[1]) : null;
}

/**
 * The real file of the page a frame shows, from the token path the bridge was served with. An expired
 * token still names its file (the signature is what counts here, not access), so a page left open keeps saving.
 */
async function bridgedPage(app: App, page: unknown): Promise<string | null> {
  if (typeof page !== 'string' || page.length > 4000) return null;
  const slash = page.indexOf('/');
  const scope = slash > 0 ? app.auth.fileScope(page.slice(0, slash), 0) : null;
  const root = scope && scopeRoot(app, scope);
  const rel = root && tokenPath(page.slice(slash + 1));
  const found = rel ? await resolveFile(rel, root!, [root!], siblingType) : null;
  return found?.type.kind === 'html' ? found.file : null;
}

/** The HTML file a person's viewer opened, as it says it did: an artifact, a file a minion linked, or a shared file. */
async function openedPage(app: App, open: any): Promise<{ project: Project; file: string; abs: string; name: string; ticket: Ticket | null }> {
  let found: Awaited<ReturnType<typeof resolveFile>> = null;
  let projectId = 0;
  // The chat the viewer opened it from: the artifact's minion, or the chat that linked the file.
  let ticket: Ticket | null = null;
  if (Number.isInteger(open?.artifact)) {
    const a = app.store.getArtifact(open.artifact);
    ticket = (a && app.store.getTicket(a.ticket_id)) ?? null;
    if (ticket) [found, projectId] = [await resolveTicketFile(app, ticket, a!.path), ticket.project_id];
  } else if (Number.isInteger(open?.ticket) && typeof open.path === 'string') {
    ticket = app.store.getTicket(open.ticket) ?? null;
    if (ticket) [found, projectId] = [await resolveTicketFile(app, ticket, open.path), ticket.project_id];
  } else if (Number.isInteger(open?.project) && typeof open.path === 'string' && !isAbsolute(open.path)) {
    const dir = projectSharedDir(app.dataDir, open.project);
    if (app.store.getProject(open.project)) [found, projectId] = [await resolveFile(open.path, dir, [dir]), open.project];
  }
  const project = projectId ? app.store.getProject(projectId) : undefined;
  if (!found || !project || found.type.kind !== 'html') throw new HttpError(404, 'That page is no longer there');
  return { project, file: found.file, abs: found.abs, name: basename(found.abs), ticket };
}

/**
 * The HTML page an agent names for artifact_data: an artifact id, or a path (absolute, relative to its
 * working directory, or "scheme shared/…") inside a folder of its scheme.
 */
async function agentPage(app: App, project: Project, caller: Ticket, body: any): Promise<string> {
  let found: Awaited<ReturnType<typeof resolveFile>> = null;
  const shared = projectSharedDir(app.dataDir, project.id);
  if (body.artifact != null) {
    const a = findPinTarget(app, project.id, caller, body.artifact, null);
    found = await resolveTicketFile(app, app.store.getTicket(a.ticket_id)!, a.path);
  } else {
    if (typeof body.path !== 'string' || !body.path.trim() || body.path.includes('\0')) throw new HttpError(400, 'Give the artifact (its id) or the page\'s path');
    const p = body.path.trim();
    const abs = p.startsWith('scheme shared/') ? join(shared, p.slice('scheme shared/'.length)) : isAbsolute(p) ? normalize(p) : caller.cwd ? join(caller.cwd, p) : '';
    const roots = [shared, ...app.store.listTickets(project.id).flatMap((t) => (t.cwd ? ticketRoots(app, t) : []))];
    found = abs ? await resolveFile(abs, '/', roots) : null;
  }
  if (!found || found.type.kind !== 'html') throw new HttpError(404, 'No HTML page there in this scheme; list_artifacts shows them');
  return found.file;
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

/**
 * mark_image (#960): the markdown line that shows `image` in a reply with marks drawn over it (public/ui/marks.js). The
 * picture is one pasted in this chat (copied into the minion's files folder, so it shows like any file it links) or an
 * image in its folders; marks are { kind, at, to, n, text, colour } in percent of the picture from its top left.
 */
export async function markImage(app: App, ticket: Ticket, body: any): Promise<{ markdown: string; path: string; w: number; h: number }> {
  const image = str(body.image, 'image', 2000);
  const alt = body.alt == null ? 'Marked picture' : str(body.alt, 'alt', 200);
  if (/[[\]\n]/.test(alt)) throw new HttpError(400, 'alt must be one line with no square brackets');
  let path: string;
  const uploads = uploadsDir(app, ticket);
  if (isAbsolute(image) && normalize(join(image, '..')) === uploads && IMAGE_NAME.test(basename(image))) {
    const src = join(uploads, basename(image));
    const dir = app.sharedDir(ticket);
    path = join(dir, basename(image));
    await mkdir(dir, { recursive: true });
    await copyFile(src, path).catch((e) => { throw e?.code === 'ENOENT' ? new HttpError(404, `No pasted picture ${basename(image)} in this chat`) : e; });
  } else {
    const found = await resolveTicketFile(app, ticket, image);
    if (!found || found.type.kind !== 'image') throw new HttpError(400, 'image must be a picture pasted in this chat (its path from the turn) or a PNG, JPEG, GIF or WebP file in your working directory, files folder or shared folder');
    path = found.abs;
  }
  if (/[\s()"<>]/.test(path)) throw new HttpError(400, `The picture's path has a space, bracket or quote, which a markdown link can't hold: copy it to a plain name first (${path})`);
  const size = imageSize(await readFile(path));
  if (!size) throw new HttpError(400, 'mark_image draws on PNG, JPEG, GIF or WebP pictures');
  const { w, h } = size;
  const raw = body.marks;
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'marks must be a list of at least one mark');
  if (raw.length > MAX_MARKS) throw new HttpError(400, `At most ${MAX_MARKS} marks on one picture`);
  const point = (v: unknown, what: string) => {
    if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new HttpError(400, `${what} must be [x, y] in percent`);
    if (v.some((n) => n < 0 || n > 100)) throw new HttpError(400, `${what} is off the picture: x and y are percent of its width and height, 0 to 100 (it is ${w}x${h})`);
    return { x: (v[0] * w) / 100, y: (v[1] * h) / 100 };
  };
  let pins = 0;
  const marks = raw.map((m: any, i: number) => {
    const what = `Mark ${i + 1}`;
    const kind = m?.kind;
    if (!['box', 'arrow', 'pin', 'label'].includes(kind)) throw new HttpError(400, `${what}: kind must be box, arrow, pin or label`);
    const colour = m.colour ?? 'red';
    if (colour !== 'red' && colour !== 'yellow') throw new HttpError(400, `${what}: colour must be red or yellow`);
    const pts = [point(m.at, `${what}'s at`)];
    if (kind === 'box' || kind === 'arrow') pts.push(point(m.to, `${what}'s to`));
    const mark: any = { tool: kind, colour, pts };
    if (kind === 'pin') {
      mark.n = m.n ?? ++pins;
      if (!Number.isInteger(mark.n) || mark.n < 0 || mark.n > 99) throw new HttpError(400, `${what}: n must be a whole number 0 to 99`);
    }
    if (kind === 'label') {
      const text = typeof m.text === 'string' ? m.text.trim().replace(/\s+/g, ' ') : '';
      if (!text || text.length > MAX_LABEL || /[;"]/.test(text)) throw new HttpError(400, `${what}: text must be 1 to ${MAX_LABEL} characters with no ; or "`);
      mark.text = text;
    }
    return mark;
  });
  const title = marksTitle(w, h, marks);
  if (parseMarks(title)?.marks.length !== marks.length) throw new HttpError(500, 'The marks did not read back; nothing was drawn');
  return { markdown: `![${alt}](${path} "${title}")`, path, w, h };
}

export const fileRoutes: Route[] = [
  {
    method: 'POST', path: '/api/tickets/:ticket/mark-image', who: ['minion'],
    async handler({ req, res, app, ticket }) {
      return json(res, 200, await markImage(app, ticket, await readJson(req)));
    },
  },
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
      const by = `${caller!.kind === 'coordinator' ? 'Taskmaster' : `#${caller!.number}`} for ${asker}`;
      // A file of the shared folder, by path: absolute, relative to the caller's folder, or as list_artifacts shows it.
      if (body.artifact == null && typeof body.path === 'string' && !body.path.includes('\0')) {
        const p = body.path.trim();
        const abs = p.startsWith('scheme shared/') ? join(projectSharedDir(app.dataDir, project.id), p.slice('scheme shared/'.length))
          : isAbsolute(p) ? normalize(p) : caller!.cwd ? join(caller!.cwd, p) : '';
        const rel = await sharedPinPath(app, project.id, abs, !!body.pinned);
        if (rel !== null) {
          const { file, already } = await pinShared(app, project.id, rel, body.pinned ? by : null);
          return json(res, 200, { artifact: file ? sharedView(app, project.id, file) : null, removed: !file, already });
        }
      }
      const a = findPinTarget(app, project.id, caller!, body.artifact, body.path);
      // Pinning one already pinned keeps who pinned it first.
      const already = !!body.pinned && a.pinned_at !== null;
      if (!already) app.store.setArtifactPinned(a.id, body.pinned ? by : null);
      app.broadcast({ type: 'artifacts', projectId: project.id });
      const updated = app.store.getArtifact(a.id);
      return json(res, 200, { artifact: updated ? artifactView(app, updated) : null, removed: !updated, already });
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/shared', who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, project }) {
      const files = await app.sharedFiles(project.id);
      // ?titles, for agents: each document's own title, and its absolute path. Only documents and pages, as
      // before #676: a folder of game snaps would bury list_artifacts.
      if (!url.searchParams.has('titles')) return json(res, 200, files);
      return json(res, 200, await Promise.all(files.filter((f) => isArtifact(f.path)).map(async (f) => {
        const v = sharedView(app, project.id, f);
        return { ...v, title: f.missing ? null : await fileTitle(v.abs) };
      })));
    },
  },
  {
    // A person drops files into the shared folder (#676), one request a file, the bytes kept as sent. `folder` is
    // relative to the shared folder (default inbox), made if missing; a name already there gets " (2)".
    method: 'PUT', path: '/api/projects/:project/shared/upload', who: ['person'], refuse: 'Only people upload to the shared folder',
    async handler({ req, res, url, app, project }) {
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files must be under 200 MB');
      const root = projectSharedDir(app.dataDir, project.id);
      const folder = uploadFolder(url.searchParams.get('folder') ?? 'inbox');
      await realFolders(root, folder);
      const saved = await saveUpload(join(root, ...folder), url.searchParams.get('name') ?? '', req);
      app.broadcast({ type: 'artifacts', projectId: project.id });
      const path = [...folder, saved.name].join('/');
      return json(res, 201, { path, name: saved.name, size: saved.size, mtime: Math.round((await stat(saved.path)).mtimeMs) });
    },
  },
  {
    // A big file into the shared folder in chunks, resumable (#832, src/chunked-uploads.ts): { name, size, folder }
    // starts one, folder as the PUT above (default inbox). public/ui/upload.js is the client.
    method: 'POST', path: '/api/projects/:project/shared/uploads', who: ['person'], refuse: 'Only people upload to the shared folder',
    async handler({ req, res, app, project, session }) {
      const body = (await readJson(req, 16 * 1024)) ?? {};
      const folder = typeof body.folder === 'string' ? body.folder : 'inbox';
      await realFolders(projectSharedDir(app.dataDir, project.id), uploadFolder(folder));
      return json(res, 201, await app.chunked.start(uploader(session), { kind: 'shared', project: project.id }, { ...body, folder }));
    },
  },
  {
    // Where an upload got to (GET), its next chunk at ?offset= (PUT; the last one answers with the file, as the PUT
    // above does), or give it up (DELETE).
    method: ['GET', 'PUT', 'DELETE'], path: '/api/projects/:project/shared/uploads/:upload', who: ['person'], refuse: 'Only people upload to the shared folder',
    async handler({ req, res, url, app, project, session, params }) {
      const who = uploader(session);
      const target = { kind: 'shared', project: project.id } as const;
      if (req.method === 'GET') return json(res, 200, await app.chunked.status(who, target, params.upload));
      if (req.method === 'DELETE') {
        await app.chunked.cancel(who, target, params.upload);
        return void res.writeHead(204).end();
      }
      const offset = Number(url.searchParams.get('offset') ?? NaN);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be the byte the chunk starts at');
      const root = projectSharedDir(app.dataDir, project.id);
      return json(res, 200, await app.chunked.put(who, target, params.upload, offset, req, async (meta, part) => {
        await realFolders(root, meta.folder);
        const saved = await place(part, join(root, ...meta.folder), meta.name);
        app.broadcast({ type: 'artifacts', projectId: project.id });
        return { path: [...meta.folder, basename(saved)].join('/'), name: basename(saved), size: meta.size, mtime: Math.round((await stat(saved)).mtimeMs) };
      }));
    },
  },
  {
    method: 'POST', path: '/api/projects/:project/shared/pin', who: ['person'],
    async handler({ req, res, app, project, session }) {
      const body = await readJson(req);
      const path = str(body.path, 'path', 1000);
      if (path.includes('\0') || isAbsolute(path)) throw new HttpError(400, 'path is relative to the shared folder');
      const abs = join(projectSharedDir(app.dataDir, project.id), path);
      const rel = await sharedPinPath(app, project.id, abs, !!body.pinned);
      if (rel === null) throw new HttpError(400, 'That path is outside the shared folder');
      const { file } = await pinShared(app, project.id, rel, body.pinned ? session.name : null);
      return json(res, 200, { file: file ?? null });
    },
  },
  {
    method: ['GET', 'HEAD'], path: '/api/projects/:project/shared/file', who: ['person'],
    async handler(ctx) {
      const { res, url, app, project } = ctx;
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
      const projectId = scopeProject(app, scope)!;
      return serveArtifact(req, res, await resolveFile(rel, root, [root], siblingType), rel, url.searchParams.has('download'), app, { projectId, page: `${params.token}/${params.path}` });
    },
  },
  {
    // The artifact bridge (#168): a person's viewer, for the page in its frame, lists or writes the page's
    // store. `open` is what the viewer opened and `page` the token path the page in the frame was served
    // under; both must be the same file, so a frame that has moved on to another page can't write here.
    method: 'POST', path: '/api/artifact-data', who: ['person'],
    async handler({ req, res, app, session }) {
      const body = await readJson(req, 4 * 1024 * 1024);
      const { project, file } = await openedPage(app, body.open);
      if (!app.store.canSee(session, project.id)) throw new HttpError(404, 'That page is no longer there');
      if (await bridgedPage(app, body.page) !== file) throw new HttpError(409, 'The frame shows a different page from the one this viewer opened; reopen it');
      if (body.op === 'write') {
        writeStore(app.store, project.id, file, cleanEntries(body.entries), session.name);
        app.broadcast({ type: 'artifact-data', projectId: project.id, store: storeId(project.id, file) });
      } else if (body.op !== 'list') throw new HttpError(400, 'op is list or write');
      return json(res, 200, { store: storeId(project.id, file), entries: entriesView(app.store.artifactData(project.id, file)), person: session.name });
    },
  },
  {
    // A page's Send (#417): the person's viewer posts the page's answer as them, straight into the chat of
    // the minion that showed the page, which wakes it. For a shared-folder page that's the minion that last
    // linked it, else the Taskmaster.
    method: 'POST', path: '/api/artifact-send', who: ['person'],
    async handler({ req, res, app, session }) {
      // Up to 6 marked pictures in base64 (#946), as the chat's message route allows.
      const body = await readJson(req, 45_000_000);
      const { project, file, abs, ticket } = await openedPage(app, body.open);
      if (!app.store.canSee(session, project.id)) throw new HttpError(404, 'That page is no longer there');
      if (await bridgedPage(app, body.page) !== file) throw new HttpError(409, 'The frame shows a different page from the one this viewer opened; reopen it');
      const linker = ticket ? null : app.store.latestArtifact(project.id, [abs, file]);
      const to = ticket ?? (linker && app.store.getTicket(linker.ticket_id)) ?? app.store.coordinatorFor(project.id, session.uid ?? null);
      if (!to) throw new HttpError(404, 'No minion or Taskmaster to send this to');
      const { about, text } = commentMessage(to.cwd && abs.startsWith(to.cwd + sep) ? abs.slice(to.cwd.length + 1) : abs, str(body.text, 'Answer', 10_000));
      app.runner.send(to.id, session.name, text, await saveImages(app, to, body.images), { comment: { path: abs, about }, hold: true });
      // The picks answer the chat's choices cards for this page (#804).
      let answered = false;
      for (const e of app.store.eventsOfKinds(to.id, ['question'])) {
        const q = JSON.parse(e.data);
        if (q.doc?.path !== abs || q.settled) continue;
        const settled = { at: Date.now(), by: session.name, sent: true };
        app.store.setEventData(e.id, { ...q, settled });
        app.runner.emit(to.id, 'question_result', { id: q.id, settled });
        answered = true;
      }
      if (answered) app.runner.broadcastTicket(to.id);
      app.runner.personWrote(to.id);
      // As in the chat: writing to the Taskmaster continues the loop guard for every minion of the scheme.
      for (const t of to.kind === 'coordinator' ? app.store.listTickets(project.id) : [to]) app.runner.continueLoop(t.id, session.name);
      return json(res, 202, { to: { id: to.id, kind: to.kind, number: to.number, label: to.kind === 'coordinator' ? 'the Taskmaster' : `#${to.number ?? to.id}` } });
    },
  },
  {
    // artifact_data: an agent reads, or sets and deletes keys of, what an HTML page of its scheme saved.
    method: 'POST', path: '/api/projects/:project/artifact-data', who: ['taskmaster', 'minion'],
    async handler({ req, res, app, project, caller }) {
      const body = await readJson(req, 4 * 1024 * 1024);
      const file = await agentPage(app, project, caller!, body);
      if (body.entries != null) {
        writeStore(app.store, project.id, file, cleanEntries(body.entries), caller!.kind === 'coordinator' ? 'Taskmaster' : `#${caller!.number}`);
        app.broadcast({ type: 'artifact-data', projectId: project.id, store: storeId(project.id, file) });
      }
      return json(res, 200, { file, entries: entriesView(app.store.artifactData(project.id, file)), limits: LIMITS });
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
    method: 'GET', path: '/api/tickets/:ticket/doc-preview', who: ['person'],
    async handler(ctx) {
      // A choices card's picture of its page's top (#821, src/doc-preview.ts); 404 when there is none,
      // and the card shows just its Open button.
      const { req, res, url, app, ticket } = ctx;
      const found = await resolveTicketFile(app, ticket, url.searchParams.get('path') ?? '');
      if (found?.type.kind !== 'html') throw new HttpError(404, 'No such page');
      const tokened = await tokenedPath(app, found.file, ticketScopes(app, ticket));
      if (!tokened) throw new HttpError(404, 'That page has no preview');
      const key = DocPreviews.key(found.file, found.size, found.mtime);
      if (req.headers['if-none-match'] === `"${key}"`) return void res.writeHead(304).end();
      let previews = docPreviews.get(app.dataDir);
      if (!previews) docPreviews.set(app.dataDir, (previews = new DocPreviews(join(app.dataDir, 'doc-previews'))));
      // The server opens the page on itself, at the address this request came in on.
      const { localAddress = '127.0.0.1', localPort } = req.socket;
      const img = await previews.get(key, () => `http://${localAddress.includes(':') ? `[${localAddress}]` : localAddress}:${localPort}/api/files/${tokened}`);
      if (!img) throw new HttpError(404, 'That page could not be shot');
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/jpeg', 'Content-Length': img.length, 'Cache-Control': 'private, no-cache', ETag: `"${key}"` });
      res.end(img);
    },
  },
  {
    method: ['GET', 'HEAD'], path: '/api/tickets/:ticket/file', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, url, app, ticket } = ctx;
      // A file the ticket linked in its reply: ?path= as written there; ?info for its details. With &fix,
      // the chat checking a link it shows: one with the wrong folders gets the one file of its name (#281).
      const path = url.searchParams.get('path') ?? '';
      if (!url.searchParams.has('info')) return serveFound(ctx, await resolveTicketFile(app, ticket, path), path, ticketScopes(app, ticket));
      const found = url.searchParams.has('fix') ? await resolveLink(path, ticket.cwd, ticketRoots(app, ticket)) : await resolveTicketFile(app, ticket, path);
      if (!found) throw new HttpError(404, 'That file is no longer there, or is not one that can be shown');
      const relPath = found.abs.startsWith(ticket.cwd + sep) ? found.abs.slice(ticket.cwd.length + 1) : found.abs;
      const artifact = app.store.findArtifact(ticket.id, [relPath, found.abs]);
      return json(res, 200, {
        path, name: basename(found.abs), display_path: displayPath(app, ticket, found.abs), abs: found.abs,
        kind: found.type.kind, size: found.size, mtime: found.mtime, fixed: 'fixed' in found,
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
