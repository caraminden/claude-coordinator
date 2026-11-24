import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { citadelSliceDir, largestUnit, MemoryStorms, parseStorm, readGroups, type GroupReading, type Storm } from '../src/memory-storms.ts';

const root = mkdtempSync(join(tmpdir(), 'memory-storms-'));
after(() => rmSync(root, { recursive: true, force: true }));

function group(dir: string, { high = 0, someUs = 0, current = 0, limit = 'max' as string | number } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.events.local'), `low 0\nhigh ${high}\nmax 0\noom 0\noom_kill 0\n`);
  writeFileSync(join(dir, 'memory.pressure'), `some avg10=0.00 avg60=0.00 avg300=0.00 total=${someUs}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  writeFileSync(join(dir, 'memory.current'), `${current}\n`);
  writeFileSync(join(dir, 'memory.high'), `${limit}\n`);
}

test('citadelSliceDir finds citadel.slice above this process, and null outside it', async () => {
  const f = join(root, 'cgroup');
  writeFileSync(f, '0::/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-turns.slice/citadel-turn-a-1.service\n');
  assert.equal(await citadelSliceDir(f, '/sys/fs/cgroup'), '/sys/fs/cgroup/user.slice/user-1002.slice/user@1002.service/citadel.slice');
  writeFileSync(f, '0::/user.slice/user-1002.slice/session-3.scope\n');
  assert.equal(await citadelSliceDir(f), null);
});

test('readGroups reads citadel.slice, its slices and containers, not the server; largestUnit walks to the biggest unit', async () => {
  const c = join(root, 'tree', 'citadel.slice');
  group(c, { current: 9 });
  group(join(c, 'citadel-turns.slice'), { high: 7, someUs: 100, current: 8, limit: 10_737_418_240 });
  group(join(c, 'citadel-turns.slice', 'citadel-turn-a-1.service'), { current: 3 });
  group(join(c, 'citadel-turns.slice', 'citadel-land-a-2.service'), { current: 5 });
  group(join(c, 'citadel-claude-2.service'), { current: 1 });
  group(join(c, 'claude-coordinator.service'), { current: 1 });
  const read = await readGroups(c);
  assert.deepEqual([...read.values()].map((g) => g.name).sort(), ['citadel-claude-2.service', 'citadel-turns.slice', 'citadel.slice']);
  assert.deepEqual(read.get(join(c, 'citadel-turns.slice')), { name: 'citadel-turns.slice', high: 7, someUs: 100, current: 8, limit: 10_737_418_240 });
  assert.deepEqual(await largestUnit(join(c, 'citadel-turns.slice')), { unit: 'citadel-land-a-2.service', bytes: 5 });
  assert.deepEqual(await largestUnit(c), { unit: 'citadel-land-a-2.service', bytes: 5 }, 'down through the biggest slice to its biggest unit');
  assert.deepEqual(await largestUnit(join(c, 'citadel-claude-2.service')), { unit: 'citadel-claude-2.service', bytes: 1 }, 'a container names itself');
  const w = join(root, 'wide', 'citadel.slice');
  group(join(w, 'citadel-turns.slice'), { current: 9 });
  for (const n of [1, 2, 3]) group(join(w, 'citadel-turns.slice', `citadel-turn-${n}.service`), { current: 3 });
  group(join(w, 'citadel-claude-2.service'), { current: 6 });
  assert.deepEqual(await largestUnit(w), { unit: 'citadel-claude-2.service', bytes: 6 }, 'a big unit beside a bigger slice of small ones');
});

/** A run of readings, one per 15 s: each [high, stalled seconds in that step] for one group. */
async function run(steps: [number, number][]) {
  const recorded: { at: number; storm: Storm }[] = [];
  let t = 1_000_000;
  let high = 0,
    someUs = 0;
  const g = (): Map<string, GroupReading> => new Map([['/c/citadel-turns.slice', { name: 'citadel-turns.slice', high, someUs, current: 10, limit: 20 }]]);
  const s = new MemoryStorms({ dir: '/c', now: () => t, read: async () => g(), largest: async () => ({ unit: 'citadel-land-x.service', bytes: 4 }), record: (at, storm) => recorded.push({ at, storm }) });
  await s.tick();
  for (const [dh, stalled] of steps) {
    t += 15_000;
    high += dh;
    someUs += stalled * 1e6;
    await s.tick();
  }
  return { recorded, s };
}

test('a storm is high events with stalls at or over the line; it is recorded once, when it ends, with its largest unit', async () => {
  const { recorded } = await run([
    [0, 0],
    [500, 9],
    [800, 12],
    [300, 6],
    [0, 0],
    [0, 0],
  ]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].at, 1_000_000 + 15_000, 'from the reading before its first stormy one');
  assert.deepEqual(recorded[0].storm, { group: 'citadel-turns.slice', seconds: 45, stalled: 27, highs: 1600, peak: 0.8, limit: 20, unit: 'citadel-land-x.service', unitBytes: 4 });
});

test('stalls without high events, high events without stalls, and blips under MIN_STALL_S are not storms', async () => {
  assert.equal(
    (
      await run([
        [0, 14],
        [0, 14],
        [0, 0],
      ])
    ).recorded.length,
    0,
    'memory pressure from elsewhere (host-wide), not this limit',
  );
  assert.equal(
    (
      await run([
        [900, 0.5],
        [900, 0.5],
        [0, 0],
      ])
    ).recorded.length,
    0,
    'at the limit but nobody stalled much: under the line',
  );
  assert.equal(
    (
      await run([
        [100, 3],
        [0, 0],
      ])
    ).recorded.length,
    0,
    'one short blip',
  );
});

test('stop records a storm still going; current() shows it meanwhile', async () => {
  const { recorded, s } = await run([
    [500, 9],
    [500, 9],
  ]);
  assert.equal(recorded.length, 0);
  assert.equal(s.current()[0].stalled, 18);
  s.stop();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].storm.stalled, 18);
  assert.deepEqual(parseStorm(JSON.stringify(recorded[0].storm)), recorded[0].storm);
  assert.equal(parseStorm('not json'), null);
});

test('a stop that comes while a reading waits still records the storm that reading opens', async () => {
  let t = 0,
    high = 0,
    someUs = 0;
  const recorded: Storm[] = [];
  let s!: MemoryStorms;
  s = new MemoryStorms({
    dir: '/c',
    now: () => t,
    read: async () => new Map([['/c/citadel-turns.slice', { name: 'citadel-turns.slice', high, someUs, current: 1, limit: 2 }]]),
    largest: async () => {
      s.stop();
      return { unit: 'u.service', bytes: 1 };
    },
    record: (_at, storm) => recorded.push(storm),
  });
  await s.tick();
  [t, high, someUs] = [15_000, 900, 9e6];
  await s.tick();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].unit, 'u.service');
});
