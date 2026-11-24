import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: plain .mjs, no types
import { take } from '../tools/review-escapes/fake-claude.mjs';
// @ts-expect-error: plain .mjs, no types
import { MAX_BLOCKS, NEED, shortfall, tally } from '../tools/review-escapes/verifier-stay.mjs';

// The verifier's state kit (#1740): the stand-in claude a dev copy's turns run, and the hook that keeps the verifier
// driving until it has done enough.
const HERE = join(import.meta.dirname, '../tools/review-escapes');

test('a queued turn goes to the minion it names, or to the first that asks when it names none', () => {
  const q = [{ ticket: 2, text: 'two' }, { text: 'any' }, { ticket: 3, text: 'three' }];
  assert.equal(take(q, { ticket: '3', number: '9' }).text, 'any');
  assert.equal(take(q, { ticket: '3', number: '9' }).text, 'three');
  assert.equal(take(q, { ticket: '5', number: '2' }).text, 'two'); // by its #N too
  assert.equal(take(q, { ticket: '1' }), null);
});

/** Runs the fake as the runner does, its prompt on stdin, in a scratch folder; returns its events and what it logged. */
function fake(queue: object[], extraArgs: string[] = [], files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  try {
    writeFileSync(join(dir, 'turns.jsonl'), queue.map((q) => JSON.stringify(q) + '\n').join(''));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const r = spawnSync(process.execPath, [join(HERE, 'fake-claude.mjs'), '-p', '--input-format', 'stream-json', ...extraArgs.map((a) => a.replace('{dir}', dir))], {
      input: JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n',
      env: { ...process.env, FAKE_CLAUDE_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), COORDINATOR_TICKET: '4', COORDINATOR_ROLE: 'thread' },
      encoding: 'utf8', cwd: dir, timeout: 30_000,
    });
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return { status: r.status, events, calls, left: readFileSync(join(dir, 'turns.jsonl'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
}

test('with nothing queued a turn replies ok and succeeds, logging its prompt', () => {
  const { status, events, calls } = fake([]);
  assert.equal(status, 0);
  assert.equal(events[0].subtype, 'init');
  assert.deepEqual(events.at(-1), { ...events.at(-1), type: 'result', is_error: false, result: 'ok' });
  assert.equal(calls[0].prompt, 'hello');
  assert.equal(calls[0].ticket, '4');
});

test('a usage-limit turn ends the way Claude Code does, in words the runner reads as a limit', async () => {
  const { status, events, left } = fake([{ outcome: 'usage_limit' }, { text: 'later' }]);
  assert.equal(status, 1);
  const result = events.at(-1);
  assert.equal(result.is_error, true);
  const { USAGE_LIMIT } = await import('../src/turn-launch.ts');
  assert.match(result.result, USAGE_LIMIT);
  assert.equal(left.trim(), JSON.stringify({ text: 'later' }), 'only the line it used is gone');
});

test('a not-logged-in turn reads as an account error', async () => {
  const { events } = fake([{ outcome: 'not_logged_in' }]);
  const { ACCOUNT_ERROR } = await import('../src/turn-outcome.ts');
  assert.match(events.at(-1).result, ACCOUNT_ERROR);
});

test('the clock offset boot.mjs writes moves the limit\'s reset hour and the log\'s time', () => {
  const day = 24 * 3600_000;
  const { calls } = fake([{}], [], { 'clock-offset': String(day) });
  assert.ok(Math.abs(Date.parse(calls[0].at) - (Date.now() + day)) < 60_000);
});

test('tools go to the turn\'s own stdio MCP server, the way Claude Code calls them', () => {
  // A tiny MCP server: answers initialize, echoes a tools/call with the ticket it runs for.
  const server = `const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;
  const result = m.method === 'tools/call' ? { content: [{ type: 'text', text: m.params.name + ':' + JSON.stringify(m.params.arguments) + ':' + process.env.COORDINATOR_TICKET }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); });`;
  const mcp = JSON.stringify({ mcpServers: { thread: { type: 'stdio', command: process.execPath, args: ['-e', server] } } });
  const { events, calls } = fake([{ tools: [{ name: 'set_thread_status', arguments: { state: 'ready' } }], text: 'set' }], ['--mcp-config', '{dir}/mcp.json'], { 'mcp.json': mcp });
  assert.deepEqual(calls[0].tools[0].result.content[0].text, 'set_thread_status:{"state":"ready"}:4');
  const use = events.find((e) => e.message?.content?.[0]?.type === 'tool_use');
  assert.equal(use.message.content[0].name, 'mcp__thread__set_thread_status');
  assert.equal(events.at(-1).result, 'set');
});

const drive = (command: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const say = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('the stay hook counts only calls that drive the running copy', () => {
  const lines = [drive('curl -s -H "Cookie: $DEV_COOKIE" "${DEV_URL}api/projects"'), drive('node boot.mjs restart'), drive('node tools/ui-shot.ts "#/p/1"'),
    drive('echo \'{"outcome":"usage_limit"}\' >> fake/turns.jsonl'), drive('git diff main...HEAD'), drive('node --test test/x.test.ts'), drive('cat src/runner.ts'), 'not json', say('done')];
  const t = tally(lines, 0, 20 * 60_000);
  assert.equal(t.drives, 4);
  assert.equal(t.minutes, 20);
  assert.equal(t.last, 'done');
});

test('the stay hook names each thing still short, and lets a run that did enough stop', () => {
  const report = '```\ncurl a\nok\n```\n```\ncurl b\nok\n```\n```\nrestart\nok\n```';
  const short = shortfall({ drives: 2, minutes: 3, last: '' });
  assert.match(short, /driven the running copy 2 times/);
  assert.match(short, /worked 3 minutes/);
  assert.match(short, /shows 0 commands/);
  assert.equal(shortfall({ drives: NEED.drives, minutes: NEED.minutes, last: report }), '');
  assert.match(shortfall({ drives: NEED.drives, minutes: NEED.minutes, last: '' }, '```\nonly one\n```'), /shows 1 commands/);
});

test('the stay hook blocks a run that stopped early, then gives way after its last block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stay-'));
  try {
    writeFileSync(join(dir, 'started-at'), String(Date.now()));
    writeFileSync(join(dir, 'stream.jsonl'), [drive('curl "$DEV_URL"'), say('ok')].join('\n'));
    const run = () => spawnSync(process.execPath, [join(HERE, 'verifier-stay.mjs'), dir], { input: JSON.stringify({ stop_hook_active: false }), encoding: 'utf8' }).stdout;
    for (let i = 0; i < MAX_BLOCKS; i++) assert.equal(JSON.parse(run()).decision, 'block', `block ${i + 1}`);
    assert.equal(run(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
