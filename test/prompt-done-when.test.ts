import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemPrompt } from '../src/prompts.ts';

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

test('a minion prompt carries the done-lines rule; the Taskmaster prompt does not (#1115)', () => {
  assert.match(build('ticket'), /Done lines \(#1115\): on a feature, before any code/);
  assert.match(build('ticket'), /Bugs, chores and research write none/);
  assert.ok(!build('coordinator').includes('Done lines (#1115)'));
});
