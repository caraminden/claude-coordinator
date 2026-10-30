import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEnter } from '../public/lists.js';

// Applies Enter with the caret at `|`, the way continueList does.
const enter = (s: string) => {
  const at = s.indexOf('|');
  const value = s.replace('|', '');
  const edit = listEnter(value, at, at);
  return edit && `${value.slice(0, edit.from)}${edit.text}|${value.slice(edit.to)}`;
};

test('Enter on a numbered item starts the next one', () => {
  assert.equal(enter('1.|'), '1.\n2. |');
  assert.equal(enter('Plan:\n1. look|'), 'Plan:\n1. look\n2. |');
  assert.equal(enter('9) nine|'), '9) nine\n10) |');
  assert.equal(enter('  3. indented|'), '  3. indented\n  4. |');
});

test('Enter mid-item moves the rest of the line into the next item', () => {
  assert.equal(enter('1. ab|cd'), '1. ab\n2. |cd');
});

test('Enter on an empty item after another ends the list', () => {
  assert.equal(enter('1. a\n2. |'), '1. a\n|');
  assert.equal(enter('1. a\n2.|'), '1. a\n|');
});

test('Enter elsewhere is left alone', () => {
  assert.equal(enter('hello|'), null);
  assert.equal(enter('1.5 litres|'), null);
  assert.equal(enter('In 2026. it rained|'), null);
  assert.equal(enter('- bullet|'), null);
  assert.equal(enter('|1. before the marker'), null);
  assert.equal(listEnter('1. a', 0, 4), null);
});
