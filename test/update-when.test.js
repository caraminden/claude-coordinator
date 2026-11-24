import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { shouldReload } from '../public/update-when.js';

const base = { pending: true, hidden: false, navigating: false, unsent: false };

test('a restart with an unchanged front end never reloads, hidden or not', () => {
  // The version is a hash of public/'s content, so the same files give the same version and nothing is pending.
  const version = (files) => createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 12);
  assert.equal(version(['a', 'b']), version(['a', 'b']));
  for (const hidden of [true, false])
    for (const navigating of [true, false]) {
      assert.equal(shouldReload({ ...base, pending: false, hidden, navigating }), false);
    }
});
test('with a changed front end, a visible tab does not reload by itself', () => {
  assert.equal(shouldReload(base), false);
});
test('a visible tab reloads on the next navigation', () => {
  assert.equal(shouldReload({ ...base, navigating: true }), true);
});
test('a hidden tab reloads', () => {
  assert.equal(shouldReload({ ...base, hidden: true }), true);
});
test('unsent work holds a hidden tab and a navigation back', () => {
  assert.equal(shouldReload({ ...base, hidden: true, unsent: true }), false);
  assert.equal(shouldReload({ ...base, navigating: true, unsent: true }), false);
});
