// What a held message's bubble says (public/heldmsg.js): not sent yet while the minion keeps it, normal once taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldLine, composerHint } from '../public/heldmsg.js';

test('heldLine: a parked message waits until the minion lists it as held, then reads as delivered', () => {
  const data = { mail: true, parked: true };
  const waiting = heldLine(data, 7, { held_ids: [7, 9] });
  assert.equal(waiting.waiting, true);
  assert.match(waiting.text, /Not sent yet: this minion is parked/);
  assert.equal(waiting.unpark, true);
  const taken = heldLine(data, 7, { held_ids: [9] });
  assert.equal(taken.waiting, false);
  assert.equal(taken.unpark, false);
  assert.match(taken.text, /Read by the minion/);
});

test('heldLine: cold and plain held mail get their own wording and no unpark button', () => {
  const cold = heldLine({ mail: true, cold: true }, 3, { held_ids: [3] });
  assert.match(cold.text, /idle over 55 minutes/);
  assert.equal(cold.unpark, false);
  const mail = heldLine({ mail: true }, 3, { held_ids: [3] });
  assert.match(mail.text, /next turn/);
  assert.notEqual(mail.text, cold.text);
});

test('heldLine: a message that was never held has no line', () => {
  assert.equal(heldLine({ text: 'hi' }, 1, { held_ids: [1] }), null);
});

test('composerHint: only a parked minion that a person can message', () => {
  assert.match(composerHint({ state: 'parked', status: 'idle' }), /parked: messages wait until it's unparked/);
  assert.equal(composerHint({ state: 'parked', status: 'running' }), null);
  assert.equal(composerHint({ state: 'parked', status: 'closed' }), null);
  assert.equal(composerHint({ state: null, status: 'idle' }), null);
  assert.ok(composerHint({ parked_for: 'x', status: 'idle' }));
  assert.equal(composerHint({ state: 'parked', kind: 'coordinator' }), null);
});
