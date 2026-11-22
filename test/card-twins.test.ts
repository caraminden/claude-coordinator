import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { cardTwin } from '../src/card-twins.ts';

const root = mkdtempSync(join(tmpdir(), 'card-twins-'));
after(() => rmSync(root, { recursive: true, force: true }));

const Q = (question: string, ...labels: string[]) => ({ question, options: labels.map((label) => ({ label })) });
function setup() {
  const store = new Store(join(root, `${Math.random()}.sqlite`));
  store.typedHandlesUpTo = 0;
  const p = store.createProject('One', null).id;
  const mk = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
  return { store, a: mk('a'), b: mk('b') };
}
const ask = { questions: [Q('Which fixes should the Taskmaster start first?', 'The stuck list', 'Waiting on you')] };

test('the same question while the first card is open, from another minion, is refused with its link', () => {
  const { store, a, b } = setup();
  const ev = store.addEvent(a.id, 'question', { id: 'q1', questions: ask.questions });
  const out = cardTwin(store, b, ask);
  assert.match(out ?? '', /still open/);
  assert.match(out ?? '', new RegExp(`e=${ev.id}`));
});

test('the same question a minute after its answer is refused, and shows the answer and who gave it', () => {
  const { store, a, b } = setup();
  store.addEvent(a.id, 'question', { id: 'q1', to: 'Cara', questions: ask.questions });
  store.addEvent(a.id, 'user_message', { author: 'Cara', text: 'The stuck list', answer: { questionId: 'q1', answers: [] } });
  const out = cardTwin(store, b, { ...ask, to: 'Cara' });
  assert.match(out ?? '', /Cara already answered/);
  assert.match(out ?? '', /The stuck list/);
});

test('an answer older than a day, a different question, another person\'s card, and no questions are not twins', () => {
  const { store, a, b } = setup();
  store.addEvent(a.id, 'question', { id: 'q1', to: 'Cara', questions: ask.questions });
  store.addEvent(a.id, 'user_message', { author: 'Cara', text: 'x', answer: { questionId: 'q1', answers: [] } });
  assert.equal(cardTwin(store, b, { ...ask, to: 'Cara' }, Date.now() + 25 * 3600_000), null, 'answered over 24 hours ago');
  assert.equal(cardTwin(store, b, { questions: [Q('Should the deploy wait for the weekend?', 'Wait', 'Go')], to: 'Cara' }), null);
  const other = setup();
  other.store.addEvent(other.a.id, 'question', { id: 'q2', to: 'Josh', questions: ask.questions });
  assert.equal(cardTwin(other.store, other.b, { ...ask, to: 'Cara' }), null, 'Josh\'s open card is not one Cara can answer');
  assert.equal(cardTwin(store, b, { questions: [] }), null, 'a choices-page or secret card has no questions');
});

test('questions that differ only by a number or a letter are not twins, and an everyone card is not a twin of one for Cara', () => {
  const { store, a, b } = setup();
  store.addEvent(a.id, 'question', { id: 'q1', to: 'Cara', questions: [Q('Merge #12 now?', 'Yes', 'No')] });
  assert.equal(cardTwin(store, b, { questions: [Q('Merge #13 now?', 'Yes', 'No')], to: 'Cara' }), null);
  assert.equal(cardTwin(store, b, { questions: [Q('Merge #12 now?', 'Yes', 'No')] }), null, 'no to: everyone, not the same people');
  assert.match(cardTwin(store, b, { questions: [Q('Merge #12 now?', 'Yes', 'No')], to: 'Cara' }) ?? '', /still open/);
});
