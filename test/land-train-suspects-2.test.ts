// Part 2 of 4 of the land-train-suspects tests (#2208); the shared setup is in land-train-suspects-setup.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bad, line, realOf } from './land-train-fixture.ts';
import { guess, tests, ships, env, real, back, taken, retro, runs, clean, guessed, proven, once } from './land-train-suspects-setup.ts';

test('two tests red at once, one ship red alone and one only a guess: the first goes back with the proof, the second once the rest is green', async () => {
  const l = await line(ships(6, { 3: guess('a', 3), 5: bad(5) }), env(`test/a.test.ts=a3.ts ${realOf(5)}`), tests('a'));
  const done = await l.go();
  back(done, 3, 5);
  proven(done[4], 'test/p5.test.ts');
  guessed(done[2], 'test/a.test.ts');
  assert.equal(runs(l, done), 4, "ship 1's, the red train's, the smaller train's and #3's own");
  clean(l);
});

test('a burn-in red on one test two ships changed: the one that fails it alone goes back, the one that passes alone waits for the next train and ships', async () => {
  const l = await line(ships(6, { 3: { change: ['h3.ts', "throw new Error('racy');\n"] }, 5: { change: ['h5.ts', 'export {};\n'] } }), env('test/h.test.ts=h3.ts', { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' }), tests('h'));
  const done = await l.go();
  back(done, 3);
  assert.match(done[1].stderr, /suspects: #3 \(test\/h\.test\.ts; failed alone: sent back\), #5 \(test\/h\.test\.ts; passed alone: waits for the next train\)/);
  assert.match(done[2].stderr, /failed its burn-in in CI .*: test\/h\.test\.ts, and run alone on perigee it passed on main and failed with ticket\/3-x by itself on main, so it is the cause/);
  assert.equal(taken(done[1])[1], '4 6');
  assert.match(retro(l), /ship train suspects · .* · failed alone here: #3 · not red alone here while another ship was: #5 ·/);
  clean(l);
});

// The old rule said "failed alone here" of every burn-in suspect, though nothing had been run alone.
test("a burn-in red nobody fails alone here: the log never says it failed alone, and it goes back on the train's green without it", async () => {
  const l = await line(ships(5, { 3: guess('a', 3) }), env('test/a.test.ts=a3.ts', { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' }), tests('a'));
  const done = await l.go();
  back(done, 3);
  assert.match(done[2].stderr, /back in line to ship alone: ticket\/2-x's ship train was red in test\/a\.test\.ts, which ticket\/3-x changed or which imports what it changed\. It was pulled off the train on that guess: run alone on perigee it did not stay red/);
  assert.match(done[2].stderr, /land: a new or changed test failed its burn-in in CI \(https:\/\/ci\/\d+\): test\/a\.test\.ts: failed in 3 of 10 copies at once/, 'refused by its own burn-in, alone');
  for (const t of [retro(l), ...done.map((d) => d.stderr)]) assert.doesNotMatch(t, /failed alone( here)?:/);
  assert.match(retro(l), /ship train suspects · ticket\/2-x · #3 \(test\/a\.test\.ts\) · pulled on a guess, not red alone here: #3 ·/);
  clean(l);
});

test('two bad ships of two tests: both are pulled after the one red run, and the rest ship on the next', async () => {
  const l = await line(ships(7, { 3: guess('a', 3), 6: guess('b', 6) }), env(`${real('a', 'a3.ts')} ${real('b', 'b6.ts')}`), tests('a', 'b'));
  const done = await l.go();
  back(done, 3, 6);
  assert.equal(taken(done[1])[1], '4 5 7');
  guessed(done[2], 'test/a.test.ts');
  guessed(done[5], 'test/b.test.ts');
  assert.equal(runs(l, done), 5, "ship 1's, the red train's, the smaller train's, and #3's and #6's own");
  clean(l);
});
