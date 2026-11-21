import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/mem-room (#1340): the room heavy work has in memory, and the test workers it pays for.
const bin = join(import.meta.dirname, '..', 'tools', 'mem-room');
const root = mkdtempSync(join(tmpdir(), 'mem-room-'));
after(() => rmSync(root, { recursive: true, force: true }));
const run = (args: string[], env: Record<string, string | undefined>) =>
  spawnSync(bin, args, { encoding: 'utf8', env: scriptEnv({ CITADEL_MEM_ROOM_MB: undefined, CITADEL_MEMINFO: undefined, CITADEL_HEAVY_CGROUP: undefined, CITADEL_TEST_MB_PER_WORKER: undefined, CITADEL_MEM_CORES: '16', ...env }) });
const workers = (room: number, extra: Record<string, string> = {}) => Number(run(['workers'], { CITADEL_MEM_ROOM_MB: String(room), ...extra }).stdout);

test('workers are the room over 350 MB, at least 1 and at most half the cores', () => {
  assert.equal(workers(100), 1, 'no room still runs one');
  assert.equal(workers(349), 1);
  assert.equal(workers(700), 2);
  assert.equal(workers(1200), 3);
  assert.equal(workers(100000), 8, 'half of 16 cores');
  assert.equal(workers(100000, { CITADEL_MEM_CORES: '1' }), 1);
  assert.equal(workers(600, { CITADEL_TEST_MB_PER_WORKER: '100' }), 6);
});

test('room is the smaller of MemAvailable and the heavy slice\'s headroom below its limit', () => {
  const info = join(root, 'meminfo');
  writeFileSync(info, 'MemTotal: 30000000 kB\nMemAvailable:    8388608 kB\n'); // 8192 MB
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: join(root, 'none') }).stdout.trim(), '8192');
  const cg = join(root, 'slice');
  mkdirSync(cg);
  writeFileSync(join(cg, 'memory.current'), String(7000 * 1048576));
  writeFileSync(join(cg, 'memory.high'), String(8192 * 1048576));
  writeFileSync(join(cg, 'memory.max'), 'max');
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '1192', 'the slice is nearly full');
  writeFileSync(join(cg, 'memory.current'), String(9000 * 1048576));
  assert.equal(run(['mb'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '0', 'over its high mark: no room');
  assert.equal(run(['workers'], { CITADEL_MEMINFO: info, CITADEL_HEAVY_CGROUP: cg }).stdout.trim(), '1');
});

test('with no reading it fails, so a caller keeps its own default', () => {
  const r = run(['workers'], { CITADEL_MEMINFO: join(root, 'missing'), CITADEL_HEAVY_CGROUP: join(root, 'nope') });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});
