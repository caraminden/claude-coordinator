// The ship train (#1166, tools/land.sh): the landing at the front of the line takes the plain lands waiting behind it,
// tests them in one CI run and ships them in one deploy; a red train keeps splitting until the bad ship is found (land-train-split.test.ts).
// This file: guard runs, flakes, cut-off runs, CI with no answer, restarts and retried fronts (split from land-train.test.ts, #1723).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen, setup, tickets, issued, quietProc } from './land-fixture.ts';
import { line, shipped, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';

// #1479: the guard tests (land.sh's guards(), #1240) on the train, not just its front. On Nov 21, 03:46 to 04:20 PST,
// #1460 rode trains with a break of the one-until guard that passed on its front in 1 s, and it took 6 CI runs to
// refuse it. A stand-in citadel-test: the guard run (the one naming the one-until guard) fails on a commit whose
// test/loop-lag.test.ts says "sleep", and logs "guard <commit> <exit>" for each guard run into the fake gh's call log,
// so a test can see whether a commit's guard run came before CI was asked about it.
// Built, not quoted: a quoted test file's name reads as a dependency to test/pipeline-files.test.ts.

const oneUntil = `test/${'one-until'}.test.ts`;
function guarded(r: ReturnType<typeof setup>) {
  mkdirSync(join(r.source, 'test'), { recursive: true });
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
case " $* " in *" ${oneUntil} "*) ;; *) exit 0 ;; esac
rc=0
if [ -n "\${GUARD_SLOW:-}" ] && [ -e f4.txt ]; then sleep "$GUARD_SLOW"; fi # a train with ship 4 on it
! grep -qs sleep test/loop-lag.test.ts || { echo "✖ ${oneUntil}:22 › loop-lag.test.ts has 5 \\\`sleep\\\` hits, the baseline allows 3"; echo "full output: /somewhere/citadel-test.log"; rc=1; }
if [ "$rc" = 1 ] && [ -n "\${GUARD_LATE:-}" ] && [ ! -e "$GUARD_LATE" ]; then : >"$GUARD_LATE"; rc=124; fi
echo "guard $(git rev-parse HEAD) $rc" >>"$GUARD_LOG"
exit $rc
`,
    { mode: 0o755 },
  );
  writeFileSync(join(r.source, oneUntil), '');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'guard tools');
}
const guardEnv = (extra: Record<string, string>) => (dir: string) => ({ GUARD_LOG: join(dir, 'gh-calls'), LAND_SMOKE: '0', ...extra });
const guardRuns = (l: { c: { calls: () => string } }) =>
  l.c
    .calls()
    .split('\n')
    .filter((s) => s.startsWith('guard '))
    .map((s) => s.split(' ').slice(1));

test('a rider that breaks a guard test is refused on the guard run on the train, before any CI run, and the riders after it still ride (#1479)', async () => {
  const l = await line([{}, {}, {}, { change: ['test/loop-lag.test.ts', '// sleep\n'] }, {}], guardEnv({ FAKE_RED_PATH: 'test/loop-lag.test.ts' }), guarded);
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /loop-lag\.test\.ts has 5 `sleep` hits/, 'the guard output, on its own stderr');
  assert.match(done[3].stderr, /the guard tests failed on ticket\/2-x's ship train in test\/one-until\.test\.ts with ticket\/4-x on it and passed on the train before it, so it is the cause, and it was taken off the train before any CI run/);
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the culprit is as it was');
  assert.match(done[1].stderr, /the guard tests failed on the ship train's top .* with ticket\/4-x on it/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 2, "ship 1's and the train's: none on a commit with ship 4's change");
  const red = guardRuns(l)
    .filter(([, rc]) => rc === '1')
    .map(([c]) => c);
  assert.ok(red.length > 0, 'the guards ran on a commit with ship 4 on it');
  for (const c of red) assert.doesNotMatch(l.c.calls(), new RegExp(`head_sha=${c}`), 'CI was never asked about a guard-red commit');
  l.done();
});

test("a train's only rider refused on its guards leaves the front to ship alone (#1479)", async () => {
  const l = await line([{}, {}, { change: ['test/loop-lag.test.ts', '// sleep\n'] }], guardEnv({ FAKE_RED_PATH: 'test/loop-lag.test.ts' }), guarded);
  const done = await l.go();
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /the guard tests failed on ticket\/2-x's ship train in test\/one-until\.test\.ts with ticket\/3-x on it/);
  for (const i of [1, 2]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.match(done[1].stderr, /main is now at [0-9a-f]{7,}/, 'the front shipped on its own');
  l.done();
});

test("a front whose own guard run didn't decide is checked again before its first rider is blamed (#1864)", async () => {
  // Ship 2 breaks the guard, and its own guard run times out (GUARD_LATE: the first red one), so CI decides.
  const l = await line([{}, { change: ['test/loop-lag.test.ts', '// sleep\n'] }, {}], (dir) => ({ ...guardEnv({ FAKE_RED_PATH: 'test/loop-lag.test.ts', GUARD_LATE: join(dir, 'late') })(dir) }), guarded);
  const done = await l.go();
  assert.match(done[1].stderr, /the guard tests couldn't run or ran past/);
  assert.match(done[1].stderr, /the guard tests failed on the ship train's top .*, but ticket\/2-x's own run of them didn't decide and fails now too, so they name no ship: CI runs them/);
  assert.doesNotMatch(done[2].stderr, /the guard tests failed/);
  assert.equal(done[2].status, 0, done[2].stderr);
  assert.equal(done[1].status, 1, done[1].stderr);
  l.done();
});

test("a train's guard runs and main's check of a red one keep their own phase moving, so the line behind doesn't give up on them (#1864)", async () => {
  // timing-ok: a test slower than a tick is the thing under test (the slow step the phase moves on during)
  const slow = 'await new Promise((r) => setTimeout(r, 1500));\n';
  const main = `import { existsSync } from 'node:fs';\n${slow}if (existsSync(new URL('../f4.txt', import.meta.url))) throw new Error('red');\n`;
  const l = await line(
    [{}, {}, {}, {}],
    (dir) => ({ ...guardEnv({ FAKE_RED_PATH: 'f4.txt', LAND_PHASE_EVERY: '0.3', GUARD_SLOW: '1.2' })(dir) }),
    (r) => {
      guarded(r);
      r.commit(r.source, 'test/real.test.ts', main);
    },
  );
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  const waiter = done[2].stderr;
  for (const p of ['the guard tests on the train', 'the red tests alone on main']) assert.match(waiter, new RegExp(`ahead: ticket/2-x, running ${p} since \\d\\d:\\d\\d, \\d+ min so far`), p);
  l.done();
});

test('a train rebuilt without a rider its guards refused takes the next ship in line, also when it had an early run to match (#1864)', async () => {
  const l = await line([{}, {}, {}, { change: ['test/loop-lag.test.ts', '// sleep\n'] }, {}], guardEnv({ LAND_EARLY: '0' }), guarded);
  const main = git(l.r.source, 'rev-parse', 'main');
  writeFileSync(join(l.state, 'early'), `${main} ticket/2-x ${Math.floor(Date.now() / 1000)} ticket/9-x ${main} ${tickets(l.state).slice(2, 4).join(',')}\n`); // as early_next leaves it
  const done = await l.go();
  assert.match(done[1].stderr, /takes the 2 ships waiting behind it \(ticket\/3-x ticket\/4-x\)/, 'the riders its early run had');
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[1].stderr, /takes the 2 ships waiting behind it \(ticket\/3-x ticket\/5-x\)/, 'ship 5 takes its place');
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  l.done();
});

test("each step of a red train's bisect runs the guard tests before asking CI, and a guard red needs no CI run (#1479)", async () => {
  // Ship 5 fixes ship 4's guard break, so the train's top passes the guards, but CI is red on both (FAKE_RED_PATH) and
  // names no suspect (FAKE_LOG=due), so the bisect looks: the first half asks CI and ships, then ship 4 by itself stops at its guards.
  const l = await line([{}, {}, {}, { change: ['test/loop-lag.test.ts', '// sleep\n'] }, { on: 4, change: ['test/loop-lag.test.ts', '// fixed\n'] }], guardEnv({ FAKE_RED_PATH: 'test/loop-lag.test.ts', FAKE_LOG: 'due' }), guarded);
  const done = await l.go();
  assert.match(done[1].stderr, /bisect: the first 2 of 4 ships tested green, so they ship now; back in line with nobody refused: ticket\/4-x ticket\/5-x/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /guard tests failed on [0-9a-f]+, the branch rebased onto main \(output above\), so no CI run was spent/);
  assert.equal(existsSync(join(l.state, 'split')), false, 'the bad ship is found');
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  const red = guardRuns(l)
    .filter(([, rc]) => rc === '1')
    .map(([c]) => c);
  assert.equal(red.length, 1, "one guard red: ship 4's own");
  assert.doesNotMatch(l.c.calls(), new RegExp(`head_sha=${red[0]}`), "CI was never asked about ship 4's step");
  const log = l.c.calls();
  const asked = guardRuns(l)
    .map(([c]) => c)
    .filter((c) => log.includes(`head_sha=${c}`));
  assert.ok(new Set(asked).size >= 3, `the front, the train's top and ship 3's step: ${asked.join(' ')}`);
  for (const c of asked) assert.ok(log.indexOf(`guard ${c} `) < log.indexOf(`head_sha=${c}`), `the guards ran on ${c} before CI was asked`);
  l.done();
});

test("a failed test file CI didn't rerun alone may be load or real, so it names no suspect and the bisect finds the ship", async () => {
  const l = await line([{}, {}, {}, { change: ['test/busy.test.ts', 'x\n'] }], { FAKE_RED_PATH: 'test/busy.test.ts', FAKE_LOG: 'due' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: CI's log doesn't say which tests really failed, so the bisect looks for the ship/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a rider refused for a skipped test hears so, for its wake to say skipped, not passed alone (#1914)', async () => {
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', '// red\n'] }], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'after-real', FAKE_SKIP: '1' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /It was pulled off the train on that guess/);
  // Pulled on a guess, it ships alone (#2098), and its own run's red says the skip as a refused ship's does.
  assert.match(done[3].stderr, /^land: a test was skipped in CI \(https:\/\/ci\/\d+\): the format check\. A skipped test is a real failure/m);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test("a file CI didn't rerun because a real failure already made the run red names no suspect: only the confirmed failure's ship is refused", async () => {
  const l = await line([{}, {}, { change: ['test/busy.test.ts', 'x\n'] }, { change: ['test/real.test.ts', '// red\n'] }], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'after-real' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /in test\/real\.test\.ts, which ticket\/4-x changed.*pulled off the train on that guess/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  assert.equal(l.runs(), 4, "ship 1's, the red train's, the smaller train's and #4's own (#2098)");
  l.done();
});

test("a train's red of flakes only is unchanged: one fresh run, and a ship that touched the flaky test still rides", async () => {
  const l = await line([{}, {}, { change: ['test/slow.test.ts', 'x\n'] }, {}], { FAKE_FLAKY_PATH: 'test/slow.test.ts', FAKE_LOG: 'flakes' });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more/);
  assert.doesNotMatch(done[1].stderr, /suspects|bisect/);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[3], 4, 2, 3);
  assert.equal(l.runs(), 2, "ship 1's and the train's, run twice");
  assert.equal(l.deployed().length, 2);
  l.done();
});

// #1419: known flakes (seen passing alone on another branch) ship the whole train with no fresh run, and every rider
// says so; a known flake one rider touched isn't excused, so the train gets #769's one fresh run as before.
test("a train's red of known flakes only ships every rider on that one run; one a rider touched gets the fresh run", async () => {
  for (const touched of [false, true]) {
    let shared = '';
    const l = await line(
      [{}, {}, touched ? { change: ['test/slow.test.ts', 'x\n'] } : {}, {}],
      (dir) => ({ FAKE_FLAKY_PATH: touched ? 'test/slow.test.ts' : 'f2.txt', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: join(dir, 'shared') }),
      (r) => seen((shared = join(r.dir, 'shared')), ['test/busy.test.ts', 'test/slow.test.ts']),
    );
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    if (touched) {
      assert.match(done[1].stderr, /test\/slow\.test\.ts is a known flake, but #3 changed it or what it imports, so it isn't excused/);
      assert.match(done[1].stderr, /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more/);
      assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /shipped past/);
    } else {
      assert.doesNotMatch(done[1].stderr, /running CI once more/);
      for (const i of [1, 2, 3]) assert.match(done[i].stderr, /^land: shipped past known flakes test\/busy\.test\.ts \(seen on 1 other branch in 14 days\), test\/slow\.test\.ts \(seen on 1 other branch in 14 days\)$/m, `ship ${i + 1}`);
      // The train's sighting names its riders, so none of them ships past it later as "another branch's" flake.
      const log = readdirSync(join(shared, 'retro-log'))
        .map((d) => readFileSync(join(shared, 'retro-log', d, 'land.md'), 'utf8'))
        .join('');
      assert.match(log, /· flake · test\/busy\.test\.ts · load [\d.]+ · \S+ · in CI · with \S+ \S+$/m);
    }
    assert.equal(l.runs(), 2, "ship 1's and the train's");
    assert.equal(l.deployed().length, 2);
    l.done();
  }
});

// #1377: on Nov 20 a bisect refused #1302 for a run interrupted at 55 s with no failing test (#1372's report).
test('a bisect run cut off twice before any test failed refuses nobody: the train goes back in line, and only a real red refuses', async () => {
  // Ship 1's run and the red train's are real; every run of the bisect's first look (the front alone) is cut off: the
  // one GitHub lists for it, the run pushed for it and its one fresh run.
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }], { FAKE_RED_PATH: 'red.txt', FAKE_CUT: '2 3' });
  const done = await l.go();
  assert.match(done[1].stderr, /finding the first ship that turned it red.*cut off before any test failed \(https:\/\/ci\/\d+\).*the ship train goes back in line, since CI gave no answer \(CI was cut off twice before any test failed \(https:\/\/ci\/\d+, https:\/\/ci\/\d+\)\)/s);
  assert.doesNotMatch(done[1].stderr, /tested green|found .* itself red/, 'the cut-off bisect named nobody');
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  // Ship 4 is refused only later, by a run that really failed.
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.doesNotMatch(done[3].stderr, /cut off/);
  assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI/);
  l.done();
});

// #1393: the same for runs killed from outside (exit 137) before any test failed: no answer, so nobody is refused for it.
test('a bisect run killed from outside twice before any test failed refuses nobody: only a real red refuses', async () => {
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }], { FAKE_RED_PATH: 'red.txt', FAKE_CUT: '2 3', FAKE_CUT_KIND: 'killed' });
  const done = await l.go();
  assert.match(done[1].stderr, /finding the first ship that turned it red.*cut off before any test failed.*the ship train goes back in line, since CI gave no answer \(CI was cut off twice before any test failed/s);
  assert.doesNotMatch(done[1].stderr, /tested green|found .* itself red|a test hung/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI/);
  l.done();
});

// #1864 (DR1): a train whose runner went away, or whose step or log GitHub doesn't send, read as red, and the bisect refused its last ship.
for (const [name, extra, why] of [
  ['lost its runner twice', { FAKE_CUT: '1 3', FAKE_CUT_KIND: 'lost' }, /the ship train goes back in line, since CI gave no answer \(CI's one fresh run lost its runner before any step failed/],
  ['sends no log', { FAKE_FLAKY_PATH: 'f4.txt', FAKE_LOG: 'down' }, /the ship train goes back in line, since CI gave no answer \(GitHub didn't send the red CI run's log/],
  ['names no step', { FAKE_FLAKY_PATH: 'f4.txt', FAKE_STEP: 'down' }, /the ship train goes back in line, since CI gave no answer \(GitHub didn't say which step of the red CI run failed/],
] as [string, Record<string, string>, RegExp][])
  test(`a train whose red run ${name} refuses nobody`, async () => {
    const l = await line([{}, {}, {}, {}], extra);
    const done = await l.go();
    assert.match(done[1].stderr, why);
    assert.doesNotMatch(done[1].stderr, /the bisect found/);
    for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });

// A rider whose tests take the runner down, on a busy perigee: the front is refused for it neither with it nor alone.
test('a train whose every run is lost while perigee is busy drops its riders, and only the ship that does it alone is refused (#1864)', async () => {
  const l = await line([{}, {}, { change: ['red.txt', 'red\n'] }], (dir) => {
    const proc = quietProc(join(dir, 'proc'), { load: 999 });
    return { FAKE_RED_PATH: 'red.txt', FAKE_STEP: 'lost', LAND_NO_VERDICT_MAX: '2', LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
  });
  const done = await l.go();
  assert.match(done[1].stderr, /the ship train goes back in line, since CI gave no answer \(CI's one fresh run lost its runner before any step failed/);
  assert.doesNotMatch(done[1].stderr, /refused by the pipeline/);
  for (const i of [1, 2]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /CI and perigee both busy, try again: CI: .*\(its runs were lost or cut off 2 times\); perigee/);
  l.done();
});

// #1864 (LB4): a train red twice of flakes only (no real failure to pin) went to the bisect; the front
// keeps its place instead. (Past its keeps, the bisect refuses nobody but a ship tested by itself: #1899.)
test('a train red twice of flakes only keeps its place, and every ship on it ships', async () => {
  const l = await line([{}, {}, {}, {}], { FAKE_FLAKY_PATH: 'f4.txt', FAKE_FLAKY_LOGS: '2', FAKE_LOG: 'flakes' });
  const done = await l.go();
  assert.match(done[1].stderr, /refused on flakes only \(test\/busy\.test\.ts, test\/slow\.test\.ts, then test\/busy\.test\.ts, test\/slow\.test\.ts on the fresh run\), not your change: keeping its place in line/);
  assert.doesNotMatch(done[1].stderr, /the bisect/);
  for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// #1393: a rerun alone killed from outside gives that file no label, but the confirmed failure still names its suspect.
test("a file whose rerun alone was killed from outside names no suspect: only the confirmed failure's ship is refused", async () => {
  const l = await line([{}, {}, { change: ['test/busy.test.ts', 'x\n'] }, { change: ['test/real.test.ts', '// red\n'] }], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'killed-rerun' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /in test\/real\.test\.ts, which ticket\/4-x changed.*pulled off the train on that guess/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a train whose front is red: the front is refused as alone, and the ships behind it ship as the next train', async () => {
  const l = await line([{}, { change: ['red.txt', 'red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.equal(done[1].status, 1);
  assert.match(done[1].stderr, /the bisect found ticket\/2-x itself red, so the ships behind it go back in line/);
  assert.match(done[1].stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\)/);
  for (const i of [3, 4, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[3], 4, 3, 3);
  shipped(l, done[4], 5, 3, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5']);
  l.done();
});

test('CI gives no answer on a train: the riders go back in line, and each lands on its own', async () => {
  // LAND_CI_DOWN=0: the note the first no-answer leaves would keep the next fronts from making a train at all.
  const l = await line([{}, {}, {}, {}], { FAKE_CI: 'down', LAND_CI_DOWN: '0' });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 2 ships/);
  assert.match(done[1].stderr, /the ship train goes back in line, since CI gave no answer \(.*\): ticket\/2-x goes on alone/);
  assert.match(done[1].stderr, /CI FALLBACK/);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.equal(l.deployed().length, 4, 'one deploy each');
  l.done();
});

// #1361 (Cara 2026-11-20, "Wait for a busy desktop"): a train keeps its riders while it waits for a busy runner, or for a
// runner to come back while perigee is busy, and they go back only when the gate gives up for good. 1 s stands for the
// 90 s bound, and the few seconds the job sits queued for a 3-min wait.
test('a train keeps its riders while a busy runner takes its time to start the job, and ships them in one CI run', async () => {
  const l = await line(
    [{}, {}, {}],
    (dir) => ({ FAKE_CI_FILE: join(dir, 'ci-state'), LAND_CI_START: '1', LAND_CI_START_ONLINE: '60' }),
    (r) => writeFileSync(join(r.dir, 'ci-state'), 'green'),
  );
  const file = join(l.r.dir, 'ci-state');
  writeFileSync(file, 'queued');
  const all = l.go();
  await until('the train waits for the busy runner', () => /ship train: ticket\/2-x takes the 1 ships/.test(l.out[1]) && /runner is online but hasn't started the job/.test(l.out[1]), 30_000);
  await new Promise((ok) => setTimeout(ok, 2500));
  writeFileSync(file, 'green');
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  shipped(l, done[2], 3, 2, 2);
  assert.equal(l.deployed().length, 2, "ship 1's deploy and the train's");
  l.done();
});

test('a train keeps its riders while perigee is busy and CI gives no answer, and ships them once CI answers', async () => {
  const l = await line(
    [{}, {}, {}],
    (dir) => {
      const proc = quietProc(join(dir, 'proc'));
      return { FAKE_CI_FILE: join(dir, 'ci-state'), LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
    },
    (r) => writeFileSync(join(r.dir, 'ci-state'), 'green'),
  );
  writeFileSync(join(l.r.dir, 'ci-state'), 'down');
  quietProc(join(l.r.dir, 'proc'), { load: 999 });
  const all = l.go();
  await until(
    'the train waits on a busy perigee',
    () => /ship train: ticket\/2-x takes the 1 ships/.test(l.out[1]) && /CI: GitHub didn't answer, but perigee is busy/.test(l.out[1]),
    30_000,
    () => l.out[1],
  );
  await new Promise((ok) => setTimeout(ok, 1000));
  writeFileSync(join(l.r.dir, 'ci-state'), 'green');
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  shipped(l, done[2], 3, 2, 2);
  l.done();
});

test("a red train's bisect keeps its riders while CI gives no answer on a busy perigee, and finds the ship once CI answers", async () => {
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }, {}, {}], (dir) => {
    const proc = quietProc(join(dir, 'proc'), { load: 999 });
    // GitHub stops answering from the bisect's first probe: the third commit asked about, after ship 1's and the train's.
    return { FAKE_RED_PATH: 'red.txt', FAKE_CI_DOWN_AT: '3', FAKE_CI_UP: join(dir, 'ci-up'), LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
  });
  const all = l.go();
  await until(
    'the bisect waits on a busy perigee',
    () => /finding the first ship that turned it red/.test(l.out[1]) && /CI: GitHub didn't answer, but perigee is busy/.test(l.out[1]),
    30_000,
    () => l.out[1],
  );
  await new Promise((ok) => setTimeout(ok, 1000));
  writeFileSync(join(l.r.dir, 'ci-up'), '');
  const done = await all;
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  assert.match(done[1].stderr, /bisect: the first 2 of 5 ships tested green, so they ship now; back in line with nobody refused: ticket\/4-x ticket\/5-x ticket\/6-x; the red may be: ticket\/4-x ticket\/5-x ticket\/6-x/);
  assert.equal(done[3].status, 1, done[3].stderr);
  for (const i of [1, 2, 3, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  l.done();
});

test('a rider stopped while its train is tested: the train ships up to the ship before it, and the rest go back in line', async () => {
  const gate = (r: ReturnType<typeof setup>) => join(r.dir, 'ci-gate');
  const l = await line(
    [{}, {}, {}, {}, {}],
    (dir) => ({ FAKE_CI_GATE: join(dir, 'ci-gate') }),
    (r) => writeFileSync(gate(r), ''),
  );
  rmSync(gate(l.r)); // the train's run stays in progress until the rider is gone
  const all = l.go();
  await until('the train', () => /ship train: ticket\/2-x takes the 3 ships/.test(l.out[1]));
  await until('ship 5 riding', () => /land: riding/.test(l.out[4]));
  const ticket = tickets(l.state)
    .map((t) => readFileSync(join(l.state, 'queue', t), 'utf8').split('\n'))
    .find((t) => t[2] === 'ticket/4-x')!;
  process.kill(-Number(ticket[0].split(' ')[0]), 'SIGKILL');
  writeFileSync(gate(l.r), '');
  const done = await all;
  assert.equal(done[3].status, null, 'killed');
  assert.match(done[1].stderr, /ship train: ticket\/4-x left the line while the train was tested, so it ships without it/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  assert.match(done[4].stderr, /back in line on its own/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5']);
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3]);
  assert.equal(l.deployed().length, 3);
});

test('the train passes over a ship that conflicts with it, one that changes the pipeline, and one landed with LAND_TRAIN=0', async () => {
  const l = await line([{}, {}, { change: ['a.txt', 'three\n'] }, { change: ['a.txt', 'four\n'] }, { change: ['tools/pipe.sh', 'x\n'] }, {}, { env: { LAND_TRAIN: '0' } }], {}, (r) => r.commit(r.source, 'tools/pipeline-files.txt', '# the pipeline\ntools/pipe.sh\n'));
  const done = await l.go();
  assert.match(done[1].stderr, /ship train: ticket\/4-x stays in line \(it doesn't rebase cleanly onto the train\)/);
  assert.match(done[1].stderr, /ship train: ticket\/5-x stays in line \(it changes the ship pipeline, which ships alone\)/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 2 ships waiting behind it \(ticket\/3-x ticket\/6-x\)/);
  assert.equal(done[3].status, 1, 'the conflict is refused on its own');
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[5], 6, 2, 3);
  assert.doesNotMatch(done[6].stderr, /land: riding/);
  assert.deepEqual(l.subjects(), ['base', 'tools/pipeline-files.txt: # the pipeline tools/pipe.sh', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: three', 'f6.txt: 6', 'tools/pipe.sh: x', 'f7.txt: 7']);
  l.done();
});

test('with <state>/train-off, every ship lands on its own', async () => {
  const l = await line([{}, {}, {}, {}], {}, (r) => {
    const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'train-off'), '');
  });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[1].stderr, /ship train/);
  assert.equal(l.runs(), 4);
  assert.equal(l.deployed().length, 4);
  l.done();
});

// deploy.sh lets go of the line once its restart is queued, while the restart is still judged (#566), so a rider can get
// the lock before its front has a verdict to give.
async function restart(rolledBack: boolean) {
  const l = await line([{ env: { FAKE_RESTART_GATE: '' } }, rolledBack ? { env: { FAKE_ROLLED_BACK: '1' } } : {}, {}, {}], (dir) => ({ FAKE_RESTART_GATE: join(dir, 'restarted') }));
  const all = l.go();
  await until('ships 3 and 4 wait outside the line', () => [2, 3].every((i) => /waiting outside the line for the restart of ticket\/2-x's ship train/.test(l.out[i])));
  writeFileSync(join(l.r.dir, 'restarted'), '');
  return { l, done: await all };
}

test("a rider that gets the lock while its train's restart is judged waits outside the line, and ships with it", async () => {
  const { l, done } = await restart(false);
  assert.equal(done[1].status, 0, done[1].stderr);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[3], 4, 2, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.equal(l.deployed().length, 2, "ship 1's deploy and the train's");
  l.done();
});

test("every rider's minion is handed to the train's deploy, with its own train commit, for the restart to report to (#1865)", async () => {
  const me = (n: number) => ({ env: { COORDINATOR_API: 'http://127.0.0.1:1', COORDINATOR_TOKEN: `tok${n}`, COORDINATOR_TICKET: String(n) } });
  const l = await line([me(1), me(2), me(3), {}, me(5)]);
  const done = await l.go();
  for (const d of done) assert.equal(d.status, 0, d.stderr);
  const at = (i: number) => git(l.r.source, 'rev-parse', `ticket/${i}-x`);
  assert.deepEqual(readFileSync(join(l.r.dir, 'deploys.riders'), 'utf8').trim().split('\n').sort(), [`http://127.0.0.1:1 tok3 3 ${at(3)}`, `http://127.0.0.1:1 tok5 5 ${at(5)}`]);
  assert.deepEqual(
    readdirSync(l.state).filter((f) => f.startsWith('riders-')),
    [],
    'no token is left behind',
  );
  l.done();
});

test('a train whose restart is rolled back: its riders go back in line and land on their own', async () => {
  const { l, done } = await restart(true);
  assert.equal(done[1].status, 1, done[1].stderr);
  for (const i of [3, 4]) {
    assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    assert.match(done[i - 1].stderr, /back in line on its own: ticket\/2-x's ship train went without/);
    assert.doesNotMatch(done[i - 1].stderr, /shipped in ticket\/2-x's ship train/);
  }
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  l.done();
});

// #1360 (Cara, 2026-11-20, "Refused ships keep their place"): ship 2, at the front, is refused by the pipeline (no CI and a
// busy perigee); it keeps its ticket, lets ship 3 take the lock, and rides ship 3's train as its first rider.
const busy = (): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), 'land-busy-'));
  const proc = quietProc(join(dir, 'proc'), { load: 999 });
  return { LAND_CI: '0', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy'), LAND_QUIET_LIMIT: '0', LAND_QUIET_POLL: '0.2' };
};
const retried = (l: Awaited<ReturnType<typeof line>>) => {
  const log = join(l.r.dir, 'shared', 'retro-log');
  return readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8')
    .split('\n')
    .filter((x) => x.includes(' · retry in place · '))
    .map((x) => x.replace(/^- \S+ /, ''));
};

test("a front refused by the pipeline keeps its ticket and rides the next ship's train as its first rider, never ahead of it (#1360)", async () => {
  const l = await line([{}, { env: busy() }, {}, {}], shared);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /refused by the pipeline \(CI and perigee both busy for 0 min\), not your change: keeping its place in line and riding the next train, once/);
  assert.match(done[2].stderr, /ship train: ticket\/3-x takes the 2 ships waiting behind it \(ticket\/2-x ticket\/4-x\)/, 'ship 2 first, ship 3 at the front');
  shipped(l, done[1], 2, 3, 3);
  shipped(l, done[3], 4, 3, 3);
  assert.doesNotMatch(done[1].stderr, /back at the front/, 'it never took the lock again');
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f2.txt: 2', 'f4.txt: 4']);
  assert.equal(issued(l.state), 4, 'no new ticket');
  assert.deepEqual(retried(l), ['· retry in place · ticket/2-x · CI and perigee both busy for 0 min · landed']);
  l.done();
});

test('a front refused by the pipeline stays first in a Releases order set while it held the lock (#1360)', async () => {
  const l = await line([{}, { env: { ...busy(), LAND_QUIET_LIMIT: '2' } }, {}, {}], shared);
  const all = l.go();
  await until('ship 2 waiting on a busy perigee', () => /waiting for CI or a quiet perigee/.test(l.out[1]));
  writeFileSync(join(l.state, 'queue', '.order'), '# set by a test\n0000000004\n0000000003\n'); // Releases ranks only the waiters
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /ship train: ticket\/4-x takes the 2 ships waiting behind it \(ticket\/2-x ticket\/3-x\)/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f4.txt: 4', 'f2.txt: 2', 'f3.txt: 3']);
  l.done();
});

test('a retried ship whose train goes red goes back in line as any rider does, is tested by itself, and is refused for good (#1360)', async () => {
  const l = await line([{}, { change: ['red.txt', 'red\n'], env: busy() }, {}, {}], (d) => ({ FAKE_RED_PATH: 'red.txt', ...shared(d) }));
  const done = await l.go();
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.match(done[1].stderr, /not your change: keeping its place/);
  assert.match(done[1].stderr, /back in line on its own: the ship train went without ticket\/2-x/);
  for (const i of [1, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  assert.deepEqual(retried(l), ['· retry in place · ticket/2-x · CI and perigee both busy for 0 min · refused']);
  l.done();
});

test("a rider whose file its front removes as it reads it is back in line, like one with no file: it doesn't die (#1914)", () => {
  const land = readFileSync(join(import.meta.dirname, '../tools/land.sh'), 'utf8');
  const body = /^train_verdict\(\) \{\n[\s\S]*?^\}$/m.exec(land)?.[0];
  assert.ok(body, 'tools/land.sh has no train_verdict()');
  const dir = mkdtempSync(join(tmpdir(), 'land-verdict-read-'));
  try {
    // The race in one step: a look at the file says it has text, and opening it fails.
    writeFileSync(join(dir, '7'), 'riding ticket/2-x\n');
    chmodSync(join(dir, '7'), 0);
    for (const [held, riding, want] of [
      ['', '', 'rc=0 riding=\n'],
      ['', '1', 'phase: waiting\nland: back in line on its own: the ship train went without ticket/7-x\nrc=0 riding=\n'],
      ['held', '1', 'phase: waiting\nland: back in line on its own: the ship train went without ticket/7-x\nrc=0 riding=\n'],
    ]) {
      const script: string = `set -euo pipefail\nsay() { echo "land: $*"; }\nqueue_phase() { echo "phase: $*"; }\n${body}\ntrain_dir=$1 riding=$2 branch=ticket/7-x DEPLOY_QUEUE_TICKET=queue/7 rc=0\ntrain_verdict $3 || rc=$?\necho "rc=$rc riding=$riding"`;
      const r = spawnSync('bash', ['-c', script, 'bash', dir, riding, held], { encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, want, `held "${held}", riding "${riding}"`);
      assert.equal(r.status, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
