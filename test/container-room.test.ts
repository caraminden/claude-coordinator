import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { containerRooms, publishRooms, ROOM_FILE } from '../src/container-room.ts';
import { scriptEnv } from './script-env.ts';

// src/container-room.ts (#1982): each container's room under its own memory limit, for tools/mem-room inside it.
const root = mkdtempSync(join(tmpdir(), 'container-room-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const MB = 1048576;
const GB = 1024 * MB;

interface Fake {
  high?: string | number;
  max?: string | number;
  current?: string | number;
  cache?: number;
}
/** One container's unit and its payload cgroup, which is what `/sys/fs/cgroup` is inside it; gives the payload's path. */
function unit(dir: string, { high = 10 * GB, max = 12 * GB, current = 0, cache }: Fake = {}) {
  const payload = join(dir, `libpod-payload-${dir.length}abc`);
  mkdirSync(payload, { recursive: true });
  mkdirSync(join(dir, 'runtime'));
  writeFileSync(join(dir, 'memory.high'), `${high}\n`);
  writeFileSync(join(dir, 'memory.max'), `${max}\n`);
  writeFileSync(join(dir, 'memory.current'), `${current}\n`);
  if (cache !== undefined) writeFileSync(join(dir, 'memory.stat'), `anon 1\nfile 5\ninactive_anon 7\ninactive_file ${cache}\nactive_file 9\n`);
  return payload;
}
const ino = (path: string) => String(statSync(path).ino);
const slice = (name: string) => {
  const dir = join(root, name, 'citadel.slice');
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("a container's room is its limit less what it uses, its inactive file cache counting as room", async () => {
  const c = slice('plain');
  const p = unit(join(c, 'citadel-claude-2.service'), { current: 9 * GB, cache: 3 * GB });
  assert.deepEqual(await containerRooms(c), [{ ino: ino(p), mb: 4096, unit: 'citadel-claude-2.service' }]);
  writeFileSync(join(c, 'citadel-claude-2.service', 'memory.high'), `${12 * GB}\n`);
  assert.equal((await containerRooms(c))[0]!.mb, 6144, 'the limit is read each time');
});

test('the lower of memory.high and memory.max counts, and neither past what is used goes under 0', async () => {
  const c = slice('limits');
  unit(join(c, 'citadel-claude-1.service'), { high: 'max', max: 4 * GB, current: GB });
  unit(join(c, 'citadel-claude-2.service'), { high: 8 * GB, max: 6 * GB, current: GB });
  unit(join(c, 'citadel-claude-3.service'), { high: 2 * GB, current: 3 * GB });
  unit(join(c, 'citadel-claude-4.service'), { current: GB, cache: 2 * GB }); // a torn pair of readings: more cache than use
  assert.deepEqual(
    (await containerRooms(c)).map((r) => [r.unit, r.mb]),
    [
      ['citadel-claude-1.service', 3072],
      ['citadel-claude-2.service', 5120],
      ['citadel-claude-3.service', 0],
      ['citadel-claude-4.service', 9216],
    ],
  );
});

test('a container with no limit, an unreadable one or one with no payload has no line; the others keep theirs', async () => {
  const c = slice('odd');
  unit(join(c, 'citadel-claude-1.service'), { high: 'max', max: 'max', current: GB });
  unit(join(c, 'citadel-claude-2.service'), { current: 'junk' });
  unit(join(c, 'citadel-claude-3.service'));
  rmSync(join(c, 'citadel-claude-3.service', 'memory.current'));
  mkdirSync(join(c, 'citadel-claude-4.service')); // just starting, or just gone
  unit(join(c, 'citadel-claude-5.service'), { high: '' });
  unit(join(c, 'citadel-claude-7.service'), { current: '' });
  const bare = join(c, 'citadel-claude-8.service');
  mkdirSync(bare);
  for (const [f, v] of Object.entries({ 'memory.high': GB, 'memory.max': GB, 'memory.current': 0 })) writeFileSync(join(bare, f), `${v}\n`);
  const p = unit(join(c, 'citadel-claude-6.service'), { current: 9 * GB });
  for (const other of ['citadel-turns.slice', 'claude-coordinator.service', 'citadel-turn-a-1.service']) unit(join(c, other));
  assert.deepEqual(await containerRooms(c), [{ ino: ino(p), mb: 1024, unit: 'citadel-claude-6.service' }]);
  assert.deepEqual(await containerRooms(join(root, 'nowhere')), []);
});

test("a Taskmaster's container has its own line, apart from its person's", async () => {
  const c = slice('tm');
  const person = unit(join(c, 'citadel-claude-2.service'), { current: 8 * GB });
  const tm = unit(join(c, 'citadel-taskmasters.slice', 'citadel-claude-2-tm.service'), { high: 3 * GB, max: 4 * GB, current: GB });
  unit(join(c, 'citadel-taskmasters.slice', 'citadel-turn-a-3.service'));
  assert.deepEqual(await containerRooms(c), [
    { ino: ino(person), mb: 2048, unit: 'citadel-claude-2.service' },
    { ino: ino(tm), mb: 2048, unit: 'citadel-claude-2-tm.service' },
  ]);
});

test('tools/mem-room reads what publishRooms wrote: each container its own, the host none', async () => {
  const c = slice('e2e');
  const heavy = join(root, 'projects', '.heavy');
  const two = unit(join(c, 'citadel-claude-2.service'), { current: 9 * GB, cache: 500 * MB });
  const three = unit(join(c, 'citadel-claude-3.service'), { current: 5 * GB });
  await publishRooms(c, heavy);
  const info = join(root, 'meminfo');
  writeFileSync(info, 'MemAvailable: 20971520 kB\n');
  const mb = (cgroup: string) => spawnSync(join(import.meta.dirname, '..', 'tools', 'mem-room'), ['mb'], { encoding: 'utf8', env: scriptEnv({ CITADEL_MEM_ROOM_MB: undefined, CITADEL_HEAVY_CGROUP: join(root, 'none'), CITADEL_MEMINFO: info, CITADEL_HEAVY_DIR: heavy, CITADEL_OWN_CGROUP: cgroup }) }).stdout.trim();
  assert.deepEqual([mb(two), mb(three), mb(root)], ['1524', '5120', '20480']);
  // The container stops: its line goes with the next reading.
  rmSync(join(c, 'citadel-claude-3.service'), { recursive: true });
  await publishRooms(c, heavy);
  assert.equal(readFileSync(join(heavy, ROOM_FILE), 'utf8'), `${ino(two)} 1524 citadel-claude-2.service\n`);
  assert.ok(!existsSync(join(heavy, `${ROOM_FILE}.tmp`)), 'written by a rename');
});

test('outside citadel.slice (a dev copy, CI) nothing is written', async () => {
  const heavy = join(root, 'dev', '.heavy');
  await publishRooms(null, heavy);
  assert.ok(!existsSync(heavy));
});
