// The hover title of a state-coloured minion link (public/threadstate.js refTitle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refTitle } from '../public/threadstate.js';

test('refTitle puts the state words after the number', () => {
  assert.equal(refTitle('#12 Fix it', 12, 'working'), '#12 · working · Fix it');
  assert.equal(refTitle('Delve #68 Laptop (owns PR #186)', 68, 'waiting'), 'Delve #68 · waiting · Laptop (owns PR #186)');
  assert.equal(refTitle('', 12, 'deployed'), '#12 · deployed');
  assert.equal(refTitle('Five', 5, 'working'), 'Five · working');
  assert.equal(refTitle('#12 Fix it', 12, undefined), '#12 Fix it', 'neutral keeps the title as it was');
});
