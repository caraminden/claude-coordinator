// Part 4 of 4 of the land-train-suspects tests (#2208); the shared setup is in land-train-suspects-setup.ts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { line, shared, shipped } from './land-train-fixture.ts';
import { git, seen } from './land-fixture.ts';
import { guess, tests, ships, env, real, back, taken, retro, runs, clean, guessed, once, verdicts } from './land-train-suspects-setup.ts';

test('a ship that can only be built on a pulled one goes back in line, blamed for nothing', async () => {
  const l = await line(ships(6, { 3: guess('a', 3), 4: { on: 3 } }), env(real('a', 'a3.ts')), tests('a'));
  const done = await l.go();
  assert.match(done[1].stderr, /ticket\/4-x stays in line \(it sits on a ship this train holds off as a likely cause\)/);
  assert.equal(taken(done[1])[1], '5 6');
  for (const i of [5, 6]) shipped(l, done[i - 1], i, 2, 3);
  guessed(done[2], 'test/a.test.ts');
  assert.match(done[3].stderr, /back in line on its own/);
  clean(l);
});

for (const [what, file] of [
  ['names nobody in line', 'ticket/0-x\nkeep 0000000098 ticket/98-x\nheld 0000000099 ticket/99-x abc test/a.test.ts https://ci/1 likely eA==\n'],
  ['names another branch under a ticket in line', 'ticket/0-x\nkeep 0000000002 ticket/9-x\nheld 0000000003 ticket/3-x abc test/a.test.ts https://ci/1 likely eA==\n'],
  ['is cut off', 'ticket/0-x\nkeep 00000'],
  ['is empty', ''],
] as const) {
  test(`a stale hand-over file that ${what} never wedges the line`, async () => {
    const l = await line(ships(4, {}));
    writeFileSync(join(l.state, 'pull'), file);
    const done = await l.go();
    back(done);
    assert.equal(taken(done[1])[0], '3 4');
    clean(l);
  });
}

test('a ship pulled on a guess, not red alone, whose train passes without it, goes back in line and ships alone: nobody is refused on a guess', async () => {
  const l = await line(ships(6, { 3: guess('real', 3) }), once, tests('real'));
  const done = await l.go();
  back(done);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts; a guess: waits for the verdict\)/);
  assert.match(done[1].stderr, /#3 goes back in line to ship alone: it was pulled on a guess, and the train without it passed test\/real\.test\.ts, but no ship pulled for it failed it alone, so its own CI run decides/);
  guessed(done[2], 'test/real.test.ts', 'shipped');
  assert.equal(git(l.r.source, 'log', '-1', '--format=%s', 'main'), 'real3.ts: export const x = 3;', 'it shipped last, by itself');
  for (const d of done) assert.doesNotMatch(d.stderr, /is refused|tests failed in CI on/);
  assert.deepEqual(
    verdicts(l).map((x) => x.replace(/^.*?ship train verdict · /, '').replace(/https:\/\/ci\/\d+/, 'ci')),
    ['ticket/2-x · #3 back in line to ship alone on a guess: the train without it passed, and nothing proves it · test/real.test.ts · ci'],
  );
  clean(l);
});

test('a guess on a test that flaked on other ships: the pass without it proves nothing, the words say so, and it ships alone so no flaky red pulls it lap after lap', async () => {
  const l = await line(
    ships(8, { 3: guess('real', 3) }),
    (d) => ({ ...once(d), LAND_TRAIN_MAX: '3' }),
    (r) => {
      tests('real')(r);
      seen(join(r.dir, 'shared'), ['test/real.test.ts']);
    },
  );
  const done = await l.go();
  back(done);
  assert.match(done[1].stderr, /#3 goes back in line to ship alone: test\/real\.test\.ts flaked on other ships, so the train passing without it proves nothing, and its own CI run decides/);
  guessed(done[2], 'test/real.test.ts', 'shipped');
  assert.match(verdicts(l).join('\n'), /ship train verdict · ticket\/2-x · #3 back in line to ship alone on a guess: known flakes, so the pass without it proves nothing · test\/real\.test\.ts ·/);
  assert.doesNotMatch(retro(l), /refused on a guess/);
  clean(l);
});

// LB5 (the pipeline review): a ship pulled on a burn-in red, whose train without it is red in another file's burn-in. Its
// test never ran without it (a burn-in runs only the train's new and changed tests), yet it was refused on that guess.
test('LB5: a ship pulled on a burn-in guess is never refused by a burn-in red of another file without it; it ships alone, and its own run decides', async () => {
  const l = await line(ships(6, { 3: guess('a', 3), 5: guess('b', 5) }), env(`${real('a', 'a3.ts')} ${real('b', 'b5.ts')}`, { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', FAKE_REAL_FIRST: '1' }), tests('a', 'b'));
  const done = await l.go();
  back(done, 3, 5);
  assert.match(done[2].stderr, /back in line to ship alone: ticket\/2-x's ship train was red in test\/a\.test\.ts, which ticket\/3-x changed/);
  assert.match(done[2].stderr, /land: a new or changed test failed its burn-in in CI \(https:\/\/ci\/\d+\): test\/a\.test\.ts: failed in 3 of 10 copies at once/, 'its own burn-in, alone, is the proof');
  for (const d of done) assert.doesNotMatch(d.stderr, /on ticket\/2-x's ship train \(https:\/\/ci\/\d+\): test\/a\.test\.ts/);
  assert.doesNotMatch(retro(l), /refused on a guess/);
  clean(l);
});

// LB5's other half: the train without the held ship goes green only by the known-flake excuse (#1419).
test('LB5: a train that ships past known flakes without a held ship refuses nobody on the guess; the held ship ships alone, and its own run decides', async () => {
  const l = await line(
    ships(6, { 3: guess('real', 3) }),
    (d) => ({ FAKE_REAL: 'test/real.test.ts=real3.ts', FAKE_FLAKY_PATH: 'f2.txt', FAKE_FLAKY_LOGS: '2', FAKE_LOG: 'flakes', ...shared(d) }),
    (r) => {
      tests('real')(r);
      seen(join(r.dir, 'shared'), ['test/busy.test.ts', 'test/slow.test.ts']);
    },
  );
  const done = await l.go();
  back(done, 3);
  assert.match(done[1].stderr, /shipped past known flakes test\/busy\.test\.ts/);
  assert.match(done[1].stderr, /#3 goes back in line to ship alone/);
  guessed(done[2], 'test/real.test.ts');
  assert.doesNotMatch(retro(l), /refused on a guess/);
  clean(l);
});
