import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shareTarget } from '../public/frames.js';

const mandate = { name: 'mandate', title: 'Mandate' };

test('a share goes to Mandate, each field passed on as share_*, re-encoded', () => {
  const to = shareTarget('?title=Caf%C3%A9+%26+bar&text=a%3Db+%231&url=https%3A%2F%2Fex.com%2Fp%3Fq%3D1%26r%3D2', [{ name: 'peek-auras' }, mandate]);
  assert.equal(to.name, 'mandate');
  const url = new URL(to.src, 'https://citadel.test');
  assert.equal(url.pathname, '/apps/mandate/');
  // What Mandate reads back is exactly what was shared: &, =, # and non-ASCII survive the trip.
  assert.deepEqual(
    [...url.searchParams],
    [
      ['share_title', 'Café & bar'],
      ['share_text', 'a=b #1'],
      ['share_url', 'https://ex.com/p?q=1&r=2'],
    ],
  );
  assert.doesNotMatch(to.src, /#/);
});

test('missing fields stay missing, empty ones stay empty, others are dropped', () => {
  assert.equal(shareTarget('?text=hi&other=x', [mandate]).src, '/apps/mandate/?share_text=hi');
  assert.equal(shareTarget('?title=&url=', [mandate]).src, '/apps/mandate/?share_title=&share_url=');
  assert.equal(shareTarget('', [mandate]).src, '/apps/mandate/?');
});

test('without Mandate enabled, nothing takes the share', () => {
  assert.equal(shareTarget('?text=hi', []), null);
  assert.equal(shareTarget('?text=hi', [{ name: 'peek-auras' }]), null);
  assert.equal(shareTarget('?text=hi', undefined), null);
  assert.equal(shareTarget('?text=hi', { error: 'x' }), null);
});

test("Citadel's manifest takes shares by GET at /c/share, inside its scope", () => {
  const m = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.deepEqual(m.share_target, { action: '/c/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } });
  assert.ok(m.share_target.action.startsWith(m.scope));
  assert.equal(m.shortcuts, undefined);
});
