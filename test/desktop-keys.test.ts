// The desktop app's reload keys (desktop/keys.cjs, #1526).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { reloadKey } = createRequire(import.meta.url)('../desktop/keys.cjs');
const down = (key: string, mods: object = {}) => reloadKey({ type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...mods });

test('Ctrl+R and F5 reload', () => {
  assert.equal(down('r', { control: true }), 'reload');
  assert.equal(down('R', { control: true }), 'reload');
  assert.equal(down('F5'), 'reload');
});

test('Ctrl+Shift+R and Ctrl+F5 reload ignoring the cache', () => {
  assert.equal(down('R', { control: true, shift: true }), 'reload-hard');
  assert.equal(down('F5', { control: true }), 'reload-hard');
});

test('plain R, key-ups and other combinations do nothing', () => {
  assert.equal(down('r'), null);
  assert.equal(down('r', { control: true, alt: true }), null);
  assert.equal(down('F5', { shift: true }), null);
  assert.equal(reloadKey({ type: 'keyUp', key: 'F5' }), null);
  assert.equal(reloadKey(null), null);
});
