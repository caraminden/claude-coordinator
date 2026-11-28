// The desktop app's reload keys (desktop/keys.cjs, #1526).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { reloadKey, devtoolsKey } = createRequire(import.meta.url)('../desktop/keys.cjs');
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

test('Ctrl+Shift+I opens DevTools, and nothing near it does (#1665)', () => {
  const key = (k: string, mods: object = {}) => devtoolsKey({ type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, ...mods });
  assert.equal(key('I', { control: true, shift: true }), true);
  assert.equal(key('i', { control: true, shift: true }), true);
  assert.equal(key('i', { control: true }), false);
  assert.equal(key('I', { shift: true }), false);
  assert.equal(key('I', { control: true, shift: true, alt: true }), false);
  assert.equal(devtoolsKey({ type: 'keyUp', key: 'I', control: true, shift: true }), false);
  assert.equal(devtoolsKey(null), false);
  assert.equal(down('I', { control: true, shift: true }), null);
});

test('a bare F12 opens DevTools too (#2274)', () => {
  const key = (k: string, mods: object = {}) => devtoolsKey({ type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, ...mods });
  assert.equal(key('F12'), true);
  assert.equal(key('F12', { control: true }), false);
  assert.equal(key('F12', { alt: true }), false);
  assert.equal(devtoolsKey({ type: 'keyUp', key: 'F12' }), false);
  assert.equal(down('F12'), null);
});
