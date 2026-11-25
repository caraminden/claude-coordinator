// closedlist.js mergeOpen: a reconnect's scheme answer against what the stream brought while it was on its way (#1854).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setView, view } from '../public/base.js';
import { closedState, mergeOpen } from '../public/closedlist.js';

const row = (id, updated_at, more) => ({ id, updated_at, created_at: 0, status: 'idle', ...more });

/** The list after the answer `open`/`dismissed` lands on `rows`, with `live` updates in between; ids it ends with, and its count. */
function merged(rows, live, open, dismissed) {
  setView({ kind: 'project', tickets: new Map(rows.map((t) => [t.id, t])) });
  const before = new Map(view.tickets);
  for (const t of live) view.tickets.set(t.id, t);
  const next = mergeOpen(open, dismissed, before);
  return { get: (id) => next.get(id), ids: [...next.keys()].sort(), ...closedState(next) };
}

test('a newer answer wins; an older one never overwrites a newer row', () => {
  assert.equal(merged([row(1, 10)], [], [row(1, 20, { title: 'answer' })], 0).get(1).title, 'answer');
  assert.equal(merged([row(1, 10)], [row(1, 20, { title: 'live' })], [row(1, 15, { title: 'answer' })], 0).get(1).title, 'live');
});

test('on a tie, a row that came live while the answer was on its way stays; one from before takes the answer', () => {
  assert.equal(merged([row(1, 10)], [row(1, 20, { title: 'live' })], [row(1, 20, { title: 'answer' })], 0).get(1).title, 'live');
  // Some changes leave updated_at alone (updateTicketQuietly), so a row that missed one is equal in time and behind.
  assert.equal(merged([row(1, 10, { title: 'old' })], [], [row(1, 10, { title: 'answer' })], 0).get(1).title, 'answer');
});

test('a dismissal or a reopen that came live stands, and the dismissed count with it', () => {
  const shut = merged([row(1, 10), row(2, 10)], [row(1, 20, { status: 'closed' })], [row(1, 10), row(2, 10)], 4);
  assert.equal(shut.get(1).status, 'closed');
  assert.equal(shut.total, 5);
  const back = merged([row(1, 10, { status: 'closed' })], [row(1, 20)], [], 4);
  assert.equal(back.get(1).status, 'idle');
  assert.equal(back.total, 3);
});

test('a minion started while the answer was on its way stays; one dismissed while offline goes and its page is read again', () => {
  const r = merged([row(1, 10), row(2, 10, { status: 'closed' })], [row(3, 20, { created_at: Date.now() })], [], 4);
  assert.deepEqual(r.ids, [2, 3]);
  assert.deepEqual([r.total, r.cursor, r.more], [4, null, true]);
});
