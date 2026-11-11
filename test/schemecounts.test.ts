import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEvent, countMoved, isWorking, otherSchemes, rowTarget, schemePill, turnMoved } from '../public/schemecounts.js';

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
  assert.equal(rowTarget([{ kind: 'question', at: 20, eventId: 4 }, { kind: 'state', at: 10 }]), 'latest', 'ready or try: the latest reply');
  assert.equal(rowTarget([{ kind: 'replies', at: 10 }]), 'latest');
  assert.equal(rowTarget([{ kind: 'approval', at: 10 }]), null, 'a card whose event is gone opens the chat as usual');
});

test('schemePill: the spinner shows beside the Needs-you count, not only at zero (#314), with the working number only over 1 (#278)', () => {
  assert.deepEqual(schemePill({ inbox: 0, running: false, working: 0 }), { need: 0, busy: false, working: 0, changed: false, label: '' }, 'nothing: hidden');
  assert.deepEqual(schemePill({ inbox: 2, running: false, working: 0 }), { need: 2, busy: false, working: 0, changed: false, label: '2 waiting on you' }, 'badge only');
  assert.deepEqual(schemePill({ inbox: 0, running: true, working: 1 }), { need: 0, busy: true, working: 0, changed: false, label: '1 minion working' }, 'spinner only, one minion: no number');
  assert.deepEqual(schemePill({ inbox: 0, running: true, working: 0 }), { need: 0, busy: true, working: 0, changed: false, label: 'Taskmaster working' }, 'only the Taskmaster mid-turn');
  assert.deepEqual(schemePill({ inbox: 2, running: true, working: 1 }), { need: 2, busy: true, working: 0, changed: false, label: '2 waiting on you · 1 minion working' }, 'both');
  assert.deepEqual(schemePill({ inbox: 2, running: true, working: 3 }), { need: 2, busy: true, working: 3, changed: false, label: '2 waiting on you · 3 minions working' }, 'both, with the working number');
  assert.equal(schemePill({ inbox: 1, running: false, working: 3 }).working, 0, 'no turn running: no working number, whatever the field says');
});

test('schemePill: a count that moved since you last had the scheme open is marked, up or down, even to zero (#498)', () => {
  assert.equal(schemePill({ inbox: 3, seenInbox: 3 }).changed, false, 'the count you left');
  assert.equal(schemePill({ inbox: 3 }).changed, false, 'nothing seen recorded: not marked');
  assert.deepEqual(schemePill({ inbox: 3, seenInbox: 1 }), { need: 3, busy: false, working: 0, changed: true, label: '3 waiting on you (1 when you last opened it)' }, 'up');
  assert.equal(schemePill({ inbox: 1, seenInbox: 3 }).changed, true, 'down');
  assert.deepEqual(schemePill({ inbox: 0, seenInbox: 3 }), { need: 0, busy: false, working: 0, changed: true, label: 'None waiting on you (3 when you last opened it)' }, 'down to none still shows');
  assert.equal(schemePill({ inbox: 2, seenInbox: 0, running: true, working: 1 }).label, '2 waiting on you (0 when you last opened it) · 1 minion working');
});
