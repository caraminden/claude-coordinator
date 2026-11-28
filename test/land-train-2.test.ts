// Part 2 of 4 of the land-train tests (#2208); the shared setup is in land-train-setup.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ci } from './land-fixture.ts';
import { type Ship, line, shipped, bad, realOf } from './land-train-fixture.ts';
import { racyCase, burnCase } from './land-train-setup.ts';

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

// The ship that adds the failing case is refused at that step, whether it is the bisect's front or a rider.
for (const [who, n] of [
  ['the front', 2],
  ['a rider', 3],
] as const) {
  test(`a bisect step red in its burn-in on a case ${who} adds refuses it, though it passes alone, with no further step (#2019)`, async () => {
    const ships: Ship[] = [{}, {}, {}, {}, {}, {}];
    ships[n - 1] = { change: [`test/p${n}.test.ts`, racyCase] };
    const l = await line(ships, { FAKE_REAL: realOf(n), FAKE_LOG_WHOLE: 'f6.txt', ...burnCase });
    const done = await l.go();
    assert.equal(done[n - 1].status, 1, done[n - 1].stderr);
    assert.match(done[n - 1].stderr, new RegExp(`ticket/${n}-x adds the test case that failed`));
    assert.deepEqual(
      [...done[1].stderr.matchAll(/^land: bisect: testing the first (\d+) of (\d+) ships$/gm)].map((m) => `${m[1]}/${m[2]}`),
      ['2/5'],
    );
    for (const i of [2, 3, 4, 5, 6].filter((i) => i !== n)) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });
}

// Three bad ships in one red train are all refused after that one red run, with no bisect: by the burn-in of the tests
// they change, or by the tests that each fail alone here with them.
for (const [what, env, why] of [
  [
    'in its burn-in on three racy tests',
    { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' },
    (i: number, red: string) => `a new or changed test failed its burn-in in CI on ticket/2-x's ship train \\(${red}\\): test/p${i}\\.test\\.ts, and run alone on perigee it passed on main and failed with ticket/${i}-x`,
  ],
  ['on three tests that each fail alone here', {}, (i: number, red: string) => `tests failed in CI on ticket/2-x's ship train \\(${red}\\) in test/p${i}\\.test\\.ts, and run alone on perigee it passed on main and failed with ticket/${i}-x by itself on main, so it is the cause`],
] as const) {
  test(`a train red ${what} refuses the three ships that turn them red after that one red run, with no bisect, and the rest ship (#1564)`, async () => {
    const l = await line([{}, {}, bad(3), bad(4), {}, bad(6), {}], { FAKE_REAL: realOf(3, 4, 6), ...env });
    const done = await l.go();
    const red = done[2].stderr.match(/ship train \((https:\/\/ci\/\d+)\)/)?.[1] ?? 'no red run';
    if (!('FAKE_LOG' in env)) assert.match(done[1].stderr, /suspects: running test\/p3\.test\.ts test\/p4\.test\.ts test\/p6\.test\.ts alone on the train's commits here, 3 at a time/);
    for (const i of [3, 4, 6]) {
      assert.equal(done[i - 1].status, 1, done[i - 1].stderr);
      assert.match(done[i - 1].stderr, new RegExp(why(i, red)), 'refused on the same red run');
    }
    assert.doesNotMatch(done[1].stderr, /bisect/);
    for (const i of [1, 2, 5, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    for (const i of [5, 7]) shipped(l, done[i - 1], i, 2, 3);
    assert.equal(l.runs(), 3, "ship 1's, the red train's and the smaller train's");
    l.done();
  });
}
