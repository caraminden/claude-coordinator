// every(): one helper for periodic jobs, recording each run (#1311). A mocked clock, so no test waits on a busy box.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { every, jobList, SLOW_MS } from '../src/every.ts';

const row = (name: string) => jobList().find((j) => j.name === name)!;
// Lets a run's awaits and its finally settle after a tick.
const settle = () => new Promise((r) => setImmediate(r));

test('a throwing job is recorded, logged, and runs again on the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => void logged.push(a));
  let calls = 0;
  const job = every('throws', 1000, () => {
    calls++;
    throw new Error(`boom ${calls}`);
  });
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(row('throws').fails, 1);
  assert.equal(row('throws').error, 'boom 1');
  t.mock.timers.tick(1000);
  await settle();
  const r = row('throws');
  assert.equal(calls, 2, 'ran again after throwing');
  assert.deepEqual([r.runs, r.fails, r.running, r.error], [2, 2, 0, 'boom 2']);
  assert.equal(r.last, Date.now());
  assert.equal(r.errorAt, Date.now());
  assert.equal(logged.length, 2);
  assert.match(String(logged[0][0]), /Background job "throws" failed/);
  job.stop();
  assert.equal(
    jobList().some((j) => j.name === 'throws'),
    false,
    'stop drops it from the list',
  );
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2, 'stop clears the timer');
});

test("a rejecting async job is recorded the same way, and a run's wall time is its duration", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  t.mock.method(console, 'error', () => {});
  const job = every('rejects', 60_000, async () => {
    t.mock.timers.tick(300);
    throw new Error('nope');
  });
  const p = job.run();
  await p;
  const r = row('rejects');
  assert.deepEqual([r.running, r.error, r.took], [0, 'nope', 300]);
  job.stop();
});

test('a slow run finishing after a newer fast one keeps the newer duration', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  let release!: () => void;
  let n = 0;
  const job = every('overlap', 60_000, () => (n++ === 0 ? new Promise<void>((r) => (release = r)) : undefined));
  const slow = job.run();
  assert.equal(row('overlap').running, 1);
  t.mock.timers.tick(5000);
  await job.run();
  assert.equal(row('overlap').took, 0);
  release();
  await slow;
  assert.equal(row('overlap').took, 0, 'the older run does not overwrite it');
  job.stop();
});

test('first: 0 runs now, a later first runs once before the period', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  let a = 0,
    b = 0;
  const now = every('first-now', 60_000, () => void a++, 0);
  const soon = every('first-soon', 60_000, () => void b++, 20);
  assert.equal(a, 1);
  t.mock.timers.tick(20);
  assert.equal(b, 1);
  t.mock.timers.tick(60_000 - 20);
  assert.deepEqual([a, b], [2, 2]);
  now.stop();
  soon.stop();
});

test('overdue after 3 periods without a run, slow over SLOW_MS', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const job = every('marks', 1000, () => {});
  const r = row('marks');
  assert.equal(r.overdue, false);
  assert.equal(jobList(r.firstAt + 2 * 1000).find((j) => j.name === 'marks')!.overdue, false);
  assert.equal(jobList(r.firstAt + 2 * 1000 + 1).find((j) => j.name === 'marks')!.overdue, true);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(row('marks').overdue, false);
  assert.equal(row('marks').slow, false);
  job.stop();
  const slow = every('slow', 60_000, () => t.mock.timers.tick(SLOW_MS + 1));
  await slow.run();
  assert.equal(row('slow').slow, true);
  slow.stop();
});
