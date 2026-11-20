import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessWindow } from '../src/runner.ts';

test('the window guess: a [1m] model has 1M, anything else 200k', () => {
  assert.equal(guessWindow('claude-opus-5-5[1m]'), 1_000_000);
  assert.equal(guessWindow('claude-sonnet-5-5'), 200_000);
  assert.equal(guessWindow(null), 200_000);
});
