// tools/fix-replay.ts (#1291): which subjects count as fixes, which files are tests, and `run` refusing outside CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FIX_RE, isRunnableTest, isTest, ticketOf } from '../tools/fix-replay.ts';

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
