import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStretch, MAX_STRETCH } from '../src/load-stretch.ts';

test('a quiet box keeps each limit as it is and adds nothing to the failure', () => {
  for (const load of [0, 3, 16]) {
    const s = loadStretch(load, 16);
    assert.equal(s.ms(10_000), 10_000);
    assert.equal(s.why, '');
  }
});

test('a busy box stretches a limit by load over cores, in whole seconds, and says so', () => {
  // The load of the refused ships of Nov 21 (#1514): 53 on 16 cores.
  const s = loadStretch(53, 16);
  assert.equal(s.ms(10_000), 34_000);
  assert.equal(s.ms(20_000), 67_000);
  assert.equal(s.why, ' (stretched 3.3x for load 53 on 16 cores)');
});

test('the stretch stops at its cap, so the 3-minute backstop still decides a hang', () => {
  const s = loadStretch(500, 16);
  assert.equal(s.by, MAX_STRETCH);
  assert.equal(s.ms(30_000), 30_000 * MAX_STRETCH);
});

test("the default core count is the box's, not the service cgroup quota (#1539)", async () => {
  const { cpus } = await import('node:os');
  const { cores } = await import('../src/host-signals.ts');
  assert.equal(cores(), cpus().length);
});
