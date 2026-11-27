// Part 1 of 4 of the land-train tests (#2208); the shared setup is in land-train-setup.ts.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git } from './land-fixture.ts';
import { type Ship, line, shipped } from './land-train-fixture.ts';
import { until } from './wait.ts';
import { importX } from './land-train-setup.ts';

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
// so they are a guess: they wait off the train, and once it is green without them they go back in line to ship alone, so
// their own run is the proof (#2098; before, the green alone refused them). Nobody from the line takes their seats (#1918).
test('a red train whose real failure maps to one ship: only it is pulled, nobody from the line takes its seat, the rest ship on one more CI run, and its own run alone refuses it', async () => {
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', '// red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'test/real.test.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(
    done[3].stderr,
    /land: back in line to ship alone: ticket\/2-x's ship train was red in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed\. It was pulled off the train on that guess: run alone on perigee it did not stay red with ticket\/4-x by itself on main\. The train without it passed, but no ship pulled for it failed it by itself on main, so that proves nothing, and its own CI run decides/,
  );
  assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\)/, 'refused by its own run alone, the proof');
  assert.doesNotMatch(done[3].stderr, /tests failed in CI on ticket\/2-x's ship train/, 'never refused for the guess');
  assert.doesNotMatch(done[3].stderr, /so it is (likely )?the cause/);
  assert.match(done[3].stderr, /pulled off ticket\/2-x's ship train on a guess, red in test\/real\.test\.ts: waiting for CI on the train without it/, 'it says why it waits');
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'show', 'ticket/4-x:test/real.test.ts'), '// red', 'the suspect keeps its change (rebased by its own run, as any refused ship)');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red .* #4: not red alone here, so the files are only a guess/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 2 ships waiting behind it \(ticket\/3-x ticket\/5-x\)/, 'ship 6 stays in line');
  assert.match(done[1].stderr, /#4 goes back in line to ship alone: it was pulled on a guess, and the train without it passed test\/real\.test\.ts, but no ship pulled for it failed it alone, so its own CI run decides/);
  assert.doesNotMatch(done[1].stderr, /is refused/);
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  shipped(l, done[6], 7, 6, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 7, "ship 1's, the red train's, what is left of it, #4's own, the next train's, and the two early runs of it #4's red dropped");
  assert.equal(l.deployed().length, 3);
  l.done();
});

test('a suspect found through what the failing test imports is pulled, and a ship stacked on it stays off what is left rather than bring its change back', async () => {
  // Ship 1 adds the test, importing x.ts once it exists (so it passes on main, #1430); ship 4 adds x.ts, which turns CI red;
  // ship 5 starts from ship 4's branch. x.ts passes run alone (CI's red is the fake's), so the files decide, not perigee.
  const l = await line([{ change: ['test/real.test.ts', `${importX}\n`] }, {}, {}, { change: ['x.ts', 'export {};\n'] }, { on: 4 }, {}, {}], { FAKE_RED_PATH: 'x.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess/);
  assert.match(done[3].stderr, /back in line to ship alone: ticket\/2-x's ship train was red in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed\. It was pulled off the train on that guess/);
  assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI/, 'its own run alone refuses it');
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

// #2141: the rider's refusal reads the burn-in's alone line from the log's last lines the front passes it.
test('a rider whose burn-in red failed alone too on CI is refused as a plain red, not a race', async () => {
  const l = await line([{}, {}, { change: ['test/real.test.ts', 'red\n'] }, {}], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', FAKE_BURN_ALONE: 'failed' });
  const done = await l.go();
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /land: a new or changed test failed its burn-in in CI on ticket\/2-x's ship train .*test\/real\.test\.ts failed in every copy, and run once by itself on CI it fails alone too: a plain red or a CI-only environment fault/);
  assert.doesNotMatch(done[2].stderr, /fix the race/);
  for (const i of [1, 2, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});
