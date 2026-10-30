import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auth, looksLikeUrl, type Nonces } from '../src/auth.ts';

test('a site address is not a name', () => {
  assert.ok(looksLikeUrl('https//cara.apps.webplatformisbestplatf'));
  assert.ok(looksLikeUrl('https://cara.apps.webplatformisbestplatform.net'));
  assert.ok(looksLikeUrl('cara.apps.example.net/'));
  assert.ok(!looksLikeUrl('Josh'));
  assert.ok(!looksLikeUrl('J.R. Smith'));
});

test('a session cookie naming a site address no longer signs in', () => {
  const auth = new Auth('a-password-long-enough', 'x'.repeat(32));
  const cookie = (name: string) => ({ headers: { cookie: auth.issueCookie({ id: 1, name }, false).split(';')[0] } }) as any;
  assert.equal(auth.session(cookie('Josh'))?.name, 'Josh');
  assert.equal(auth.session(cookie('https//cara.apps.webplatformisbestplatf')), null);
});

test('an agent token lives for its turn: the next turn or closing the minion kills it', () => {
  const kept = new Map<number, Nonces>();
  const closed = new Set<number>();
  const gone = new Set<number>();
  const auth = new Auth('a-password-long-enough', 'x'.repeat(32), {
    get: (id) => gone.has(id) ? null : { ...kept.get(id) ?? { current: null, previous: null }, closed: closed.has(id) },
    set: (id, nonces) => void kept.set(id, nonces),
  });
  const as = (token: string, method = 'GET', url = '/api/tickets/7') => auth.session({ method, url, headers: { authorization: `Bearer ${token}` } } as any)?.agent;
  const report = (token: string) => as(token, 'POST', '/api/tickets/7/deploy');

  // The old kind of token works until the minion's first turn token, then never again.
  const old = auth.agentToken(7);
  assert.equal(as(old), 7);
  const first = auth.turnToken(7);
  assert.equal(as(first), 7);
  assert.equal(as(old), undefined);
  assert.equal(report(old), undefined);

  // A new turn kills the last one's token, except for its deploy report.
  const second = auth.turnToken(7);
  assert.notEqual(second, first);
  assert.equal(as(second), 7);
  assert.equal(as(first), undefined);
  assert.equal(as(first, 'POST', '/api/tickets/7/questions'), undefined);
  assert.equal(as(first, 'POST', '/api/tickets/8/deploy'), undefined);
  assert.equal(report(first), 7);
  auth.turnToken(7);
  assert.equal(report(first), undefined);

  // A forged nonce, or a real one under another minion's number, doesn't sign in.
  const [, nonce, sig] = auth.turnToken(7).split('.');
  assert.equal(as(`7.${nonce.replace(/^./, (c) => c === 'A' ? 'B' : 'A')}.${sig}`), undefined);
  assert.equal(as(`8.${nonce}.${sig}`), undefined);

  // A dismissed minion's token only posts the deploy report it may still be waiting on; a deleted one's is dead.
  const last = auth.turnToken(7);
  closed.add(7);
  assert.equal(as(last), undefined);
  assert.equal(report(last), 7);
  kept.delete(7);
  gone.add(7);
  assert.equal(report(last), undefined);
});
