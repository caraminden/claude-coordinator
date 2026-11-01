// Citadel's service worker (public/sw.js, scope /) keeps out of contraptions under /apps/, which bring
// their own worker (the brief's section 3): it answers no request of theirs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('the service worker answers Citadel\'s page loads but no /apps/ request', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const self = { addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn) };
  new Function('self', 'fetch', readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8'))(self, () => new Promise(() => {}));
  const answered = (url: string, mode = 'navigate') => {
    let called = false;
    listeners.fetch({ request: { url, mode }, respondWith: () => (called = true) });
    return called;
  };
  assert.equal(answered('https://citadel.example/'), true);
  assert.equal(answered('https://citadel.example/project/2'), true);
  assert.equal(answered('https://citadel.example/apps/mandate/'), false);
  assert.equal(answered('https://citadel.example/apps/peek-auras/link?x=1'), false);
  assert.equal(answered('https://citadel.example/apps/mandate/app.js', 'no-cors'), false);
});
