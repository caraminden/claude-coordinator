import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEvent, countMoved, isShipping, isWorking, otherSchemes, rowTarget, schemePill, seenInScheme, syncBadge, turnMoved, wantsBadge } from '../public/schemecounts.js';

const minion = (over = {}) => ({ id: 7, project_id: 2, state: null, replies: [], status: 'idle', activity: null, ...over });

test('another scheme\'s minion: news that can move its Needs-you count refetches the counts, the rest doesn\'t (#188)', () => {
  let fetches = 0;
  const watch = otherSchemes(() => fetches++);
  watch.ticket(minion({ status: 'running' }));
  assert.equal(fetches, 1, 'a minion new to this page may already count');
  watch.ticket(minion({ status: 'running', activity: 'Reading files' }));
  assert.equal(fetches, 1, 'activity alone moves nothing');
  watch.ticket(minion({ status: 'idle', activity: 'Reading files' }));
  assert.equal(fetches, 2, 'its turn ended: the spinner may stop (#248)');
  watch.ticket(minion({ status: 'running', activity: 'Reading files' }));
  assert.equal(fetches, 3, 'a turn started');
  watch.ticket(minion({ status: 'idle', state: 'ready' }));
  assert.equal(fetches, 4, 'ready counts');
  watch.ticket(minion({ status: 'idle', state: 'ready', replies: ['Merge it'] }));
  assert.equal(fetches, 5, 'offering replies counts');
  watch.ticket(minion({ status: 'closed', state: 'ready', replies: ['Merge it'] }));
  assert.equal(fetches, 6, 'dismissing it stops it counting');

  watch.event({ ticket_id: 7, kind: 'question', data: '{}' });
  assert.equal(fetches, 7, 'a card raised');
  watch.event({ ticket_id: 7, kind: 'user_message', data: '{"answer":{"id":1}}' });
  assert.equal(fetches, 8, 'a card answered by typing');
  watch.event({ ticket_id: 7, kind: 'user_message', data: '{"text":"hi"}' });
  watch.event({ ticket_id: 7, kind: 'assistant_text', data: '{}' });
  assert.equal(fetches, 8, 'chat that settles no card moves nothing');
});

test('cardEvent and countMoved, as the open scheme\'s badge uses them too', () => {
  for (const kind of ['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']) assert.equal(cardEvent({ kind, data: '{}' }), true, kind);
  assert.equal(cardEvent({ kind: 'tool_use', data: '{}' }), false);
  assert.equal(countMoved(undefined, minion()), true);
  assert.equal(countMoved(minion(), minion({ activity: 'x' })), false);
  assert.equal(countMoved(minion({ state: 'try' }), minion({ state: 'ready' })), true);
  assert.equal(countMoved(minion({ properties: { assigned: 'Cara' } }), minion({ properties: { assigned: 'Josh' } })), true, 'it changed hands (#197)');
  assert.equal(turnMoved(minion(), minion({ status: 'running' })), true, 'a turn started: the spinner (#248)');
  assert.equal(turnMoved(minion({ status: 'running' }), minion({ status: 'idle' })), true, 'a turn ended');
  assert.equal(turnMoved(minion({ status: 'idle' }), minion({ status: 'error' })), false, 'neither running');
});

test('isWorking: only a turn doing work spins the scheme\'s spinner and counts beside it, not one held on a person (#373)', () => {
  assert.equal(isWorking(minion({ status: 'running' })), true, 'mid-turn');
  assert.equal(isWorking(minion({ status: 'running', approvals: 0 })), true, 'no card waiting');
  assert.equal(isWorking(minion({ status: 'running', approvals: 1 })), false, 'its turn waits on an approval card (Delve #110, 14 hours)');
  assert.equal(isWorking(minion({ kind: 'coordinator', status: 'running', approvals: 1 })), false, 'a Taskmaster waiting on one too');
  for (const status of ['idle', 'new', 'error', 'closed']) assert.equal(isWorking(minion({ status })), false, status);
  for (const state of ['blocked', 'parked', 'outside', 'pending-deploy', 'ready', 'try']) {
    assert.equal(isWorking(minion({ state })), false, `${state} between turns`);
    assert.equal(isWorking(minion({ state, status: 'running' })), true, `${state} left from before, but a turn runs now`);
  }
  assert.equal(isWorking(undefined), false, 'no Taskmaster loaded yet');
  // The server landing it after its turn ended counts as working (#727), unless a card holds it or it was dismissed.
  // The server landing it after its turn ended is not working (#1294) but shipping: counted apart.
  assert.equal(isWorking(minion({ server_work: { kind: 'land' } })), false, 'its handed-off land is not a running turn');
  assert.equal(isShipping(minion({ server_work: { kind: 'land' } })), true, 'it waits on the server');
  assert.equal(isShipping(minion({ server_work: { kind: 'land' }, status: 'running' })), false, 'a turn runs: working, not waiting');
  assert.equal(isShipping(minion({ server_work: { kind: 'land' }, approvals: 1 })), false, 'a card waits on a person');
  assert.equal(isShipping(minion({ server_work: { kind: 'land' }, status: 'closed' })), false, 'dismissed');
  assert.equal(turnMoved(minion({}), minion({ server_work: { kind: 'land' } })), true, 'a ship entering the line moves the pill');
  assert.deepEqual(schemePill({ inbox: 2, running: true, working: 3, shipping: 6 }), { need: 2, busy: true, working: 3, shipping: 6, fresh: false, label: '2 need your answer · 3 minions working · 6 waiting to ship' }, 'running, waiting to ship, and needs-you apart');
  assert.equal(schemePill({ shipping: 1 }).label, '1 waiting to ship', 'waiting alone shows');
  assert.equal(turnMoved(minion({ status: 'running' }), minion({ status: 'running', approvals: 1 })), true, 'an approval card stops the spinner');
  assert.equal(turnMoved(minion({ status: 'running', approvals: 1 }), minion({ status: 'running' })), true, 'answering it starts it again');
});

test('forget: after the counts are fetched afresh, a minion the watcher last saw before then refetches on its next change', () => {
  let fetches = 0;
  const watch = otherSchemes(() => fetches++);
  watch.ticket(minion());
  watch.forget(); // it went ready while you were in its scheme, then you came back
  watch.ticket(minion());
  assert.equal(fetches, 2, 'its state before may not be what the fresh counts saw');
});

test('rowTarget: a Needs-you row goes to the oldest thing its minion waits on you for (#236)', () => {
  assert.equal(rowTarget([{ kind: 'approval', at: 30, eventId: 9 }, { kind: 'question', at: 10, eventId: 4 }, { kind: 'plan', at: 20, eventId: 6 }]), 4);
  assert.equal(rowTarget([{ kind: 'question', at: 20, eventId: 4 }, { kind: 'replies', at: 10 }]), 'latest', 'replies: the latest reply');
  assert.equal(rowTarget([{ kind: 'replies', at: 10 }]), 'latest');
  assert.equal(rowTarget([{ kind: 'approval', at: 10 }]), null, 'a card whose event is gone opens the chat as usual');
});

test('schemePill: the spinner shows beside the Needs-you count, not only at zero (#314), with the working number only over 1 (#278)', () => {
  assert.deepEqual(schemePill({ inbox: 0, running: false, working: 0 }), { need: 0, busy: false, working: 0, shipping: 0, fresh: false, label: '' }, 'nothing: hidden');
  assert.deepEqual(schemePill({ inbox: 2, running: false, working: 0 }), { need: 2, busy: false, working: 0, shipping: 0, fresh: false, label: '2 need your answer' }, 'badge only');
  assert.deepEqual(schemePill({ inbox: 0, running: true, working: 1 }), { need: 0, busy: true, working: 0, shipping: 0, fresh: false, label: '1 minion working' }, 'spinner only, one minion: no number');
  assert.deepEqual(schemePill({ inbox: 0, running: true, working: 0 }), { need: 0, busy: true, working: 0, shipping: 0, fresh: false, label: 'Taskmaster working' }, 'only the Taskmaster mid-turn');
  assert.deepEqual(schemePill({ inbox: 2, running: true, working: 1 }), { need: 2, busy: true, working: 0, shipping: 0, fresh: false, label: '2 need your answer · 1 minion working' }, 'both');
  assert.deepEqual(schemePill({ inbox: 2, running: true, working: 3 }), { need: 2, busy: true, working: 3, shipping: 0, fresh: false, label: '2 need your answer · 3 minions working' }, 'both, with the working number');
  assert.equal(schemePill({ inbox: 1, running: false, working: 3 }).working, 0, 'no turn running: no working number, whatever the field says');
});

test('schemePill: violet only when something new waits, not when the count moved, and nothing at zero (#498, #539)', () => {
  assert.equal(schemePill({ inbox: 3 }).fresh, false, 'nothing new');
  assert.deepEqual(schemePill({ inbox: 3, fresh: true }), { need: 3, busy: false, working: 0, shipping: 0, fresh: true, label: '3 need your answer (something new since you last opened it)' }, 'new');
  assert.deepEqual(schemePill({ inbox: 0, fresh: true }), { need: 0, busy: false, working: 0, shipping: 0, fresh: false, label: '' }, 'at zero: hidden, never a violet 0');
  assert.equal(schemePill({ inbox: 2, fresh: true, running: true, working: 1 }).label, '2 need your answer (something new since you last opened it) · 1 minion working');
});

test('the scheme you\'re in: a new ask is new unless the chat you\'re on asks it, until you open another chat (#548)', () => {
  const item = (key, ticketId) => ({ key, ticketId });
  const a = item('question:1', 7), b = item('replies:8', 8), c = item('plan:3', 9);
  let seen = seenInScheme(new Set(), [a], 7, true);
  assert.deepEqual([...seen], ['question:1'], 'opening a chat sees everything waiting');
  seen = seenInScheme(seen, [a, b], 7, false);
  assert.equal(seen.has('replies:8'), false, 'another minion asks while you stay put: new to you');
  seen = seenInScheme(seen, [a, b, item('approval:x', 7)], 7, false);
  assert.equal(seen.has('approval:x'), true, 'the minion you have open asks: not new');
  assert.equal(seen.has('replies:8'), false, 'and the other one is still new');
  seen = seenInScheme(seen, [b, c], 9, true);
  assert.deepEqual([...seen].sort(), ['plan:3', 'replies:8'], 'moving to any chat sees all of it, and what stopped waiting drops out');
  const gone = seenInScheme(seen, [b], 7, false);
  assert.equal(seenInScheme(gone, [b, c], 7, false).has('plan:3'), false, 'an item that stops waiting and waits again later is new again');
});

test('app badge: on while any visible scheme is purple, the open scheme by this page\'s own word (#980)', () => {
  const ps = [{ id: 1, inbox: 2, fresh: true }, { id: 2, inbox: 1, fresh: false }, { id: 3, inbox: 1, fresh: true, hidden: true }];
  assert.equal(wantsBadge(ps, 2, null), true);
  assert.equal(wantsBadge(ps, 1, { projectId: 1, fresh: false }), false, 'you have seen it here');
  assert.equal(wantsBadge([{ id: 1, inbox: 0, fresh: true }], null, null), false, 'nothing waiting');
  assert.equal(wantsBadge(undefined, null, null), false);
});

test('app badge: calls the API only on a change, and nothing without it (#980)', () => {
  const calls: string[] = [];
  const nav = { setAppBadge: () => (calls.push('set'), Promise.resolve()), clearAppBadge: () => (calls.push('clear'), Promise.resolve()) };
  const st = { on: null as boolean | null };
  syncBadge(true, st, nav); syncBadge(true, st, nav); syncBadge(false, st, nav); syncBadge(false, st, nav);
  assert.deepEqual(calls, ['set', 'clear']);
  assert.equal(syncBadge(true, { on: null }, {} as any), false);
});

test('a minimized scheme never lights the icon badge (#1243)', () => {
  const p = { id: 1, inbox: 1, fresh: true };
  assert.equal(wantsBadge([p], null, null), true);
  assert.equal(wantsBadge([{ ...p, minimized: true }], null, null), false);
});
