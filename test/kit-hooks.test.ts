import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobCheck, MAX_STOP_BLOCKS, stopHook } from '../kit/hooks/job-check.ts';
import { bashLines, failedTests, logPath, note, tripwireRefusals } from '../kit/hooks/retro-log.ts';

const HOOKS = join(import.meta.dirname, '..', 'kit', 'hooks');
const running = { id: 'b1', type: 'shell', status: 'running', description: 'Run the test suite', command: 'node --test' };
const stop = (over: object = {}) => ({ hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1', cwd: '/tmp', background_tasks: [running], ...over });
const shared = () => mkdtempSync(join(tmpdir(), 'kit-shared-'));
/** Every line of every retro log under a shared folder. */
const logLines = (dir: string) => {
  try {
    return readdirSync(join(dir, 'retro-log'), { recursive: true }).filter((f) => String(f).endsWith('.md')).flatMap((f) => readFileSync(join(dir, 'retro-log', String(f)), 'utf8').split('\n').filter((l) => l.startsWith('- ')));
  } catch {
    return [];
  }
};

test('hooks.json is valid and every script it names exists in kit/hooks', () => {
  const { hooks } = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));
  const commands = Object.values(hooks).flat().flatMap((m: any) => m.hooks.map((h: any) => h.command));
  for (const c of commands) {
    const file = c.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([\w.-]+)/)?.[1];
    assert.ok(file && readdirSync(HOOKS).includes(file), c);
  }
  assert.ok(hooks.Stop[0].hooks.some((h: any) => h.command.includes('job-check.ts')));
});

test('job check: refuses a minion\'s stop while its background job runs, at most twice per prompt', () => {
  assert.match(jobCheck(stop(), 'thread', 0)!, /still running: b1 \(Run the test suite\).*wait inside the turn/);
  assert.equal(jobCheck(stop(), 'thread', MAX_STOP_BLOCKS), null);
  assert.equal(jobCheck(stop(), 'coordinator', 0), null, 'the Taskmaster loads the kit too, and is left alone');
  assert.equal(jobCheck(stop({ background_tasks: [{ ...running, status: 'completed' }] }), 'thread', 0), null);
  assert.equal(jobCheck(stop({ background_tasks: undefined }), 'thread', 0), null);

  const dir = mkdtempSync(join(tmpdir(), 'kit-jobs-'));
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared() };
  assert.equal(JSON.parse(stopHook(stop(), env, dir)!).decision, 'block');
  assert.ok(stopHook(stop({ stop_hook_active: true }), env, dir));
  assert.equal(stopHook(stop({ stop_hook_active: true }), env, dir), null, 'a third stop ends the turn');
  assert.ok(stopHook(stop({ prompt_id: 'p2' }), env, dir), 'the next prompt counts afresh');
  assert.equal(logLines(env.COORDINATOR_SHARED_DIR).filter((l) => l.includes('refused stop')).length, 3);
  // Without a prompt id, only a first stop is refused.
  assert.ok(stopHook(stop({ session_id: 's2', prompt_id: undefined }), env, dir));
  assert.equal(stopHook(stop({ session_id: 's2', prompt_id: undefined, stop_hook_active: true }), env, dir), null);
});

test('job check script prints the block for Claude Code, and fails open on bad input', () => {
  const env = { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared(), TMPDIR: mkdtempSync(join(tmpdir(), 'kit-tmp-')) };
  const run = (input: string) => spawnSync(process.execPath, [join(HOOKS, 'job-check.ts')], { input, env, encoding: 'utf8' });
  const ok = run(JSON.stringify(stop({ session_id: 'script' })));
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).decision, 'block');
  const bad = run('not json');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('retro log: counts red tests from node, dotnet and pytest summaries', () => {
  assert.equal(failedTests('ℹ tests 600\nℹ pass 598\nℹ fail 2\n'), 2);
  assert.equal(failedTests('# fail 1'), 1);
  assert.equal(failedTests('ℹ fail 0'), 0);
  assert.equal(failedTests('Failed!  - Failed:     3, Passed:    10'), 3);
  assert.equal(failedTests('=== 4 failed, 10 passed in 2.1s ==='), 4);
  assert.equal(failedTests('all green'), 0);
});

test('retro log: a red test or a failed push earns a line; a green run, a background run or a good push none', () => {
  const failure = (command: string, error: string) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error });
  assert.deepEqual(bashLines(failure('node --test test/', 'Exit code 1\nℹ fail 2')), [['red test', '2 failed: node --test test/']]);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'npm test | tail' }, tool_response: { stdout: 'ℹ fail 1', stderr: '' } })[0][0], 'red test');
  assert.deepEqual(bashLines(failure('git push origin ticket/1', 'Exit code 1\n! [rejected] (non-fast-forward)'))[0], ['failed push', 'git push origin ticket/1: Exit code 1 ! [rejected] (non-fast-forward)']);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'git push' }, tool_response: { stdout: '', stderr: 'ok' } }), []);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'node --test' }, tool_response: { stdout: 'ℹ fail 0' } }), []);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'node --test', run_in_background: true }, tool_response: { stdout: 'ℹ fail 3' } }), []);
});

test('retro log: reads this prompt\'s tripwire refusals from the transcript', () => {
  const refusal = (promptId: string, id: string) => JSON.stringify({ type: 'user', promptId, message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: id, content: `PreToolUse:Bash hook error: ['/usr/bin/node' '/x/tripwire.ts' '{"home":"/h"}']: [tripwire] ~/claude-coordinator is the live checkout.\n[tripwire] This guard stops known accidents in Citadel.\n` }] } });
  const transcript = [refusal('p0', 't0'), refusal('p1', 't1'), JSON.stringify({ type: 'user', promptId: 'p1', message: { content: 'mentions [tripwire] PreToolUse: in prose' } }), 'not json [tripwire] PreToolUse:'].join('\n');
  assert.deepEqual(tripwireRefusals(transcript, 'p1'), [['t1', 'Bash', '~/claude-coordinator is the live checkout.']]);
  assert.equal(tripwireRefusals(transcript).length, 2, 'a subagent\'s transcript is read whole');
});

test('retro log script: writes each line once, under the shared folder\'s retro-log/<date>/<session>.md', () => {
  const dir = shared();
  const transcript = join(mkdtempSync(join(tmpdir(), 'kit-tr-')), 't.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', promptId: 'p1', message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: 'u1', content: 'PreToolUse:Write hook error: [x]: [tripwire] Write of /x is blocked.\n' }] } }));
  const env = { ...process.env, COORDINATOR_SHARED_DIR: dir, TMPDIR: mkdtempSync(join(tmpdir(), 'kit-tmp-')) };
  const run = (input: object) => spawnSync(process.execPath, [join(HOOKS, 'retro-log.ts')], { input: JSON.stringify(input), env, encoding: 'utf8' });
  const end = { hook_event_name: 'Stop', session_id: 'sess', prompt_id: 'p1', transcript_path: transcript, cwd: tmpdir() };
  assert.equal(run(end).status, 0);
  assert.equal(run({ ...end, stop_hook_active: true }).status, 0, 'a refused stop fires Stop again');
  run({ hook_event_name: 'PostToolUseFailure', session_id: 'sess', tool_name: 'Bash', tool_input: { command: 'node --test' }, error: 'ℹ fail 1' });
  const path = logPath(dir, 'sess', new Date());
  const log = readFileSync(path, 'utf8');
  assert.match(log, /^# Retro log: sess\n/);
  assert.deepEqual(logLines(dir).map((l) => l.replace(/^- \S+ · /, '')), ['tripwire refusal · Write: Write of /x is blocked.', 'red test · 1 failed: node --test']);
  // No shared folder (a run outside Citadel): nothing written, nothing thrown.
  note({ session_id: 'x' }, 'red test', '1', {});
});

test('after-compact prints the branch and the working tree from the session\'s folder', () => {
  const out = spawnSync('bash', [join(HOOKS, 'after-compact.sh')], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^\[after-compact\] This conversation was just compacted/);
  assert.match(out.stdout, /\nBranch: /);
});
