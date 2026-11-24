// What a chat's page sends of a long tool call (#1530, public/eventcut.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionCut, cutEvent, GRUNT_RESULT_HEAD, INPUT_HEAD, RESULT_HEAD, TEXT_HEAD } from '../public/eventcut.js';

const row = (data, kind = 'claude') => ({ id: 7, ticket_id: 3, kind, data: JSON.stringify(data), created_at: 1 });
const sent = (r) => JSON.parse(cutEvent(r).data);
const big = (n, c = 'x') => c.repeat(n);

test("a long tool result keeps its beginning and its full length; the minion's own keeps more than a Grunt's", () => {
  const own = sent(row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: `Created #15 ${big(20_000)}` }] } }));
  assert.equal(own.message.content[0].content, `Created #15 ${big(20_000)}`.slice(0, RESULT_HEAD));
  assert.equal(own.message.content[0].cut, 20_012);
  assert.equal(own.message.content[0].tool_use_id, 'a');
  const grunt = sent(row({ type: 'user', parent_tool_use_id: 'g', message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: big(5000) }] } }));
  assert.equal(grunt.message.content[0].content.length, GRUNT_RESULT_HEAD);
  assert.equal(grunt.message.content[0].is_error, true);
});

test('a result in parts is cut as its text, the parts joined', () => {
  const content = [{ type: 'text', text: big(3000, 'a') }, { type: 'image' }, { type: 'text', text: 'end' }];
  const b = sent(row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content }] } })).message.content[0];
  assert.equal(b.content, big(RESULT_HEAD, 'a'));
  assert.equal(b.cut, 3000 + '\n[image]\nend'.length);
});

test('a long input field is cut with its length in cut; short fields, plan and task tools are kept whole', () => {
  const write = sent(row({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/a/b.ts', content: big(30_000) } }] } })).message.content[0];
  assert.equal(write.input.file_path, '/a/b.ts');
  assert.equal(write.input.content.length, INPUT_HEAD);
  assert.deepEqual(write.cut, { content: 30_000 });
  const task = { type: 'tool_use', id: 't', name: 'TaskCreate', input: { subject: 'Step', description: big(5000) } };
  assert.deepEqual(sent(row({ type: 'assistant', message: { content: [task] } })).message.content[0], task);
});

test("Claude's words are never cut; its user-side text (a compacted summary) is", () => {
  const reply = row({ type: 'assistant', message: { content: [{ type: 'text', text: big(10_000) }] } });
  assert.equal(cutEvent(reply), reply);
  const summary = sent(row({ type: 'user', message: { content: [{ type: 'text', text: big(30_000) }] } })).message.content[0];
  assert.equal(summary.text.length, TEXT_HEAD);
  assert.equal(summary.cut, 30_000);
});

test('small events, other kinds and bad JSON go as stored', () => {
  for (const r of [row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: big(1500) }] } }), row({ text: big(10_000) }, 'user_message'), { id: 1, ticket_id: 1, kind: 'claude', data: `{${big(5000)}`, created_at: 1 }]) assert.equal(cutEvent(r), r);
});

test('an action is cut when its input or its result was', () => {
  assert.equal(actionCut({ block: { input: {} }, result: { content: 'x' } }), false);
  assert.equal(actionCut({ block: { input: {}, cut: { content: 9 } }, result: null }), true);
  assert.equal(actionCut({ block: { input: {} }, result: { content: 'x', cut: 9 } }), true);
});
