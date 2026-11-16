import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { READ_WAIT_MS, writeOffThread, type Writer } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';
import { writes } from '../src/http.ts';

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
  while (w.queued()) await new Promise((r) => setTimeout(r, 20));
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

test('a response waits for the request\'s writes, so a client reading the file sees them', () => {
  const { store } = open();
  store.setSetting('seen', 'yes');
  writes.settle!();
  const other = new DatabaseSync(store.path, { readOnly: true });
  assert.deepEqual({ ...other.prepare("SELECT value FROM settings WHERE key = 'seen'").get() }, { value: '"yes"' });
  other.close();
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
