// copyDb copies the chat log's own file (events.db, #1169) beside the database: all of it for a preview or a dev copy,
// only the open minions' chats for the boot check.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { copyDb } from '../src/db-copy.ts';
import { until } from './helpers.ts';
import { eventsSchema } from '../src/events-db.ts';

const root = mkdtempSync(join(tmpdir(), 'db-copy-events-'));
after(() => rmSync(root, { recursive: true, force: true }));

function live(dir: string) {
  mkdirSync(dir);
  const main = new DatabaseSync(join(dir, 'coordinator.db'));
  main.exec("CREATE TABLE tickets (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO tickets VALUES (1, 'idle'), (2, 'closed')");
  main.close();
  const ev = new DatabaseSync(join(dir, 'events.db'));
  ev.exec(`PRAGMA journal_mode = WAL; ${eventsSchema('main', false)}
    INSERT INTO events (ticket_id, kind, data, created_at) VALUES (1, 'note', '{}', 1), (2, 'note', '{}', 2), (1, 'claude', '{}', 3)`);
  ev.close();
}
const rows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const r = db
    .prepare('SELECT ticket_id, created_at FROM events ORDER BY id')
    .all()
    .map((x: any) => `${x.ticket_id}:${x.created_at}`);
  const idx = db.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").get()!.n;
  db.close();
  return { r, idx };
};

test('a copy brings events.db along, whole', async () => {
  const src = join(root, 'a');
  live(src);
  await copyDb(join(src, 'coordinator.db'), join(root, 'a-copy.db'));
  assert.deepEqual(rows(join(root, 'a-copy.db.events')).r, ['1:1', '2:2', '1:3']);
});

test("the boot check's copy takes only open minions' chats, with the indexes", async () => {
  const src = join(root, 'b');
  live(src);
  const out = join(root, 'b-out');
  mkdirSync(out);
  await copyDb(join(src, 'coordinator.db'), join(out, 'coordinator.db'), { events: 'open' });
  assert.deepEqual(rows(join(out, 'events.db')), { r: ['1:1', '1:3'], idx: 6 });
});

test('a database not yet moved has no events.db to copy, and a stale one at the destination goes', async () => {
  const src = join(root, 'c');
  mkdirSync(src);
  new DatabaseSync(join(src, 'coordinator.db')).exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, status TEXT)');
  const out = join(root, 'c-out');
  mkdirSync(out);
  new DatabaseSync(join(out, 'events.db')).exec('CREATE TABLE stale (x)');
  await copyDb(join(src, 'coordinator.db'), join(out, 'coordinator.db'));
  assert.ok(!existsSync(join(out, 'events.db')));
});

test('a copy waits for a writer that holds events.db, not "database is locked"', async () => {
  const src = join(root, 'd');
  live(src);
  const evFile = join(src, 'events.db');
  const w = new DatabaseSync(evFile);
  w.exec('PRAGMA journal_mode = DELETE'); // a rollback-journal file: an exclusive lock blocks readers
  w.close();
  // The lock is held by another process, since a busy wait in this one would also stop the timer that releases it.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(process.argv[1]);
    d.exec('BEGIN EXCLUSIVE'); console.log('locked');
    setTimeout(() => { d.exec('COMMIT'); console.log('released ' + Date.now()); process.exit(0); }, 1000);`,
      evFile,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let outText = '';
  holder.stdout.on('data', (c) => {
    outText += c;
  });
  try {
    await new Promise((res) => holder.stdout.once('data', res));
    const out = join(root, 'd-out');
    mkdirSync(out);
    // The copy's busy wait blocks this process, so the holder frees the lock on its own timer and reports when.
    const started = Date.now();
    await copyDb(join(src, 'coordinator.db'), join(out, 'coordinator.db'), { events: 'open' });
    const finished = Date.now();
    await until('the holder reports its release', () => /released \d+/.test(outText));
    const released = Number(/released (\d+)/.exec(outText)![1]);
    // Without these the test could pass on a slow box having waited on nothing: the copy began while the lock was held, and ended only after it let go.
    assert.ok(started < released - 300, `the copy started ${released - started} ms before the release: too late to have met the lock`);
    assert.ok(finished >= released - 5, `the copy finished ${released - finished} ms before the lock was released`);
    assert.deepEqual(rows(join(out, 'events.db')).r, ['1:1', '1:3']);
  } finally {
    holder.kill();
  }
});
