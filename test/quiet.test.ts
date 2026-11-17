import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { checkProcess, descendants, GRACE_MS, longestTool, noteEvent, QUIET_MS, quietAt, toolLimit } from '../src/quiet.ts';

const use = (id: string, name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

test('quiet 5 min after the last output, or 2 min past an open tool\'s own timeout when that is later (#906)', () => {
  let a = noteEvent({ at: 0, tools: [] }, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, 1000);
  assert.equal(quietAt(a), 1000 + QUIET_MS, 'thinking: 5 min');
  a = noteEvent(a, use('t1', 'Bash', { command: 'npm test', timeout: 600_000 }), 2000);
  assert.equal(quietAt(a), 2000 + 600_000 + GRACE_MS, 'a 10 min test run: quiet at 12 min');
  assert.equal(longestTool(a)?.label, 'Bash: npm test');
  a = noteEvent(a, use('t2', 'Read', { file_path: 'src/db.ts' }), 3000);
  assert.equal(longestTool(a)?.id, 't1', 'the longest-open call is named');
  a = noteEvent(a, result('t1'), 4000);
  a = noteEvent(a, result('t2'), 5000);
  assert.deepEqual(a.tools, []);
  assert.equal(quietAt(a), 5000 + QUIET_MS, 'results close their calls; the clock restarts at the last line');
});

test('tool limits: Bash by its timeout (default 2 min, at most 10), background calls none, MCP 10 min, the rest none', () => {
  assert.equal(toolLimit('Bash', {}), 120_000);
  assert.equal(toolLimit('Bash', { timeout: 9_999_999 }), 600_000);
  assert.equal(toolLimit('Bash', { timeout: 300_000, run_in_background: true }), 0);
  assert.equal(toolLimit('mcp__thread__hand_off_land', {}), 600_000);
  assert.equal(toolLimit('Read', {}), 0);
});

test('descendants walks the process tree from a pid', () => {
  const all = new Map([[1, { pid: 1, ppid: 0 }], [2, { pid: 2, ppid: 1 }], [3, { pid: 3, ppid: 2 }], [4, { pid: 4, ppid: 9 }]]);
  assert.deepEqual(descendants(all, 1).sort(), [1, 2, 3]);
  assert.deepEqual(descendants(all, 7), []);
});

test('checkProcess: unknown with no pid, gone for a dead one, busy for a process burning CPU', async () => {
  assert.equal((await checkProcess(null)).verdict, 'unknown');
  assert.equal((await checkProcess(2 ** 22 + 12345)).verdict, 'gone');
  const busy = spawn(process.execPath, ['-e', 'const t = Date.now(); while (Date.now() - t < 3000);'], { stdio: 'ignore' });
  try {
    const c = await checkProcess(busy.pid!, 300);
    assert.equal(c.verdict, 'busy', c.text);
  } finally {
    busy.kill();
    await new Promise((r) => busy.once('exit', r));
  }
});
