// Held mail in the chat (public/heldmsg.js): Josh, 2026-11-20: "make the held mail messages we show to users a lot less
// intense, maybe we go back to how it used to look with a small less intrusive "deliver" button". A waiting message is a
// dashed bubble with a small row; #1067's inbox card is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldLine, composerHint } from '../public/heldmsg.js';

test('heldLine: waiting while the chat lists it as held, then a read tag; never held has none', () => {
  assert.equal(heldLine({ mail: true, parked: true }, 7, { held_ids: [7, 9] }).waiting, true);
  const taken = heldLine({ mail: true, parked: true }, 7, { held_ids: [9] });
  assert.deepEqual([taken.waiting, taken.tag], [false, 'left while parked']);
  assert.equal(heldLine({ mail: true, cold: true }, 3, { held_ids: [] }).tag, 'held mail');
  assert.equal(heldLine({ text: 'hi' }, 1, { held_ids: [1] }), null);
});

test('heldLine: held for a working minion is queued, shown in the log with a tag, not waiting (no Deliver row)', () => {
  const q = heldLine({ mail: true }, 7, { status: 'running', held_ids: [7] });
  assert.deepEqual([q.waiting, q.queued], [false, true]);
  const read = heldLine({ mail: true }, 7, { status: 'running', held_ids: [] });
  assert.deepEqual([read.waiting, read.queued], [false, false]);
});

test('composerHint: only a parked minion that a person can message', () => {
  assert.match(composerHint({ state: 'parked', status: 'idle' }), /parked: messages wait until it's unparked/);
  assert.equal(composerHint({ state: 'parked', status: 'running' }), null);
  assert.equal(composerHint({ state: 'parked', status: 'closed' }), null);
  assert.equal(composerHint({ state: null, status: 'idle' }), null);
  assert.ok(composerHint({ parked_for: 'x', status: 'idle' }));
  assert.equal(composerHint({ state: 'parked', kind: 'coordinator' }), null);
});
