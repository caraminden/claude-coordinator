// Part 3 of 4 of the land-train tests (#2208); the shared setup is in land-train-setup.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci } from './land-fixture.ts';
import { type Ship, line, bad, realOf } from './land-train-fixture.ts';
import { until } from './wait.ts';
import {} from './land-train-setup.ts';

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
