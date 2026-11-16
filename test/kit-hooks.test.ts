import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobCheck, MAX_STOP_BLOCKS, stopHook } from '../kit/hooks/job-check.ts';
import { bashLines, failedTests, logPath, note, refusals } from '../kit/hooks/retro-log.ts';

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
  assert.match(jobCheck(stop(), 'thread', 0)!, /still running.*b1 \(Run the test suite\), a Bash job/s);
  assert.match(jobCheck(stop(), 'thread', 0)!, /`citadel-wait pid <pid>`/, 'names a wait Claude Code lets through (#481)');
  assert.match(jobCheck(stop({ background_tasks: [{ ...running, pid: 4242 }] }), 'thread', 0)!, /`citadel-wait pid 4242`/, 'the pid when the task has it');
  const grunt = { id: 'a7', type: 'agent', status: 'running', description: 'Review the diff' };
  const both = jobCheck(stop({ background_tasks: [running, grunt] }), 'thread', 0)!;
  assert.match(both, /a7 \(Review the diff\), a Grunt: wait for its result with SendMessage to a7, or stop it with TaskStop a7/, 'a Grunt gets its own way out');
  assert.match(both, /b1 .*`citadel-wait pid <pid>`/s, 'each job lists its own action');
  assert.match(both, /`run_in_background: false`/);
  assert.equal(jobCheck(stop(), 'thread', MAX_STOP_BLOCKS), null);
  assert.equal(jobCheck(stop(), 'coordinator', 0), null, 'the Taskmaster loads the kit too, and is left alone');
  assert.equal(jobCheck(stop({ background_tasks: [{ ...running, status: 'completed' }] }), 'thread', 0), null);
  assert.equal(jobCheck(stop({ background_tasks: undefined }), 'thread', 0), null);
  // #359: claude -p waits for a workflow run itself, and no blocking command could; a shell job beside it still counts.
  const workflow = { id: 'w1', type: 'workflow', status: 'running', name: 'survey' };
  assert.equal(jobCheck(stop({ background_tasks: [workflow] }), 'thread', 0), null);
  assert.match(jobCheck(stop({ background_tasks: [workflow, running] }), 'thread', 0)!, /b1 \(Run the test suite\), a Bash job/);

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

test('retro log: counts red tests from each runner\'s own summary line', () => {
  assert.equal(failedTests('ℹ tests 600\nℹ pass 598\nℹ fail 2\n'), 2);
  assert.equal(failedTests('# fail 1'), 1);
  assert.equal(failedTests('ℹ fail 0'), 0);
  assert.equal(failedTests('Failed!  - Failed:     3, Passed:    10', ['dotnet']), 3);
  assert.equal(failedTests('Failed!  - Failed:     1, Passed: 4\nFailed!  - Failed:     2, Passed: 9', ['dotnet']), 3, 'one line per test project');
  assert.equal(failedTests('Failed!  - Failed:     1, Passed: 4\nTest summary: total: 15, failed: 3, succeeded: 12', ['dotnet']), 3, 'the overall summary wins');
  assert.equal(failedTests('=== 4 failed, 10 passed in 2.1s ===', ['pytest']), 4);
  assert.equal(failedTests('2 failed, 1 passed, 1 warning in 0.12s', ['pytest']), 2);
  assert.equal(failedTests('Tests:       2 failed, 10 passed, 12 total', ['jest']), 2);
  assert.equal(failedTests(' Tests  5 failed | 10 passed (15)', ['jest']), 5, 'vitest');
  assert.equal(failedTests('test result: FAILED. 10 passed; 2 failed; 0 ignored\ntest result: FAILED. 1 passed; 1 failed;', ['cargo']), 3);
  assert.equal(failedTests('--- FAIL: TestA (0.00s)\n    --- FAIL: TestA/sub (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL', ['go']), 2, 'top-level tests only');
  assert.equal(failedTests('  3 failing', ['mocha']), 3);
  assert.equal(failedTests('all green'), 0);
  assert.equal(failedTests('the PR says 3 failed before the fix'), 0, 'prose is not a summary');
});

test('retro log: only a test runner in the command counts, and the line names that command', () => {
  const ran = (command: string, stdout: string) => bashLines({ hook_event_name: 'PostToolUse', tool_input: { command }, tool_response: { stdout, stderr: '' } });
  const failure = (command: string, error: string) => bashLines({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error });
  // Delve #5's log, 2026-11-02: a cat of two PR descriptions that say "failed".
  assert.deepEqual(ran('cd /p/tmp/37/prs && cat 219.md 207.md', '## Fix\nBefore this, 1 failed on CI.\nFailed: 2 runs'), []);
  // Reading the retro log fed its own "N failed" lines back into it.
  const logText = '- 05:32:17Z · red test · 4 failed: dotnet test tests/X\n- 05:51:24Z · red test · 1 failed: npm test\nℹ fail 2\n';
  assert.deepEqual(ran("cd /p/shared/project/retro-log && ls 2026-11-0*/ | head; grep -l 'auniv6\\|b7-final\\|b7-' */*.md 2>/dev/null | head", logText), []);
  assert.deepEqual(ran("cd /p/shared/project/retro-log && grep '^- ' 2026-11-02/b388.md | cut -c1-230", logText), []);
  assert.deepEqual(ran('D=/p/shared/project/retro-log; for f in $D/2026-11-01/s.md; do node --test x; cat $f; done', logText), [], 'never log a command that reads the retro log');
  // A heredoc edit whose script prints "failed" is not a test run, even if the heredoc body names one.
  const edit = "cd /p/b7-seams && python3 - <<'EOF'\np='tests/SeamTests.cs'\ns=open(p).read()\n# then: dotnet test tests/X\nprint('2 failed asserts rewritten')\nEOF";
  assert.deepEqual(ran(edit, '2 failed asserts rewritten\nFailed!  - Failed:     2, Passed: 1'), []);
  // An edit chained with a real, red test run: the line names the test command, not the edit.
  const dotnet = 'Failed!  - Failed:     2, Passed:    40, Skipped:     0, Total:    42';
  assert.deepEqual(ran(`${edit}\ndotnet test tests/Delve.Sim.Tests --no-build --filter "A|B" 2>&1 | tail -5`, dotnet), [['red test', '2 failed: dotnet test tests/Delve.Sim.Tests --no-build --filter "A|B" 2>&1']]);
  assert.deepEqual(ran("cd /p && python3 - <<'E' && dotnet test x.sln\nprint(1)\nE", dotnet), [['red test', '2 failed: dotnet test x.sln']]);
  // A runner named inside quotes is an argument, not a run.
  assert.deepEqual(ran("grep -n 'npm test; dotnet test' notes.md", 'ℹ fail 4\n' + dotnet), []);
  assert.deepEqual(ran('git commit -m "pytest: 3 failed before"', '=== 3 failed in 1.0s ==='), []);
  // Runners and wrappers it recognises.
  assert.deepEqual(failure('cd /w && npm test 2>&1 | tail -20', 'Exit code 1\nℹ fail 1'), [['red test', '1 failed: npm test 2>&1']]);
  assert.deepEqual(ran('FOO=1 timeout 300 node --test test/a.test.ts', 'ℹ fail 3'), [['red test', '3 failed: FOO=1 timeout 300 node --test test/a.test.ts']]);
  assert.deepEqual(ran('python3 -m pytest -q tests/', '2 failed, 1 passed in 0.12s'), [['red test', '2 failed: python3 -m pytest -q tests/']]);
  assert.deepEqual(ran('cargo test --all', 'test result: FAILED. 1 passed; 1 failed;'), [['red test', '1 failed: cargo test --all']]);
  assert.deepEqual(ran('go test ./...', '--- FAIL: TestA (0.00s)\nFAIL'), [['red test', '1 failed: go test ./...']]);
  assert.deepEqual(ran('npx vitest run', ' Tests  5 failed | 10 passed (15)'), [['red test', '5 failed: npx vitest run']]);
  assert.deepEqual(ran('bash tools/check.sh && tools/land.sh', 'ℹ fail 1'), [['red test', '1 failed: bash tools/check.sh; tools/land.sh']]);
  assert.deepEqual(ran('dotnet test a && dotnet test b', 'Failed!  - Failed:     1, Passed: 1\nFailed!  - Failed:     1, Passed: 1'), [['red test', '2 failed: dotnet test a; dotnet test b']]);
  assert.deepEqual(ran('tools/citadel-node --test test/a.test.ts', 'ℹ fail 2'), [['red test', '2 failed: tools/citadel-node --test test/a.test.ts']], 'node under its renamed link (#506)');
  assert.deepEqual(ran('node --test test/retro-log.test.ts', 'ℹ fail 1'), [['red test', '1 failed: node --test test/retro-log.test.ts']], 'a file named retro-log is not the log');
  assert.deepEqual(ran('if npm test; then echo ok; fi', 'ℹ fail 2'), [['red test', '2 failed: if npm test']]);
  assert.deepEqual(ran('timeout -k 5 300 npm --prefix web test', 'ℹ fail 2'), [['red test', '2 failed: timeout -k 5 300 npm --prefix web test']]);
  assert.deepEqual(ran('pnpm --filter app test', 'ℹ fail 1')[0][0], 'red test');
  assert.deepEqual(ran('echo $((1<<2))\nnpm test', 'ℹ fail 1'), [['red test', '1 failed: npm test']], 'a shift is not a heredoc');
  assert.deepEqual(ran('node scripts/latest.js', 'ℹ fail 2'), [], 'a name that merely contains "test"');
  assert.deepEqual(ran('npm install test-utils', 'ℹ fail 2'), []);
  assert.deepEqual(ran('python3 tools/run-tests.py', 'ℹ fail 2')[0][0], 'red test');
  // A runner's own summary only: dotnet's count never comes from a pytest-style line.
  assert.deepEqual(ran('dotnet test', 'Some prose: 3 failed earlier'), []);
});

test('retro log: a red test or a failed push earns a line; a green run, a background run or a good push none', () => {
  const failure = (command: string, error: string) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error });
  assert.deepEqual(bashLines(failure('node --test test/', 'Exit code 1\nℹ fail 2')), [['red test', '2 failed: node --test test/']]);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'npm test | tail' }, tool_response: { stdout: 'ℹ fail 1', stderr: '' } })[0][0], 'red test');
  assert.deepEqual(bashLines(failure('git push origin ticket/1', 'Exit code 1\n! [rejected] (non-fast-forward)'))[0], ['failed push', 'git push origin ticket/1: Exit code 1 ! [rejected] (non-fast-forward)']);
  assert.equal(bashLines(failure('git -C ../x push -u origin b', 'Exit code 128'))[0][0], 'failed push');
  assert.deepEqual(bashLines(failure('git commit -m "fix push race"', 'Exit code 1\nhook failed')), [], 'not a push');
  // #468 S08-7: a push named only inside quotes, or one a red test stopped before it ran.
  assert.deepEqual(bashLines(failure('git commit -m "fix git push hook"', 'Exit code 1\nhook failed')), [], 'a push in a message');
  assert.deepEqual(bashLines(failure('npm test && git push', 'Exit code 1\nℹ fail 2')), [['red test', '2 failed: npm test']], 'the tests failed, so no push ran');
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'git push' }, tool_response: { stdout: '', stderr: 'ok' } }), []);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'node --test' }, tool_response: { stdout: 'ℹ fail 0' } }), []);
  assert.deepEqual(bashLines({ hook_event_name: 'PostToolUse', tool_input: { command: 'node --test', run_in_background: true }, tool_response: { stdout: 'ℹ fail 3' } }), []);
});

test('retro log: reads this prompt\'s tripwire and guard refusals from the transcript', () => {
  const refusal = (promptId: string, id: string) => JSON.stringify({ type: 'user', promptId, message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: id, content: `PreToolUse:Bash hook error: ['/usr/bin/node' '/x/tripwire.ts' '{"home":"/h"}']: [tripwire] ~/claude-coordinator is the live checkout.\n[tripwire] This guard stops known accidents in Citadel.\n` }] } });
  const guard = JSON.stringify({ type: 'user', promptId: 'p1', message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: 'g1', content: [{ type: 'text', text: 'PreToolUse:Bash hook error: ["$CLAUDE_PROJECT_DIR"/tools/guard.sh --hook bash]: [guard] Push to main refused.\n[guard] main only changes through a merged pull request.\n' }] }] } });
  const transcript = [refusal('p0', 't0'), refusal('p1', 't1'), guard, JSON.stringify({ type: 'user', promptId: 'p1', message: { content: 'mentions [tripwire] PreToolUse: in prose' } }), 'not json [tripwire] PreToolUse:'].join('\n');
  assert.deepEqual(refusals(transcript, 'p1'), [['t1', 'tripwire', 'Bash', '~/claude-coordinator is the live checkout.'], ['g1', 'guard', 'Bash', 'Push to main refused.']]);
  assert.equal(refusals(transcript).length, 3, 'a subagent\'s transcript is read whole');
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
