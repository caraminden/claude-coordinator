import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScheme, tileHue, tileLetter } from '../public/schemes.js';

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

test("a letter tile shows the name's first letter or digit, and keeps its hue through a rename", () => {
  assert.equal(tileLetter('citadel'), 'C');
  assert.equal(tileLetter('  #2 peek'), '2');
  assert.equal(tileLetter('Éclair'), 'É');
  assert.equal(tileLetter('—'), '?');
  assert.equal(tileHue(7), tileHue(7));
  assert.notEqual(tileHue(1), tileHue(2));
  assert.ok(tileHue(12345) >= 0 && tileHue(12345) < 360);
});
