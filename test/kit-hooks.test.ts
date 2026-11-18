import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobCheck, MAX_STOP_BLOCKS, stopHook } from '../kit/hooks/job-check.ts';
import { bashLines, failedTests, logPath, note, refusals } from '../kit/hooks/retro-log.ts';
import { isSourceFile, REMINDER, testFirstHook } from '../kit/hooks/test-first.ts';
import { bigReadHook } from '../kit/hooks/big-read.ts';
import { gruntModelHook, jobTable } from '../kit/hooks/grunt-model.ts';

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
  assert.match(both, /`citadel-wait cmd '<test>'`/, 'a Bash job without a pid keeps the other waits');
  const other = jobCheck(stop({ background_tasks: [{ id: 'm1', type: 'monitor', status: 'running', description: 'watch' }] }), 'thread', 0)!;
  assert.match(other, /m1 \(watch\), a Bash job.*TaskStop m1/s, 'an unknown type is not told to SendMessage');
  assert.match(jobCheck(stop({ background_tasks: [{ ...grunt, type: 'local_agent' }] }), 'thread', 0)!, /a Grunt: wait for its result with SendMessage/);
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

test('test-first reminder: once per session on the first source edit, quiet after a red run, never for tests, docs, config or UI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-test-first-'));
  const edit = (file: string, session = 's1') => testFirstHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: session, cwd: '/w', tool_input: { file_path: file } }, dir);
  const bash = (command: string, session: string, over: object = {}) => testFirstHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: session, cwd: '/w', tool_input: { command }, tool_response: { stdout: '', stderr: '' }, ...over }, dir);
  for (const f of ['/w/test/a.test.ts', '/w/src/a.test.ts', '/w/crates/x/tests/busy.rs', '/w/ingest/tests/test_x.py', '/w/README.md', '/w/docs/adr/1.md', '/w/package.json', '/w/vite.config.ts', '/w/public/app.js', '/w/web/page.tsx', '/w/src/style.css', '/w/kit/skills/x/SKILL.md', '/tmp/scratch.ts', '/w/../other/src/a.ts']) {
    assert.equal(edit(f, 'quiet'), null, f);
  }
  // A first source edit, after those: the reminder, as context, once.
  const out = JSON.parse(edit('/w/src/runner.ts', 'quiet')!);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: REMINDER } });
  assert.equal(edit('/w/src/other.ts', 'quiet'), null, 'quiet the second time');
  // A red run first keeps it quiet: a failed exit (citadel-test, cargo test) or a failure count in the output.
  bash('citadel-test test/a.test.ts', 'red1', { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' });
  assert.equal(edit('/w/src/a.ts', 'red1'), null);
  bash('npm test 2>&1 | tail -5', 'red2', { tool_response: { stdout: '# fail 2\n' } });
  assert.equal(edit('/w/src/a.rs', 'red2'), null);
  bash('cd app && cargo test -p core', 'red3', { hook_event_name: 'PostToolUseFailure', error: 'test result: FAILED. 3 passed; 1 failed;' });
  assert.equal(edit('/w/src/lib.rs', 'red3'), null);
  // A green run, a failing command that isn't a test, or a test run left in the background: still reminds.
  bash('citadel-test test/a.test.ts', 'green', { tool_response: { stdout: '✔ 4 passed, 0 failed in 1.2 s' } });
  bash('grep -n foo src/a.ts', 'green', { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' });
  bash('cargo test', 'green', { hook_event_name: 'PostToolUseFailure', tool_input: { command: 'cargo test', run_in_background: true } });
  assert.ok(edit('/w/tools/land.sh', 'green'));
  assert.ok(isSourceFile('src/db.ts') && isSourceFile('crates/core/src/lib.rs') && isSourceFile('ingest/load.py'));
  // The script itself prints the reminder and nothing on a broken input.
  const run = (input: string) => spawnSync(process.execPath, [join(HOOKS, 'test-first.ts')], { input, env: { ...process.env, TMPDIR: dir }, encoding: 'utf8' });
  assert.match(run(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'cli', cwd: '/w', tool_input: { file_path: 'src/x.ts' } })).stdout, /test-first/);
  assert.equal(run('not json').stdout, '');
});

test('big-read guard: sends back whole reads and plain cat/sed of big files, lets small, ranged, unclear and allow_large through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-big-read-'));
  writeFileSync(join(dir, 'big.ts'), Array.from({ length: 900 }, (_, i) => `const line${i} = ${i};`).join('\n'));
  writeFileSync(join(dir, 'wide.css'), Array.from({ length: 200 }, () => 'x'.repeat(200)).join('\n')); // 200 lines, 40k chars
  writeFileSync(join(dir, 'small.ts'), Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join('\n'));
  writeFileSync(join(dir, 'pic.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.alloc(60_000, 1)]));
  const read = (tool_input: object) => bigReadHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: dir, tool_input });
  const bash = (command: string) => bigReadHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command } });
  const denied = (out: string | null, what: string) => {
    assert.ok(out, what);
    const h = JSON.parse(out).hookSpecificOutput;
    assert.equal(h.hookEventName, 'PreToolUse');
    assert.equal(h.permissionDecision, 'deny', what);
    return h.permissionDecisionReason as string;
  };
  // A whole read of a big file, by lines or by chars: sent back, naming the size and the cheaper way.
  const why = denied(read({ file_path: join(dir, 'big.ts') }), 'whole read, 900 lines');
  assert.match(why, /900 lines/);
  assert.match(why, /grep -n/);
  assert.match(why, /offset\/limit/);
  assert.match(why, /allow_large: true/);
  denied(read({ file_path: join(dir, 'wide.css') }), 'whole read, 40k chars');
  denied(read({ file_path: join(dir, 'big.ts'), offset: 100 }), 'offset with no limit still reads 800 lines');
  // Let through: a small file, a ranged read, allow_large, a short tail from an offset, binaries and missing paths.
  for (const input of [{ file_path: join(dir, 'small.ts') }, { file_path: join(dir, 'big.ts'), offset: 1, limit: 200 }, { file_path: join(dir, 'big.ts'), limit: 800 }, { file_path: join(dir, 'big.ts'), allow_large: true }, { file_path: join(dir, 'big.ts'), offset: 700 }, { file_path: join(dir, 'pic.png') }, { file_path: join(dir, 'nope.ts') }, { file_path: dir }]) {
    assert.equal(read(input), null, JSON.stringify(input));
  }
  // Bash: a plain cat or sed -n range over the bar is sent back, naming the cheaper way.
  assert.match(denied(bash('cat big.ts'), 'cat'), /sed -n|offset\/limit/);
  denied(bash(`cat -n "${join(dir, 'wide.css')}"`), 'cat -n, quoted absolute path');
  denied(bash("git status; cat big.ts && echo done"), 'cat between other commands');
  denied(bash("sed -n '1,800p' big.ts"), 'sed range of 800 lines');
  denied(bash("sed -n '50,$p' big.ts"), 'sed to the end');
  assert.match(denied(bash('cat small.ts big.ts'), 'two files'), /# allow_large/);
  // Let through: small files and ranges, pipes, redirects, expansions, a cd first, other commands, and the marker.
  for (const c of ['cat small.ts', "sed -n '1,200p' big.ts", "sed -n '100,300p;400,500p' big.ts", 'cat big.ts | grep line1', 'cat big.ts > copy.ts', 'cat $F', 'cat *.ts', 'cd sub && cat big.ts', 'cat big.ts # allow_large', "sed -i 's/a/b/' big.ts", 'head -n 900 big.ts', 'cat nope.ts', 'cat pic.png', "echo 'cat big.ts'", 'grep -n line big.ts']) {
    assert.equal(bash(c), null, c);
  }
  // Other tools pass, and the script prints the deny for Claude Code and nothing on a broken input.
  assert.equal(bigReadHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dir, tool_input: { file_path: join(dir, 'big.ts') } }), null);
  const run = (input: string) => spawnSync(process.execPath, [join(HOOKS, 'big-read.ts')], { input, encoding: 'utf8' });
  assert.match(run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: dir, tool_input: { file_path: 'big.ts' } })).stdout, /"deny"/);
  assert.equal(run('not json').stdout, '');
  // Wired for Read and Bash before they run.
  const { hooks } = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));
  const pre = (tool: string) => hooks.PreToolUse.some((m: any) => new RegExp(m.matcher).test(tool) && m.hooks.some((h: any) => h.command.includes('big-read.ts')));
  assert.ok(pre('Read') && pre('Bash'));
});

test('grunt-model guard: sends back an Agent call with no deliberate model or effort, lets pinned ones and forks through', () => {
  const repo = mkdtempSync(join(tmpdir(), 'kit-grunt-model-'));
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'agents', 'pinned.md'), '---\nname: pinned\ndescription: x\nmodel: sonnet\neffort: low\n---\nBody\n');
  writeFileSync(join(repo, '.claude', 'agents', 'half.md'), '---\nname: half\ndescription: x\neffort: high\n---\nBody\n');
  writeFileSync(join(repo, '.claude', 'agents', 'inherits.md'), '---\nname: inherits\ndescription: x\nmodel: inherit\neffort: medium\n---\n');
  writeFileSync(join(repo, '.claude', 'agents', 'renamed-file.md'), '---\nname: other-name\ndescription: x\nmodel: opus\neffort: high\n---\n');
  const call = (tool_input: object, tool_name = 'Agent') => gruntModelHook({ hook_event_name: 'PreToolUse', tool_name, cwd: repo, tool_input: { description: 'd', prompt: 'p', ...tool_input } });
  const denied = (out: string | null) => out && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';
  const reason = (out: string | null) => JSON.parse(out!).hookSpecificOutput.permissionDecisionReason as string;

  // A bare call (general-purpose by default) and built-ins with half a choice are sent back, pointing at the table.
  for (const ti of [{}, { subagent_type: 'general-purpose' }, { subagent_type: 'Explore', model: 'sonnet' }, { subagent_type: 'Plan', effort: 'high' }]) assert.ok(denied(call(ti)), JSON.stringify(ti));
  const bare = reason(call({}));
  assert.match(bare, /citadel:subagents/);
  assert.match(bare, /Known-shape worker.*sonnet.*medium/, 'quotes the table rows');
  assert.match(reason(call({ subagent_type: 'Explore' })), /Row for Explore: .*sonnet, low/, 'names the row when the agent type has one');
  assert.match(reason(call({ subagent_type: 'Explore', model: 'sonnet' })), /no effort/);
  // Both on the call, a definition that pins both, or a definition plus the missing half on the call go through.
  assert.equal(call({ subagent_type: 'general-purpose', model: 'sonnet', effort: 'medium' }), null);
  assert.equal(call({ model: 'haiku', effort: 'low' }), null);
  assert.equal(call({ subagent_type: 'pinned' }), null);
  assert.equal(call({ subagent_type: 'other-name' }), null, 'found by its name: field, not only its file name');
  assert.ok(denied(call({ subagent_type: 'half' })), 'a definition with effort but no model');
  assert.equal(call({ subagent_type: 'half', model: 'opus' }), null);
  assert.ok(denied(call({ subagent_type: 'inherits' })), 'model: inherit is not a choice');
  assert.equal(call({ subagent_type: 'inherits', model: 'sonnet' }), null);
  // The kit's own agents pin both, so a plain call goes through.
  for (const f of readdirSync(join(HOOKS, '..', 'agents'))) assert.equal(call({ subagent_type: `citadel:${f.replace(/\.md$/, '')}` }), null, f);
  // Forks run on the parent by design; agents it can't read (another plugin's, a missing one) and other tools fail open.
  assert.equal(call({ subagent_type: 'fork' }), null);
  assert.equal(call({ subagent_type: 'someplugin:thing' }), null);
  assert.equal(call({ subagent_type: 'nowhere' }), null);
  assert.equal(gruntModelHook({ tool_name: 'Read', cwd: repo, tool_input: {} }), null);
  // The older tool name is checked too.
  assert.ok(denied(call({}, 'Task')));

  // The script prints the deny for Claude Code and nothing on a broken input; wired for Agent before it runs.
  const run = (input: string) => spawnSync(process.execPath, [join(HOOKS, 'grunt-model.ts')], { input, encoding: 'utf8' });
  assert.match(run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: repo, tool_input: { prompt: 'p' } })).stdout, /"deny"/);
  assert.equal(run('not json').stdout, '');
  const { hooks } = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'));
  assert.ok(hooks.PreToolUse.some((m: any) => new RegExp(m.matcher).test('Agent') && m.hooks.some((h: any) => h.command.includes('grunt-model.ts'))));
});

test('grunt-model table: every kit agent pins model and effort, and its frontmatter matches its row in citadel:subagents', () => {
  const rows = jobTable();
  assert.ok(rows.length >= 10, 'the table parses');
  for (const r of rows) assert.ok(r.job && r.model && r.effort, JSON.stringify(r));
  for (const f of readdirSync(join(HOOKS, '..', 'agents'))) {
    const head = readFileSync(join(HOOKS, '..', 'agents', f), 'utf8').split('\n---')[0];
    const model = head.match(/^model:\s*(\S+)/m)?.[1];
    const effort = head.match(/^effort:\s*(\S+)/m)?.[1];
    assert.ok(model && model !== 'inherit' && effort, `${f} pins model and effort`);
    const name = `citadel:${f.replace(/\.md$/, '')}`;
    const row = rows.find((r) => r.job === `\`${name}\``);
    assert.ok(row, `${name} has its own row`);
    // The critic's row reads "from the rubric"; its frontmatter is only the backstop.
    if (/^(sonnet|opus|haiku|fable)$/.test(row.model)) assert.deepEqual([model, effort], [row.model, row.effort], name);
  }
});
