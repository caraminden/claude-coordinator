// The ship train (#1166, tools/land.sh): the landing at the front of the line takes the plain lands waiting behind it,
// tests them in one CI run and ships them in one deploy; a red train is bisected, and its first red ship refused.
// Split (#1723): riders, guards, flakes and restarts in land-train-riders.test.ts; main's red, conflict prep, the early
// next train and the own and light checks in land-train-early.test.ts; the shared line() in land-train-fixture.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen } from './land-fixture.ts';
import { type Ship, line, shipped, bad, realOf } from './land-train-fixture.ts';
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

// #1864 (LA1): a rider got none of the front's steps after its rebase, so two ADRs 0027 shipped in one train.
test("a rider gets the front's steps: the next free ADR number, and its prompt baseline measured again", async () => {
  const budget = `test/${'prompt-budget'}.test.ts`; // built, not quoted: test/pipeline-files.test.ts reads quoted test names
  const base = 'test/prompt-baseline.json';
  const adr = (n: number) => [`docs/adr/0002-${n}.md`, `# ADR 0002: ${n}\n`] as [string, string];
  const l = await line([{}, { also: adr(2) }, { also: adr(3) }, { also: [base, 'stale\n'] }, { also: adr(5) }], {}, (r) => {
    for (const d of ['docs/adr', 'test']) mkdirSync(join(r.source, d), { recursive: true });
    r.commit(r.source, 'docs/adr/0001-first.md', '# ADR 0001: first\n');
    r.commit(r.source, base, 'old\n');
    r.commit(r.source, budget, `import { writeFileSync } from 'node:fs';\nif (process.env.PROMPT_BASELINE === 'write') writeFileSync(new URL('prompt-baseline.json', import.meta.url), 'measured\\n');\n`);
    git(r.wt, 'merge', '-q', '--ff-only', 'main');
  });
  for (const n of [2, 3, 4, 5]) {
    git(l.wts[n - 1], 'reset', '-q', '--soft', git(l.wts[n - 1], 'merge-base', 'main', 'HEAD'));
    git(l.wts[n - 1], 'commit', '-q', '-m', `#${n}: adr`);
  }
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 3 ships waiting behind it/);
  const adrs = git(l.r.source, 'ls-tree', '--name-only', 'main:docs/adr').split('\n');
  assert.deepEqual(adrs, ['0001-first.md', '0002-2.md', '0003-3.md', '0004-5.md']);
  assert.equal(git(l.r.source, 'show', 'main:docs/adr/0004-5.md'), '# ADR 0004: 5');
  assert.match(done[1].stderr, /ADR 0002 → 0003: the ship train took 0002/);
  assert.equal(git(l.r.source, 'show', `main:${base}`), 'measured');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/5-x'), git(l.r.source, 'rev-parse', 'main'), 'its branch holds its renumbering');
  l.done();
});

test('a rider whose commit lost its #N: title stays in line, and is refused for it at the front', async () => {
  const l = await line([{}, {}, { change: ['f3.txt', '#3: kept\n'], also: ['g3.txt', 'lost\n'] }], {});
  git(l.wts[2], 'commit', '-q', '--amend', '-m', 'lost it');
  git(l.wts[2], 'commit', '-q', '--allow-empty', '-m', '#3: kept');
  const done = await l.go();
  assert.match(done[1].stderr, /ship train: ticket\/3-x stays in line \(a commit of it lost its #N: title\)/);
  assert.equal(done[2].status, 1);
  assert.match(done[2].stderr, /lost its #N: title/);
  l.done();
});

test('a red train is bisected: the ship that turned it red is refused with its own failure, and the other four ship', async () => {
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'its own failure, on its own stderr');
  assert.match(done[1].stderr, /suspects: no ship on the train touched test\/real\.test\.ts or what it imports, so the bisect looks for the ship/, 'the real failure maps to no ship (#1346)');
  assert.match(done[1].stderr, /bisect: the first 2 of 5 ships tested green, so they ship now; back in line with nobody refused: ticket\/4-x ticket\/5-x ticket\/6-x; the red may be: ticket\/4-x ticket\/5-x ticket\/6-x/);
  // Each step for the Releases page (#1368, src/land-news.ts): the leader and ticket/3-x, which ship.
  assert.deepEqual(
    [...done[1].stderr.matchAll(/^land: bisect: testing the first (\d+) of (\d+) ships$/gm)].map((m) => `${m[1]}/${m[2]}`),
    ['2/5'],
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

test("a ship stopped during its train's bisect cancels the step's run, whose id it hasn't read yet (#1894)", async () => {
  const two: Ship = {};
  const l = await line([{}, two, {}, { change: ['red.txt', 'red\n'] }], { FAKE_RED_PATH: 'red.txt' }, (r) => {
    two.env = { FAKE_UNLISTED: `f2.txt ${join(r.dir, 'listed')}`, LAND_CI_LATE: '20', LAND_CI_LATE_POLL: '0.2' };
  });
  const all = l.go();
  await until("the bisect's first step in CI", () => /bisect: testing the first 1 of 3/.test(l.out[1]) && l.hubAt('land/ticket/2-x') === 'f2.txt: 2');
  const id = 6 + l.runs();
  l.stop(2);
  writeFileSync(join(l.r.dir, 'listed'), '');
  const done = await all;
  assert.notEqual(done[1].status, 0);
  assert.deepEqual(l.cancelled(), [String(id)]);
  assert.equal(l.hubAt('land/ticket/2-x'), '', 'its scratch branch goes');
  assert.equal(done[2].status, 0, done[2].stderr); // the ships behind it carry on
});

// Suspects first (#1346): a real failure (the fake's log says test/real.test.ts failed again alone) is pinned on the ships
// whose change touched that test or what it imports. Here the test passes alone on perigee (only CI's machine fails it),
// so they are a guess: they wait off the train, and are refused once it is green without them (#1403). Nobody from the
// line takes their seats (#1918).
test('a red train whose real failure maps to one ship: only it is refused, nobody from the line takes its seat, and the rest ship on one more CI run', async () => {
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', '// red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'test/real.test.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(
    done[3].stderr,
    /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed\. It was pulled off the train on that guess: run alone on perigee it did not stay red with ticket\/4-x by itself on main\. No ship pulled for it failed it by itself on main, and the train without them passed/,
  );
  assert.doesNotMatch(done[3].stderr, /so it is (likely )?the cause/);
  assert.match(done[3].stderr, /pulled off ticket\/2-x's ship train on a guess, red in test\/real\.test\.ts: waiting for CI on the train without it/, 'it says why it waits');
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the suspect is as it was');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red .* #4: not red alone here, so the files are only a guess/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 2 ships waiting behind it \(ticket\/3-x ticket\/5-x\)/, 'ship 6 stays in line');
  assert.match(done[1].stderr, /#4 is refused: it was pulled on a guess, no ship pulled for test\/real\.test\.ts failed it alone, and the train without it passed it/);
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  shipped(l, done[6], 7, 6, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 4, "ship 1's, the red train's, what is left of it, and the next train's");
  assert.equal(l.deployed().length, 3);
  l.done();
});

// A fixture test that imports <file> once it exists, so it passes on main and red-on-main (#1430) stays out of the
// way (split, so test/pipeline-files.test.ts doesn't read it as this file importing the fixture).
const importIf = (file: string) => `import { existsSync } from 'node:fs'; if (existsSync(new URL('../${file}', import.meta.url))) await imp` + `ort('../${file}');`;
const importX = importIf('x.ts');
test('a suspect found through what the failing test imports is refused, and a ship stacked on it stays off what is left rather than bring its change back', async () => {
  // Ship 1 adds the test, importing x.ts once it exists (so it passes on main, #1430); ship 4 adds x.ts, which turns CI red;
  // ship 5 starts from ship 4's branch. x.ts passes run alone (CI's red is the fake's), so the files decide, not perigee.
  const l = await line([{ change: ['test/real.test.ts', `${importX}\n`] }, {}, {}, { change: ['x.ts', 'export {};\n'] }, { on: 4 }, {}, {}], { FAKE_RED_PATH: 'x.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess/);
  assert.match(done[3].stderr, /in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed\. It was pulled off the train on that guess.*Look into it: fix it if it is yours, re-test, commit, then run this again/s);
  assert.match(done[1].stderr, /ship train: ticket\/5-x stays in line \(it sits on a ship this train holds off as a likely cause\)/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 1 ships waiting behind it \(ticket\/3-x\)/);
  assert.match(done[4].stderr, /back in line on its own/, 'ship 5 is blamed for nothing on that train');
  assert.doesNotMatch(done[1].stderr, /red again|bisect/);
  for (const i of [1, 2, 3, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  assert.equal(done[3].status, 1);
  assert.equal(done[4].status, 1, "ship 5 carries ship 4's change, so it is red on its own turn");
  assert.deepEqual(l.subjects(), ['base', `test/real.test.ts: ${importX}`, 'f2.txt: 2', 'f3.txt: 3', 'f6.txt: 6', 'f7.txt: 7']);
  l.done();
});

// #1443: a red burn-in names its racy file, so the ship that added or changed it is the suspect, with no bisect.
test("a train red in its burn-in: the ship that changed the racy test is refused with the burn-in's words, and the rest ship", async () => {
  const l = await line([{}, {}, { change: ['test/real.test.ts', 'racy\n'] }, {}], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  const done = await l.go();
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /land: a new or changed test failed its burn-in in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\): test\/real\.test\.ts, and run alone on perigee it passed on main and failed with ticket\/3-x by itself on main, so it is the cause, and it was taken off the train/);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts; failed alone: sent back\)/);
  assert.doesNotMatch(done[1].stderr, /bisect|running CI once more/);
  for (const i of [1, 2, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[3], 4, 2, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f4.txt: 4']);
  l.done();
});

// #1564 (Cara 2026-11-21, C "Go"): a train with three bad riders refuses all three after its one red run, not one a run.
// #2019: a burn-in race passes alone, so a run alone can't prove it. A case no ship before this one has needs no proof:
// only the ship that adds it can have turned it red.
const racyCase = "import test from 'node:test';\ntest('a racy case', () => {});\n";
const burnCase = { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', FAKE_CASE: 'a racy case' };

test('a train red in its burn-in on a case one ship adds refuses that ship at once, though it passes alone, and the rest ship (#2019)', async () => {
  const l = await line([{}, {}, { change: ['test/p3.test.ts', racyCase] }, {}], { FAKE_REAL: realOf(3), ...burnCase });
  const done = await l.go();
  assert.equal(done[2].status, 1);
  assert.match(done[2].stderr, /a new or changed test failed its burn-in in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\): test\/p3\.test\.ts, and ticket\/3-x adds the test case that failed/);
  assert.doesNotMatch(done[1].stderr, /a guess|bisect/);
  assert.match(done[1].stderr, /#3 \(test\/p3\.test\.ts; adds the failing case: sent back\)/);
  assert.equal(done[1].status, 0, done[1].stderr);
  assert.equal(done[3].status, 0, done[3].stderr);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f4.txt: 4']);
  l.done();
});

test('a ship that edits a file whose failing burn-in case was already there is still only a guess (#2019)', async () => {
  const edit = { change: ['test/p3.test.ts', `${racyCase}// edited\n`] as [string, string], also: ['f3.txt', '3\n'] as [string, string] };
  const l = await line([{}, {}, edit, {}], { FAKE_REAL: 'test/p3.test.ts=f3.txt', ...burnCase }, (r) => {
    r.commit(r.source, 'test/p3.test.ts', racyCase);
  });
  const done = await l.go();
  assert.match(done[1].stderr, /a guess: waits for the verdict/);
  assert.doesNotMatch(done[1].stderr, /adds the failing case/);
  l.done();
});

test('a bisect step red in its burn-in on a case the front adds refuses the front with no further step (#2019)', async () => {
  const front = { change: ['test/p2.test.ts', racyCase] as [string, string] };
  const l = await line([{}, front, {}, {}, {}, {}], { FAKE_REAL: realOf(2), FAKE_LOG_WHOLE: 'f6.txt', ...burnCase });
  const done = await l.go();
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.deepEqual(
    [...done[1].stderr.matchAll(/^land: bisect: testing the first (\d+) of (\d+) ships$/gm)].map((m) => `${m[1]}/${m[2]}`),
    ['2/5'],
  );
  for (const i of [3, 4, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a bisect step red in its burn-in on a case a rider adds refuses that rider, which passes alone (#2019)', async () => {
  const rider = { change: ['test/p3.test.ts', racyCase] as [string, string] };
  const l = await line([{}, {}, rider, {}, {}, {}], { FAKE_REAL: realOf(3), FAKE_LOG_WHOLE: 'f6.txt', ...burnCase });
  const done = await l.go();
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /ticket\/3-x adds the test case that failed/);
  assert.deepEqual(
    [...done[1].stderr.matchAll(/^land: bisect: testing the first (\d+) of (\d+) ships$/gm)].map((m) => `${m[1]}/${m[2]}`),
    ['2/5'],
  );
  for (const i of [2, 4, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a train red in its burn-in on three racy tests refuses the three ships that changed them after that one red run, and the rest ship (#1564)', async () => {
  const l = await line([{}, {}, bad(3), bad(4), {}, bad(6), {}], { FAKE_REAL: realOf(3, 4, 6), FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  const done = await l.go();
  const red = done[2].stderr.match(/ship train \((https:\/\/ci\/\d+)\)/)?.[1];
  for (const i of [3, 4, 6]) {
    assert.equal(done[i - 1].status, 1, done[i - 1].stderr);
    assert.match(done[i - 1].stderr, new RegExp(`a new or changed test failed its burn-in in CI on ticket/2-x's ship train \\(${red}\\): test/p${i}\\.test\\.ts, and run alone on perigee it passed on main and failed with ticket/${i}-x`), 'refused on the same red run');
  }
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 5, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [5, 7]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the smaller train's");
  l.done();
});

test('a train red on three tests that each fail alone here refuses the three ships that turn them red after that one red run, with no bisect (#1564)', async () => {
  const l = await line([{}, {}, bad(3), bad(4), {}, bad(6), {}], { FAKE_REAL: realOf(3, 4, 6) });
  const done = await l.go();
  const red = done[2].stderr.match(/ship train \((https:\/\/ci\/\d+)\)/)?.[1];
  assert.match(done[1].stderr, /suspects: running test\/p3\.test\.ts test\/p4\.test\.ts test\/p6\.test\.ts alone on the train's commits here, 3 at a time/);
  for (const i of [3, 4, 6]) {
    assert.equal(done[i - 1].status, 1, done[i - 1].stderr);
    assert.match(done[i - 1].stderr, new RegExp(`tests failed in CI on ticket/2-x's ship train \\(${red}\\) in test/p${i}\\.test\\.ts, and run alone on perigee it passed on main and failed with ticket/${i}-x by itself on main, so it is the cause`), 'refused on the same red run');
  }
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 5, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [5, 7]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the smaller train's");
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
  assert.match(done[1].stderr, /suspects: no ship could be pinned on test\/real\.test\.ts, so they stay on the train while the likely causes leave/);
  assert.match(done[1].stderr, /suspects: no ship on the train touched test\/real\.test\.ts or what it imports, so the bisect looks for the ship/);
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /land: tests failed on the rebased branch in CI/);
  for (const i of [1, 2, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f6.txt: 6']);
  l.done();
});

test('a train red again on the same test without its suspect: the guess was wrong, so the held suspect goes back in line unrefused and the bisect finds the ship', async () => {
  // Ship 4 touched the failing test (which passes alone on perigee), but ship 5 is what turns CI red.
  // Ship 2's run stays in progress until the next train's early run is pushed beside it (#1568), so the red drops it.
  const go = join(mkdtempSync(join(tmpdir(), 'early-go-')), 'go');
  const l = await line([{}, { env: { FAKE_CI_GATE: go } }, {}, { change: ['test/real.test.ts', '// x\n'] }, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt', LAND_TRAIN_MAX: '3' });
  const all = l.go();
  await until("the early push beside ship 2's run", () => /its CI starts now/.test(l.out[1]));
  writeFileSync(go, '');
  const done = await all;
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess/);
  assert.match(done[1].stderr, /#4 goes back in line: the train was red again on test\/real\.test\.ts without it, so the guess was wrong/);
  assert.doesNotMatch(done[3].stderr, /refuse|likely the cause/, 'the innocent suspect is never refused (#1403)');
  assert.match(done[1].stderr, /suspects: no ship on the train touched test\/real\.test\.ts or what it imports, so the bisect looks for the ship/);
  assert.match(done[1].stderr, /bisect: testing the first 1 of 3 ships/);
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /land: tests failed on the rebased branch in CI/);
  for (const i of [1, 2, 3, 4, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'test/real.test.ts: // x', 'f6.txt: 6', 'f7.txt: 7']);
  // The next train's early run (#1568) started beside the red train's and was dropped with it. The split starts none, so
  // the only other ones are stacked on ship 4's train, which is no part of the split.
  assert.match(done[1].stderr, /early next train: dropped the early CI run on ticket\/6-x's train \(the train ahead went red\)/);
  const drops = done.flatMap((d) => d.stderr.match(/^land: early next train: dropped the early CI run on \S+ train \(the train ahead went red\)/gm) ?? []).length;
  assert.equal(l.runs(), 7 + drops, "ship 1's, the red train's, the smaller train's, one for the bisect, ship 4's train's, ships 5's and 6's, and each early run dropped with a red");
  l.done();
});

test("a held suspect whose test CI didn't rerun on the smaller train is no pass: it goes back in line unrefused (#1403)", async () => {
  // Ship 4 touched the failing test (which passes alone on perigee), ship 5 turns CI red; the smaller train's log has a
  // new real failure first, so CI never reruns test/real.test.ts alone there.
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', '// x\n'] }, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt', FAKE_LOG: 'swap', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess/);
  assert.match(done[1].stderr, /#4 goes back in line: the train was red again on test\/real\.test\.ts without it, so the guess was wrong/);
  assert.doesNotMatch(done[1].stderr, /#4 is refused/);
  assert.doesNotMatch(done[3].stderr, /refuse|likely the cause/, 'the innocent suspect is never refused');
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /land: tests failed on the rebased branch in CI/);
  for (const i of [1, 2, 3, 4, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
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
    assert.doesNotMatch(done[1].stderr, /Run alone on main here, the tests failed with/, 'no pin');
    assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red .* #4: not red alone here/);
    assert.match(done[1].stderr, /#4 goes back in line/);
    assert.equal(done[2].status, 1, done[2].stderr);
    assert.match(done[2].stderr, /land: tests failed on the rebased branch in CI/);
    for (const i of [1, 2, 4, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });
}

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
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, and run alone on perigee it passed on main and failed with ticket\/4-x by itself on main, so it is the cause/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the culprit is as it was');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; failed alone: sent back\): CI is red .* Run alone on main here, the tests failed with #4 and passed without, so that is the cause/);
  assert.doesNotMatch(done[1].stderr, /#3 \(|bisect/, 'the ship that changed the hub is no suspect, and no bisect runs');
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the smaller train's");
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
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess/);
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
  assert.match(done[1].stderr, /suspects: #4 \(test\/judges\.test\.ts; a guess/);
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
  assert.match(done[3].stderr, /run alone on perigee it passed on main and failed with ticket\/4-x by itself on main, so it is the cause/);
  assert.doesNotMatch(done[1].stderr, /no ship on the train touched|bisect/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// #1827: a ship that declares Regenerate files holds the line. In line behind ship 1's deploy with ships 2 and 3 ahead
// of it, ship 4 goes next, alone; the ships behind may stack on it (early next) but none ships before it.
test('a ship that declares Regenerate files goes first among the waiters, alone, and the ships ahead of it in line wait for it', async () => {
  const l = await line([{}, {}, {}, { trailers: 'Regenerate: true\nRegenerate-files: f4.txt' }, {}]);
  assert.match(l.out[3], /ticket\/4-x declares Regenerate files \(f4\.txt\), so it holds the line/);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f4.txt: 4', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5']);
  assert.doesNotMatch(done[3].stderr, /ship train:/, 'it ships alone');
  assert.match(done[1].stderr, /in line for the deploy lock, about \d+ min \(ahead: ticket\/4-x/, 'ship 2, first in line before it, waited behind it');
  l.done();
});
