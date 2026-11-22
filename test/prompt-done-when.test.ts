import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemPrompt, turnContext } from '../src/prompts.ts';
import { DONE_LINES } from '../src/done-lines.ts';

const project = { id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any;
const ticket = { id: 929, number: 415, title: 'x', kind: 'ticket', branch: 'ticket/415-x' } as any;
const build = (kind: string) => systemPrompt(project, { ...ticket, kind }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, '');

test('the Taskmaster prompt tells it to end every brief with a "Done when" (#925)', () => {
  const p = build('coordinator');
  assert.equal(p.split('"Done when"').length - 1, 1);
  const line = p.split('\n').find((l) => l.includes('"Done when"'))!;
  assert.match(line, /self-contained first message/);
});

test('a minion prompt does not carry the Done when line', () => {
  assert.ok(!build('ticket').includes('"Done when"'));
});

test('a minion prompt carries the finishing-work lines in its cached system part (AG-01, #975)', () => {
  const p = build('ticket');
  assert.match(p, /Finish the work before you end the turn/);
  assert.match(p, /a summary that announces the next step/);
  assert.match(p, /risky or destructive actions, and ships at the Shipping line's go threshold, wait for a person's go/);
});

test('the Taskmaster prompt says a brief covers what happens to things saved before a change (#1172)', () => {
  const line = build('coordinator').split('\n').find((l) => l.includes('"Done when"'))!;
  assert.match(line, /how saved things are stored, read or applied/);
  assert.match(line, /what happens to the ones saved before the change: migrated, left as they are on purpose, or flagged to their owner/);
  assert.ok(!build('ticket').includes('saved before the change'));
});

test('the done-lines rule (#1115) left every prompt for set_properties\' feature reply and a feature\'s first turn (#1574)', () => {
  assert.ok(!build('ticket').includes('Done lines (#1115)'));
  assert.ok(!build('coordinator').includes('Done lines (#1115)'));
  assert.match(DONE_LINES, /^Done lines \(#1115\): on a feature, before any code/);
  assert.match(DONE_LINES, /Bugs, chores and research write none\.$/);
});

test('a feature minion\'s first turn note opens with the done-lines rule; a later turn, a bug or no type does not (#1574)', () => {
  const turn = (t: object) => turnContext(project, { ...ticket, ...t }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, '');
  assert.ok(turn({ type: 'feature' }).includes(DONE_LINES));
  for (const t of [{ type: 'feature', session_id: 's1' }, { type: 'bug' }, {}]) assert.ok(!turn(t).includes('Done lines'), JSON.stringify(t));
});
