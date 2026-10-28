import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScheme } from '../public/schemes.js';

const list = (...ids) => ids.map((id) => ({ id }));

test('the last-opened scheme wins while it still exists', () => {
  assert.equal(startScheme(list(1, 2, 5), 5), 5);
});

test('falls back to Citadel, then the first scheme', () => {
  assert.equal(startScheme(list(1, 2, 5), 9), 2);
  assert.equal(startScheme(list(1, 2), NaN), 2);
  assert.equal(startScheme(list(4, 7), 9), 4);
});

test('no schemes: nothing to open', () => {
  assert.equal(startScheme([], 2), null);
});
