import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gist, groupTitle, gruntName, gruntOf } from '../public/grunts.js';
import { applyEvent, createProgress } from '../public/progress.js';

const say = (text, parent) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...(parent ? { parent_tool_use_id: parent } : {}) });

test("a subagent's words are a Grunt's; the minion's own are its reply", () => {
  assert.equal(gruntOf('claude', say('Round 1 for Emberknight is done.', 'toolu_01CB')), 'toolu_01CB');
  assert.equal(gruntOf('claude', say('All 40 takes are drawn.')), null);
  assert.equal(gruntOf('claude', { type: 'result', subtype: 'success' }), null);
  // A Grunt's tool results are its too, so they still count toward its own run.
  assert.equal(gruntOf('claude', { type: 'user', message: { content: [] }, parent_tool_use_id: 'toolu_9' }), 'toolu_9');
  // People's messages never are, whatever they carry.
  assert.equal(gruntOf('user_message', { text: 'hi', parent_tool_use_id: 'toolu_9' }), null);
  assert.equal(gruntOf('claude', { ...say('x'), parent_tool_use_id: '' }), null);
  assert.equal(gruntOf('claude', null), null);
});

test("a report's line is its verdict, else its first line, without Markdown", () => {
  assert.equal(gist('Emberknight has five takes in `classes/emberknight.py`.\n\n**A** reads well.'), 'Emberknight has five takes in classes/emberknight.py.');
  assert.equal(gist('## Review\n\n- one finding\n\n**Verdict:** ship it'), 'Verdict: ship it');
  assert.equal(gist('\n\n- **first** bullet\n'), 'first bullet');
  assert.equal(gist('Fixed test_foo.py and a_b | c'), 'Fixed test_foo.py and a_b | c');
  assert.equal(gist(''), '');
  assert.equal(gist('x'.repeat(300)).length, 160);
});

test("a Grunt's name is its description, else its agent type", () => {
  assert.equal(gruntName({ description: 'Draw Emberknight sigil takes', subagent_type: 'general-purpose' }), 'Draw Emberknight sigil takes');
  assert.equal(gruntName({ subagent_type: 'citadel:check-runner' }), 'citadel:check-runner');
  assert.equal(gruntName(undefined), 'Grunt');
});

test('a fan-out block says how many Grunts and how long, when known', () => {
  const d = (ms) => `${Math.round(ms / 60000)}m`;
  assert.equal(groupTitle(8, 360000, d), '8 Grunts finished · 6m');
  assert.equal(groupTitle(1, 0, d), '1 Grunt finished');
});

test("a Grunt's report isn't the readout's note on the step underway", () => {
  const p = createProgress();
  p.tasks = [{ id: '1', subject: 'Draw', status: 'in_progress', actions: 0 }];
  applyEvent(p, 'claude', say('Eight workers are drawing.'));
  applyEvent(p, 'claude', say('Emberknight has five takes…', 'toolu_1'));
  assert.equal(p.tasks[0].note, 'Eight workers are drawing.');
});
