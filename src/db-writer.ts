// The server's database writes, on a worker thread of their own (#795). With WAL and synchronous=NORMAL a commit
// doesn't fsync, except the first after a checkpoint emptied the WAL: it starts the WAL over and fsyncs its header on
// the writer's thread. On the event loop that held every page and every minion's tool call for as long as perigee's
// disk stalled (14.3 s on a one-row write, #791). So the Store's void writes go to one worker with its own connection,
// in order, and the server's own connection only reads. A read waits a moment for writes still queued, so it sees
// them; a stalled disk only makes reads stale for as long as it lasts, never stops them.
// Most writes that return something stay on the server's thread, after the queue; the ones the server waited on most
// (ASYNC_WRITES) run on the worker too and resolve with their value (#1877, step 2 of #795).
import { existsSync, readlinkSync } from 'node:fs';
import type { StatementSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Store, WRITER_BUSY_MS } from './db.ts';
import { writes } from './http.ts';
import { busySource } from './settled.ts';
import { thrown } from './thrown.ts';

/** The Store's writes the worker runs: none returns a value its callers use, and every argument survives postMessage. */
export const WRITES = [
  'setCabalName',
  'setCabalRed',
  'setCabalWidth',
  'updateCabalRow',
  'deleteCabalRow',
  'answerCabalAsk',
  'leaveCabal',
  'deleteCabalOf',
  'setProjectRepoDir',
  'setProjectUpstream',
  'setProjectInstructions',
  'setAppInstructions',
  'setPersonalInstructions',
  'setProjectSettings',
  'updateUser',
  'deleteUser',
  'putCredential',
  'failCredential',
  'deleteCredential',
  'finishOpenrouterCall',
  'setOpenrouterCallPath',
  'sweepOpenrouterCalls',
  'adoptOwnerless',
  'addMember',
  'removeMember',
  'putRepoCollaborator',
  'deleteRepoCollaborator',
  'updateContraption',
  'setContraptionUser',
  'putContraptionSession',
  'endContraptionTurn',
  'putTurnAudit',
  'setTurnVerdict',
  'sweepTurnAudit',
  'deleteTurnAudit',
  'setProjectHidden',
  'setListOrder',
  'setSeenItems',
  'deleteProject',
  'setTicketDir',
  'deleteTicket',
  'updateTicketQuietly',
  'updateTicket',
  'addWaitRecord',
  'setLastActivity',
  'setEventData',
  'setArtifactPinned',
  'deleteCiFile',
  'publishCiFile',
  'recordApkPublish',
  'setSharedPin',
  'writeArtifactData',
  'deleteClaudeState',
  'setTicketPinned',
  'addGithubSeen',
  'addStepTimes',
  'addHealthEvent',
  'setSetting',
  'autoCheckpoint',
  'deleteSetting',
  'setSettings',
  'addRunnerLoad',
  'addRunnerLoads',
  'pruneRunnerLoad',
  'moveRunnerLoad',
  'setMachineProjects',
  'deleteMachine',
  'saveView',
  'setPushMuted',
  'setPushEverything',
  'setPushOnlyPinned',
  'deletePushSubscription',
  'savePushDevice',
  'deletePushDevice',
  'insertEvent',
  'putFates',
  'touch',
  'leaveTouched',
  'noteDigest',
  'addPick',
  'addContraptionError',
  'addContraptionRun',
  'addSlowMoments',
  'recordGrunts',
  'addHostSample',
  'addFlakeEvents',
  'updateFlakeFix',
  'usage.addCounts',
  'memory.putChunks',
  'props.backfillOther',
  'props.setBuild',
  'schedules.ran',
  'schedules.heldNote',
  'memory.deleteTicket',
  'saveTimeLogExplain',
];

/**
 * Writes whose callers await their value (each returns a Promise in the Store): on the worker, in order with the rest,
 * resolving with what the worker's run returned (#1877). They held the server's thread longest waiting for the queue
 * (Nov 24: 15.4 s in recordTurn). Their arguments and values survive postMessage.
 */
export const ASYNC_WRITES = ['recordTurn', 'markSeen', 'syncArtifacts'];

/** Writes that return a value: they run on the server's thread after the queue, and a write they make inside runs with them. */
export const VALUE_WRITES = [
  'ensureCabal',
  'addCabalRow',
  'joinCabal',
  'addCabalAsk',
  'addCabalLog',
  'createProject',
  'renameProject',
  'createUser',
  'addOpenrouterCall',
  'createContraption',
  'deleteContraptionSession',
  'startContraptionTurn',
  'createTicket',
  'putCiFile',
  'setPersonNote',
  'recap',
  'rewriteClaudeEvents',
  'backfillTurns',
  'addRelease',
  'addContraptionDeploy',
  'createMachine',
  'addMachineJob',
  'deleteView',
  'addFlakeFix',
  // CI numbers: the step-up check reads them back at once, so they never wait in the queue behind a stalled disk.
  'putCiNumbers',
  'addCiNumberStep',
  'pruneCiNumbers',
  // Machines and their jobs: the code reads a row back at once (a job's card, the slot, the go; the lend sent to the agent and
  // checked), so a read that gave up on the queue never acts on the state before (main red, Nov 21). Rare writes: none per beat.
  'updateMachine',
  'setMachineRole',
  'writeMachineRoles',
  // Join codes (Build 7 M2): a code is used and its row made in one request, and the panel reads how it went at once.
  'addMachineJoin',
  'takeMachineJoin',
  'setMachineJoined',
  'pruneMachineJoins',
  'updateMachineJob',
  'allowJobKind',
  'savePushSubscription',
  'pruneArtifacts',
  'props.set',
  'props.registerKey',
  'props.registerValues',
  'props.review',
  'schedules.create',
  'schedules.update',
  'schedules.remove',
  'reviews.create',
  'reviews.save',
  'reviews.restore',
  'addDelivery',
  'updateDelivery',
  'pruneDeliveries',
  'importDeliveries',
  'deliveryTransaction',
];

/** The longest slice of a wait on the worker: after one that times out, it looks whether the thread is still there. */
const GONE_CHECK_MS = 100;

/** This thread's id to the kernel, 0 where /proc can't say (not Linux). */
function threadId() {
  try {
    return Number(readlinkSync('/proc/thread-self').split('/').pop());
  } catch {
    return 0;
  }
}

/** Mark the worker gone and wake everyone waiting on it: readers stop answering on their own. */
function markGone(shared: BigInt64Array) {
  Atomics.store(shared, 1, -1n);
  for (const i of [0, 1, 3]) Atomics.notify(shared, i);
}

/** What a write makes the server forget of its own caches: when it is sent, and again when it lands, since a read in
 * between caches what the file still holds. */
const FORGETS: Record<string, (store: Store, args: number[]) => void> = {
  deleteTicket: (store, [id]) => (store.forgetCards(), store.memory.forgetTicket(id)),
  setEventData: (store, [id]) => store.forgetCards(id),
  'memory.deleteTicket': (store, [id]) => store.memory.forgetTicket(id),
};

// A statement that writes, or a transaction: it waits for the whole queue, so the database never sees writes out of order.
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b|^\s*PRAGMA\s+[\w.]+\s*=|^\s*WITH\b[\s\S]*\)\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
/** How long a read waits for queued writes before it reads without them. */
export const READ_WAIT_MS = 50;
/** How long a write on the server's thread waits for the queue (it must come after it) before it is refused. */
const DRAIN_MS = 30_000;
/** A write here that waits this long for the queue goes in the health log, named (#1495): the stall stacks stop short of it. */
export const SLOW_DRAIN_MS = 500;
/** At most one stale-read row in the health log per this long: a day-long stall stays far under the log's row cap. */
const STALE_NOTE_MS = 60_000;

type Stmt = Record<'run' | 'get' | 'all' | 'iterate', (...a: unknown[]) => unknown>;
type Methods = Record<string, (...args: unknown[]) => unknown>;
/** The object a write's name ('addDelivery', 'props.set') lives on, and its method name: looked up by name, so untyped. */
const owner = (store: Store, name: string) => {
  const methods = store as unknown as Record<string, Methods>;
  const dot = name.indexOf('.');
  return dot < 0 ? { obj: store as unknown as Methods, method: name } : { obj: methods[name.slice(0, dot)], method: name.slice(dot + 1) };
};

export type Writer = {
  /** Wait for every queued write, at most `ms`. True if they all ran. `what` names the waiting write in the slow-wait log. */
  drain(ms?: number, what?: string): boolean;
  /** Writes sent and not yet run. */
  queued(): number;
  /** Stop the worker: writes run on the store's connection again. */
  stop(): Promise<number>;
  /** [0]: the last write run, [1]: the worker's state, [2]: the last write sent, [3]: steps closed, [4]: steps opened,
   * [5]: the worker's thread id. Reader threads wait on it (src/reader.ts). */
  shared: BigInt64Array;
};

/**
 * From now on the store's void writes (WRITES) run on a worker with its own connection, in the order they were called,
 * and return a promise of the write instead of nothing. Reads on the store's connection first wait up to READ_WAIT_MS
 * for writes still queued; writes there (VALUE_WRITES, and SQL run directly) wait for all of them. If the worker can't
 * start or stops, writes run on the store's connection again. Null for an in-memory store. `delayMs` holds every
 * write that long on the worker, for tests of a stalled disk; `drainMs` is how long a write here waits for the queue,
 * `readWaitMs` how long a read does, `staleNoteMs` how often a stale read is recorded (a test of what a read sees when the disk isn't stalled sets its "it hung" deadline: a loaded box takes over 50 ms now and then, #1656).
 */
export function writeOffThread(store: Store, { delayMs = 0, readyMs = 30_000, drainMs = DRAIN_MS, readWaitMs = READ_WAIT_MS, staleNoteMs = STALE_NOTE_MS } = {}): Writer | null {
  if (!store.statePath) return null;
  const db = store.db;
  // [0]: the last write run, [1]: 1 once the worker is ready, -1 once it is gone, [2]: the last write sent,
  // [3]: the steps whose every write has run (the worker's), [4]: the steps this thread has opened, [5]: the worker's
  // thread id.
  const shared = new BigInt64Array(new SharedArrayBuffer(48));
  const worker = new Worker(new URL(import.meta.url), { workerData: { writer: { path: store.path, shared, delayMs } } });
  worker.on('error', (err) => console.error(`DB write worker failed: ${thrown(err).stack ?? err}`));
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
  const pending = new Map<number, { name: string; args: unknown[]; resolve: (value?: unknown) => void; reject: (e: Error) => void }>();
  // Responses waiting for their request's writes (#1244): each until the write numbered `seq` has run.
  const waiters = new Set<{ seq: number; done: () => void }>();
  // Settings sent and not yet written, by key (null: deleted). A read that gave up waiting still sees them, or a
  // get-then-set (merge goes, turn nonces) would write back a list without the update before it.
  const unwritten = new Map<string, { seq: number; json: string | null }>();
  const applied = () => Number(Atomics.load(shared, 0));
  // Marked gone before its 'exit' reaches this thread: a write sent to it now would be lost.
  const gone = () => !alive || Atomics.load(shared, 1) !== 1n;
  // A step is one run of this thread's code (#1628): each write commits alone, so a reader thread reads only where no
  // step is half written, between one step's last write and the next one's first (src/reader.ts, atWholeStep). Its
  // first write of any kind opens it, before anything commits; the worker closes it after the step's last write.
  let stepOpen = false;
  const openStep = () => {
    if (stepOpen || !alive) return;
    stepOpen = true;
    const n = Atomics.add(shared, 4, 1n) + 1n;
    queueMicrotask(() => {
      stepOpen = false;
      try {
        worker.postMessage({ step: n });
      } catch {
        /* gone: readers stop waiting on steps once it is */
      }
    });
  };
  const unlist = busySource(() => (alive && seq > applied() ? [`${seq - applied()} queued DB writes`] : []));

  const waitFor = (target: number, ms: number) => {
    const until = Date.now() + ms;
    for (let done = applied(); done < target; done = applied()) {
      const left = until - Date.now();
      if (left <= 0 || Atomics.load(shared, 1) !== 1n) return false;
      if (Atomics.wait(shared, 0, BigInt(done), Math.min(left, GONE_CHECK_MS)) !== 'timed-out') continue;
      // A worker that ran out of memory wakes nobody, and its 'exit' can't reach this thread while it waits (#2130).
      const tid = Number(Atomics.load(shared, 5));
      if (tid && !existsSync(`/proc/self/task/${tid}`)) markGone(shared);
    }
    return true;
  };
  // Reads that went on past queued writes go in the health log (#1656, Cara 2026-11-22, "Count them first"): one row
  // per `staleNoteMs` at most, naming the read that gave up and counting the ones since the last row. An upper bound on
  // wrong answers: a read is counted whether or not the writes it passed touch what it reads.
  let staleAt = 0,
    staleMore = 0;
  const beforeRead = (sql?: string) => {
    const target = seq,
      behind = target - applied();
    if (!alive || behind <= 0) return;
    if (stalled && applied() < stalled) return void staleMore++;
    if (waitFor(target, readWaitMs)) return void (stalled = 0);
    stalled = target;
    const now = Date.now();
    if (now - staleAt < staleNoteMs || inline || db.isTransaction) return void staleMore++;
    const text = `${sql ? `SQL ${sql.trim().replace(/\s+/g, ' ').slice(0, 60)}` : 'a response'} on the server's thread waited ${readWaitMs} ms for ${behind} queued writes and read without them; ${staleMore} more reads passed queued writes since the last record`;
    (staleAt = now), (staleMore = 0);
    try {
      void store.addHealthEvent('db-read-stale', now, null, text);
    } catch {
      /* best effort */
    }
  };
  const drain = (ms = drainMs, what = 'a drain') => {
    const t0 = Date.now(),
      target = seq,
      took = target - applied();
    const ok = !alive || waitFor(target, ms);
    const waited = Date.now() - t0;
    if (waited >= SLOW_DRAIN_MS) {
      const text = `${what} on the server's thread waited ${waited} ms for ${took} queued writes${ok ? '' : ' and gave up'}`;
      console.error(`DB write: ${text}.`);
      // Sent to the worker behind the writes it waited for, so it adds no wait; inside a write or transaction here it would run here.
      if (alive && !inline && !db.isTransaction)
        try {
          void store.addHealthEvent('db-write-wait', t0, null, text);
        } catch {
          /* best effort */
        }
    }
    return ok;
  };
  // After its own request's writes (landed, below), a response waits a moment for everyone else's, as a read does.
  writes.settle = () => beforeRead();
  // A response waits for its own request's writes, however long they take, but off the event loop: a client's next
  // request (an invite link right after making the person) or a client reading the file itself finds them (#1244).
  writes.landed = (everyone = false) => {
    const own = everyone ? seq : (writes.request.getStore()?.seq ?? 0);
    if (!alive || applied() >= own) return null;
    return new Promise<void>((resolve) => {
      const w = { seq: own, done: () => (clearTimeout(timer), waiters.delete(w), resolve()) };
      const timer = setTimeout(() => {
        console.error(`A response waited ${drainMs} ms for its request's DB writes, ${own - applied()} still queued, and went without them.`);
        w.done();
      }, drainMs).unref();
      waiters.add(w);
    });
  };
  // A write here after a queue it can't wait out would land before writes made earlier: refuse it instead. If the
  // worker is gone, the queue is lost anyway and its 'exit' puts writes back on this thread.
  const beforeWrite = (what: string) => {
    if (alive && applied() < seq && !drain(drainMs, what) && Atomics.load(shared, 1) === 1n) {
      throw new Error(`DB write refused: the write worker is still ${seq - applied()} writes behind after ${drainMs} ms`);
    }
  };

  // A raw statement's wait names the code that ran it: 'SQL BEGIN' alone didn't say whose transaction waited 20.5 s (#1877).
  const sqlWhat = (sql: string) => {
    const at = new Error().stack
      ?.split('\n')
      .slice(3)
      .find((l) => !l.includes('db-writer.ts'));
    const fn = at && /at (?:async )?([\w$.<>]+) \(/.exec(at)?.[1];
    return `SQL ${sql.trim().replace(/\s+/g, ' ').slice(0, 60)}${fn ? ` (in ${fn})` : ''}`;
  };
  // The store's connection: reads wait a moment for queued writes, and its own writes for all of them.
  const maxEvent = db.prepare('SELECT max(id) AS id FROM events');
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string, ...rest: never[]) => {
    const st = prepare(sql, ...rest) as StatementSync;
    const before = WRITE_SQL.test(sql) ? () => (openStep(), applied() < seq && beforeWrite(sqlWhat(sql))) : () => beforeRead(sql);
    for (const m of ['run', 'get', 'all', 'iterate'] as const) {
      const f = (st as Stmt)[m].bind(st);
      (st as Stmt)[m] = (...a: unknown[]) => {
        if (!db.isTransaction) before();
        return f(...a);
      };
    }
    return st;
  }) as typeof db.prepare;
  const exec = db.exec.bind(db);
  db.exec = ((sql: string) => {
    openStep();
    if (!db.isTransaction && applied() < seq) beforeWrite(sqlWhat(sql));
    return exec(sql);
  }) as typeof db.exec;

  // Ids for addEvent, handed out here so it can return its row at once: past every id already written, and every id
  // handed out (a deleted newest event's id isn't reused while the server runs).
  store.eventIds = { next: 0, floor: () => ((maxEvent.get() as { id: number | null }).id ?? 0) + 1 };

  const getSetting = store.getSetting.bind(store);
  store.getSetting = (<T>(key: string): T | null => {
    const u = unwritten.get(key);
    if (u && !gone() && applied() < u.seq) return u.json === null ? null : JSON.parse(u.json);
    if (u) unwritten.delete(key);
    return getSetting<T>(key);
  }) as typeof store.getSetting;

  for (const name of VALUE_WRITES) {
    const { obj, method } = owner(store, name);
    const f = obj[method];
    if (typeof f !== 'function') throw new Error(`db-writer: no ${name} to run on the server's thread`);
    obj[method] = function (this: unknown, ...args: unknown[]) {
      openStep();
      beforeWrite(name);
      inline++;
      // Only its synchronous part: memory.index awaits embeddings for minutes, and other writes meanwhile go to the worker.
      try {
        return f.apply(this, args);
      } finally {
        inline--;
      }
    };
  }
  for (const name of ASYNC_WRITES) {
    const { obj, method } = owner(store, name);
    const f = obj[method];
    if (typeof f !== 'function') throw new Error(`db-writer: no ${name} to send to the write worker`);
    obj[method] = function (this: unknown, ...args: unknown[]) {
      openStep();
      if (gone() || inline || db.isTransaction) return f.apply(this, args);
      const n = send(name, args);
      if (n === null) {
        beforeWrite(name);
        return f.apply(this, args);
      }
      return new Promise((resolve, reject) => pending.set(n, { name, args, resolve, reject }));
    };
  }
  // Post a write to the worker as the next in the queue; null if postMessage can't copy its arguments.
  const send = (name: string, args: unknown[]) => {
    const n = seq + 1;
    try {
      worker.postMessage({ seq: n, name, args });
    } catch (e) {
      console.error(`DB write ${name} can't go to the write worker (${thrown(e).message ?? e}): run on the server's thread.`);
      return null;
    }
    seq = n;
    Atomics.store(shared, 2, BigInt(n));
    const req = writes.request.getStore();
    if (req && !req.done) req.seq = n;
    return n;
  };
  for (const name of WRITES) {
    const { obj, method } = owner(store, name);
    const f = obj[method];
    if (typeof f !== 'function') throw new Error(`db-writer: no ${name} to send to the write worker`);
    obj[method] = function (this: unknown, ...args: unknown[]) {
      openStep();
      // Inside a transaction or another write on this thread it runs with that, or the worker would wait on our lock.
      if (gone() || inline || db.isTransaction) return f.apply(this, args);
      const n = send(name, args);
      if (n === null) {
        // An argument postMessage can't copy: run it here, after the queue.
        beforeWrite(name);
        return f.apply(this, args);
      }
      if (name === 'setSetting') unwritten.set(args[0] as string, { seq: n, json: JSON.stringify(args[1]) });
      else if (name === 'deleteSetting') unwritten.set(args[0] as string, { seq: n, json: null });
      else if (name === 'setSettings') {
        for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) unwritten.set(k, { seq: n, json: JSON.stringify(v) });
        for (const k of (args[1] as string[] | undefined) ?? []) unwritten.set(k, { seq: n, json: null });
      }
      // The server's connection must not checkpoint either while the checkpoint worker does (src/checkpoint.ts).
      else if (name === 'autoCheckpoint') exec(`PRAGMA wal_autocheckpoint = ${args[0] ? 1000 : 0}`);
      FORGETS[name]?.(store, args as number[]);
      const p = new Promise<unknown>((resolve, reject) => pending.set(n, { name, args, resolve, reject }));
      p.catch(() => {
        /* logged by the worker; a caller that awaits sees it */
      });
      return p;
    };
  }

  worker.on('message', ({ seq: n, error, value }: { seq: number; error?: string; value?: unknown }) => {
    const p = pending.get(n);
    pending.delete(n);
    if (p) FORGETS[p.name]?.(store, p.args as number[]);
    if (error) p?.reject(new Error(error));
    else p?.resolve(value);
    for (const w of waiters) if (applied() >= w.seq) w.done();
  });
  worker.once('exit', (code) => {
    // Here too: terminate() and running out of memory kill the worker without running its own 'exit' handler (#2130).
    markGone(shared);
    alive = false;
    unlist();
    unwritten.clear();
    const lost = seq - applied();
    seq = applied();
    Atomics.store(shared, 2, BigInt(seq));
    for (const p of pending.values()) p.reject(new Error('the DB write worker stopped'));
    pending.clear();
    for (const w of waiters) w.done();
    console.error(`DB write worker stopped (exit code ${code})${lost ? `, ${lost} queued writes lost` : ''}: writes run on the server's thread again.`);
    try {
      store.addHealthEvent('db-writer-stopped', Date.now(), null, `exit code ${code}, ${lost} queued writes lost`);
    } catch {
      /* the health log is best effort */
    }
  });

  // However the server stops, what it queued is written first (the worker runs until the process is gone), and
  // writes made later at exit (the runner-load samples, #791) run here.
  process.on('exit', () => {
    if (alive && !drain(10_000, 'the exit')) console.error(`DB write worker: ${seq - applied()} queued writes not written by exit.`);
    alive = false;
  });
  // Code that is already async waits for the queue here, off the event loop, before a write on this thread (#1877).
  store.allWritten = () => writes.landed?.(true) ?? null;
  worker.unref(); // after the listeners: adding one refs the worker again
  console.log(`DB writes run on a worker thread (started in ${readyMs - (until - Date.now())} ms).`);
  return { drain, queued: () => seq - applied(), stop: () => worker.terminate(), shared };
}

if (!isMainThread && workerData?.writer) {
  const { path, shared, delayMs } = workerData.writer as { path: string; shared: BigInt64Array; delayMs: number };
  // Sooner than the server's handler, which can't run while that thread is blocked in a drain.
  process.on('exit', () => markGone(shared));
  const store = new Store(path, { writer: true });
  Atomics.store(shared, 5, BigInt(threadId()));
  Atomics.store(shared, 1, 1n);
  Atomics.notify(shared, 1);
  const pause = delayMs ? new Int32Array(new SharedArrayBuffer(4)) : null;
  // How long the write waited for another connection's write lock: a try with no busy wait first, so a free lock costs
  // two statements, and only a held one (SQLITE_BUSY) is waited out and timed. Lock first, then the write: what is left of a
  // slow write is time inside it, the disk. shortcut: a connection that takes the lock between the two is counted as writing.
  const lockWait = () => {
    try {
      store.db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK;');
      return 0;
    } catch {
      if (store.db.isTransaction) store.db.exec('ROLLBACK');
    } finally {
      store.db.exec(`PRAGMA busy_timeout = ${WRITER_BUSY_MS}`);
    }
    const t0 = performance.now();
    try {
      store.db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    } catch {
      if (store.db.isTransaction) store.db.exec('ROLLBACK');
    }
    return Math.max(1, Math.round(performance.now() - t0));
  };
  const run = async ({ seq, name, args, step }: { seq: number; name: string; args: unknown[]; step?: bigint }) => {
    // Every write of the step was sent before this, so all of them have run.
    if (step) return (Atomics.store(shared, 3, step), Atomics.notify(shared, 3));
    const t0 = performance.now();
    const locked = lockWait();
    if (pause) Atomics.wait(pause, 0, 0, delayMs);
    let error: string | undefined;
    let value: unknown;
    try {
      const { obj, method } = owner(store, name);
      // An ASYNC_WRITES method's body runs at once; awaiting it only unwraps the value.
      value = await obj[method](...args);
    } catch (e) {
      error = String(thrown(e).message ?? e);
      console.error(`DB write ${name} failed on the write worker: ${thrown(e).stack ?? e}`);
      try {
        store.addHealthEvent('db-write-error', Date.now(), null, `${name}: ${error}`.slice(0, 2000));
      } catch {
        /* the health log is best effort */
      }
    }
    const took = Math.round(performance.now() - t0);
    Atomics.store(shared, 0, BigInt(seq));
    Atomics.notify(shared, 0);
    try {
      parentPort!.postMessage({ seq, error, value });
    } catch (e) {
      parentPort!.postMessage({ seq, error: `its value can't go back to the server's thread: ${thrown(e).message ?? e}` });
    }
    if (took >= SLOW_DRAIN_MS) {
      const text = `${name} took ${took} ms on the write worker: ${locked ? `${locked} ms waiting for another connection's write lock (SQLITE_BUSY)` : 'the write lock was free'}; ${took - locked} ms writing`;
      console.error(`DB write: ${text}.`);
      try {
        store.addHealthEvent('db-write-slow', Date.now(), null, text);
      } catch {
        /* the health log is best effort */
      }
    }
  };
  // One at a time, in the order sent: the chain keeps an awaited value write's successor from starting before it ends.
  let chain: Promise<unknown> = Promise.resolve();
  parentPort!.on('message', (m) => {
    chain = chain.then(() => run(m)).catch((e) => console.error(`DB write worker: ${thrown(e).stack ?? e}`));
  });
}
