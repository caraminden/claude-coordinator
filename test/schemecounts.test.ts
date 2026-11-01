import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEvent, countMoved, otherSchemes, rowTarget } from '../public/schemecounts.js';

const minion = (over = {}) => ({ id: 7, project_id: 2, state: null, replies: [], status: 'idle', activity: null, ...over });

test('another scheme\'s minion: news that can move its Needs-you count refetches the counts, the rest doesn\'t (#188)', () => {
  let fetches = 0;
  const watch = otherSchemes(() => fetches++);
  watch.ticket(minion({ status: 'running' }));
  assert.equal(fetches, 1, 'a minion new to this page may already count');
  watch.ticket(minion({ status: 'running', activity: 'Reading files' }));
  assert.equal(fetches, 1, 'activity alone moves nothing');
  watch.ticket(minion({ status: 'idle', state: 'ready' }));
  assert.equal(fetches, 2, 'ready counts');
  watch.ticket(minion({ status: 'idle', state: 'ready', replies: ['Merge it'] }));
  assert.equal(fetches, 3, 'offering replies counts');
  watch.ticket(minion({ status: 'closed', state: 'ready', replies: ['Merge it'] }));
  assert.equal(fetches, 4, 'dismissing it stops it counting');

  watch.event({ ticket_id: 7, kind: 'question', data: '{}' });
  assert.equal(fetches, 5, 'a card raised');
  watch.event({ ticket_id: 7, kind: 'user_message', data: '{"answer":{"id":1}}' });
  assert.equal(fetches, 6, 'a card answered by typing');
  watch.event({ ticket_id: 7, kind: 'user_message', data: '{"text":"hi"}' });
  watch.event({ ticket_id: 7, kind: 'assistant_text', data: '{}' });
  assert.equal(fetches, 6, 'chat that settles no card moves nothing');
});

test('cardEvent and countMoved, as the open scheme\'s badge uses them too', () => {
  for (const kind of ['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']) assert.equal(cardEvent({ kind, data: '{}' }), true, kind);
  assert.equal(cardEvent({ kind: 'tool_use', data: '{}' }), false);
  assert.equal(countMoved(undefined, minion()), true);
  assert.equal(countMoved(minion(), minion({ activity: 'x' })), false);
  assert.equal(countMoved(minion({ state: 'try' }), minion({ state: 'ready' })), true);
  assert.equal(countMoved(minion({ properties: { assigned: 'Cara' } }), minion({ properties: { assigned: 'Josh' } })), true, 'it changed hands (#197)');
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
