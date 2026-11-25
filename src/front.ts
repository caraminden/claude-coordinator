// The front thread (#1563): it owns the listening socket so a click never waits for the main thread. People's
// read-only page requests on READER_PATHS go to reader threads (src/reader.ts), which answer from their own
// read-only connection with the real router, Auth and access checks; everything else is piped as it is (bodies,
// live streams, websocket upgrades) to the main thread, which listens on a local socket. This file loads no app code
// and reads no database, so nothing here can block. Design: the shared folder's specs/reader-threads.md.
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, Server as NetServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { shellOff } from './shell.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SchemeReleases } from './releases.ts';
import { thrown } from './thrown.ts';
import type { Storm } from './memory-storms.ts';
import type { EaseNow } from './memory-ease.ts';
import type { PcView } from './ci-load.ts';
import type { DiskUse, UnitState } from './app-services.ts';
import type { JobRow } from './every.ts';

/**
 * The people's GETs readers answer, as their routes' paths: a minion's history pages and single events, memory search
 * (#1563), a scheme's minions list, a minion's own page and the Status page (#1590), and the rest of the page reads
 * (#1628). A route goes here once nothing it runs reads the main thread's memory or does more than read the database.
 */
export const READER_ROUTES: readonly string[] = [
  '/api/tickets/:ticket',
  '/api/tickets/:ticket/events',
  '/api/tickets/:ticket/events/:event',
  '/api/projects/:project',
  '/api/projects/:project/memory',
  '/api/status',
  '/api/box-capacity',
  // #1628: the rest that answer from the database and the snapshot. The main thread keeps the GETs that read its
  // memory or the disk, start a process (git), write, or reach a part a reader lacks once there are rows: /api/projects,
  // /api/me, /api/home, costs, releases, people, the me/* logins, machines, catalogue, ideas, recap, shared, spend,
  // memory-files, instructions/sources, schedules, app/settings, facts, push/key, secrets, welcome, a minion's jobs,
  // artifacts, the ci-files, ci-numbers and ci-runners, contraptions, reviews/schemes, and the Taskmaster-only GETs.
  '/api/tickets/:ticket/commands',
  '/api/tickets/:ticket/ship-risk',
  '/api/tickets/:ticket/time-log',
  '/api/ship-lines',
  '/api/app/instructions',
  '/api/app/instructions/history',
  '/api/projects/:project/members',
  '/api/projects/:project/taskmaster-events',
  '/api/projects/:project/instructions/history',
  '/api/projects/:project/my-instructions',
  '/api/projects/:project/my-instructions/history',
  '/api/projects/:project/repo-setup',
  '/api/projects/:project/plugins',
  '/api/projects/:project/properties',
  '/api/projects/:project/views',
  '/api/projects/:project/search',
  '/api/projects/:project/past-minions',
  '/api/projects/:project/schedule-audits',
  '/api/projects/:project/ship-lessons',
  '/api/projects/:project/claims',
  '/api/projects/:project/contraption-turns',
  '/api/ci',
  '/api/ci-desktop',
  '/api/units',
];
/**
 * Their paths, with or without the front end's /c prefix. A parameter matches any segment: a reader matches the main
 * thread's whole table (src/routes/all.ts) and hands back any path whose route isn't one of these.
 */
export const READER_PATHS = new RegExp(`^(?:/c)?(?:${READER_ROUTES.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+')).join('|')})$`);
/** Headers the front thread sets on every request it passes to the main thread; a client's own copies are dropped. */
export const PEER_HEADER = 'x-citadel-peer';
export const LOCAL_HEADER = 'x-citadel-local';
/**
 * A request a reader hasn't answered in this long is asked of another one too (a GET is safe to ask twice). It waits
 * four times this for a reader in all, then gets a 503 its page retries (#2003): never the main thread, where one slow
 * read on a swamped disk holds up everyone.
 */
export const READER_ANSWER_MS = 2000;
/**
 * A reader whose thread hasn't said it is alive for this long gets a replacement, and goes once that is ready. With
 * none heard from for six times this, requests go to the main thread.
 */
export const READER_STUCK_MS = 10_000;

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

/** Citadel UI's files, which contraptions load from /apps/_citadel/ (on their own hosts too), each with an ETag. */
export const KIT_FILE = /^\/apps\/_citadel\/((rail|drawers)\.(js|d\.ts)|appswitch\.js|reorder\.js|extlinks\.js|app-menu\.js|pick-crop\.js|theme\.css|ui\/[a-z][a-z0-9-]*\.(js|css|d\.ts))$/;
/** Bodies smaller than this go out as they are: gzip isn't worth it. */
export const MIN_GZIP_BYTES = 1400;

/** One front-end file ready to send (#1628): its headers (Vary and X-Front-Hash among them), body and gzipped body. */
export type StaticFile = { headers: Record<string, string>; body: Uint8Array; gz: Uint8Array | null };
/**
 * public/ as the main thread loaded it, which the front thread serves with no hop to the main thread: each file by
 * name, and the variants a request picks, the dark manifest and the service worker the off switch's flag file asks for.
 */
export type Statics = { files: Record<string, StaticFile>; darkManifest: StaticFile; swOff: StaticFile; dataDir: string };
const gzipped = promisify(gzip);
/**
 * Every file's ETag is the hash of the bytes it sends (#1697), so a reload revalidates (no-cache) and gets a 304 for
 * what it has, while a ship's changed bytes are a new tag: never stale. Per variant, so the dark manifest and the off
 * switch's worker never answer a 304 for the other one.
 */
export const readyFile = async (headers: Record<string, string>, body: Uint8Array): Promise<StaticFile> => ({
  headers: { Vary: 'Accept-Encoding', ...headers, ETag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` },
  body,
  gz: body.length >= MIN_GZIP_BYTES ? await gzipped(body, { level: 6 }) : null,
});

/** The front-end file a request's URL names (Citadel UI's under /apps/_citadel/ too); null for anything else. */
export function staticName(url: string, onAppHost: boolean): string | null {
  const kit = (path: string) => (KIT_FILE.test(path) ? path.slice('/apps/_citadel/'.length) : null);
  // A contraption's own host serves only Citadel UI's files of Citadel's.
  if (onAppHost) return kit(url.split('?')[0]);
  const own = ownPath(url);
  if (own && 'redirect' in own) return null;
  let path: string;
  try {
    path = new URL(own?.url ?? url, 'http://localhost').pathname;
    decodeURIComponent(path);
  } catch {
    return null;
  }
  return kit(path) ?? (path.startsWith('/api/') || path.startsWith('/apps/') ? null : path === '/' ? 'index.html' : path.slice(1));
}

/** The answer to a GET or HEAD for front-end file `name`, or null when there is no such file. One copy for both threads. */
export function staticAnswer(s: Statics, name: string, req: IncomingHttpHeaders): { status: number; headers: Record<string, string>; body: Uint8Array } | null {
  if (!Object.hasOwn(s.files, name)) return null;
  let f = s.files[name];
  if (name === 'sw.js' && shellOff(s.dataDir)) f = s.swOff;
  if (name === 'manifest.webmanifest' && /dark/.test(String(req['sec-ch-prefers-color-scheme'] ?? ''))) f = s.darkManifest;
  const headers = f.headers;
  const asked = String(req['if-none-match'] ?? '')
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''));
  if (asked.includes(headers.ETag) || asked.includes('*')) return { status: 304, headers, body: new Uint8Array() };
  if (f.gz && /\bgzip\b/.test(String(req['accept-encoding'] ?? ''))) return { status: 200, headers: { ...headers, 'Content-Encoding': 'gzip' }, body: f.gz };
  return { status: 200, headers, body: f.body };
}

// Hop-by-hop headers belong to one connection, not the request.
// Upgrade stays on a request that isn't one (no Connection: upgrade): the main thread answers it as it would have.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer']);

/** The contraption a request's host names (<name>.<domain>), or null on any other host: one of Citadel's own (src/apps.ts re-exports it). */
export function appHost(req: IncomingMessage, domain: string | null): string | null {
  if (!domain) return null;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

/**
 * The requests the main thread upgrades (contraptions' websockets): an /apps/ path or a contraption's own host. One
 * copy for both threads: the front thread pipes exactly these raw, so no request on a raw pipe reaches the main
 * thread's HTTP parser carrying peer headers a client wrote.
 */
export const upgrades = (req: IncomingMessage, appsDomain: string | null) => (req.url ?? '').startsWith('/apps/') || appHost(req, appsDomain) !== null;

/**
 * What readers build pages from that lives in the main thread's memory, not the database (#1590): each minion's
 * Runner.live(), the Status page's inputs (src/reader.ts statusPage), each scheme's build headers and Citadel's own
 * scheme. Main posts what changed (publish); the front thread keeps the whole and passes each change on to the readers.
 * `ready`: main has posted every minion once, so a minion missing from `live` is new and its page is main's to answer.
 */
/** `ships`: the ship lines' inputs main keeps in memory (#1628): the Citadel line's queue folder and every scheme's releases. */
export type Ships = { queue: string | null; releases: SchemeReleases[] };
/** The Status page's inputs as main posts them (reader-live.ts), for a reader's StatusPage (reader.ts). */
export interface StatusSnap {
  bootAt: number;
  commit: string;
  cores: number;
  probing: boolean;
  lastMs: number | null;
  readerMs: number | null;
  storms: Storm[];
  easing: EaseNow | null;
  desktops: PcView[];
  disk: Record<string, DiskUse | null>;
  units: UnitState[] | null;
  jobs: JobRow[];
}
export type Snapshot = { ready: boolean; live: Record<number, unknown>; status: StatusSnap | null; builds: Record<number, unknown>; ownScheme: number | null; previews: boolean; ships: Ships | null };
export type SnapDelta = { ready?: true; live?: Record<number, unknown>; status?: StatusSnap; builds?: Record<number, unknown>; ownScheme?: number | null; previews?: boolean; ships?: Ships };
export const emptySnapshot = (): Snapshot => ({ ready: false, live: {}, status: null, builds: {}, ownScheme: null, previews: false, ships: null });
export function applySnap(s: Snapshot, d: SnapDelta) {
  if (d.ready) s.ready = true;
  if (d.live) Object.assign(s.live, d.live);
  if (d.status) s.status = d.status;
  if (d.builds) Object.assign(s.builds, d.builds);
  if (d.ownScheme !== undefined) s.ownScheme = d.ownScheme;
  if (d.previews !== undefined) s.previews = d.previews;
  if (d.ships) s.ships = d.ships;
}

type Answer = { status: number; headers: Record<string, string | string[]>; body: Uint8Array };
export type FrontOptions = {
  /** systemd's socket, fd 3, or else this host and port (0: a free one). */
  fd?: number;
  host?: string;
  port?: number;
  /** How many readers; 0 sends everything to the main thread. */
  readers: number;
  /** Start data for each reader (src/reader.ts): the database path, sign-in keys, the writer's shared counter. */
  reader: Record<string, unknown>;
  /** APPS_DOMAIN: a contraption's own host goes to the main thread whatever its path. */
  appsDomain: string | null;
  /** READER_ANSWER_MS and READER_STUCK_MS, turned down by a test server (test/front.test.ts). */
  answerMs?: number;
  stuckMs?: number;
};

/** Where the socket's folder goes: XDG_RUNTIME_DIR, else tmpdir(), else /tmp when that makes the path pass a unix socket's 107 bytes (a CI runner's long TMPDIR). */
export function socketBase(env = process.env, tmp = tmpdir()) {
  const base = env.XDG_RUNTIME_DIR || tmp;
  return Buffer.byteLength(join(base, 'citadel-XXXXXX', 'main.sock')) > 107 ? '/tmp' : base;
}

/**
 * Serve `server` (the main thread's) through a front thread: it listens on a local socket, and the front thread on
 * the real one. `onListening` gets the port the front thread bound. `onUsage`/`onSetting` take the counts and cache
 * writes readers post (the main thread and its writer do every write). The process exits if the front thread dies.
 * `stop()`, for a restart, resolves once the front thread has let go of the port and answered what it took; `quiet`
 * once its reader threads have gone, which the exit waits for (#1625).
 * `publish()` posts a change to the readers' snapshot (Snapshot); `statics()` the front end's files, which it serves (Statics).
 */
export function listenThroughFront(server: Server, opts: FrontOptions, on: { listening: (port: number) => void; usage: (args: unknown[]) => void; setting: (key: string, value: unknown) => void }) {
  // A private folder (0700) for the socket: only this account can reach it, so only the front thread sets the peer header.
  const dir = mkdtempSync(join(socketBase(), 'citadel-'));
  const sock = join(dir, 'main.sock');
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  let stopping = false;
  let front: Worker | null = null;
  let stopped!: () => void;
  const drained = new Promise<void>((r) => (stopped = r));
  let quieted!: () => void;
  const quiet = new Promise<void>((r) => (quieted = r));
  // How many snapshot changes main has posted: the front thread reads what it hasn't applied yet before it asks a reader,
  // so a reader never answers from older state than main had when the request came (a person's own click included).
  const posted = new Int32Array(new SharedArrayBuffer(4));
  let early: ({ snap: SnapDelta } | { statics: Statics })[] | null = [];
  // Counted before it is sent, and a snapshot change as soon as main has made it (`coming`): a reader asked in between
  // answered from the state before it, a page without the click its person had just made (#1963). Counted but not yet
  // applied, the front thread sends the request to main instead.
  let announced = 0;
  const post = (m: { snap: SnapDelta } | { statics: Statics }, counted = false) => {
    if (early) return void early.push(m);
    if (counted && announced) announced--;
    else Atomics.add(posted, 0, 1);
    try {
      front!.postMessage(m);
    } catch (err) {
      Atomics.sub(posted, 0, 1); // never sent: a count the front thread can't reach would send every read to main for good
      throw err;
    }
  };
  // The front thread's pooled connections stay open until it closes them, so a reused one is never closed under a request.
  server.keepAliveTimeout = 0;
  server.listen(sock, () => {
    front = new Worker(new URL(import.meta.url), { workerData: { front: { ...opts, sock, posted } } });
    const held = early!;
    early = null;
    for (const m of held) post(m);
    front.on('message', (m: { listening?: number; usage?: unknown[][]; setting?: [string, unknown]; stopped?: true; quiet?: true }) => {
      if (m.stopped) stopped();
      if (m.quiet) quieted();
      if (m.listening !== undefined) on.listening(m.listening);
      for (const args of m.usage ?? []) on.usage(args);
      if (m.setting) on.setting(m.setting[0], m.setting[1]);
    });
    front.on('error', (err) => console.error(`Front thread failed: ${thrown(err).stack ?? err}`));
    // It holds the port: without it nothing answers, so the server exits and systemd starts it again, the socket holding requests meanwhile.
    front.once('exit', (code) => {
      stopped();
      quieted();
      if (stopping) return;
      console.error(`Front thread stopped (exit code ${code}): exiting so systemd starts the server again.`);
      process.exit(1);
    });
  });
  return {
    stop() {
      stopping = true;
      if (!front) {
        stopped();
        quieted();
      } else front.postMessage('stop');
      return drained;
    },
    /** Resolves once no reader thread is still starting: the process must not exit while one is (src/reader.ts, #1625). */
    quiet,
    /** A warm handover (#1170): stop accepting, keep open connections, and send all their requests to the main thread. */
    release() {
      front?.postMessage('release');
    },
    /** `counted`: the change `coming()` already counted. */
    publish(d: SnapDelta, counted = false) {
      post({ snap: d }, counted);
    },
    /** A snapshot change is made and will be published within this run of the main thread: no reader answers without it. */
    coming() {
      if (early) return; // counted when it is posted: nothing is asked before the front thread exists
      announced++;
      Atomics.add(posted, 0, 1);
    },
    /** The front end's files as loaded (at the start and on each SIGHUP): the front thread serves them from then on. */
    statics(s: Statics) {
      post({ statics: s });
    },
  };
}

if (!isMainThread && workerData?.front) runFront(workerData.front as FrontOptions & { sock: string; posted: Int32Array });

/**
 * Every answer carries the server's own time (#1752): `Server-Timing: app;dur=<ms>`, from the request's arrival to its
 * head going out, so the page's slow-load recorder (public/slow-moments.js) can tell server time from network and tab
 * time. The front thread stamps all it answers (its files, readers' answers, main's, whose own stamp it replaces); the
 * main thread stamps its own for when it listens alone (CITADEL_FRONT=0).
 */
export function stampServerTime(res: ServerResponse, t0 = performance.now()): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    if (!this.headersSent) this.setHeader('Server-Timing', `app;dur=${(performance.now() - t0).toFixed(1)}`);
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as ServerResponse['writeHead'];
}

/** Bodies up to this size are read whole before going to the main thread (pass, in runFront). */
const SMALL_BODY = 1024 * 1024;

function runFront(opts: FrontOptions & { sock: string; posted: Int32Array }) {
  const toMain = new Agent({ keepAlive: true });
  const answerMs = opts.answerMs ?? READER_ANSWER_MS,
    stuckMs = opts.stuckMs ?? READER_STUCK_MS;

  /** The request's headers for the main thread: any client copy of its own two headers dropped, the connection's own addresses set. */
  const mainHeaders = (req: IncomingMessage, keepUpgrade = false) => {
    const h: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (k !== PEER_HEADER && k !== LOCAL_HEADER && (keepUpgrade || !HOP.has(k))) h[k] = v;
    h[PEER_HEADER] = req.socket.remoteAddress ?? '';
    h[LOCAL_HEADER] = `${req.socket.localAddress ?? ''} ${req.socket.localPort ?? ''}`;
    return h;
  };

  const pass = (req: IncomingMessage, res: ServerResponse) => {
    const up = request({ agent: toMain, socketPath: opts.sock, method: req.method, path: req.url, headers: mainHeaders(req) }, (r) => {
      const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.has(k) && k !== 'server-timing'));
      if (/\bclose\b/i.test(r.headers.connection ?? '')) headers.connection = 'close'; // the main thread ends this connection: so does the front
      res.writeHead(r.statusCode ?? 502, r.statusMessage, headers as Record<string, string | string[]>);
      res.flushHeaders(); // a live stream's headers go now, before its first event
      r.pipe(res, { end: false });
      // An answer before the whole body (a refused upload) ends once the rest is read: ended with it unread, the
      // connection resets and a client still sending never sees the answer. requestTimeout bounds it.
      r.once('end', () => {
        if (req.complete) return void res.end();
        req.unpipe(up);
        req.resume();
        req.once('end', () => res.end());
      });
      r.once('close', () => {
        if (!r.complete) res.destroy();
      });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('The server is restarting: try again in a moment');
      else res.destroy();
    });
    // A client that goes (a closed page's live stream) closes the main thread's side too.
    res.once('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    // A small body goes with its head in one write: main may refuse from the head alone and close, and a body written
    // after that would fail the request here (a 502) before main's answer is read. Anything else streams, its head
    // sent at once, since main may answer from it alone (an upload refused by its size) before any body comes.
    const size = Number(req.headers['content-length']);
    if (size > 0 && size <= SMALL_BODY) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.once('end', () => up.end(Buffer.concat(chunks)));
    } else {
      up.flushHeaders();
      req.pipe(up);
    }
  };

  // The readers' snapshot (Snapshot), whole for a reader that starts, and each change main posts passed on in order.
  const snap = emptySnapshot();
  let applied = 0;
  let statics: Statics | null = null;
  // Every change main posted before this request is applied first: false if one is still on its way.
  const caughtUp = () => {
    for (let m; Atomics.load(opts.posted, 0) !== applied && (m = receiveMessageOnPort(parentPort!)); ) fromMain(m.message);
    return Atomics.load(opts.posted, 0) === applied;
  };

  // Readers: started here, so their answers never wait on the main thread.
  // open: what it was asked and hasn't answered, oldest first: the oldest is the one it is busy with.
  // late: it missed an answer's deadline and gets no more requests until it posts something again.
  // silent: it was silent for stuckMs and another was started in its place; it stays until that is ready, or it is heard
  // again (one that was only slow on disk, #2003). ended: terminated here.
  // starting: resolves when the thread has said it is ready, or has died. A thread that hasn't is still evaluating its
  // module (it opens the database and hashes the sign-in keys there), and killing one then aborts the whole process:
  // V8's "Check failed: !is_null()", SIGTRAP, so the server dies on a signal instead of exiting 0 (#1625).
  type Reader = { worker: Worker; ready: boolean; late: boolean; silent: boolean; ended: boolean; heard: number; open: Map<number, { a: Ask; done: (got: Answer | null) => void }>; starting: Promise<void> };
  // A page read, and the readers asked for it so far.
  type Ask = { req: IncomingMessage; res: ServerResponse; asked: Set<Reader>; timer: NodeJS.Timeout };
  const readers = new Set<Reader>();
  const asks = new Set<Ask>();
  let nextId = 1;
  // A reader has been ready since this process started.
  let up = false;
  let failures = 0;
  let stopping = false;
  let released = false; // a warm handover's: every request goes to the main thread, which passes it on
  const end = (r: Reader) => {
    r.ended = true;
    void r.worker.terminate();
  };
  // Once there are enough that answer, the silent ones go, and any over: a silent one that came back outlives its replacement.
  const trim = () => {
    const up = [...readers].filter((r) => r.ready && !r.silent && !r.ended);
    if (up.length < opts.readers) return;
    for (const r of readers) if (r.ready && r.silent && !r.ended) end(r);
    for (const r of up.slice(opts.readers)) end(r);
  };
  // At most twice opts.readers threads: one stuck in a disk read outlives its termination until the read ends.
  const fill = () => {
    const coming = () => [...readers].filter((r) => !r.ended && !(r.ready && r.silent)).length;
    while (!stopping && coming() < opts.readers && readers.size < 2 * opts.readers) startReader(true);
  };
  const startReader = (again = false) => {
    let started_up!: () => void;
    const r: Reader = {
      worker: new Worker(new URL('./reader.ts', import.meta.url), { workerData: { reader: opts.reader, snap } }),
      ready: false,
      late: false,
      silent: false,
      ended: false,
      heard: Date.now(),
      open: new Map(),
      starting: new Promise<void>((done) => (started_up = done)),
    };
    readers.add(r);
    const started = Date.now();
    r.worker.on('message', (m: { ready?: true; alive?: true; id?: number; answer?: Answer | null; usage?: unknown[][]; setting?: [string, unknown] }) => {
      const back = r.late || r.silent || m.ready;
      r.heard = Date.now();
      r.late = r.silent = false;
      if (m.ready) {
        r.ready = up = true;
        started_up();
        failures = 0;
        if (again) console.log('Reader thread started again: ready.');
      }
      if (m.id !== undefined) {
        r.open.get(m.id)?.done(m.answer ?? null);
        r.open.delete(m.id);
      }
      if (m.usage || m.setting) parentPort!.postMessage({ usage: m.usage, setting: m.setting });
      if (back) {
        trim();
        for (const a of asks) give(a);
      }
    });
    r.worker.on('error', (err) => console.error(`Reader thread failed: ${thrown(err).stack ?? err}`));
    r.worker.once('exit', (code) => {
      readers.delete(r);
      started_up();
      const left = [...r.open.values()];
      r.open.clear();
      // One that died: to the main thread. One replaced: the read it was stuck on is asked again by the page, the rest of another reader here.
      if (!r.ended) for (const o of left) o.done(null);
      else if (left.length) settle(left[0].a, () => busy(left[0].a.res));
      if (stopping) return;
      if (r.ended) {
        console.log('Reader thread replaced: the old one is gone.');
        for (const a of asks) give(a);
        return fill(); // the cap may have held one back
      }
      // One that dies at once again and again (a database it can't open) waits longer each time, at most a minute.
      if (Date.now() - started < stuckMs) failures++;
      const wait = Math.min(60_000, failures ? 1000 * 2 ** Math.min(failures, 6) : 0);
      console.error(`Reader thread stopped (exit code ${code}): starting another${wait ? ` in ${wait / 1000} s` : ''}.`);
      setTimeout(fill, wait).unref();
      for (const a of asks) give(a); // with none left, to the main thread
    });
  };
  for (let i = 0; i < opts.readers; i++) startReader();
  // A reader whose thread stopped answering (a read that never ends, or a swamped disk) is replaced.
  setInterval(() => {
    for (const r of readers) {
      if (r.silent || r.ended || Date.now() - r.heard <= stuckMs) continue;
      r.silent = r.late = true; // said once
      // One that has never said it is ready is still evaluating its module, and terminating it then aborts the whole
      // process (see Reader above), so it is left alone. Accepted: while a thread is wedged there (a database it can't
      // open) the reads it would have answered wait for the other readers, or the main thread (heardFrom), which beats
      // what this did before (#1625), which was to kill the server. The message that says it is ready puts it back
      // under this watch.
      if (!r.ready) console.error(`Reader thread hasn't started in ${Math.round((Date.now() - r.heard) / 1000)} s: leaving it to finish.`);
      else console.error(`Reader thread silent for ${Math.round((Date.now() - r.heard) / 1000)} s: replacing it once another is ready.`);
      fill();
    }
  }, 1000).unref();

  const forReader = (req: IncomingMessage) => req.method === 'GET' && !req.headers.authorization && !req.headers.upgrade && appHost(req, opts.appsDomain) === null && READER_PATHS.test((req.url ?? '').split('?')[0]);

  // Whether a reader can still be hoped for. None that can't ever open its database holds up the pages for good: they
  // go to the main thread, as before there were readers.
  const heardFrom = () => [...readers].some((r) => !r.ended && Date.now() - r.heard < 6 * stuckMs);
  const settle = (a: Ask, how: () => void) => {
    if (!asks.delete(a)) return;
    clearTimeout(a.timer);
    if (!a.res.destroyed) how();
  };
  const main = (a: Ask) => settle(a, () => pass(a.req, a.res));
  /**
   * Ask a reader that is free to answer, if it has none yet or the one it has is stuck on another read; else it waits for
   * one. The read a reader is stuck on stays with it, so one that never ends can't take every reader.
   */
  const give = (a: Ask) => {
    if (!asks.has(a)) return;
    if ([...a.asked].some((r) => !r.ended && readers.has(r) && (!r.late || [...r.open.values()][0]?.a === a))) return;
    if (stopping || released || !heardFrom()) return main(a);
    let best: Reader | null = null;
    for (const r of readers) if (r.ready && !r.late && !r.ended && !a.asked.has(r) && (!best || r.open.size < best.open.size)) best = r;
    if (!best) return;
    const r = best,
      id = nextId++;
    a.asked.add(r);
    const timer = setTimeout(() => {
      r.late = true;
      give(a);
    }, answerMs);
    const done = (got: Answer | null) => {
      clearTimeout(timer);
      if (!got) return main(a);
      settle(a, () => {
        a.res.setHeader('X-Citadel-Answered', 'reader'); // for tests and probes: who answered
        a.res.writeHead(got.status, got.headers);
        a.res.end(got.body);
      });
    };
    r.open.set(id, { a, done });
    r.worker.postMessage({ id, method: a.req.method, url: a.req.url, headers: a.req.headers });
  };
  // After a start on a busy box the first reader takes longer than that to load: a read waits for it (or, once none can be
  // hoped for, goes to the main thread), since callers that aren't the page don't ask again.
  const tooLong = (a: Ask) => {
    if (up) return settle(a, () => busy(a.res));
    a.timer = setTimeout(() => tooLong(a), answerMs);
    give(a);
  };
  const ask = (req: IncomingMessage, res: ServerResponse) => {
    // So every change main posted reaches the reader before the request does.
    if (!caughtUp()) return pass(req, res);
    const a: Ask = { req, res, asked: new Set(), timer: setTimeout(() => tooLong(a), 4 * answerMs) };
    asks.add(a);
    res.once('close', () => settle(a, () => {}));
    give(a);
  };
  // No reader in time: the page asks again (public/base.js).
  const busy = (res: ServerResponse) => res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1', 'X-Citadel-Answered': 'front' }).end(JSON.stringify({ error: 'The server is waiting for its disk: try again in a moment', retry: true }));

  // The front end's files (#1628), as main last loaded them; a test's `citadel-test-reader=main` asks main for the reference.
  const testHooks = !!opts.reader.testHooks;
  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.upgrade || (testHooks && /[?&]citadel-test-reader=main\b/.test(req.url ?? ''))) return false;
    const file = staticName(req.url ?? '/', appHost(req, opts.appsDomain) !== null);
    const a = file && caughtUp() && statics && staticAnswer(statics, file, req.headers);
    if (!a) return false;
    res.writeHead(a.status, { ...a.headers, 'X-Citadel-Answered': 'front' });
    res.end(a.body);
    return true;
  };

  const front = createServer({ shouldUpgradeCallback: (req) => upgrades(req, opts.appsDomain) }, (req, res) => {
    stampServerTime(res);
    try {
      if (released) pass(req, res);
      else if (forReader(req)) ask(req, res);
      else if (!serveStatic(req, res)) pass(req, res);
    } catch (err) {
      console.error(`Front thread: ${(err as Error)?.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  // Websockets (contraptions'): the request head goes to the main thread as it came, then the bytes both ways.
  front.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const up = connect(opts.sock);
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(mainHeaders(req, true))) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket).pipe(up);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    up.once('close', () => socket.destroy());
    socket.once('close', () => up.destroy());
  });
  front.requestTimeout = 30 * 60_000; // as the main thread's: a 200 MB attachment on a slow uplink
  front.on('error', (err) => {
    console.error(`Front thread can't listen: ${err.message}`);
    process.exit(1);
  });
  const listening = () => parentPort!.postMessage({ listening: (front.address() as { port: number }).port });
  if (opts.fd !== undefined) front.listen({ fd: opts.fd }, listening);
  else front.listen(opts.port ?? 0, opts.host, listening);

  function fromMain(m: 'stop' | 'release' | { snap: SnapDelta } | { statics: Statics }) {
    if (m === 'release') {
      // net's close, not http's, which would also close an idle connection whose request isn't read yet (ECONNRESET).
      released = true;
      for (const a of asks) give(a);
      NetServer.prototype.close.call(front);
      return;
    }
    if (m !== 'stop' && 'statics' in m) {
      statics = m.statics;
      applied++;
      return;
    }
    if (m !== 'stop') {
      applySnap(snap, m.snap);
      applied++;
      for (const r of readers) r.worker.postMessage(m);
      return;
    }
    // New connections wait in systemd's socket for the next server; open ones finish what they asked, readers' and
    // the main thread's alike (it keeps listening until told this is done), then the main thread exits.
    stopping = true;
    for (const a of asks) give(a); // those no reader has: the main thread's, within the stop's grace
    front.close(() => {
      // At once: the main thread closes its own connections when it hears this, and holding it back for the readers
      // below would hold every open connection open with it.
      parentPort!.postMessage({ stopped: true });
      void (async () => {
        // Each reader finishes starting first: one killed mid-start takes the whole process down with it (see Reader
        // above). The main thread waits for `quiet` before it exits, with a cap, so a reader that never starts only
        // slows the restart down.
        await Promise.all([...readers].map((r) => r.starting));
        for (const r of readers) void r.worker.terminate();
        parentPort!.postMessage({ quiet: true });
      })();
    });
    front.closeIdleConnections();
    setInterval(() => front.closeIdleConnections(), 50).unref();
  }
  parentPort!.on('message', fromMain);
}
