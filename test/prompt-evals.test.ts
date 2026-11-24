import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempRoot } from './helpers.ts';
import { answer } from '../tools/prompt-evals/stub.ts';
import { briefProblems, events, failures, fell, holds, load, passes, problems, snapshot, type Brief, type Case } from '../tools/prompt-evals/run.ts';

// Prompt evals (#1117): the frozen cases stay valid, and the scoring, the stub and the snapshot do what README.md says.
const dir = new URL('../tools/prompt-evals/', import.meta.url).pathname;

test('every case and brief file is valid, with unique ids and regexes that compile', () => {
  const cases = load<Case>(join(dir, 'cases'), problems);
  const briefs = load<Brief>(join(dir, 'briefs'), briefProblems);
  assert.ok(cases.length >= 25, `${cases.length} cases`);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.equal(new Set(briefs.map((b) => b.id)).size, briefs.length);
  for (const c of cases) assert.ok(c.history.length <= 2_500, `${c.id}: history is ${c.history.length} characters`);
});

test('problems() names what is wrong with a case', () => {
  const ok = { id: 'x', kind: 'rule', source: 's', role: 'minion', ticket: { number: 1, title: 't', type: null }, commit: 'abc1234', from: 'Cara', history: '', message: 'm', facts: [], right: 'r', wrong: 'w', checks: [{ call: 'ask_question', why: 'y' }] };
  assert.deepEqual(problems(ok, 'x.json'), []);
  assert.match(problems({ ...ok, checks: [{ call: 'a', noText: 'b', why: 'y' }] }).join(), /exactly one/);
  assert.match(problems({ ...ok, checks: [{ noText: '(', why: 'y' }] }).join(), /noText/);
  assert.match(problems({ ...ok, checks: [{ noText: 'a', before: 'b', why: 'y' }] }).join(), /before goes with call/);
  assert.match(problems(ok, 'y.json').join(), /file name/);
});

const stream = (...blocks: object[]) => blocks.map((b) => JSON.stringify({ type: 'assistant', message: { content: [b] } })).join('\n');
const said = (text: string) => ({ type: 'text', text });
const called = (name: string, input: object) => ({ type: 'tool_use', name, input });

test("events() keeps the top-level calls and text in order and skips a Grunt's own", () => {
  const s = stream(said('Checking.'), called('mcp__thread__host_check', { sql: 'select 1' })) + '\n' + JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [said('grunt')] } }) + '\nnot json';
  assert.deepEqual(events(s), [{ text: 'Checking.' }, { call: 'mcp__thread__host_check', input: '{"sql":"select 1"}' }]);
});

test('checks: call, before, noCall, reply and noText', () => {
  const ev = events(stream(said('Let me look.'), called('mcp__thread__read_minion', { number: 523 }), said('#523 is in self-review, no card open.')));
  assert.ok(holds({ call: 'read_minion|list_tickets', input: '523', why: '' }, ev));
  assert.ok(!holds({ call: 'read', why: '' }, ev), 'a tool pattern matches the whole name');
  assert.ok(!holds({ call: 'read_minion', input: '999', why: '' }, ev));
  assert.ok(holds({ call: 'read_minion', before: 'self-review', why: '' }, ev), 'the call came before the claim');
  assert.ok(!holds({ call: 'read_minion', before: 'look', why: '' }, ev), 'the text came first');
  assert.ok(holds({ call: 'read_minion', before: 'never said', why: '' }, ev));
  assert.ok(holds({ noCall: 'ask_question', why: '' }, ev));
  assert.ok(!holds({ noCall: 'read_.*', why: '' }, ev));
  assert.ok(holds({ reply: 'no card open', why: '' }, ev));
  assert.ok(!holds({ reply: 'let me', why: '' }, ev), 'reply is the last text only');
  assert.ok(!holds({ noText: 'LET ME', why: '' }, ev), 'case-insensitive');
  const c = {
    checks: [
      { noText: 'self-review', why: 'said it' },
      { call: 'read_minion', why: 'looked' },
    ],
  } as Case;
  assert.deepEqual(failures(c, ev), ['said it']);
});

test('checks: said matches any text or any call input', () => {
  const ev = events(stream(said('Let me look.'), called('mcp__thread__plan', { steps: [{ n: 1, step: 'when X, then Y' }] }), said('Done.')));
  assert.ok(holds({ said: 'let me', why: '' }, ev), 'an early text');
  assert.ok(holds({ said: 'when x, then y', why: '' }, ev), 'a call input');
  assert.ok(!holds({ said: 'nowhere', why: '' }, ev));
  const ok = { id: 'x', kind: 'rule', source: 's', role: 'minion', ticket: { number: 1, title: 't', type: null }, commit: 'abc1234', from: 'Cara', history: '', message: 'm', facts: [], right: 'r', wrong: 'w', checks: [{ said: 'a', why: 'y' }] };
  assert.deepEqual(problems(ok), []);
  assert.match(problems({ ...ok, work: 'not a sha' }).join(), /work is a sha/);
});

test('scoring: most runs pass; a case fell only on a drop of 2 or more', () => {
  assert.ok(passes(2, 3) && !passes(1, 3) && !passes(1, 2));
  assert.ok(fell(1, 3) && fell(0, 2) && !fell(2, 3) && !fell(1, 2) && !fell(3, 1));
});

test('the stub answers from the first matching fact, else a stock reply', () => {
  const facts = [
    { tool: 'host_check', match: 'ci_runs', result: 'run 7 waited 40 s' },
    { tool: 'host_check|read_minion', result: 'any' },
  ];
  assert.equal(answer(facts, 'host_check', { sql: 'select * from ci_runs' }), 'run 7 waited 40 s');
  assert.equal(answer(facts, 'host_check', { sql: 'select 1' }), 'any');
  assert.match(answer([], 'ask_question', {}), /card is in the chat/);
  assert.match(answer([], 'hand_off_land', {}), /Handed off/);
  assert.equal(answer([], 'list_tickets', {}), '(no rows)');
});

test('the stub serves a tool list and answers calls over stdio', async () => {
  const tmp = tempRoot('stub-tools-');
  const tools = tmp.path('tools.json'),
    facts = tmp.path('facts.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tools, JSON.stringify([{ name: 'host_check', inputSchema: { type: 'object' } }]));
  writeFileSync(facts, JSON.stringify([{ tool: 'host_check', result: 'rows' }]));
  const p = tmp.spawn(process.execPath, [join(dir, 'stub.ts')], { env: { ...process.env, STUB_TOOLS: tools, STUB_FACTS: facts } });
  try {
    const got: any[] = [];
    let buf = '';
    const done = new Promise<void>((ok) =>
      p.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop()!;
        got.push(...lines.map((l) => JSON.parse(l)));
        if (got.length === 3) ok();
      }),
    );
    for (const m of [{ id: 1, method: 'initialize', params: {} }, { method: 'notifications/initialized' }, { id: 2, method: 'tools/list' }, { id: 3, method: 'tools/call', params: { name: 'host_check', arguments: {} } }]) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    await done;
    assert.equal(got[1].result.tools[0].name, 'host_check');
    assert.equal(got[2].result.content[0].text, 'rows');
  } finally {
    await tmp.teardown();
  }
});

test("the replay guard refuses writes and today's live state, and lets Citadel's own (stubbed) tools through", () => {
  const decide = (tool_name: string, tool_input: object) => {
    const out = spawnSync(process.execPath, [join(dir, 'guard.ts')], { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' }).stdout.trim();
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
  };
  assert.equal(decide('Read', { file_path: '/tmp/x/src/db.ts' }), 'allow');
  assert.equal(decide('Bash', { command: 'git log -3' }), 'allow');
  assert.equal(decide('Bash', { command: 'node /tmp/k/kit/skills/test-quality/scripts/test-habits.ts --base main' }), 'allow');
  assert.equal(decide('Bash', { command: 'node /tmp/k/kit/skills/test-quality/scripts/test-habits.ts --base main; rm -rf /tmp/x' }), 'deny');
  assert.equal(decide('Bash', { command: 'node /tmp/k/tools/other.ts' }), 'deny');
  assert.equal(decide('Bash', { command: 'cd /tmp/ws && node /tmp/k/kit/skills/test-quality/scripts/test-habits.ts' }), 'allow');
  assert.equal(decide('Write', { file_path: '/tmp/x/a.ts', content: '' }), 'deny');
  assert.equal(decide('Bash', { command: 'cat /home/cara/.local/share/claude-coordinator/projects/2/shared/project/handoffs/x.md' }), 'deny');
  assert.equal(decide('Bash', { command: 'sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select 1"' }), 'deny');
  assert.equal(decide('Read', { file_path: '/home/cara/claude-coordinator/src/db.ts' }), 'deny');
  assert.equal(decide('mcp__thread__message_minion', { text: 'see projects/2/shared/project/handoffs/x.md' }), 'allow');
  assert.equal(decide('mcp__thread__host_check', { what: 'db', sql: 'select 1' }), 'allow');
});

test("snapshot() cuts the two instruction sections out of a turn's system prompt", () => {
  const text = ['# Environment', 'x', '', '# Citadel-wide instructions', 'People set these…', '', '## Who', 'Cara runs it.', '', "GitHub's own runners (set in its Minion rules): ask first.", '', '# Scheme instructions for "Citadel"', 'People set these…', '', '## Names', 'Old names stay.'].join('\n');
  assert.deepEqual(snapshot(text), { app: '## Who\nCara runs it.\n', scheme: '## Names\nOld names stay.\n' });
  assert.ok(readFileSync(join(dir, 'fixture/citadel-wide.md'), 'utf8').includes('## Who and tone'));
});

test('ablate() empties parts, removes lines and cuts tools to their first sentence, and refuses a drop that matches nothing (#1277)', async () => {
  const { ablate } = await import('../tools/prompt-evals/render.ts');
  const parts = { system: { base: ['keep me', 'drop me too'], files: ['f1', 'f2'] }, turn: { files: ['t1'], pr: ['p'] } };
  const tools = [
    { name: 'ask_question', description: 'Ask people a card. It has many more words. And more.' },
    { name: 'other', description: 'Stays. Whole.' },
  ];
  ablate(parts, tools, { parts: ['files'], lines: ['drop me'], tools: ['ask_question'] });
  assert.deepEqual(parts, { system: { base: ['keep me'], files: [] }, turn: { files: [], pr: ['p'] } });
  assert.deepEqual(
    tools.map((t) => t.description),
    ['Ask people a card.', 'Stays. Whole.'],
  );
  for (const bad of [{ parts: ['nope'] }, { lines: ['not there'] }, { tools: ['nope'] }]) assert.throws(() => ablate(parts, tools, bad), /drop: no/);
  assert.throws(() => ablate(parts, [{ name: 'one', description: 'Only one sentence.' }], { tools: ['one'] }), /one sentence already/, 'a cut that leaves the text whole tests nothing');
  for (const bad of [null, {}, { part: ['close'] }, { parts: 'close' }, { lines: [] }, { lines: [''] }]) assert.throws(() => ablate(parts, tools, bad as any), /drop: want/);
});
