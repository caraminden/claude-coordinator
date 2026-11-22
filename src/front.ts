// The front thread (#1563): it owns the listening socket so a click never waits for the main thread. People's
// read-only page requests on READER_PATHS go to reader threads (src/reader.ts), which answer from their own
// read-only connection with the real router, Auth and access checks; everything else is piped as it is (bodies,
// live streams, websocket upgrades) to the main thread, which listens on a local socket. This file loads no app code
// and reads no database, so nothing here can block. Design: the shared folder's specs/reader-threads.md.
import { Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, Server as NetServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The paths readers answer, with or without the front end's /c prefix: a minion's history pages and single events,
 * memory search (#1563), and a scheme's minions list, a minion's own page and the Status page (#1590).
 */
export const READER_PATHS = /^\/(?:c\/)?api\/(?:tickets\/\d+(?:\/events(?:\/\d+)?)?|projects\/\d+(?:\/memory)?|status)$/;
/** Headers the front thread sets on every request it passes to the main thread; a client's own copies are dropped. */
export const PEER_HEADER = 'x-citadel-peer';
export const LOCAL_HEADER = 'x-citadel-local';
/** A request a reader hasn't answered in this long goes to the main thread instead (a GET is safe to ask twice). */
export const READER_ANSWER_MS = 2000;
/** A reader whose thread hasn't said it is alive for this long is replaced. */
export const READER_STUCK_MS = 10_000;

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
export type Snapshot = { ready: boolean; live: Record<number, unknown>; status: Record<string, any> | null; builds: Record<number, unknown>; ownScheme: number | null; previews: boolean };
export type SnapDelta = { ready?: true; live?: Record<number, unknown>; status?: Record<string, unknown>; builds?: Record<number, unknown>; ownScheme?: number | null; previews?: boolean };
export const emptySnapshot = (): Snapshot => ({ ready: false, live: {}, status: null, builds: {}, ownScheme: null, previews: false });
export function applySnap(s: Snapshot, d: SnapDelta) {
  if (d.ready) s.ready = true;
  if (d.live) Object.assign(s.live, d.live);
  if (d.status) s.status = d.status;
  if (d.builds) Object.assign(s.builds, d.builds);
  if (d.ownScheme !== undefined) s.ownScheme = d.ownScheme;
  if (d.previews !== undefined) s.previews = d.previews;
}

type Answer = { status: number; headers: Record<string, string | string[]>; body: Uint8Array };
export type FrontOptions = {
  /** systemd's socket, fd 3, or else this host and port (0: any free one). */
  fd?: number; host?: string; port?: number;
  /** How many readers; 0 sends everything to the main thread. */
  readers: number;
  /** Start data for each reader (src/reader.ts): the database path, sign-in keys, the writer's shared counter. */
  reader: Record<string, unknown>;
  /** APPS_DOMAIN: a contraption's own host goes to the main thread whatever its path. */
  appsDomain: string | null;
  /** READER_ANSWER_MS and READER_STUCK_MS, turned down by a test server (test/front.test.ts). */
  answerMs?: number; stuckMs?: number;
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
 * `stop()`, for a restart, resolves once the front thread has let go of the port and answered what it took.
 * `publish()` posts a change to the readers' snapshot (Snapshot).
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
  // How many snapshot changes main has posted: the front thread reads what it hasn't applied yet before it asks a reader,
  // so a reader never answers from older state than main had when the request came (a person's own click included).
  const posted = new Int32Array(new SharedArrayBuffer(4));
  let early: SnapDelta[] | null = [];
  const post = (d: SnapDelta) => {
    front!.postMessage({ snap: d });
    Atomics.add(posted, 0, 1);
  };
  // The front thread's pooled connections stay open until it closes them, so a reused one is never closed under a request.
  server.keepAliveTimeout = 0;
  server.listen(sock, () => {
    front = new Worker(new URL(import.meta.url), { workerData: { front: { ...opts, sock, posted } } });
    for (const d of early!) post(d);
    early = null;
    front.on('message', (m: { listening?: number; usage?: unknown[][]; setting?: [string, unknown]; stopped?: true }) => {
      if (m.stopped) stopped();
      if (m.listening !== undefined) on.listening(m.listening);
      for (const args of m.usage ?? []) on.usage(args);
      if (m.setting) on.setting(m.setting[0], m.setting[1]);
    });
    front.on('error', (err) => console.error(`Front thread failed: ${err?.stack ?? err}`));
    // It holds the port: without it nothing answers, so the server exits and systemd starts it again, the socket holding requests meanwhile.
    front.once('exit', (code) => {
      stopped();
      if (stopping) return;
      console.error(`Front thread stopped (exit code ${code}): exiting so systemd starts the server again.`);
      process.exit(1);
    });
  });
  return {
    stop() {
      stopping = true;
      if (!front) stopped();
      else front.postMessage('stop');
      return drained;
    },
    /** A warm handover (#1170): stop accepting, keep open connections, and send all their requests to the main thread. */
    release() {
      front?.postMessage('release');
    },
    publish(d: SnapDelta) {
      if (early) early.push(d);
      else post(d);
    },
  };
}

if (!isMainThread && workerData?.front) runFront(workerData.front as FrontOptions & { sock: string; posted: Int32Array });

/** Bodies up to this size are read whole before going to the main thread (pass, in runFront). */
const SMALL_BODY = 1024 * 1024;

function runFront(opts: FrontOptions & { sock: string; posted: Int32Array }) {
  const toMain = new Agent({ keepAlive: true });
  const answerMs = opts.answerMs ?? READER_ANSWER_MS, stuckMs = opts.stuckMs ?? READER_STUCK_MS;

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
      const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.has(k)));
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
      r.once('close', () => { if (!r.complete) res.destroy(); });
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('The server is restarting: try again in a moment');
      else res.destroy();
    });
    // A client that goes (a closed page's live stream) closes the main thread's side too.
    res.once('close', () => { if (!res.writableFinished) up.destroy(); });
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

  // Readers: started here, so their answers never wait on the main thread.
  // late: it missed an answer's deadline and gets no more requests until it posts something again.
  type Reader = { worker: Worker; ready: boolean; late: boolean; heard: number; open: Map<number, (a: Answer | null) => void> };
  const readers = new Set<Reader>();
  let nextId = 1;
  let failures = 0;
  let stopping = false;
  const startReader = (again = false) => {
    const r: Reader = { worker: new Worker(new URL('./reader.ts', import.meta.url), { workerData: { reader: opts.reader, snap } }), ready: false, late: false, heard: Date.now(), open: new Map() };
    readers.add(r);
    const started = Date.now();
    r.worker.on('message', (m: { ready?: true; alive?: true; id?: number; answer?: Answer | null; usage?: unknown[][]; setting?: [string, unknown] }) => {
      r.heard = Date.now();
      r.late = false;
      if (m.ready) {
        r.ready = true;
        failures = 0;
        if (again) console.log('Reader thread started again: ready.');
      }
      if (m.id !== undefined) { r.open.get(m.id)?.(m.answer ?? null); r.open.delete(m.id); }
      if (m.usage || m.setting) parentPort!.postMessage({ usage: m.usage, setting: m.setting });
    });
    r.worker.on('error', (err) => console.error(`Reader thread failed: ${err?.stack ?? err}`));
    r.worker.once('exit', (code) => {
      readers.delete(r);
      for (const done of r.open.values()) done(null); // to the main thread
      r.open.clear();
      if (stopping) return;
      // One that dies at once again and again (a database it can't open) waits longer each time, at most a minute.
      if (Date.now() - started < stuckMs) failures++;
      const wait = Math.min(60_000, failures ? 1000 * 2 ** Math.min(failures, 6) : 0);
      console.error(`Reader thread stopped (exit code ${code}): starting another${wait ? ` in ${wait / 1000} s` : ''}.`);
      setTimeout(startReader, wait, true).unref();
    });
  };
  for (let i = 0; i < opts.readers; i++) startReader();
  // A reader whose thread stopped answering (a read that never ends) is replaced; its requests already went to the main thread.
  setInterval(() => {
    for (const r of readers) if (Date.now() - r.heard > stuckMs) {
      console.error(`Reader thread silent for ${Math.round((Date.now() - r.heard) / 1000)} s: replacing it.`);
      r.heard = Infinity; // terminated once
      void r.worker.terminate();
    }
  }, 1000).unref();

  const forReader = (req: IncomingMessage) => req.method === 'GET' && !req.headers.authorization && !req.headers.upgrade
    && appHost(req, opts.appsDomain) === null
    && READER_PATHS.test((req.url ?? '').split('?')[0]);

  const ask = (req: IncomingMessage, res: ServerResponse) => {
    // Every change main posted before this request is applied first, and so reaches the reader before the request does.
    for (let m; Atomics.load(opts.posted, 0) !== applied && (m = receiveMessageOnPort(parentPort!));) fromMain(m.message);
    if (Atomics.load(opts.posted, 0) !== applied) return pass(req, res);
    let best: Reader | null = null;
    for (const r of readers) if (r.ready && !r.late && r.heard !== Infinity && (!best || r.open.size < best.open.size)) best = r;
    if (!best) return pass(req, res);
    const r = best, id = nextId++;
    const timer = setTimeout(() => { r.late = true; r.open.get(id)?.(null); r.open.delete(id); }, answerMs);
    r.open.set(id, (a) => {
      clearTimeout(timer);
      if (res.destroyed) return;
      if (!a) return pass(req, res);
      res.setHeader('X-Citadel-Answered', 'reader'); // for tests and probes: who answered
      res.writeHead(a.status, a.headers);
      res.end(a.body);
    });
    r.worker.postMessage({ id, method: req.method, url: req.url, headers: req.headers });
  };

  let released = false; // a warm handover's: every request goes to the main thread, which passes it on
  const front = createServer({ shouldUpgradeCallback: (req) => upgrades(req, opts.appsDomain) }, (req, res) => {
    try {
      if (!released && forReader(req)) ask(req, res);
      else pass(req, res);
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
  front.on('error', (err) => { console.error(`Front thread can't listen: ${err.message}`); process.exit(1); });
  const listening = () => parentPort!.postMessage({ listening: (front.address() as { port: number }).port });
  if (opts.fd !== undefined) front.listen({ fd: opts.fd }, listening);
  else front.listen(opts.port ?? 0, opts.host, listening);

  function fromMain(m: 'stop' | 'release' | { snap: SnapDelta }) {
    if (m === 'release') {
      // net's close, not http's, which would also close an idle connection whose request isn't read yet (ECONNRESET).
      released = true;
      NetServer.prototype.close.call(front);
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
    front.close(() => {
      for (const r of readers) void r.worker.terminate();
      parentPort!.postMessage({ stopped: true });
    });
    front.closeIdleConnections();
    setInterval(() => front.closeIdleConnections(), 50).unref();
  }
  parentPort!.on('message', fromMain);
}
