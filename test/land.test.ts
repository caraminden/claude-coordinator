// tools/land.sh itself: the rebase, its test run or CI gate, conflicts and refusals.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, landAsync, tickets, issued } from './land-fixture.ts';

test('rebases onto main, tests, fast-forwards main, and deploys holding the lock', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.source, 'c.txt', 'someone else\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running the tests/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(git(r.source, 'log', '--format=%s', '-3'), 'b.txt: mine\nc.txt: someone else\nbase');
  assert.ok(existsSync(join(r.source, 'b.txt')), "the scheme repo's checkout moves with main");
  assert.equal(r.note(), 'locked=1 held=yes');
});

test("a rebase that changes land.sh hands over to the rebased copy, which keeps the lock and lands (#500)", () => {
  const r = setup();
  // The worktree runs its own tools/land.sh, as a minion does; main's newer one says it is the one running.
  for (const f of ['land.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real land.sh');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const script = join(r.source, 'tools', 'land.sh');
  writeFileSync(script, readFileSync(script, 'utf8').replace('say "running the tests"', 'say "running the tests (the rebased land.sh)"'));
  git(r.source, 'commit', '-qam', 'newer land.sh');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running the tests \(the rebased land\.sh\)/);
  assert.equal(res.stderr.match(/rebasing/g)?.length, 1, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes', 'the deploy still runs under the lock');
  // The rebased copy kept the first one's ticket in the line (#502), took it out at the end, and its time was noted.
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  assert.deepEqual(tickets(state), []);
  assert.equal(issued(state), 1, 'one ticket for the whole landing');
  assert.match(readFileSync(join(state, 'queue', '.took'), 'utf8'), /^\d+\n$/);
});

// A killed land.sh must not leave its test run holding the deploy lock (ultra review A4).
test("the test run doesn't get the deploy lock's fd 9", () => {
  const r = setup();
  const tools = join(r.dir, 'tools');
  mkdirSync(tools);
  for (const f of ['land.sh', 'deploy-queue.sh']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(tools, f));
  writeFileSync(join(tools, 'run-tests.sh'), '#!/usr/bin/env bash\n[ -e /proc/self/fd/9 ] && echo open >"$FD9_NOTE" || echo closed >"$FD9_NOTE"\n', { mode: 0o755 });
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = spawnSync('bash', [join(tools, 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FD9_NOTE: join(r.dir, 'fd9') } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(r.dir, 'fd9'), 'utf8'), 'closed\n');
  assert.equal(r.note(), 'locked=1 held=yes', 'land.sh itself still holds the lock for the deploy');
});

test('red tests stop it before main moves', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ FAIL_TESTS: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(r.note(), null);
});

// The test run holds the deploy lock, so it must end however a test goes wrong (#377).
test('a red test that leaks a handle ends the run at once instead of holding the lock', () => {
  const r = setup();
  r.commit(r.wt, 'test/ok.test.mjs', "import { test } from 'node:test';\ntest('leaks', () => { setInterval(() => {}, 1000); throw new Error('red'); });\n");
  const main = git(r.source, 'rev-parse', 'main');
  const t = Date.now();
  const res = r.run({ DEPLOY_TEST_TIMEOUT: '60' });
  assert.ok(Date.now() - t < 30_000, `not the whole time limit: ${Date.now() - t} ms`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.doesNotMatch(res.stderr, /ran past/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('a test that hangs is stopped at the time limit, says so, and lets go of the lock', () => {
  const r = setup();
  r.commit(r.wt, 'test/ok.test.mjs', "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ DEPLOY_TEST_TIMEOUT: '2' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the tests ran past 2s and were stopped: a test hung/);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'the deploy lock is free');
});

// The CI gate (#523): GitHub is a bare repo as origin and a stand-in gh. The stand-in knows one run, id 7, of whatever
// commit land/<branch> points at there, in the state FAKE_CI names; FAKE_OLD_RUN is an earlier run, "<sha> <status> <conclusion>",
// which GitHub still answers with for FAKE_LAG polls after the push; FAKE_STEP is the step a red run failed in.
function ci(r: ReturnType<typeof setup>) {
  const hub = join(r.dir, 'hub.git');
  git(r.dir, 'init', '-q', '--bare', hub);
  git(r.source, 'remote', 'add', 'origin', hub);
  const bin = join(r.dir, 'bin');
  mkdirSync(bin);
  const calls = join(r.dir, 'gh-calls');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >>"${calls}"
case "$*" in
  *"/actions/runs?head_sha="*)
    sha=\${2#*head_sha=} sha=\${sha%%&*}
    [ "\${FAKE_CI:-}" != down ] || exit 1
    lag=0
    if [ -n "\${FAKE_LAG:-}" ] && [ "$(grep -c head_sha "${calls}")" -le "\$((FAKE_LAG + 1))" ]; then lag=1; fi
    if [ "$lag" = 0 ] && [ "$(git -C "${hub}" rev-parse -q --verify "refs/heads/land/ticket/1-x" 2>/dev/null)" = "$sha" ]; then
      case \${FAKE_CI:-green} in
        green) printf '7\\tcompleted\\tsuccess\\thttps://ci/7\\n' ;;
        red) printf '7\\tcompleted\\tfailure\\thttps://ci/7\\n' ;;
        cancelled) printf '7\\tcompleted\\tcancelled\\thttps://ci/7\\n' ;;
        queued) printf '7\\tqueued\\t-\\thttps://ci/7\\n' ;;
        running) printf '7\\tin_progress\\t-\\thttps://ci/7\\n' ;;
      esac
    elif [ "\${FAKE_OLD_RUN%% *}" = "$sha" ]; then
      set -- \$FAKE_OLD_RUN; printf '3\\t%s\\t%s\\thttps://ci/3\\n' "$2" "$3"
    fi ;;
  *"/actions/runners "*) [ "\${FAKE_RUNNERS:-1}" != down ] || exit 1; echo "\${FAKE_RUNNERS:-1}" ;;
  *"/actions/runs/7/jobs "*) echo "\${FAKE_STEP:-the full suite}" ;;
  "run view "*) printf 'test\\tthe full suite\\t2026 run-tests: test/slow.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\\n'; echo "not ok 1 - the red test's output" ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const testRuns = join(r.dir, 'test-runs');
  return {
    run: (extra: Record<string, string> = {}) => r.run({ PATH: `${bin}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', TEST_RUNS: testRuns, ...extra }),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    localRuns: () => (existsSync(testRuns) ? readFileSync(testRuns, 'utf8').trim().split('\n').length : 0),
    refs: () => git(hub, 'for-each-ref', '--format=%(refname)'),
  };
}

test('green CI on the exact rebased commit lands it without a test run here, and the scratch branch goes', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.source, 'c.txt', 'someone else\n');
  // A green run of the commit as it was before the rebase is not a run of what lands.
  const res = c.run({ FAKE_OLD_RUN: `${git(r.wt, 'rev-parse', 'HEAD')} completed success` });
  assert.equal(res.status, 0, res.stderr);
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  assert.equal(git(r.source, 'rev-parse', 'main'), tip);
  assert.match(res.stderr, /waiting for CI on .*CI passed on/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|running the tests/);
  assert.equal(c.localRuns(), 0);
  assert.match(c.calls(), new RegExp(`head_sha=${tip}&`), 'it asked about the rebased commit');
  assert.equal(c.refs(), '', 'land/<branch> is deleted again');
  assert.equal(r.note(), 'locked=1 held=yes');
});

test('a run of this very commit that is already green lands at once; one that was red is run again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  let res = c.run({ FAKE_OLD_RUN: `${tip} completed success`, FAKE_RUNNERS: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.doesNotMatch(c.calls(), /runners/, 'no new run was asked for');
  assert.equal(c.localRuns(), 0);

  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  // GitHub takes a moment to list the new run: until then it still answers with the old red one, which is no verdict.
  res = c2.run({ FAKE_OLD_RUN: `${git(r2.wt, 'rev-parse', 'HEAD')} completed failure`, FAKE_LAG: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed on .*ci\/7/);
  assert.equal(c2.localRuns(), 0);
  assert.ok(c2.calls().split('\n').filter((l) => l.includes('head_sha')).length >= 4, 'it polled past the old run');
});

test('red CI refuses with main untouched, shows the failed log, and never falls back to a run here', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(landLog(shared), /· flake · test\/slow\.test\.ts · load 31\.5 · ticket\/1-x · in CI$/m, 'a flake CI labelled reaches the retro log');
  assert.match(res.stderr, /the red test's output\n.*tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');
  assert.equal(r.note(), null);
});

test('when CI cannot answer, it says so loudly, logs it, runs the suite here and lands', async (t) => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['no runner online', { FAKE_RUNNERS: '0' }, /no citadel-ci-linux runner is online/],
    ['GitHub down', { FAKE_CI: 'down' }, /GitHub didn't answer/],
    ['the runner list fails', { FAKE_RUNNERS: 'down' }, /didn't say which runners are online/],
    ['no runner starts the job', { FAKE_CI: 'queued', LAND_CI_START: '1' }, /no runner started the job within 1s/],
    ['the run never finishes', { FAKE_CI: 'running', LAND_CI_TIMEOUT: '1' }, /CI didn't finish within 1s/],
    ['the run was cancelled', { FAKE_CI: 'cancelled' }, /ended as cancelled/],
    ['the run failed before the tests', { FAKE_CI: 'red', FAKE_STEP: "the runner user's systemd" }, /failed in its setup step "the runner user's systemd", before any test ran/],
    ['LAND_CI=0', { LAND_CI: '0' }, /LAND_CI=0 was set/],
  ];
  for (const [name, extra, why] of cases) {
    await t.test(name, () => {
      const r = setup();
      const c = ci(r);
      r.commit(r.wt, 'b.txt', 'mine\n');
      const shared = join(r.dir, 'shared');
      const res = c.run({ COORDINATOR_SHARED_DIR: shared, ...extra });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /={20,}\nland: CI FALLBACK: .*Running the full suite on perigee instead\.\nland: ={20,}\nland: running the tests/);
      assert.match(res.stderr, why);
      assert.match(res.stderr.trimEnd().split('\n').at(-1)!, /landed on perigee's own test run, not CI: /, 'the last line says it again');
      assert.match(landLog(shared), /^- \d\d:\d\d:\d\dZ · ci fallback · ticket\/1-x · /m);
      assert.equal(c.localRuns(), 1);
      assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
      assert.equal(c.refs(), '', 'nothing is left on GitHub');
      // A run nobody waits for any more is cancelled, so it doesn't keep the one runner from the next landing.
      if (extra.FAKE_CI === 'queued' || extra.FAKE_CI === 'running') assert.match(c.calls(), /-X POST repos\/.*\/actions\/runs\/7\/cancel/);
      if (extra.LAND_CI === '0') assert.equal(c.calls(), '', 'GitHub is never asked');
    });
  }
});

// F11: with CI stuck, every landing in line waited its own 90 s (or 6 min) to learn the same thing.
test('after CI gave no answer in time, the landings of the next minutes skip the wait and say why; past that CI is asked again, and a green run clears it', () => {
  const r = setup();
  const c = ci(r);
  const down = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'ci-down');
  r.commit(r.wt, 'b.txt', 'one\n');
  let res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(down), 'the first landing leaves a note');
  const asked = c.calls();
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '30' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI gave no answer to a landing \d+ s ago \(no runner started the job within 1s\), so this one doesn't wait for it \(it is asked again from \d\d:\d\d\)/);
  assert.equal(c.calls(), asked, 'GitHub is not asked');
  assert.equal(c.localRuns(), 2);
  r.commit(r.wt, 'b.txt', 'three\n');
  res = c.run({ LAND_CI_DOWN: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed/);
  assert.ok(!existsSync(down), 'a green run takes the note away');
  assert.equal(c.localRuns(), 2);
});

test('a red run here after a fallback still refuses', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = c.run({ FAKE_RUNNERS: '0', FAIL_TESTS: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CI FALLBACK.*tests failed on the rebased branch \(full log/s);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

// The tests run from the worktree's top, wherever in it land.sh was started (#468 S10-7).
test('run from a subfolder of the worktree, it tests and lands the same', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  // By a relative path, as a person in the subfolder would type it: its helpers are found all the same.
  const res = spawnSync('bash', [relative(join(r.wt, 'test'), land)], { cwd: join(r.wt, 'test'), encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes');
});

test('a conflict aborts the rebase and lands nothing', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed/);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip, 'the branch is as it was');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

// The one day's folder, whichever UTC day the run fell on.
const landLog = (shared: string) => readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');

test('a conflict is logged to the retro-log with its files, and the refusal names them', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed.*conflicted files: a\.txt\./);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const log = landLog(shared);
  assert.match(log, new RegExp(`^- \\d\\d:\\d\\d:\\d\\dZ · land conflict · ticket/1-x onto ${main.slice(0, 7)}: a\\.txt$`, 'm'));
});

test('a rebase that cannot start logs no conflicted files', () => {
  const r = setup();
  r.commit(r.wt, 'x.txt', 'mine\n');
  writeFileSync(join(r.source, 'c.txt'), 'x\n');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'c');
  // main adds c.txt; an untracked c.txt in the worktree is in the way of the rebase.
  writeFileSync(join(r.wt, 'c.txt'), 'untracked\n');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  const log = landLog(shared);
  assert.match(log, /land conflict · ticket\/1-x: no conflicted files found/m);
});

test('a conflict still refuses the same when there is no shared dir or it cannot be written', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const main = git(r.source, 'rev-parse', 'main');
  const blocker = join(r.dir, 'blocker');
  writeFileSync(blocker, 'a file, not a folder\n');
  for (const shared of ['', blocker]) {
    const res = r.run({ COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rebase onto main failed/);
    assert.equal(git(r.source, 'rev-parse', 'main'), main);
    assert.equal(git(r.wt, 'status', '--porcelain'), '');
  }
});

test('a deploy that fails before going live puts main back', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ FAKE_DEPLOY_EXIT: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /main is back at/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.ok(!existsSync(join(r.source, 'b.txt')));
});

// Other schemes' builds can hold every heavy slot for an hour. A landing that waited for one while
// holding the deploy lock held up every other landing (#499): landings run their tests without one.
test('two landings both land while other jobs hold every heavy slot', async () => {
  const r = setup();
  const wt2 = join(r.dir, 'wt2');
  git(r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-y', wt2);
  r.commit(r.wt, 'b.txt', 'one\n');
  r.commit(wt2, 'c.txt', 'two\n');
  const heavy = join(r.dir, 'heavy');
  mkdirSync(heavy);
  writeFileSync(join(heavy, 'slots'), '1\n');
  // A stand-in for someone's cargo build, holding the only slot until this test stops it.
  const build = spawn('flock', [join(heavy, 'slot-0'), 'sleep', '600'], { detached: true, stdio: 'ignore' });
  try {
    while (spawnSync('flock', ['-n', join(heavy, 'slot-0'), 'true']).status === 0) await new Promise((ok) => setTimeout(ok, 50));
    const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), CITADEL_HEAVY_DIR: heavy };
    const [a, b] = await Promise.all([landAsync(r.wt, extra, 60_000), landAsync(wt2, extra, 60_000)]);
    assert.equal(a.status, 0, `first landing: ${a.stderr}`);
    assert.equal(b.status, 0, `second landing: ${b.stderr}`);
    assert.doesNotMatch(a.stderr + b.stderr, /heavy slots .* busy/, 'neither waited on the build');
    assert.deepEqual(git(r.source, 'log', '--format=%s', 'main').split('\n').sort(), ['b.txt: one', 'base', 'c.txt: two']);
  } finally {
    try { process.kill(-build.pid!, 'SIGKILL'); } catch {}
  }
});

test("refuses uncommitted work, main itself, arguments, running inside a citadel-heavy slot, and a person's container", () => {
  const r = setup();
  writeFileSync(join(r.wt, 'a.txt'), 'dirty\n');
  assert.match(r.run().stderr, /uncommitted changes/);
  git(r.wt, 'checkout', '--', 'a.txt');
  assert.match(spawnSync('bash', [land, '--now'], { cwd: r.wt, encoding: 'utf8', env }).stderr, /takes no arguments/);
  // Under citadel-heavy it would hold a slot other schemes need while it waits on the deploy lock.
  assert.match(r.run({ CITADEL_HEAVY_HELD: '1' }).stderr, /not under citadel-heavy/);
  // A person's Claude container has no deploy lock or GitHub login: the land tool runs it on the host.
  assert.match(r.run({ COORDINATOR_CONTAINER: '1' }).stderr, /runs in a container: call the land tool/);
  const onMain = spawnSync('bash', [land], { cwd: r.source, encoding: 'utf8', env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source } });
  assert.match(onMain.stderr, /not main/);
});
