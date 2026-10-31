import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconSrc, startScheme } from '../public/schemes.js';

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

test("a scheme's favicon URL carries its version, so a merged new icon is fetched afresh; none without one", () => {
  assert.equal(iconSrc({ id: 1, icon: null }), null);
  assert.equal(iconSrc({ id: 1, icon: 5 }), 'api/projects/1/icon?v=5');
  assert.notEqual(iconSrc({ id: 1, icon: 6 }), iconSrc({ id: 1, icon: 5 }));
});
