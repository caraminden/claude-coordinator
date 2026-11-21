import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { READ_WAIT_MS, VALUE_WRITES, WRITES, writeOffThread, type Writer } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';
import { json, ownWrites, writes } from '../src/http.ts';
import { until } from './wait.ts';

// #795: with WAL and synchronous=NORMAL, the first write after a checkpoint fsyncs the WAL's new header on the
// writer's thread, and on the event loop a stalled disk held the whole server (14.3 s, #791). The server's void
// writes run on a worker of their own; `delayMs` stands in for the stalled fsync.
const root = mkdtempSync(join(tmpdir(), 'db-writer-'));
const writers: Writer[] = [];
after(async () => {
  for (const w of writers) await w.stop();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const open = (delayMs = 0, drainMs?: number) => {
  const dir = join(root, String(++n));
  execFileSync('mkdir', ['-p', dir]);
  const store = new Store(join(dir, 'coordinator.db'));
  const w = writeOffThread(store, { delayMs, drainMs })!;
  writers.push(w);
  return { store, w };
};
const ticket = (store: Store) => {
  const p = store.createProject(`p${n}`, null);
  return store.createTicket({ project_id: p.id, title: 'a minion', permission_mode: 'default', created_by: 'cara' });
};

test('a write on a stalled disk never holds the event loop; reads go on, stale, until it lands', async () => {
  const { store, w } = open(400);
  const t = ticket(store);
  const title = () => store.getTicket(t.id)!.title;
  w.drain();
  let worst = 0, last = performance.now();
  const tick = setInterval(() => { worst = Math.max(worst, performance.now() - last); last = performance.now(); }, 10);
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) store.updateTicket(t.id, { title: `new ${i}` }); // 1.6 s of writes on the worker
  assert.ok(performance.now() - t0 < 100, 'sending writes is instant');
  // The first read waits READ_WAIT_MS for them, then reads without; the next doesn't wait again.
  const r0 = performance.now();
  assert.equal(title(), 'a minion');
  assert.ok(performance.now() - r0 < READ_WAIT_MS + 100);
  const r1 = performance.now();
  for (let i = 0; i < 20; i++) assert.equal(title(), 'a minion');
  assert.ok(performance.now() - r1 < 50, 'later reads skip the wait while the disk is stalled');
  await until('the queued writes to land', () => !w.queued(), 15_000);
  clearInterval(tick);
  assert.ok(performance.now() - t0 >= 1500, 'the writes really were slow');
  assert.ok(worst < 200, `the event loop was held ${Math.round(worst)} ms`);
  assert.equal(title(), 'new 3', 'they landed in order');
});

test('a read right after a write sees it, and writes land in the order they were made', () => {
  const { store } = open();
  for (let i = 0; i < 50; i++) {
    store.setSetting('k', i);
    if (i % 3 === 0) store.deleteSetting('k');
    assert.equal(store.getSetting('k'), i % 3 === 0 ? null : i);
  }
  const t = ticket(store);
  store.updateTicket(t.id, { title: 'renamed' });
  assert.equal(store.getTicket(t.id)!.title, 'renamed');
});

test('a get-then-set of a setting on a stalled disk keeps every update', () => {
  const { store, w } = open(300);
  const push = (v: string) => store.setSetting('goes', [...(store.getSetting<string[]>('goes') ?? []), v]);
  push('cara'); push('josh'); push('cody');
  assert.deepEqual(store.getSetting('goes'), ['cara', 'josh', 'cody'], 'read before they land');
  store.deleteSetting('goes');
  assert.equal(store.getSetting('goes'), null);
  store.setSetting('goes', ['again']);
  assert.ok(w.drain());
  assert.deepEqual(store.getSetting('goes'), ['again'], 'and the file agrees once they land');
});

test('a card\'s cached row is dropped again when its change lands, not only when it is sent', async () => {
  const { store, w } = open(150);
  const t = ticket(store);
  const e = store.addEvent(t.id, 'plan', { id: 'c1', status: 'pending' });
  w.drain();
  const card = () => JSON.parse(store.recentCards(t.project_id, 10).find((c) => c.id === e.id)!.data).status;
  assert.equal(card(), 'pending');
  const landed = store.setEventData(e.id, { id: 'c1', status: 'approved' }) as unknown as Promise<void>;
  assert.equal(card(), 'pending', 'read while the change is still queued');
  await landed;
  assert.equal(card(), 'approved');
});

test('turning autocheckpoint off reaches the server\'s own connection at once', () => {
  const { store } = open(200);
  const pragma = () => (store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
  store.autoCheckpoint(false);
  assert.equal(pragma(), 0);
  store.autoCheckpoint(true);
  assert.equal(pragma(), 1000);
});

test('a write on the server\'s thread that can\'t wait out the queue is refused, not run ahead of it', () => {
  const { store, w } = open(300, 50);
  store.setSetting('k', 'queued');
  assert.throws(() => store.createProject('late', null), /refused.*1 writes behind/);
  assert.ok(w.drain(2000));
  assert.equal(store.createProject('late', null).name, 'late');
  assert.equal(store.getSetting('k'), 'queued');
});

test('a void write returns a promise of its own write; a failed one rejects and is in the health log', async () => {
  const { store } = open();
  await store.setSetting('k', 1);
  store.createMachine('one', '', 'cara', null);
  const two = store.createMachine('two', '', 'cara', null);
  await assert.rejects(store.updateMachine(two.id, { name: 'one' }) as unknown as Promise<void>, /UNIQUE/);
  assert.equal(store.getMachine(two.id)!.name, 'two');
  assert.equal(store.healthCount('db-write-error', 0, Date.now() + 1000).count, 1);
});

test('addEvent hands out ids at once, past any row another connection wrote', () => {
  const { store, w } = open(50);
  const t = ticket(store);
  const a = store.addEvent(t.id, 'note', { text: 'a' });
  const b = store.addEvent(t.id, 'user_message', { text: 'b', author: 'cara' });
  assert.equal(b.id, a.id + 1);
  w.drain();
  const other = new DatabaseSync(store.path);
  other.prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)').run(t.id, 'note', '{}', Date.now());
  other.close();
  const c = store.addEvent(t.id, 'note', { text: 'c' });
  assert.equal(c.id, b.id + 2);
  w.drain();
  assert.deepEqual(store.listEvents(t.id).map((e) => [e.id, JSON.parse(e.data).text ?? null]), [[a.id, 'a'], [b.id, 'b'], [b.id + 1, null], [c.id, 'c']]);
});

test('a write that returns a value waits for the queue, and what it writes inside runs with it', () => {
  const { store } = open(30);
  store.setSetting('before', 1);
  const t = ticket(store); // createTicket: after the queued setting, on this thread
  assert.equal(store.getSetting('before'), 1);
  assert.equal(store.getTicket(t.id)!.title, 'a minion');
});

test('a read in a request still waits only READ_WAIT_MS; awaiting its own writes, it sees them, off the event loop (#1244)', async () => {
  const { store, w } = open(READ_WAIT_MS * 3);
  const has = (key: string) => store.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined;
  await writes.request.run({ seq: 0 }, async () => {
    store.setSetting('mine', 1);
    const t0 = performance.now();
    assert.equal(has('mine'), false, 'a read gives up waiting: the disk is "stalled"');
    assert.ok(performance.now() - t0 < READ_WAIT_MS + 100, 'and never holds the server longer than any read');
    await ownWrites();
    assert.equal(has('mine'), true, 'once it has awaited its own writes, it sees them');
    writes.request.getStore()!.done = true;
    store.setSetting('later', 1);
    assert.equal(writes.landed!(), null, 'once its response is sent, work it started is no longer its own');
  });
  assert.ok(w.drain());
});

test('a response waits for its own request\'s writes, however slow, off the event loop (#1244)', async () => {
  const { store, w } = open(READ_WAIT_MS * 3);
  const seen = () => {
    const other = new DatabaseSync(store.path, { readOnly: true });
    try { return other.prepare("SELECT value FROM settings WHERE key = 'seen'").get()?.value; } finally { other.close(); }
  };
  store.setSetting('other', 'not this request\'s');
  assert.equal(writes.request.run({ seq: 0 }, () => writes.landed!()), null, 'a request that wrote nothing waits for nothing');
  await writes.request.run({ seq: 0 }, async () => {
    store.setSetting('seen', 'yes');
    let worst = 0, last = performance.now();
    const tick = setInterval(() => { worst = Math.max(worst, performance.now() - last); last = performance.now(); }, 10);
    await writes.landed!();
    clearInterval(tick);
    assert.equal(seen(), '"yes"', 'a client reading the file sees it');
    assert.ok(worst < 100, `the event loop was held ${Math.round(worst)} ms`);
    assert.equal(writes.landed!(), null, 'once they have landed, nothing to wait for');
  });
  w.drain();
});

test('a response whose own writes outlast the wait goes out once, without them (#1244)', async () => {
  const { store, w } = open(READ_WAIT_MS * 20, READ_WAIT_MS * 2);
  const sent: number[] = [];
  const res = { destroyed: false, headersSent: false, writeHead() { this.headersSent = true; }, end() { sent.push(performance.now()); } };
  const t0 = performance.now();
  writes.request.run({ seq: 0 }, () => {
    store.setSetting('slow', 1);
    json(res as never, 200, { ok: true });
  });
  await until('the reply goes out', () => sent.length > 0);
  assert.ok(sent[0] - t0 < READ_WAIT_MS * 15, `sent after ${Math.round(sent[0] - t0)} ms, not held until the write landed`);
  assert.ok(w.drain(5000), 'the write lands');
  assert.equal(sent.length, 1, 'sent once, never held again');
});

test('if the worker stops, writes run on the server\'s thread again', async () => {
  const { store, w } = open();
  await w.stop();
  const r = store.setSetting('k', 'inline');
  assert.equal(r, undefined, 'run here, not sent');
  assert.equal(store.getSetting('k'), 'inline');
  assert.equal(store.healthCount('db-writer-stopped', 0, Date.now() + 1000).count, 1);
});

test('writes still queued when the process exits are written first, and writes made at exit too', () => {
  const dir = join(root, 'exit');
  execFileSync('mkdir', ['-p', dir]);
  const script = join(dir, 'exit.ts');
  writeFileSync(script, `
    import { Store } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'db.ts'))};
    import { writeOffThread } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'db-writer.ts'))};
    const store = new Store(${JSON.stringify(join(dir, 'coordinator.db'))});
    writeOffThread(store, { delayMs: 20 });
    for (let i = 0; i < 10; i++) store.setSetting('k' + i, i);
    process.on('exit', () => store.setSetting('at exit', 1));
    process.exit(0);
  `);
  execFileSync(process.execPath, [script]);
  const db = new DatabaseSync(join(dir, 'coordinator.db'), { readOnly: true });
  assert.equal((db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'k%' OR key = 'at exit'").get() as { n: number }).n, 11);
  db.close();
});

// #1285: writes added to the Store after #795 (touch, on every chat message) missed both lists and held the server on a
// slow disk. Every method whose source runs a statement is in WRITES, VALUE_WRITES or here, with why.
const STAYS_ON_THREAD: Record<string, string> = {
  // The constructor's one-time migrations: they run before the writer starts.
  ...Object.fromEntries(['attachState', 'moveSharedViews', 'serverLoginOwnerOnly', 'groupByType', 'closedAtFromNotes', 'dropEarlyPeekAurasBuilds',
    'shippingFromRules', 'lendingLists', 'numberTickets', 'settleBuilds', 'props.seed', 'props.insertSeed'].map((m) => [m, 'boot'])),
  // Helpers that run inside a listed write, with it.
  // The usage ledger batches counts in memory and flushes on the server's thread on a timer (#1306).
  'usage.flush': 'the ledger\'s own timer', 'usage.prune': 'the ledger\'s own timer', 'usage.rows': 'an admin read that flushes first',
  dropAudit: 'inside sweepTurnAudit and deleteTurnAudit',
  'props.insertValue': 'inside props.registerValues and props.review',
  'props.putStage': 'inside props.statusChanged',
  'props.statusChanged': 'inside updateTicket',
  'props.startStage': 'no callers',
  // Not moved yet: rare, or they write only now and then and would wait for the queue on every call as a VALUE_WRITE.
  ...Object.fromEntries(['putSecret', 'deleteSecret', 'splitScheme', 'putClaudeState', 'forgetJobKind', 'props.backfill', 'schedules.setBrief',
    'schedules.categorize', 'reviews.ensureAgents', 'reviews.recordRun', 'reviews.recordVerdict', 'reviews.removeVerdict', 'reviews.recordRefutes',
    'reviews.removeLesson', 'reviews.backfill', 'claims.take', 'claims.release', 'claims.releaseHeldBy', 'claims.setQueue', 'claims.passOn', 'lessons.add', 'lessons.take', 'ideas.upsert',
    'ideas.restatus', 'ideas.linkStarts', 'ideas.sync', 'ideas.laterNote', 'minionIndex.indexTicket', 'minionIndex.syncHandoffs',
    'minionIndex.deleteTicket', 'memoryProposals.create', 'memoryProposals.decide', 'memoryProposals.restored', 'memoryProposals.prune', 'ideas.edit',
    'ideas.linkHandoff', 'ideas.fromHandoff', 'ideas.join', 'ideas.readPage', 'ideas.now', 'ideas.fromChat', 'ideas.soon', 'minionIndex.indexClosed'].map((m) => [m, 'not moved yet'])),
};

test('every Store method that writes is sent to the worker or listed as staying on the server\'s thread (#1285)', () => {
  const store = new Store(join(root, 'lists.db')) as any;
  const listed = new Set<string>([...WRITES, ...VALUE_WRITES]);
  const runsSql = /\.run\(|\bdb\.exec\(|[`'"]\s*(INSERT|UPDATE|DELETE|REPLACE)\s/i;
  const writers: string[] = [];
  const scan = (obj: object, prefix: string) => {
    const src = new Map<string, string>();
    for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        const f = Object.getOwnPropertyDescriptor(p, k)!.value;
        if (k !== 'constructor' && typeof f === 'function' && !src.has(k)) src.set(k, f.toString());
      }
    }
    // A method writes if it runs a statement, or calls a method of its own object that does and is in neither list
    // (a listed one it calls is sent or waits by itself).
    const found = new Set([...src].filter(([, s]) => runsSql.test(s)).map(([k]) => k));
    for (let grew = true; grew;) {
      grew = false;
      const via = [...found].filter((w) => !listed.has(prefix + w));
      for (const [k, s] of src) if (!found.has(k) && via.some((w) => s.includes(`this.${w}(`))) found.add(k), (grew = true);
    }
    writers.push(...[...found].map((k) => prefix + k));
  };
  scan(store, '');
  // Its parts with writes of their own (props, schedules, memory, reviews and the rest): the lists name them `part.method`.
  for (const [k, v] of Object.entries(store)) {
    if (v && typeof v === 'object' && v !== store.db && !(v instanceof Map) && !(v instanceof Set) && Object.getPrototypeOf(v) !== Object.prototype) scan(v, `${k}.`);
  }
  assert.ok(writers.includes('touch') && writers.includes('props.set'), 'the scan finds writes, its own and its parts\'');
  const missed = writers.filter((m) => !listed.has(m) && !(m in STAYS_ON_THREAD));
  assert.deepEqual(missed, [], `these write but are in neither WRITES nor VALUE_WRITES (src/db-writer.ts): ${missed.join(', ')}. A void write goes in WRITES, one whose result its callers use in VALUE_WRITES.`);
  const stale = Object.keys(STAYS_ON_THREAD).filter((m) => !writers.includes(m) || listed.has(m));
  assert.deepEqual(stale, [], 'listed as staying on the server\'s thread, but gone, no longer writing, or now in a list');
});
