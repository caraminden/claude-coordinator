// The ship train (#1166, tools/land.sh): the landing at the front of the line takes the plain lands waiting behind it,
// tests them in one CI run and ships them in one deploy; a red train is bisected, and its first red ship refused.
// This file: shipping through main's red, conflict prep, the early next train, and a ship's own and light check (split from
// land-train.test.ts, #1723).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DEP, ci, depsRepo, git, seen, setup, landAsync } from './land-fixture.ts';
import { type Ship, line, shipped, bad, realOf, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';

// Red on main too (#1430): main's own tip fails test/real.test.ts run alone (Nov 21 00:00 PST's clock test), so every
// train is red on it. Ship through (#1478, Cara, 2026-11-21, on #1430's card: "Ship through"): when that is the run's only
// real failure (its other reds passed alone: flakes) and no ship on it touched the test, the train is no worse than main,
// so it ships, saying so, and main's fix ships separately. It used to go back in line, its front refused. Ship 1 lands
// green (its CI isn't told the red file).

test("a train red only on a test that fails on main too ships through main's red, and says so (#1478)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}, {}, {}],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }),
    (r) => {
      r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n");
      seen(join(r.dir, 'shared'), ['test/slow.test.ts']);
    },
  );
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  const front = done[1].stderr;
  assert.doesNotMatch(front, /suspects:|bisect|likely the cause|keeping its place|go back in line/, 'no ship is blamed or sent back');
  assert.match(front, /SHIPPING THROUGH MAIN'S RED: test\/real\.test\.ts fails run alone on main's tip [0-9a-f]{7,} here too, and it is the only real failure of this train's CI run \(https:\/\/ci\/\d+\)/);
  assert.match(front, /Main still needs a fix for test\/real\.test\.ts/);
  assert.match(front, /^land: shipped through main's red on test\/real\.test\.ts$/m, "the front's shipped line names main's red");
  assert.match(front, /^land: shipped past known flakes test\/slow\.test\.ts \(seen on 1 other branch in 14 days\)$/m, 'its flake is a known one (#1419)');
  for (const i of [3, 4]) {
    shipped(l, done[i - 1], i, 2, 3);
    assert.match(done[i - 1].stderr, /^land: shipped through main's red on test\/real\.test\.ts$/m, `ship ${i}'s shipped line names main's red`);
  }
  assert.deepEqual(l.subjects(), ['base', "test/real.test.ts: throw new Error('red on main');", 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4'], 'the train shipped on a red main');
  const log = join(l.r.dir, 'shared', 'retro-log');
  const lines = readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8');
  assert.match(lines, / · shipped through main's red · ticket\/2-x · test\/real\.test\.ts · https:\/\/ci\/\d+/);
  assert.doesNotMatch(lines, /red on main too: not/);
  l.done();
});

test("a ship alone red only on main's red test ships through it too (#1478)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }),
    (r) => {
      r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n");
      seen(join(r.dir, 'shared'), ['test/slow.test.ts']);
    },
  );
  const [first, one] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stderr, /SHIPPING THROUGH MAIN'S RED: test\/real\.test\.ts fails run alone on main's tip [0-9a-f]{7,} here too, and it is the only real failure of this ship's CI run/);
  assert.match(one.stderr, /^land: shipped through main's red on test\/real\.test\.ts$/m);
  assert.deepEqual(l.subjects(), ['base', "test/real.test.ts: throw new Error('red on main');", 'f1.txt: 1', 'f2.txt: 2']);
  l.done();
});

// A second real failure that passes on main may be the train's own: no ship through. #1430's path stands: nobody is blamed
// by a bisect that can't judge, the riders go back in line, and each front takes its one retry in place, then is refused
// naming the other failure as maybe its own (#1478).
test("a train also red on a test that passes on main doesn't ship through: #1430's path (#1478)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}, {}],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'two-real', ...shared(d) }),
    (r) => {
      r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n");
      r.commit(r.source, 'test/other.test.ts', "import test from 'node:test'; test('green on main', () => {});\n");
    },
  );
  const done = await l.go();
  assert.equal(done[0].status, 0, done[0].stderr);
  for (const i of [2, 3]) {
    const e = done[i - 1].stderr;
    assert.equal(done[i - 1].status, 1, `ship ${i}: ${e}`);
    assert.doesNotMatch(e, /SHIPPING THROUGH|shipped through/, `ship ${i} doesn't ship through`);
    assert.doesNotMatch(e, /suspects:|bisect|likely the cause/, `ship ${i}: no ship is blamed`);
    assert.match(e, /land: tests failed in CI \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, which fails on main's own tip too \(run alone here\): main is red, not this change, so main is untouched\. The run was also red on test\/other\.test\.ts, which may be yours/, `ship ${i}'s refusal says so`);
  }
  assert.match(done[1].stderr, /red on main too: not this train's: test\/real\.test\.ts fails run alone on main's tip [0-9a-f]{7,} here, so no ship on the train is to blame and none is refused: the 1 riders go back in line \(its other failures, test\/other\.test\.ts, cannot be pinned on a ship/);
  assert.match(done[1].stderr, /not your change: keeping its place in line and riding the next train, once/, 'the front: its one retry in place');
  assert.deepEqual(l.subjects().slice(-1), ['f1.txt: 1'], 'nothing more landed');
  l.done();
});

// A rider that changed main's red test and left it red may have broken it again: the train doesn't ship through. It goes
// back in line and, alone, is refused (its change doesn't make the test pass); the front, after its retry in place,
// ships through on its own (#1478).
test("a train with a rider that changed main's red test doesn't ship through it; the front then ships alone (#1478)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}, { change: ['test/real.test.ts', "throw new Error('still red');\n"] }],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }),
    (r) => {
      r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n");
      seen(join(r.dir, 'shared'), ['test/slow.test.ts']);
    },
  );
  const done = await l.go();
  assert.equal(done[0].status, 0, done[0].stderr);
  assert.match(done[1].stderr, /the 1 riders go back in line \(ticket\/3-x changed test\/real\.test\.ts or what it imports, so the train doesn't ship through main's red\)/);
  assert.match(done[1].stderr, /not your change: keeping its place in line and riding the next train, once/, 'the front: its one retry in place');
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.doesNotMatch(done[2].stderr, /SHIPPING THROUGH|shipped through/, "the rider doesn't ship through");
  assert.match(done[2].stderr, /ticket\/3-x changed test\/real\.test\.ts or what it imports, yet it still fails: main is red and this change doesn't make it pass/, 'alone, the rider hears its change is no fix');
  assert.equal(done[1].status, 0, done[1].stderr);
  assert.match(done[1].stderr, /SHIPPING THROUGH MAIN'S RED: test\/real\.test\.ts .* of this ship's CI run/, 'the front, alone, ships through');
  assert.deepEqual(l.subjects().slice(-2), ['f1.txt: 1', 'f2.txt: 2'], "only the front's change landed");
  l.done();
});

// A failed file that was never rerun alone (CI stopped at its first real failure) may be load or the train's own: it is
// no flake, so no ship through (#1478).
test("a train whose other red file was never rerun doesn't ship through main's red (#1478)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'after-real', ...shared(d) }),
    (r) => r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n"),
  );
  const [first, one] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(one.status, 1, one.stderr);
  assert.doesNotMatch(one.stderr, /SHIPPING THROUGH|shipped through/);
  assert.match(one.stderr, /main is red, not this change, so main is untouched\. The run was also red on test\/busy\.test\.ts, which may be yours/);
  l.done();
});

// The run's other reds go by #1419's rule: a flake never seen on another branch may be the ship's own, and the leak
// guard's red is never a flake, so neither ships through main's red (#1478 review).
test("a ship red on main's red test plus a new flake, or the leak guard, doesn't ship through (#1478)", async () => {
  for (const leak of [false, true]) {
    const l = await line(
      [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}],
      (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...(leak ? { FAKE_LEAK: '1' } : {}), ...shared(d) }),
      (r) => {
        r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n");
        if (leak) seen(join(r.dir, 'shared'), ['test/slow.test.ts']);
      },
    );
    const [first, one] = await l.go();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(one.status, 1, one.stderr);
    assert.doesNotMatch(one.stderr, /SHIPPING THROUGH|shipped through/);
    const other = leak ? 'the leak guard \\(the tests left processes running\\)' : 'test\\/slow\\.test\\.ts \\(passed alone, but no known flake\\)';
    assert.match(one.stderr, new RegExp(`main is red, not this change, so main is untouched\\. The run was also red on ${other}, which may be yours`));
    l.done();
  }
});

// A burn-in red is the ship's own racy test, even when main is red on that test too: no ship through (#1443, #1478).
test("a ship whose burn-in is red doesn't ship through main's red on the same test (#1478)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, { change: ['test/real.test.ts', 'racy\n'] }],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', ...shared(d) }),
    (r) => {
      r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n");
      seen(join(r.dir, 'shared'), ['test/slow.test.ts']);
    },
  );
  const [first, one] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(one.status, 1, one.stderr);
  assert.doesNotMatch(one.stderr, /SHIPPING THROUGH|shipped through|red on main/);
  assert.match(one.stderr, /land: a new or changed test failed its burn-in in CI \(https:\/\/ci\/\d+\)/);
  l.done();
});

// A ship that changed main's red test and left it red is still no culprit for a bisect, but it hears its change doesn't make
// the test pass, rather than "not this change", and takes no retry (#1430 review).
test("a ship that changes main's red test and leaves it red hears so, with no retry (#1430)", async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, { change: ['test/real.test.ts', "throw new Error('still red');\n"] }],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }),
    (r) => r.commit(r.source, 'test/real.test.ts', "throw new Error('red on main');\n"),
  );
  const [first, one] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(one.status, 1, one.stderr);
  assert.match(one.stderr, /red on main too: not this ship's: test\/real\.test\.ts fails run alone on main's tip [0-9a-f]{7,} here, so ticket\/2-x changed test\/real\.test\.ts or what it imports and it still fails, so its change doesn't make it pass/);
  assert.match(one.stderr, /land: tests failed in CI \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, which fails on main's own tip too \(run alone here\), and ticket\/2-x changed test\/real\.test\.ts or what it imports, yet it still fails: main is red and this change doesn't make it pass, so main is untouched/);
  assert.doesNotMatch(one.stderr, /keeping its place|not this change/);
  l.done();
});

// A test that only times out on main (a busy perigee at nice 19) is no proof main is red: today's path (#1430 review).
test('a red test that only times out when run alone on main is no main red: the ship is refused as before (#1430)', async () => {
  const l = await line(
    [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}],
    (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }),
    (r) => r.commit(r.source, 'test/real.test.ts', "import test from 'node:test'; test('slow', { timeout: 50 }, () => new Promise((r) => setTimeout(r, 5000)));\n"),
  );
  const [first, one] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(one.status, 1, one.stderr);
  assert.match(one.stderr, /red on main\?: running test\/real\.test\.ts alone/, 'it did check main');
  assert.doesNotMatch(one.stderr, /red on main too/);
  assert.match(one.stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\), so main is untouched/);
  l.done();
});

// A test that could not run on main here is no proof main is red (#1863): the scratch worktree had no packages, so the type
// check and the property tests failed on their import and a ship's own red shipped "through main's red".
for (const [why, withLock] of [
  ['its package is nowhere to be had', false],
  ['it passes on main once the packages its lockfile names are there', true],
] as const) {
  test(`a red test whose package main's scratch worktree lacks is no main red: ${why} (#1863)`, async () => {
    let bin = '';
    const l = await line(
      [{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}],
      (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d), ...(withLock ? { PATH: `${bin}:${join(d, 'bin')}:${process.env.PATH}` } : {}) }),
      (r) => {
        if (withLock) bin = depsRepo(r.dir, r.source).npmBin;
        r.commit(r.source, 'test/real.test.ts', `import '${DEP}';\n`);
      },
    );
    const [first, one] = await l.go();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(one.status, 1, one.stderr);
    assert.match(one.stderr, /red on main\?: running test\/real\.test\.ts alone/, 'it did check main');
    assert.doesNotMatch(one.stderr, /red on main too|SHIPPING THROUGH/);
    assert.match(one.stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\), so main is untouched/);
    l.done();
  });
}

// Conflict prep (#1366, Cara, 2026-11-20: "we know what main WILL look like, and we can deal with the merge issues before
// we try to ship"): ship 4 waits behind ship 2's train, which carries ship 3, and conflicts with ship 3 in a.txt. While the
// train is tested, land.sh tells it so; its minion records the fix with git rerere in a scratch worktree (prepMessage's
// steps), off its branch; once the train ships, ship 4's real rebase replays the fix and it ships.
// keep: the fix keeps the train's side whole, so ship 4's a.txt commit drops out and only its second commit ships.
async function prepped(red: boolean, keep = false, early = false) {
  let gate = '';
  const l = await line(
    [{}, {}, { change: ['a.txt', 'three\n'], ...(red ? { also: ['red.txt', 'red\n'] as [string, string] } : {}) }, { change: ['a.txt', 'four\n'], ...(keep ? { also: ['g.txt', 'g\n'] as [string, string] } : {}) }],
    (dir) => ({ ...shared(dir), ...(early ? {} : { LAND_EARLY: '0' }), FAKE_CI_GATE: (gate = join(dir, 'ci-gate')), ...(red ? { FAKE_RED_PATH: 'red.txt' } : {}) }),
    (r) => writeFileSync(join(r.dir, 'ci-gate'), ''), // ship 1's run goes through; the train's waits
  );
  rmSync(gate);
  const all = l.go();
  await until("ship 4's prep line", () => /land: prep: ticket\/4-x will conflict/.test(l.out[3]));
  const m = /land: prep: ticket\/4-x will conflict with ticket\/3-x once ticket\/2-x's ship train ships; conflicted files: a\.txt; record the fix against ([0-9a-f]{40}) from ([0-9a-f]{40}) to ([0-9a-f]{40})$/m.exec(l.out[3]);
  assert.ok(m, l.out[3]);
  assert.equal(m[3], l.was[3], "ship 4's own head");
  // What the minion runs, in a scratch worktree of its own.
  const wt = join(l.r.dir, 'train-prep');
  git(l.wts[3], 'worktree', 'add', '-q', '--detach', wt, m[1]);
  assert.throws(() => git(wt, '-c', 'rerere.enabled=true', 'cherry-pick', `${m[2]}..${m[3]}`));
  writeFileSync(join(wt, 'a.txt'), keep ? 'three\n' : 'three\nfour\n');
  git(wt, 'add', 'a.txt');
  if (keep) {
    assert.throws(() => git(wt, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'cherry-pick', '--continue'), 'nothing to commit');
    git(wt, '-c', 'rerere.enabled=true', 'rerere');
    git(wt, 'cherry-pick', '--skip');
  } else git(wt, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'cherry-pick', '--continue');
  git(l.wts[3], 'worktree', 'remove', '--force', wt);
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'its branch is as it was');
  await until('the fix is seen', () => /land: prep: ticket\/4-x conflicts with ticket\/3-x on ticket\/2-x's ship train \(a\.txt\), but the fix recorded ahead of time \(git rerere\) resolves it/.test(l.out[3]));
  writeFileSync(gate, '');
  return { l, done: await all };
}

test('conflict prep: a ship that will conflict with a rider is told while the train is tested, records the fix, and ships on it (#1366)', async () => {
  const { l, done } = await prepped(false);
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /land: the fix recorded ahead of time \(git rerere, conflict prep\) resolved the rebase's conflicts/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: three', 'a.txt: four']);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'three\nfour');
  assert.equal(git(l.r.source, 'config', '--get', 'rerere.enabled'), 'false', "rerere stays land.sh's: rr-cache would turn it on for every command");
  const log = join(l.r.dir, 'shared', 'retro-log');
  const lines = readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8')
    .split('\n')
    .filter((x) => x.includes(' · train prep '))
    .map((x) => x.replace(/^- \S+ · /, '').replace(/\(([0-9a-f]{7,})\)/, '(sha)'));
  assert.deepEqual(lines, ["train prep conflict · ticket/4-x onto ticket/2-x's train (sha) · ticket/3-x: a.txt", 'train prep replayed · ticket/4-x onto main (sha)']);
  l.done();
});

test('conflict prep: when the train goes red and the rider drops out, the ship carries no foreign commits and the record goes unused (#1366)', async () => {
  const { l, done } = await prepped(true);
  assert.equal(done[2].status, 1, 'ship 3 turned the train red');
  for (const i of [1, 2, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.doesNotMatch(done[3].stderr, /resolved the rebase's conflicts/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: four']);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'four');
  l.done();
});

test("conflict prep: a fix that keeps the train's side whole drops that commit, and the ship's other commits ship (#1366)", async () => {
  const { l, done } = await prepped(false, true);
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /resolved the rebase's conflicts/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: three', 'g.txt: g']);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'three');
  l.done();
});

test('conflict prep with the early next train: the early stack replays the recorded fix, and its run counts (#1366)', async () => {
  const { l, done } = await prepped(false, false, true);
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /that run is its CI/);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'three\nfour');
  assert.deepEqual(retro(l.r.dir, ' · train prep replayed · '), ["train prep replayed · ticket/4-x onto ticket/2-x's train sha, early"]);
  l.done();
});

test('conflict prep off: <state>/prep-off, and no prep line is said (#1366)', async () => {
  const l = await line([{}, {}, { change: ['a.txt', 'three\n'] }, { change: ['a.txt', 'four\n'] }], {}, (r) => {
    const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'prep-off'), '');
  });
  const done = await l.go();
  assert.equal(done[3].status, 1, 'the conflict is refused as before');
  assert.doesNotMatch(done[3].stderr, /land: prep:/);
  assert.throws(() => git(l.r.source, 'config', '--get', 'rerere.enabled'), "land.sh leaves the repo's rerere setting alone");
  l.done();
});

// Early next train (#1366, #1568): while a train's CI runs, the ship next in line and the train it would take are stacked
// on its top and pushed to CI once that run has a runner. LAND_TRAIN_MAX=1: ship 2 takes ship 3, and ship 4 is next, with ship 5.
const retro = (dir: string, what: string) => {
  const log = join(dir, 'shared', 'retro-log');
  return readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8')
    .split('\n')
    .filter((x) => x.includes(what))
    .map((x) => x.replace(/^- \S+ · /, '').replace(/\(([0-9a-f]{7,})\)|[0-9a-f]{7,}$/g, 'sha'));
};

test("early next train: the next ship's train is stacked and its CI started while the train ahead's CI runs, and its run counts (#1366, #1568)", async () => {
  // Ship 2's run stays in progress until the test sees the early push: the early run starts beside it, not after it.
  const go = join(mkdtempSync(join(tmpdir(), 'early-go-')), 'go');
  const l = await line([{}, { env: { FAKE_CI_GATE: go } }, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }), pushLog);
  const all = l.go();
  await until("the early push beside ship 2's run", () => /its CI starts now/.test(l.out[1]));
  assert.doesNotMatch(l.out[1], /CI passed on/, "ship 2's run is still going");
  writeFileSync(go, '');
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: early next train: ticket\/4-x \(with ticket\/5-x riding\) is stacked on this train's top and its CI starts now, while this one's CI runs \(([0-9a-f]{7,})\)/);
  const top = /while this one's CI runs \(([0-9a-f]{7,})\)/.exec(done[1].stderr)![1];
  assert.ok(done[1].stderr.indexOf('its CI starts now') < done[1].stderr.indexOf('CI passed on'), 'pushed before the train ahead was green');
  assert.equal(done[1].stderr.match(/is stacked on this train's top/g)?.length, 1, 'its deploy keeps the early run rather than stacking another');
  assert.match(done[3].stderr, /land: early next train: CI started on this train at \d\d:\d\d beside ticket\/2-x's, and it came out the same, so that run is its CI \(\d+ s head start\)/);
  assert.equal(git(l.r.source, 'rev-parse', '--short=7', 'main').slice(0, 7), top.slice(0, 7), 'the train that shipped is the one stacked early');
  shipped(l, done[4], 5, 4, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5']);
  assert.deepEqual(retro(l.r.dir, ' · early train · '), ["early train · ticket/4-x + 1 riders onto ticket/2-x's train sha · pushed sha", 'early train · ticket/4-x · counted · 0s head start'.replace('0s', retro(l.r.dir, ' · counted · ')[0]?.match(/(\d+)s head/)?.[1] + 's')]);
  assert.match(retro(l.r.dir, 'timing · ticket/4-x').join('\n'), / · ci early \d+s · landed/);
  assert.ok(!existsSync(join(l.state, 'early')), 'the record is used up');
  // The early run goes with its base, ship 2's train top, for the burn-in (#1443), and both scratch branches are deleted.
  const pushes = readFileSync(join(l.r.dir, 'pushes'), 'utf8').trim().split('\n');
  const base = pushes.find((x) => x.endsWith(' refs/heads/early-base/ticket/4-x') && !/^0+ /.test(x))?.split(' ')[0];
  assert.ok(base, `early-base/ticket/4-x pushed: ${pushes.join('; ')}`);
  assert.equal(git(l.r.source, 'log', '-1', '--format=%s', base!), 'f3.txt: 3', "its base is ship 2's train top (ship 3 rode it)");
  assert.ok(!pushes.some((x) => / refs\/heads\/land(-base)?\/ticket\/4-x$/.test(x)), `ship 4's counted run needed no land/ run: ${pushes.join('; ')}`);
  assert.equal(git(join(l.r.dir, 'hub.git'), 'for-each-ref', 'refs/heads/early/', 'refs/heads/early-base/'), '', 'its early refs end deleted');
  l.done();
});

test("a ship stopped at the gate of its counted early run cancels that run, whose id the gate hasn't read yet (#1894)", async () => {
  const [two, four]: Ship[] = [{}, {}];
  const l = await line(
    [{}, two, {}, four],
    (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }),
    (r) => {
      two.env = { FAKE_CI_GATE: join(r.dir, 'go') };
      // The early run is listed for early_look and early_gate, and not for the gate's own questions after them.
      four.env = { FAKE_UNLISTED: `f4.txt ${join(r.dir, 'listed')} 2`, LAND_CI_LATE: '20', LAND_CI_LATE_POLL: '0.2' };
    },
  );
  const all = l.go();
  await until("the early push beside ship 2's run", () => /its CI starts now/.test(l.out[1]));
  writeFileSync(join(l.r.dir, 'go'), '');
  await until("ship 4 at its early run's gate", () => /so that run is its CI/.test(l.out[3]) && /waiting for CI on/.test(l.out[3]));
  l.stop(4);
  writeFileSync(join(l.r.dir, 'listed'), '');
  const done = await all;
  assert.notEqual(done[3].status, 0);
  assert.equal(l.cancelled().length, 1, l.c.calls());
  assert.equal(l.hubAt('early/ticket/4-x'), '', 'its scratch branch goes');
});

test('a ship stopped while it pushes an early run leaves it to the next landing, which counts or drops it (#1894)', async () => {
  const [two, three]: Ship[] = [{}, {}];
  const l = await line(
    [{}, two, three, {}],
    (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }),
    (r) => {
      two.env = { FAKE_CI_GATE: join(r.dir, 'go') };
      three.env = { FAKE_UNLISTED: `f4.txt ${join(r.dir, 'listed')}`, LAND_CI_LATE: '20', LAND_CI_LATE_POLL: '0.2' };
      // GitHub has the early push, and is slow to say so.
      const hook = join(r.dir, 'hub.git', 'hooks', 'post-receive');
      writeFileSync(hook, `#!/bin/sh\nwhile read -r _ _ ref; do case $ref in refs/heads/early/*) until [ -e "${join(r.dir, 'stopped')}" ]; do sleep 0.05; done ;; esac; done\n`, { mode: 0o755 });
    },
  );
  const all = l.go();
  await until("the early push beside ship 2's run", () => l.hubAt('early/ticket/4-x') !== '');
  const early = git(join(l.r.dir, 'hub.git'), 'rev-parse', 'early/ticket/4-x');
  l.stop(2);
  writeFileSync(join(l.r.dir, 'stopped'), '');
  await until("the next landing's look for the early run", () => l.c.calls().includes(`head_sha=${early}`));
  const before = l.cancelled().length;
  writeFileSync(join(l.r.dir, 'listed'), ''); // a moment later GitHub lists it
  await until('the early run to be dropped', () => /dropped the early CI run/.test(l.out[2]));
  assert.equal(l.cancelled().length, before + 1, l.c.calls());
  writeFileSync(join(l.r.dir, 'listed.end'), '');
  const done = await all;
  for (const i of [3, 4]) assert.equal(done[i - 1].status, 0, done[i - 1].stderr);
  assert.equal(l.hubAt('early/ticket/4-x'), '', 'the next landing dropped it');
});

// The early run's train is the one its landing builds (#1568): a ship that would make it different (here ship 6, which
// ship 4's own landing, allowed two riders, would take) waits for the train after it, so the early run still counts.
test('early next train: the next landing rides only the riders its early run was stacked with, so it still counts (#1568)', async () => {
  const l = await line([{}, {}, {}, { env: { LAND_TRAIN_MAX: '2' } }, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /early next train: ticket\/4-x \(with ticket\/5-x riding\) is stacked/);
  assert.match(done[3].stderr, /it came out the same, so that run is its CI/);
  shipped(l, done[4], 5, 4, 2);
  assert.doesNotMatch(done[5].stderr, /shipped in ticket\/4-x's ship train/, 'ship 6 waits for the next train');
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5', 'f6.txt: 6']);
  l.done();
});

test('early next train: an early run that went red is dropped and runs again on its turn, and the train is bisected as usual (#1366)', async () => {
  const l = await line([{}, {}, {}, {}, { change: ['red.txt', 'red\n'] }], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', FAKE_RED_PATH: 'red.txt' }));
  const done = await l.go();
  assert.match(done[1].stderr, /land: early next train: ticket\/4-x \(with ticket\/5-x riding\) is stacked/);
  assert.match(done[3].stderr, /land: early next train: dropped the early CI run on ticket\/4-x's train \(the early run failed, so it runs again\)/);
  assert.equal(done[4].status, 1, 'ship 5 turned it red');
  for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.deepEqual(retro(l.r.dir, ' · discarded · '), ['early train · ticket/4-x · discarded · the early run failed, so it runs again']);
  assert.equal(git(l.r.dir + '/hub.git', 'for-each-ref', 'refs/heads/early-base/', 'refs/heads/early/', 'refs/heads/land-base/ticket/4-x', 'refs/heads/land/ticket/4-x'), '', 'no scratch branch of it is left on GitHub');
  l.done();
});

test("early next train: a record for a ship that wasn't next is dropped by the next landing to reach its gate (#1366)", async () => {
  const l = await line([{}], shared, (r) => {
    const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'early'), `${git(r.source, 'rev-parse', 'main')} ticket/9-x ${Math.floor(Date.now() / 1000)} ticket/8-x\n`);
  });
  const [d] = await l.go();
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /land: early next train: dropped the early CI run on ticket\/9-x's train \(ticket\/9-x wasn't next in line after all\)/);
  assert.ok(!existsSync(join(l.state, 'early')));
});

test('early next train: with no free runner nothing is pushed early, and with LAND_EARLY=0, <state>/early-off or the CI hold on nothing is tried (#1366, #1902)', async () => {
  // The one runner is online, so each ship's CI waits for its run, but busy (a heavy job holds it), so never free.
  const runners = JSON.stringify({ runners: [{ status: 'online', busy: true, labels: [{ name: 'citadel-ci-linux' }] }] });
  const l = await line(
    [{}, {}, {}, {}, {}],
    (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', FAKE_RUNNERS_FILE: join(d, 'runners') }),
    (r) => writeFileSync(join(r.dir, 'runners'), runners),
  );
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: early next train: no free citadel-ci-linux runner, so ticket\/4-x's CI waits for its turn/);
  assert.doesNotMatch(done[3].stderr, /early next train/);
  assert.deepEqual(retro(l.r.dir, ' · early train · '), []);
  l.done();
  for (const how of ['env', 'file', 'hold'] as const) {
    // With the hold on (#1906) it goes at a deploy alone, and not while another job is on the CI desktop.
    const off = await line([{}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', ...(how === 'env' ? { LAND_EARLY: '0' } : {}), ...(how === 'hold' ? { FAKE_ACTIVE: '1' } : {}) }), how === 'hold' ? holdOn : undefined);
    if (how === 'file') writeFileSync(join(off.state, 'early-off'), '');
    const offDone = await off.go();
    offDone.forEach((d, i) => assert.equal(d.status, 0, `${how}: ship ${i + 1}: ${d.stderr}`));
    const said = offDone.map((d) => d.stderr).join('\n');
    if (how === 'hold') assert.match(said, /early next train: another Citadel job is on the CI desktop or queued, so ticket\/\d-x's CI waits for its turn/);
    assert.doesNotMatch(said, how === 'hold' ? /is stacked on this train's top/ : /early next train/, how);
    assert.deepEqual(retro(off.r.dir, ' · early train · '), [], how);
    off.done();
  }
});

// A ship's own check (#1567, tools/own-check.sh; Cara, 2026-11-22, A "Gated, after C and B"): with someone in line and
// the check runner online, a ship's CI runs on that runner before it joins the line.
const own = (d: string) => ({ ...shared(d), FAKE_CHECK_RUNNERS: '1', LAND_OWN_CHECK_POLL: '0.05' });
const pushLog = (r: ReturnType<typeof setup>) => writeFileSync(join(r.dir, 'hub.git', 'hooks', 'post-receive'), `#!/bin/sh\nwhile read -r old new ref; do echo "$new $ref" >>'${join(r.dir, 'pushes')}'; done\n`, { mode: 0o755 });
const pushes = (dir: string) => (existsSync(join(dir, 'pushes')) ? readFileSync(join(dir, 'pushes'), 'utf8').trim().split('\n') : []);
const holdOn = (r: ReturnType<typeof setup>) => rmSync(join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'hold-off'));
test('with the CI hold on, the next train goes early at the deploy on an idle desktop, and an own check only when nothing else runs (#1906)', async () => {
  const l = await line([{}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }), holdOn);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  const said = done.map((d) => d.stderr).join('\n');
  assert.match(said, /early next train: ticket\/\d-x.* its CI starts now, while this one deploys/);
  assert.doesNotMatch(said, /while this one's CI runs/);
  l.done();
  for (const active of ['0', '1']) {
    const c = await line([{}, {}], (d) => ({ ...own(d), FAKE_ACTIVE: active }), holdOn);
    const ships = await c.go();
    ships.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    if (active === '0') assert.match(ships[1].stderr, /own check: green/);
    else assert.match(ships[1].stderr, /own check: another Citadel job is on the CI desktop or queued, so this joins the line unchecked/);
    c.done();
  }
});

// Ship 2, landed while ship 1 holds the line in its deploy; ship 2 is refused before it gets a ticket, so line() can't wait for it.
async function refusedBehind(change: [string, string], extra: Record<string, string>, before: (r: ReturnType<typeof setup>) => void = () => {}) {
  const l = await line(
    [{}],
    (d) => ({ ...own(d), ...extra }),
    (r) => (pushLog(r), before(r)),
  );
  const wt = join(l.r.dir, 'wt2');
  git(l.r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-x', wt);
  l.r.commit(wt, ...change);
  const d = await landAsync(wt, l.env, 150_000, () => {}); // (with no callback it keeps no stderr)
  const [first] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  return { l, d };
}

test('own check: green on the check runner, it joins the line and that run is its CI there, with no second run; alone in line, no check (#1567)', async () => {
  const l = await line([{}, {}], own, pushLog);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[0].stderr, /own check/, 'nobody was in line ahead of ship 1');
  assert.match(done[1].stderr, /land: own check: its CI runs now on the check runner, on [0-9a-f]{7,} \(rebased onto main [0-9a-f]{7,}\), before it joins the line/);
  assert.match(done[1].stderr, /land: own check: green in \d+ s \(https:\/\/ci\/\d+\), so it joins the line/);
  const p = pushes(l.r.dir);
  assert.ok(
    p.some((x) => x.endsWith(' refs/heads/check/ticket/2-x') && !/^0+ /.test(x)),
    `check/ticket/2-x pushed: ${p.join('; ')}`,
  );
  assert.ok(!p.some((x) => x.endsWith(' refs/heads/land/ticket/2-x')), `no land run pushed for ship 2: ${p.join('; ')}`);
  assert.ok(!git(join(l.r.dir, 'hub.git'), 'for-each-ref', 'refs/heads/check/', 'refs/heads/check-base/'), 'no check branch is left on GitHub');
  assert.equal(l.runs(), 2, "ship 1's run and ship 2's check, which was its CI in line too");
  assert.deepEqual(
    retro(l.r.dir, 'own check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
    ['own check · ticket/2-x · green · Ns'],
  );
  l.done();
});

// An earlier red check run of the same commit (handed off again unchanged) is no verdict on this one: the check waits
// for the run its own push starts, which GitHub lists a poll or two later.
test("own check: an earlier check run of the same commit is not taken for this one's (#1567)", async () => {
  const l = await line([{}, {}], (d) => ({ ...own(d), FAKE_CHECK_OLD: 'ticket/2-x 3' }));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: own check: green in \d+ s \(https:\/\/ci\/99\), so it joins the line/);
  assert.doesNotMatch(done[1].stderr, /ci\/3\b/);
  l.done();
});

test('own check: a burn-in red is refused before the line, with nobody waiting on it (#1567)', async () => {
  const { l, d } = await refusedBehind(bad(2).change as [string, string], { FAKE_REAL: realOf(2), FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  assert.equal(d.status, 1, d.stderr);
  assert.match(d.stderr, /own check: a new or changed test failed its burn-in in CI on its own check, on its commit rebased onto main \(https:\/\/ci\/\d+\): test\/p2\.test\.ts: failed in 3 of 10 copies at once\. A burn-in red is the ship's own, so it didn't join the line/);
  assert.doesNotMatch(d.stderr, /in line for the deploy lock/);
  assert.ok(!pushes(l.r.dir).some((x) => x.endsWith(' refs/heads/land/ticket/2-x')), 'it never got a run in line');
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1']);
  l.done();
});

test('own check: a file that failed again alone in CI, and here fails with the ship and passes on main, is refused before the line (#1567)', async () => {
  const { l, d } = await refusedBehind(bad(2).change as [string, string], { FAKE_REAL: realOf(2) });
  assert.equal(d.status, 1, d.stderr);
  assert.match(d.stderr, /own check: test\/p2\.test\.ts failed in its own CI run on its commit rebased onto main \(https:\/\/ci\/\d+\), and run alone here fail with this branch and pass on main, so it didn't join the line/);
  assert.match(d.stderr, /citadel-test test\/p2\.test\.ts/);
  assert.deepEqual(
    retro(l.r.dir, 'own check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
    ['own check · ticket/2-x · red: test/p2.test.ts · Ns'],
  );
  l.done();
});

test("own check: a refusal before the line has its timing line and leaves no times file, its own or an old killed landing's (#1864)", async () => {
  const { l, d } = await refusedBehind(bad(2).change as [string, string], { FAKE_REAL: realOf(2) }, (r) => {
    const old = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'times-999999');
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, 'start 1\n');
    utimesSync(old, 1, 1);
  });
  assert.equal(d.status, 1, d.stderr);
  assert.match(retro(l.r.dir, 'timing · ticket/2-x').join('\n'), /^timing · ticket\/2-x · .* · refused at line$/);
  assert.deepEqual(
    readdirSync(l.state).filter((f) => f.startsWith('times-')),
    [],
  );
  l.done();
});

test('own check: a red of flakes alone joins the line, where CI decides (#1567)', async () => {
  const l = await line([{}, { change: ['flaky.txt', 'x\n'] }], (d) => ({ ...own(d), FAKE_FLAKY_PATH: 'flaky.txt', FAKE_LOG: 'flakes' }));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /own check: red, but no test file failed again alone \(https:\/\/ci\/\d+\): flakes or a run cut off, so it joins the line/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'flaky.txt: x']);
  l.done();
});

test('own check: a check runner busy for longer than a ship waits sends it to the line unchecked; with no check runner nothing is tried (#1567)', async () => {
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const l = await line([{}, {}], own, (r) => {
      const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'own-check-run'), `${Math.floor(Date.now() / 1000)} ticket/9-x\n`);
      writeFileSync(join(state, 'own-check-secs'), '1000\n');
      holder = spawn('flock', [join(state, 'own-check.lock'), 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
    });
    await until('the check lock is held', () => spawnSync('flock', ['-n', join(l.state, 'own-check.lock'), 'true']).status === 1);
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    assert.match(done[1].stderr, /own check: ticket\/9-x's check has about 17 min to go, more than the 120 s a ship waits for it, so this one skips its own check/);
    assert.match(done[1].stderr, /light check: CI's side runner isn't free, so this joins the line unchecked/);
    assert.doesNotMatch(done[1].stderr, /check runner, on/);
    l.done();
  } finally {
    holder?.stdin?.end();
  }
  const off = await line([{}, {}], (d) => ({ ...own(d), FAKE_CHECK_RUNNERS: '0' }));
  const done = await off.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /own check/);
  off.done();
});

// The light check (#1620, tools/light-check.sh; Cara, 2026-11-22, "Fill #1567's gap"): a ship sent away by a busy check
// runner runs its own and affected test files on CI's side runner instead. heavy-ci.ts is faked: the fake logs where and
// how it was called, and prints FAKE_LIGHT_OUT as the run's output.
function busyCheck(r: ReturnType<typeof setup>) {
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'own-check-run'), `${Math.floor(Date.now() / 1000)} ticket/9-x\n`);
  writeFileSync(join(state, 'own-check-secs'), '1000\n');
  writeFileSync(
    join(r.dir, 'bin', 'fake-heavy'),
    `#!/usr/bin/env bash
{ echo "pwd $(pwd)"; echo "head $(git rev-parse HEAD)"; echo "ship \${CITADEL_HEAVY_SHIP:-}"; echo "args $*"; echo "log $(git log --format=%s -3 | tr '\\n' '|')"; } >>"${join(r.dir, 'heavy-calls')}"
printf '%b\\n' "\${FAKE_LIGHT_OUT:-light check: green}"
`,
    { mode: 0o755 },
  );
  return spawn('flock', [join(state, 'own-check.lock'), 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
}
const light = (d: string) => ({ ...own(d), FAKE_SIDE_RUNNERS: '1', LAND_LIGHT_CHECK_HEAVY: join(d, 'bin', 'fake-heavy') });
const heavyCalls = (dir: string) => (existsSync(join(dir, 'heavy-calls')) ? readFileSync(join(dir, 'heavy-calls'), 'utf8') : '');
const lockHeld = (state: string) => spawnSync('flock', ['-n', join(state, 'own-check.lock'), 'true']).status === 1;

test("light check: with the check runner busy, a ship's own tests run on the side runner, on its branch rebased onto main, and green joins the line (#1620)", async () => {
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const l = await line([{}, {}], light, (r) => (holder = busyCheck(r)));
    await until('the check lock is held', () => lockHeld(l.state));
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    assert.match(done[1].stderr, /land: light check: its own and affected test files run now on CI's side runner instead, on [0-9a-f]{7,} \(rebased onto main [0-9a-f]{7,}\)/);
    assert.match(done[1].stderr, /land: light check: green in \d+ s, so it joins the line/);
    const calls = heavyCalls(l.r.dir);
    const got = (k: string) => calls.match(new RegExp(`^${k} (.*)$`, 'm'))?.[1] ?? '';
    assert.equal(got('ship'), '1', 'it skips the wait for ships');
    assert.equal(got('log'), 'f2.txt: 2|f1.txt: 1|base|', 'ship 2 rebased onto ship 1');
    assert.equal(got('args'), `bash tools/light-check-run.sh ${git(l.r.source, 'rev-parse', `${got('head')}^`)}`, 'against main, its base');
    assert.notEqual(got('pwd'), l.wts[1], "in a scratch worktree, not the ship's");
    assert.ok(!existsSync(got('pwd')), 'its scratch worktree is gone');
    assert.deepEqual(
      retro(l.r.dir, 'light check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
      ['light check · ticket/2-x · green · Ns'],
    );
    l.done();
  } finally {
    holder?.stdin?.end();
  }
});

test("light check: a red that is the ship's own is refused before the line, with nobody waiting on it (#1620)", async () => {
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const l = await line(
      [{}],
      (d) => ({ ...light(d), FAKE_LIGHT_OUT: '✖ test/p2.test.ts:3 › breaks\\nlight check: red: test/p2.test.ts, test/p3.test.ts' }),
      (r) => (holder = busyCheck(r)),
    );
    await until('the check lock is held', () => lockHeld(l.state));
    const wt = join(l.r.dir, 'wt2');
    git(l.r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-x', wt);
    l.r.commit(wt, 'f2.txt', '2\n');
    const d = await landAsync(wt, l.env, 150_000, () => {});
    const [first] = await l.go();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(d.status, 1, d.stderr);
    assert.match(d.stderr, /light check: test\/p2\.test\.ts, test\/p3\.test\.ts failed on CI's side runner, on its commit rebased onto main, and run alone there fail with this branch and pass on main \(or are new with it\), so it didn't join the line/);
    assert.match(d.stderr, /citadel-test test\/p2\.test\.ts test\/p3\.test\.ts\)/);
    assert.match(d.stderr, /✖ test\/p2\.test\.ts:3 › breaks/, "the run's output is shown");
    assert.doesNotMatch(d.stderr, /in line for the deploy lock/);
    assert.deepEqual(
      retro(l.r.dir, 'light check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
      ['light check · ticket/2-x · red: test/p2.test.ts, test/p3.test.ts · Ns'],
    );
    assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1']);
    l.done();
  } finally {
    holder?.stdin?.end();
  }
});

test('light check: no verdict joins the line; with the side runner busy, or LAND_LIGHT_CHECK=0, nothing runs (#1620)', async () => {
  for (const [extra, said, logged] of [
    [{ FAKE_LIGHT_OUT: 'light check: no verdict: test/p2.test.ts passed alone (flakes)' }, /light check: test\/p2\.test\.ts passed alone \(flakes\), so it joins the line, where CI decides/, ['light check · ticket/2-x · no verdict: test/p2.test.ts passed alone (flakes) · Ns']],
    [{ FAKE_LIGHT_OUT: 'citadel-heavy: no runner took it' }, /light check: the run ended without one \(citadel-heavy: no runner took it\), so it joins the line/, ['light check · ticket/2-x · no verdict: the run ended without one (citadel-heavy: no runner took it) · Ns']],
    [{ FAKE_SIDE_RUNNERS: '0' }, null, ['light check · ticket/2-x · skipped: no idle side runner']],
    [{ LAND_LIGHT_CHECK: '0' }, null, []],
  ] as [Record<string, string>, RegExp | null, string[]][]) {
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      const l = await line(
        [{}, {}],
        (d) => ({ ...light(d), ...extra }),
        (r) => (holder = busyCheck(r)),
      );
      await until('the check lock is held', () => lockHeld(l.state));
      const done = await l.go();
      done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
      if (said) assert.match(done[1].stderr, said);
      else assert.equal(heavyCalls(l.r.dir), '', 'no light check ran');
      assert.deepEqual(
        retro(l.r.dir, 'light check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
        logged,
      );
      assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2']);
      l.done();
    } finally {
      holder?.stdin?.end();
    }
  }
});

// #1417: the front's restart held for a starved box (deploy.sh's <state>/hold) tells each rider when it expects to be
// live, and an urgent fix riding the train (the land tool's outage: true) marks that restart to skip the hold.
test('riders of a restart held for a starved box say when it expects to be live; only an urgent rider marks it to skip the hold (#1417)', async () => {
  for (const urgent of [false, true]) {
    const l = await line([{}, { env: { FAKE_NOT_LIVE: '1' } }, { env: urgent ? { LAND_URGENT: '1' } : {} }, {}]);
    writeFileSync(join(l.state, 'hold'), `${Math.floor(Date.now() / 1000) + 600} CPU pressure 63%\n`);
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    for (const i of [3, 4]) assert.match(done[i - 1].stderr, /^deploy: not live yet: the restart ticket\/2-x's ship train queued carries it; the box is starved \(CPU pressure 63%\), so it waits for it to ease, live by about \d\d?:\d\d P[SD]T at the latest/m, `ship ${i}`);
    assert.equal(existsSync(join(l.state, 'urgent')), urgent, urgent ? 'the urgent rider marks the restart' : 'no urgent rider, no mark');
    l.done();
  }
});

// Its restart takes the mark as it starts (#1865): one left later would let the next, unrelated restart skip the hold.
test('an urgent rider marks its restart only while it still waits: for turns, yes; once it is under way or over, no', async () => {
  for (const [at, active, underWay] of [
    ['waiting', true, false],
    ['under way', true, true],
    ['over', false, false],
  ] as const) {
    const l = await line([{}, { env: { FAKE_NOT_LIVE: '1' } }, { env: { LAND_URGENT: '1' } }], {}, (r) => {
      writeFileSync(join(r.dir, 'bin', 'systemctl'), `#!/bin/sh\ncase "$*" in *'is-active -q cc-restart-when-idle'*) exit ${active ? 0 : 3} ;; esac\nexit 1\n`, { mode: 0o755 });
    });
    if (underWay) writeFileSync(join(l.state, 'restart'), `${process.pid} ${readFileSync('/proc/self/stat', 'utf8').split(') ').pop()!.split(' ')[19]}\nrestarting claude-coordinator since 10:00\n`);
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    assert.match(done[2].stderr, /^deploy: not live yet: the restart ticket\/2-x's ship train queued carries it, and reports here too/m);
    assert.equal(existsSync(join(l.state, 'urgent')), at === 'waiting', at);
    l.done();
  }
});
