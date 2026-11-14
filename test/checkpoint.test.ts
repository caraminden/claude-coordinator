import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkpointOffThread } from '../src/checkpoint.ts';
import { Store } from '../src/db.ts';

// #680: a checkpoint fsyncs, and run on the event loop by whichever commit crossed 1000 pages it held the server
// for seconds when the disk stalled. The server's connection leaves them to a worker thread.
const root = mkdtempSync(join(tmpdir(), 'checkpoint-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const store = () => new Store(join(root, `${++n}.db`));
const size = (f: string) => statSync(f).size;
// 1,500 pages' worth, past SQLite's 1000-page auto-checkpoint.
const fill = (s: Store) => { for (let i = 0; i < 30; i++) s.setSetting(`big:${i}`, 'x'.repeat(200_000) + i); };

test('setting a value it already has writes nothing to the WAL', () => {
  const s = store();
  s.setSetting('k', { jobs: 'y'.repeat(50_000) });
  const wal = size(`${s.path}-wal`);
  for (let i = 0; i < 5; i++) s.setSetting('k', { jobs: 'y'.repeat(50_000) });
  assert.equal(size(`${s.path}-wal`), wal);
  s.setSetting('k', { jobs: 'z'.repeat(50_000) });
  assert.ok(size(`${s.path}-wal`) > wal, 'a changed value is still written');
  assert.deepEqual(s.getSetting('k'), { jobs: 'z'.repeat(50_000) });
  s.db.close();
});

test('with auto-checkpoint off, commits leave the database file alone', () => {
  const s = store();
  const before = size(s.path);
  s.autoCheckpoint(false);
  fill(s);
  assert.equal(size(s.path), before, 'no checkpoint ran on this connection');
  s.autoCheckpoint(true);
  s.setSetting('one more', 1);
  assert.ok(size(s.path) > before + 5_000_000, 'back on, the next commit checkpoints');
  s.db.close();
});

test('the worker checkpoints, and the store goes back to checkpointing itself when it stops', async () => {
  const s = store();
  const worker = checkpointOffThread(s, 20)!;
  assert.equal((s.db.prepare('PRAGMA wal_autocheckpoint').get() as any).wal_autocheckpoint, 0);
  const before = size(s.path);
  fill(s);
  await once(worker, 'message');
  await once(worker, 'message'); // a whole round after the writes
  assert.ok(size(s.path) > before + 5_000_000, 'the worker copied the WAL into the database');
  await worker.terminate();
  assert.equal((s.db.prepare('PRAGMA wal_autocheckpoint').get() as any).wal_autocheckpoint, 1000);
  s.db.close();
});

test('an in-memory store has no worker', () => {
  const s = new Store(':memory:');
  assert.equal(checkpointOffThread(s), null);
  s.db.close();
});
