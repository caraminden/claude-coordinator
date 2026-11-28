// Part 2 of 3 of the land-train-riders tests (#2208); the shared setup is in land-train-riders-setup.ts.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, quietProc } from './land-fixture.ts';
import { line, shipped } from './land-train-fixture.ts';
import { busy } from './land-train-riders-setup.ts';

// A bisect run lost before any test failed says nothing about the ship it tests: cut off (#1377: on Nov 20 a bisect
// refused #1302 for a run interrupted at 55 s with no failing test, #1372's report) or killed from outside, exit 137
// (#1393). Ship 1's run and the red train's are real; every run of the bisect's first look (the front alone) is lost:
// the one GitHub lists for it, the run pushed for it and its one fresh run.
for (const kind of ['interrupt', 'killed']) {
  test(`a bisect run lost twice before any test failed (${kind}) refuses nobody: the train goes back in line, and only a real red refuses`, async () => {
    const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }], { FAKE_RED_PATH: 'red.txt', FAKE_CUT: '2 3', FAKE_CUT_KIND: kind });
    const done = await l.go();
    assert.match(done[1].stderr, /finding the first ship that turned it red.*cut off before any test failed \(https:\/\/ci\/\d+\).*the ship train goes back in line, since CI gave no answer \(CI was cut off twice before any test failed \(https:\/\/ci\/\d+, https:\/\/ci\/\d+\)\)/s);
    assert.doesNotMatch(done[1].stderr, /tested green|found .* itself red|a test hung/, 'the lost bisect named nobody');
    for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    // Ship 4 is refused only later, by a run that really failed.
    assert.equal(done[3].status, 1, done[3].stderr);
    assert.doesNotMatch(done[3].stderr, /cut off/);
    assert.match(done[3].stderr, /land: tests failed on the rebased branch in CI/);
    l.done();
  });
}

// #1864 (DR1): a train whose runner went away, or whose step or log GitHub doesn't send, read as red, and the bisect refused its last ship.
for (const [name, extra, why] of [
  ['lost its runner twice', { FAKE_CUT: '1 3', FAKE_CUT_KIND: 'lost' }, /the ship train goes back in line, since CI gave no answer \(CI's one fresh run lost its runner before any step failed/],
  ['sends no log', { FAKE_FLAKY_PATH: 'f4.txt', FAKE_LOG: 'down' }, /the ship train goes back in line, since CI gave no answer \(GitHub didn't send the red CI run's log/],
  ['names no step', { FAKE_FLAKY_PATH: 'f4.txt', FAKE_STEP: 'down' }, /the ship train goes back in line, since CI gave no answer \(GitHub didn't say which step of the red CI run failed/],
] as [string, Record<string, string>, RegExp][])
  test(`a train whose red run ${name} refuses nobody`, async () => {
    const l = await line([{}, {}, {}, {}], extra);
    const done = await l.go();
    assert.match(done[1].stderr, why);
    assert.doesNotMatch(done[1].stderr, /the bisect found/);
    for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });

// A rider whose tests take the runner down, on a busy perigee: the front is refused for it neither with it nor alone.
test('a train whose every run is lost while perigee is busy drops its riders, and only the ship that does it alone is refused (#1864)', async () => {
  const l = await line([{}, {}, { change: ['red.txt', 'red\n'] }], (dir) => {
    const proc = quietProc(join(dir, 'proc'), { load: 999 });
    return { FAKE_RED_PATH: 'red.txt', FAKE_STEP: 'lost', LAND_NO_VERDICT_MAX: '2', LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
  });
  const done = await l.go();
  assert.match(done[1].stderr, /the ship train goes back in line, since CI gave no answer \(CI's one fresh run lost its runner before any step failed/);
  assert.doesNotMatch(done[1].stderr, /refused by the pipeline/);
  for (const i of [1, 2]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /CI and perigee both busy, try again: CI: .*\(its runs were lost or cut off 2 times\); perigee/);
  l.done();
});

// #1864 (LB4): a train red twice of flakes only (no real failure to pin) went to the bisect; the front
// keeps its place instead. (Past its keeps, the bisect refuses nobody but a ship tested by itself: #1899.)
test('a train red twice of flakes only keeps its place, and every ship on it ships', async () => {
  const l = await line([{}, {}, {}, {}], { FAKE_FLAKY_PATH: 'f4.txt', FAKE_FLAKY_LOGS: '2', FAKE_LOG: 'flakes' });
  const done = await l.go();
  assert.match(done[1].stderr, /refused on flakes only \(test\/busy\.test\.ts, test\/slow\.test\.ts, then test\/busy\.test\.ts, test\/slow\.test\.ts on the fresh run\), not your change: keeping its place in line/);
  assert.doesNotMatch(done[1].stderr, /the bisect/);
  for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// #1393: a rerun alone killed from outside gives that file no label, but the confirmed failure still names its suspect.
test("a file whose rerun alone was killed from outside names no suspect: only the confirmed failure's ship is refused", async () => {
  const l = await line([{}, {}, { change: ['test/busy.test.ts', 'x\n'] }, { change: ['test/real.test.ts', '// red\n'] }], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'killed-rerun' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /in test\/real\.test\.ts, which ticket\/4-x changed.*pulled off the train on that guess/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test('a train whose front is red: the front is refused as alone, and the ships behind it ship as the next train', async () => {
  const l = await line([{}, { change: ['red.txt', 'red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.equal(done[1].status, 1);
  assert.match(done[1].stderr, /the bisect found ticket\/2-x itself red, so the ships behind it go back in line/);
  assert.match(done[1].stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\)/);
  for (const i of [3, 4, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[3], 4, 3, 3);
  shipped(l, done[4], 5, 3, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5']);
  l.done();
});
