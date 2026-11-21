// tools/fix-replay.ts (#1291): which subjects count as fixes, which files are tests, and `run` refusing outside CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FIX_RE, isRunnableTest, isTest, ticketOf, verdict } from '../tools/fix-replay.ts';

test('fix subjects match on whole words, so "change" is not a hang', () => {
  for (const s of ['#12: fix the rail', 'Review fixes (#545)', 'land hangs on a stale lock', '#9: flaky wait', '#3: self-review findings'])
    assert.ok(FIX_RE.test(s), s);
  for (const s of ['#12: change the rail', '#4: prefix ids', '#5: add a hangar page']) assert.ok(!FIX_RE.test(s), s);
});

test('tests, runnable tests and the ticket number', () => {
  assert.ok(isTest('test/fixtures/a.json') && isTest('kit/x.test.ts') && !isTest('src/db.ts'));
  assert.ok(isRunnableTest('test/db.test.ts') && !isRunnableTest('test/fixtures/x.test.ts') && !isRunnableTest('test/helpers.ts'));
  assert.equal(ticketOf('#1291: fix-replay (#1265)'), '1291');
  assert.equal(ticketOf('no number'), null);
});

test('run refuses outside GitHub Actions, so no replay runs tests here', () => {
  const env = { ...process.env, GITHUB_ACTIONS: '', FIX_REPLAY_DRY: '' };
  const r = spawnSync(process.execPath, ['tools/fix-replay.ts', 'run', 'nothing.json'], { encoding: 'utf8', env });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /run only on CI/);
});

test('a verdict needs a failing test with the fix undone and a passing run without it', () => {
  const ok = { code: 0, pass: 3, fail: 0 }, failed = { code: 1, pass: 2, fail: 1 };
  assert.equal(verdict(ok), 'green');
  assert.equal(verdict({ code: 0, pass: 0, fail: 0 }), 'skipped');
  assert.equal(verdict(failed), 'needs-clean');
  assert.equal(verdict(failed, ok), 'red');
  assert.equal(verdict(failed, failed), 'red-both');
  assert.equal(verdict(failed, { code: 0, pass: 0, fail: 0 }), 'red-both', 'a clean run where nothing ran proves nothing');
  assert.equal(verdict({ code: 124, pass: 1, fail: 0 }, ok), 'red', 'the 5-min cut: a hang that came back');
  assert.equal(verdict({ code: 1, pass: 0, fail: 0 }), 'error', 'a runner that died with nothing failing');
  assert.equal(verdict({ code: null, pass: 0, fail: 0 }), 'error', 'killed by a signal');
});

test('plan refuses a batch size that would never end', () => {
  const r = spawnSync(process.execPath, ['tools/fix-replay.ts', 'plan', '--batch', '0', '--spec', '/nonexistent'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--batch must be a whole number above 0/);
});
