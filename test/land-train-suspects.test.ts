// Part 1 of 4 of the land-train-suspects tests (#2208); the shared setup is in land-train-suspects-setup.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bad, line, realOf, shipped } from './land-train-fixture.ts';
import { guess, tests, ships, env, real, back, taken, runs, clean, guessed, proven, once } from './land-train-suspects-setup.ts';

// Josh's example, with 2 to 8 for his 1 to 7: 4 and 6 look likely and are pulled, then the front; the other four ship.
test("Josh's train of seven: two are pulled at once, red on another test the front is pulled too, and the other four ship on the third run", async () => {
  const l = await line(ships(9, { 2: guess('b', 2), 4: guess('a', 4), 6: guess('a', 6) }), env(`${real('a', 'a4.ts', 'a6.ts')} ${real('b', 'b2.ts')}`, { FAKE_REAL_FIRST: '1' }), tests('a', 'b'));
  const done = await l.go();
  back(done, 2, 4, 6);
  assert.match(done[1].stderr, /suspects: #4 \(test\/a\.test\.ts; a guess: waits for the verdict\), #6 \(test\/a\.test\.ts; a guess: waits for the verdict\): CI is red/);
  assert.equal(taken(done[1])[1], '3 5 7 8', 'ship 9, in line, takes no empty seat');
  assert.match(done[1].stderr, /suspects: #2 \(test\/b\.test\.ts; a guess: waits for the verdict\): CI is red/);
  for (const i of [5, 7, 8]) shipped(l, done[i - 1], i, 3, 4);
  for (const i of [4, 6]) guessed(done[i - 1], 'test/a.test.ts');
  guessed(done[1], 'test/b.test.ts');
  assert.equal(runs(l, done), 8, "ship 1's, the train's three, #2's, #4's and #6's own, and ship 9's");
  assert.deepEqual(l.deployed().length, 3, 'the four go live together');
  clean(l);
});

test('a wrong first guess blames nobody: red again on the same test, the pulled ship goes back in line and ships', async () => {
  // Ship 4 adds a file test/a imports, but red.txt of ship 6 is what turns it red, and no ship left can be named for it.
  const l = await line(ships(7, { 4: guess('a', 4), 6: { change: ['red.txt', 'red\n'] } }), env(real('a', 'red.txt')), tests('a'));
  const done = await l.go();
  assert.deepEqual(taken(done[1]).slice(0, 2), ['3 4 5 6 7', '3 5 6 7']);
  assert.match(done[1].stderr, /#4 goes back in line: the train was red again on test\/a\.test\.ts without it, so the guess was wrong/);
  back(done, 6);
  assert.doesNotMatch(done[3].stderr, /refuse|likely the cause/);
  clean(l);
});

test('a guilty front ship that fails its test alone is sent back with the proof, and what is left of its train ships on one more run, with nobody from the line', async () => {
  const l = await line(ships(6, { 2: bad(2) }), env(realOf(2), { LAND_TRAIN_MAX: '3' }));
  const done = await l.go();
  back(done, 2);
  proven(done[1], 'test/p2.test.ts');
  assert.deepEqual(taken(done[2])[0], '4 5');
  assert.match(done[2].stderr, /runs on what is left of ticket\/2-x's red train, with nobody else from the line/);
  for (const i of [4, 5]) shipped(l, done[i - 1], i, 3, 3);
  assert.equal(runs(l, done), 4, "ship 1's, the red train's, what is left of it, and ship 6's");
  clean(l);
});

test('a front that is only a guess steps aside: the ships left run without it, and their green sends it back', async () => {
  const l = await line(ships(6, { 2: guess('a', 2) }), env(real('a', 'a2.ts'), { LAND_TRAIN_MAX: '3' }), tests('a'));
  const done = await l.go();
  back(done, 2);
  assert.match(done[1].stderr, /ticket\/2-x steps aside: the next ship in line runs the train with what is left of it/);
  guessed(done[1], 'test/a.test.ts');
  assert.equal(taken(done[2])[0], '4 5');
  for (const i of [4, 5]) shipped(l, done[i - 1], i, 3, 3);
  clean(l);
});

test('a front that steps aside on a wrong guess ships in the end, blamed for nothing', async () => {
  const l = await line(ships(6, { 2: guess('a', 2), 4: { change: ['red.txt', 'red\n'] } }), env(real('a', 'red.txt')), tests('a'));
  const done = await l.go();
  back(done, 4);
  assert.match(done[2].stderr, /#2 goes back in line: the train was red again on test\/a\.test\.ts without it, so the guess was wrong/);
  clean(l);
});
