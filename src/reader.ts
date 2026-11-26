// A reader thread (#1563), started by the front thread (src/front.ts): it answers people's read-only page requests
// on READER_PATHS from its own read-only connection, with the real router, Auth, access checks and route objects, so
// who sees what has one copy. What those pages show from the main thread's memory (a turn's steps, its approval
// cards, the ship line, the Status page's live numbers) comes from main's snapshot (#1590, src/reader-live.ts). Anything it can't answer the same way the main thread would (a request it doesn't
// know, a failure) it hands back, and the front thread asks the main thread instead. Waiting is never a reason to
// hand one back (#2003): the disk that slows a reader slows the main thread too, and there it holds up everyone.
// First, so every module after it already sees a reader thread's guards (src/only-reads.ts).
import { refusals, refusal } from './only-reads.ts';
import { existsSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './db.ts';
import { Auth } from './auth.ts';
import { acceptsGzip, HttpError, isSecure, json, ownPath, requestUrl, router, type App, type Route } from './http.ts';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { READ_WAIT_MS } from './db-writer.ts';
import { CHAT } from './events-db.ts';
import { llamaEmbed } from './memory.ts';
import { apiRoutes } from './routes/all.ts';
import { READER_ANSWER_MS, READER_ROUTES, applySnap, type Snapshot, type SnapDelta } from './front.ts';
import { Runner } from './runner.ts';
import { MinionQueue } from './minion-queue.ts';
import { LIMIT_RESUMES, WaitList } from './resumes.ts';
import { StatusPage } from './status-page.ts';
import { CiHealth } from './ci-health.ts';
import { RepoAccess } from './repo-access.ts';
import { labelTicket } from './waits.ts';
import type { Ticket } from './db.ts';

export type ReaderData = {
  dbPath: string;
  password: string;
  secret: string;
  /** The write worker's counter (src/db-writer.ts): [0] the last write run, [1] its state, [2] the last write sent. */
  shared: BigInt64Array | null;
  embedUrl: string;
  embedModel: string;
  memorySchemes: number[] | null;
  /** DATA_DIR, where the Status page reads backups from. */
  dataDir: string;
  /** A test server's (CITADEL_TEST_SETTLED): `citadel-test-reader=exit`, `=hang`, `=stall-<ms>` or `=slow` in a query ends, hangs, stalls or slows (500 ms) this thread mid-request, and `=main` sends it to the main thread. */
  testHooks?: boolean;
  /** A test server's (CITADEL_READER_BOOT_WAIT): a path this thread waits for while it starts, so a test can stop the server while a reader still is (#1625). */
  bootWait?: string;
};

// Only the GETs: the front thread sends no other method here, and answer() hands any back.
const taken = (r: Route) => [r.method].flat().includes('GET') && READER_ROUTES.includes(r.path);
/** The routes readers answer: the GETs READER_ROUTES names. */
export const readerRoutes = () => apiRoutes.filter(taken);
/** The main thread's table with every other route's handler handing the request back, so a path is never answered by a route main wouldn't run. */
const readerTable = () =>
  router(
    apiRoutes.map((r) =>
      taken(r)
        ? r
        : {
            ...r,
            handler: () => {
              throw new Error('The main thread answers this one');
            },
          },
    ),
  );

/**
 * The Runner a reader's views run on: the real view() and views(), their database reads on this thread's connection,
 * and live() from main's snapshot. A minion main hasn't posted yet throws, and so does anything else read from memory
 * (a field added outside Runner.live), which sends the request to the main thread.
 */
export function readerRunner(store: Store, snap: Snapshot): Runner {
  return Object.assign(Object.create(Runner.prototype), {
    store,
    queue: new MinionQueue(store),
    resumes: { limit: new WaitList(store, LIMIT_RESUMES) },
    onLive: () => {},
    // Unused: live() below carries main's ratio as step_ratio, so a reader keeps no cache of its own.
    stepRatio: () => 1,
    live: (t: Ticket) => {
      const live = snap.ready ? snap.live[t.id] : undefined;
      if (!live) throw new Error(`No live state for minion ${t.id} yet`);
      return live;
    },
  });
}

/** The Status page on a reader: the database's parts read here, the memory's from main's snapshot; none before main posts one. */
export function readerStatus(store: Store, snap: Snapshot, dataDir: string): () => StatusPage | null {
  let page: StatusPage | null = null;
  const s = () => snap.status!;
  return () =>
    snap.status &&
    (page ??= new StatusPage({
      store,
      dataDir,
      bootAt: s().bootAt,
      commit: s().commit,
      cores: s().cores,
      ownScheme: () => snap.ownScheme,
      ciSnapshot: (canSee) => CiHealth.prototype.snapshot.call({ store } as unknown as CiHealth, canSee),
      desktops: () => s().desktops,
      storms: () => s().storms,
      easing: () => s().easing,
      diskUse: (row) => s().disk[row.name] ?? null,
      unitsNow: () => s().units,
      jobs: () => s().jobs,
      answer: s().probing
        ? {
            probe: {
              get lastMs() {
                return s().lastMs;
              },
              get readerMs() {
                return s().readerMs;
              },
              take: () => null,
            },
            turns: () => 0,
          }
        : undefined,
    }));
}

/** `o`, but reading a part it lacks throws (the request goes to the main thread) instead of giving undefined. */
export const mainOnly = <T extends object>(o: T): T =>
  new Proxy(o, {
    get: (t, k, r) => {
      if (typeof k === 'string' && !(k in t)) throw new Error(`app.${k} is the main thread's`);
      return Reflect.get(t, k, r);
    },
  });

/** The steps the main thread has opened (src/db-writer.ts); 0 with no write worker (then readers answer nothing). */
export const stepsOpened = (shared: BigInt64Array | null) => (shared && Atomics.load(shared, 1) === 1n ? Atomics.load(shared, 4) : 0n);

const writerUp = (shared: BigInt64Array | null) => !!shared && Atomics.load(shared, 1) === 1n;
/**
 * Begin a read transaction on `db` at a whole step of the main thread's (#1628): every write of every step it opened
 * so far has run and none of a later one's has, so a read never sees half of one (a turn's queue taken but the next
 * turn not yet running). Waits at most `ms`; the steps it is at, or null if no whole step came or there is no write
 * worker to count them (the main thread answers).
 */
export function atWholeStep(db: DatabaseSync, shared: BigInt64Array | null, ms = READ_WAIT_MS): bigint | null {
  // One read of each file starts its snapshot: the transaction keeps the three as they were here.
  const pin = () => (db.exec('BEGIN'), db.prepare(`SELECT (SELECT count(*) FROM main.sqlite_master), (SELECT count(*) FROM state.sqlite_master), (SELECT count(*) FROM ${CHAT}.sqlite_master)`).get());
  // With no write worker the main thread writes in place, where a step can't be told from the next: it answers.
  if (!shared || !writerUp(shared)) return null;
  const until = Date.now() + ms;
  for (;;) {
    const opened = Atomics.load(shared, 4),
      closed = Atomics.load(shared, 3);
    if (closed >= opened) {
      pin();
      // No step opened while it pinned, so nothing committed since the check.
      if (Atomics.load(shared, 4) === opened) return opened;
      db.exec('ROLLBACK');
    }
    const left = until - Date.now();
    if (left <= 0 || Atomics.load(shared, 1) !== 1n) return null;
    Atomics.wait(shared, 3, closed, left);
  }
}

/**
 * Runs a request's read in a read transaction at a whole step (atWholeStep). The requests running at once share one;
 * one that needs a newer step (main opened one since) waits for them to finish. Null: the main thread answers.
 * `pin` is atWholeStep, a test's own to open a step at a moment it picks.
 */
export function wholeSteps(db: DatabaseSync, shared: BigInt64Array | null, pin = atWholeStep) {
  let tx: { at: bigint; refs: number; done: Promise<void>; end: () => void } | null = null;
  return async <T>(run: () => Promise<T>): Promise<T | null> => {
    const start = Date.now();
    for (let wait = READ_WAIT_MS; !tx || tx.at < stepsOpened(shared); wait = 0) {
      // The front thread answered it long since (four times READER_ANSWER_MS): a writer far behind must not pile these up here.
      if (Date.now() - start > 5 * READER_ANSWER_MS) return null;
      if (tx) {
        await tx.done;
        continue;
      }
      const at = pin(db, shared, wait);
      if (at === null) {
        // No write worker: the main thread answers.
        if (!writerUp(shared)) return null;
        await sleep(20);
        continue;
      }
      let end!: () => void;
      tx = { at, refs: 0, done: new Promise<void>((r) => (end = r)), end };
      // Pinned after this request came, so new enough for it whatever opened since. Checked again against the steps
      // opened, one that opened in this instant sent it to wait for a transaction nobody holds, which never ends, and
      // every later request on this thread behind it (#2086: every page read a 503 for 30 minutes, Nov 25).
      break;
    }
    const mine = tx;
    mine.refs++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      if (--mine.refs === 0) {
        if (tx === mine) tx = null;
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already ended */
        }
        mine.end();
      }
    };
    // A slow one (a memory search waits on its embedding) lets go after a while, so it doesn't keep everyone else at an
    // old step: its answer, null here, goes to the main thread's.
    const free = freeFor(READER_ANSWER_MS);
    try {
      return await Promise.race([run(), free.done]);
    } finally {
      free.stop();
      release();
    }
  };
}

type Answer = { status: number; headers: Record<string, string | string[]>; body: Uint8Array };

/** Just enough of a ServerResponse for json() and send(): the answer is collected and posted back whole. */
class Collect {
  headersSent = false;
  destroyed = false;
  private status = 200;
  private headers: Record<string, string | string[]> = {};
  private done: (a: Answer) => void;
  constructor(done: (a: Answer) => void) {
    this.done = done;
  }
  setHeader(k: string, v: string | string[]) {
    this.headers[k.toLowerCase()] = v;
    return this;
  }
  getHeader(k: string) {
    return this.headers[k.toLowerCase()];
  }
  writeHead(status: number, headers: Record<string, string | number | string[]> = {}) {
    this.status = status;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = typeof v === 'number' ? String(v) : v;
    this.headersSent = true;
    return this;
  }
  end(body?: string | Uint8Array) {
    this.headersSent = true;
    this.done({ status: this.status, headers: this.headers, body: typeof body === 'string' ? Buffer.from(body) : (body ?? new Uint8Array()) });
    return this;
  }
}

/**
 * Null once this thread has been free for `ms`: time it was stuck in a disk read doesn't count, so an answer it comes
 * back with is sent, not thrown away for the main thread to read again (#2003). `stop` ends the wait.
 */
function freeFor(ms: number) {
  let left = Math.ceil(ms / 50),
    timer!: NodeJS.Timeout;
  const done = new Promise<null>((r) => (timer = setInterval(() => --left <= 0 && r(null), 50)));
  return { done, stop: () => clearInterval(timer) };
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
  try {
    url = requestUrl(req);
  } catch {
    return null;
  }
  if (!routes.knows(url.pathname)) return null;
  let resolve!: (a: Answer) => void;
  const answered = new Promise<Answer>((r) => (resolve = r));
  const collect = new Collect(resolve);
  const res = collect as unknown as ServerResponse;
  if (/\bgzip\b/.test(String(m.headers['accept-encoding'] ?? ''))) acceptsGzip.add(res);
  const refused = refusals();
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
  const free = freeFor(1500);
  const a = await Promise.race([answered, free.done]);
  free.stop();
  // A refusal while it ran, caught or not (one in a request beside it too), sends it to the main thread.
  return a && a.status < 500 && refusals() === refused ? a : null;
}

if (workerData?.reader) {
  const data = workerData.reader as ReaderData;
  if (data.testHooks && data.bootWait) {
    // Blocking, like the real work here (opening the database, the sign-in keys): it holds this thread mid-start.
    console.log('Reader test hook: starting slowly');
    const idle = new Int32Array(new SharedArrayBuffer(4));
    for (const until = Date.now() + 30_000; !existsSync(data.bootWait) && Date.now() < until; ) Atomics.wait(idle, 0, 0, 50);
  }
  const store = new Store(data.dbPath, { reader: true });
  const auth = new Auth(data.password, data.secret, undefined, store);
  // The reads' writes go to the main thread, which makes every write: route counts in batches, and history's page-plan cache.
  let usage: unknown[][] = [];
  store.usage.used = (...args: unknown[]) => void usage.push(args);
  store.setSetting = (key: string, value: unknown) => {
    // Only history's page-plan cache (pagePlanKey, src/db-keys.ts); any other write is the main thread's.
    if (!/^plan:\d+:page$/.test(key)) throw refusal(`write setting ${key}`);
    parentPort!.postMessage({ setting: [key, value] });
  };
  setInterval(() => {
    parentPort!.postMessage(usage.length ? { alive: true, usage } : { alive: true });
    usage = [];
  }, 1000);
  const schemes = data.memorySchemes;
  const snap = workerData.snap as Snapshot;
  const status = readerStatus(store, snap, data.dataDir);
  const ships = () => {
    if (!snap.ships) throw new Error('No ship lines snapshot yet');
    return snap.ships;
  };
  // No dataDir on purpose: a scheme's first open makes its Taskmaster's folder and row (ensureCoordinator), which throws here and the main thread does.
  // Any other part of the main thread's App throws too (mainOnly), so a route never quietly takes another branch here.
  const app = mainOnly({
    store,
    runner: readerRunner(store, snap),
    memory: { embed: llamaEmbed(data.embedUrl), model: data.embedModel, indexed: (id: number) => !schemes || schemes.includes(id) },
    builds: { get: (id: number) => snap.builds[id] ?? [] },
    // The ship lines' (/api/ship-lines): main's queue folder and releases, the queue's files read here.
    releases: { view: (visible: (id: number) => boolean) => ships().releases.filter((s) => visible(s.projectId)) },
    waits: {
      get queue() {
        return ships().queue;
      },
      ticketFor: (label: string) => labelTicket(store, label)?.id ?? null,
    },
    // The Members page's: a member's repo invite, from the database.
    repoAccess: { view: (projectId: number, userId: number) => RepoAccess.prototype.view.call({ store } as unknown as RepoAccess, projectId, userId) },
    // The CI page's (/api/ci, /api/ci-desktop): CI health is in the database, the desktops' load in the Status snapshot.
    ciHealth: { snapshot: (canSee: (id: number) => boolean) => CiHealth.prototype.snapshot.call({ store } as unknown as CiHealth, canSee) },
    ciLoad: {
      views: () => {
        if (!snap.status) throw new Error('No Status snapshot yet');
        return snap.status.desktops;
      },
    },
    // None in a preview server, as main has none there.
    previews: { buildScheme: () => (!snap.previews || snap.ownScheme == null ? null : { id: snap.ownScheme }) },
    // None yet: main answers (its own would never be missing).
    get status() {
      const page = status();
      if (!page) throw new Error('No Status snapshot yet');
      return page;
    },
  }) as unknown as App;
  const routes = readerTable();
  // A history page or one event reads only the minion's row, which the route loads through view(): the row as it is
  // stands in, so these answer before main's first snapshot, as they did in slice 1.
  const rowOnly = Object.assign(Object.create(app), { runner: { view: (t: Ticket) => t } }) as App;
  const inWholeStep = wholeSteps(store.db, data.shared);
  parentPort!.on('message', async (m: { snap?: SnapDelta; id: number; method: string; url: string; headers: Record<string, string | string[] | undefined> }) => {
    if (m.snap) return applySnap(snap, m.snap);
    let a: Answer | null = null;
    if (data.testHooks && /[?&]citadel-test-reader=main\b/.test(m.url)) return parentPort!.postMessage({ id: m.id, answer: null });
    if (data.testHooks && /[?&]citadel-test-reader=exit\b/.test(m.url)) process.exit(1);
    if (data.testHooks && /[?&]citadel-test-reader=hang\b/.test(m.url)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    // A disk that answers nothing for that many ms.
    const stall = data.testHooks && /[?&]citadel-test-reader=stall-(\d+)/.exec(m.url);
    if (stall) console.log('Reader test hook: stalled');
    if (stall) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stall[1]));
    if (data.testHooks && /[?&]citadel-test-reader=slow\b/.test(m.url)) {
      console.log('Reader test hook: slow');
      await sleep(500);
    }
    try {
      // Never older than the person's own last write, nor half of one main step: or the main thread answers.
      a = await inWholeStep(() => answer(/\/events(?:\/\d+)?(?:\?|$)/.test(m.url) ? rowOnly : app, auth, routes, m));
    } catch (err) {
      console.error(`Reader: ${m.method} ${m.url.split('?')[0]}: ${(err as Error)?.stack ?? err}`);
    }
    parentPort!.postMessage({ id: m.id, answer: a });
  });
  if (data.testHooks) console.log('Reader test hook: ready');
  parentPort!.postMessage({ ready: true });
}
