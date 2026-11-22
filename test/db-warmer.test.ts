import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from './wait.ts';
import { Store } from '../src/db.ts';
import { BACKOFF_MS, Pacer, WARMER_SETTING, WARM_MS, warmDatabase } from '../src/db-warmer.ts';

const dir = mkdtempSync(join(tmpdir(), 'warmer-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('three slow passes in a row back off for 30 s, then it starts counting again (#1560)', () => {
  const p = new Pacer();
  // 100 MB in 1 s is 100 MB/s: from disk.
  assert.equal(p.after(100, 1000).backoff, false);
  assert.equal(p.after(100, 1000).backoff, false);
  const third = p.after(100, 1000);
  assert.deepEqual(third, { wait: BACKOFF_MS, backoff: true });
  assert.equal(p.after(100, 1000).backoff, false, 'the count restarts after a backoff');
});

test('a fast pass resets the count, a tiny pass is no evidence, and the wait is what is left of the period', () => {
  const p = new Pacer();
  p.after(100, 1000); p.after(100, 1000);
  assert.equal(p.after(100, 40).backoff, false); // 2500 MB/s: from memory
  assert.equal(p.after(100, 1000).backoff, false);
  assert.equal(p.after(100, 1000).backoff, false);
  for (let i = 0; i < 5; i++) assert.equal(p.after(1, 100).backoff, false); // 10 MB/s but 1 MB
  assert.deepEqual(p.after(100, 40), { wait: WARM_MS - 40, backoff: false });
  assert.equal(p.after(100, 9000).wait, 0, 'a pass longer than the period starts the next at once, never queued');
});

test('the worker reads the database and its WAL, and the setting turns it off and on with no restart', async () => {
  const store = new Store(join(dir, 'coordinator.db'));
  writeFileSync(`${store.path}-wal`, Buffer.alloc(3 * 1048576));
  const w = warmDatabase(store, 30, 30)!;
  try {
    const s = await until('the warmer has read a pass', () => w.stats().mb > 0 && w.stats());
    assert.ok(s.mb >= 3, `read ${s.mb} MB, the 3 MB WAL at least`);
    store.setSetting(WARMER_SETTING, false);
    await until('the warmer is off: no pass is shown', () => w.stats().mb === 0);
    store.setSetting(WARMER_SETTING, true);
    await until('the warmer is on again', () => w.stats().mb > 0);
  } finally { w.stop(); }
});
