// The Needs-you inbox's stream hooks (public/inbox.js): which news refetches the open scheme's items, which
// refetches every scheme's counts, and which fetches nothing. Watched at the network: the fetches made,
// after the hooks' debounce. The fetches fail, so nothing reaches the strip's drawing (checked in a browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setView } from '../public/base.js';
import { forgetOtherSchemes, inboxEvent, inboxOtherTicket, inboxTicket } from '../public/inbox.js';

const ITEMS = 'api/projects/2/inbox';
const COUNTS = 'api/projects';

const minion = { id: 900, number: 12, project_id: 2, kind: 'ticket', status: 'idle', state: null, replies: [] };
const taskmaster = { id: 1, kind: 'coordinator', project_id: 2, status: 'idle' };

/** Scheme 2 open with one minion, fetches recorded (and refused), timers on a fake clock. */
function scheme(t, over = {}) {
  const fetched = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    fetched.push(path);
    return { ok: false, status: 500, json: async () => ({}) };
  };
  setView({ kind: 'project', projectId: 2, coordinator: taskmaster, tickets: new Map([[minion.id, minion]]), ...over });
  t.after(() => { globalThis.fetch = realFetch; setView(null); forgetOtherSchemes(); });
  return fetched;
}

const card = (ticketId, kind = 'question') => ({ ticket_id: ticketId, kind, data: '{}' });

test('a card opened or settled in this scheme refetches its items once the burst is over', (t) => {
  const fetched = scheme(t);
  inboxEvent(card(900));
  inboxEvent(card(1, 'approval_result')); // the Taskmaster's, a moment later
  t.mock.timers.tick(299);
  assert.deepEqual(fetched, [], 'not before 300ms');
  t.mock.timers.tick(1);
  assert.deepEqual(fetched, [ITEMS], 'one fetch for the burst');
  t.mock.timers.tick(2000);
  assert.deepEqual(fetched, [ITEMS], 'and no other scheme\'s counts: the Taskmaster is this scheme\'s');
});

test('a typed answer settles a card; other chat news fetches nothing', (t) => {
  const fetched = scheme(t);
  inboxEvent({ ticket_id: 900, kind: 'user_message', data: JSON.stringify({ text: 'hi' }) });
  inboxEvent({ ticket_id: 900, kind: 'text', data: '{}' });
  t.mock.timers.tick(2000);
  assert.deepEqual(fetched, []);
  inboxEvent({ ticket_id: 900, kind: 'user_message', data: JSON.stringify({ text: 'Yes', answer: true }) });
  t.mock.timers.tick(300);
  assert.deepEqual(fetched, [ITEMS]);
});

test("a card in another scheme's minion refetches every scheme's counts, not this scheme's items, at most once a second", (t) => {
  const fetched = scheme(t);
  inboxEvent(card(5000));
  t.mock.timers.tick(500);
  inboxEvent(card(5001, 'plan'));
  t.mock.timers.tick(999);
  assert.deepEqual(fetched, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fetched, [COUNTS]);
});

test('off the scheme pages, chat news fetches nothing', (t) => {
  const fetched = scheme(t, { kind: 'settings' });
  inboxEvent(card(900));
  inboxEvent(card(5000));
  inboxOtherTicket({ ...minion, id: 5000, project_id: 1 });
  t.mock.timers.tick(2000);
  assert.deepEqual(fetched, []);
});

test("this scheme's minion refetches the items when its count can move; a turn starting or ending fetches nothing", (t) => {
  const fetched = scheme(t);
  inboxTicket(minion, { ...minion, status: 'running' });
  inboxTicket(minion, { ...minion, title: 'Renamed' });
  t.mock.timers.tick(2000);
  assert.deepEqual(fetched, [], 'only the spinner moves');
  inboxTicket(minion, { ...minion, state: 'ready' });
  t.mock.timers.tick(300);
  assert.deepEqual(fetched, [ITEMS], 'ready now waits on you');
  inboxTicket(null, minion);
  t.mock.timers.tick(300);
  assert.deepEqual(fetched, [ITEMS, ITEMS], 'a minion new to the page');
});

test("another scheme's minion refetches the counts when it is new or its count or turn moved, and not for a repeat", (t) => {
  const fetched = scheme(t);
  const other = { ...minion, id: 5000, project_id: 1 };
  inboxOtherTicket(other);
  t.mock.timers.tick(1000);
  assert.deepEqual(fetched, [COUNTS], 'first seen');
  inboxOtherTicket({ ...other, title: 'Renamed' });
  t.mock.timers.tick(1000);
  assert.deepEqual(fetched, [COUNTS], 'nothing a count shows');
  inboxOtherTicket({ ...other, title: 'Renamed', status: 'running' });
  t.mock.timers.tick(1000);
  assert.deepEqual(fetched, [COUNTS, COUNTS], 'its turn started: the spinner');
  inboxOtherTicket({ ...other, title: 'Renamed', status: 'running', state: 'try' });
  t.mock.timers.tick(1000);
  assert.deepEqual(fetched, [COUNTS, COUNTS, COUNTS], 'waits on you now');
});
