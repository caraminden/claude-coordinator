import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueList, listEnter } from '../public/ui/composer.js';

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

// A textarea 3 lines of 20px tall, whose copies measure 20px per line of their value.
const fakeBox = (value: string, caret: number, scrollTop = 0) => {
  const box: any = {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    scrollTop,
    clientHeight: 60,
    offsetWidth: 300,
    setSelectionRange() {},
    after() {},
    cloneNode: () => ({
      style: { cssText: '' },
      removeAttribute() {},
      remove() {},
      get scrollHeight() {
        return this.value.split('\n').length * 20;
      },
    }),
  };
  return box;
};

test('Only the key that adds a line continues a list; plain Enter still sends', () => {
  (globalThis as any).document = { execCommand: () => true };
  const key = (e: object, enterAddsLine?: boolean) => {
    const box = fakeBox('1. a', 4);
    return continueList(box, { key: 'Enter', preventDefault() {}, ...e }, enterAddsLine);
  };
  assert.equal(key({}), false);
  assert.equal(key({ shiftKey: true }), true);
  assert.equal(key({}, true), true);
  assert.equal(key({ shiftKey: true, ctrlKey: true }), false);
  delete (globalThis as any).document;
});

test('A new item below the bottom edge scrolls the box down to it; one in view leaves it be', () => {
  // The scripted insert stands in for execCommand: it adds the item and moves the caret past it.
  const press = (value: string, caret: number, scrollTop: number) => {
    const box = fakeBox(value, caret, scrollTop);
    (globalThis as any).document = {
      execCommand: (_: string, __: boolean, text: string) => {
        box.value = box.value.slice(0, caret) + text + box.value.slice(caret);
        box.selectionStart = box.selectionEnd = caret + text.length;
        return true;
      },
    };
    continueList(box, { key: 'Enter', shiftKey: true, preventDefault() {} });
    delete (globalThis as any).document;
    return box.scrollTop;
  };
  const list = '1. a\n2. b\n3. c\n4. d';
  assert.equal(press(list, list.length, 20), 40); // "5. " is line 5: scrolled so it's the bottom line
  assert.equal(press(list, 9, 0), 0); // "3. " lands on line 3, still in view
});
