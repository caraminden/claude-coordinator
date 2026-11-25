// secret-check.js (#838): every "key is…" in a message is looked at, not only the first (#1860, HP14).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksSecret } from '../public/secret-check.js';

test('a password after an earlier harmless "key is…" in the same message is still caught', () => {
  assert.equal(looksSecret('the key is below. password: hunter22'), 'hunter22');
  assert.equal(looksSecret('the key is the name, the token is the one above'), null);
});
