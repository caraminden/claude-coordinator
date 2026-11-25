import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { ASYNC_WRITES, READ_WAIT_MS, SLOW_DRAIN_MS, VALUE_WRITES, WRITES, writeOffThread, type Writer } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';
import { json, ownWrites, writes } from '../src/http.ts';
import { attachEventsIfThere } from '../src/events-db.ts';
import { atWholeStep } from '../src/reader.ts';
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
const open = (delayMs = 0, drainMs?: number, readWaitMs?: number, staleNoteMs?: number) => {
  const dir = join(root, String(++n));
  execFileSync('mkdir', ['-p', dir]);
  const store = new Store(join(dir, 'coordinator.db'));
  const w = writeOffThread(store, { delayMs, drainMs, readWaitMs, staleNoteMs })!;
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
  let worst = 0,
    last = performance.now();
  const tick = setInterval(() => {
    worst = Math.max(worst, performance.now() - last);
    last = performance.now();
  }, 10);
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) store.updateTicket(t.id, { title: `new ${i}` }); // 1.6 s of writes on the worker
  // Sending didn't wait for the worker: the writes are still queued (and `worst` below shows no send held the loop).
  assert.ok(w.queued(), 'sending writes is instant: they are still queued');
  // The first read waits READ_WAIT_MS for them, then reads without (stale, the queue still there); the next don't wait again.
  assert.equal(title(), 'a minion');
  assert.ok(w.queued(), 'the read gave up waiting instead of waiting out the queue');
  // Waiting READ_WAIT_MS on every read would let the 1.6 s of writes land within ~32 reads and the title flip to 'new 3'.
  for (let i = 0; i < 60; i++) assert.equal(title(), 'a minion', 'later reads skip the wait while the disk is stalled');
  await until('the queued writes to land', () => !w.queued(), 15_000);
  clearInterval(tick);
  assert.ok(performance.now() - t0 >= 1500, 'the writes really were slow');
  // timing-ok: a true speed bound (the loop is never held), listed for a bench in #1444
  assert.ok(worst < 200, `the event loop was held ${Math.round(worst)} ms`);
  assert.equal(title(), 'new 3', 'they landed in order');
});

test('a read right after a write sees it, and writes land in the order they were made', () => {
  // The read waits for its write however long a loaded box takes over it: the 50 ms a live read waits is its "the disk
  // is stalled" line, and a CI runner crossed it (#1656). What a read does past that line is the test above's.
  const { store } = open(0, undefined, 30_000);
  for (let i = 0; i < 50; i++) {
    store.setSetting('k', i);
    if (i % 3 === 0) store.deleteSetting('k');
    assert.equal(store.getSetting('k'), i % 3 === 0 ? null : i);
  }
  const t = ticket(store);
  store.updateTicket(t.id, { title: 'renamed' });
  assert.equal(store.getTicket(t.id)!.title, 'renamed');
});

// #1628: a reader thread reads in a transaction begun at a whole step of the server's thread (src/reader.ts).
const stepsClosed = (w: Writer) => until('the steps close', () => Atomics.load(w.shared, 3) >= Atomics.load(w.shared, 4));

test('a reader pinned at a whole step keeps the main, state and chat files as they were, until it ends', async () => {
  const { store, w } = open();
  const t = ticket(store);
  await stepsClosed(w);
  const reader = new Store(store.path, { reader: true });
  const states = () => (reader.db.prepare('SELECT count(*) AS n FROM state.claude_state').get() as { n: number }).n;
  const before = reader.listEvents(t.id).length;
  assert.notEqual(atWholeStep(reader.db, w.shared), null);
  store.updateTicket(t.id, { title: 'later' });
  store.addEvent(t.id, 'note', { text: 'later' });
  store.db.prepare('INSERT INTO state.claude_state (path, project_id, size, mtime, data) VALUES (?, ?, 0, 0, ?)').run('x', t.project_id, new Uint8Array());
  assert.ok(w.drain());
  assert.deepEqual([reader.getTicket(t.id)!.title, reader.listEvents(t.id).length, states()], ['a minion', before, 0]);
  reader.db.exec('ROLLBACK');
  assert.deepEqual([reader.getTicket(t.id)!.title, reader.listEvents(t.id).length, states()], ['later', before + 1, 1]);
});

test("a step the server's thread opened holds readers off until its last write has run, then they see all of it", async () => {
  const { store, w } = open(200);
  const t = ticket(store);
  await stepsClosed(w);
  const reader = new Store(store.path, { reader: true });
  store.updateTicket(t.id, { title: 'one' });
  store.updateTicket(t.id, { status: 'running' });
  // Held 200 ms on the writer: no whole step within a reader's wait.
  assert.equal(atWholeStep(reader.db, w.shared, 20), null);
  await until('the step closes', () => atWholeStep(reader.db, w.shared, 20) !== null);
  const seen = reader.getTicket(t.id)!;
  reader.db.exec('ROLLBACK');
  assert.deepEqual([seen.title, seen.status], ['one', 'running']);
});

test('a get-then-set of a setting on a stalled disk keeps every update', () => {
  const { store, w } = open(300);
  const push = (v: string) => store.setSetting('goes', [...(store.getSetting<string[]>('goes') ?? []), v]);
  push('cara');
  push('josh');
  push('cody');
  assert.deepEqual(store.getSetting('goes'), ['cara', 'josh', 'cody'], 'read before they land');
  store.deleteSetting('goes');
  assert.equal(store.getSetting('goes'), null);
  store.setSetting('goes', ['again']);
  assert.ok(w.drain());
  assert.deepEqual(store.getSetting('goes'), ['again'], 'and the file agrees once they land');
});

test("a write inside a transaction on the server's thread goes with it, rolled back or kept", () => {
  const { store, w } = open();
  const keys = () =>
    store.db
      .prepare("SELECT key FROM settings WHERE key LIKE 'tx-%' ORDER BY key")
      .all()
      .map((r) => (r as { key: string }).key);
  for (const end of ['ROLLBACK', 'COMMIT']) {
    store.db.exec('BEGIN IMMEDIATE');
    store.setSetting(`tx-${end}`, 1);
    store.db.exec(end);
  }
  assert.ok(w.drain());
  assert.deepEqual(keys(), ['tx-COMMIT']);
});

test("SQL run straight on the server's connection, and a write the worker can't be sent, come after what is queued", () => {
  const { store, w } = open(50);
  store.setSetting('by-sql', 'queued');
  store.db.exec(`UPDATE settings SET value = '"sql"' WHERE key = 'by-sql'`);
  store.setSetting('unsendable', 'queued');
  store.setSetting('unsendable', { last: true, f() {} }); // a function: postMessage can't copy it
  assert.ok(w.drain());
  assert.deepEqual([store.getSetting('by-sql'), store.getSetting('unsendable')], ['sql', { last: true }]);
});

test('a key setSettings removes reads as gone at once, on a stalled disk', () => {
  const { store } = open(300);
  store.setSettings({ kept: 1, removed: 1 });
  store.setSettings({ kept: 2 }, ['removed']);
  assert.deepEqual([store.getSetting('kept'), store.getSetting('removed')], [2, null]);
});

test("a card's cached row is dropped when its change is sent, so a read that waits for the write sees it", () => {
  const { store } = open(0, undefined, 30_000); // the read waits until the write lands, before the server hears it has
  const t = ticket(store);
  const e = store.addEvent(t.id, 'plan', { id: 'c1', status: 'pending' });
  const card = () => JSON.parse(store.recentCards(t.project_id, 10).find((c) => c.id === e.id)!.data).status;
  assert.equal(card(), 'pending');
  store.setEventData(e.id, { id: 'c1', status: 'approved' });
  assert.equal(card(), 'approved');
});

test("a card's cached row is dropped again when its change lands, not only when it is sent", async () => {
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

test("a machine's or a job's write is read back at once even on a stalled disk: the code acts on it next (main red, Nov 21)", () => {
  const { store, w } = open(200);
  const id = store.createMachine('box', 'x', 'cara', null).id;
  w.drain();
  // A queued write would leave these stale past READ_WAIT_MS: setLend then told the agent the lend from before.
  store.updateMachine(id, { lend: JSON.stringify({ server: 'own', workspaces: [] }) });
  assert.equal(JSON.parse(store.getMachine(id)!.lend!).server, 'own');
  store.allowJobKind(id, 'h', 'k', '{}', 'cara');
  assert.ok(store.jobKind(id, 'h'), 'a standing go is there for the start that follows it');
});

test("turning autocheckpoint off reaches the server's own connection at once", () => {
  const { store } = open(200);
  const pragma = () => (store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
  store.autoCheckpoint(false);
  assert.equal(pragma(), 0);
  store.autoCheckpoint(true);
  assert.equal(pragma(), 1000);
});

test("a write on the server's thread that can't wait out the queue is refused, not run ahead of it", () => {
  const { store, w } = open(300, 50);
  store.setSetting('k', 'queued');
  assert.throws(() => store.createProject('late', null), /refused.*1 writes behind/);
  assert.ok(w.drain(2000));
  assert.equal(store.createProject('late', null).name, 'late');
  assert.equal(store.getSetting('k'), 'queued');
});

test("a write on the server's thread that waits long for the queue is named in the health log (#1495)", () => {
  const { store, w } = open(SLOW_DRAIN_MS + 200);
  store.setSetting('k', 'queued');
  store.createProject('late', null); // a VALUE_WRITES call: waits out the slow write ahead of it
  assert.ok(w.drain(5000), 'the wait record, queued behind it, lands');
  const rows = store.healthEventsSince(['db-write-wait'], 0);
  assert.equal(rows.length, 1);
  assert.match(rows[0].detail, /^createProject on the server's thread waited \d+ ms for 1 queued writes$/);
});

// #1877: on Nov 24 a db-write-wait said the server waited 20.5 s for 3 queued writes, and nothing said why the worker took
// that long. The worker names each slow write itself: the time it waited for another connection's write lock, and the
// time inside the write (the disk).
test('the write worker names each slow write: its method, the wait for the write lock, and the time writing (#1877)', async () => {
  const { store, w } = open(SLOW_DRAIN_MS + 100);
  store.setSetting('k', 'slow');
  assert.ok(w.drain(5000));
  await until('the slow-write row lands', () => store.healthEventsSince(['db-write-slow'], 0).length > 0);
  const [row] = store.healthEventsSince(['db-write-slow'], 0);
  assert.match(row.detail, /^setSetting took (\d+) ms on the write worker: the write lock was free; (\d+) ms writing$/);
  assert.ok(Number(/(\d+) ms writing/.exec(row.detail)![1]) >= SLOW_DRAIN_MS, 'the stalled "disk" counts as time writing');
});

test("a slow write that waited for another connection's write lock says so (SQLITE_BUSY), apart from its time writing (#1877)", async () => {
  const { store, w } = open();
  const other = new DatabaseSync(store.path);
  other.exec('BEGIN IMMEDIATE');
  const freed = setTimeout(() => other.exec('COMMIT'), SLOW_DRAIN_MS + 200);
  store.setSetting('k', 'behind a lock');
  await until('the write lands once the lock is let go', () => !w.queued());
  clearTimeout(freed);
  other.close();
  await until('the slow-write row lands', () => store.healthEventsSince(['db-write-slow'], 0).length > 0);
  const [row] = store.healthEventsSince(['db-write-slow'], 0);
  const m = /^setSetting took \d+ ms on the write worker: (\d+) ms waiting for another connection's write lock \(SQLITE_BUSY\); (\d+) ms writing$/.exec(row.detail);
  assert.ok(m, row.detail);
  assert.ok(Number(m[1]) >= SLOW_DRAIN_MS, `the lock wait is named: ${row.detail}`);
  assert.ok(Number(m[2]) < SLOW_DRAIN_MS, `and kept apart from the time writing: ${row.detail}`);
});

// #1877, #795's step 2: recordTurn, markSeen and syncArtifacts waited on the server's thread for the whole queue (15.4 s
// on Nov 24). They run on the worker now, in order, and their callers await the value.
test('recordTurn, markSeen and syncArtifacts on a stalled disk never hold the event loop; each resolves with its value, after the writes before it (#1877)', async () => {
  const { store, w } = open(600);
  const t = ticket(store);
  w.drain();
  let worst = 0,
    last = performance.now();
  const tick = setInterval(() => {
    worst = Math.max(worst, performance.now() - last);
    last = performance.now();
  }, 10);
  store.setSetting('before', 1); // queued ahead of them: 600 ms of "disk"
  const t0 = performance.now();
  const turn = store.recordTurn(t.id, { session_id: 's', ended_at: Date.now(), session_cost_usd: 2 });
  const seen = store.markSeen('cara', t.id);
  const synced = store.syncArtifacts(t, [{ path: 'a.html', size: 1, mtime: 1 }]);
  const sent = performance.now() - t0;
  // timing-ok: a true speed bound (they are sent, not run, here); on main each waited out the 600 ms queue on this thread
  assert.ok(sent < 200, `sending them held the server's thread ${Math.round(sent)} ms`);
  assert.ok(w.queued() >= 3, 'they are queued on the worker, behind the setting');
  const [row, at, changed] = await Promise.all([turn, seen, synced]);
  clearInterval(tick);
  assert.equal(row.ticket_id, t.id);
  assert.equal(row.cost_usd, 2);
  assert.ok(at > 0);
  assert.equal(changed, true);
  // Each resolved once it had landed: a read sees it, and the setting queued ahead of them landed first.
  assert.equal(store.getSetting('before'), 1);
  assert.equal(store.ticketCost(t.id), 2);
  assert.equal(store.seenAt('cara', t.id), at);
  assert.deepEqual(
    store.listArtifacts(t.project_id).map((a) => a.path),
    ['a.html'],
  );
  // timing-ok: a true speed bound (the loop is never held), listed for a bench in #1444
  assert.ok(worst < 300, `the event loop was held ${Math.round(worst)} ms`);
});

test('a value write sent to the worker that fails rejects at its caller, and the writes after it still land (#1877)', async () => {
  const { store, w } = open();
  const t = ticket(store);
  w.drain();
  await assert.rejects(store.recordTurn(t.id + 1000, { session_id: 's', ended_at: Date.now(), session_cost_usd: 1 }), /FOREIGN KEY/);
  store.setSetting('after', 1);
  assert.ok(w.drain(5000));
  assert.equal(store.getSetting('after'), 1);
});

test("the usage ledger's flush never waits for the queue on the server's thread: its counts go to the worker (#1877)", async () => {
  const { store, w } = open(SLOW_DRAIN_MS * 2);
  store.setSetting('k', 'queued'); // 1 s of "disk" ahead of the flush
  store.usage.used('page', 'home', 1);
  const t0 = performance.now();
  store.usage.flush();
  const took = performance.now() - t0;
  // timing-ok: a true speed bound; on main the flush's BEGIN waited out the queue here
  assert.ok(took < 200, `the flush held the server's thread ${Math.round(took)} ms`);
  assert.ok(w.drain(5000));
  assert.deepEqual(
    store.usage.rows().map((r) => [r.kind, r.name, r.n]),
    [['page', 'home', 1]],
  );
});

test('a read that gives up waiting for queued writes is in the health log, named, with the reads since the last row; one row per minute at most (#1656)', () => {
  // The write takes a second and the read waits 1 ms: only a second's hold of this thread inside that wait could let it see the write.
  const rows = (staleNoteMs?: number) => {
    const { store, w } = open(1000, undefined, 1, staleNoteMs);
    const t = ticket(store);
    assert.ok(w.drain());
    store.updateTicket(t.id, { title: 'new' });
    assert.equal(store.getTicket(t.id)!.title, 'a minion', 'the read went on without the write');
    store.getTicket(t.id); // doesn't wait again: counted, no row of its own
    assert.ok(w.drain());
    store.updateTicket(t.id, { title: 'newer' });
    store.getTicket(t.id); // gives up again
    assert.ok(w.drain(), 'the records, queued behind the writes, land');
    return store.healthEventsSince(['db-read-stale'], 0).map((r) => r.detail);
  };
  const each = rows(0);
  assert.equal(each.length, 2);
  assert.match(each[0], /^SQL SELECT .* on the server's thread waited 1 ms for 1 queued writes and read without them; 0 more reads passed queued writes since the last record$/);
  assert.match(each[1], /; 1 more reads passed queued writes since the last record$/);
  assert.equal(rows().length, 1, 'a second give-up inside the minute is counted, not recorded');
});

test('a void write returns a promise of its own write; a failed one rejects and is in the health log', async () => {
  const { store } = open();
  await store.setSetting('k', 1);
  store.createUser({ name: 'One', login: 'one' });
  const two = store.createUser({ name: 'Two', login: 'two' });
  await assert.rejects(store.updateUser(two.id, { name: 'One' }) as unknown as Promise<void>, /UNIQUE/);
  assert.equal(store.getUser(two.id)!.name, 'Two');
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
  attachEventsIfThere(other, store.path); // the chat log lives in events.db (#1169)
  other.prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)').run(t.id, 'note', '{}', Date.now());
  other.close();
  const c = store.addEvent(t.id, 'note', { text: 'c' });
  assert.equal(c.id, b.id + 2);
  w.drain();
  assert.deepEqual(
    store.listEvents(t.id).map((e) => [e.id, JSON.parse(e.data).text ?? null]),
    [
      [a.id, 'a'],
      [b.id, 'b'],
      [b.id + 1, null],
      [c.id, 'c'],
    ],
  );
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
    assert.equal(has('mine'), false, 'a read gives up waiting: the disk is "stalled"');
    assert.ok(w.queued(), 'and never holds the server for the queue: the write is still queued');
    await ownWrites();
    assert.equal(has('mine'), true, 'once it has awaited its own writes, it sees them');
    writes.request.getStore()!.done = true;
    store.setSetting('later', 1);
    assert.equal(writes.landed!(), null, 'once its response is sent, work it started is no longer its own');
  });
  assert.ok(w.drain());
});

test("a response waits for its own request's writes, however slow, off the event loop (#1244)", async () => {
  const { store, w } = open(READ_WAIT_MS * 3);
  const seen = () => {
    const other = new DatabaseSync(store.path, { readOnly: true });
    try {
      return other.prepare("SELECT value FROM settings WHERE key = 'seen'").get()?.value;
    } finally {
      other.close();
    }
  };
  store.setSetting('other', "not this request's");
  assert.equal(
    writes.request.run({ seq: 0 }, () => writes.landed!()),
    null,
    'a request that wrote nothing waits for nothing',
  );
  await writes.request.run({ seq: 0 }, async () => {
    store.setSetting('seen', 'yes');
    let worst = 0,
      last = performance.now();
    const tick = setInterval(() => {
      worst = Math.max(worst, performance.now() - last);
      last = performance.now();
    }, 10);
    await writes.landed!();
    clearInterval(tick);
    assert.equal(seen(), '"yes"', 'a client reading the file sees it');
    // timing-ok: a true speed bound (the loop is never held), listed for a bench in #1444
    assert.ok(worst < 100, `the event loop was held ${Math.round(worst)} ms`);
    assert.equal(writes.landed!(), null, 'once they have landed, nothing to wait for');
  });
  w.drain();
});

test('a response whose own writes outlast the wait goes out once, without them (#1244)', async () => {
  const { store, w } = open(READ_WAIT_MS * 20, READ_WAIT_MS * 2);
  const sent: boolean[] = []; // was the write still queued when the reply went out
  const res = {
    destroyed: false,
    headersSent: false,
    writeHead() {
      this.headersSent = true;
    },
    end() {
      sent.push(!!w.queued());
    },
  };
  writes.request.run({ seq: 0 }, () => {
    store.setSetting('slow', 1);
    json(res as never, 200, { ok: true });
  });
  await until('the reply goes out', () => sent.length > 0);
  assert.equal(sent[0], true, 'sent while the write was still queued, not held until it landed');
  assert.ok(w.drain(5000), 'the write lands');
  assert.equal(sent.length, 1, 'sent once, never held again');
});

test("if the worker stops, writes run on the server's thread again", async () => {
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
  writeFileSync(
    script,
    `
    import { Store } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'db.ts'))};
    import { writeOffThread } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'db-writer.ts'))};
    const store = new Store(${JSON.stringify(join(dir, 'coordinator.db'))});
    writeOffThread(store, { delayMs: 20 });
    for (let i = 0; i < 10; i++) store.setSetting('k' + i, i);
    process.on('exit', () => store.setSetting('at exit', 1));
    process.exit(0);
  `,
  );
  execFileSync(process.execPath, [script]);
  const db = new DatabaseSync(join(dir, 'coordinator.db'), { readOnly: true });
  assert.equal((db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'k%' OR key = 'at exit'").get() as { n: number }).n, 11);
  db.close();
});

// #1285: writes added to the Store after #795 (touch, on every chat message) missed both lists and held the server on a
// slow disk. Every method whose source runs a statement is in WRITES, VALUE_WRITES or here, with why.
const STAYS_ON_THREAD: Record<string, string> = {
  // The constructor's one-time migrations: they run before the writer starts.
  ...Object.fromEntries(['attachState', 'moveSharedViews', 'serverLoginOwnerOnly', 'groupByType', 'closedAtFromNotes', 'dropEarlyPeekAurasBuilds', 'shippingFromRules', 'lendingLists', 'numberTickets', 'settleBuilds', 'props.seed', 'props.insertSeed', 'schedules.fillTriggers'].map((m) => [m, 'boot'])),
  // Helpers that run inside a listed write, with it.
  // The usage ledger batches counts in memory and sends them as usage.addCounts on a timer (#1306, #1877).
  'usage.prune': "the ledger's own timer",
  dropAudit: 'inside sweepTurnAudit and deleteTurnAudit',
  'props.insertValue': 'inside props.registerValues and props.review',
  'props.putStage': 'inside props.statusChanged',
  'props.statusChanged': 'inside updateTicket',
  'props.startStage': "called by newMinion (src/new-minion.ts), which runs it with the ticket's other writes",
  // Not moved yet: rare, or they write only now and then and would wait for the queue on every call as a VALUE_WRITE.
  ...Object.fromEntries(
    [
      'putSecret',
      'deleteSecret',
      'splitScheme',
      'putClaudeState',
      'forgetJobKind',
      'props.backfill',
      'schedules.setBrief',
      'schedules.categorize',
      'reviews.ensureAgents',
      'reviews.recordRun',
      'reviews.recordVerdict',
      'reviews.removeVerdict',
      'reviews.recordRefutes',
      'reviews.removeLesson',
      'reviews.backfill',
      'claims.take',
      'claims.release',
      'claims.releaseHeldBy',
      'claims.setQueue',
      'claims.passOn',
      'claims.shipped',
      'claims.holderLive',
      'lessons.add',
      'lessons.take',
      'ideas.upsert',
      'ideas.restatus',
      'ideas.restatusWith',
      'ideas.warmUp',
      'ideas.syncSteps',
      'ideas.linkStarts',
      'ideas.sync',
      'ideas.laterNote',
      'minionIndex.indexTicket',
      'minionIndex.syncHandoffs',
      'minionIndex.deleteTicket',
      'memoryProposals.create',
      'memoryProposals.decide',
      'memoryProposals.keepFirst',
      'memoryProposals.restored',
      'memoryProposals.prune',
      'ideas.edit',
      'ideas.linkHandoff',
      'ideas.fromHandoff',
      'ideas.join',
      'ideas.readPage',
      'ideas.now',
      'ideas.fromChat',
      'ideas.soon',
      'minionIndex.indexClosed',
    ].map((m) => [m, 'not moved yet']),
  ),
};

test("every Store method that writes is sent to the worker or listed as staying on the server's thread (#1285)", () => {
  const store = new Store(join(root, 'lists.db'));
  const listed = new Set<string>([...WRITES, ...VALUE_WRITES, ...ASYNC_WRITES]);
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
    for (let grew = true; grew; ) {
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
  assert.ok(writers.includes('touch') && writers.includes('props.set'), "the scan finds writes, its own and its parts'");
  const missed = writers.filter((m) => !listed.has(m) && !(m in STAYS_ON_THREAD));
  assert.deepEqual(missed, [], `these write but are in neither WRITES nor VALUE_WRITES (src/db-writer.ts): ${missed.join(', ')}. A void write goes in WRITES, one whose result its callers use in VALUE_WRITES.`);
  const stale = Object.keys(STAYS_ON_THREAD).filter((m) => !writers.includes(m) || listed.has(m));
  assert.deepEqual(stale, [], "listed as staying on the server's thread, but gone, no longer writing, or now in a list");
});
