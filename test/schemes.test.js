import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './wait.ts';
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

test("a scheme's favicon comes from one batched request for every version the page lacks; none without an icon (#1543)", async () => {
  const asked = [];
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.fetch = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ icons: { 1.5: 'data:a', 2.6: null } }) };
  };
  assert.equal(iconSrc({ id: 1, icon: null }), null);
  assert.equal(iconSrc({ id: 1, icon: 5 }), null); // not here yet: it is asked for
  assert.equal(iconSrc({ id: 2, icon: 6 }), null);
  await until('the batch answered', () => iconSrc({ id: 1, icon: 5 }) !== null);
  assert.deepEqual(asked, ['api/icons?ids=1.5,2.6']);
  assert.equal(iconSrc({ id: 1, icon: 5 }), 'data:a'); // kept: no second request
  assert.equal(iconSrc({ id: 2, icon: 6 }), null);
  assert.equal(asked.length, 1);
});
