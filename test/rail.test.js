import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railItems } from '../public/rail.js';

test('no contraption enabled: no rail at all', () => {
  assert.deepEqual(railItems([], '/'), []);
  assert.deepEqual(railItems(undefined, '/'), []);
});

test('the rail lists Citadel, then each contraption, and marks where you are', () => {
  const mine = [{ name: 'mandate', title: 'Mandate', icon: '/icon.svg' }, { name: 'peek-auras', title: 'Peek Auras', icon: null }];
  const inCitadel = railItems(mine, '/');
  assert.deepEqual(inCitadel.map((i) => [i.title, i.href, i.current]), [['Citadel', '/', true], ['Mandate', '/apps/mandate/', false], ['Peek Auras', '/apps/peek-auras/', false]]);
  // A contraption's icon is a path it serves; none gets a letter tile.
  assert.deepEqual(inCitadel.map((i) => i.icon), ['/icon.svg', '/apps/mandate/icon.svg', null]);
  const inMandate = railItems(mine, '/apps/mandate/today');
  assert.deepEqual(inMandate.map((i) => i.current), [false, true, false]);
  // In a preview, Citadel is its preview's root.
  assert.equal(railItems(mine, '/preview/4/', '/preview/4/')[0].href, '/preview/4/');
});
