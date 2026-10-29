// HTTP plumbing for the API: one error type, JSON in and out, and the checks on what a request sends.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';
// Types only: this module loads nothing of the app's, so any module can import it.
import type { Auth, Session } from './auth.ts';
import type { BranchStatus } from './branch.ts';
import type { Artifact, Machine, Project, Store, Ticket, TicketTag } from './db.ts';
import type { MachineRelay } from './machines.ts';
import type { Previews } from './previews.ts';
import type { Pusher, PushTrigger } from './push.ts';
import type { Runner } from './runner.ts';
import type { Schedule } from './schedules.ts';
import type { Chain, LiveWaiters } from './wake.ts';

/** An answer with a status: what any route or module throws to refuse a request. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const SECURITY_HEADERS = {
  // blob: lets the composer preview pasted images before they are sent.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

// Responses to browsers that accept gzip. Caddy passes bodies through as they are, and a long
// thread's history is megabytes of JSON that gzips about 4x.
export const acceptsGzip = new WeakSet<ServerResponse>();
const MIN_GZIP_BYTES = 1400;

/** Send a whole body, gzipped when the browser accepts it and it is big enough to be worth it. */
export function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
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

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  send(res, status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, JSON.stringify(body));
}

export async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
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

/** A request's URL; a 400 for one that can't be parsed or decoded (`//`, `/%`) rather than a crash. */
export function requestUrl(req: IncomingMessage): URL {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    throw new HttpError(400, 'Bad request');
  }
}

export function clientIp(req: IncomingMessage): string {
  // Caddy appends the real client address, so only the right-most entry is trustworthy.
  const fwd = req.headers['x-forwarded-for'];
  const last = typeof fwd === 'string' ? fwd.split(',').pop()!.trim() : '';
  return last || req.socket.remoteAddress || '?';
}

export function isSecure(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}

/** One of a fixed set of values, or null when empty. */
export function oneOf(v: unknown, allowed: readonly string[], field: string): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

export function buildNumber(v: unknown): number | null {
  if (v === null || v === '') return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 9999) throw new HttpError(400, 'Build must be a whole number from 1 to 9999');
  return v as number;
}

/** One-tap replies: up to 3 short texts, stored as JSON; none (null or []) clears them. */
export function replyList(v: unknown): string | null {
  if (v === null || (Array.isArray(v) && !v.length)) return null;
  if (!Array.isArray(v) || v.length > 3) throw new HttpError(400, 'Replies must be a list of at most 3');
  return JSON.stringify(v.map((r) => str(r, 'Reply', 40)));
}

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
}

// ---------- the route table ----------

/**
 * Who may call a route, besides a signed-in person ('person'): a scheme's Taskmaster, on its own scheme
 * and not on itself except to read ('taskmaster'); a minion, on itself or its own scheme ('minion'); any
 * thread on its own chat, the Taskmaster included ('self').
 */
export type Who = 'person' | 'taskmaster' | 'minion' | 'self';

/** What the routes reach of the running server (built once in server.ts). */
export interface App {
  store: Store;
  runner: Runner;
  auth: Auth;
  waiters: LiveWaiters;
  previews: Previews | null;
  machines: MachineRelay;
  pusher: Pusher;
  /** Open event streams (GET /api/stream). */
  clients: Set<ServerResponse>;
  dataDir: string;
  preview: boolean;
  machinesUrl: URL | null;
  bootCommit: string | null;
  readonly assetVersion: string;
  broadcast(msg: object): void;
  notify(ticketId: number, trigger: PushTrigger, except?: string | null): void;
  newMinion(project: Project, m: { title: string; tag: TicketTag | null; props: Record<string, unknown>; model?: string | null; effort?: string | null }, by: string): Promise<{ id: number; number: number; notes: string[] }>;
  startChained(c: Chain, why: string): Promise<void>;
  ticketBranch(ticketId: number): Promise<BranchStatus | null>;
  sharedFiles(projectId: number): Promise<unknown[]>;
  sharedDir(ticket: Ticket): string;
  registryChanged(projectId: number, global: boolean): void;
}

export type TicketView = ReturnType<Runner['view']>;

/** One request as a route's handler sees it, with the rows its path names already loaded. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  app: App;
  /** Null only on 'anyone' and 'machine' routes. */
  session: Session;
  /** The minion or Taskmaster calling, or null for a person. */
  caller: Ticket | null;
  /** Path parameters as sent (still percent-encoded). */
  params: Record<string, string>;
  ticket: TicketView;
  project: Project;
  schedule: Schedule;
  artifact: Artifact;
  machine: Machine;
}

export interface Route {
  method: string | readonly string[];
  /** Segments, with `:name` for a parameter; :ticket, :project, :schedule, :artifact and :machine load that row. */
  path: string;
  /** 'anyone' needs no login; 'machine' is a machine's agent, which checks its own token. */
  who: readonly Who[] | 'anyone' | 'machine';
  /** The 403 for a caller `who` leaves out (a minion always gets "A minion may only update itself"). */
  refuse?: string;
  handler(ctx: Ctx): unknown;
}

const LOADED = ['ticket', 'project', 'schedule', 'artifact', 'machine'];
const NUMERIC = new Set([...LOADED, 'machineId']);

/** Load a row a path names, onto ctx; returns the scheme it belongs to, if any. */
function load(ctx: Ctx, name: string, id: number): number | undefined {
  const { store, runner } = ctx.app;
  if (name === 'ticket') {
    const t = store.getTicket(id);
    if (!t) throw new HttpError(404, 'No such minion');
    ctx.ticket = runner.view(t);
    return t.project_id;
  }
  if (name === 'project') {
    const p = store.getProject(id);
    if (!p) throw new HttpError(404, 'No such scheme');
    ctx.project = p;
    return p.id;
  }
  if (name === 'schedule') {
    const s = store.schedules.get(id);
    if (!s) throw new HttpError(404, 'No such schedule');
    ctx.schedule = s;
    return s.project_id;
  }
  if (name === 'artifact') {
    const a = store.getArtifact(id);
    if (!a) throw new HttpError(404, 'No such artifact');
    ctx.artifact = a;
    return a.project_id;
  }
  const m = store.getMachine(id);
  if (!m) throw new HttpError(404, 'No such machine');
  ctx.machine = m;
}

/** The 403 for a caller the route's `who` leaves out, or for one reaching past its own scheme or chat. */
function checkWho(route: Route, ctx: Ctx, method: string, project: number | undefined, ticket: number | undefined) {
  const who = route.who as readonly Who[];
  const { caller } = ctx;
  if (!caller) {
    if (!who.includes('person')) throw new HttpError(403, route.refuse ?? 'Not for people');
    return;
  }
  if (who.includes('self') && ticket === caller.id) return;
  if (caller.kind === 'coordinator') {
    if (!who.includes('taskmaster')) throw new HttpError(403, route.refuse ?? 'Not available to the Taskmaster');
    if (project !== undefined && project !== caller.project_id) throw new HttpError(403, 'Outside this Taskmaster\'s scheme');
    if (ticket === caller.id && method !== 'GET') throw new HttpError(403, 'The Taskmaster cannot act on itself');
    return;
  }
  const own = ticket !== undefined ? ticket === caller.id : project === undefined || project === caller.project_id;
  if (!who.includes('minion') || !own) throw new HttpError(403, 'A minion may only update itself');
}

/**
 * The API as one table: match the path and method, check the login and the origin, load the rows the
 * path names (404 when gone), check who may call it, then run its handler.
 */
export function router(routes: Route[]) {
  const table = routes.map((route) => ({
    route,
    methods: typeof route.method === 'string' ? [route.method] : route.method,
    names: route.path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
    re: new RegExp(`^${route.path.split('/').map((s) => (s.startsWith(':') ? (NUMERIC.has(s.slice(1)) ? '(\\d+)' : '([^/]+)') : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`),
  }));
  const dispatch = async (app: App, req: IncomingMessage, res: ServerResponse, url: URL, session: Session | null) => {
    const method = req.method ?? 'GET';
    const onPath = table.filter((r) => r.re.test(url.pathname));
    const hit = onPath.find((r) => r.methods.includes(method));
    const { route } = hit ?? {};
    const ctx = { req, res, url, app, session, caller: null, params: {} } as unknown as Ctx;
    if (hit) hit.re.exec(url.pathname)!.slice(1).forEach((v, i) => (ctx.params[hit.names[i]] = v));
    if (route?.who === 'anyone' || route?.who === 'machine') return route.handler(ctx);
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
    if (!route) throw onPath.length ? new HttpError(405, 'Method not allowed') : new HttpError(404, 'Not found');

    let project: number | undefined;
    for (const name of hit!.names) if (LOADED.includes(name)) project = load(ctx, name, Number(ctx.params[name])) ?? project;
    if (session.agent !== undefined) {
      ctx.caller = app.store.getTicket(session.agent) ?? null;
      if (!ctx.caller) throw new HttpError(403, 'No such minion');
    }
    checkWho(route, ctx, method, project, ctx.ticket?.id);
    return route.handler(ctx);
  };
  // shortcut: while routes move over from server.ts's api(), which paths the table already has.
  return Object.assign(dispatch, { knows: (path: string) => table.some((r) => r.re.test(path)) });
}
