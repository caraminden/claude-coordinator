import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { citadelSliceDir, largestUnit, MemoryStorms, parseStorm, readGroups, stormDetail, topProcesses, type GroupReading, type Storm } from '../src/memory-storms.ts';

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
  group(join(c, 'citadel-taskmasters.slice'), { current: 2 });
  group(join(c, 'citadel-taskmasters.slice', 'citadel-claude-2-tm.service'), { current: 1 });
  group(join(c, 'citadel-taskmasters.slice', 'citadel-turn-a-3.service'), { current: 1 });
  group(join(c, 'claude-coordinator.service'), { current: 1 });
  const read = await readGroups(c);
  assert.deepEqual([...read.values()].map((g) => g.name).sort(), ['citadel-claude-2-tm.service', 'citadel-claude-2.service', 'citadel-taskmasters.slice', 'citadel-turns.slice', 'citadel.slice']);
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

test('topProcesses ranks every process in a container and its cgroups below by anon memory plus swap, not page cache', async () => {
  const c = join(root, 'procs', 'citadel-claude-2.service');
  const proc = join(root, 'procs', 'proc');
  const cg = (dir: string, pids: number[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''));
  };
  const ps = (pid: number, anonKb: number, swapKb: number, file: number, argv: string[]) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), 'status'), `Name:\tx\nVmRSS:\t${anonKb + file} kB\nRssAnon:\t${anonKb} kB\nRssFile:\t${file} kB\nVmSwap:\t${swapKb} kB\n`);
    writeFileSync(join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
  };
  cg(c, [10]);
  cg(join(c, 'libpod-payload-abc'), [11, 12, 13, 99]);
  cg(join(c, 'libpod-payload-abc', 'nested'), [14]);
  ps(10, 1000, 0, 0, ['conmon']);
  ps(11, 200_000, 0, 9_000_000, ['/usr/bin/claude', '-p']); // mostly page cache: small
  ps(12, 3_000_000, 1_000_000, 0, ['cargo', 'build', '--release']);
  ps(13, 500_000, 0, 0, ['node', 'x'.repeat(300)]);
  ps(14, 2_000_000, 0, 0, ['rustc', 'big.rs']);
  // 99 exited between reading cgroup.procs and its status: skipped
  const top = await topProcesses(c, 3, proc);
  assert.deepEqual(
    top.map((p) => [p.pid, p.anon, p.swap]),
    [
      [12, 3_000_000 * 1024, 1_000_000 * 1024],
      [14, 2_000_000 * 1024, 0],
      [13, 500_000 * 1024, 0],
    ],
  );
  assert.equal(top[0].cmd, 'cargo build --release');
  assert.equal(top[2].cmd, 'node …', 'a long word is masked as a secret might be');
  ps(13, 500_000, 0, 0, ['curl', '-H', 'Authorization: Bearer s3cret', 'ab '.repeat(90)]);
  const masked = (await topProcesses(c, 3, proc))[2].cmd;
  assert.equal(masked.length, 90, 'a long command line is cut');
  assert.doesNotMatch(masked, /s3cret/);
  assert.deepEqual(await topProcesses(join(root, 'procs', 'gone'), 3, proc), [], 'a cgroup that went away names nobody');
});

test('one stuck command line costs the rest their names, not the thread pool', async () => {
  const c = join(root, 'stuck', 'cg');
  const proc = join(root, 'stuck', 'proc');
  mkdirSync(c, { recursive: true });
  writeFileSync(join(c, 'cgroup.procs'), '1\n2\n3\n4\n5\n');
  for (const pid of [1, 2, 3, 4, 5]) {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), 'status'), `Name:\tp${pid}\nRssAnon:\t${100 - pid} kB\nVmSwap:\t0 kB\n`);
    execFileSync('mkfifo', [join(proc, String(pid), 'cmdline')]); // a read of it waits, as one on a process's memory lock does
  }
  const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
  try {
    assert.deepEqual(
      (await topProcesses(c, 5, proc)).map((p) => p.cmd),
      names,
    );
    assert.deepEqual(
      (await topProcesses(c, 5, proc)).map((p) => p.cmd),
      names,
      'nor does the next reading start another',
    );
    assert.match(await readFile(join(proc, '1', 'status'), 'utf8'), /p1/, 'the pool still answers');
  } finally {
    // Opening each for reading and writing frees a read waiting on it; closing ends that read.
    for (const pid of [1, 2, 3, 4, 5]) closeSync(openSync(join(proc, String(pid), 'cmdline'), 'r+'));
  }
});

test('a storm naming five long commands still fits its health event', () => {
  const top = [1, 2, 3, 4, 5].map((i) => ({ pid: 4_000_000 + i, anon: 10 ** 11, swap: 10 ** 11, cmd: '"\\'.repeat(45) }));
  const storm: Storm = { group: 'citadel-claude-2.service', seconds: 900, stalled: 800, highs: 10 ** 7, peak: 1, limit: 10 ** 10, unit: 'libpod-payload-'.padEnd(80, 'a'), unitBytes: 10 ** 10, top };
  const kept = parseStorm(stormDetail(storm).slice(0, 1000));
  assert.equal(kept?.group, storm.group);
  assert.deepEqual(kept?.top, top.slice(0, kept?.top?.length), 'the biggest are the ones kept');
  assert.ok(kept?.top?.length);
  assert.equal(stormDetail({ ...storm, top: undefined }), JSON.stringify({ ...storm, top: undefined }));
});

/** A run of readings, one per 15 s: each [high, stalled seconds in that step] for one group. */
async function run(steps: [number, number][]) {
  const recorded: { at: number; storm: Storm }[] = [];
  let t = 1_000_000;
  let high = 0,
    someUs = 0;
  const g = (): Map<string, GroupReading> => new Map([['/c/citadel-turns.slice', { name: 'citadel-turns.slice', high, someUs, current: 10, limit: 20 }]]);
  const s = new MemoryStorms({ dir: '/c', now: () => t, read: async () => g(), largest: async () => ({ unit: 'citadel-land-x.service', bytes: 4 }), top: async () => [{ pid: 7, anon: 3, swap: 1, cmd: 'cargo build' }], record: (at, storm) => recorded.push({ at, storm }) });
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
  assert.deepEqual(recorded[0].storm, { group: 'citadel-turns.slice', seconds: 45, stalled: 27, highs: 1600, peak: 0.8, limit: 20, unit: 'citadel-land-x.service', unitBytes: 4, top: [{ pid: 7, anon: 3, swap: 1, cmd: 'cargo build' }] });
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
