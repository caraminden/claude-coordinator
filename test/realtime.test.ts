import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { readSched, SCHED_OTHER, SCHED_RR, startRealtime } from '../src/realtime.ts';

const canRt = (() => {
  try {
    return spawnSync('chrt', ['-r', '1', 'true']).status === 0;
  } catch {
    return false;
  }
})();

test('a failing chrt logs one line and the server carries on', async () => {
  const lines: string[] = [];
  let calls = 0;
  const rt = startRealtime({ enabled: () => true, log: (l) => lines.push(l), run: async () => { calls++; throw new Error('Operation not permitted'); }, everyMs: 1e9 });
  await rt.tick();
  await rt.tick();
  rt.stop();
  assert.equal(calls, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not set, carrying on at normal priority: Operation not permitted/);
});

test('off asks for nothing', async () => {
  let calls = 0;
  const rt = startRealtime({ enabled: () => false, log: () => {}, run: async () => { calls++; }, everyMs: 1e9 });
  await rt.tick();
  rt.stop();
  assert.equal(calls, 0);
});

// A dev copy of the server's own setup: a process that starts it, with a Worker and a child, then reports every thread's policy.
const SCRIPT = `
import { startRealtime, readSched } from ${JSON.stringify(new URL('../src/realtime.ts', import.meta.url).href)};
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
let enabled = true;
const rt = startRealtime({ enabled: () => enabled, log: () => {}, everyMs: 1e9 });
await rt.tick();
const w = new Worker('setInterval(() => {}, 1000)', { eval: true });
await new Promise((r) => w.once('online', r));
await new Promise((r) => setTimeout(r, 200));
const child = spawn('sleep', ['5']);
await new Promise((r) => setTimeout(r, 100));
await rt.tick();
const pol = async (pid, tid) => (await readSched(pid, tid))?.policy;
const threads = readdirSync('/proc/self/task').map(Number);
const out = { main: await readSched(process.pid, process.pid), others: await Promise.all(threads.filter((t) => t !== process.pid).map((t) => pol(process.pid, t))), child: await pol(child.pid, child.pid) };
enabled = false;
await rt.tick();
out.after = await readSched(process.pid, process.pid);
child.kill();
w.terminate();
console.log(JSON.stringify(out));
process.exit(0);
`;

test('main thread is SCHED_RR 1; every other thread and child stay SCHED_OTHER; off puts it back', { skip: !canRt && 'no real-time priority on this box' }, () => {
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').pop()!);
  assert.deepEqual(out.main, { prio: 1, policy: SCHED_RR });
  assert.ok(out.others.length > 1, 'the process has other threads');
  assert.deepEqual([...new Set(out.others)], [SCHED_OTHER]);
  assert.equal(out.child, SCHED_OTHER);
  assert.equal(out.after.policy, SCHED_OTHER);
});
