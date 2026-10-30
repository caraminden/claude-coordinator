import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueList, listEnter } from '../public/lists.js';

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

test('Only the key that adds a line continues a list; plain Enter still sends', () => {
  (globalThis as any).document = { execCommand: () => true };
  const key = (e: object, enterAddsLine?: boolean) => {
    const box = { value: '1. a', selectionStart: 4, selectionEnd: 4, setSelectionRange() {} };
    return continueList(box, { key: 'Enter', preventDefault() {}, ...e }, enterAddsLine);
  };
  assert.equal(key({}), false);
  assert.equal(key({ shiftKey: true }), true);
  assert.equal(key({}, true), true);
  assert.equal(key({ shiftKey: true, ctrlKey: true }), false);
  delete (globalThis as any).document;
});
