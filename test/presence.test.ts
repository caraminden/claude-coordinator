// Presence (#695, src/presence.ts): who has a minion open or wrote in it lately, in memory, per scheme.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayReceive, messageScope } from '../src/access.ts';
import { Store } from '../src/db.ts';
import { Presence, VIEW_TTL_MS, WROTE_MS } from '../src/presence.ts';

function world() {
  let now = 1_000_000;
  const sent: any[] = [];
  const projectOf = (id: number) => ({ 1: 10, 2: 10, 3: 20 } as Record<number, number>)[id];
  const p = new Presence({ projectOf, broadcast: (m) => sent.push(m), now: () => now });
  return { p, sent, tick: (ms: number) => (now += ms) };
}

test('a viewer shows on the chat they opened and drops off when their tab closes', () => {
  const { p, sent } = world();
  p.open('s1', 'Josh');
  assert.equal(sent.length, 0); // an open stream with no chat says nothing
  assert.ok(p.view('s1', 'Josh', 1));
  assert.deepEqual(sent.at(-1), { type: 'presence', projectId: 10, tickets: { 1: ['Josh'] } });
  p.view('s1', 'Josh', 1); // a heartbeat on the same chat sends nothing new
  assert.equal(sent.length, 1);
  p.close('s1');
  assert.deepEqual(sent.at(-1), { type: 'presence', projectId: 10, tickets: {} });
  assert.deepEqual(p.snapshot(), []);
});

test('moving to another scheme clears the old one; another person can not use your stream', () => {
  const { p, sent } = world();
  p.open('s1', 'Josh');
  p.view('s1', 'Josh', 1);
  p.view('s1', 'Josh', 3);
  assert.deepEqual(sent.slice(-2), [{ type: 'presence', projectId: 10, tickets: {} }, { type: 'presence', projectId: 20, tickets: { 3: ['Josh'] } }]);
  assert.equal(p.view('s1', 'Olive', 1), false);
  assert.equal(p.view('nope', 'Josh', 1), false);
});

test('a missed heartbeat drops the viewer; a write counts for ten minutes', () => {
  const { p, sent, tick } = world();
  p.open('s1', 'Josh');
  p.view('s1', 'Josh', 1);
  p.wroteIn(2, 'Cara');
  assert.deepEqual(p.forScheme(10), { 1: ['Josh'], 2: ['Cara'] });
  tick(VIEW_TTL_MS + 1);
  p.sweep();
  assert.deepEqual(sent.at(-1).tickets, { 2: ['Cara'] });
  tick(WROTE_MS);
  p.sweep();
  assert.deepEqual(sent.at(-1).tickets, {});
  // A heartbeat after the drop brings the viewer back.
  p.view('s1', 'Josh', 1);
  assert.deepEqual(sent.at(-1).tickets, { 1: ['Josh'] });
});

test("presence goes only to people who can see the minion's scheme", () => {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const games = store.createProject('Games', null, josh.id);
  store.createProject('Other', null, cara.id);
  const scope = messageScope(store, { type: 'presence', projectId: games.id, tickets: {} });
  assert.equal(scope, games.id);
  assert.ok(mayReceive(store, { name: 'Josh', uid: josh.id, exp: 0 }, scope));
  assert.ok(!mayReceive(store, { name: 'Olive', uid: olive.id, exp: 0 }, scope));
});
