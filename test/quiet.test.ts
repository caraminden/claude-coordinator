import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
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

// The runner end: a real turn (a stand-in claude that says one line when told, and ends when released).
testPins();
const root = mkdtempSync(join(tmpdir(), 'quiet-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
const { existsSync, rmSync } = require('node:fs');
process.stdin.resume();
const tick = setInterval(() => {
  if (existsSync(${JSON.stringify(join(root, 'talk'))})) {
    rmSync(${JSON.stringify(join(root, 'talk'))});
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] } }));
  }
  if (!existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(tick);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`);
chmodSync(fake, 0o755);

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}

test('the runner saves a turn going quiet, not while it waits on a person, and clears it when the turn talks again (#906)', async () => {
  const store = new Store(join(root, 'test.db'));
  const project = store.createProject('Test', null);
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  r.send(t.id, 'Cara', 'go');
  await until(() => !!(r as any).turns.get(t.id));
  const live = (r as any).turns.get(t.id);
  const saved = () => store.getSetting<{ quiet?: number }>(`turn:${t.id}`)?.quiet ?? null;
  const goQuiet = () => {
    live.activity = { at: Date.now() - QUIET_MS - 60_000, tools: [] };
    (r as any).checkQuiet(t.id, live);
  };

  goQuiet();
  assert.equal(saved(), live.activity.at + QUIET_MS);
  assert.equal(r.activityOf(t.id)!.quiet_since, saved());

  // An approval waiting: the silence is the person's, and the clock restarts.
  const waiting = (r as any).approvals.waiting;
  (r as any).approvals.waiting = (id: number) => id === t.id;
  (r as any).checkQuiet(t.id, live);
  assert.equal(saved(), null);
  assert.ok(Date.now() - live.activity.at < 1000, 'the quiet clock restarted');
  goQuiet();
  assert.equal(saved(), null, 'never quiet while it waits on a person');
  (r as any).approvals.waiting = waiting;

  goQuiet();
  assert.ok(saved());
  writeFileSync(join(root, 'talk'), '');
  await until(() => saved() === null);
  assert.equal(r.activityOf(t.id)!.quiet_since, null);

  writeFileSync(join(root, 'release'), '');
  await until(() => !r.isRunning(t.id));
});
