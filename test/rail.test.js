import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensApart, railItems } from '../public/rail.js';

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
  // One that isn't up (service down, keys that don't open) gets a greyed letter tile: nothing is fetched from it.
  const down = railItems([{ ...mine[0], up: false }, { ...mine[1], up: true }], '/');
  assert.deepEqual(down.map((i) => [i.icon, i.down]), [['/icon.svg', undefined], [null, true], [null, false]]);
  // In a preview, Citadel is its preview's root.
  assert.equal(railItems(mine, '/preview/4/', '/preview/4/')[0].href, '/preview/4/');
});

test("in an installed app, another app's entry opens apart so Chrome hands it to that app; in a tab, same tab", () => {
  const items = railItems([{ name: 'mandate', title: 'Mandate' }], '/c/', '/c/');
  assert.deepEqual(items.map((i) => opensApart(i, true)), [false, true]); // Citadel is where you are
  assert.deepEqual(items.map((i) => opensApart(i, false)), [false, false]);
  // The way back from a contraption's own app hands off to Citadel's.
  const inMandate = railItems([{ name: 'mandate', title: 'Mandate' }], '/apps/mandate/', '/c/');
  assert.deepEqual(inMandate.map((i) => opensApart(i, true)), [true, false]);
});
