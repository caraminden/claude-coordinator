// Part 1 of 4 of the land tests (#2208); the shared setup is in land-setup.ts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, tickets, issued, ci } from './land-fixture.ts';
import { copyLand, landText } from './land-files.ts';
import { repo, timings, stopped, cancels, hubHas, waits, once, landLog } from './land-setup.ts';

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

test('a rebase that changes land.sh hands over to the rebased copy, which keeps the lock and lands (#500)', () => {
  const r = setup();
  // The worktree runs its own tools/land.sh, as a minion does; main's newer one says it is the one running.
  copyLand(join(r.source, 'tools'));
  for (const f of ['deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs', 'citadel-heavy']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
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

// The same when only a part changed (#2099): land.sh's parts (tools/land/*.sh) are read once, up front, so a rebase
// that brings a new or changed part hands over to a copy that sources it.
test('a rebase that changes only a part of land.sh hands over to the rebased copy, which lands with it (#2099)', () => {
  const r = setup();
  copyLand(join(r.source, 'tools'));
  for (const f of ['deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs', 'citadel-heavy']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real land.sh');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  // Main gains a part the worktree's copy never sourced; it rewords one line, so the copy that sources it shows.
  mkdirSync(join(r.source, 'tools', 'land'), { recursive: true });
  writeFileSync(join(r.source, 'tools', 'land', 'extra.sh'), `say() { [ "$*" != "running the tests" ] || set -- "running the tests (a part's say)"; echo "land: $*" >&2; }\n`);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'a part');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), COORDINATOR_SHARED_DIR: join(r.dir, 'shared') } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running the tests \(a part's say\)/);
  assert.equal(res.stderr.match(/rebasing/g)?.length, 1, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes', 'the deploy still runs under the lock');
});

// A killed land.sh must not leave its test run holding the deploy lock (ultra review A4).
test("the test run doesn't get the deploy lock's fd 9", () => {
  const r = setup();
  const tools = join(r.dir, 'tools');
  mkdirSync(tools);
  copyLand(tools);
  for (const f of ['deploy-queue.sh', 'citadel-heavy']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(tools, f));
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
    [
      'a read-only TMPDIR',
      (r) => {
        const tmp = join(r.dir, 'ro-tmp');
        mkdirSync(tmp, { mode: 0o555 });
        return { TMPDIR: tmp };
      },
      /run-tests: could not make a temp file in .*ro-tmp/,
    ],
    [
      'an unwritable land-test.log',
      (_, state) => {
        mkdirSync(state, { recursive: true, mode: 0o700 });
        writeFileSync(join(state, 'land-test.log'), '', { mode: 0o444 });
        return {};
      },
      /run-tests: could not write the log .*land-test\.log/,
    ],
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
  // It hangs alone too, and passes on main, so it is the ship's own (#1863); 3 s is enough to tell a hang by.
  const res = r.run({ DEPLOY_TEST_TIMEOUT: '2', LAND_PIN_LIMIT: '3' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the tests ran past 2s and were stopped: a test hung/);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'the deploy lock is free');
});

// 6 of 9 fallbacks on perigee hit the 600 s limit, and each told its minion its own tests had failed (#1863).
test('a suite that only ran out of time is no verdict on the ship: refused, and never as its own failed tests', () => {
  const r = setup();
  r.commit(r.source, 'test/hang.test.mjs', "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ DEPLOY_TEST_TIMEOUT: '3', LAND_PIN_LIMIT: '3' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /land: the suite on perigee ran out of its time limit and no test is known to be ticket\/1-x's own failure .*: that is no answer, so main is untouched/);
  assert.doesNotMatch(res.stderr, /tests failed/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
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
  assert.match(res.stderr, /lane: light .*no CI: /s);
  assert.equal(c.calls(), '', 'not a word to GitHub');
  assert.equal(c.localRuns(), 0);
  assert.equal(r.note(), 'locked=1 held=yes', 'and it deployed');
  for (const [file, lane] of [
    ['kit/x.md', /lane: kit \(/],
    ['b.txt', null],
    ['tools/lanes', null],
  ] as const) {
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

// #1864 (LA2): a light ship gets no CI, so the tests the affected map picks for its paths run on its rebased commit.
test('a light land runs the tests that read its paths, and one that breaks them is refused', () => {
  const r = setup();
  const c = ci(r);
  const log = join(r.dir, 'light.log');
  mkdirSync(join(r.source, 'docs'));
  mkdirSync(join(r.source, 'test'), { recursive: true });
  copyFileSync(join(import.meta.dirname, '..', 'tools', 'affected.ts'), join(r.source, 'tools', 'affected.ts'));
  // The stand-in runner: which tests it was given, and red once the list doc and the index disagree.
  writeFileSync(join(r.source, 'tools', 'citadel-test'), `#!/usr/bin/env bash\nshift 2\necho "$*" >>"${log}"\n[ "$(cat docs/a.md)" = "$(cat docs/b.md)" ] || { echo "✖ test/doc.test.ts › the two agree"; exit 1; }\n`);
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  writeFileSync(join(r.source, 'test', 'doc.test.ts'), '');
  writeFileSync(join(r.source, 'tools', 'affected-map.txt'), '@tests test/*.test.ts\ndocs/*.md: test/doc.test.ts\n');
  writeFileSync(join(r.source, 'docs', 'a.md'), 'one\n');
  writeFileSync(join(r.source, 'docs', 'b.md'), 'one\n');
  r.commit(r.source, 'tools/lanes', 'light docs/*\n');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'docs/a.md', 'two\n');
  const main = git(r.source, 'rev-parse', 'main');
  let res = c.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /guard tests failed on [0-9a-f]+, the branch rebased onto main/);
  assert.match(res.stderr, /land: guard: ✖ test\/doc\.test\.ts › the two agree/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  r.commit(r.wt, 'docs/b.md', 'two\n');
  res = c.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /guard tests passed on .*no CI: /s);
  assert.equal(c.calls(), '', 'not a word to GitHub');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['test/doc.test.ts', 'test/doc.test.ts']);
  // A map that can't answer holds nobody up, and says so.
  writeFileSync(join(r.wt, 'docs', 'a.md'), 'three\n');
  git(r.source, 'reset', '-q', '--hard');
  r.commit(r.source, 'tools/affected-map.txt', '@fallback sometimes\n');
  git(r.wt, 'commit', '-qam', 'docs: three');
  res = c.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the affected map couldn't answer, so no test that reads these paths ran/);
});

test('a landing leaves one timing line with every phase; CI that answers fills the CI fields', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  let res = c.run({ COORDINATOR_SHARED_DIR: shared, FAKE_LAG: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(landLog(shared), /^# Retro log: land\.sh\n\nWritten by .*`timing` line per landing.*`restart` line per queued restart/s, 'the header names the new lines');
  // Whichever writer makes the day's file writes the header, so the three copies are one text.
  const header = (f: string) =>
    (f === 'land.sh' ? landText() : readFileSync(join(import.meta.dirname, '..', 'tools', f), 'utf8'))
      .split('\n')
      .find((l) => l.includes("'# Retro log: land.sh'"))
      ?.trim();
  assert.ok(header('land.sh'));
  assert.equal(header('deploy.sh'), header('land.sh'));
  assert.equal(header('run-tests.sh'), header('land.sh'));
  assert.deepEqual(timings(shared).length, 1);
  assert.match(timings(shared)[0], /^- \d\d:\d\d:\d\dZ · timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy \d+ · live \d+ · landed$/);
  // #1722: each CI wait says what is left of the login's GitHub hour, and the landing logs its gh calls beside it.
  assert.match(res.stderr, /land: waiting for CI on \S+: .*\. GitHub calls left this hour: 4321\/5000, resets in 25 min\n/);
  const githubLines = landLog(shared)
    .split('\n')
    .filter((l) => l.includes(' · github · '));
  assert.equal(githubLines.length, 1);
  const counted = readFileSync(join(r.live, '.git', 'cc-deploy', 'gh-calls'), 'utf8')
    .trim()
    .split('\n').length;
  assert.ok(counted >= 3, `the runners check, a push and the polls are counted: ${counted}`);
  assert.match(githubLines[0], new RegExp(`^- \\S+ · github · ticket/1-x · ${counted} gh calls · left 4321/5000 as CI began$`));
  // A deploy whose restart isn't live by the time it ends.
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ COORDINATOR_SHARED_DIR: shared, FAKE_NOT_LIVE: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(timings(shared)[1], /· fallback - · deploy \d+ · live - · landed, not live yet$/);
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  assert.deepEqual(
    readdirSync(state).filter((f) => f.startsWith('times-')),
    [],
    "deploy.sh's times file goes at the end",
  );
});

test('a landing stopped while it waits for CI is logged as stopped there, not landed', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const child = spawn('bash', [land], {
    cwd: r.wt,
    env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), COORDINATOR_SHARED_DIR: shared, PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', FAKE_CI: 'running', LAND_CI_TIMEOUT: '60' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

test('a ship stopped before it has read the id of the run it pushed cancels that run, listed a moment late (#1894)', async () => {
  const s = await stopped({ LAND_CI_LATE: '20' }, waits, true);
  assert.deepEqual(cancels(s.calls), ['7']);
  assert.ok(!hubHas(s.r, 'land/ticket/1-x') && !hubHas(s.r, 'land-base/ticket/1-x'), 'the scratch branches go');
});

test("a stopped ship whose commit's red run from before is all GitHub lists yet waits for its own run, and cancels that (#1894)", async () => {
  // The old run is the answer to the gate's two asks and the stop's first two.
  const s = await stopped((r) => ({ FAKE_OLD_RUN: `${git(r.wt, 'rev-parse', 'HEAD')} completed failure`, FAKE_LAG: '3', FAKE_UNLISTED: '', LAND_CI_LATE: '20', LAND_CI_LATE_POLL: '0.2' }), waits);
  assert.deepEqual(cancels(s.calls), ['7']);
});

test("a stopped ship never cancels a run another branch's push started on its commit (#1894)", async () => {
  const s = await stopped({ FAKE_RUN_BRANCH: 'check/ticket/9-x', LAND_CI_LATE: '3' }, waits, true);
  assert.deepEqual(cancels(s.calls), []);
});
