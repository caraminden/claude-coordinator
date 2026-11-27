// Part 1 of 3 of the land-train-riders tests (#2208); the shared setup is in land-train-riders-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen, tickets } from './land-fixture.ts';
import { line, shipped, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';
import { guarded, guardEnv, guardRuns, busy } from './land-train-riders-setup.ts';

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
