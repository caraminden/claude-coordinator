import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, edgeSide, settleOpen } from '../public/drawers.js';

test('a swipe has to start at a screen edge', () => {
  assert.equal(edgeSide(5, 390), 'left');
  assert.equal(edgeSide(24, 390), 'left');
  assert.equal(edgeSide(100, 390), null);
  assert.equal(edgeSide(380, 390), 'right');
  assert.equal(edgeSide(360, 390), null);
});

test('only mostly-horizontal moves in the opening direction are swipes', () => {
  assert.equal(classify(4, 3, 1), 'wait');
  assert.equal(classify(40, 5, 1), 'swipe');
  assert.equal(classify(-40, 5, -1), 'swipe');
  assert.equal(classify(-40, 5, 1), 'ignore'); // wrong way
  assert.equal(classify(20, 30, 1), 'ignore'); // vertical scroll
  assert.equal(classify(20, 18, 1), 'ignore'); // diagonal
});

test('a released drawer settles by flick speed, then by distance', () => {
  assert.equal(settleOpen(0.2, 0.8), true);
  assert.equal(settleOpen(0.9, -0.8), false);
  assert.equal(settleOpen(0.6, 0), true);
  assert.equal(settleOpen(0.4, 0.1), false);
});
