import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sides, summary } from '../tools/ship-runs.ts';

test('ship runs either side of a moment, oldest first, with the green rate and the median minutes', () => {
  const run = (id: number, min: number, conclusion: string | null, branch = 'land/x') => ({ id, head_branch: branch, conclusion, run_started_at: new Date(min * 60_000).toISOString(), updated_at: new Date((min + 10) * 60_000).toISOString() });
  const runs = [run(1, 0, 'success'), run(2, 20, 'failure'), run(3, 40, 'success'), run(4, 45, 'cancelled'), run(5, 60, 'success'), run(6, 80, null), run(7, 90, 'success', 'check/x'), run(8, 95, 'success')];
  const { before, after } = sides(runs, 52 * 60_000, 2);
  assert.deepEqual(
    before.map((r) => r.id),
    [2, 3],
    'the last two that ended before it; run 4 was still going',
  );
  assert.deepEqual(
    after.map((r) => r.id),
    [5, 8],
    'the first two started after it, ended, and a ship',
  );
  assert.deepEqual(summary(before), { runs: 2, green: 1, red: 1, other: 0, rate: 50, minutes: 10 });
  assert.equal(summary([]).rate, null);
});
