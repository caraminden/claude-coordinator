import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
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

test('a session over 7 days old is renewed on use; a newer one, a disabled person\'s, an agent\'s or a preview\'s is not', (t) => {
  const DAY = 86400_000;
  const people = new Map<number, any>([[1, { id: 1, name: 'Cara', disabled_at: null }], [2, { id: 2, name: 'Olive', disabled_at: Date.now() }]]);
  const users = { getUser: (id: number) => people.get(id), findUser: () => undefined } as any;
  const auth = new Auth('a-password-long-enough', 'x'.repeat(32), undefined, users);
  const now = Date.now();
  /** A request carrying a cookie issued `days` ago. */
  const aged = (a: Auth, id: number, days: number) => {
    const clock = t.mock.method(Date, 'now', () => now - days * DAY);
    const cookie = a.issueCookie({ id, name: people.get(id).name }, false).split(';')[0];
    clock.mock.restore();
    return { headers: { cookie } } as any;
  };
  const renewed = auth.renewal(auth.session(aged(auth, 1, 8)), true);
  assert.match(renewed ?? '', /^cc_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000; Secure$/);
  const fresh = auth.session({ headers: { cookie: renewed!.split(';')[0] } } as any)!;
  assert.equal(fresh.uid, 1);
  assert.ok(fresh.exp > now + 179 * DAY, 'the new cookie runs a full 180 days from now');
  assert.equal(auth.renewal(fresh, true), null, 'and is not renewed again on the next request');

  assert.equal(auth.renewal(auth.session(aged(auth, 1, 1)), false), null, 'a day-old session is left alone');
  assert.equal(auth.session(aged(auth, 1, 179))?.uid, 1, 'a session unused for 179 days still signs in');
  assert.equal(auth.session(aged(auth, 1, 181)), null, 'and one unused for 181 days does not');
  // A cookie issued under the old 30-day rule, 2 days ago: renewed on its next request.
  const payload = Buffer.from(JSON.stringify({ name: 'Cara', uid: 1, exp: now + 28 * DAY })).toString('base64url');
  const legacy = { headers: { cookie: `cc_session=${payload}.${createHmac('sha256', 'x'.repeat(32)).update(payload).digest('base64url')}` } } as any;
  assert.equal(auth.session(legacy)?.uid, 1);
  assert.match(auth.renewal(auth.session(legacy), false) ?? '', /Max-Age=15552000$/, 'a 30-day cookie moves to 180 days on its next request');
  assert.equal(auth.session(aged(auth, 2, 8)), null, 'a disabled person is signed out');
  assert.equal(auth.renewal(auth.session(aged(auth, 2, 8)), false), null, 'and gets no fresh cookie');
  assert.equal(auth.renewal({ name: 'Taskmaster', exp: Infinity, agent: 7 }, false), null);
  const preview = new Auth('a-password-long-enough', 'x'.repeat(32));
  assert.equal(preview.renewal(preview.session(aged(preview, 1, 8)), false), null, 'without the people table nobody is renewed');
});
