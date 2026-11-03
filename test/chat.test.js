// Citadel UI's chat kit (public/ui/chat.js): the pure model and its HTML. The live mount is checked in a
// browser (a dev copy's scratch page); the contract test stores a recorded turn's HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatModel, duration, gruntName, renderChat } from '../public/ui/chat.js';

const t = (s) => Date.parse(`2026-11-02T12:00:${String(s).padStart(2, '0')}Z`);
const text = (delta, message = 'm1') => ({ type: 'text', data: { delta, parent: null, message } });
const tool = (id, name, input = {}, parent = null, at) => ({ type: 'tool', data: { id, name, input, parent }, at });
const result = (id, ok = true, parent = null, at) => ({ type: 'tool_result', data: { id, ok, parent }, at });
const reply = (m, i = 0) => m.items[i].blocks;

test('text splits per message id, not glued across a tool call; without ids, at the tool call', () => {
  const events = [text('Let me '), text('check.'), tool('a', 'mcp__mandate__list_todos'), result('a'), text('Done.', 'm2'), { type: 'end', data: {} }];
  const m = chatModel([{ ask: 'Push my errands', events }]);
  assert.equal(m.running, false);
  assert.equal(m.items[0].ask, 'Push my errands');
  assert.deepEqual(reply(m).map((b) => [b.kind, b.text]), [['text', 'Let me check.'], ['steps', undefined], ['text', 'Done.']]);
  // Two messages with nothing between them are still two paragraphs.
  assert.equal(reply(chatModel([{ events: [text('One.'), text('Two.', 'm2')] }])).length, 2);
  // An app on an older Citadel (no ids): the tool call splits them.
  const old = events.map((e) => (e.type === 'text' ? { ...e, data: { delta: e.data.delta, parent: null } } : e));
  assert.deepEqual(reply(chatModel([{ events: old }])).map((b) => b.text ?? b.kind), ['Let me check.', 'steps', 'Done.']);
});

test('a run of calls between texts folds into one block, each step marked by its result', () => {
  const events = [tool('g', 'get'), result('g'), tool('r', 'read', {}, null, t(1)), result('r', false, null, t(3)), tool('s', 'search')];
  const [run] = reply(chatModel([{ events }]));
  assert.deepEqual(run.steps.map((s) => [s.id, s.state]), [['g', 'done'], ['r', 'failed'], ['s', 'running']]);
  assert.deepEqual([run.steps[1].start, run.steps[1].end], [t(1), t(3)]);
});

test('Agent calls become Grunt rows holding their own calls by parent, nested Grunts included', () => {
  const events = [
    text('Splitting it.'),
    tool('a', 'Agent', { description: 'Check Thursday' }, null, t(0)),
    tool('b', 'Agent', { subagent_type: 'citadel:check-runner' }),
    tool('a1', 'mcp__mandate__calendar', {}, 'a'),
    result('a1', true, 'a'),
    tool('ax', 'Agent', { description: 'deeper' }, 'a'),
    tool('ax1', 'mcp__mandate__list', {}, 'ax'),
    tool('z1', 'mcp__mandate__list', {}, 'nobody'),
    result('a', true, null, t(41)),
  ];
  const m = chatModel([{ events }]);
  const run = reply(m)[1];
  assert.equal(run.kind, 'steps');
  const [a, b] = run.steps;
  assert.equal(a.grunt, true);
  assert.equal(gruntName(a.input), 'Check Thursday');
  assert.equal(gruntName(b.input), 'citadel:check-runner');
  assert.deepEqual(a.steps.map((s) => s.id), ['a1', 'ax', 'ax1'], 'a nested Grunt\'s calls land in the outermost row; a stray parent is dropped');
  assert.deepEqual([a.state, b.state, a.end - a.start], ['done', 'running', 41000]);
  // No Grunt's call leaks into the reply's own steps.
  assert.deepEqual(run.steps.map((s) => s.id), ['a', 'b']);
});

test('when a turn ends, fails or is stopped, whatever was still running stops, and the notice says which', () => {
  const events = [tool('a', 'Agent', {}), tool('a1', 'x', {}, 'a'), tool('c', 'calc')];
  const stopped = chatModel([{ events: [...events, { type: 'error', data: { code: 'canceled', message: 'turn canceled' } }] }]);
  assert.equal(stopped.running, false);
  const [run, note] = reply(stopped);
  assert.deepEqual([run.steps[0].state, run.steps[0].steps[0].state, run.steps[1].state], ['stopped', 'stopped', 'stopped']);
  assert.equal(note.kind, 'stopped');
  const failed = chatModel([{ events: [...events, { type: 'error', data: { code: 'limit', message: 'You\'ve reached your usage limit.' } }] }]);
  assert.deepEqual(reply(failed).at(-1), { id: '0.1', kind: 'error', code: 'limit', message: 'You\'ve reached your usage limit.' });
  // A turn with no end that a later turn followed stopped too; only the newest one can be running.
  const two = chatModel([{ ask: 'a', events }, { ask: 'b', events: [] }]);
  assert.deepEqual([two.items[0].running, two.items[1].running, two.running], [false, true, true]);
  assert.equal(reply(two)[0].steps[1].state, 'stopped');
});

test('a call the app claims as a card leaves the step run and takes its result', () => {
  const card = (name) => name === 'mcp__pob__show_viability';
  const events = [tool('g', 'get'), tool('v', 'mcp__pob__show_viability', { odds: 4 }), result('v'), tool('h', 'get')];
  const blocks = reply(chatModel([{ events }], { card }));
  assert.deepEqual(blocks.map((b) => b.kind), ['steps', 'card', 'steps']);
  assert.deepEqual(blocks[1], { id: '0.1', kind: 'card', tool: 'v', name: 'mcp__pob__show_viability', input: { odds: 4 }, result: { id: 'v', ok: true, parent: null } });
  // The result is the tool_result's data as it came, ok a boolean: an app's own fields reach its card (#287, Theory of Crafting).
  const rich = { type: 'tool_result', data: { id: 7, ok: 1, parent: null, output: { odds: 0.4 } } };
  const [c] = reply(chatModel([{ events: [tool('7', 'mcp__pob__show_viability'), rich] }], { card }));
  assert.deepEqual(c.result, { id: '7', ok: true, parent: null, output: { odds: 0.4 } });
  // Agent calls are always Grunts, whatever the app claims.
  assert.equal(reply(chatModel([{ events: [tool('a', 'Agent')] }], { card: () => true }))[0].kind, 'steps');
});

test('renderChat: the folded row reads the step in hand while running and a count once done', () => {
  const stepLabel = (name, input) => (name === 'move_todo' ? `Moving “${input.title}”` : undefined);
  const running = renderChat([{ ask: 'Go', events: [tool('a', 'list'), result('a'), tool('m', 'move_todo', { title: 'Dry <cleaning>' })] }], { stepLabel, now: 0 });
  assert.match(running, /<b>Moving “Dry &lt;cleaning&gt;”…<\/b> · step 2/);
  assert.match(running, /class="cui-spin"/);
  const done = renderChat([{ events: [tool('a', 'list'), result('a'), tool('g', 'Agent'), result('g', false), { type: 'end', data: {} }] }], { now: 0 });
  assert.match(done, /2 steps · 1 Grunt · 1 failed/);
  assert.match(done, /data-state="failed"/);
  assert.doesNotMatch(done, /cui-steps/, 'folded until opened');
  assert.match(renderChat([{ events: [tool('a', 'list_todos'), result('a')] }], { open: ['0.0'] }), /<span class="cui-step-label">List todos<\/span>/);
});

test('renderChat: the app\'s markdown hooks reach every reply; the kit keeps breaks, streaming and the hooks it wasn\'t given', () => {
  const markdown = { text: (html) => html.replace(/\b(?:Ctrl|Alt)\+[\w+]+/g, (k) => `<kbd>${k}</kbd>`), breaks: false, streaming: false };
  const done = renderChat([{ events: [text('Press Ctrl+Alt+P\nthen [docs](https://x.y)'), { type: 'end', data: {} }] }], { markdown });
  assert.match(done, /Press <kbd>Ctrl\+Alt\+P<\/kbd><br>then <a /, 'the text hook runs; line breaks stay');
  assert.match(done, /<a [^>]*href="https:\/\/x\.y"[^>]*target="_blank"/, 'no link hook given: the kit\'s link handling stays');
  const link = (href, html) => `<a class="mine" href="${href}">${html}</a>`;
  // An app path the kit would leave inert (Theory of Crafting's /apps/.../api/... links) becomes a real link.
  assert.match(renderChat([{ events: [text('[the build](/apps/toc/api/builds/7)')] }]), /<span class="cui-link"[^>]*>the build<\/span>/);
  const streaming = renderChat([{ events: [text('Use **Ctrl+K and [the build](/apps/toc/api/builds/7)')] }], { markdown: { ...markdown, link } });
  assert.match(streaming, /Use <strong><kbd>Ctrl\+K<\/kbd> and <a class="mine" href="\/apps\/toc\/api\/builds\/7">the build<\/a><\/strong>/, 'still streaming: the half bold closes; the link hook replaces the kit\'s');
});

test('renderChat: a running Grunt shows under its row with its steps and a ticking clock', () => {
  const html = renderChat([{ events: [tool('g', 'Agent', { description: 'Check' }, null, 1000), tool('g1', 'calendar', {}, 'g')] }], { now: 42000 });
  assert.match(html, /<span class="cui-grunt-task">Grunt · Check<\/span><span class="cui-time" data-since="1000">41s<\/span>/);
  assert.match(html, /<span class="cui-step-label">Calendar<\/span>/);
});

test('duration reads as seconds or minutes', () => {
  assert.equal(duration(41000), '41s');
  assert.equal(duration(72000), '1m 12s');
  assert.equal(duration(-5), '0s');
});
