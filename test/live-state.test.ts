import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveState } from '../src/live-state.ts';

// read_ticket's live view (#620): what a turn waits on, from stored events.
const T0 = 1_800_000_000_000;
const ev = (at: number, data: object, kind = 'claude') => ({ kind, data: JSON.stringify(data), created_at: T0 + at * 1000 });
const init = (at: number) => ev(at, { type: 'system', subtype: 'init' });
const use = (at: number, id: string, name: string, input: object, grunt?: string) => ev(at, { type: 'assistant', ...(grunt ? { parent_tool_use_id: grunt } : {}), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (at: number, id: string, content: string, is_error = false) => ev(at, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const minion = { number: 291, status: 'running', cwd: '/data/projects/3/tickets/1405', turnStartedAt: T0, queued: 0, approvals: 0 };

test('a turn stuck in a tool call says which, with its input and how long it has run', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const events = [
    ev(-100, { type: 'system', subtype: 'init' }), use(-90, 'old', 'Bash', { command: 'from an earlier turn' }),
    init(0), use(10, 'a', 'Read', { file_path: '/x/app.ts' }), result(11, 'a', 'line one\nline two'),
    use(60, 'b', 'Bash', { command: `GH_TOKEN=${token} npm test`, description: 'Run the tests' }),
  ];
  const text = liveState(minion, events, T0 + 780_000).join('\n');
  assert.match(text, /^Live state of #291: status running, turn running 13m 0s$/m);
  assert.match(text, /^worktree: \/data\/projects\/3\/tickets\/1405$/m);
  assert.match(text, /^waiting on: a tool: Bash \(Run the tests: GH_TOKEN=… npm test\), running 12m 0s$/m);
  assert.doesNotMatch(text, /aaaaaaaaaa/);
  assert.match(text, /Read: \/x\/app\.ts → ok after 1s: line one line two/);
  assert.match(text, /Last 2 of this turn's 2 tool call\(s\)/);
  assert.doesNotMatch(text, /earlier turn/);
});

test('env values, URL passwords and bearer tokens are hidden in inputs and output', () => {
  const events = [init(0), use(1, 'a', 'Bash', { command: 'PASSWORD=hunter2 curl -H "Authorization: Bearer abcdef123456" https://u:pw@h/x' }), result(2, 'a', 'HOME=/home/x\nDATABASE_URL=postgres://user:secret@db/app')];
  const text = liveState(minion, events, T0 + 5_000).join('\n');
  for (const secret of ['hunter2', 'abcdef123456', ':pw@', 'secret', '/home/x']) assert.ok(!text.includes(secret), `${secret} shown in:\n${text}`);
  assert.match(text, /PASSWORD=… curl -H "Authorization: Bearer …" https:\/\/u:…@h\/x/);
  assert.match(text, /HOME=… DATABASE_URL=…/);
});

test("a turn that hasn't sent its init yet doesn't show the last turn's unanswered call as running", () => {
  const events = [init(0), use(5, 'a', 'Bash', { command: 'sleep 999' }), ev(9, { type: 'result', subtype: 'error' })];
  const text = liveState({ ...minion, turnStartedAt: T0 + 3_600_000 }, events, T0 + 3_602_000).join('\n');
  assert.match(text, /^waiting on: the model: no events from this turn yet$/m);
  assert.doesNotMatch(text, /sleep 999/);
});

test("an open Grunt call shows the Grunt's own latest call", () => {
  const events = [init(0), use(5, 'g', 'Agent', { description: 'Review the diff', prompt: 'long brief' }), use(30, 'g1', 'Grep', { pattern: 'liveState' }, 'g'), result(31, 'g1', 'src/live-state.ts'), use(40, 'g2', 'Bash', { command: 'git diff main' }, 'g')];
  const text = liveState(minion, events, T0 + 100_000).join('\n');
  assert.match(text, /a tool: Agent \(Review the diff\), running 1m 35s; its Grunt's latest call, 1m 0s ago: Bash \(git diff main\), still running/);
  assert.match(text, /\(Grunt\) Grep: liveState → ok/);
});

test('with every call answered it waits on the model, and queued messages and waits are named', () => {
  const events = [init(0), use(5, 'a', 'Bash', { command: 'false' }), result(8, 'a', 'exit 1', true)];
  const wait = { kind: 'land', text: '2nd in line, behind #513 (testing)', since: T0 + 20_000 };
  const text = liveState({ ...minion, queued: 2, wait }, events, T0 + 48_000).join('\n');
  assert.match(text, /^waiting on: the model: 40s since the turn's last event; land: 2nd in line, behind #513 \(testing\) \(for 28s\)$/m);
  assert.match(text, /^queued: 2 message\(s\) from people/m);
  assert.match(text, /Bash: false → error after 3s: exit 1/);
});

test('an approval card is what it waits on, not the model', () => {
  const text = liveState({ ...minion, approvals: 1 }, [init(0)], T0 + 5_000).join('\n');
  assert.match(text, /^waiting on: a person: 1 approval card\(s\) waiting$/m);
  assert.match(text, /No tool calls in this turn\./);
});

test("a minion with no turn running says so, and a call its turn never answered isn't shown as running", () => {
  const events = [init(0), use(5, 'a', 'Bash', { command: 'sleep 999' }), ev(9, { type: 'result', subtype: 'error' })];
  const text = liveState({ ...minion, status: 'idle', state: 'ready', turnStartedAt: null }, events, T0 + 60_000).join('\n');
  assert.match(text, /^Live state of #291: status idle$/m);
  assert.match(text, /^waiting on: nothing: no turn is running \(state ready\)$/m);
  assert.match(text, /Bash: sleep 999 → no result \(the turn ended\)/);
  assert.match(text, /of the last turn's 1 tool call/);
});
