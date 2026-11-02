import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensApart, railItems } from '../public/rail.js';

test('no contraption enabled: no rail at all', () => {
  assert.deepEqual(railItems([], '/'), []);
  assert.deepEqual(railItems(undefined, '/'), []);
});

test('the rail lists Citadel, then each contraption, and marks where you are', () => {
  const mine = [{ name: 'mandate', title: 'Mandate', icon: '/icon.svg' }, { name: 'peek-auras', title: 'Peek Auras', icon: null }];
  // In Citadel, a contraption opens in Citadel's own window (#/apps/<name>, frames.js; #274).
  const inCitadel = railItems(mine, null, '/c/', true);
  assert.deepEqual(inCitadel.map((i) => [i.title, i.href, i.current]), [['Citadel', '/c/', true], ['Mandate', '#/apps/mandate', false], ['Peek Auras', '#/apps/peek-auras', false]]);
  // A contraption's icon is a path it serves; none gets a letter tile.
  assert.deepEqual(inCitadel.map((i) => i.icon), ['/c/icon.svg', '/apps/mandate/icon.svg', null]);
  assert.deepEqual(railItems(mine, 'mandate', '/c/', true).map((i) => i.current), [false, true, false]);
  // From a contraption's own page, the others open in Citadel's window too, through Citadel's root.
  const inMandate = railItems(mine, 'mandate', '/c/');
  assert.deepEqual(inMandate.map((i) => [i.href, i.current]), [['/c/', false], ['/c/#/apps/mandate', true], ['/c/#/apps/peek-auras', false]]);
  // One that isn't up (service down, keys that don't open) gets a greyed letter tile: nothing is fetched from it.
  const down = railItems([{ ...mine[0], up: false }, { ...mine[1], up: true }], null, '/c/', true);
  assert.deepEqual(down.map((i) => [i.icon, i.down]), [['/c/icon.svg', undefined], [null, true], [null, false]]);
  // In a preview, Citadel is its preview's root.
  assert.equal(railItems(mine, null, '/preview/4/c/')[0].href, '/preview/4/c/');
});

test("a contraption's own installed app opens every other entry apart, so Chrome hands it to Citadel's app; in a tab, same tab", () => {
  const items = railItems([{ name: 'mandate', title: 'Mandate' }], 'mandate', '/c/');
  assert.deepEqual(items.map((i) => opensApart(i, true)), [true, false]); // Mandate is where you are
  assert.deepEqual(items.map((i) => opensApart(i, false)), [false, false]);
});
