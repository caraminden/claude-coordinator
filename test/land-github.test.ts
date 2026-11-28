// A ship's run on GitHub's runners and its desktop fallback (#2209, ADR 0043), beside the land tests' parts (#2208).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, setup, ci, write } from './land-fixture.ts';
import { landLog, ciDown, asleep } from './land-setup.ts';

// #2209 (Cara, 2026-11-27: "github should actually be the main CI? with my desktop as the fallback"): main's tests.yml
// with the shard job sends a ship's run to GitHub's runners; the desktop takes it when GitHub can't, with no person.
const onGitHub = (r: ReturnType<typeof setup>) => write(r.source, { '.github/workflows/tests.yml': 'jobs:\n  shard:\n' }, 'shards');

test("a ship's run on GitHub needs no desktop runner online, and lands on its green", () => {
  const r = setup();
  const c = ci(r);
  onGitHub(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_RUNNERS: '0', LAND_CI_GH_START: '0', FAKE_CI_SLOW: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the full suite on GitHub's runners, 20 ways .*CI passed on \w+ in \d+s \(https:\/\/ci\/7\)/s);
  assert.doesNotMatch(c.calls(), /dispatches|cancel/);
  assert.equal(c.localRuns(), 0);
  // #2210: before its push the landing marks itself (pre-yield.<its pid>), so Citadel's pre-ship runs give it GitHub's slots.
  assert.equal(readdirSync(join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy')).filter((f) => /^pre-yield\.\d+$/.test(f)).length, 1);
});

test("a ship's run on GitHub with shards not started, or failed before any test, goes to the desktop and lands on its run", () => {
  for (const [extra, why] of [
    [{ FAKE_CI: 'queued', FAKE_GH_JOBS: '0 20 5' }, /GitHub started only 15 of 20 shards within 0s \(its slots are taken, or it is having trouble\), so the run goes to Cara's desktop instead/],
    [{ FAKE_CI: 'red', FAKE_STEP: 'the tools the tests need' }, /GitHub's run failed in its step "the tools the tests need", before its tests ran \(https:\/\/ci\/7\), so the run goes to Cara's desktop/],
    // A shard red in its tests beside one that never ran them: the run's verdict is the desktop's.
    [{ FAKE_CI: 'red', FAKE_STEP: 'the full suite\tthe tools the tests need' }, /failed in its step "the tools the tests need", before its tests ran/],
    [{ FAKE_CI: 'queued', FAKE_LAG: '1' }, /GitHub listed no run within 0s, so the run goes to Cara's desktop/],
    [{ FAKE_CI: 'queued', FAKE_GH_JOBS: 'down' }, /GitHub didn't say whether the run's shards had started \(3 asks\)/],
    [{ FAKE_CI: 'running', LAND_CI_TIMEOUT: '0', LAND_CI_GH_START: '600' }, /CI didn't finish within 0s of starting, so the run goes to Cara's desktop/],
    [{ FAKE_CI: 'cancelled', FAKE_STEP: '-' }, /GitHub's run ended as cancelled, with no failed step, so the run goes to Cara's desktop/],
  ] as const) {
    const r = setup();
    const c = ci(r);
    onGitHub(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    const res = c.run({ FAKE_CI_RERUN: 'green', LAND_CI_GH_START: '0', COORDINATOR_SHARED_DIR: shared, ...extra });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, why);
    assert.match(res.stderr, /CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/);
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    assert.match(c.calls(), /dispatches -f ref=land\/ticket\/1-x -f inputs\[where\]=desktop/);
    assert.equal(/runs\/7\/cancel/.test(c.calls()), !('FAKE_LAG' in extra) && extra.FAKE_CI !== 'red' && extra.FAKE_CI !== 'cancelled', 'only a listed run still going is cancelled');
    assert.match(landLog(shared), /· ci to desktop · ticket\/1-x · /);
    assert.equal(c.localRuns(), 0);
  }
});

test('a red on GitHub in the full suite is a verdict: refused, and the desktop is not asked', () => {
  const r = setup();
  const c = ci(r);
  onGitHub(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /test\/real\.test\.ts/);
  assert.doesNotMatch(c.calls(), /dispatches/);
});

test('GitHub broken with no desktop runner online: the suite runs here, loudly, and the next ship asks GitHub again', () => {
  const r = setup();
  const c = ci(r);
  onGitHub(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: 'the tools the tests need', FAKE_RUNNERS: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: GitHub's run failed in its step "the tools the tests need", before its tests ran \(https:\/\/ci\/7\), and no citadel-ci-linux runner is registered/);
  assert.doesNotMatch(c.calls(), /dispatches/);
  assert.equal(c.localRuns(), 1);
  assert.ok(!existsSync(ciDown(r)), 'no note that skips CI for the next ships');
});

// #2299: the desktop's runners asleep under Citadel's runner plan (offline on GitHub) can still take the run: it goes there,
// and the plan wakes one for the queued job, rather than the suite running on perigee.
test("GitHub broken with the desktop's runners asleep: the run goes to the desktop for Citadel's plan to wake one (#2299)", () => {
  const r = setup();
  const c = ci(r);
  onGitHub(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: 'the tools the tests need', FAKE_CI_RERUN: 'green', FAKE_RUNNERS_FILE: asleep(r.dir, 3) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /before its tests ran \(https:\/\/ci\/7\), so the run goes to Cara's desktop instead \(asleep: the job wakes one\)/);
  assert.match(res.stderr, /CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/);
  assert.match(c.calls(), /dispatches -f ref=land\/ticket\/1-x -f inputs\[where\]=desktop/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
});

test('shards slow to start with no desktop runner online: the ship keeps waiting on GitHub and lands on its run', () => {
  const r = setup();
  const c = ci(r);
  onGitHub(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI_SLOW: '1', FAKE_GH_JOBS: '0 20 5', FAKE_RUNNERS: '0', LAND_CI_GH_START: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /GitHub started only 15 of 20 shards within 0s .*, and no citadel-ci-linux runner is online, so this keeps waiting on GitHub's run \(https:\/\/ci\/7\).*CI passed on \w+ in \d+s \(https:\/\/ci\/7\)/s);
  assert.doesNotMatch(c.calls(), /dispatches|cancel/);
  assert.equal(c.localRuns(), 0);
});
