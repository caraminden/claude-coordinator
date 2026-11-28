import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerableCard, answerText } from '../src/card-answer.ts';
import { HttpError } from '../src/http.ts';

// The card-answer route's checks and wording, called with no server (#2324).
type Row = { id: number; data: string };
const store = (cards: object[], answered: string[] = []) => ({
  eventsOfKinds: (_t: number, kinds: string[]): Row[] => (kinds[0] === 'question' ? cards.map((c, i) => ({ id: i + 1, data: JSON.stringify(c) })) : answered.map((q, i) => ({ id: 100 + i, data: JSON.stringify({ answer: { questionId: q } }) }))),
});
const refused = (cards: object[], status: number, text: RegExp, answered: string[] = []) =>
  assert.throws(
    () => answerableCard(store(cards, answered), 1, 'q1'),
    (e: unknown) => e instanceof HttpError && e.status === status && text.test(e.message),
  );

test('which cards can be answered', () => {
  assert.equal(answerableCard(store([{ id: 'q1', questions: [] }]), 1, 'q1').card.id, 1);
  refused([{ id: 'other' }], 404, /No such question/);
  refused([{ id: 'q1' }], 409, /already been answered/, ['q1']);
  refused([{ id: 'q1', settled: { by: 'Cara', dismissed: true } }], 409, /Cara dismissed/);
  refused([{ id: 'q1', settled: { by: 'Cara' } }], 409, /Cara already marked this seen/);
  refused([{ id: 'q1', settled: {} }], 409, /took this as answered in the chat/);
  refused([{ id: 'q1', doc: 'a.html' }], 409, /answered on its page/);
  refused([{ id: 'q1', secret: true }], 409, /takes a secret/);
});

test('the answer as the minion reads it', () => {
  assert.equal(answerText([{ question: 'Ship?' }], [{ selected: ['Yes'] }]), 'Ship?\n→ Yes');
  assert.equal(answerText([{ question: 'Ship?' }], [{ selected: ['Yes', 'Now'], other: 'soon' }]), 'Ship?\n→ Yes; Now\n  Added: soon');
  assert.equal(answerText([{ question: 'Ship?' }], [{ selected: [], other: 'later' }]), 'Ship?\n→ In their own words: later');
  assert.equal(answerText([{ question: 'Ship?' }], [{ selected: [] }]), 'Ship?\n→ (no option picked; see the attachment)');
  assert.equal(answerText([{ question: 'A?' }, { question: 'B?' }], [{ selected: ['x'] }, { selected: ['y'] }]), '1. A?\n→ x\n\n2. B?\n→ y');
});
