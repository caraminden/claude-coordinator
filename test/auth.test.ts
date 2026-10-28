import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auth, looksLikeUrl } from '../src/auth.ts';

test('a site address is not a name', () => {
  assert.ok(looksLikeUrl('https//cara.apps.webplatformisbestplatf'));
  assert.ok(looksLikeUrl('https://cara.apps.webplatformisbestplatform.net'));
  assert.ok(looksLikeUrl('cara.apps.example.net/'));
  assert.ok(!looksLikeUrl('Josh'));
  assert.ok(!looksLikeUrl('J.R. Smith'));
});

test('a session cookie naming a site address no longer signs in', () => {
  const auth = new Auth('a-password-long-enough', 'x'.repeat(32));
  const cookie = (name: string) => ({ headers: { cookie: auth.issueCookie(name, false).split(';')[0] } }) as any;
  assert.equal(auth.session(cookie('Josh'))?.name, 'Josh');
  assert.equal(auth.session(cookie('https//cara.apps.webplatformisbestplatf')), null);
});
