// How many minions fit (#1987): the numbers the Status page's panel reads out, on seeded readings, and the route's readings.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { boxCapacity, ENOUGH, WAITS_FREED_AT, type BoxReading } from '../src/box-capacity.ts';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'box-capacity-'));
after(() => rmSync(root, { recursive: true, force: true }));

let clock = WAITS_FREED_AT;
/** `count` readings at `turns`, their loads 1..count times `step`, the first `stalls` of them stalled. */
const at = (turns: number, count: number, step: number, stalls = 0): BoxReading[] => Array.from({ length: count }, (_, i) => ({ at: clock++, turns, load: (i + 1) * step, used: 40, stall: i < stalls ? 10 : 9.9 }));

test('a number reads the readings within one turn of it: typical load, the 1-in-10 load, the share that stalled', () => {
  const c = boxCapacity([...at(4, 20, 1), ...at(5, 20, 1, 2), ...at(8, 10, 2)], 16);
  // Near 4: both sets, loads 1..20 twice; 2 of the 40 stalled, at exactly 10%.
  assert.deepEqual(c.near[4], { count: 40, typical: 10.5, high: 18, stalls: 2, stallOf: 40 });
  assert.equal(c.near[3].count, 20, 'only the readings at 4');
  assert.deepEqual(c.near[8], { count: 10, typical: 11, high: 18, stalls: 0, stallOf: 10 });
  assert.equal(c.near.length, 9, '0 up to the most turns seen');
});

test('a reading without memory pressure is left out of the stalled share, and a number nothing is near has none', () => {
  const c = boxCapacity([{ at: 1, turns: 3, load: 2, used: 40, stall: null }, ...at(3, 1, 1, 1)], 16);
  assert.deepEqual([c.near[3].count, c.near[3].stalls, c.near[3].stallOf], [2, 1, 1]);
  assert.deepEqual(c.near[0], { count: 0, typical: null, high: null, stalls: 0, stallOf: 0 });
});

test('comfortable is the last number before typical load passes the cores or stalls pass 1 in 20', () => {
  // Near 6 the loads are 1..20 twice (typical 10.5) and one set of 2s: past 16 cores at 8.
  const loaded = boxCapacity([...at(5, 20, 1), ...at(6, 20, 1), ...at(9, 20, 2)], 16);
  assert.deepEqual(loaded.comfortable, { turns: 7, past: 8 });
  const stalled = boxCapacity([...at(2, 20, 1), ...at(5, 20, 1, 2)], 16);
  assert.deepEqual(stalled.comfortable, { turns: 3, past: 4 }, '2 of 20 stalled');
  const edge = boxCapacity([...at(2, 20, 1), ...at(5, 20, 1, 1)], 16);
  assert.deepEqual(edge.comfortable, { turns: 5, past: null }, '1 of 20 is still fine, and the readings end there');
});

test('a number with too few readings near it neither counts nor stops the count, and none at all says nothing', () => {
  const gap = boxCapacity([...at(1, 20, 0.1), ...at(4, ENOUGH - 1, 50), ...at(8, 20, 1)], 16);
  assert.deepEqual(gap.comfortable, { turns: 8, past: null });
  assert.deepEqual(boxCapacity(at(3, ENOUGH - 1, 1), 16).comfortable, { turns: null, past: null });
  assert.deepEqual(boxCapacity([], 16).comfortable, { turns: null, past: null });
  assert.deepEqual(boxCapacity(at(0, ENOUGH, 10), 16).comfortable, { turns: null, past: 0 }, 'loaded at the fewest');
});

test('the bands split every reading once, and readings that counted waiting turns are told apart', () => {
  const old = at(12, 3, 1).map((r) => ({ ...r, at: WAITS_FREED_AT - 1 }));
  const c = boxCapacity([...old, ...at(0, 2, 1), ...at(20, 1, 1), ...at(36, 1, 1)], 16);
  assert.deepEqual(
    c.bands.filter((b) => b.count).map((b) => [b.from, b.to, b.count]),
    [
      [0, 1, 2],
      [11, 14, 3],
      [20, null, 2],
    ],
  );
  assert.equal(c.waiting.count, 3);
});

test('the store reads only samples that counted the turns, within the time asked for', () => {
  const store = new Store(join(root, 'db'));
  const s = { mem_total: 1000, mem_avail: 600, disk_total: 1, disk_free: 1, rss: 1 };
  const answer = (turns: unknown) => JSON.stringify({ v: 1, turns });
  store.addHostSample({ ...s, at: 1, load1: 1, answer_time: answer(9) });
  store.addHostSample({ ...s, at: 10, load1: 2.34, mem_psi: 12.5, answer_time: answer(7) });
  store.addHostSample({ ...s, at: 11, load1: 3, mem_psi: null, answer_time: answer(0) });
  store.addHostSample({ ...s, at: 12, load1: 3, answer_time: null });
  store.addHostSample({ ...s, at: 13, load1: 3, answer_time: 'not json' });
  store.addHostSample({ ...s, at: 14, load1: 3, answer_time: answer(null) });
  assert.deepEqual(
    store.boxReadings(10).map((r) => ({ ...r })),
    [
      { at: 10, turns: 7, load: 2.3, used: 40, stall: 12.5 },
      { at: 11, turns: 0, load: 3, used: 40, stall: null },
    ],
  );
});
