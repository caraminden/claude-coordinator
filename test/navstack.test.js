import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGoBack, canGoForward, step } from '../public/navstack.js';

const start = { id: 'x', entries: ['#/p/2'], idx: 0 };

test('a fresh stack has nowhere to go: Back never leaves the app', () => {
  assert.equal(canGoBack(start), false);
  assert.equal(canGoForward(start), false);
  assert.equal(canGoBack(null), false);
});

test('opening views adds entries; going back and forth moves along them', () => {
  let s = step(start, { hash: '#/p/2/t/5' });
  s = step(s, { hash: '#/p/2/t/9' });
  assert.deepEqual(s.entries, ['#/p/2', '#/p/2/t/5', '#/p/2/t/9']);
  assert.equal(s.idx, 2);
  assert.equal(canGoBack(s), true);
  assert.equal(canGoForward(s), false);
  s = step(s, { hash: '#/p/2/t/5', at: 1 });
  assert.equal(canGoBack(s), true);
  assert.equal(canGoForward(s), true);
  s = step(s, { hash: '#/p/2', at: 0 });
  assert.equal(canGoBack(s), false);
  assert.equal(canGoForward(s), true);
});

test('opening a view after going back drops what was forward, as a browser does', () => {
  let s = step(step(start, { hash: '#/p/2/t/5' }), { hash: '#/p/2/t/9' });
  s = step(s, { hash: '#/p/2', at: 0 });
  s = step(s, { hash: '#/p/2/t/7' });
  assert.deepEqual(s.entries, ['#/p/2', '#/p/2/t/7']);
  assert.equal(canGoForward(s), false);
});

test('a replaced address takes the current entry\'s place', () => {
  let s = step(start, { hash: '#/p/2/t/5' });
  s = step(s, { hash: '#/p/2/t/5/x', replaced: true });
  assert.deepEqual(s.entries, ['#/p/2', '#/p/2/t/5/x']);
  assert.equal(s.idx, 1);
});

test('the stack keeps the newest 100 entries', () => {
  let s = start;
  for (let i = 0; i < 150; i++) s = step(s, { hash: `#/p/2/t/${i}` });
  assert.equal(s.entries.length, 100);
  assert.equal(s.entries.at(-1), '#/p/2/t/149');
  assert.equal(s.idx, 99);
});

test('a move to a place past the end lands on the last entry', () => {
  const s = step(step(start, { hash: '#/p/2/t/5' }), { hash: '#/p/2/t/5', at: 7 });
  assert.equal(s.idx, 1);
});
