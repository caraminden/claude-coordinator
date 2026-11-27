// Part 1 of 2 of the land-train-early tests (#2208); the shared setup is in land-train-early-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEP, ci, depsRepo, git, seen, type setup } from './land-fixture.ts';
import { type Ship, line, shipped, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';
import { prepped, retro, own, pushLog, pushes } from './land-train-early-setup.ts';

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

// A rider that changed main's red test and left it red may have broken it again, so it can't ship through (#1478). Only it
// leaves the train (#2212; Cara, 2026-11-27, "Hold only that ship"): the front runs CI again without it and ships through
// main's red; the rider, back in line and alone, is refused (its change doesn't make the test pass).
test("a train with a rider that changed main's red test ships through without it; the rider then alone is refused (#1478, #2212)", async () => {
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
  assert.match(
    done[1].stderr,
    /red on main too: not this train's: test\/real\.test\.ts fails run alone on main's tip [0-9a-f]{7,} here too, and it is the only real failure of this train's CI run \(https:\/\/ci\/\d+\), but ticket\/3-x changed test\/real\.test\.ts or what it imports, so it can't ship through main's red: back in line, refused for nothing, and the train runs again without it/,
  );
  assert.doesNotMatch(done[1].stderr, /keeping its place in line and riding the next train/, 'the front takes no retry in place');
  assert.equal(done[1].status, 0, done[1].stderr);
  assert.match(done[1].stderr, /SHIPPING THROUGH MAIN'S RED: test\/real\.test\.ts .* of this ship's CI run/, 'the front, without it, ships through');
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.doesNotMatch(done[2].stderr, /SHIPPING THROUGH|shipped through/, "the rider doesn't ship through");
  assert.match(done[2].stderr, /ticket\/3-x changed test\/real\.test\.ts or what it imports, yet it still fails: main is red and this change doesn't make it pass/, 'alone, the rider hears its change is no fix');
  assert.deepEqual(l.subjects().slice(-2), ['f1.txt: 1', 'f2.txt: 2'], "only the front's change landed");
  l.done();
});

// Hold only the suspect (#2212; Cara, 2026-11-27, "Hold only that ship"): of a train of three red only on main's red, the
// rider that changes a file the red test imports goes back in line; the train runs CI again without it, the other two ship
// through main's red, and the rider, alone, is refused as #1430 refuses a ship whose change doesn't make the red pass.
const imports = (r: ReturnType<typeof setup>) => {
  r.commit(r.source, 'test/lib.ts', 'export const x = 1;\n');
  r.commit(r.source, 'test/real.test.ts', "import './lib.ts'; throw new Error('red on main');\n");
  seen(join(r.dir, 'shared'), ['test/slow.test.ts']);
};

test("a train red only on main's red holds only the rider that reaches the red test; the other two ship through (#2212)", async () => {
  const l = await line([{ env: { FAKE_RED_PATH: 'nothing.txt' } }, {}, { change: ['test/lib.ts', 'export const x = 3;\n'] }, {}], (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }), imports);
  const done = await l.go();
  assert.equal(done[0].status, 0, done[0].stderr);
  const front = done[1].stderr;
  assert.match(front, /but ticket\/3-x changed test\/real\.test\.ts or what it imports, so it can't ship through main's red: back in line, refused for nothing, and the train runs again without it/);
  assert.equal(done[1].status, 0, front);
  assert.match(front, /SHIPPING THROUGH MAIN'S RED: test\/real\.test\.ts .* of this train's CI run .*, all 2 ships/, 'the two left ship through');
  shipped(l, done[3], 4, 2, 2);
  assert.match(done[3].stderr, /^land: shipped through main's red on test\/real\.test\.ts$/m);
  const red = front.match(/the only real failure of this train's CI run \(https:\/\/ci\/(\d+)\), but/)?.[1];
  const through = front.match(/SHIPPING THROUGH MAIN'S RED: .* of this train's CI run \(https:\/\/ci\/(\d+)\)/)?.[1];
  assert.ok(red && through && red !== through, `the train without the suspect had a CI run of its own: ${red}, ${through}`);
  assert.match(l.c.calls(), new RegExp(`head_sha=${git(l.r.source, 'rev-parse', 'main')}`), 'CI ran on the commit that shipped');
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /ticket\/3-x changed test\/real\.test\.ts or what it imports, yet it still fails/, 'alone, the suspect hears its change is no fix');
  assert.deepEqual(l.subjects().slice(-3), ['f1.txt: 1', 'f2.txt: 2', 'f4.txt: 4'], "the suspect's change didn't land");
  l.done();
});

test("a train red only on main's red whose front reaches the red test: the front steps aside and the next ship leads the rest through (#2212)", async () => {
  const l = await line([{ env: { FAKE_RED_PATH: 'nothing.txt' } }, { change: ['test/lib.ts', 'export const x = 2;\n'] }, {}, {}], (d) => ({ FAKE_RED_PATH: 'test/real.test.ts', ...shared(d) }), imports);
  const done = await l.go();
  assert.equal(done[0].status, 0, done[0].stderr);
  assert.match(done[1].stderr, /but ticket\/2-x, at the front, changed test\/real\.test\.ts or what it imports, so it can't ship through main's red: it steps aside, keeping its place in line and refused for nothing, and the next ship runs the train without it/);
  assert.equal(done[2].status, 0, done[2].stderr);
  assert.match(done[2].stderr, /SHIPPING THROUGH MAIN'S RED: test\/real\.test\.ts .* of this train's CI run .*, all 2 ships/, 'the next ship leads the rest through');
  shipped(l, done[3], 4, 3, 2);
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.match(done[1].stderr, /ticket\/2-x changed test\/real\.test\.ts or what it imports, yet it still fails/, 'alone, the front hears its change is no fix');
  assert.deepEqual(l.subjects().slice(-3), ['f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4'], "the front's change didn't land");
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
