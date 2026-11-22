// A reader thread (#1563), started by the front thread (src/front.ts): it answers people's read-only page requests
// on READER_PATHS from its own read-only connection, with the real router, Auth, access checks and route objects, so
// who sees what has one copy. Anything it can't answer the same way the main thread would (a request it doesn't
// know, a failure, writes it can't wait out) it hands back, and the front thread asks the main thread instead.
import { parentPort, workerData } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './db.ts';
import { Auth } from './auth.ts';
import { acceptsGzip, HttpError, isSecure, json, ownPath, requestUrl, router, type App } from './http.ts';
import { READ_WAIT_MS } from './db-writer.ts';
import { llamaEmbed } from './memory.ts';
import { ticketRoutes } from './routes/tickets.ts';
import { projectRoutes } from './routes/projects.ts';
import { READER_PATHS } from './front.ts';

export type ReaderData = {
  dbPath: string; password: string; secret: string;
  /** The write worker's counter (src/db-writer.ts): [0] the last write run, [1] its state, [2] the last write sent. */
  shared: BigInt64Array | null;
  embedUrl: string; embedModel: string; memorySchemes: number[] | null;
  /** A test server's (CITADEL_TEST_SETTLED): `citadel-test-reader=exit`, `=hang` or `=slow` in a query ends, hangs or slows (500 ms) this thread mid-request. */
  testHooks?: boolean;
};

/** The routes readers answer: every GET whose path is one of READER_PATHS. */
export const readerRoutes = () => [...ticketRoutes, ...projectRoutes].filter((r) => r.method === 'GET' && READER_PATHS.test(r.path.replace(/:\w+/g, '1')));

/** Wait on this thread until every write sent so far has run, at most `ms`. False if they hadn't. */
export function writesCaughtUp(shared: BigInt64Array | null, ms = READ_WAIT_MS): boolean {
  if (!shared || Atomics.load(shared, 1) !== 1n) return true; // no write worker: the main thread writes in place
  const target = Atomics.load(shared, 2);
  const until = Date.now() + ms;
  for (let done = Atomics.load(shared, 0); done < target; done = Atomics.load(shared, 0)) {
    const left = until - Date.now();
    if (left <= 0 || Atomics.load(shared, 1) !== 1n) return Atomics.load(shared, 0) >= target;
    Atomics.wait(shared, 0, done, left);
  }
  return true;
}

type Answer = { status: number; headers: Record<string, string | string[]>; body: Uint8Array };

/** Just enough of a ServerResponse for json() and send(): the answer is collected and posted back whole. */
class Collect {
  headersSent = false;
  destroyed = false;
  private status = 200;
  private headers: Record<string, string | string[]> = {};
  private done: (a: Answer) => void;
  constructor(done: (a: Answer) => void) { this.done = done; }
  setHeader(k: string, v: string | string[]) { this.headers[k.toLowerCase()] = v; return this; }
  getHeader(k: string) { return this.headers[k.toLowerCase()]; }
  writeHead(status: number, headers: Record<string, string | number | string[]> = {}) {
    this.status = status;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = typeof v === 'number' ? String(v) : v;
    this.headersSent = true;
    return this;
  }
  end(body?: string | Uint8Array) {
    this.headersSent = true;
    this.done({ status: this.status, headers: this.headers, body: typeof body === 'string' ? Buffer.from(body) : body ?? new Uint8Array() });
    return this;
  }
}

/** Answer one request, or null to hand it to the main thread. */
export async function answer(app: App, auth: Auth, routes: ReturnType<typeof router>, m: { method: string; url: string; headers: Record<string, string | string[] | undefined> }): Promise<Answer | null> {
  // Agents' tokens and contraptions' keys are the main thread's: their nonces and keys live there.
  if (m.headers.authorization || m.method !== 'GET') return null;
  const req = { method: m.method, url: m.url, headers: m.headers, socket: {} } as unknown as IncomingMessage;
  const own = ownPath(m.url);
  if (own && 'redirect' in own) return null;
  if (own) req.url = own.url;
  let url: URL;
  try { url = requestUrl(req); } catch { return null; }
  if (!routes.knows(url.pathname)) return null;
  let resolve!: (a: Answer) => void;
  const answered = new Promise<Answer>((r) => (resolve = r));
  const collect = new Collect(resolve);
  const res = collect as unknown as ServerResponse;
  if (/\bgzip\b/.test(String(m.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
  try {
    const session = auth.session(req);
    const renewed = auth.renewal(session, isSecure(req));
    if (renewed) res.setHeader('Set-Cookie', renewed);
    await routes(app, req, res, url, session);
  } catch (err) {
    // What the main thread's own catch answers for a refusal; anything else (a write this connection refused, a
    // fault the main thread records) is asked again there.
    if (!(err instanceof HttpError) || err.status >= 500 || collect.headersSent) return null;
    json(res, err.status, { error: err.message });
  }
  // A gzipped answer comes a moment later; one that never comes is the main thread's to find out.
  let timer: NodeJS.Timeout | undefined;
  const a = await Promise.race([answered, new Promise<null>((r) => (timer = setTimeout(r, 1500, null)))]);
  clearTimeout(timer);
  return a && a.status < 500 ? a : null;
}

if (workerData?.reader) {
  const data = workerData.reader as ReaderData;
  const store = new Store(data.dbPath, { reader: true });
  const auth = new Auth(data.password, data.secret, undefined, store);
  // The reads' writes go to the main thread, which makes every write: route counts in batches, and history's page-plan cache.
  let usage: unknown[][] = [];
  store.usage.used = (...args: unknown[]) => void usage.push(args);
  store.setSetting = (key: string, value: unknown) => {
    // Only history's page-plan cache (pagePlanKey, src/db-keys.ts); any other write is the main thread's.
    if (!/^plan:\d+:page$/.test(key)) throw new Error(`A reader can't write setting ${key}`);
    parentPort!.postMessage({ setting: [key, value] });
  };
  setInterval(() => {
    parentPort!.postMessage(usage.length ? { alive: true, usage } : { alive: true });
    usage = [];
  }, 1000);
  const schemes = data.memorySchemes;
  const app = {
    store,
    runner: { view: (t: unknown) => t }, // the slice's routes read only the row's id and scheme
    memory: { embed: llamaEmbed(data.embedUrl), model: data.embedModel, indexed: (id: number) => !schemes || schemes.includes(id) },
  } as unknown as App;
  const routes = router(readerRoutes());
  parentPort!.on('message', async (m: { id: number; method: string; url: string; headers: Record<string, string | string[] | undefined> }) => {
    let a: Answer | null = null;
    if (data.testHooks && /[?&]citadel-test-reader=exit\b/.test(m.url)) process.exit(1);
    if (data.testHooks && /[?&]citadel-test-reader=hang\b/.test(m.url)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (data.testHooks && /[?&]citadel-test-reader=slow\b/.test(m.url)) {
      console.log('Reader test hook: slow');
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      // Never older than the person's own last write: what the main thread sent the writer has run, or the main thread answers.
      if (writesCaughtUp(data.shared)) a = await answer(app, auth, routes, m);
    } catch (err) {
      console.error(`Reader: ${m.method} ${m.url.split('?')[0]}: ${(err as Error)?.stack ?? err}`);
    }
    parentPort!.postMessage({ id: m.id, answer: a });
  });
  parentPort!.postMessage({ ready: true });
}
