import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appOrder, remember, switchKey } from '../public/appswitch.js';

const key = (code, o = {}) => ({ type: 'keydown', code, key: code === 'Backquote' ? '`' : code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o });
const altUp = { type: 'keyup', key: 'Alt', code: 'AltLeft', altKey: false };

test('order: where you are first, then most recently used, then never used in rail order', () => {
  const names = ['', 'mandate', 'peek', 'toc'];
  assert.deepEqual(appOrder([], names, ''), ['', 'mandate', 'peek', 'toc']);
  assert.deepEqual(appOrder(['peek', '', 'mandate'], names, 'peek'), ['peek', '', 'mandate', 'toc']);
  // An app no longer on the rail (disabled, or down) drops out.
  assert.deepEqual(appOrder(['gone', 'toc', 'peek'], names, ''), ['', 'toc', 'peek', 'mandate']);
});

test('remember moves an app to the front without repeats', () => {
  assert.deepEqual(remember(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
  assert.deepEqual(remember([], ''), ['']);
  assert.equal(
    remember(
      Array.from({ length: 40 }, (_, i) => String(i)),
      'x',
    ).length,
    30,
  );
});

test('one quick Alt+` flips to the last app', () => {
  const order = ['here', 'last', 'older'];
  let r = switchKey(null, key('Backquote'), order);
  assert.deepEqual([r.act, r.state.index, r.consume], ['open', 1, true]);
  r = switchKey(r.state, altUp, order);
  assert.deepEqual([r.act, r.to, r.state, r.consume], ['commit', 'last', null, true]);
});

test('holding Alt, ` moves on and wraps, Shift+` moves back', () => {
  const order = ['a', 'b', 'c'];
  let s = switchKey(null, key('Backquote'), order).state;
  s = switchKey(s, key('Backquote'), order).state;
  assert.equal(s.index, 2);
  s = switchKey(s, key('Backquote'), order).state;
  assert.equal(s.index, 0);
  s = switchKey(s, key('Backquote', { shiftKey: true }), order).state;
  assert.equal(s.index, 2);
  // Shift's own keyup (Alt still held) doesn't switch.
  const r = switchKey(s, { type: 'keyup', key: 'Shift', altKey: true }, order);
  assert.deepEqual([r.act, r.state.index, r.consume], [null, 2, false]);
  assert.equal(switchKey(s, altUp, order).to, 'c');
});

test('Shift+Alt+` opens on the far end', () => {
  assert.equal(switchKey(null, key('Backquote', { shiftKey: true }), ['a', 'b', 'c']).state.index, 2);
});

test('Esc cancels and Enter switches at once', () => {
  const order = ['a', 'b'];
  const s = switchKey(null, key('Backquote'), order).state;
  const esc = switchKey(s, key('Escape', { key: 'Escape' }), order);
  assert.deepEqual([esc.act, esc.state, esc.consume], ['cancel', null, true]);
  // Alt's keyup after a cancel is nothing to the switcher.
  assert.deepEqual(switchKey(null, altUp, order), { state: null, act: null, consume: false });
  const enter = switchKey(s, key('Enter', { key: 'Enter' }), order);
  assert.deepEqual([enter.act, enter.to], ['commit', 'b']);
});

test('the Alt release is caught whatever key name the system gives it', () => {
  const s = switchKey(null, key('Backquote'), ['a', 'b']).state;
  // X11 reports Alt let go after Shift as Meta.
  const r = switchKey(s, { type: 'keyup', key: 'Meta', altKey: false }, ['a', 'b']);
  assert.deepEqual([r.act, r.to, r.consume], ['commit', 'b', true]);
});

test('other keys while Alt is held are swallowed; a key after an unheard Alt release switches and goes through', () => {
  const s = switchKey(null, key('Backquote'), ['a', 'b']).state;
  const f = switchKey(s, key('KeyF', { key: 'f' }), ['a', 'b']);
  assert.deepEqual([f.act, f.state, f.consume], [null, s, true]);
  const late = switchKey(s, key('KeyX', { key: 'x', altKey: false }), ['a', 'b']);
  assert.deepEqual([late.act, late.to, late.consume], ['commit', 'b', false]);
});

test('Alt+` opens only with somewhere to go, and not with Ctrl (AltGr), Meta (Cmd+`) or mid-IME', () => {
  for (const [e, order] of [
    [key('Backquote'), ['only']],
    [key('Backquote', { altKey: false }), ['a', 'b']],
    [key('Backquote', { ctrlKey: true }), ['a', 'b']],
    [key('Backquote', { metaKey: true }), ['a', 'b']],
    [key('Backquote', { isComposing: true }), ['a', 'b']],
    [key('Tab', { key: 'Tab', altKey: false }), ['a', 'b']],
    [{ ...key('Backquote'), type: 'keyup' }, ['a', 'b']],
  ])
    assert.deepEqual(switchKey(null, e, order), { state: null, act: null, consume: false });
});
