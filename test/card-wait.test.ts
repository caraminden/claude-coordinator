import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callOf, cardWait, losesPass, newCalls, noteCalls, sameCall, type CardWait } from '../src/card-wait.ts';
import type { ClaudeEvent } from '../src/claude-events.ts';

// #1916: what a turn does while its approval cards wait. Josh, 2026-11-24: "shouldnt a minion waiting on a card just release to the pool".
const call = (id: string, name = 'Bash', parent: string | null = null, command = 'gh pr merge 1'): ClaudeEvent => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: name === 'Bash' ? { command } : {} }] },
});
const done = (id: string): ClaudeEvent => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const tasks = (...kinds: string[]): ClaudeEvent => ({ type: 'system', subtype: 'background_tasks_changed', tasks: kinds.map((task_type) => ({ task_type })) });
const card = (use?: string, tool = 'Bash') => ({ tool, use });

const rows: [string, ClaudeEvent[], { tool: string; use?: string }[], CardWait][] = [
  ['no card', [call('a')], [], 'working'],
  ['its one call waits', [call('x'), done('x'), call('a')], [card('a')], 'end'],
  ['its call not read from the stream yet', [], [card('a')], 'working'],
  ['a parallel call runs', [call('a'), call('b', 'Read')], [card('a')], 'working'],
  ['the parallel call is done', [call('a'), call('b', 'Read'), done('b')], [card('a')], 'end'],
  ['two cards at once', [call('a'), call('b')], [card('a'), card('b')], 'lend'],
  ["a Grunt's call waits and the Grunt has no other", [call('g', 'Agent'), call('a', 'Bash', 'g')], [card('a')], 'lend'],
  ['a Grunt beside the card still runs', [call('a'), call('g', 'Agent'), call('b', 'Read', 'g')], [card('a')], 'working'],
  ['a Grunt beside the card is between calls', [call('a'), call('g', 'Agent')], [card('a')], 'working'],
  ['a Grunt runs in the background', [call('g', 'Agent'), done('g'), tasks('local_agent'), call('a')], [card('a')], 'working'],
  ['a job runs in the background', [tasks('local_bash'), call('a')], [card('a')], 'lend'],
  ['the background job is over', [tasks('local_bash'), tasks(), call('a')], [card('a')], 'end'],
  ['a command left a job behind', [call('s', 'Bash', null, 'node server.js > log 2>&1 &'), done('s'), call('a')], [card('a')], 'lend'],
  ['&& and 2>&1 leave nothing behind', [call('s', 'Bash', null, 'cd x && make 2>&1 | tail'), done('s'), call('a')], [card('a')], 'end'],
  ['a card from before #1916 frees the worker, never the process', [call('a')], [card()], 'lend'],
  ['a card from before #1916 beside another tool', [call('a'), call('b', 'Read')], [card()], 'working'],
];
for (const [name, events, cards, want] of rows)
  test(`${name}: ${want}`, () => {
    const turn = newCalls();
    for (const ev of events) noteCalls(turn, ev);
    assert.equal(cardWait(turn, cards), want);
  });

const shown = (input: object, headRefOid = 'abc') => callOf({ id: 'c', tool: 'Bash', input, merge: { pr: { number: 1, oid: headRefOid } } }, '/w')!;
test('an approval stands for exactly one call: its input, where it runs, and the pull request as the card showed it', () => {
  const at = shown({ command: 'gh pr merge 1' });
  assert.ok(sameCall(at, shown({ command: 'gh pr merge 1' })));
  assert.ok(!sameCall(at, shown({ command: 'gh pr merge 1 ' })), 'another input');
  assert.ok(!sameCall(at, shown({ command: 'gh pr merge 1' }, 'def')), 'pushed to since');
  assert.ok(!sameCall(at, { ...at, cwd: '/x' }) && !sameCall(at, { ...at, tool: 'Write' }) && !sameCall(at, { ...at, tripwire: 'it deletes data' }));
  assert.equal(callOf({ id: 'c', tool: 'Write', input: { truncated: '…' } }, '/w'), null, 'a card that shows only part of it');
});

test('the pass goes with the first thing the turn does besides its call', () => {
  const pass = { id: 'c', by: 'Josh', call: shown({ command: 'gh pr merge 1' }) };
  const turn = newCalls();
  noteCalls(turn, call('a'));
  assert.ok(!losesPass(pass, turn, call('s', 'ToolSearch')), 'loading the schema is not a step of its own');
  assert.ok(!losesPass(pass, turn, call('a')));
  assert.ok(losesPass(pass, turn, call('r', 'Read')));
  assert.ok(losesPass(pass, turn, done('a')), 'a call of that tool ran without a card');
});
