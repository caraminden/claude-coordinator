import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.document = { addEventListener() {}, body: {} };
const { quoteOf } = await import('../public/selectact.js');

test('a selection becomes a quote with room to type below', () => {
  assert.equal(quoteOf('one sentence'), '> one sentence\n\n');
  assert.equal(quoteOf(' a\n\nb \n'), '> a\n>\n> b\n\n');
});
