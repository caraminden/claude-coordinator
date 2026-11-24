// The ship train (#1166, tools/land.sh): the landing at the front of the line takes the plain lands waiting behind it,
// tests them in one CI run and ships them in one deploy; a red train is bisected, and its first red ship refused.
// Split (#1723): riders, guards, flakes and restarts in land-train-riders.test.ts; main's red, conflict prep, the early
// next train and the own and light checks in land-train-early.test.ts; the shared line() in land-train-fixture.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git } from './land-fixture.ts';
import { line, shipped, bad, realOf } from './land-train-fixture.ts';
import { until } from './wait.ts';

test('five ships waiting in line ship as one train: one CI run, one deploy, each with its own shipped line', async () => {
  const l = await line([{}, {}, {}, {}, {}, {}]);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.deepEqual(l.subjects(), ['base', ...done.map((_, i) => `f${i + 1}.txt: ${i + 1}`)]);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 4 ships waiting behind it \(ticket\/3-x ticket\/4-x ticket\/5-x ticket\/6-x\): CI runs once on all 5/);
  assert.equal(l.runs(), 2, "ship 1's run and the train's");
  assert.deepEqual(l.deployed(), [git(l.r.source, 'rev-parse', 'main~5'), git(l.r.source, 'rev-parse', 'main')], "ship 1's deploy and the train's");
  for (let i = 3; i <= 6; i++) {
    shipped(l, done[i - 1], i, 2, 5);
    assert.doesNotMatch(done[i - 1].stderr, /land: rebasing/, 'a rider never rebases or tests on its own');
  }
  l.done();
});

test('a red train is bisected: the ship that turned it red is refused with its own failure, and the other four ship', async () => {
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\), and its bisect found ticket\/4-x the first ship that turned it red/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'its own failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the red ship is as it was');
  assert.match(done[1].stderr, /suspects: no ship on the train touched test\/real\.test\.ts or what it imports, so the bisect looks for the ship/, 'the real failure maps to no ship (#1346)');
  assert.match(done[1].stderr, /the bisect found ticket\/4-x the first ship that turned the train red \(https:\/\/ci\/\d+\): it is refused, and the 1 before it ship/);
  // Each step for the Releases page (#1368, src/land-news.ts): the leader and ticket/3-x, then ticket/4-x too.
  assert.deepEqual(
    [...done[1].stderr.matchAll(/^land: bisect: testing the first (\d+) of (\d+) ships$/gm)].map((m) => `${m[1]}/${m[2]}`),
    ['2/5', '3/5'],
  );
  for (const i of [1, 2, 3, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  // The ships after the red one went back in line, and shipped as the next train.
  assert.match(done[4].stderr, /back in line on its own: the ship train went without ticket\/5-x/);
  shipped(l, done[5], 6, 5, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6']);
  assert.equal(l.runs(), 5, "ship 1's, the train's, two for the bisect, and the next train's");
  assert.equal(l.deployed().length, 3);
  l.done();
});

// Suspects first (#1346): a real failure (the fake's log says test/real.test.ts failed again alone) is pinned on the ships
// whose change touched that test or what it imports. Here the test passes alone on perigee (only CI's machine fails it),
// so they are a guess: they wait off the train, and are refused once it is green without them (#1403).
test('a red train whose real failure maps to one ship: only it is refused, the next in line takes its place, and the rest ship on one more CI run', async () => {
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', '// red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'test/real.test.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed, so it is likely the cause/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the suspect is as it was');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\): CI is red .* #4: perigee cannot fail those tests alone, so the files are only a guess/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 3 ships waiting behind it \(ticket\/3-x ticket\/5-x ticket\/6-x\)/, 'ship 6 takes its place');
  assert.match(done[1].stderr, /#4 is refused: the train without it passed test\/real\.test\.ts/);
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5, 6]) shipped(l, done[i - 1], i, 2, 4);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 4, "ship 1's, the red train's, the refilled train's, and ship 7's");
  assert.equal(l.deployed().length, 3);
  l.done();
});

// A fixture test that imports <file> once it exists, so it passes on main and red-on-main (#1430) stays out of the
// way (split, so test/pipeline-files.test.ts doesn't read it as this file importing the fixture).
const importIf = (file: string) => `import { existsSync } from 'node:fs'; if (existsSync(new URL('../${file}', import.meta.url))) await imp` + `ort('../${file}');`;
const importX = importIf('x.ts');
test('a suspect found through what the failing test imports is refused, and a ship stacked on it stays out of the refill rather than bring its change back', async () => {
  // Ship 1 adds the test, importing x.ts once it exists (so it passes on main, #1430); ship 4 adds x.ts, which turns CI red;
  // ship 5 starts from ship 4's branch. x.ts passes run alone (CI's red is the fake's), so the files decide, not perigee.
  const l = await line([{ change: ['test/real.test.ts', `${importX}\n`] }, {}, {}, { change: ['x.ts', 'export {};\n'] }, { on: 4 }, {}, {}], { FAKE_RED_PATH: 'x.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.match(done[3].stderr, /in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed, so it is likely the cause.*Look into it: fix it if it is yours, re-test, commit, then run this again/s);
  assert.match(done[1].stderr, /ship train: ticket\/5-x stays in line \(it sits on a ship this train holds off as a likely cause\)/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 3 ships waiting behind it \(ticket\/3-x ticket\/6-x ticket\/7-x\)/);
  assert.doesNotMatch(done[1].stderr, /red again|bisect/);
  for (const i of [1, 2, 3, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 6, 7]) shipped(l, done[i - 1], i, 2, 4);
  assert.equal(done[3].status, 1);
  assert.equal(done[4].status, 1, "ship 5 carries ship 4's change, so it is red on its own turn");
  assert.deepEqual(l.subjects(), ['base', `test/real.test.ts: ${importX}`, 'f2.txt: 2', 'f3.txt: 3', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 4, "ship 1's, the red train's, the refilled train's, and ship 5's");
  l.done();
});

// #1443: a red burn-in names its racy file, so the ship that added or changed it is the suspect, with no bisect.
test("a train red in its burn-in: the ship that changed the racy test is refused with the burn-in's words, and the rest ship", async () => {
  const l = await line([{}, {}, { change: ['test/real.test.ts', 'racy\n'] }, {}], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  const done = await l.go();
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /land: a new or changed test failed its burn-in in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\): test\/real\.test\.ts, which ticket\/3-x changed or which imports what it changed, so it is likely the cause, and it was taken off the train/);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts\)/);
  assert.doesNotMatch(done[1].stderr, /bisect|running CI once more/);
  for (const i of [1, 2, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[3], 4, 2, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f4.txt: 4']);
  l.done();
});

// #1564 (Cara 2026-11-21, C "Go"): a train with three bad riders refuses all three after its one red run, not one a run.
test('a train red in its burn-in on three racy tests refuses the three ships that changed them after that one red run, and the rest ship (#1564)', async () => {
  const l = await line([{}, {}, bad(3), bad(4), {}, bad(6), {}], { FAKE_REAL: realOf(3, 4, 6), FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  const done = await l.go();
  const red = done[2].stderr.match(/ship train \((https:\/\/ci\/\d+)\)/)?.[1];
  for (const i of [3, 4, 6]) {
    assert.equal(done[i - 1].status, 1, done[i - 1].stderr);
    assert.match(done[i - 1].stderr, new RegExp(`a new or changed test failed its burn-in in CI on ticket/2-x's ship train \\(${red}\\): test/p${i}\\.test\\.ts, which ticket/${i}-x changed`), 'refused on the same red run');
  }
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 5, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [5, 7]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the refilled train's");
  l.done();
});

test('a train red on three tests that each fail alone here refuses the three ships that turn them red after that one red run, with no bisect (#1564)', async () => {
  const l = await line([{}, {}, bad(3), bad(4), {}, bad(6), {}], { FAKE_REAL: realOf(3, 4, 6) });
  const done = await l.go();
  const red = done[2].stderr.match(/ship train \((https:\/\/ci\/\d+)\)/)?.[1];
  assert.match(done[1].stderr, /suspects: running test\/p3\.test\.ts test\/p4\.test\.ts test\/p6\.test\.ts alone on the train's commits here, 3 at a time/);
  for (const i of [3, 4, 6]) {
    assert.equal(done[i - 1].status, 1, done[i - 1].stderr);
    assert.match(done[i - 1].stderr, new RegExp(`tests failed in CI on ticket/2-x's ship train \\(${red}\\) in test/p${i}\\.test\\.ts, and run alone on perigee it passed .* and failed with it, so it is the cause`), 'refused on the same red run');
  }
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 5, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [5, 7]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the refilled train's");
  l.done();
});

// Before #1564 the one file no ship could be pinned on sent the whole train to a bisect, which finds one ship a round.
test('a red train with two confirmed causes and a failure no ship can be pinned on refuses the two at once; red again on that file, the bisect finds the third (#1564)', async () => {
  const l = await line([{}, {}, bad(3), bad(4), { change: ['red.txt', 'red\n'] }, {}], { FAKE_REAL: `${realOf(3, 4)} test/real.test.ts=red.txt` });
  const done = await l.go();
  const red = done[2].stderr.match(/ship train \((https:\/\/ci\/\d+)\)/)?.[1];
  for (const i of [3, 4]) {
    assert.equal(done[i - 1].status, 1, done[i - 1].stderr);
    assert.match(done[i - 1].stderr, new RegExp(`ship train \\(${red}\\) in test/p${i}\\.test\\.ts, and run alone on perigee it passed .* so it is the cause`), 'refused on the same red run');
  }
  assert.match(done[1].stderr, /suspects: no ship could be pinned on test\/real\.test\.ts, so they stay on the train while the confirmed causes leave/);
  assert.match(done[1].stderr, /red again on test\/real\.test\.ts, which no ship could be pinned on, now that the confirmed causes are off the train: the bisect looks for the ship/);
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /its bisect found ticket\/5-x the first ship that turned it red/);
  for (const i of [1, 2, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f6.txt: 6']);
  l.done();
});

test('a refilled train red again on the same test: the guess was wrong, so the held suspect goes back in line unrefused and the bisect finds the ship', async () => {
  // Ship 4 touched the failing test (which passes alone on perigee), but ship 5 is what turns CI red.
  // Ship 2's run stays in progress until the next train's early run is pushed beside it (#1568), so the red drops it.
  const go = join(mkdtempSync(join(tmpdir(), 'early-go-')), 'go');
  const l = await line([{}, { env: { FAKE_CI_GATE: go } }, {}, { change: ['test/real.test.ts', '// x\n'] }, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt', LAND_TRAIN_MAX: '3' });
  const all = l.go();
  await until("the early push beside ship 2's run", () => /its CI starts now/.test(l.out[1]));
  writeFileSync(go, '');
  const done = await all;
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.match(done[1].stderr, /#4 goes back in line: the train was red again on test\/real\.test\.ts without it, so the guess was wrong/);
  assert.doesNotMatch(done[3].stderr, /refuse|likely the cause/, 'the innocent suspect is never refused (#1403)');
  assert.match(done[1].stderr, /red again on test\/real\.test\.ts with the likely causes off the train, so the guess was wrong: the bisect looks for the ship/);
  assert.match(done[1].stderr, /the bisect found ticket\/5-x the first ship that turned the train red \(https:\/\/ci\/\d+\): it is refused, and the 1 before it ship/);
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /its bisect found ticket\/5-x the first ship that turned it red/);
  for (const i of [1, 2, 3, 4, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  // Ship 4, back in line, fronts the next train with ships 6 and 7.
  for (const i of [6, 7]) shipped(l, done[i - 1], i, 4, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'test/real.test.ts: // x', 'f6.txt: 6', 'f7.txt: 7']);
  // The next train's early run (#1568) started beside the red train's and was dropped with it; the refilled train stacks
  // the next one again (dropped too if it was pushed before that train went red), and at the deploy ship 4's train is
  // stacked once more, and that run counts. Each dropped run is a run the early start cost.
  assert.match(done[1].stderr, /early next train: dropped the early CI run on ticket\/6-x's train \(the train ahead went red\)/);
  assert.match(done[1].stderr, /early next train: ticket\/4-x \(with ticket\/6-x ticket\/7-x riding\) is stacked on this train's top and its CI starts now, while this one deploys/);
  assert.match(done[3].stderr, /early next train: CI started on this train at \d\d:\d\d beside ticket\/2-x's, and it came out the same, so that run is its CI/);
  const drops = done[1].stderr.match(/dropped the early CI run on \S+ train \(the train ahead went red\)/g)!.length;
  assert.equal(l.runs(), 6 + drops, "ship 1's, the red train's, the refilled train's, two for the bisect, the next train's (its early run), and each early run dropped with a red");
  l.done();
});

test("a held suspect whose test CI didn't rerun on the refilled train is no pass: it goes back in line unrefused (#1403)", async () => {
  // Ship 4 touched the failing test (which passes alone on perigee), ship 5 turns CI red; the refilled train's log has a
  // new real failure first, so CI never reruns test/real.test.ts alone there.
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', '// x\n'] }, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt', FAKE_LOG: 'swap', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.match(done[1].stderr, /#4 goes back in line: the train was red again on test\/real\.test\.ts without it, so the guess was wrong/);
  assert.doesNotMatch(done[1].stderr, /#4 is refused/);
  assert.doesNotMatch(done[3].stderr, /refuse|likely the cause/, 'the innocent suspect is never refused');
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /its bisect found ticket\/5-x the first ship that turned it red/);
  for (const i of [1, 2, 3, 4, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a files guess that names two ships holds neither: a green run without both could not tell which, so the bisect finds the ship (#1403)', async () => {
  // test/real.test.ts imports a.ts and b.ts; ship 3 changes a.ts, ship 4 adds b.ts, which is what turns CI red.
  const l = await line([{}, {}, { change: ['a.ts', 'export const a = 2;\n'] }, { change: ['b.ts', 'export const b = 1;\n'] }, {}], { FAKE_RED_PATH: 'b.ts' }, (r) => {
    writeFileSync(join(r.source, 'a.ts'), 'export const a = 1;\n');
    r.commit(r.source, 'test/real.test.ts', `import '../a.ts';\n${importIf('b.ts')}\n`); // b.ts once it exists: green on main (#1430)
  });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: the files name more than one ship \(#3, #4\) for test\/real\.test\.ts/);
  assert.doesNotMatch(done[2].stderr, /refuse|likely the cause/, 'the innocent one is never refused');
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /its bisect found ticket\/4-x the first ship that turned it red/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// Ship 3 turns CI red; ship 4 adds the failing test file, which perigee can't fail for real: a pin that took one bad
// run as red would blame an innocent ship, so each must give no pin, the files hold ship 4, and the bisect finds ship 3.
for (const [what, body, env] of [
  ['fails only on its first run here (load)', "import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync(process.env.FLAKE_ONCE)) { writeFileSync(process.env.FLAKE_ONCE, ''); throw new Error('load'); }\n", {}],
  // timing-ok: the body of a fake test land.sh runs alone, slower than LAND_PIN_LIMIT; nothing here waits on it
  ['runs past LAND_PIN_LIMIT here', 'await new Promise((r) => setTimeout(r, 8000));\n', { LAND_PIN_LIMIT: '1' }],
] as const) {
  test(`a failing test that ${what} pins no ship: the run once more on each side, or a stop, is no answer (#1403)`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'land-pin-'));
    const l = await line([{}, {}, { change: ['red.txt', 'red\n'] }, { change: ['test/real.test.ts', body] }, {}], { FAKE_RED_PATH: 'red.txt', FLAKE_ONCE: join(tmp, 'flag'), ...env });
    const done = await l.go();
    rmSync(tmp, { recursive: true, force: true });
    assert.doesNotMatch(done[1].stderr, /Run alone here, they failed with/, 'no pin');
    assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\): CI is red .* #4: perigee cannot fail those tests alone/);
    assert.match(done[1].stderr, /#4 goes back in line/);
    assert.equal(done[2].status, 1, done[2].stderr);
    assert.match(done[2].stderr, /its bisect found ticket\/3-x the first ship that turned it red/);
    for (const i of [1, 2, 4, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });
}

test('a front that is only a files guess is not refused on it: the bisect finds the ship (#1403)', async () => {
  const l = await line([{}, { change: ['test/real.test.ts', '// x\n'] }, {}, { change: ['red.txt', 'red\n'] }], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: ticket\/2-x itself is only a guess from the files for test\/real\.test\.ts, and it can't wait off its own train, so the bisect looks for the ship/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /its bisect found ticket\/4-x the first ship that turned it red/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a front whose failing test fails alone here with it and passes on main is refused as the cause, and its riders ship next (#1403)', async () => {
  const l = await line([{}, { change: ['src/props.ts', "throw new Error('props.propose');\n"] }, {}, {}], { FAKE_RED_TEXT: 'props.propose' }, (r) => {
    mkdirSync(join(r.source, 'src'));
    writeFileSync(join(r.source, 'src', 'props.ts'), 'export const props = 1;\n');
    r.commit(r.source, 'test/real.test.ts', "import '../src/props.ts';\n");
  });
  const done = await l.go();
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.match(done[1].stderr, /land: tests failed in CI on its ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, and run alone on perigee it passed on main and failed with ticket\/2-x on it, so it is the cause/);
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// The Nov 20 case (#1403, shared reports/incident-2026-11-20-2106-cause.md): the failing test reaches the culprit's file
// only through a hub it imports (level 2), and an innocent ship changed that hub (level 1), so the files alone blame the
// innocent one. Run alone here on the train's prefixes, the test names the ship that turns it red.
test('a failing test that fails alone here pins the ship that turns it red: the culprit behind a hub is refused, the ship that changed the hub ships, with no bisect', async () => {
  const l = await line([{}, {}, { change: ['src/db.ts', "import './props.ts';\nexport const db = 2;\n"] }, { change: ['src/props.ts', "throw new Error('props.propose');\n"] }, {}], { FAKE_RED_TEXT: 'props.propose' }, (r) => {
    mkdirSync(join(r.source, 'src'));
    writeFileSync(join(r.source, 'src', 'db.ts'), "import './props.ts';\nexport const db = 1;\n");
    writeFileSync(join(r.source, 'src', 'props.ts'), 'export const props = 1;\n');
    r.commit(r.source, 'test/real.test.ts', "import '../src/db.ts';\n");
  });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, and run alone on perigee it passed on the train up to the ship before ticket\/4-x and failed with it, so it is the cause/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the culprit is as it was');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\): CI is red .* Run alone here, they failed with #4 and passed on the train before it, so that is the cause/);
  assert.doesNotMatch(done[1].stderr, /#3 \(|bisect/, 'the ship that changed the hub is no suspect, and no bisect runs');
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the refilled train's");
  l.done();
});

// A guard test that scans files rather than importing them (test/one-pacific.test.ts on Nov 20, 23:03 PST): the files
// guess can never name a ship for it, but run alone here on the train's prefixes it still names the one that turns it red.
test('a guard that names the file behind its failure: the ship that changed that file is the suspect, not the one that changed what the guard reads (#1451)', async () => {
  const l = await line([{}, {}, { change: ['test/flake-baseline.json', '{"a":2}\n'] }, { change: ['test/loop-lag.test.ts', '// sleep\n'] }, {}], { FAKE_RED_PATH: 'test/loop-lag.test.ts', FAKE_RED_NAMES: 'loop-lag.test.ts:22 5 `sleep` hits, the baseline allows 3' }, (r) => {
    mkdirSync(join(r.source, 'test'), { recursive: true });
    writeFileSync(join(r.source, 'test', 'flake-baseline.json'), '{"a":1}\n');
    r.commit(r.source, 'test/real.test.ts', "import { readFileSync } from 'node:fs';\nreadFileSync('test/flake-baseline.json');\n");
  });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.doesNotMatch(done[1].stderr, /#3 \(|bisect/, 'the ship that changed the baseline is no suspect');
  assert.equal(done[3].status, 1, done[3].stderr);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// #1538 (from #1488, bounced twice on Nov 21): test/judges.test.ts goes red when a judge's pinned code changed without a
// re-recorded replay, and says which files are pinned. The ship that changed one of those is the suspect, not the one that
// only edited judges.test.ts (or its replay record).
test('a judge-replay red names the pinned code: the ship that changed it is the suspect, not the one that re-recorded the replay file the test reads (#1538)', async () => {
  const l = await line(
    [{}, {}, { change: ['test/judge-replays.json', '{"a":2}\n'] }, { change: ['test/pinned-judge.ts', 'export const X = 2;\n'] }, {}],
    { FAKE_RED_PATH: 'test/pinned-judge.ts', FAKE_REAL_FILE: 'test/judges.test.ts', FAKE_RED_NAMES: 'the flake counter code changed since its last replay (pinned code: test/pinned-judge.ts)' },
    (r) => {
      mkdirSync(join(r.source, 'test'), { recursive: true });
      writeFileSync(join(r.source, 'test', 'judge-replays.json'), '{"a":1}\n');
      r.commit(r.source, 'test/judges.test.ts', "import { readFileSync } from 'node:fs';\nreadFileSync('test/judge-replays.json');\n");
    },
  );
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/judges\.test\.ts\)/);
  assert.doesNotMatch(done[1].stderr, /#3 \(|bisect/, 'the ship that only edited the judge test is no suspect');
  assert.equal(done[3].status, 1, done[3].stderr);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a scan-style guard test that imports nothing still pins the ship that turns it red, with no bisect (#1403)', async () => {
  const l = await line([{}, {}, { change: ['public/other.js', 'x\n'] }, { change: ['public/sidebar.js', "const at = 'props.propose';\n"] }, {}], { FAKE_RED_TEXT: 'props.propose' }, (r) => {
    mkdirSync(join(r.source, 'public'));
    writeFileSync(join(r.source, 'public', 'sidebar.js'), 'const at = 1;\n');
    r.commit(r.source, 'test/real.test.ts', "import { readFileSync } from 'node:fs';\nif (readFileSync('public/sidebar.js', 'utf8').includes('props.' + 'propose')) throw new Error('scan');\n");
  });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /run alone on perigee it passed on the train up to the ship before ticket\/4-x and failed with it, so it is the cause/);
  assert.doesNotMatch(done[1].stderr, /no ship on the train touched|bisect/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});
