// tools/land.sh itself: the rebase, its test run or CI gate, conflicts and refusals.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, landAsync, tickets, issued, ci } from './land-fixture.ts';
import { until } from './wait.ts';

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
  const shared = join(r.dir, 'shared');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), COORDINATOR_SHARED_DIR: shared } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running the tests \(the rebased land\.sh\)/);
  // One timing line for the whole landing, with the first copy's wait in line and rebase kept (#565).
  assert.equal(timings(shared).length, 1, landLog(shared));
  assert.match(timings(shared)[0], /· line \d+ · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/);
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

// M6: land-test.log is shared, so the next landing overwrote a red run's log within a second; the red one is kept by branch.
test("a red run's full log is kept under the branch's name, so the next landing doesn't overwrite it", () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  const kept = join(state, 'land-red-ticket-1-x.log');
  const res = r.run({ FAIL_TESTS: '1' });
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes(`tests failed on the rebased branch (full log: ${kept})`), res.stderr);
  assert.match(readFileSync(kept, 'utf8'), /red/);
  assert.equal(r.run().status, 0, 'the same branch, green');
  assert.match(readFileSync(kept, 'utf8'), /red/, 'still the red run');
});

// F12a: a test run that can't write its temp file or its log never ran a test, but read "tests failed on the rebased branch".
test("a test run that can't write its temp file or its log says so and that no test ran", async (t) => {
  const cases: [string, (r: ReturnType<typeof setup>, state: string) => Record<string, string>, RegExp][] = [
    ['a read-only TMPDIR', (r) => {
      const tmp = join(r.dir, 'ro-tmp');
      mkdirSync(tmp, { mode: 0o555 });
      return { TMPDIR: tmp };
    }, /run-tests: could not make a temp file in .*ro-tmp/],
    ['an unwritable land-test.log', (_, state) => {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(join(state, 'land-test.log'), '', { mode: 0o444 });
      return {};
    }, /run-tests: could not write the log .*land-test\.log/],
  ];
  for (const [name, prep, said] of cases) {
    await t.test(name, () => {
      const r = setup();
      r.commit(r.wt, 'b.txt', 'mine\n');
      const main = git(r.source, 'rev-parse', 'main');
      const res = r.run({ ...prep(r, join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy')), TEST_RUNS: join(r.dir, 'runs') });
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, said);
      assert.match(res.stderr, /land: no test ran: the test run could not write its files \(the run-tests line above says which\), so main is untouched/);
      assert.doesNotMatch(res.stderr, /tests failed/);
      assert.ok(!existsSync(join(r.dir, 'runs')), 'no test ran');
      assert.equal(git(r.source, 'rev-parse', 'main'), main);
    });
  }
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

// #753: the lane comes from tools/lanes as main has it. Light asks GitHub nothing and runs no test; kit and the rest
// wait for CI as before (tools/run-tests.sh picks the kit's test files there); a branch can't loosen its own lane.
test('a light land asks GitHub nothing and runs no test; kit, unlisted paths and a loosened map still wait for CI', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.source, 'tools/lanes', 'light docs/*\nkit kit/*\n');
  git(r.wt, 'rebase', '-q', 'main');
  mkdirSync(join(r.wt, 'docs'));
  mkdirSync(join(r.wt, 'kit'));
  r.commit(r.wt, 'docs/a.md', 'mine\n');
  let res = c.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.match(res.stderr, /lane: light .*no tests and no CI/s);
  assert.equal(c.calls(), '', 'not a word to GitHub');
  assert.equal(c.localRuns(), 0);
  assert.equal(r.note(), 'locked=1 held=yes', 'and it deployed');
  for (const [file, lane] of [['kit/x.md', /lane: kit \(/], ['b.txt', null], ['tools/lanes', null]] as const) {
    r.commit(r.wt, file, file === 'tools/lanes' ? 'light *\n' : 'two\n');
    const before = c.calls().length;
    res = c.run();
    assert.equal(res.status, 0, res.stderr);
    if (lane) assert.match(res.stderr, lane);
    else assert.doesNotMatch(res.stderr, /lane: /);
    assert.match(res.stderr, /waiting for CI on .*CI passed on/s, file);
    assert.ok(c.calls().length > before);
  }
  // The loosened map is main's now, and judges the next land.
  r.commit(r.wt, 'b.txt', 'three\n');
  assert.match(c.run().stderr, /lane: light \(tools\/lanes; the path that decided it: b\.txt\)/);
});

// #565: one line per landing with how long each phase took, landed or refused.
const timings = (shared: string) => landLog(shared).split('\n').filter((l) => l.includes(' · timing · '));
test('a landing leaves one timing line with every phase; CI that answers fills the CI fields', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  let res = c.run({ COORDINATOR_SHARED_DIR: shared, FAKE_LAG: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(landLog(shared), /^# Retro log: land\.sh\n\nWritten by .*`timing` line per landing.*`restart` line per queued restart/s, 'the header names the new lines');
  // Whichever writer makes the day's file writes the header, so the three copies are one text.
  const header = (f: string) => readFileSync(join(import.meta.dirname, '..', 'tools', f), 'utf8').split('\n').find((l) => l.includes("'# Retro log: land.sh'"))?.trim();
  assert.ok(header('land.sh'));
  assert.equal(header('deploy.sh'), header('land.sh'));
  assert.equal(header('run-tests.sh'), header('land.sh'));
  assert.deepEqual(timings(shared).length, 1);
  assert.match(timings(shared)[0], /^- \d\d:\d\d:\d\dZ · timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy \d+ · live \d+ · landed$/);
  // A deploy whose restart isn't live by the time it ends.
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ COORDINATOR_SHARED_DIR: shared, FAKE_NOT_LIVE: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(timings(shared)[1], /· fallback - · deploy \d+ · live - · landed, not live yet$/);
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  assert.deepEqual(readdirSync(state).filter((f) => f.startsWith('times-')), [], "deploy.sh's times file goes at the end");
});

test('a landing stopped while it waits for CI is logged as stopped there, not landed', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const child = spawn('bash', [land], { cwd: r.wt, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), COORDINATOR_SHARED_DIR: shared, PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', FAKE_CI: 'running', LAND_CI_TIMEOUT: '60' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const done = new Promise((ok) => child.once('close', ok));
  // Killed once a poll has seen the run going (land.sh's "cirun" mark), so the line has a ci-run time to show; a kill
  // before that first answer rightly says ci-run - (#578 saw it on the desktop runner).
  const times = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', `times-${child.pid}`);
  const running = () => existsSync(times) && /^cirun /m.test(readFileSync(times, 'utf8'));
  for (const end = Date.now() + 30_000; !running(); await new Promise((ok) => setTimeout(ok, 50))) assert.ok(Date.now() < end, stderr);
  child.kill('SIGTERM');
  await done;
  assert.match(timings(shared).join('\n'), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy - · live - · stopped at ci( \(exit \d+\))?$/);
  assert.ok(c.calls());
});

test('a landing that gives up in line leaves a timing line too', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  mkdirSync(state, { recursive: true });
  const holder = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(state, 'lock')], { stdio: 'ignore' });
  try {
    while (spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status === 0) spawnSync('sleep', ['0.05']);
    const shared = join(r.dir, 'shared');
    const res = r.run({ COORDINATOR_SHARED_DIR: shared, DEPLOY_QUEUE_STALL: '1' });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /nothing has moved/);
    assert.match(timings(shared).join('\n'), /^- \S+ · timing · ticket\/1-x · line \d+ · rebase - · ci-queue - · ci-run - · fallback - · deploy - · live - · refused at line$/);
  } finally {
    holder.kill('SIGKILL');
  }
});

test("a retro log that can't be written changes neither a landing's output nor its exit code", () => {
  const runs = ['', 'blocker'].map((shared) => {
    const r = setup();
    r.commit(r.wt, 'b.txt', 'mine\n');
    const blocker = join(r.dir, 'blocker');
    writeFileSync(blocker, 'a file, not a folder\n');
    const res = r.run({ COORDINATOR_SHARED_DIR: shared && blocker });
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    return { status: res.status, stderr: res.stderr.replace(/\b[0-9a-f]{7,40}\b/g, 'H').replace(/\d\d:\d\d/g, 'T').replace(/\/\d+\//g, '/N/') };
  });
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(runs[0].status, 0);
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
  const res = c.run({ FAKE_CI: 'red', COORDINATOR_SHARED_DIR: shared }); // a flake and a real failure
  assert.equal(res.status, 1);
  assert.match(landLog(shared), /· flake · test\/slow\.test\.ts · load 31\.5 · ticket\/1-x · in CI$/m, 'a flake CI labelled reaches the retro log');
  assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy - · live - · refused at ci$/m);
  assert.match(res.stderr, /the red test's output \(run 7\)\n.*real\.test\.ts: failed again alone.*\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.doesNotMatch(landLog(shared), /· flake rerun ·/, 'a real failure gets no fresh run');
  assert.equal(c.calls().split('\n').filter((l) => l.includes('/actions/runners ')).length, 1, 'one run only');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');
  assert.equal(r.note(), null);
});

// #769 (Cara, 2026-11-15, #767's card: "2 Rerun CI on flake-only red"): a red in which every failed file passed alone
// gets one fresh run of the same commit, and only a fully green one lands.
test('a red of flakes only gets one fresh CI run, and lands when that run is green', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /only flakes failed \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more on \w+, the land needs a fully green run\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(c.calls().split('\n').filter((l) => l.includes('/actions/runners ')).length, 2, 'a second push, so a new run');
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · test\/busy\.test\.ts, test\/slow\.test\.ts · green$/m);
  assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy \d+ · live \d+ · landed$/m);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '', 'nothing is left on GitHub');
});

test('a red of flakes only whose fresh run is red again refuses, whatever its labels say, and is not run a third time', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared }); // both runs red, both of flakes only
  assert.equal(res.status, 1);
  assert.match(res.stderr, /running CI once more.*the red test's output \(run 8\).*tests failed on the rebased branch in CI again \(https:\/\/ci\/8\), on the one fresh run after a red of flakes only \(test\/busy\.test\.ts, test\/slow\.test\.ts\), so main is untouched/s);
  assert.equal(c.calls().split('\n').filter((l) => l.includes('/actions/runners ')).length, 2, 'two runs, never three');
  assert.equal(res.stderr.match(/once more/g)!.length, 1);
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · test\/busy\.test\.ts, test\/slow\.test\.ts · red$/m);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');
});

test("a red of flakes only stays red when the scratch branch can't be deleted for the fresh run, rather than wait on a run never started", () => {
  const r = setup();
  const c = ci(r);
  // GitHub refuses the delete: pushing the same commit again would start no run.
  writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read -r old new ref; do case $new in *[!0]*) ;; *) echo "deletes refused" >&2; exit 1 ;; esac; done\n', { mode: 0o755 });
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /only flakes failed \(test\/busy\.test\.ts, test\/slow\.test\.ts\), but deleting land\/ticket\/1-x on GitHub to start a fresh run failed \(.*deletes refused.*\), so this stays red\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.equal(c.calls().split('\n').filter((l) => l.includes('/actions/runners ')).length, 1, 'no second run asked for');
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · .* · not started$/m);
  assert.equal(c.localRuns(), 0);
});

test('a red with no rerun labels (too many files failed) refuses at once, and a fresh run that gets no answer falls back to the run here', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  let res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'many' });
  assert.equal(res.status, 1);
  assert.doesNotMatch(res.stderr, /once more/);
  assert.equal(c.calls().split('\n').filter((l) => l.includes('/actions/runners ')).length, 1);

  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  const shared = join(r2.dir, 'shared');
  res = c2.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'queued', LAND_CI_START: '1', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running CI once more.*CI FALLBACK: no runner started the job within 1s/s);
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · .* · no answer$/m);
  assert.equal(c2.localRuns(), 1, 'the fallback suite here had to pass');
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
      assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/m);
      assert.equal(c.localRuns(), 1);
      assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
      assert.equal(c.refs(), '', 'nothing is left on GitHub');
      // A run nobody waits for any more is cancelled, so it doesn't keep the one runner from the next landing.
      if (extra.FAKE_CI === 'queued' || extra.FAKE_CI === 'running') assert.match(c.calls(), /-X POST repos\/.*\/actions\/runs\/7\/cancel/);
      if (extra.LAND_CI === '0') assert.equal(c.calls(), '', 'GitHub is never asked');
    });
  }
});

// F12d: CI's own reason reaches the landing: a rate limit, an error page or a rejected push all read "GitHub didn't answer"
// or "no runner started the job" before, and an error page waited out the full 90 s.
test("when CI can't answer, the fallback says what gh or git said, at once", async (t) => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['a rate limit', { FAKE_CI: 'rate' }, /CI FALLBACK: GitHub didn't answer \(gh: API rate limit exceeded for installation ID 1\. \(HTTP 403\)\)/],
    ['an error page for the runs', { FAKE_CI: 'garbage' }, /CI FALLBACK: GitHub didn't answer \(it sent something that isn't a run: <html><body>Bad gateway/],
    ['an error page for the runners', { FAKE_CI: 'queued', FAKE_RUNNERS: 'garbage' }, /CI FALLBACK: GitHub didn't say which runners are online \(it sent: <html>Bad gateway<\/html>\)/],
    ['a rejected push', { FAKE_CI: 'queued', REJECT: '1' }, /CI FALLBACK: pushing \w+ to GitHub failed \(remote: denied by the test hook; .*\)/],
  ];
  for (const [name, extra, why] of cases) {
    await t.test(name, () => {
      const r = setup();
      const c = ci(r);
      if (extra.REJECT) writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), "#!/bin/sh\necho 'denied by the test hook' >&2\nexit 1\n", { mode: 0o755 });
      r.commit(r.wt, 'b.txt', 'mine\n');
      const t0 = Date.now();
      const res = c.run(extra);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, why);
      assert.ok(Date.now() - t0 < 60_000, 'it does not wait out the 90 s for a runner');
      assert.equal(c.localRuns(), 1);
    });
  }
});

// M14: after a refusal, cancelling the CI run and deleting land/<branch> ran before the landing left the line, so a
// hung gh or push held the deploy lock up to 60 s more.
test('a refused landing lets go of the deploy lock before it cleans up on GitHub', { timeout: 60_000 }, async () => {
  const r = setup();
  const c = ci(r);
  // Deleting the scratch branch hangs 8 s.
  writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do [ "$new" != 0000000000000000000000000000000000000000 ] || sleep 8; done\n', { mode: 0o755 });
  r.commit(r.wt, 'b.txt', 'mine\n');
  const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
  let stderr = '';
  let ended = false;
  const landing = landAsync(r.wt, { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', FAKE_CI: 'red' }, 50_000, (e) => (stderr = e)).finally(() => (ended = true));
  await until('the refusal', () => /tests failed on the rebased branch in CI/.test(stderr), 30_000, () => stderr);
  await until('the lock to be free', () => spawnSync('flock', ['-n', lock, 'true']).status === 0, 4_000, () => stderr);
  assert.ok(!ended, 'freed while the cleanup still runs');
  const res = await landing;
  assert.equal(res.status, 1, res.stderr);
  assert.equal(c.refs(), '', 'the scratch branch still goes');
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

test("a stale squash, which reverts what landed since the branch started, is refused until it names each undo (#677)", () => {
  const r = setup();
  const lines = (who: string) => [1, 2, 3, 4, 5].map((k) => `${who} landed this, line ${k}\n`).join('');
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.source, 'c.txt', lines('someone else'));
  const theirs = git(r.source, 'rev-parse', 'main');
  // The branch's own ticket's earlier landing doesn't count.
  writeFileSync(join(r.source, 'd.txt'), lines('an earlier #1'));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', '#1: the first part');
  git(r.wt, 'reset', '--soft', 'main');
  git(r.wt, 'commit', '-qm', 'squashed');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`removes what these landed, without naming them:\\nland:   ${theirs.slice(0, 12)} c\\.txt: someone else .*\\(5 of the 5 lines`));
  assert.doesNotMatch(res.stderr, /^land: +[0-9a-f]{12} #1: the first part/m);
  assert.match(res.stderr, /git reset --soft \$\(git merge-base HEAD main\).*"Undoes: <sha>"/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.source, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), null, 'no deploy');
  git(r.wt, 'commit', '-q', '--amend', '-m', `squashed\n\nUndoes: ${theirs.slice(0, 9)}`);
  const again = r.run();
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!existsSync(join(r.source, 'c.txt')), 'the named undo landed');
});

test("a plain git revert of another minion's landing names it, so the undo guard lets it land (#677)", () => {
  const r = setup();
  r.commit(r.source, 'c.txt', [1, 2, 3, 4, 5].map((k) => `someone else landed this, line ${k}\n`).join(''));
  git(r.wt, 'rebase', '-q', 'main');
  git(r.wt, 'revert', '--no-edit', 'HEAD');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(join(r.source, 'c.txt')));
});

test("the undo guard is the kit template's, line for line, so a fix to one reaches the other (#677)", () => {
  const guard = (f: string) => readFileSync(f, 'utf8').match(/^# The undo guard \(#677[^]*?\n\}\n/m)?.[0];
  assert.ok(guard(land));
  assert.equal(guard(land), guard(join(import.meta.dirname, '..', 'kit/skills/scheme-setup/templates/land.sh')));
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
  assert.deepEqual(timings(shared).map((l) => l.replace(/^- \S+ · /, '').replace(/\d+/g, 'N')), ['timing · ticket/N-x · line N · rebase N · ci-queue - · ci-run - · fallback - · deploy - · live - · refused at rebase']);
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
