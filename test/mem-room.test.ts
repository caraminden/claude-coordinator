import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/mem-room (#1340): the room heavy work has in memory, and the test workers it pays for.
const bin = join(import.meta.dirname, '..', 'tools', 'mem-room');
const root = mkdtempSync(join(tmpdir(), 'mem-room-'));
after(() => rmSync(root, { recursive: true, force: true }));
const run = (args: string[], env: Record<string, string | undefined>) =>
  spawnSync(bin, args, { encoding: 'utf8', env: scriptEnv({ CITADEL_MEM_ROOM_MB: undefined, CITADEL_MEMINFO: undefined, CITADEL_HEAVY_CGROUP: undefined, CITADEL_HEAVY_DIR: join(root, 'no-heavy'), CITADEL_TEST_MB_PER_WORKER: undefined, CITADEL_MEM_CORES: '16', ...env }) });
const workers = (room: number, extra: Record<string, string> = {}) => Number(run(['workers'], { CITADEL_MEM_ROOM_MB: String(room), ...extra }).stdout);

test('workers are the room over 350 MB, at least 1 and at most half the cores', () => {
  assert.equal(workers(100), 1, 'no room still runs one');
  assert.equal(workers(349), 1);
  assert.equal(workers(700), 2);
  assert.equal(workers(1200), 3);
  assert.equal(workers(100000), 8, 'half of 16 cores');
  assert.equal(workers(100000, { CITADEL_MEM_CORES: '1' }), 1);
  assert.equal(workers(100000, { CITADEL_MEM_CORES: '5' }), 3, 'rounded up, as the old default was');
  assert.equal(workers(600, { CITADEL_TEST_MB_PER_WORKER: '100' }), 6);
});

test("room is the smaller of MemAvailable and the heavy slice's headroom below its limit", () => {
  const info = join(root, 'meminfo');
  writeFileSync(info, 'MemTotal: 30000000 kB\nMemAvailable:    8388608 kB\n'); // 8192 MB
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: join(root, 'none') }).stdout.trim(), '8192');
  const cg = join(root, 'slice');
  mkdirSync(cg);
  writeFileSync(join(cg, 'memory.current'), String(7000 * 1048576));
  writeFileSync(join(cg, 'memory.high'), String(8192 * 1048576));
  writeFileSync(join(cg, 'memory.max'), 'max');
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '1192', 'the slice is nearly full');
  writeFileSync(join(cg, 'memory.stat'), `anon 1\ninactive_file ${2000 * 1048576}\n`);
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '3192', 'reclaimable cache is room');
  rmSync(join(cg, 'memory.stat'));
  writeFileSync(join(cg, 'memory.current'), String(9000 * 1048576));
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '0', 'over its high mark: no room');
  assert.equal(run(['workers'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '1');
});

test('with no reading it fails, so a caller keeps its own default', () => {
  const r = run(['workers'], { CITADEL_MEMINFO: join(root, 'missing'), CITADEL_HEAVY_CGROUP: join(root, 'nope') });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

// #1982: a container's /proc/meminfo is the whole box's, so the server publishes each container's own room (src/container-room.ts).
test("in a container, room is the smaller of MemAvailable and the container's own headroom", () => {
  const info = join(root, 'box-meminfo');
  writeFileSync(info, 'MemAvailable: 20971520 kB\n'); // 20480 MB
  const box = (name: string) => {
    mkdirSync(join(root, name));
    return { path: join(root, name), ino: statSync(join(root, name)).ino };
  };
  const [mine, other, full, unlisted] = ['mine', 'other', 'full', 'unlisted'].map(box) as [ReturnType<typeof box>, ReturnType<typeof box>, ReturnType<typeof box>, ReturnType<typeof box>];
  const dir = join(root, 'heavy');
  mkdirSync(dir);
  const file = join(dir, 'container-room');
  // `other`'s number is longer by a digit and a suffix of a third one's: only the whole inode may match.
  const lines = `${other.ino} 9000 citadel-claude-3.service\n1${mine.ino} 70 citadel-claude-5.service\n${mine.ino}1 71 citadel-claude-6.service\n${mine.ino} 1500 citadel-claude-2.service\n${full.ino} 0 citadel-claude-2-tm.service\n`;
  const env = (cg: string, extra: Record<string, string> = {}) => ({ CITADEL_MEMINFO: info, CITADEL_HEAVY_DIR: dir, CITADEL_OWN_CGROUP: cg, CITADEL_MEM_CORES: '16', ...extra });
  const mb = (cg: string, extra = {}) => run(['mb'], env(cg, extra)).stdout.trim();
  const at = (secondsAgo: number) => utimesSync(file, new Date(), new Date(Date.now() - secondsAgo * 1000));
  const box20 = '20480';

  assert.equal(mb(mine.path), box20, 'no file yet: the box, as before');
  writeFileSync(file, lines);
  assert.equal(mb(mine.path), '1500');
  assert.equal(run(['workers'], env(mine.path)).stdout.trim(), '4', '1500 over 350');
  assert.equal(mb(other.path), '9000', 'each container its own line');
  assert.equal(mb(full.path), '0', 'a full container has no room');
  assert.equal(run(['workers'], env(full.path)).stdout.trim(), '1', 'and still runs one');
  assert.equal(mb(unlisted.path), box20, 'a host turn, or a container with no limit, has no line');
  assert.equal(mb(join(root, 'no-such-cgroup')), box20);
  assert.equal(mb(mine.path, { CITADEL_MEMINFO: join(root, 'missing') }), '1500', 'its own reading is enough');

  writeFileSync(info, 'MemAvailable: 819200 kB\n'); // 800 MB: the box is shorter than the container
  assert.equal(mb(mine.path), '800');
  writeFileSync(info, 'MemAvailable: 20971520 kB\n');

  at(50);
  assert.equal(mb(mine.path), '1500', 'fresh enough');
  at(90);
  assert.equal(mb(mine.path), box20, 'over 60 s old: a stopped server, no reading');
  for (const bad of ['', 'garbage\n', `${mine.ino} \n`, `${mine.ino} x12 a\n`, `${mine.ino} -5 a\n`, `${mine.ino}\n`]) {
    writeFileSync(file, bad);
    const r = run(['mb'], env(mine.path));
    assert.deepEqual([r.stdout.trim(), r.status, r.stderr], [box20, 0, ''], `unreadable: ${JSON.stringify(bad)}`);
  }
  rmSync(file);
  mkdirSync(file);
  const r = run(['workers'], env(mine.path));
  assert.deepEqual([r.stdout.trim(), r.status, r.stderr], ['8', 0, ''], 'not a file: the box, quietly');
});
