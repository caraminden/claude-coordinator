import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { writeOffThread, type Writer } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';
import { busyNow, track } from '../src/settled.ts';
import { settled } from './helpers.ts';

// #1437: a test waits until the work it started is finished, not for its first sign. settled() only resolves once the
// DB write worker has applied every queued write.
const root = mkdtempSync(join(tmpdir(), 'settled-'));
const writers: Writer[] = [];
after(async () => {
  for (const w of writers) await w.stop();
  // timing-ok: only the in-process Store's database is in root, and its writers have stopped above; bootServer cleans its own
  rmSync(root, { recursive: true, force: true });
});

test('settled() waits for a write held on the worker, and only resolves once it is applied', async () => {
  const path = join(root, 'coordinator.db');
  const store = new Store(path);
  const w = writeOffThread(store, { delayMs: 400 })!;
  writers.push(w);
  // A second connection reads the file itself, as a test reading the database does: no wait for the queue.
  const onDisk = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare("SELECT value FROM settings WHERE key = 'settled-test'").get() as { value: string } | undefined)?.value;
    } finally {
      db.close();
    }
  };
  const t0 = Date.now();
  void store.setSetting('settled-test', 'written');
  assert.deepEqual(busyNow(), ['1 queued DB writes']);
  assert.equal(onDisk(), undefined, 'still held on the worker');
  await settled();
  assert.equal(onDisk(), '"written"', 'applied by the time settled() resolves');
  assert.ok(Date.now() - t0 >= 350, `it waited out the held write (${Date.now() - t0} ms)`);
  assert.deepEqual(busyNow(), []);
});

test('settled() names what is still busy when it runs out of time, and counts tracked jobs', async () => {
  let finish!: () => void;
  const job = track('session saves', new Promise<void>((r) => (finish = r)));
  await assert.rejects(settled(50), /Still busy after 50 ms: 1 session saves/);
  finish();
  await job;
  await settled(1000);
});
