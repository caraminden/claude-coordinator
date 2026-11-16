// The server's database writes, on a worker thread of their own (#795). With WAL and synchronous=NORMAL a commit
// doesn't fsync, except the first after a checkpoint emptied the WAL: it starts the WAL over and fsyncs its header on
// the writer's thread. On the event loop that held every page and every minion's tool call for as long as perigee's
// disk stalled (14.3 s on a one-row write, #791). So the Store's void writes go to one worker with its own connection,
// in order, and the server's own connection only reads. A read waits a moment for writes still queued, so it sees
// them; a stalled disk only makes reads stale for as long as it lasts, never stops them.
// Writes that return something stay on the server's thread for now, after the queue (step 2 of #795 moves them).
import type { StatementSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Store } from './db.ts';
import { writes } from './http.ts';

/** The Store's writes the worker runs: none returns a value its callers use, and every argument survives postMessage. */
export const WRITES = [
  'setProjectRepoDir', 'setProjectUpstream', 'setProjectInstructions', 'setAppInstructions', 'setPersonalInstructions',
  'setProjectSettings', 'updateUser', 'deleteUser', 'putCredential', 'failCredential', 'deleteCredential',
  'finishOpenrouterCall', 'setOpenrouterCallPath', 'sweepOpenrouterCalls', 'adoptOwnerless', 'addMember', 'removeMember',
  'putRepoCollaborator', 'deleteRepoCollaborator', 'updateContraption', 'setContraptionUser', 'putContraptionSession',
  'endContraptionTurn', 'setProjectHidden', 'setListOrder', 'setSeenItems', 'deleteProject', 'setTicketDir', 'deleteTicket',
  'updateTicketQuietly', 'updateTicket', 'setLastActivity', 'setEventData', 'setArtifactPinned', 'deleteCiFile',
  'publishCiFile', 'recordApkPublish', 'setSharedPin', 'writeArtifactData', 'deleteClaudeState', 'setTicketPinned',
  'settleBrief', 'addGithubSeen', 'addStepTimes', 'addHealthEvent', 'setSetting', 'autoCheckpoint', 'deleteSetting',
  'addRunnerLoad', 'addRunnerLoads', 'pruneRunnerLoad', 'updateMachine', 'setMachineProjects', 'deleteMachine', 'saveView',
  'setPushMuted', 'setPushEverything', 'setPushOnlyPinned', 'deletePushSubscription', 'insertEvent', 'putFates',
  'props.backfillOther', 'props.setBuild', 'schedules.ran', 'memory.deleteTicket',
];

/** Writes that return a value: they run on the server's thread after the queue, and a write they make inside runs with them. */
export const VALUE_WRITES = [
  'createProject', 'renameProject', 'createUser', 'addOpenrouterCall', 'createContraption', 'deleteContraptionSession',
  'startContraptionTurn', 'createTicket', 'putCiFile', 'syncArtifacts', 'markSeen', 'setPersonNote', 'claimBrief', 'recap',
  'rewriteClaudeEvents', 'recordTurn', 'backfillTurns', 'addRelease', 'addContraptionDeploy', 'createMachine', 'deleteView',
  'savePushSubscription', 'pruneArtifacts', 'props.set', 'props.registerKey', 'props.registerValues', 'props.review',
  'schedules.create', 'schedules.update', 'schedules.remove', 'memory.index',
];

/** What a write also changes in the server's own memory, done there when the write is sent. */
const MAIN_SIDE: Record<string, (store: Store, args: any[], exec: (sql: string) => void) => void> = {
  deleteTicket: (store, [id]) => (store.forgetCards(), store.memory.forgetTicket(id)),
  setEventData: (store, [id]) => store.forgetCards(id),
  'memory.deleteTicket': (store, [id]) => store.memory.forgetTicket(id),
  // The server's connection must not checkpoint either while the checkpoint worker does (src/checkpoint.ts).
  autoCheckpoint: (store, [on], exec) => exec(`PRAGMA wal_autocheckpoint = ${on ? 1000 : 0}`),
};

// A statement that writes, or a transaction: it waits for the whole queue, so the database never sees writes out of order.
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b|^\s*PRAGMA\s+[\w.]+\s*=|^\s*WITH\b[\s\S]*\)\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
/** How long a read waits for queued writes before it reads without them. */
export const READ_WAIT_MS = 50;
/** How long a write on the server's thread waits for the queue (it must come after it). */
const DRAIN_MS = 30_000;

const owner = (store: any, name: string) => {
  const dot = name.indexOf('.');
  return dot < 0 ? { obj: store, method: name } : { obj: store[name.slice(0, dot)], method: name.slice(dot + 1) };
};

export type Writer = {
  /** Wait for every queued write, at most `ms`. True if they all ran. */
  drain(ms?: number): boolean;
  /** Writes sent and not yet run. */
  queued(): number;
};

/**
 * From now on the store's void writes (WRITES) run on a worker with its own connection, in the order they were called,
 * and return a promise of the write instead of nothing. Reads on the store's connection first wait up to READ_WAIT_MS
 * for writes still queued; writes there (VALUE_WRITES, and SQL run directly) wait for all of them. If the worker can't
 * start or stops, writes run on the store's connection again. Null for an in-memory store. `delayMs` holds every
 * write that long on the worker, for tests of a stalled disk.
 */
export function writeOffThread(store: Store, { delayMs = 0, readyMs = 30_000 } = {}): Writer | null {
  if (!store.statePath) return null;
  const db = store.db;
  // [0]: the last write run, [1]: 1 once the worker is ready, -1 once it is gone.
  const shared = new BigInt64Array(new SharedArrayBuffer(16));
  const worker = new Worker(new URL(import.meta.url), { workerData: { writer: { path: store.path, shared, delayMs } } });
  worker.on('error', (err) => console.error(`DB write worker failed: ${err?.stack ?? err}`));
  // Its start is a few ms of opening the file; waiting here keeps the boot's own writes in order.
  const until = Date.now() + readyMs;
  while (Atomics.load(shared, 1) === 0n && Date.now() < until) Atomics.wait(shared, 1, 0n, until - Date.now());
  if (Atomics.load(shared, 1) !== 1n) {
    console.error(`DB write worker didn't start within ${readyMs} ms: writes stay on the server's thread.`);
    void worker.terminate();
    return null;
  }

  let alive = true;
  let seq = 0;
  let stalled = 0; // a read gave up waiting for this write: later reads don't wait until it has run
  let inline = 0; // inside a write on this thread: writes it makes run with it
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  const applied = () => Number(Atomics.load(shared, 0));

  const waitFor = (target: number, ms: number) => {
    const until = Date.now() + ms;
    for (let done = applied(); done < target; done = applied()) {
      const left = until - Date.now();
      if (left <= 0 || Atomics.load(shared, 1) !== 1n) return false;
      Atomics.wait(shared, 0, BigInt(done), left);
    }
    return true;
  };
  const beforeRead = () => {
    const target = seq;
    if (!alive || applied() >= target) return;
    if (stalled && applied() < stalled) return;
    stalled = waitFor(target, READ_WAIT_MS) ? 0 : target;
  };
  const drain = (ms = DRAIN_MS) => {
    const t0 = Date.now(), target = seq;
    const ok = !alive || waitFor(target, ms);
    if (Date.now() - t0 > 1000) console.error(`DB write on the server's thread waited ${Date.now() - t0} ms for ${target - applied()} queued writes${ok ? '' : ' and gave up'}.`);
    return ok;
  };
  // A response waits as a read does, so a client reading the database itself (a test, a tool) finds the request's writes.
  writes.settle = beforeRead;
  const beforeWrite = () => {
    if (alive && applied() < seq) drain();
  };

  // The store's connection: reads wait a moment for queued writes, and its own writes for all of them.
  const maxEvent = db.prepare('SELECT max(id) AS id FROM events');
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string, ...rest: any[]) => {
    const st = prepare(sql, ...rest) as StatementSync;
    const before = WRITE_SQL.test(sql) ? beforeWrite : beforeRead;
    for (const m of ['run', 'get', 'all', 'iterate'] as const) {
      const f = (st as any)[m].bind(st);
      (st as any)[m] = (...a: any[]) => {
        if (!db.isTransaction) before();
        return f(...a);
      };
    }
    return st;
  }) as typeof db.prepare;
  const exec = db.exec.bind(db);
  db.exec = ((sql: string) => {
    if (!db.isTransaction) beforeWrite();
    return exec(sql);
  }) as typeof db.exec;

  // Ids for addEvent, handed out here so it can return its row at once: past every id already written, and every id
  // handed out (a deleted newest event's id isn't reused while the server runs).
  store.eventIds = { next: 0, floor: () => ((maxEvent.get() as { id: number | null }).id ?? 0) + 1 };

  for (const name of VALUE_WRITES) {
    const { obj, method } = owner(store, name);
    const f = obj[method];
    if (typeof f !== 'function') throw new Error(`db-writer: no ${name} to run on the server's thread`);
    obj[method] = function (this: unknown, ...args: any[]) {
      beforeWrite();
      inline++;
      // Only its synchronous part: memory.index awaits embeddings for minutes, and other writes meanwhile go to the worker.
      try { return f.apply(this, args); } finally { inline--; }
    };
  }
  for (const name of WRITES) {
    const { obj, method } = owner(store, name);
    const f = obj[method];
    if (typeof f !== 'function') throw new Error(`db-writer: no ${name} to send to the write worker`);
    obj[method] = function (this: unknown, ...args: any[]) {
      // Inside a transaction or another write on this thread it runs with that, or the worker would wait on our lock.
      if (!alive || inline || db.isTransaction) return f.apply(this, args);
      const n = seq + 1;
      try {
        worker.postMessage({ seq: n, name, args });
      } catch (e: any) {
        // An argument postMessage can't copy: run it here, after the queue.
        console.error(`DB write ${name} can't go to the write worker (${e?.message ?? e}): run on the server's thread.`);
        beforeWrite();
        return f.apply(this, args);
      }
      seq = n;
      MAIN_SIDE[name]?.(store, args, exec);
      const p = new Promise<void>((resolve, reject) => pending.set(n, { resolve, reject }));
      p.catch(() => { /* logged by the worker; a caller that awaits sees it */ });
      return p;
    };
  }

  worker.on('message', ({ seq: n, error }: { seq: number; error?: string }) => {
    const p = pending.get(n);
    pending.delete(n);
    if (error) p?.reject(new Error(error));
    else p?.resolve();
  });
  worker.once('exit', (code) => {
    alive = false;
    const lost = seq - applied();
    seq = applied();
    for (const p of pending.values()) p.reject(new Error('the DB write worker stopped'));
    pending.clear();
    console.error(`DB write worker stopped (exit code ${code})${lost ? `, ${lost} queued writes lost` : ''}: writes run on the server's thread again.`);
    try {
      store.addHealthEvent('db-writer-stopped', Date.now(), null, `exit code ${code}, ${lost} queued writes lost`);
    } catch { /* the health log is best effort */ }
  });

  // However the server stops, what it queued is written first (the worker runs until the process is gone), and
  // writes made later at exit (the runner-load samples, #791) run here.
  process.on('exit', () => {
    if (alive && !drain(10_000)) console.error(`DB write worker: ${seq - applied()} queued writes not written by exit.`);
    alive = false;
  });
  worker.unref(); // after the listeners: adding one refs the worker again
  return { drain, queued: () => seq - applied() };
}

if (!isMainThread && workerData?.writer) {
  const { path, shared, delayMs } = workerData.writer as { path: string; shared: BigInt64Array; delayMs: number };
  process.on('exit', () => {
    Atomics.store(shared, 1, -1n);
    Atomics.notify(shared, 1);
    Atomics.notify(shared, 0);
  });
  const store = new Store(path, { writer: true });
  Atomics.store(shared, 1, 1n);
  Atomics.notify(shared, 1);
  const pause = delayMs ? new Int32Array(new SharedArrayBuffer(4)) : null;
  parentPort!.on('message', ({ seq, name, args }: { seq: number; name: string; args: unknown[] }) => {
    if (pause) Atomics.wait(pause, 0, 0, delayMs);
    let error: string | undefined;
    try {
      const { obj, method } = owner(store, name);
      obj[method](...args);
    } catch (e: any) {
      error = String(e?.message ?? e);
      console.error(`DB write ${name} failed on the write worker: ${e?.stack ?? e}`);
      try {
        store.addHealthEvent('db-write-error', Date.now(), null, `${name}: ${error}`.slice(0, 2000));
      } catch { /* the health log is best effort */ }
    }
    Atomics.store(shared, 0, BigInt(seq));
    Atomics.notify(shared, 0);
    parentPort!.postMessage({ seq, error });
  });
}
