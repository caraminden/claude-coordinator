import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, percentile } from '../src/stats.ts';

test('median: empty is null, one value is itself, even length averages the middle two, input order does not matter', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  const xs = [3, 1, 2];
  median(xs);
  assert.deepEqual(xs, [3, 1, 2]);
});

test('percentile: nearest rank, p0 is the smallest, p100 the largest, empty is null, unsorted input is fine', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([9], 0.99), 9);
  const xs = [10, 50, 20, 40, 30];
  assert.equal(percentile(xs, 0), 10);
  assert.equal(percentile(xs, 1), 50);
  assert.equal(percentile(xs, 0.5), 30);
  assert.equal(percentile(xs, 0.9), 50);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
});
