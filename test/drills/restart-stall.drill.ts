// Drill 4 (#1326): 3 restarts in quick succession, then the event loop held for 2 s (the server frozen with SIGSTOP, so
// the stall is real to it). Every stall the server logs is a health_events row the Status page reads: A4 (rows dropped
// for 10 minutes after a boot) was closed by #1295, which keeps a boot's stalls as their own kind.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { until } from '../helpers.ts';
import { Drill, signal } from './harness.ts';

const d = new Drill('restart-stall');
after(() => d.cleanup());
const STALL = /^The event loop was held for/;

test('a stall after 3 restarts in 10 minutes is recorded (A4)', async () => {
  await d.boot();
  for (let i = 0; i < 3; i++) await d.restart();
  const pid = d.srv!.proc.pid!;
  signal(pid, 'SIGSTOP');
  await new Promise((r) => setTimeout(r, 2_000));
  signal(pid, 'SIGCONT');
  await until('the server logged the stall', () => d.logged(STALL) > 0, 20_000);
  // The row goes through the write queue, which takes at most a moment.
  const rows = () => d.rows("SELECT detail FROM health_events WHERE kind IN ('loop-lag', 'loop-lag-boot')").length;
  await until('the stall recorded', () => rows() >= d.logged(STALL), 10_000).catch(() => {
    assert.fail(`A4: the server logged ${d.logged(STALL)} stall(s) and recorded ${rows()}`);
  });
});
