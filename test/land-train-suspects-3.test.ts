// Part 3 of 4 of the land-train-suspects tests (#2208); the shared setup is in land-train-suspects-setup.ts.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { line, shared, shipped } from './land-train-fixture.ts';
import { guess, tests, ships, env, real, back, taken, retro, runs, clean, guessed } from './land-train-suspects-setup.ts';

test('two ships that fail only together: both are pulled, neither fails alone, both go back in line, and the first ships alone while the second is refused by its own run on top of it', async () => {
  const l = await line(ships(6, { 3: guess('real', 3), 5: guess('real', 5) }), (d) => ({ FAKE_RED_BOTH: 'real3.ts real5.ts', ...shared(d) }), tests('real'));
  const done = await l.go();
  back(done, 5);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts; a guess: waits for the verdict\), #5 \(test\/real\.test\.ts; a guess: waits for the verdict\)/);
  guessed(done[2], 'test/real.test.ts', 'shipped');
  guessed(done[4], 'test/real.test.ts');
  assert.equal(runs(l, done), 5, "ship 1's, the red train's, the smaller train's, and #3's and #5's own");
  clean(l);
});

test('no guess: the back half is pulled and the front half is tested, with nobody from the line in the empty seats', async () => {
  const l = await line(ships(8, { 6: { change: ['red.txt', 'red\n'] } }), env(real('a', 'red.txt'), { LAND_TRAIN_MAX: '5' }), tests('a'));
  const done = await l.go();
  back(done, 6);
  assert.match(done[1].stderr, /bisect: testing the first 3 of 6 ships/);
  assert.deepEqual(taken(done[1]), ['3 4 5 6 7']);
  for (const i of [3, 4]) shipped(l, done[i - 1], i, 2, 3);
  clean(l);
});

test('every ship on the train named and none red alone: nothing would be left to test, so the train is cut in half', async () => {
  const l = await line(ships(4, { 2: guess('a', 2), 3: guess('a', 3), 4: guess('a', 4) }), env(real('a', 'a3.ts')), tests('a'));
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: the files name every ship there is to pull for test\/a\.test\.ts and none of them failed alone, so the bisect looks for the ship/);
  back(done, 3);
  clean(l);
});

test('a front and a rider that both changed the red test, the rider red alone: it goes back, and the front ships on the next train (#1918)', async () => {
  const l = await line(ships(5, { 2: { change: ['h2.ts', 'export {};\n'] }, 4: { change: ['h4.ts', "throw new Error('racy');\n"] } }), env('test/h.test.ts=h4.ts', { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' }), tests('h'));
  const done = await l.go();
  back(done, 4);
  assert.match(done[1].stderr, /suspects: #2 \(test\/h\.test\.ts; passed alone: waits for the next train\), #4 \(test\/h\.test\.ts; failed alone: sent back\)/);
  clean(l);
});

test('a front that steps aside takes no ship built on a pulled one into the next front: those go back in line', async () => {
  const l = await line(ships(7, { 2: guess('a', 2), 3: guess('a', 3), 4: { on: 3 }, 5: { on: 2 } }), env(real('a', 'a2.ts', 'a3.ts')), tests('a'));
  const done = await l.go();
  for (const i of [4, 5]) assert.match(done[1].stderr, new RegExp(`ticket/${i}-x goes back in line: it sits on a ship this train pulled`));
  for (const i of [2, 3]) guessed(done[i - 1], 'test/a.test.ts');
  shipped(l, done[6], 7, 6, 2);
  assert.equal(taken(done[5])[0], '7');
  clean(l);
});

// Ship 5's test fails here only with ship 3 under it, so its runs on the train's prefixes name ship 5, and that is no proof.
test('a test that fails here only with two ships together is proof against neither: the one its runs on the train name is pulled on a guess, and the words say which run failed', async () => {
  const pair = "import { existsSync } from 'node:fs';\nif (existsSync('x3.txt') && existsSync('x5.txt')) throw new Error('only together');\n";
  const l = await line(
    ships(6, { 3: { change: ['x3.txt', '3\n'] }, 5: { change: ['x5.txt', '5\n'] } }),
    (d) => ({ FAKE_RED_BOTH: 'x3.txt x5.txt', ...shared(d) }),
    (r) => r.commit(r.source, 'test/real.test.ts', pair),
  );
  const done = await l.go();
  back(done, 5);
  assert.match(done[1].stderr, /suspects: #5 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red/);
  assert.match(done[4].stderr, /in test\/real\.test\.ts\. It was pulled off the train on that guess: run alone on perigee it passed on the train up to the ship before ticket\/5-x and failed with ticket\/5-x on it\. The train without it passed, but no ship pulled for it failed it by itself on main/);
  for (const t of [retro(l), ...done.map((d) => d.stderr)]) assert.doesNotMatch(t, /failed alone( here)?:|so it is the cause/);
  clean(l);
});

test('a likely ship that sits on another ship of the train has no run of its own, and is never said to have had one', async () => {
  const l = await line(ships(6, { 3: { change: ['n.txt', '3\n'] }, 4: { on: 3, also: ['a4.ts', 'export {};\n'] } }), env(real('a', 'a4.ts')), tests('a'));
  const done = await l.go();
  back(done, 4);
  assert.match(done[3].stderr, /pulled off the train on that guess: it couldn't be run on perigee with ticket\/4-x by itself on main\. The train without it passed, but no ship pulled for it failed it by itself on main/);
  assert.doesNotMatch(done.map((d) => d.stderr).join(''), /it did not stay red with/);
  clean(l);
});

test("a last red whose log doesn't name every failed file proves nothing of a held ship: it goes back in line", async () => {
  // The front alone is the last run: red on its own test/c, and the log names one file of the two it counts.
  const l = await line(ships(3, { 2: { change: ['red.txt', 'red\n'] }, 3: guess('a', 3) }), env(`${real('a', 'a3.ts')} ${real('c', 'red.txt')}`, { FAKE_REAL_FIRST: '1', FAKE_REAL_SHORT: 'test/c.test.ts' }), tests('a'));
  const done = await l.go();
  back(done, 2, 3);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.doesNotMatch(done[2].stderr, /pulled off the train on that guess/);
  clean(l);
});

test('a ship held on a guess whose train loses its last rider too goes back in line: the front alone says nothing of it', async () => {
  const l = await line(ships(4, { 3: guess('a', 3), 4: { on: 3 } }), env(real('a', 'a3.ts')), tests('a'));
  const done = await l.go();
  assert.match(done[1].stderr, /ticket\/4-x stays in line \(it sits on a ship this train holds off as a likely cause\)/);
  assert.equal(done[1].status, 0, done[1].stderr);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.doesNotMatch(done[2].stderr, /on ticket\/2-x's ship train/);
  clean(l);
});
