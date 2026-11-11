import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/land.sh on throwaway repos: a scheme repo on main, a minion worktree, and a live clone. The
// worktree's tools/deploy.sh is a stand-in that notes whether it got the lock, and fails on request.
const land = join(import.meta.dirname, '..', 'tools', 'land.sh');
const root = mkdtempSync(join(tmpdir(), 'land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make land.sh's own `node --test` report to this runner instead of exiting red;
// COORDINATOR_* would have the real deploy.sh report to the live server; CITADEL_HEAVY_* would queue it in the host's slots;
// The variables the scripts export (test/script-env.ts), set when a real land runs these tests, would have a test's deploy.sh skip its own lock
// ("flock: 9: Bad file descriptor") or its tests; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope.
const env = { ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, CITADEL_HEAVY_DIR: join(root, 'heavy'), DEPLOY_TEST_CPU_WEIGHT: '', NODE_TEST_CONTEXT: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

let n = 0;
function setup() {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  // TEST_RUNS: a file that gets a line per test run, naming the checkout it ran in.
  writeFileSync(join(source, 'test', 'ok.test.mjs'), "import { appendFileSync } from 'node:fs';\nif (process.env.TEST_RUNS) appendFileSync(process.env.TEST_RUNS, process.cwd() + '\\n');\nif (process.env.FAIL_TESTS) throw new Error('red');\n");
  writeFileSync(join(source, 'tools', 'deploy.sh'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
flock -n "$lock" true && held=no || held=yes
echo "locked=$DEPLOY_LOCKED held=$held" >"$DEPLOY_NOTE"
until [ -z "\${FAKE_DEPLOY_GATE:-}" ] || [ -e "\$FAKE_DEPLOY_GATE" ]; do sleep 0.05; done
exit "\${FAKE_DEPLOY_EXIT:-0}"
`);
  chmodSync(join(source, 'tools', 'deploy.sh'), 0o755);
  writeFileSync(join(source, 'a.txt'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'base');
  const live = join(dir, 'live');
  git(dir, 'clone', '-q', source, live);
  const wt = join(dir, 'wt');
  git(source, 'worktree', 'add', '-q', '-b', 'ticket/1-x', wt);
  const run = (extra: Record<string, string> = {}) =>
    // A time limit, so a land.sh whose test run hangs fails this test instead of hanging it (#377).
    spawnSync('bash', [land], { cwd: wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: live, DEPLOY_SOURCE: source, DEPLOY_NOTE: join(dir, 'note'), ...extra } });
  const commit = (where: string, file: string, text: string) => {
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const note = () => (existsSync(join(dir, 'note')) ? readFileSync(join(dir, 'note'), 'utf8').trim() : null);
  return { dir, source, live, wt, run, commit, note };
}

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

// Run land.sh in its own process group, so a run that hangs can be stopped with everything it started.
function landAsync(cwd: string, extra: Record<string, string>, limit: number, seen?: (stderr: string) => void): Promise<{ status: number | null; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn('bash', [land], { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => seen?.((stderr += d)));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, limit);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr, ms: Date.now() - t }); });
  });
}

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

// The real deploy.sh and run-tests.sh on main, a boot check that passes, and stand-ins for systemd: the
// queued "restart" waits for the lock, then counts as live and checked (it tags last-good, as the real one does). run() runs a script with them; runs() lists
// where the tests ran.
async function withRealDeploy(body: (r: ReturnType<typeof setup>, run: (script: string, cwd: string, extra?: Record<string, string>) => Promise<{ stderr: string }>, runs: () => string[]) => Promise<void>) {
  const r = setup();
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "console.log('v1');\n");
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real deploy.sh');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  const base = git(r.source, 'rev-parse', 'main');
  const bin = join(r.dir, 'bin');
  const restarted = join(r.dir, 'restarted');
  const testRuns = join(r.dir, 'test-runs');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
(flock -w 20 "$lock" true && echo got >${JSON.stringify(restarted)} && git -C "$DEPLOY_LIVE" tag -f last-good HEAD) >/dev/null 2>&1 &
`);
  for (const f of ['systemctl', 'systemd-run']) chmodSync(join(bin, f), 0o755);
  const server = createServer((_, res) => res.end(JSON.stringify({ ok: true, commit: existsSync(restarted) ? git(r.source, 'rev-parse', 'main') : base })));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const run = (script: string, cwd: string, extra: Record<string, string> = {}) => promisify(execFile)('bash', [script], {
      cwd, encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_URL: url, DEPLOY_DB: join(r.dir, 'none.db'), DEPLOY_REMOTE: '', TEST_RUNS: testRuns, ...extra },
    });
    const runs = () => (existsSync(testRuns) ? readFileSync(testRuns, 'utf8').trim().split('\n') : []);
    await body(r, run, runs);
  } finally {
    server.close();
  }
}

test('the real deploy.sh takes the lock land.sh holds, lets go of it once the restart is queued, and skips the tests land.sh just ran', () =>
  withRealDeploy(async (r, run, runs) => {
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = await run(land, r.wt);
    assert.match(res.stderr, /live now: the server restarted on/);
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'));
    assert.match(res.stderr, /skipping the tests: land\.sh just ran them on/);
    assert.deepEqual(runs(), [r.wt], 'the suite ran once, in the worktree');
  }));

// A killed deploy must not leave its test run or boot check holding the lock (ultra review A4), and the boot check
// runs under a name ananicy's node rule doesn't match (A5b).
test("deploy.sh's test run and boot check don't get the deploy lock's fd 9, and the boot check isn't named node", () =>
  withRealDeploy(async (r, run) => {
    const fd9 = join(r.dir, 'fd9');
    writeFileSync(join(r.source, 'tools', 'run-tests.sh'), '#!/usr/bin/env bash\n[ -e /proc/self/fd/9 ] && echo tests open >>"$FD9_NOTE" || echo tests closed >>"$FD9_NOTE"\n');
    // node opens descriptors of its own, so the boot check looks at what its fd 9 is.
    writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "import { appendFileSync, readlinkSync } from 'node:fs';\nimport { basename } from 'node:path';\nlet fd9 = '';\ntry { fd9 = readlinkSync('/proc/self/fd/9'); } catch {}\nappendFileSync(process.env.FD9_NOTE, `boot ${fd9.endsWith('/cc-deploy/lock') ? 'open' : 'closed'} ${basename(process.argv0)}\\n`);\nconsole.log('v1');\n");
    git(r.source, 'commit', '-qam', 'stand-ins that look for fd 9');
    const res = await run(join(import.meta.dirname, '..', 'tools', 'deploy.sh'), r.source, { FD9_NOTE: fd9 });
    assert.match(res.stderr, /live now: the server restarted on/);
    assert.equal(readFileSync(fd9, 'utf8'), 'tests closed\nboot closed citadel-node\n');
  }));

test('deploy.sh tests again when a file outside the commit was in the worktree (untracked or ignored) or is in the live checkout', async () => {
  for (const stray of ['wt/scratch.txt', 'wt/notes.ignored', 'live/test/stray.test.mjs']) {
    await withRealDeploy(async (r, run, runs) => {
      r.commit(r.wt, 'b.txt', 'mine\n');
      appendFileSync(join(r.source, '.git', 'info', 'exclude'), '*.ignored\n'); // the worktree shares it
      const [where, file] = stray.split(/\/(.*)/);
      writeFileSync(join(where === 'wt' ? r.wt : r.live, file), '\n');
      const res = await run(land, r.wt);
      assert.match(res.stderr, /live now: the server restarted on/, stray);
      assert.doesNotMatch(res.stderr, /skipping the tests/, stray);
      assert.deepEqual(runs(), [r.wt, r.live], stray);
    });
  }
});

test('deploy.sh on its own, or told of a different tested commit, still runs the tests', async () => {
  for (const tested of [undefined, 'stale']) {
    await withRealDeploy(async (r, run, runs) => {
      r.commit(r.source, 'b.txt', 'theirs\n');
      // A commit land.sh tested that isn't the one the pull lands on (main moved on, or a hand-made deploy).
      const extra = tested ? { DEPLOY_TESTED: git(r.source, 'rev-parse', 'main~1') } : {};
      const res = await run(join(import.meta.dirname, '..', 'tools', 'deploy.sh'), r.source, extra);
      assert.match(res.stderr, /running the tests/);
      assert.doesNotMatch(res.stderr, /skipping the tests/);
      assert.deepEqual(runs(), [r.live]);
      assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.source, 'rev-parse', 'main'));
    });
  }
});

// DEPLOY_LOCKED and DEPLOY_TESTED leaked into a deploy land.sh didn't start (an inherited env, a test run under
// a deploy, a nested run): with no fd 9, or fd 9 on another file, it takes the lock itself and runs the tests (#514).
test('deploy.sh told DEPLOY_LOCKED without the lock on fd 9 takes the lock itself and runs the tests', async () => {
  for (const fd9 of ['', 'exec 9>/dev/null; ']) {
    await withRealDeploy(async (r, run, runs) => {
      r.commit(r.source, 'b.txt', 'theirs\n');
      const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
      mkdirSync(join(lock, '..'), { recursive: true });
      // Someone else holds the lock for a while: the deploy must wait for it rather than go ahead.
      const holder = spawn('flock', [lock, 'sleep', '2'], { stdio: 'ignore' });
      const released = new Promise((ok) => holder.once('exit', ok));
      while (spawnSync('flock', ['-n', lock, 'true']).status === 0) await new Promise((ok) => setTimeout(ok, 20));
      const script = join(r.dir, 'leaky.sh');
      writeFileSync(script, `${fd9}exec bash ${JSON.stringify(join(import.meta.dirname, '..', 'tools', 'deploy.sh'))}\n`);
      let holderDone = false;
      void released.then(() => (holderDone = true));
      const res = await run(script, r.source, { DEPLOY_LOCKED: '1', DEPLOY_TESTED: git(r.source, 'rev-parse', 'main') });
      await released;
      assert.ok(holderDone, `the deploy waited for the lock (fd9: ${fd9 || 'closed'})`);
      assert.match(res.stderr, /taking the lock/, fd9);
      assert.match(res.stderr, /running the tests/, fd9);
      assert.doesNotMatch(res.stderr, /skipping the tests/, fd9);
      assert.deepEqual(runs(), [r.live], fd9);
      assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.source, 'rev-parse', 'main'), fd9);
    });
  }
});

// A person pressing Stop, or a Bash time limit, ends the whole run with a signal (#468 S10-5).
test('a land killed while the deploy tests the live checkout puts the checkout and main back', async () => {
  const r = setup();
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  // Run in the live checkout (the deploy's own test run), it says so and takes a few seconds.
  writeFileSync(join(r.source, 'test', 'slow.test.mjs'), `import { realpathSync, writeFileSync } from 'node:fs';
if (process.env.KILL_MARK && realpathSync(process.cwd()) === realpathSync(process.env.DEPLOY_LIVE)) {
  writeFileSync(process.env.KILL_MARK + '.started', '');
  await new Promise((r) => setTimeout(r, 3000));
  writeFileSync(process.env.KILL_MARK + '.done', '');
}
`);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real deploy.sh');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  const base = git(r.source, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  writeFileSync(join(r.wt, 'scratch.txt'), ''); // a file outside the commit, so the deploy runs its own tests (#500)
  const bin = join(r.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const mark = join(r.dir, 'kill');
  const child = spawn('bash', [land], {
    cwd: r.wt, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_URL: 'http://127.0.0.1:9', DEPLOY_DB: join(r.dir, 'none.db'), DEPLOY_REMOTE: '', KILL_MARK: mark },
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const exited = new Promise((ok) => child.once('exit', ok));
  const until = async (file: string) => {
    for (const end = Date.now() + 60_000; !existsSync(file); await new Promise((ok) => setTimeout(ok, 50))) {
      if (Date.now() > end) throw new Error(`no ${file}:\n${stderr}`);
    }
  };
  await until(`${mark}.started`);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'), 'main had moved');
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'), 'the live checkout had pulled it');
  process.kill(-child.pid!, 'SIGTERM');
  await exited;
  await until(`${mark}.done`); // the test run itself (in a process group of its own) ends by itself
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), base, `the live checkout is back:\n${stderr}`);
  assert.equal(git(r.source, 'rev-parse', 'main'), base, `main is back:\n${stderr}`);
  assert.match(stderr, /putting the checkout back/);
  assert.match(stderr, /main is back at/);
});

// The line for the deploy lock (tools/deploy-queue.sh, #502). The kernel grants a flock in no order, so ten
// landings waiting on it at once (2026-11-10) meant some lost every round and timed out.
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(what: string, cond: () => boolean, ms = 30_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const tickets = (state: string) => (existsSync(join(state, 'queue')) ? readdirSync(join(state, 'queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
const issued = (state: string) => (existsSync(join(state, 'queue', '.seq')) ? Number(readFileSync(join(state, 'queue', '.seq'), 'utf8')) : 0);

test('ten landings started together land in the order they arrived, each told its place in line', async () => {
  const r = setup();
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FAKE_DEPLOY_GATE: join(r.dir, 'gate'), DEPLOY_QUEUE_POLL: '0.05' };
  const wts = [r.wt];
  for (let i = 2; i <= 10; i++) git(r.source, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[wts.push(join(r.dir, `wt${i}`)) - 1]);
  wts.forEach((wt, i) => r.commit(wt, `f${i + 1}.txt`, `${i + 1}\n`));
  const lands: ReturnType<typeof landAsync>[] = [];
  let last = '';
  for (let i = 1; i <= 10; i++) {
    lands.push(landAsync(wts[i - 1], extra, 120_000, (stderr) => i === 10 && (last = stderr)));
    await until(`landing ${i}'s ticket`, () => issued(state) === i); // arrival order is the order of the tickets
  }
  // The first holds the lock until all ten are in line and the last has been told its place.
  await until('the last to say its place', () => /queue: 10th in line for the deploy lock, about 45 min \(ahead: ticket\/1-x, deploying\)/.test(last));
  writeFileSync(join(r.dir, 'gate'), '');
  const done = await Promise.all(lands);
  done.forEach((d, i) => assert.equal(d.status, 0, `landing ${i + 1}: ${d.stderr}`));
  assert.deepEqual(git(r.source, 'log', '--reverse', '--format=%s', 'main').split('\n'), ['base', ...done.map((_, i) => `f${i + 1}.txt: ${i + 1}`)]);
  assert.doesNotMatch(done[0].stderr, /in line/, 'the first had nobody to wait for');
  assert.match(done[9].stderr, /queue: 2nd in line for the deploy lock, about \d+ min \(ahead: ticket\/9-x, /);
  assert.match(done[9].stderr, /queue: got the deploy lock/);
  assert.deepEqual(tickets(state), [], 'every ticket is gone');
  assert.equal(readFileSync(join(state, 'queue', '.took'), 'utf8').trim().split('\n').length, 5, 'the newest five landings were timed, for the estimate');
  assert.equal(spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status, 0, 'the deploy lock is free');
});

// Fake work for the line itself: wait in line, note the turn, then hold the lock while $3 runs.
const queueLib = join(import.meta.dirname, '..', 'tools', 'deploy-queue.sh');
function waiter(state: string, label: string, work: string, extra: Record<string, string> = {}) {
  const child = spawn('bash', ['-c', '. "$0"; queue_lock "$1" "$2" || exit 1; echo "$2" >>"$1/order"; eval "$3"; queue_done ok', queueLib, state, label, work], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, DEPLOY_QUEUE_POLL: '0.05', ...extra } });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const exit = new Promise<number | null>((ok) => child.on('close', ok));
  return { child, exit, stderr: () => stderr };
}
const order = (state: string) => (existsSync(join(state, 'order')) ? readFileSync(join(state, 'order'), 'utf8').trim().split('\n') : []);
const queueState = () => {
  const state = join(root, `queue-${++n}`);
  mkdirSync(state);
  return state;
};

test('a waiter that is killed leaves the line, and the one behind it goes next', async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  let c: ReturnType<typeof waiter> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    const b = waiter(state, 'b', 'true');
    await until("b's ticket", () => issued(state) === 2);
    c = waiter(state, 'c', 'true');
    const cs = c.stderr;
    await until('c to see its place', () => /3rd in line/.test(cs()));
    const [ta, , tc] = tickets(state);
    assert.ok(tc, 'three tickets in line');
    b.child.kill('SIGKILL');
    await b.exit;
    // Not counted right after the kill: c may already have removed it by then.
    await until('c to move up past the dead ticket', () => /2nd in line/.test(cs()));
    assert.deepEqual(tickets(state), [ta, tc], "the waiter behind it removed the killed waiter's ticket");
    writeFileSync(join(state, 'go'), '');
    assert.equal(await a.exit, 0);
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(order(state), ['a', 'c']);
  } finally {
    writeFileSync(join(state, 'go'), ''); // a failed check must not leave a and c waiting, which hangs the file
    c?.child.kill('SIGKILL');
  }
});

// A zombie: b's parent starts it, then becomes a sleep that never waits on it, so once b is killed its
// /proc entry stays, start time and all, until the parent goes.
const isZombie = (pid: number) => { try { return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };

test('a killed waiter whose parent never reaps it leaves the line too', async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  let c: ReturnType<typeof waiter> | undefined;
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    parent = spawn('bash', ['-c', 'bash -c \'. "$0"; queue_lock "$1" b\' "$0" "$1" & echo $! >"$1/b.pid"; exec sleep 600', queueLib, state], { stdio: 'ignore', env: { ...env, DEPLOY_QUEUE_POLL: '0.05' } });
    await until("b's ticket", () => issued(state) === 2);
    c = waiter(state, 'c', 'true');
    const cs = c.stderr;
    await until('c to see its place', () => /3rd in line/.test(cs()));
    const [ta, , tc] = tickets(state);
    assert.ok(tc, 'three tickets in line');
    const b = Number(readFileSync(join(state, 'b.pid'), 'utf8'));
    process.kill(b, 'SIGKILL');
    await until('b to be a zombie', () => isZombie(b));
    await until('c to move up past the zombie', () => /2nd in line/.test(cs()));
    assert.deepEqual(tickets(state), [ta, tc], "the zombie's ticket was removed");
    assert.ok(isZombie(b), 'b was still a zombie when c moved up');
    writeFileSync(join(state, 'go'), '');
    assert.equal(await a.exit, 0);
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(order(state), ['a', 'c']);
  } finally {
    writeFileSync(join(state, 'go'), '');
    c?.child.kill('SIGKILL');
    parent?.kill('SIGKILL');
  }
});

test('a holder that is killed leaves the line too, and its lock goes with it', async () => {
  const state = queueState();
  const a = waiter(state, 'a', 'exec sleep 600');
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true');
  await until('b to wait', () => /2nd in line/.test(b.stderr()));
  a.child.kill('SIGKILL');
  assert.equal(await b.exit, 0, b.stderr());
  assert.deepEqual(order(state), ['a', 'b']);
});

test('waiters outlast the stall limit while the holder moves on, and give up once nothing moves', async () => {
  const state = queueState();
  // Three seconds of work in phases, against a two-second limit on no progress (bash counts whole seconds, so it can be a second short).
  const a = waiter(state, 'a', `for i in $(seq 10); do queue_phase "step $i"; sleep 0.3; done; touch '${state}/stuck'; exec sleep 600`);
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '2' });
  const t = Date.now();
  assert.equal(await b.exit, 1, 'it gives up in the end');
  try {
    assert.ok(existsSync(join(state, 'stuck')), `not while the holder was still moving: gave up after ${Date.now() - t} ms\n${b.stderr()}`);
    assert.match(b.stderr(), /2nd in line for the deploy lock, about 5 min \(ahead: a, step 1\)/);
    assert.match(b.stderr(), /nothing has moved for .* \(ahead: a, step 10; pid \d+, state \w; the lock is held\), so this gave up/);
    assert.deepEqual(tickets(state).length, 1, 'its ticket went with it');
    assert.deepEqual(order(state), ['a']);
  } finally {
    a.child.kill('SIGKILL');
  }
});

test('the head of the line waits for a lock held outside it (the queued restart), and the estimate comes from past landings', async () => {
  const state = queueState();
  mkdirSync(join(state, 'queue'));
  writeFileSync(join(state, 'queue', '.took'), '100\n140\n');
  const restart = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(state, 'lock')], { stdio: 'ignore' }); // one process, so killing it frees the lock
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    const a = waiter(state, 'a', 'sleep 1.2');
    await until('a to say it waits', () => /next in line for the deploy lock \(ahead: outside the line, the lock is open in pid \d+ \(sleep 600\)\)/.test(a.stderr()));
    const b = waiter(state, 'b', 'true');
    await until('b to say its place', () => /2nd in line for the deploy lock, about 2 min \(ahead: a, waiting\)/.test(b.stderr()));
    assert.deepEqual(order(state), []);
    restart.kill('SIGKILL');
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(order(state), ['a', 'b']);
    // Each noted how long it held the lock; a held it for a second or two.
    const took = readFileSync(join(state, 'queue', '.took'), 'utf8').trim().split('\n').map(Number);
    assert.equal(took.length, 4);
    assert.ok(took[2] >= 1 && took[2] <= 30, `a's time: ${took[2]}`);
  } finally {
    restart.kill('SIGKILL');
  }
});

// The pipeline failure drill's F3 (#553): a frozen unit or container stops a waiter (state T). It holds nothing, yet
// everyone behind it waited on it with the lock free, and gave up.
test('a waiter that is frozen is passed over: the one behind it takes the lock, and it goes when it wakes', { timeout: 60_000 }, async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  const b = waiter(state, 'b', 'true');
  let c: ReturnType<typeof waiter> | undefined;
  try {
    await until('b to say its place', () => /2nd in line/.test(b.stderr()));
    process.kill(b.child.pid!, 'SIGSTOP');
    c = waiter(state, 'c', 'true', { DEPLOY_QUEUE_STALL: '3' });
    const cs = c.stderr;
    await until('c to say its place', () => /in line/.test(cs()));
    writeFileSync(join(state, 'go'), '');
    assert.equal(await c.exit, 0, cs());
    assert.deepEqual(order(state), ['a', 'c']);
    process.kill(b.child.pid!, 'SIGCONT');
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(order(state), ['a', 'c', 'b']);
  } finally {
    for (const w of [a, b, c]) w?.child.kill('SIGKILL');
  }
});

test('giving up names the process at the head of the line, its state and whether the lock is held', { timeout: 60_000 }, async () => {
  const state = queueState();
  const a = waiter(state, 'a', 'sleep 60');
  let b: ReturnType<typeof waiter> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    process.kill(a.child.pid!, 'SIGSTOP'); // the holder itself is frozen: nobody can pass it
    b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '2' });
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), new RegExp(`nothing has moved for 0 min \\(ahead: a, starting; pid ${a.child.pid}, stopped; the lock is held\\), so this gave up`));
  } finally {
    for (const w of [a, b]) w?.child.kill('SIGKILL');
  }
});

// F8: an orphan of a killed landing (its test run, its boot check) keeps the lock with no ticket, and the waiters
// were told "a queued restart, or a landing started from a branch older than the line", which it never was.
test('a waiter behind a lock held from outside the line names the processes that have the lock file open', { timeout: 60_000 }, async () => {
  const state = queueState();
  const outside = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 41', join(state, 'lock')], { stdio: 'ignore' }); // one process, the lock on its fd 9
  let b: ReturnType<typeof waiter> | undefined;
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    b = waiter(state, 'b', 'true');
    const bs = b.stderr;
    await until('b to say what it waits for', () => /next in line/.test(bs()));
    assert.match(bs(), /next in line for the deploy lock \(ahead: outside the line, the lock is open in pid \d+ \([^)]*sleep 41\)/);
    assert.doesNotMatch(bs(), new RegExp(`pid ${b.child.pid} `), 'not itself');
    outside.kill('SIGKILL');
    assert.equal(await b.exit, 0, bs());
  } finally {
    outside.kill('SIGKILL');
    b?.child.kill('SIGKILL');
  }
});

// F4: the queued restart takes no ticket, so the waiters saw nothing move through it and gave up. It now says what
// it is doing in <state>/restart ("<pid>" and its phase), and each new phase is progress.
test("the queued restart's phases show to the waiters and count as progress", { timeout: 60_000 }, async () => {
  const state = queueState();
  const restart = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 42', join(state, 'lock')], { stdio: 'ignore' }); // one process, the lock on its fd 9
  const phase = (text: string) => writeFileSync(join(state, 'restart'), `${restart.pid}\n${text}\n`);
  let b: ReturnType<typeof waiter> | undefined;
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    phase('restarting citadel on abc1234 since 10:00');
    b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '3' });
    const bs = b.stderr;
    await until('b to see the restart', () => /ahead: the queued restart, restarting citadel on abc1234 since 10:00\)/.test(bs()));
    await new Promise((ok) => setTimeout(ok, 2000));
    phase('rolling back to def5678 since 10:01');
    await until('b to see the next phase', () => /ahead: the queued restart, rolling back to def5678 since 10:01\)/.test(bs()));
    await new Promise((ok) => setTimeout(ok, 2000));
    assert.doesNotMatch(bs(), /gave up/, 'past the stall since it arrived, but the restart moved');
    restart.kill('SIGKILL');
    assert.equal(await b.exit, 0, bs());
  } finally {
    restart.kill('SIGKILL');
    b?.child.kill('SIGKILL');
  }
});
