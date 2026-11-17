// HTTP plumbing for the API: one error type, JSON in and out, and the checks on what a request sends.
import type { Presence } from './presence.ts';
import type { ClaudeLink } from './claude-link.ts';
import type { CodexLink } from './codex-link.ts';
import type { Contraptions } from './contraptions.ts';
import type { AppServices } from './app-services.ts';
import type { ContraptionTurns } from './contraption-turns.ts';
import type { ErrorDigest } from './contraption-errors.ts';
import type { Landings } from './land.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';
// Types only: this module loads nothing of the app's, so any module can import it.
import type { Auth, Session } from './auth.ts';
import type { BranchStatus } from './branch.ts';
import type { Builds } from './builds.ts';
import type { Artifact, ContraptionRow, Machine, Project, Store, Ticket } from './db.ts';
import type { MachineRelay } from './machines.ts';
import type { MachineJobs } from './machine-jobs.ts';
import type { GithubLink } from './github-link.ts';
import type { OpenRouter } from './openrouter.ts';
import type { OutsideSpend } from './outside-spend.ts';
import type { Secrets } from './secrets.ts';
import type { RepoAccess } from './repo-access.ts';
import type { CiLoad } from './ci-load.ts';
import type { RunnerJobs, RunnerTokens } from './ci-runner.ts';
import type { ChunkedUploads } from './chunked-uploads.ts';
import type { CiStore } from './ci-store.ts';
import type { Previews } from './previews.ts';
import type { Releases } from './releases.ts';
import type { AutoDeploy } from './auto-deploy.ts';
import type { Pusher, PushTrigger } from './push.ts';
import type { Runner } from './runner.ts';
import type { Schedule } from './schedules.ts';
import type { Embed } from './memory.ts';
import type { UltraReviews } from './ultrareview.ts';
import type { Chain, LiveWaiters, TimedWakes } from './wake.ts';
import type { ClientErrors, DeployWatch } from './deploy-watch.ts';

/** An answer with a status: what any route or module throws to refuse a request. */
export class HttpError extends Error {
  status: number;
  /** A 5xx the server gives on purpose about something outside it (a lent machine that's offline): not a server fault, so the deploy watch doesn't count it. */
  expected: boolean;

  constructor(status: number, message: string, expected = false) {
    super(message);
    this.status = status;
    this.expected = expected;
  }
}

export const SECURITY_HEADERS = {
  // blob: lets the composer preview pasted images before they are sent. frame-ancestors 'self': a
  // contraption's installed window shows Citadel's page in a frame over its own (rail.js, #311).
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** With APPS_DOMAIN (src/apps.ts): Citadel's pages frame contraptions on their own hosts, and a contraption's installed window frames Citadel's. */
export function framedWithApps(domain: string) {
  SECURITY_HEADERS['Content-Security-Policy'] = SECURITY_HEADERS['Content-Security-Policy'].replace("frame-ancestors 'self'", `frame-src 'self' *.${domain}; frame-ancestors 'self' *.${domain}`);
}

// Responses to browsers that accept gzip. Caddy passes bodies through as they are, and a long
// thread's history is megabytes of JSON that gzips about 4x.
export const acceptsGzip = new WeakSet<ServerResponse>();
const MIN_GZIP_BYTES = 1400;

/** Set by the DB write worker (src/db-writer.ts): waits a moment for queued writes, so a response comes after its request's writes (#795). */
export const writes = { settle: null as (() => void) | null };

/** Send a whole body, gzipped when the browser accepts it and it is big enough to be worth it. */
export function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
  writes.settle?.();
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
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  // Every route reads fields off it: `null` would be a TypeError there, answered as a 500.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body;
}

/**
 * Citadel's own pages live under /c/ (manifest scope and start_url), so its installed app doesn't claim
 * /apps/ and each contraption installs as its own app (#270: browsers won't install an app inside an
 * installed one's scope). For a raw request URL: `{ redirect }` from the old root "/" (relative, so a
 * preview's copy stays under its /preview/N/; browsers keep the #route), `{ url }` with the /c taken off
 * for anything under /c/, so the front end's relative URLs (api/, app.js) reach the same routes; else null.
 * A share from the phone's Share sheet (the manifest's share_target, #375) goes to the front end's #/share.
 */
export function ownPath(url: string): { redirect: string } | { url: string } | null {
  const root = /^\/c?(\?.*)?$/.exec(url);
  if (root) return { redirect: `c/${root[1] ?? ''}` };
  const share = /^\/c\/share(\?.*)?$/.exec(url);
  if (share) {
    // Re-encoded, so the Location header is plain ASCII whatever the share sent.
    const q = new URLSearchParams(share[1] ?? '').toString();
    return { redirect: `./#/share${q ? `?${q}` : ''}` };
  }
  if (url.startsWith('/c/') && !/^\/c\/(apps|preview)\//.test(url)) return { url: url.slice(2) };
  return null;
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

/** A minion's Workflow switch (#359) as stored: true is 1; false, null or "" is 0. A Taskmaster never gets it. */
export function workflowSwitch(v: unknown, ticket?: { kind: string }): number {
  if (v === null || v === '' || v === false) return 0;
  if (v !== true) throw new HttpError(400, 'Workflow must be true or false');
  if (ticket?.kind === 'coordinator') throw new HttpError(400, 'Only minions can use the Workflow tool');
  return 1;
}

/** One-tap replies: up to 3 short texts, stored as JSON; none (null or []) clears them. */
export function replyList(v: unknown): string | null {
  if (v === null || (Array.isArray(v) && !v.length)) return null;
  if (!Array.isArray(v) || v.length > 3) throw new HttpError(400, 'Replies must be a list of at most 3');
  return JSON.stringify(v.map((r) => str(r, 'Reply', 40)));
}

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long: ${v.length.toLocaleString('en')} characters, at most ${max.toLocaleString('en')}`);
  return v.trim();
}

// ---------- the route table ----------

/**
 * Who may call a route, besides a signed-in person ('person'): a scheme's Taskmaster, on its own scheme
 * and not on itself except to read ('taskmaster'); a minion, on itself or its own scheme ('minion'); any
 * thread on its own chat, the Taskmaster included ('self').
 */
export type Who = 'person' | 'taskmaster' | 'minion' | 'self';

/** A file in a scheme's shared folder, as the Shared list shows it; `path` is relative to the folder. */
export interface SharedFile {
  path: string;
  name: string;
  kind: string;
  display_path: string;
  size: number;
  mtime: number;
  pinned_at: number | null;
  pinned_by: string | null;
  missing: number;
}

/** What the routes reach of the running server (built once in server.ts). */
export interface App {
  store: Store;
  runner: Runner;
  auth: Auth;
  waiters: LiveWaiters;
  /** wake_at's timed wakes (#722). */
  timedWakes: TimedWakes;
  /** The post-deploy watch and the beacon's limits (src/deploy-watch.ts, #724); absent in tests that build no server. */
  health?: { watch: DeployWatch | null; clientErrors: ClientErrors };
  previews: Previews | null;
  /** The release monitor's data: each scheme's targets and test copies (src/releases.ts, #625). */
  releases: Releases;
  /** Auto-deploy and the release cards' Deploy button (src/auto-deploy.ts, #629). */
  autoDeploy: AutoDeploy;
  machines: MachineRelay;
  /** Jobs on people's own machines (src/machine-jobs.ts, #857). */
  jobs: MachineJobs;
  pusher: Pusher;
  /** People's own GitHub links (src/github-link.ts). */
  github: GithubLink;
  /** Scheme members' collaborator invites on the scheme's GitHub repo (src/repo-access.ts, #310). */
  repoAccess: RepoAccess;
  /** CI runner registration tokens, minted with a scheme owner's GitHub login (src/ci-runner.ts, #320). */
  runnerTokens: RunnerTokens;
  /** The CI desktop's load: the runner agents' samples, each PC's view and verdict (src/ci-load.ts, #534). */
  ciLoad: CiLoad;
  /** Big uploads in chunks, for the shared folder and contraptions (src/chunked-uploads.ts, #832). */
  chunked: ChunkedUploads;
  /** CI output the schemes' runners upload, kept per scheme and swept by rule (src/ci-store.ts, #658). */
  ciStore: CiStore;
  /** Jobs for the CI runner agent on Cara's desktop: add, list, remove a scheme's runners (src/ci-runner.ts, #328). */
  runnerJobs: RunnerJobs;
  /** People's own Claude plans, in a container each (src/claude-link.ts, #213). */
  claude: ClaudeLink;
  /** People's own OpenRouter keys and caps, and the media tools that spend them (src/openrouter.ts, #717). */
  openrouter: OpenRouter;
  /** Spend on outside APIs and a scheme's cap on it (src/outside-spend.ts, #839). */
  outsideSpend: OutsideSpend;
  /** Secrets people saved (#838). */
  secrets: Secrets;
  /** People's own Codex sign-ins, in their Claude container (src/codex-link.ts, #330). */
  codex: CodexLink;
  /** Contraptions' keys and who each is enabled for (src/contraptions.ts). */
  contraptions: Contraptions;
  /** Contraptions' systemd user services (src/app-services.ts). */
  services: AppServices;
  /** Contraption turns: the turn API's engine (src/contraption-turns.ts). */
  contraptionTurns: ContraptionTurns;
  /** Contraptions' daily error digest (#835): yesterday's count goes in the scheme's list_tickets. Absent in tests that build no server. */
  errorDigest?: ErrorDigest;
  /** land.sh runs for container turns' land tool (src/land.ts). */
  landings: Landings;
  /** Ultra reviews people start on their own Claude login (src/ultrareview.ts, #432). */
  ultrareviews: UltraReviews;
  /** Who has each minion open or wrote in it lately (#695, src/presence.ts). */
  presence: Presence;
  /** Open event streams (GET /api/stream), with whose they are. */
  clients: Map<ServerResponse, Session>;
  /** Semantic memory's model (#331): what embeds a search, and which schemes are indexed. */
  memory: { embed: Embed; model: string; indexed: (projectId: number) => boolean };
  dataDir: string;
  preview: boolean;
  machinesUrl: URL | null;
  /** The commit the server runs: its boot commit, moved on by each SIGHUP reload (a front-end-only or light deploy). */
  liveCommit: string | null;
  readonly assetVersion: string;
  broadcast(msg: object): void;
  notify(ticketId: number, trigger: PushTrigger, except?: string | null): void;
  newMinion(project: Project, m: { title: string; props: Record<string, unknown>; model?: string | null; effort?: string | null; build?: number | null }, by: string): Promise<{ id: number; number: number; notes: string[] }>;
  startChained(c: Chain, why: string): Promise<void>;
  ticketBranch(ticketId: number): Promise<BranchStatus | null>;
  /** Build branches' headers (src/builds.ts). */
  builds: Pick<Builds, 'get'>;
  sharedFiles(projectId: number): Promise<SharedFile[]>;
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
  /** Null only on 'anyone', 'machine' and 'contraption' routes. */
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
  /** The contraption calling, on 'contraption' routes. */
  contraption: ContraptionRow;
}

export interface Route {
  method: string | readonly string[];
  /**
   * Segments, with `:name` for a parameter; :ticket, :project, :schedule, :artifact and :machine load that row.
   * A last segment `*name` takes the rest of the path, slashes and all.
   */
  path: string;
  /**
   * 'anyone' needs no login; 'machine' is a machine's agent, which checks its own token; 'contraption' is
   * a contraption's own server, local and with its key (src/contraptions.ts caller), and no one else.
   */
  who: readonly Who[] | 'anyone' | 'machine' | 'contraption';
  /** The 403 for a caller `who` leaves out (a minion always gets "A minion may only update itself"). */
  refuse?: string;
  /**
   * For a person, beyond seeing the scheme the path names: 'admin' for admins only, 'owner' for the
   * scheme's owner (and admins). Threads keep to `who`.
   */
  access?: 'admin' | 'owner';
  /**
   * Also a contraption's own server with its key (as 'contraption' routes), for its home scheme only: the
   * path's :project must be its home_scheme (#665, so a contraption reads its own scheme's CI files).
   */
  homeContraption?: true;
  /** A GET the Citadel scheme's Taskmaster may make in any scheme, on a turn a Citadel member or admin asked for (#656). */
  everyScheme?: true;
  handler(ctx: Ctx): unknown;
}

/** A minion as the API shows it; 404 when it is gone. */
export function ticketView(app: App, id: number): TicketView {
  const t = app.store.getTicket(id);
  if (!t) throw new HttpError(404, 'No such minion');
  return app.runner.view(t);
}

const LOADED = ['ticket', 'project', 'schedule', 'artifact', 'machine'];
const GONE: Record<string, string> = { ticket: 'No such minion', project: 'No such scheme', schedule: 'No such schedule', artifact: 'No such artifact' };
const NUMERIC = new Set([...LOADED, 'machineId']);

/** Load a row a path names, onto ctx; returns the scheme it belongs to, if any. */
function load(ctx: Ctx, name: string, id: number): number | undefined {
  const { store } = ctx.app;
  if (name === 'ticket') {
    ctx.ticket = ticketView(ctx.app, id);
    return ctx.ticket.project_id;
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

/**
 * The 403 for a caller the route's `who` leaves out, checked before any row is loaded so a refused
 * caller learns nothing of what exists. A minion's reach is all in the path: its own ticket, or its own scheme.
 */
function checkRole(route: Route, caller: Ticket | null, params: Record<string, string>) {
  const who = route.who as readonly Who[];
  if (!caller) {
    if (!who.includes('person')) throw new HttpError(403, route.refuse ?? 'Not for people');
    return;
  }
  const ticket = params.ticket === undefined ? undefined : Number(params.ticket);
  if (who.includes('self') && ticket === caller.id) return;
  if (caller.kind === 'coordinator') {
    if (!who.includes('taskmaster')) throw new HttpError(403, route.refuse ?? 'Not available to the Taskmaster');
    return;
  }
  const own = ticket !== undefined ? ticket === caller.id : params.project === undefined || Number(params.project) === caller.project_id;
  if (!who.includes('minion') || !own) throw new HttpError(403, 'A minion may only update itself');
}

/**
 * Once its rows are loaded: a Taskmaster stays in its own scheme, and only reads itself, GET or HEAD (its 'self' routes aside).
 * The Citadel scheme's reads other schemes' minions through `everyScheme` routes (#656, Josh: "the Citadel taskmaster should
 * have full read access to all schemes"), on a Citadel member's or admin's ask (as access.ts adminAskRefusal), never writes.
 */
function checkScope(store: Store, route: Route, caller: Ticket, method: string, project: number | undefined, ticket: number | undefined) {
  if (caller.kind !== 'coordinator' || (ticket === caller.id && (route.who as readonly Who[]).includes('self'))) return;
  const reads = route.everyScheme && method === 'GET' && store.readsEveryScheme(caller);
  if (project !== undefined && project !== caller.project_id && !reads) {
    throw new HttpError(403, `Outside this Taskmaster's scheme${route.everyScheme && method === 'GET' ? ": only the Citadel scheme's reads other schemes, on a turn a Citadel member or admin asked for" : ''}`);
  }
  if (ticket === caller.id && method !== 'GET' && method !== 'HEAD') throw new HttpError(403, 'The Taskmaster cannot act on itself');
}

/**
 * The API as one table: match the path and method, check the login and the origin, load the rows the
 * path names (404 when gone), check who may call it, then run its handler.
 */
export function router(routes: Route[]) {
  const table = routes.map((route) => ({
    route,
    methods: typeof route.method === 'string' ? [route.method] : route.method,
    names: route.path.split('/').filter((s) => /^[:*]/.test(s)).map((s) => s.slice(1)),
    re: new RegExp(`^${route.path.split('/').map((s) => (s.startsWith(':') ? (NUMERIC.has(s.slice(1)) ? '(\\d+)' : '([^/]+)') : s.startsWith('*') ? '(.+)' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`),
  }));
  const dispatch = async (app: App, req: IncomingMessage, res: ServerResponse, url: URL, session: Session | null) => {
    const method = req.method ?? 'GET';
    const onPath = table.filter((r) => r.re.test(url.pathname));
    const hit = onPath.find((r) => r.methods.includes(method));
    const { route } = hit ?? {};
    const ctx = { req, res, url, app, session, caller: null, params: {} } as unknown as Ctx;
    if (hit) hit.re.exec(url.pathname)!.slice(1).forEach((v, i) => (ctx.params[hit.names[i]] = v));
    if (route?.who === 'anyone' || route?.who === 'machine') return route.handler(ctx);
    if (route?.who === 'contraption') {
      ctx.contraption = app.contraptions.caller(req);
      return route.handler(ctx);
    }
    // A bearer that isn't a minion's token leaves no session: on these routes it may be a contraption's key.
    if (!session && route?.homeContraption && req.headers.authorization) {
      ctx.contraption = app.contraptions.caller(req);
      if (ctx.contraption.home_scheme === null || Number(ctx.params.project) !== ctx.contraption.home_scheme) {
        throw new HttpError(403, 'A contraption may only read its own home scheme here');
      }
      for (const name of hit!.names) if (LOADED.includes(name)) load(ctx, name, Number(ctx.params[name]));
      return route.handler(ctx);
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
    if (!route) throw onPath.length ? new HttpError(405, 'Method not allowed') : new HttpError(404, 'Not found');

    if (session.agent !== undefined) {
      ctx.caller = app.store.getTicket(session.agent) ?? null;
      if (!ctx.caller) throw new HttpError(403, 'No such minion');
    }
    checkRole(route, ctx.caller, ctx.params);
    // A Taskmaster on an admin route is checked by the route, after its own scheme check (src/access.ts adminAskRefusal).
    if (!ctx.caller && route.access === 'admin' && !session.admin) throw new HttpError(403, 'Only an admin can do that');
    let project: number | undefined;
    for (const name of hit!.names) {
      if (!LOADED.includes(name)) continue;
      project = load(ctx, name, Number(ctx.params[name])) ?? project;
      // A scheme someone isn't in answers as if it didn't exist.
      if (!ctx.caller && project !== undefined && !app.store.canSee(session, project)) throw new HttpError(404, GONE[name]);
    }
    if (ctx.caller) checkScope(app.store, route, ctx.caller, method, project, ctx.ticket?.id);
    else if (route.access === 'owner' && !session.admin && app.store.getProject(project!)?.owner_id !== session.uid) throw new HttpError(403, 'Only the scheme\'s owner can do that');
    return route.handler(ctx);
  };
  // Whether the table has a path at all, for a listener that serves more than its table.
  return Object.assign(dispatch, { knows: (path: string) => table.some((r) => r.re.test(path)) });
}
