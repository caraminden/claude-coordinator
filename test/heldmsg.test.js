// Held mail in the chat (public/heldmsg.js, #1067): a waiting bubble gives way to the held-mail card, which groups the mail
// by sender, offers the kinds the scheme still holds, and says what its footer can do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldLine, heldModel, composerHint } from '../public/heldmsg.js';

test('heldLine: waiting while the chat lists it as held, then a read tag; never held has none', () => {
  assert.equal(heldLine({ mail: true, parked: true }, 7, { held_ids: [7, 9] }).waiting, true);
  const taken = heldLine({ mail: true, parked: true }, 7, { held_ids: [9] });
  assert.deepEqual([taken.waiting, taken.tag], [false, 'left while parked']);
  assert.equal(heldLine({ mail: true, cold: true }, 3, { held_ids: [] }).tag, 'held mail');
  assert.equal(heldLine({ text: 'hi' }, 1, { held_ids: [1] }), null);
});

test('heldLine: held for a working minion is queued, shown in the log, not waiting on the card', () => {
  const q = heldLine({ mail: true }, 7, { status: 'running', held_ids: [7] });
  assert.deepEqual([q.waiting, q.queued], [false, true]);
  const read = heldLine({ mail: true }, 7, { status: 'running', held_ids: [] });
  assert.deepEqual([read.waiting, read.queued], [false, false]);
});

const item = (author, text, extra = {}) => ({ id: 1, author, from: null, need: null, note: false, parked: false, at: 1, text, ...extra });

test('heldModel: nothing held, no card; mail grouped by sender, newest as the preview with the tracking words gone', () => {
  assert.equal(heldModel({ held_mail: null, loop_hold: null }), null);
  const m = heldModel({ kind: 'coordinator', status: 'idle', held_mail: { until: 5, items: [
    item('#12 Fix', 'one', { need: 'fyi' }), item('Citadel', 'red run', { note: true }), item('#12 Fix', '(for your tracking; nothing to do) shipped\nmore', { need: 'fyi' }),
  ] }, loop_hold: null }, 'note', (ms) => `T${ms}`);
  assert.equal(m.count, 3);
  assert.equal(m.title, "Waiting for the Taskmaster's next turn");
  assert.equal(m.sub, 'Read then, or by T5');
  assert.deepEqual(m.sections.map((s) => [s.author, s.items.length, s.preview, s.kinds]), [['#12 Fix', 2, 'shipped', ['fyi']], ['Citadel', 1, 'red run', []]], 'notes are already never held, so not offered');
  assert.deepEqual(m.footer, { text: 'All 3 go in one turn', action: 'deliver' });
});

test('heldModel: a loop hold alone is a Needs-you card; parked offers Unpark and no kinds; dismissed offers nothing; working shows no mail', () => {
  const loop = heldModel({ kind: 'ticket', number: 4, status: 'idle', held_mail: null, loop_hold: { n: 2, at: 1, text: 'x' } });
  assert.deepEqual([loop.count, loop.sub, loop.footer, loop.sections.length], [1, 'Held by the loop guard', null, 0]);
  const mail = { until: null, items: [item('Taskmaster', 'hi', { need: 'ask', parked: true })] };
  const parked = heldModel({ kind: 'ticket', number: 4, status: 'idle', state: 'parked', held_mail: mail });
  assert.deepEqual([parked.sub, parked.footer.action, parked.sections[0].kinds], ["It's parked: read when it's unparked", 'unpark', []]);
  assert.equal(heldModel({ kind: 'ticket', number: 4, status: 'running', held_mail: mail }), null, 'queued into a working turn: the light view, no card');
  const both = heldModel({ kind: 'ticket', number: 4, status: 'running', held_mail: mail, loop_hold: { n: 1, at: 1, text: 'x' } });
  assert.deepEqual([both.count, both.sections.length, both.footer], [1, 0, null], 'a loop hold still needs a person while it works');
  assert.equal(heldModel({ kind: 'ticket', number: 4, status: 'closed', held_mail: mail }).footer.action, null);
});

test('composerHint: only a parked minion that a person can message', () => {
  assert.match(composerHint({ state: 'parked', status: 'idle' }), /parked: messages wait until it's unparked/);
  assert.equal(composerHint({ state: 'parked', status: 'running' }), null);
  assert.equal(composerHint({ state: 'parked', status: 'closed' }), null);
  assert.equal(composerHint({ state: null, status: 'idle' }), null);
  assert.ok(composerHint({ parked_for: 'x', status: 'idle' }));
  assert.equal(composerHint({ state: 'parked', kind: 'coordinator' }), null);
});
