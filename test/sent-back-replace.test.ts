// A reply the link check sent back gives way to its rewrite once the turn ends (#281, Cara's pick
// "Replace in place"), in the stored history so a reload shows one version too.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { SENT_BACK } from '../src/link-check.ts';
import { Runner } from '../src/runner.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'sent-back-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const broadcasts: any[] = [];
const runner = new Runner(store, (m) => broadcasts.push(m), () => ({}), '/bin/false');

const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = (name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input: {} }] } });
const feedback = (text = `Stop hook feedback:\n${SENT_BACK}\n- /x/a.png: no such file`) => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done' };

/** Run one turn's stream lines through the runner, then each reply's text and whether it was replaced. */
function turn(lines: object[]) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  for (const l of lines) (runner as any).handleLine(t.id, JSON.stringify(l), () => {});
  return store.listEvents(t.id).filter((e) => e.kind === 'claude').map((e) => JSON.parse(e.data))
    .filter((d) => d.type === 'assistant' && d.message.content[0].type === 'text')
    .map((d) => [d.message.content[0].text, !!d.replaced]);
}

test('the sent-back reply is marked replaced by the rewrite, even with narration and tools between them', () => {
  assert.deepEqual(turn([say('Working.'), tool('Bash'), say('Done: ![x](a.png)'), feedback(), say('Fixing the path:'), tool('Bash'), say('Done: ![x](/r/a.png)'), result]), [
    ['Working.', false], ['Done: ![x](a.png)', true], ['Fixing the path:', false], ['Done: ![x](/r/a.png)', false],
  ]);
  const swap = broadcasts.map((b) => b.event).filter((e) => e?.kind === 'replaced').at(-1);
  assert.ok(swap, 'open chats are told to drop it');
});

test("a Grunt's words before the send-back are not taken for the reply", () => {
  const grunt = { ...say('Grunt: all good'), parent_tool_use_id: 't9' };
  assert.deepEqual(turn([say('Done: ![x](a.png)'), grunt, feedback(), say('Done: ![x](/r/a.png)'), result]).map(([, r]) => r), [true, false, false]);
});

test('with no words after the send-back, or another hook\'s feedback, the first version stays', () => {
  assert.deepEqual(turn([say('Done: ![x](a.png)'), feedback(), tool('Bash'), result]), [['Done: ![x](a.png)', false]]);
  assert.deepEqual(turn([say('Done.'), feedback('Stop hook feedback:\nYour task list has open tasks'), say('Done, tasks ticked.'), result]), [
    ['Done.', false], ['Done, tasks ticked.', false],
  ]);
});

test('a bare KEEP after the send-back keeps the first version and drops the KEEP (#404)', () => {
  assert.deepEqual(turn([say('#390 told Delve.'), feedback(), say('KEEP'), result]), [['#390 told Delve.', false], ['KEEP', true]]);
  const swap = broadcasts.map((b) => b.event).filter((e) => e?.kind === 'replaced').at(-1);
  const { event, by } = typeof swap.data === 'string' ? JSON.parse(swap.data) : swap.data;
  assert.ok(by < event, 'open chats drop the KEEP, not the reply');
  assert.deepEqual(turn([say('#390 told Delve.'), feedback(), say('**Keep.**'), result]).map(([, r]) => r), [false, true]);
  // Any other words are a rewrite, as before.
  assert.deepEqual(turn([say('#390 told Delve.'), feedback(), say('Keep it short: #390 told Delve.'), result]).map(([, r]) => r), [true, false]);
});

test('only this turn counts: an earlier turn\'s send-back is left as it was', () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  for (const l of [say('A ![x](a.png)'), feedback(), result, say('Next turn.'), result]) (runner as any).handleLine(t.id, JSON.stringify(l), () => {});
  const replaced = store.listEvents(t.id).filter((e) => e.kind === 'claude' && JSON.parse(e.data).replaced);
  assert.equal(replaced.length, 0);
});
