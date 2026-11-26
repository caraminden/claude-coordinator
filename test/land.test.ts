// tools/land.sh itself: the rebase, its test run or CI gate, conflicts and refusals.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, landAsync, tickets, issued, ci, quietProc, stopShip } from './land-fixture.ts';
import { until } from './wait.ts';
const repo = join(import.meta.dirname, '..');

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
  for (const f of ['land.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs', 'citadel-heavy']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
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
  for (const f of ['land.sh', 'deploy-queue.sh', 'citadel-heavy']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(tools, f));
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

// #565: one line per landing with how long each phase took, landed or refused.
const timings = (shared: string) =>
  landLog(shared)
    .split('\n')
    .filter((l) => l.includes(' · timing · '));
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
    readFileSync(join(import.meta.dirname, '..', 'tools', f), 'utf8')
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

// #1894: stopping a ship ends the run it pushed, whose id it may not have read yet. `when` says when to stop it; then
// with `listed`, GitHub
// lists the run from after its clean-up's first look for it on (else never).
async function stopped(extra: Record<string, string> | ((r: ReturnType<typeof setup>) => Record<string, string>), when: (c: ReturnType<typeof ci>, r: ReturnType<typeof setup>) => boolean, listed = false) {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const seen = join(r.dir, 'listed');
  const child = spawn('bash', [land], {
    cwd: r.wt,
    env: {
      ...env,
      DEPLOY_LIVE: r.live,
      DEPLOY_SOURCE: r.source,
      DEPLOY_NOTE: join(r.dir, 'note'),
      PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`,
      LAND_CI: '1',
      LAND_CI_POLL: '2', // long beside a stop, so the gate's own polls don't read the run's id
      FAKE_CI: 'running',
      FAKE_UNLISTED: `b.txt ${seen}`,
      ...(typeof extra === 'function' ? extra(r) : extra),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  let ended = false;
  child.once('close', () => (ended = true));
  await until(
    'the moment to stop it',
    () => when(c, r),
    30_000,
    () => stderr,
  );
  const lines = () => c.calls().split('\n').filter(Boolean);
  const before = lines().length;
  stopShip(child.pid!);
  if (listed) {
    await until('its first look for the run', () => ended || lines().length > before);
    writeFileSync(seen, '');
  }
  await until(
    'land.sh to end',
    () => ended,
    undefined,
    () => stderr,
  );
  return { r, calls: lines(), after: lines().slice(before) };
}
const cancels = (calls: string[]) => calls.filter((x) => x.includes('-X POST') && x.endsWith('/cancel')).map((x) => /runs\/(\d+)\/cancel/.exec(x)?.[1]);
const hubHas = (r: ReturnType<typeof setup>, ref: string) => git(join(r.dir, 'hub.git'), 'for-each-ref', `refs/heads/${ref}`) !== '';
const waits = (c: ReturnType<typeof ci>, r: ReturnType<typeof setup>) => hubHas(r, 'land/ticket/1-x') && c.calls().split('head_sha=').length > 2;

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

test('a stopped ship whose run GitHub never lists ends within its cap, scratch branches gone (#1894)', async () => {
  const s = await stopped({ LAND_CI_LATE: '3', LAND_CI_LATE_POLL: '0.2' }, waits);
  assert.deepEqual(cancels(s.calls), []);
  assert.ok(!hubHas(s.r, 'land/ticket/1-x'));
});

test('a ship stopped before it pushed asks GitHub nothing on its way out (#1894)', async () => {
  const s = await stopped(
    (r) => {
      spawnSync('mkfifo', [join(r.dir, 'runners')]); // nothing is ever written to it, so the question before the push never ends
      return { FAKE_RUNNERS_FILE: join(r.dir, 'runners') };
    },
    (c) => c.calls().includes('/actions/runners '),
  );
  assert.deepEqual(s.after, []);
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
    return {
      status: res.status,
      stderr: res.stderr
        .replace(/\b[0-9a-f]{7,40}\b/g, 'H')
        .replace(/\d\d:\d\d/g, 'T')
        .replace(/\/\d+\//g, '/N/')
        .replace(/(passed in) \d+ s/g, '$1 N s')
        .replace(/its last \d+ run/g, 'its last N run'), // this file's ships share one history, so the second counts one more
    };
  });
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(runs[0].status, 0);
});

// #1912: judged and logged as a ship joins the line, never acted on (tools/quick-train.ts).
test('a ship logs whether it would ride the quick train, and ships the same either way', () => {
  const r = setup();
  r.commit(r.source, 'tools/pipeline-files.txt', 'p.txt\n');
  r.commit(r.source, 'tools/affected-map.txt', '*.txt: test/a.test.ts\n');
  const lines = (dir: string) => landLog(dir).match(/quick train · .*/g);
  const go = (n: number, file: string, risk: string) => {
    r.commit(r.wt, file, `${n}\n`);
    const shared = join(r.dir, `shared-${n}`);
    const res = r.run({ COORDINATOR_SHARED_DIR: shared, LAND_RISK: risk });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    assert.doesNotMatch(res.stdout + res.stderr, /quick train/, 'nothing of it reaches the landing itself');
    return lines(shared);
  };
  // The branch starts behind main and rebases onto it: the judge runs once, not again in the rebased copy.
  assert.deepEqual(go(1, 'b.txt', 'low'), ['quick train · ticket/1-x · would qualify']);
  assert.deepEqual(go(2, 'p.txt', 'low'), ['quick train · ticket/1-x · not: sensitive: pipeline (p.txt)']);
  assert.deepEqual(go(3, 'b.txt', ''), ['quick train · ticket/1-x · not: no risk label']);
  // A map that can't be read: the ship goes on, and the line says it wasn't judged.
  r.commit(r.source, 'tools/affected-map.txt', 'no colon here\n');
  assert.deepEqual(go(4, 'b.txt', 'low'), ['quick train · ticket/1-x · not: could not be judged']);
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
  assert.ok(
    c2
      .calls()
      .split('\n')
      .filter((l) => l.includes('head_sha')).length >= 4,
    'it polled past the old run',
  );
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
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
    'one run only',
  );
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');
  assert.equal(r.note(), null);
});

// #1240: a ship's CI run stops rerunning files alone when its answer is due, so a file left unrerun has no "passed
// alone" label: the run is a real red, refused at once, with no fresh run and no fallback to the suite here.
test("a red whose reruns alone were cut at CI's deadline is a real red: refused, not run again, not run here", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'due', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /busy\.test\.ts: not rerun: CI's answer is due.*\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
    'one run only',
  );
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
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
  assert.match(res.stderr, /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more on \w+, the land needs a fully green run\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  // src/flakes.ts parses these lines (a pipeline test can't import it; test/flakes.test.ts pins the same format).
  assert.match(res.stderr, /^land: flake: test\/busy\.test\.ts · in CI$/m);
  assert.match(res.stderr, /^land: flake: test\/slow\.test\.ts · in CI$/m);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
    'a second push, so a new run',
  );
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
  // Both runs red, both of flakes only, on a hand-off that already kept its place twice (#1419 part 2: before that it would
  // keep its place again; test/land-known-flakes.test.ts has those).
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared, LAND_FLAKE_KEPT: '2' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /running CI once more.*the red test's output \(run 8\).*tests failed on the rebased branch in CI again \(https:\/\/ci\/8\), on the one fresh run after a red whose files all passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\), so main is untouched/s);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
    'two runs, never three',
  );
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
  assert.match(
    res.stderr,
    /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\), but deleting land\/ticket\/1-x on GitHub to start a fresh run failed \(.*deletes refused.*\), so this stays red\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s,
  );
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
    'no second run asked for',
  );
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
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
  );

  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  const shared = join(r2.dir, 'shared');
  res = c2.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running CI once more.*CI FALLBACK: no runner started the job within 1s/s);
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · .* · no answer$/m);
  assert.equal(c2.localRuns(), 1, 'the fallback suite here had to pass');
});

// #1377 (#1372's report: run 44859457680 was interrupted at 55 s with no failing test, and a bisect refused #1302 for
// it): a run cut off from outside says nothing about the commit. It gets one fresh run; cut off again, it is no answer.
test('a run cut off before any test failed is no verdict: one fresh run decides, and a second cut-off is no answer', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  let res = c.run({ FAKE_CUT: '0 1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the CI run on \w+ was cut off before any test failed \(https:\/\/ci\/7\), so it says nothing about this commit: running CI once more\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|tests failed/);
  assert.match(landLog(shared), /· cut-off rerun · ticket\/1-x · https:\/\/ci\/7 · green$/m);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
  );
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');

  // Both cut off: no answer, so it falls back to the suite here, as for any CI that can't answer.
  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  const shared2 = join(r2.dir, 'shared');
  res = c2.run({ FAKE_CUT: '0 2', COORDINATOR_SHARED_DIR: shared2 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI was cut off twice before any test failed \(https:\/\/ci\/7, https:\/\/ci\/8\)/);
  assert.doesNotMatch(res.stderr, /tests failed/);
  assert.match(landLog(shared2), /· cut-off rerun · ticket\/1-x · https:\/\/ci\/7 · no answer$/m);
  assert.equal(
    c2
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
    'never a third run',
  );
  assert.equal(c2.localRuns(), 1, 'the fallback suite here had to pass');
});

test('a hang run-tests.sh stopped prints the same interrupt but is a real red: refused, not run again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'hung' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /a test hung.*\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /cut off|once more|CI FALLBACK/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
  );
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

// #1393: a run killed from outside (exit 137, the desktop's out-of-memory killer) before any test failed is a lost run,
// as #1377's cut-off one: run-tests.sh's killed line, or only GitHub's exit 137 line when the whole step was killed.
test('a CI run killed from outside before any test failed is no verdict: one fresh run decides', () => {
  for (const kind of ['killed', 'bare']) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    const res = c.run({ FAKE_CUT: '0 1', FAKE_CUT_KIND: kind, COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 0, `${kind}: ${res.stderr}`);
    assert.match(res.stderr, /the CI run on \w+ was cut off before any test failed \(https:\/\/ci\/7\), so it says nothing about this commit: running CI once more\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s, kind);
    assert.doesNotMatch(res.stderr, /CI FALLBACK|tests failed|a test hung/, kind);
    assert.match(landLog(shared), /· cut-off rerun · ticket\/1-x · https:\/\/ci\/7 · green$/m, kind);
  }
});

// #1864 (DR1): a runner that went away fails its job with no step of it failed, so the red says nothing about the commit.
test('a CI run that lost its runner is no verdict: one fresh run decides, and a second lost one is no answer', () => {
  for (const [cut, result, fallback] of [
    ['0 1', 'green', 0],
    ['0 2', 'no answer', 1],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    const res = c.run({ FAKE_CUT: cut, FAKE_CUT_KIND: 'lost', COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /the CI run on \w+ lost its runner before any step failed \(https:\/\/ci\/7\), so it says nothing about this commit: running CI once more/);
    assert.doesNotMatch(res.stderr, /tests failed/);
    if (fallback) assert.match(res.stderr, /CI FALLBACK: CI's one fresh run lost its runner before any step failed \(https:\/\/ci\/8\), after one that lost its runner before any step failed \(https:\/\/ci\/7\)/);
    assert.match(landLog(shared), new RegExp(`· cut-off rerun · ticket/1-x · https://ci/7 · ${result}$`, 'm'));
    assert.equal(c.localRuns(), fallback);
  }
});

test("a question about a red run that GitHub misses is asked again: the run's own step still decides", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: "the runner user's systemd", FAKE_STEP_MISS: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /failed in its setup step "the runner user's systemd"/);
});

// #1864 (LB6): the Windows port check runs after a green suite and measures the PC, not the change.
test("a run red only in the check of the PC's own ports counts as green, and says so", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: 'Windows ports left behind', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI's full suite passed on \w+, and then its check of the PC's own ports went red .*it counts as green \(https:\/\/ci\/7\)/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|tests failed/);
  assert.match(landLog(shared), /· CI ports red · ticket\/1-x · counted as green · https:\/\/ci\/7$/m);
  assert.equal(c.localRuns(), 0);
});

// The step's name in land.sh and land.local.sh is the workflow's.
test('the ports step land.sh counts as green is the one tests.yml runs after a green suite', () => {
  const name = (f: string) => /^(?:CITADEL_)?CI_PORTS_STEP='([^']+)'/m.exec(readFileSync(join(import.meta.dirname, '..', f), 'utf8'))?.[1];
  const step = name('tools/land.sh')!;
  assert.equal(name('tools/land.local.sh'), step);
  assert.match(readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'tests.yml'), 'utf8'), new RegExp(`- name: ${step}\n {8}if: \\$\\{\\{ success\\(\\) \\}\\}`));
});

test('a CI run killed from outside after a test had failed is a real red: refused, not run again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'killed-red' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/);
  assert.doesNotMatch(res.stderr, /cut off|once more|CI FALLBACK/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
  );
});

test('when CI cannot answer, it says so loudly, logs it, runs the suite here and lands', async (t) => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['no runner online', { FAKE_RUNNERS: '0' }, /no citadel-ci-linux runner is online/],
    ['GitHub down', { FAKE_CI: 'down' }, /GitHub didn't answer/],
    ['GitHub down, and it says nothing of the hour either (#1722)', { FAKE_CI: 'down', FAKE_QUOTA: 'down' }, /GitHub didn't answer/],
    ['the runner list fails', { FAKE_RUNNERS: 'down' }, /didn't say which runners are online/],
    ['no runner starts the job, and none is online', { FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' }, /no runner started the job within 1s, and no citadel-ci-linux runner is online/],
    ['a runner is online but starts no job in the longer bound', { FAKE_CI: 'queued', LAND_CI_START: '1', LAND_CI_START_ONLINE: '2' }, /no runner started the job within 2s, though a citadel-ci-linux runner is online/],
    ['the run never finishes', { FAKE_CI: 'running', LAND_CI_TIMEOUT: '1' }, /CI didn't finish within 1s of starting/],
    ['GitHub stops answering while CI runs (#1655)', { FAKE_CI: 'running', FAKE_CI_FAIL_AFTER: '2', LAND_CI_TIMEOUT: '4' }, /CI FALLBACK: GitHub didn't answer since \d\d:\d\d \(\d+ polls failed in a row\) \(gh: API rate limit exceeded.*, so it isn't known whether CI finished/],
    ['the run was cancelled', { FAKE_CI: 'cancelled' }, /ended as cancelled/],
    ['the run failed before the tests', { FAKE_CI: 'red', FAKE_STEP: "the runner user's systemd" }, /failed in its setup step "the runner user's systemd", before any test ran/],
    ["GitHub doesn't say which step failed (#1864)", { FAKE_CI: 'red', FAKE_STEP: 'down' }, /CI FALLBACK: GitHub didn't say which step of the red CI run failed \(https:\/\/ci\/7\), so it isn't known whether its tests are red/],
    ["GitHub doesn't send the red run's log (#1864)", { FAKE_CI: 'red', FAKE_LOG: 'down' }, /CI FALLBACK: GitHub didn't send the red CI run's log \(https:\/\/ci\/7\)/],
    ["the runner's clock stayed skewed", { FAKE_CI: 'red', FAKE_STEP: "the runner's clock" }, /CI FALLBACK: runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran/],
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
      assert.match(res.stderr, /={20,}\nland: CI FALLBACK: .*Running the full suite on perigee instead\.\nland: BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee \(#1443\)\nland: ={20,}\nland: running the tests/);
      assert.match(res.stderr, why);
      assert.match(res.stderr.trimEnd().split('\n').at(-1)!, /landed on perigee's own test run, not CI: /, 'the last line says it again');
      assert.match(landLog(shared), /^- \d\d:\d\d:\d\dZ · ci fallback · ticket\/1-x · /m);
      // #1722: once GitHub was asked at all, the fallback line ends with what was left of the hour.
      const left = extra.FAKE_QUOTA === 'down' ? 'unknown' : '4321/5000, resets in 25 min';
      if (extra.LAND_CI !== '0')
        assert.ok(
          landLog(shared)
            .split('\n')
            .some((l) => l.includes(' · ci fallback · ticket/1-x · ') && l.endsWith(` · GitHub calls left: ${left}`)),
          landLog(shared),
        );
      assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/m);
      assert.equal(c.localRuns(), 1);
      assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
      assert.equal(c.refs(), '', 'nothing is left on GitHub');
      // A run nobody waits for any more is cancelled, so it doesn't keep the one runner from the next landing.
      if (extra.FAKE_CI === 'queued' || extra.FAKE_CI === 'running') assert.match(c.calls(), /-X POST repos\/.*\/actions\/runs\/7\/cancel/);
      if (extra.LAND_CI === '0') assert.equal(c.calls(), '', 'GitHub is never asked');
      if (extra.FAKE_CI_FAIL_AFTER) assert.match(readFileSync(join(r.live, '.git', 'cc-deploy', 'gh-calls'), 'utf8'), /^\d+ ticket\/1-x api repos\/\S+\/actions\/runs/m, 'each gh call is counted with its landing (#1655)');
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
test('a refused landing lets go of the deploy lock before it cleans up on GitHub', { timeout: 60_000 }, async (t) => {
  const r = setup();
  const c = ci(r);
  // Deleting the scratch branch hangs until the test opens the gate, once it has seen the lock free (a fixed 8 s, twice, before #1615).
  const gate = join(r.dir, 'cleanup-go');
  writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), `#!/bin/sh\nwhile read old new ref; do [ "$new" != 0000000000000000000000000000000000000000 ] || until [ -e '${gate}' ]; do sleep 0.05; done; done\n`, { mode: 0o755 });
  r.commit(r.wt, 'b.txt', 'mine\n');
  const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
  let stderr = '';
  let ended = false;
  const landing = landAsync(r.wt, { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', FAKE_CI: 'red' }, 50_000, (e) => (stderr = e)).finally(() => (ended = true));
  t.after(async () => {
    writeFileSync(gate, '');
    await landing;
  }); // a failed wait below still lets the hook, and the landing, end
  await until(
    'the refusal',
    () => /tests failed on the rebased branch in CI/.test(stderr),
    30_000,
    () => stderr,
  );
  await until(
    'the lock to be free',
    () => spawnSync('flock', ['-n', lock, 'true']).status === 0,
    4_000,
    () => stderr,
  );
  assert.ok(!ended, 'freed while the cleanup still runs');
  writeFileSync(gate, '');
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
  let res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(down), 'the first landing leaves a note');
  const asked = c.calls();
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '30' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI gave no answer to a landing \d+ s ago \(no runner started the job within 1s, and no citadel-ci-linux runner is online .*\), so this one doesn't wait for it \(it is asked again from \d\d:\d\d\)/);
  assert.equal(c.calls(), asked, 'GitHub is not asked');
  assert.equal(c.localRuns(), 2);
  r.commit(r.wt, 'b.txt', 'three\n');
  res = c.run({ LAND_CI_DOWN: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed/);
  assert.ok(!existsSync(down), 'a green run takes the note away');
  assert.equal(c.localRuns(), 2);
});

// #1254 (Josh, 2026-11-20: "only if and when perigee has plenty of resources, just make sure we play nice"): the suite runs
// here only while perigee is quiet; until then the ship keeps waiting for CI, and a long busy spell refuses it.
const procAt = (r: ReturnType<typeof setup>, o?: Parameters<typeof quietProc>[1]) => {
  const proc = quietProc(join(r.dir, 'proc'), o);
  return { LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(r.dir, 'heavy') };
};
test("on a quiet perigee the fallback runs the suite in citadel-heavy's slot, named, and lands", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const p = procAt(r);
  const seen = join(r.dir, 'seen');
  const res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0', TEST_SEEN: seen, ...p });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: no runner started the job within 1s/);
  const cores = Number(spawnSync('nproc', { encoding: 'utf8' }).stdout.trim());
  // nice 19, and half run-tests.sh's usual (cores + 1) / 2 files at once (the fixture's empty CPU weight makes no scope).
  assert.equal(readFileSync(seen, 'utf8'), `nice 19 concurrency ${Math.floor((Math.floor((cores + 1) / 2) + 1) / 2)}\n`);
  assert.doesNotMatch(res.stderr, /perigee is busy/);
  assert.equal(c.localRuns(), 1);
  assert.match(readFileSync(join(p.CITADEL_HEAVY_DIR, 'history'), 'utf8'), /\tland\.sh's suite for ticket\/1-x \(CI fallback\)\t/, 'the run held the heavy slot');
});

// Each flips its world (CI answers, a runner comes back, perigee goes quiet) only once land.sh has said perigee is busy.
const once = (act: () => void) => {
  let done = false;
  return (s: string) => {
    if (!done && /perigee is busy/.test(s)) {
      done = true;
      act();
    }
  };
};

test('on a busy perigee the ship keeps waiting for CI, and lands on its answer without running the suite here', async () => {
  for (const [name, o] of [
    ['CPU pressure', { psi: 60 }],
    ['load', { load: 999 }],
    ['memory', { freePct: 5 }],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const gate = join(r.dir, 'ci-gate');
    const res = await c.runAsync(
      { FAKE_CI: 'green', FAKE_CI_GATE: gate, LAND_CI_TIMEOUT: '1', LAND_QUIET_POLL: '0.2', ...procAt(r, o) },
      once(() => writeFileSync(gate, '')),
    );
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stderr, /waiting for CI or a quiet perigee: CI: CI didn't finish within 1s of starting, but perigee is busy \(.+\), so this keeps asking CI/, name);
    assert.match(res.stderr, /CI passed/, name);
    assert.doesNotMatch(res.stderr, /CI FALLBACK/, name);
    assert.equal(c.localRuns(), 0, name);
  }
});

// The reruns alone get a window of their own (#1374): on Nov 20 a busy desktop's full run ended at the old limit, so its
// flakes were never rerun and counted as a real red. At its CI limit land.sh looks at the run's steps once.
const RERUNNING = 'the full suite\tcompleted\tfailure\nrerun failed files alone\tin_progress\t-\n';
test("a run rerunning its failed files alone at CI's limit gets the reruns' window, and a red of flakes only lands on its fresh run", async () => {
  // Reruns that ended in the moment between the gate's two looks count too: the next look reads the run's verdict.
  for (const steps of [RERUNNING, 'the full suite\tcompleted\tfailure\nrerun failed files alone\tcompleted\tsuccess\n']) await windowed(steps);
});
async function windowed(steps: string) {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const gate = join(r.dir, 'ci-gate');
  const told = (s: string) => /rerunning the failed files alone/.test(s) && !existsSync(gate) && writeFileSync(gate, '');
  // Quiet perigee: without the window it would fall back at the limit and run the suite here.
  const res = await c.runAsync({ FAKE_CI: 'red', FAKE_LOG: 'flakes', FAKE_CI_RERUN: 'green', FAKE_CI_GATE: gate, FAKE_STEPS: steps, LAND_CI_TIMEOUT: '1', LAND_CI_RERUN: '60', ...procAt(r) }, told);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to 1 min 0 s more for them instead of falling back at 1s/);
  assert.match(res.stderr, /running CI once more/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
}

test("a run still in its full suite at CI's limit falls back then, as before: the reruns' window is only for reruns under way", () => {
  for (const steps of ['the full suite\tin_progress\t-\nrerun failed files alone\tqueued\t-\n', '']) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = c.run({ FAKE_CI: 'running', FAKE_STEPS: steps, LAND_CI_TIMEOUT: '1', LAND_CI_RERUN: '600', ...procAt(r) });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /CI FALLBACK: CI didn't finish within 1s/);
    assert.doesNotMatch(res.stderr, /rerunning the failed files alone/);
    assert.equal(c.localRuns(), 1);
  }
});

test('reruns alone that outlast their window fall back at its end, once: the window is never extended again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'running', FAKE_STEPS: RERUNNING, LAND_CI_TIMEOUT: '1', LAND_CI_RERUN: '1', ...procAt(r) });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr.match(/rerunning the failed files alone/g)?.length, 1, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI didn't finish within \d+s of starting, its reruns alone included/);
  assert.equal(c.localRuns(), 1);
});

test('with no runner online and a busy perigee, the ship asks CI again until a runner is back, and lands on CI', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const runners = join(r.dir, 'runners');
  writeFileSync(runners, '0');
  const res = await c.runAsync(
    { FAKE_RUNNERS_FILE: runners, LAND_QUIET_POLL: '0.2', ...procAt(r, { load: 999 }) },
    once(() => writeFileSync(runners, '1')),
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI: no citadel-ci-linux runner is online.*but perigee is busy/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
});

test('a busy perigee that turns quiet runs the suite then, whether CI was waited on or never asked', async () => {
  for (const extra of [{ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' }, { LAND_CI: '0' }]) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const p = procAt(r, { psi: 60 });
    const res = await c.runAsync(
      { ...extra, ...p, LAND_QUIET_POLL: '0.2' },
      once(() => quietProc(p.LAND_QUIET_PROC)),
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /but perigee is busy \(CPU pressure 60% \(quiet is under 20%\)\).*CI FALLBACK/s);
    assert.equal(c.localRuns(), 1);
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  }
});

// quiet() reads the load to the hundredth, and a reading it can't take counts as busy.
test('quiet is under half the cores to the hundredth of a load, and a missing reading is busy', () => {
  const cores = Number(spawnSync('nproc', { encoding: 'utf8' }).stdout.trim());
  for (const [name, load, gone, busy] of [
    ['just under half', cores / 2 - 0.01, '', null],
    ['exactly half', cores / 2, '', new RegExp(`load ${(cores / 2).toFixed(2)} on ${cores} cores`)],
    ['no pressure file', 0, 'pressure/cpu', /no CPU pressure reading/],
    ['no meminfo', 0, 'meminfo', /no memory reading/],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const p = procAt(r, { load });
    if (gone) rmSync(join(p.LAND_QUIET_PROC, gone));
    const res = c.run({ LAND_CI: '0', LAND_QUIET_LIMIT: '0', ...p });
    if (busy) {
      assert.equal(res.status, 1, `${name}: ${res.stderr}`);
      assert.match(res.stderr, busy, name);
      assert.equal(c.localRuns(), 0, name);
    } else {
      assert.equal(res.status, 0, `${name}: ${res.stderr}`);
      assert.equal(c.localRuns(), 1, name);
    }
  }
});

test('CI with no answer and a perigee busy past the limit refuse the ship: main untouched, no suite run', async () => {
  for (const extra of [{ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' }, { LAND_CI: '0' }]) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const main = git(r.source, 'rev-parse', 'main');
    const heavy = join(r.dir, 'heavy');
    mkdirSync(heavy);
    // A heavy job holding the slot is busy too, and named.
    writeFileSync(join(heavy, 'slot-0.who'), 'peek #9 cargo test');
    const holder = spawn('flock', [join(heavy, 'slot-0'), 'sleep', '30'], { stdio: 'ignore' });
    try {
      await until('the slot is held', () => spawnSync('flock', ['-n', join(heavy, 'slot-0'), 'true']).status !== 0);
      const res = c.run({ ...extra, ...procAt(r), LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2' });
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, /CI and perigee both busy, try again: CI: .*; perigee for 0 min: perigee's heavy slot is taken \(peek #9 cargo test\)/);
      assert.match(res.stderr, /not your change: keeping its place.*refused by the pipeline again \(CI and perigee both busy for 0 min\), after its one retry in place/s, 'alone in line, it goes again once, then refuses');
      assert.doesNotMatch(res.stderr, /CI FALLBACK/);
      assert.equal(c.localRuns(), 0);
      assert.equal(git(r.source, 'rev-parse', 'main'), main);
    } finally {
      holder.kill();
    }
  }
});

// A test that takes the runner down: every run is red with no failed step, so each gate ends with no answer, from runs
// that did finish. The time CI runs for doesn't count as a busy perigee's (#1361), so the runs do.
for (const [what, env] of [
  ['', {}],
  [', its runner gone for the fresh run', { FAKE_RUNNERS_ODD: '1' }],
] as const) {
  test(`a run that ends without a verdict every time holds the line for three goes, not for ever${what} (#1864)`, async () => {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = await c.runAsync({ FAKE_CI: 'red', FAKE_STEP: 'lost', FAKE_CI_SLOW: '1', ...env, ...procAt(r, { load: 999 }), LAND_QUIET_POLL: '0.2' }, () => {});
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /refused by the pipeline \(CI's runs were lost or cut off 3 times, and perigee is busy\), not your change: keeping its place/);
    assert.match(res.stderr, /CI and perigee both busy, try again: CI: .*\(its runs were lost or cut off 3 times\); perigee/);
    assert.equal(c.localRuns(), 0);
  });
}

// #1360 (Cara, 2026-11-20, "Refused ships keep their place"): a refusal by the pipeline, not the ship's change, keeps its
// ticket and goes again once; alone in line it goes again at once (no ship to let by: land-train-riders.test.ts has the line).
const retries = (shared: string) =>
  landLog(shared)
    .split('\n')
    .filter((l) => l.includes(' · retry in place · '));
// A test file that fails on the runs FLAKY_FAIL names (1,3: the 1st and 3rd), counted in FLAKY_COUNT.
const flaky =
  "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.FLAKY_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if ((process.env.FLAKY_FAIL ?? '').split(',').includes(String(n))) throw new Error('flaky');\n}\n";

test('a ship refused because CI and perigee were both busy keeps its ticket, goes again, and lands on that run (#1360)', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const p = procAt(r, { load: 999 });
  let flipped = false;
  const res = await c.runAsync({ LAND_CI: '0', ...p, LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2', COORDINATOR_SHARED_DIR: shared }, (s) => {
    if (!flipped && /not your change/.test(s)) {
      flipped = true;
      quietProc(p.LAND_QUIET_PROC);
    }
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /refused by the pipeline \(CI and perigee both busy for 0 min\), not your change: keeping its place in line and riding the next train, once/);
  assert.match(res.stderr, /back at the front after its retry in place: starting over from the rebase.*CI FALLBACK/s);
  assert.equal(c.localRuns(), 1);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  assert.equal(issued(state), 1, 'the same ticket, not a new one at the back');
  assert.deepEqual(
    retries(shared).map((l) => l.replace(/^- \S+ /, '')),
    ['· retry in place · ticket/1-x · CI and perigee both busy for 0 min · landed'],
  );
  assert.equal(timings(shared).length, 1, 'one landing, one timing line');
});

test('a retry in place that then conflicts with main is refused, and its retro line says refused (#1360)', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'a.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const p = procAt(r, { load: 999 });
  let moved = false;
  const res = await c.runAsync({ LAND_CI: '0', LAND_SMOKE: '0', ...p, LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2', COORDINATOR_SHARED_DIR: shared }, (s) => {
    if (!moved && /not your change/.test(s)) {
      moved = true;
      r.commit(r.source, 'a.txt', 'theirs\n');
      quietProc(p.LAND_QUIET_PROC);
    }
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /back at the front after its retry in place.*rebase onto main failed/s);
  assert.match(retries(shared)[0] ?? '', /· retry in place · ticket\/1-x · CI and perigee both busy for 0 min · refused$/);
});

test("a ship whose suite couldn't start because the heavy slot was taken goes again once, and lands (#1360)", async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const p = procAt(r);
  mkdirSync(p.CITADEL_HEAVY_DIR, { recursive: true });
  // A deploy build going first holds citadel-heavy up without quiet() seeing it, as one that takes the slot after it looked.
  const first = join(p.CITADEL_HEAVY_DIR, 'first');
  writeFileSync(first, 'deploy build: npm ci\n');
  const fresh = setInterval(() => {
    if (existsSync(first)) writeFileSync(first, 'deploy build: npm ci\n');
  }, 200);
  try {
    const res = await c.runAsync({ LAND_CI: '0', ...p, LAND_HEAVY_MAX_WAIT: '1', COORDINATOR_SHARED_DIR: shared }, (s) => {
      if (/not your change/.test(s)) rmSync(first, { force: true });
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /refused by the pipeline \(perigee's heavy slot was taken\), not your change/);
    assert.equal(c.localRuns(), 1);
    assert.match(retries(shared)[0], /· retry in place · ticket\/1-x · perigee's heavy slot was taken · landed$/);
  } finally {
    clearInterval(fresh);
  }
});

// #1393: the suite here killed from outside before any test failed is the pipeline's, not the change's: it keeps its
// place and goes again once, as a red of flakes only does.
const killer =
  "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.KILL_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if ((process.env.KILL_ON ?? '').split(',').includes(String(n))) { process.kill(process.ppid, 'SIGKILL'); await new Promise(() => {}); }\n}\n";

test('a perigee run killed from outside before any test failed goes again once, and lands on a green run (#1393)', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'test/killer.test.mjs', killer);
  const shared = join(r.dir, 'shared');
  const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', KILL_COUNT: join(r.dir, 'count'), KILL_ON: '1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /run-tests: the tests were killed \(exit 137\)/);
  assert.match(res.stderr, /refused by the pipeline \(the suite on perigee was killed from outside before any test failed\), not your change/);
  assert.doesNotMatch(res.stderr, /a test hung|tests failed on the rebased branch/);
  assert.match(retries(shared)[0], /· retry in place · ticket\/1-x · the suite on perigee was killed from outside before any test failed · landed$/);
});

test('a perigee red of flakes only goes again once: green lands, red again refuses for good (#1360)', () => {
  for (const [fails, status, outcome] of [
    ['1', 0, 'landed'],
    ['1,3', 1, 'refused'],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'test/flaky.test.mjs', flaky);
    const shared = join(r.dir, 'shared');
    const main = git(r.source, 'rev-parse', 'main');
    const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: fails, COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, status, res.stderr);
    assert.match(res.stderr, /refused by the pipeline \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), not your change/);
    assert.equal(readFileSync(join(r.dir, 'count'), 'utf8'), fails === '1' ? '3' : '4', 'the full run and the rerun alone, twice over at most');
    assert.match(retries(shared)[0], new RegExp(`· retry in place · ticket/1-x · failed in the full run but passed alone on perigee: test/flaky\\.test\\.mjs · ${outcome}$`));
    if (status) {
      assert.match(res.stderr, /refused by the pipeline again \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), after its one retry in place.*tests failed on the rebased branch/s);
      assert.equal(git(r.source, 'rev-parse', 'main'), main, 'red stays red');
    }
  }
});

// Ultra review of the ship scripts, 2026-11-23 (#1693): the copy of land.sh a rebase hands over to (#500), or that
// starts over after main moved under the restart ahead, is the same hand-off. It counts its gh calls as the first copy
// does, and keeps the hand-off's one retry in place and its flake keeps rather than starting them over.
// newerLandOnMain: the worktree runs its own tools/land.sh, as a minion does, and main has a newer one its rebase brings in.
function newerLandOnMain(r: ReturnType<typeof setup>) {
  for (const f of readdirSync(join(repo, 'tools'), { withFileTypes: true })) if (f.isFile() && f.name !== 'deploy.sh') copyFileSync(join(repo, 'tools', f.name), join(r.source, 'tools', f.name));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real tools');
  git(r.wt, 'rebase', '-q', 'main');
  const script = join(r.source, 'tools', 'land.sh');
  writeFileSync(script, readFileSync(script, 'utf8') + '# newer\n');
  git(r.source, 'commit', '-qam', 'newer land.sh');
  return (extra: Record<string, string>) =>
    spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], {
      cwd: r.wt,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', TEST_RUNS: join(r.dir, 'test-runs'), ...extra },
    });
}

test('the copy a rebase hands over to counts its gh calls and keeps the flake keeps the hand-off has used', () => {
  const r = setup();
  ci(r);
  const run = newerLandOnMain(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', LAND_FLAKE_KEPT: '2', COORDINATOR_SHARED_DIR: join(r.dir, 'shared') });
  assert.equal(res.status, 1, res.stderr);
  const state = join(r.live, '.git', 'cc-deploy');
  assert.match(readFileSync(join(state, 'gh-calls'), 'utf8'), /^\d+ ticket\/1-x api repos\/\S+\/actions\/runs\?head_sha=/m, "the rebased copy's CI asks are counted (#1655)");
  assert.doesNotMatch(res.stderr + (existsSync(join(state, 'ci.err')) ? readFileSync(join(state, 'ci.err'), 'utf8') : ''), /command not found/);
  assert.match(res.stderr, /only flakes failed again \(test\/busy\.test\.ts, test\/slow\.test\.ts\), but it has kept its place 2 times already, so it is refused this time/);
  assert.doesNotMatch(res.stderr, /keeping its place in line/, 'the rebased copy counts the 2 keeps the first copy was handed');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('the copy a rebase hands over to keeps the one retry in place the hand-off has used', () => {
  const r = setup();
  ci(r);
  const run = newerLandOnMain(r);
  r.commit(r.wt, 'test/flaky.test.mjs', flaky);
  const main = git(r.source, 'rev-parse', 'main');
  const res = run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', LAND_RETRIED: 'an earlier refusal', COORDINATOR_SHARED_DIR: join(r.dir, 'shared') });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /refused by the pipeline again \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), after its one retry in place \(an earlier refusal\)/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('the copy that starts over after main moved under the restart ahead keeps the one retry in place the hand-off has used', () => {
  const r = setup();
  ci(r);
  newerLandOnMain(r);
  // Its first run moves main on (as a restart ahead rolled back does), so the gate's commit is stale and land.sh starts
  // over from the rebase; its second full run fails on a flake, which passes alone.
  r.commit(
    r.wt,
    'test/move.test.mjs',
    "import { execFileSync } from 'node:child_process';\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.MOVE_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if (n === 1) execFileSync('git', ['-C', process.env.MOVE_MAIN, 'commit', '-q', '--allow-empty', '-m', 'someone else']);\n  if (n === 2) throw new Error('flaky');\n}\n",
  );
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], {
    cwd: r.wt,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), LAND_CI: '0', LAND_SMOKE: '0', MOVE_COUNT: join(r.dir, 'count'), MOVE_MAIN: r.source, LAND_RETRIED: 'an earlier refusal', COORDINATOR_SHARED_DIR: join(r.dir, 'shared') },
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /while this waited \(the restart ahead was rolled back\): rebasing ticket\/1-x onto it and testing again/);
  assert.match(res.stderr, /refused by the pipeline again \(failed in the full run but passed alone on perigee: test\/move\.test\.mjs\), after its one retry in place \(an earlier refusal\)/);
});

// A CI fallback's suite first waits for perigee's heavy slot, up to the busy limit and citadel-heavy's load and memory
// waits, longer than the 15 min the line behind waits on an unchanged phase: so the phase moves on meanwhile.
test('a CI fallback moves its phase on while it waits for a heavy slot and runs, so the line behind sees progress', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  mkdirSync(join(r.dir, 'heavy'));
  const queue = join(r.live, '.git', 'cc-deploy', 'queue');
  const phases = new Set<string>();
  const look = setInterval(() => {
    for (const f of tickets(join(r.live, '.git', 'cc-deploy')))
      try {
        phases.add(readFileSync(join(queue, f), 'utf8').split('\n')[3]);
      } catch {}
  }, 50);
  try {
    // A box citadel-heavy calls busy (any pressure at all), for 3 s before it starts anyway.
    // Its own slot folder: with no past runs to judge by, the suite takes a slot rather than run at once.
    const res = await c.runAsync({ LAND_CI: '0', LAND_SMOKE: '0', CITADEL_HEAVY_DIR: join(r.dir, 'heavy'), CITADEL_HEAVY_MAX_PRESSURE: '0', CITADEL_HEAVY_LOAD_WAIT: '3', CITADEL_HEAVY_POLL: '0.2', LAND_PHASE_EVERY: '0.5' }, () => {});
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /the box is busy/);
  } finally {
    clearInterval(look);
  }
  const during = [...phases].filter((p) => p.startsWith('running the tests since'));
  assert.ok(
    during.some((p) => / min so far/.test(p)),
    `the phase moved on while it waited: ${[...phases].join(' | ')}`,
  );
});

test("a CI fallback's phase ticker leaves the reruns' phase alone once they start, so the line behind reads their counts", async () => {
  const r = setup();
  const c = ci(r);
  // Fails in the full run; alone, it takes a few ticks and passes, so the reruns' phase has to outlast them.
  r.commit(r.wt, 'test/slow-flake.test.mjs', flaky + "if (Number(readFileSync(f, 'utf8')) > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n");
  const queue = join(r.live, '.git', 'cc-deploy', 'queue');
  const seen: string[] = [];
  const look = setInterval(() => {
    for (const f of tickets(join(r.live, '.git', 'cc-deploy')))
      try {
        const p = readFileSync(join(queue, f), 'utf8').split('\n')[3];
        if (p && p !== seen.at(-1)) seen.push(p);
      } catch {}
  }, 50);
  try {
    const res = await c.runAsync({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', LAND_PHASE_EVERY: '0.3' }, () => {});
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /slow-flake\.test\.mjs: failed in the full run, passed alone/);
  } finally {
    clearInterval(look);
  }
  const rerun = seen.findIndex((p) => p.startsWith('rerunning 1 failed test file since'));
  assert.ok(rerun >= 0, `the reruns set their phase: ${seen.join(' | ')}`);
  // What follows is the land's own next step (a flake goes again from the rebase), never the ticker's count.
  assert.doesNotMatch(seen[rerun + 1] ?? '', /^running the tests since/, `the ticker wrote over the reruns' phase: ${seen.join(' | ')}`);
});

test('a perigee red with a real failure beside a flake refuses at once, with no retry (#1360)', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'test/flaky.test.mjs', flaky);
  const shared = join(r.dir, 'shared');
  const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', FAIL_TESTS: '1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /flaky\.test\.mjs: failed in the full run, passed alone/);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.doesNotMatch(res.stderr, /refused by the pipeline|retry in place/);
  assert.equal(retries(shared).length, 0);
});

test("a busy perigee doesn't take the recent no-answer note's shortcut: it asks CI again and waits for it", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'one\n');
  let res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0', ...procAt(r) });
  assert.equal(res.status, 0, res.stderr);
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ ...procAt(r, { load: 999 }) });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /so this one doesn't wait for it/);
  assert.match(res.stderr, /CI passed/);
  assert.equal(c.localRuns(), 1, 'only the first, quiet, landing ran the suite here');
});

// #900: a skewed runner clock lasts hours, and each landing spent a CI run on learning it again.
test("a red in the runner's clock step leaves the note, so the next landing doesn't spend a CI run on it", () => {
  const r = setup();
  const c = ci(r);
  const down = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'ci-down');
  r.commit(r.wt, 'b.txt', 'one\n');
  let res = c.run({ FAKE_CI: 'red', FAKE_STEP: "the runner's clock" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(down), 'the landing leaves a note');
  const asked = c.calls();
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ FAKE_CI: 'red', FAKE_STEP: "the runner's clock" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI gave no answer to a landing \d+ s ago \(runner clock: /);
  assert.equal(c.calls(), asked, 'GitHub is not asked');
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

test('a stale squash, which reverts what landed since the branch started, is refused until it names each undo (#677)', () => {
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
  const res = r.run({ LAND_SMOKE: '0' }); // the rebase under the lock, which smoke's check before the line would beat
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
  const res = r.run({ COORDINATOR_SHARED_DIR: shared, LAND_SMOKE: '0' }); // the rebase under the lock, as above
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed.*conflicted files: a\.txt\./);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const log = landLog(shared);
  assert.match(log, new RegExp(`^- \\d\\d:\\d\\d:\\d\\dZ · land conflict · ticket/1-x onto ${main.slice(0, 7)}: a\\.txt$`, 'm'));
  assert.deepEqual(
    timings(shared).map((l) => l.replace(/^- \S+ · /, '').replace(/\d+/g, 'N')),
    ['timing · ticket/N-x · line N · rebase N · ci-queue - · ci-run - · fallback - · deploy - · live - · refused at rebase'],
  );
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
    const res = r.run({ COORDINATOR_SHARED_DIR: shared, LAND_SMOKE: '0' }); // the rebase under the lock, as above
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rebase onto main failed/);
    assert.equal(git(r.source, 'rev-parse', 'main'), main);
    assert.equal(git(r.wt, 'status', '--porcelain'), '');
  }
});

// The smoke check (#1012): before the line, so its refusals never wait in it. Its tests run through the branch's own
// tools/citadel-test, a stand-in here that notes each run's arguments on a line ("alone" for a failed file's rerun
// without the always-tests) and answers as told.
// #1240: the guard tests run on the rebased commit, before a CI run is spent. A stand-in citadel-test fails when
// GUARD_EXIT is set, and logs what it was asked to run.
function guardSetup() {
  const r = setup();
  const c = ci(r);
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
echo "\${CITADEL_TEST_ALWAYS:-} $*" >>"$GUARD_ARGS"
[ -z "\${GUARD_EXIT:-}" ] || { echo "✖ test/schema-compat.test.ts:40 › each schema number is used once"; echo "  SCHEMA_HISTORY 212 is taken twice"; echo "full output: /somewhere/citadel-test.log"; exit "$GUARD_EXIT"; }
`,
  );
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  // Built, not quoted: a quoted test file's name reads as a dependency to test/pipeline-files.test.ts.
  for (const g of ['schema-compat', 'ui-contract']) writeFileSync(join(r.source, 'test', `${g}.test.ts`), '');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'guard tools');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const args = join(r.dir, 'guard-args');
  const shared = join(r.dir, 'shared');
  const run = (extra: Record<string, string> = {}) => c.run({ GUARD_ARGS: args, COORDINATOR_SHARED_DIR: shared, LAND_SMOKE: '0', FAKE_CI: 'green', ...extra });
  const ran = () => (existsSync(args) ? readFileSync(args, 'utf8').trim() : '');
  return { ...r, c, run, ran, shared };
}

test('a guard test that fails on the rebased branch refuses before any push to land/*, with its own message, and no CI run is spent (#1240)', () => {
  const r = guardSetup();
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ GUARD_EXIT: '1' });
  assert.equal(res.status, 1);
  assert.equal(r.ran(), '/dev/null --timeout 120 test/schema-compat.test.ts test/ui-contract.test.ts', 'only the guards the repo has, without the always-tests');
  assert.match(res.stderr, /land: guard: ✖ test\/schema-compat\.test\.ts:40 › each schema number is used once\nland: guard:   SCHEMA_HISTORY 212 is taken twice\n/);
  assert.match(res.stderr, /guard tests failed on \w+, the branch rebased onto main \(output above\), so no CI run was spent and main is untouched/);
  assert.doesNotMatch(res.stderr, /full output|waiting for CI|CI FALLBACK/);
  assert.equal(r.c.calls(), '', 'GitHub never asked, nothing pushed');
  assert.equal(r.c.refs(), '');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.match(landLog(r.shared), /· guard · ticket\/1-x · test\/schema-compat\.test\.ts · \d+s$/m);
  assert.match(landLog(r.shared), /· timing · ticket\/1-x · .* · refused at guards$/m);
});

test('guard tests that pass, or cannot decide, let the land go on to CI (#1240)', () => {
  let r = guardSetup();
  let res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /guard tests passed on \w+ in \d+ s\n(.*\n)*.*waiting for CI/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  r = guardSetup();
  res = r.run({ GUARD_EXIT: '124' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the guard tests couldn't run or ran past 120 s \(exit 124\), so they don't decide: CI runs them/);
});

function smokeSetup() {
  const r = setup();
  writeFileSync(join(r.source, 'tools', 'always-tests.txt'), '# repo-wide\n\ntest/always.test.ts\n');
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
echo "\${CITADEL_TEST_ALWAYS:+alone }$*" >>"$SMOKE_ARGS"
sleep "\${SMOKE_SLEEP:-0}"
code=\${SMOKE_EXIT:-}; [ -z "\${CITADEL_TEST_ALWAYS:-}" ] || code=\${SMOKE_ALONE_EXIT-$code}
[ -z "$code" ] || [ "$code" = 0 ] || { echo "✖ test/always.test.ts:3 › a snapshot"; echo "full output: /somewhere/citadel-test.log"; exit "$code"; }
`,
  );
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  writeFileSync(join(r.source, 'test', 'always.test.ts'), '');
  writeFileSync(join(r.source, 'test', 'gone.test.ts'), '');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'smoke tools');
  git(r.wt, 'rebase', '-q', 'main');
  writeFileSync(join(r.wt, 'test', 'mine.test.ts'), '');
  git(r.wt, 'rm', '-q', 'test/gone.test.ts');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const args = join(r.dir, 'smoke-args');
  const shared = join(r.dir, 'shared');
  const smoke = (extra: Record<string, string> = {}) => r.run({ SMOKE_ARGS: args, COORDINATOR_SHARED_DIR: shared, ...extra });
  const ran = () => (existsSync(args) ? readFileSync(args, 'utf8').trim().split('\n') : []);
  return { ...r, smoke, ran, shared };
}

test('the smoke check refuses a conflict before the line: a smoke line in the retro log, no timing line, the lock never taken (#1012)', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /by git merge-tree before the line, so nothing landed; conflicted files: a\.txt\./);
  assert.match(res.stderr, /^land: smoke: it conflicts with main, before the line \(\d+ s\), so nothing landed and nobody waited on it\./m);
  assert.doesNotMatch(res.stderr, /^queue: /m, 'it never got in line');
  assert.equal(r.note(), null, 'no deploy ran');
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.deepEqual(timings(shared), []);
  assert.match(landLog(shared), /^- \S+ · smoke · ticket\/1-x · it conflicts with main · \d+s$/m);
  assert.match(landLog(shared), /· land conflict · ticket\/1-x onto \w+: a\.txt · before the line$/m, 'the conflict line the architecture check counts');
});

test("the smoke check runs the always-tests and the branch's changed test files, and refuses a red one before the line (#1012)", () => {
  const r = smokeSetup();
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.smoke({ SMOKE_EXIT: '1' });
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(r.ran(), ['--timeout 300 test/always.test.ts test/mine.test.ts', 'alone --timeout 300 test/always.test.ts'], 'not the deleted test, not the comment or blank line; then the failed file alone');
  assert.match(res.stderr, /^land: smoke: ✖ test\/always\.test\.ts:3 › a snapshot$/m);
  assert.doesNotMatch(res.stderr, /full output/, "citadel-test's log is the land's runner's, not the minion's");
  assert.match(res.stderr, /^land: smoke: tests failed \(exit 1\), before the line \(\d+ s\), so nothing landed/m);
  assert.doesNotMatch(res.stderr, /^queue: /m);
  assert.equal(r.note(), null);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.deepEqual(timings(r.shared), []);
  assert.match(landLog(r.shared), /· smoke · ticket\/1-x · tests failed \(exit 1\) · \d+s$/m);
});

test('the smoke check adds the @pinned tests (the route test, list-reads, the boot check) only when the affected map picks them for what the branch changed (#1544, #2037)', () => {
  const route = 'access-matrix';
  const run = (changed: string, edit = (m: string) => m) => {
    const r = smokeSetup();
    copyFileSync(join(repo, 'tools', 'affected.ts'), join(r.source, 'tools', 'affected.ts'));
    writeFileSync(join(r.source, 'tools', 'affected-map.txt'), edit(readFileSync(join(repo, 'tools', 'affected-map.txt'), 'utf8')));
    // built, not quoted: a quoted test name reads as an import to test/pipeline-files.test.ts
    for (const t of [route, 'list-reads', 'boot-check']) writeFileSync(join(r.source, 'test', `${t}.test.ts`), '');
    git(r.source, 'add', '-A');
    git(r.source, 'commit', '-qm', 'map');
    git(r.wt, 'rebase', '-q', 'main');
    mkdirSync(dirname(join(r.wt, changed)), { recursive: true });
    r.commit(r.wt, changed, 'x\n');
    assert.equal(r.smoke().status, 0);
    return r.ran()[0];
  };
  assert.match(run('src/http.ts'), new RegExp(`test/mine\\.test\\.ts test/${route}\\.test\\.ts$`));
  assert.doesNotMatch(run('notes/c.txt'), new RegExp(route));
  // #2037: the map's other @pinned tests (list-reads, the boot check) join the same way, for the paths that pick them.
  assert.match(run('src/runner.ts'), /test\/mine\.test\.ts test\/boot-check\.test\.ts test\/list-reads\.test\.ts$/);
  // A map from before @pinned: the route test alone, as before.
  assert.match(
    run('src/http.ts', (m) => m.replace(/^@pinned .*\n/m, '')),
    new RegExp(`test/${route}\\.test\\.ts$`),
  );
  assert.doesNotMatch(
    run('src/runner.ts', (m) => m.replace(/^@pinned .*\n/m, '')),
    /list-reads|boot-check/,
  );
  // A map that can't answer runs every @pinned test, never skips one.
  assert.match(
    run('notes/c.txt', (m) => `${m}a line that is no rule\n`),
    new RegExp(`test/${route}\\.test\\.ts test/list-reads\\.test\\.ts test/boot-check\\.test\\.ts$`),
  );
});

test("a clean smoke check lands as before, its time outside the timing line; tests past the limit don't decide; LAND_SMOKE=0 skips it (#1012)", () => {
  const r = smokeSetup();
  const res = r.smoke({ SMOKE_SLEEP: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /^land: smoke: passed in \d+ s$/m);
  assert.deepEqual(r.ran(), ['--timeout 300 test/always.test.ts test/mine.test.ts']);
  assert.equal(timings(r.shared).length, 1, landLog(r.shared));
  // The same line as before the smoke check, and its 2 s are not in the line's time.
  assert.match(timings(r.shared)[0], /· timing · ticket\/1-x · line [01] · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/);
  assert.doesNotMatch(landLog(r.shared), / · smoke · /, 'a pass logs nothing');

  const slow = smokeSetup();
  const late = slow.smoke({ SMOKE_EXIT: '124', LAND_SMOKE_TIMEOUT: '7' });
  assert.equal(late.status, 0, late.stderr);
  assert.deepEqual(slow.ran(), ['--timeout 7 test/always.test.ts test/mine.test.ts'], 'a hang is never rerun');
  assert.match(late.stderr, /smoke: the tests ran past 7 s, so they don't decide: getting in line, and CI runs them all/);

  const broken = smokeSetup();
  const setupError = broken.smoke({ SMOKE_EXIT: '2' });
  assert.equal(setupError.status, 0, setupError.stderr);
  assert.match(setupError.stderr, /smoke: citadel-test couldn't run the tests \(exit 2\), so they don't decide: getting in line/);

  // A file that fails in the run and passes alone is a likely flake: it gets a flake line and doesn't decide.
  const flaky = smokeSetup();
  const flake = flaky.smoke({ SMOKE_EXIT: '1', SMOKE_ALONE_EXIT: '0' });
  assert.equal(flake.status, 0, flake.stderr);
  assert.match(flake.stderr, /smoke: test\/always\.test\.ts failed, then passed alone: likely load, not your change/);
  assert.match(landLog(flaky.shared), /· flake · test\/always\.test\.ts · smoke · ticket\/1-x$/m);
  assert.match(flake.stderr, /^land: flake: test\/always\.test\.ts · smoke$/m);
  assert.doesNotMatch(landLog(flaky.shared), /^- \S+ · smoke · /m, 'no smoke refusal');

  const off = smokeSetup();
  assert.equal(off.smoke({ SMOKE_EXIT: '1', LAND_SMOKE: '0' }).status, 0);
  assert.deepEqual(off.ran(), []);
});

// #1983: eight ships on 2026-11-25 waited up to 70 minutes in line to hear they were over the size list. The real repo-wide
// list and the real size test (its list of allowed giants emptied: the fixture has none of them), run by the real citadel-test.
test('a branch over the file size limit is refused by the smoke check, before the line (#1983)', () => {
  const r = setup();
  const size = `test/${'size-budget'}.test.ts`; // built, not quoted: test/pipeline-files.test.ts reads quoted test names
  for (const f of ['tools/citadel-test', 'tools/citadel-test-reporter.ts', 'tools/citadel-node', 'tools/citadel-node.cjs', 'tools/mem-room', 'test/leak-guard.ts', 'test/leak-file.ts', 'package.json', size]) cpSync(join(repo, f), join(r.source, f));
  const real = readFileSync(join(repo, size), 'utf8');
  const bare = real.replace(/(export const ALLOWED[^\n]* = \{)\n[^]*?\n\};/, '$1};');
  assert.notEqual(bare, real);
  writeFileSync(join(r.source, size), bare);
  const listed = readFileSync(join(repo, 'tools/always-tests.txt'), 'utf8').split('\n');
  writeFileSync(join(r.source, 'tools/always-tests.txt'), `${listed.filter((l) => l === size).join('\n')}\n`);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'size check');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'tools/big.sh', ':\n'.repeat(1501));
  const main = git(r.source, 'rev-parse', 'main');
  const own = { CITADEL_TEST_EXTRA: '0', TMPDIR: r.dir };
  const res = r.run(own);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /^land: smoke: .*tools\/big\.sh: 1501 lines, limit 1500/m);
  assert.match(res.stderr, /^land: smoke: tests failed \(exit 1\), before the line/m);
  assert.doesNotMatch(res.stderr, /^(queue|land: rebasing)/m, 'it never got in line');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  r.commit(r.wt, 'tools/big.sh', ':\n'.repeat(1500));
  const ok = r.run(own);
  assert.equal(ok.status, 0, ok.stderr);
});

test('a commit that lost its #N: title is refused by the smoke check, before the line; a branch with no #N titles is not (#1983)', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  git(r.wt, 'commit', '-q', '--amend', '-m', 'lost it');
  git(r.wt, 'commit', '-q', '--allow-empty', '-m', '#1: kept');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^land: smoke: commit [0-9a-f]+ \("lost it"\) lost its #N: title/m);
  assert.match(res.stderr, /^land: smoke: a commit title is wrong, before the line \(\d+ s\), so nothing landed and nobody waited on it\./m);
  assert.doesNotMatch(res.stderr, /^(queue|land: rebasing)/m, 'it never got in line');
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.match(landLog(shared), /· smoke · ticket\/1-x · a commit title is wrong · \d+s$/m);
  // The check at the front stays, for what the line or the rebase changed.
  const late = r.run({ LAND_SMOKE: '0' });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /^land: rebasing [^]*lost its #N: title/m);
  git(r.wt, 'reset', '-q', '--hard', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n'); // "b.txt: mine": no title of it starts "#N"
  assert.equal(r.run().status, 0);
});

test('the smoke check does not blame a title the rebase leaves out: one main has cherry-picked, or one that came off main (#1983)', () => {
  for (const kind of ['cherry-picked', 'taken back']) {
    const r = setup();
    r.commit(r.wt, 'x.txt', 'no number in this title');
    const x = git(r.wt, 'rev-parse', 'HEAD');
    if (kind === 'cherry-picked') {
      r.commit(r.source, 'm.txt', 'main moved');
      git(r.source, 'cherry-pick', x);
    } else {
      const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
      mkdirSync(state);
      writeFileSync(join(state, 'taken-back'), `${x} ticket/9-other\n`);
    }
    r.commit(r.wt, 'b.txt', 'mine\n');
    git(r.wt, 'commit', '-q', '--amend', '-m', '#1: mine');
    const res = r.run();
    assert.equal(res.status, 0, `${kind}: ${res.stderr}`);
    assert.equal(git(r.source, 'log', '-1', '--format=%s'), '#1: mine');
  }
});

test("the smoke check refuses a .ts file that doesn't parse, by the branch's tools/parse-check.ts (#1012)", () => {
  const r = setup();
  writeFileSync(join(r.wt, 'tools', 'parse-check.ts'), "console.log('src/x.ts does not parse (Expected a semicolon)'); process.exit(1);\n");
  git(r.wt, 'add', '-A');
  git(r.wt, 'commit', '-qm', 'a parse check that finds one');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /^land: smoke: src\/x\.ts does not parse \(Expected a semicolon\)$/m);
  assert.match(res.stderr, /^land: smoke: a \.ts file does not parse, before the line/m);
  assert.equal(r.note(), null);
});

test('--check (#770) says whether the rebase onto main would conflict, naming the files, and changes nothing', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'b.txt', 'clean\n');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  let res = r.run({}, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  res = r.run({ COORDINATOR_SHARED_DIR: shared }, ['--check']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, new RegExp(`^land: ticket/1-x won't rebase onto main \\(${main.slice(0, 7)} "a\\.txt: theirs"\\) cleanly, by git merge-tree at hand-off, so nothing landed; conflicted files: a\\.txt\\. On conflicts: run git rebase main, resolve them`));
  assert.match(landLog(shared), new RegExp(`^- \\d\\d:\\d\\d:\\d\\dZ · land conflict · ticket/1-x onto ${main.slice(0, 7)}: a\\.txt · at hand-off$`, 'm'));
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.ok(!existsSync(state), 'no lock, line or state');
  assert.equal(r.note(), null, 'no deploy');
});

test('--check leaves behind a commit that came off main, as the rebase does, and checks --into against the build', () => {
  const r = setup();
  const before = git(r.source, 'rev-parse', 'main');
  r.commit(r.source, 'a.txt', 'rolled back\n');
  const u = git(r.source, 'rev-parse', 'main');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  git(r.source, 'reset', '-q', '--keep', before);
  r.commit(r.source, 'a.txt', 'redone\n');
  assert.equal(r.run({}, ['--check']).status, 3, 'carried along, the commit that came off main would conflict');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  mkdirSync(state);
  writeFileSync(join(state, 'taken-back'), `${u} ticket/9-other\n`);
  let res = r.run({}, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  // --into: against the build, not main, and only when the branch isn't on the build's tip already.
  git(r.source, 'branch', 'build/1', before);
  res = r.run({}, ['--check', '--into', 'build/1', 'test/ok.test.mjs']);
  assert.equal(res.status, 0, res.stderr);
  git(r.source, 'checkout', '-q', 'build/1');
  r.commit(r.source, 'b.txt', "the build's\n");
  git(r.source, 'checkout', '-q', 'main');
  res = r.run({}, ['--check', '--into', 'build/1', 'test/ok.test.mjs']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /won't rebase onto build\/1 .*conflicted files: b\.txt\. On conflicts: run git rebase build\/1/);
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
// holding the deploy lock held up every other landing (#499): a landing CI answers never touches a slot. One CI can't
// answer waits for a quiet perigee (#1254), the free slot included, and is refused after LAND_QUIET_LIMIT, not an hour.
test('two landings both land on CI while other jobs hold every heavy slot', async () => {
  const r = setup();
  const c = ci(r);
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
    await until('the lock to be held', async () => spawnSync('flock', ['-n', join(heavy, 'slot-0'), 'true']).status !== 0);
    for (const wt of [r.wt, wt2]) {
      const res = c.run({ CITADEL_HEAVY_DIR: heavy }, [], wt);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /CI passed/);
      assert.doesNotMatch(res.stderr, /heavy slot|perigee is busy/, 'it never waited on the build');
    }
    assert.deepEqual(git(r.source, 'log', '--format=%s', 'main').split('\n').sort(), ['b.txt: one', 'base', 'c.txt: two']);
  } finally {
    try {
      process.kill(-build.pid!, 'SIGKILL');
    } catch {}
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

// merge-tree reads .gitattributes from the worktree it runs in, but the rebase sees main's: a union file main gained
// after the branch forked must not make --check refuse a branch that appends to it too.
test("--check reads main's .gitattributes, so both appending to a union file is no conflict", () => {
  const r = setup();
  r.commit(r.wt, 'log.md', 'base\nmine\n');
  for (const d of [r.wt, r.source]) mkdirSync(join(d, 'docs'));
  r.commit(r.wt, 'docs/notes.md', 'base\nmine\n');
  r.commit(r.source, '.gitattributes', 'log.md merge=union\n');
  r.commit(r.source, 'log.md', 'base\ntheirs\n');
  r.commit(r.source, 'docs/.gitattributes', 'notes.md merge=union\n'); // a folder's own, as git reads it
  r.commit(r.source, 'docs/notes.md', 'base\ntheirs\n');
  // Conflict prep off: its rebase in a scratch checkout reads main's .gitattributes either way, so it would hide a wrong
  // verdict from the merge-tree trial itself (git before 2.40 ignores attr.tree, #2071).
  for (const prep of ['1', '0']) {
    const res = r.run({ LAND_PREP: prep }, ['--check']);
    assert.equal(res.status, 0, `LAND_PREP=${prep}: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /conflicts with main/, `LAND_PREP=${prep}`);
  }
});

// #1361 (Cara 2026-11-20, "Wait for a busy desktop"): while a runner is online, a ship waits LAND_CI_START_ONLINE for
// it to start the job, not LAND_CI_START; only no runner online (or GitHub erring) writes ci-down. Here 1 s stands for
// the 90 s, and a job that starts a few seconds in stands for one that starts 5 min in, after another ship's run.
const startsLater = (file: string, ms = 2500) => {
  let done = false;
  return (s: string) => {
    if (done || !/runner is online but hasn't started the job/.test(s)) return;
    done = true;
    setTimeout(() => {
      writeFileSync(file, 'running');
      setTimeout(() => writeFileSync(file, 'green'), 500);
    }, ms);
  };
};
const ciDown = (r: ReturnType<typeof setup>) => join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'ci-down');

test('a runner online but busy past the short bound: the ship waits for it, lands on CI, runs no suite here and writes no ci-down', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(r.dir, 'ci-state');
  writeFileSync(state, 'queued');
  const shared = join(r.dir, 'shared');
  const res = await c.runAsync({ FAKE_CI_FILE: state, LAND_CI_START: '1', LAND_CI_START_ONLINE: '60', LAND_CI_ONLINE_POLL: '0', COORDINATOR_SHARED_DIR: shared, ...procAt(r) }, startsLater(state));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /a citadel-ci-linux runner is online but hasn't started the job \(busy with another run, most likely\), so this waits for it: up to 1 min/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|no runner started/);
  assert.equal(c.localRuns(), 0, 'no suite on perigee');
  assert.ok(!existsSync(ciDown(r)), 'no ci-down note');
  const queued = Number(landLog(shared).match(/· timing · ticket\/1-x · .* · ci-queue (\d+) · /)?.[1]);
  assert.ok(queued >= 2, `it waited past the 1 s bound in the queue (${queued} s)`);
});

test('a busy perigee: the busy limit counts no time while a runner is online and CI still waits on it', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(r.dir, 'ci-state');
  writeFileSync(state, 'queued');
  // A 1 s busy limit: before #1361 the wait past the short bound counted, and this ship was refused.
  const res = await c.runAsync({ FAKE_CI_FILE: state, LAND_CI_START: '1', LAND_CI_START_ONLINE: '60', LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2', ...procAt(r, { load: 999 }) }, startsLater(state));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /both busy|not your change|CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
});

test('a late start or a slow run falls back on a quiet perigee but leaves no ci-down, so the next ship asks CI; no runner online leaves one', () => {
  for (const [name, extra] of [
    ['late start', { FAKE_CI: 'queued', LAND_CI_START: '0', LAND_CI_START_ONLINE: '1' }],
    ['slow run', { FAKE_CI: 'running', LAND_CI_TIMEOUT: '1' }],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'one\n');
    let res = c.run({ ...extra, ...procAt(r) });
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stderr, /CI FALLBACK: (no runner started the job within 1s, though a citadel-ci-linux runner is online|CI didn't finish within 1s of starting)/, name);
    assert.ok(!existsSync(ciDown(r)), `${name}: no ci-down note`);
    r.commit(r.wt, 'b.txt', 'two\n');
    res = c.run({ ...procAt(r) });
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stderr, /CI passed/, `${name}: the next ship asked CI`);
    assert.equal(c.localRuns(), 1, name);
  }
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'one\n');
  const t0 = Date.now();
  const res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', LAND_CI_START_ONLINE: '60', FAKE_RUNNERS_WAIT: '0', ...procAt(r) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: no runner started the job within 1s, and no citadel-ci-linux runner is online/);
  assert.ok(Date.now() - t0 < 30_000, 'it fell back at the short bound, not the long one');
  assert.ok(existsSync(ciDown(r)), 'no runner online: the note is written');
});
