// Part 2 of 4 of the land-train tests (#2208); the shared setup is in land-train-setup.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ci } from './land-fixture.ts';
import { line, shipped, bad, realOf } from './land-train-fixture.ts';
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
