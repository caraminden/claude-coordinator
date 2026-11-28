// The gap train (#2243, tools/land/quick.sh; Josh, 2026-11-24, on #1910's card: "Plan approved: build it this way.").
// Part 1 of 2; the shared setup is in land-quick-train-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from './land-fixture.ts';
import { line } from './land-train-fixture.ts';
import { retro } from './land-train-early-setup.ts';
import { mixed, on, quick, quickCalls } from './land-quick-train-setup.ts';

test('gap train: the qualifying ships waiting behind a full train ship right after it on one quick check and one deploy, and the next full train rides on its top with its early run kept', async () => {
  const l = await line(mixed, quick, on);
  const top2 = () => git(l.r.source, 'rev-parse', 'ticket/3-x');
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /unbound variable|command not found/);
  // In line order: the full train 2+3, the quick train 5+6, then 4's full train with 7 (sensitive: never quick).
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6', 'f4.txt: 4', 's7.txt: 7']);
  assert.equal(l.deployed().length, 4, 'one deploy each: ship 1, the full train, the quick train, the next full train');
  assert.match(done[1].stderr, /land: quick train: ticket\/5-x \(with ticket\/6-x\) goes right after this train, on a quick check/);
  assert.match(done[4].stderr, /land: no CI run: a quick train, green on its quick check/);
  assert.match(done[5].stderr, /shipped in ticket\/5-x's ship train of 2 ships/);
  assert.match(done[5].stderr, /it was a quick train: no CI run/);
  // The check ran once, on the quick train's top, against the full train's top.
  const calls = quickCalls(l.r.dir);
  assert.equal(calls.length, 1, calls.join('\n'));
  assert.match(calls[0], new RegExp(`^head f6.txt: 6 [0-9a-f]{40} args bash tools/light-check-run.sh ${top2()}$`));
  // No CI run for the quick train; 4's train was stacked early on its top, and that run counted.
  assert.doesNotMatch(l.c.calls(), new RegExp(`head_sha=${git(l.r.source, 'rev-parse', 'ticket/6-x')}`), 'CI was never asked about the quick top');
  assert.match(l.c.calls(), new RegExp(`head_sha=${git(l.r.source, 'rev-parse', 'ticket/3-x')}`), 'CI ran on the full train');
  assert.match(done[4].stderr, /land: early next train: ticket\/4-x \(with ticket\/7-x riding\) is stacked on this train's top/);
  assert.doesNotMatch(done[1].stderr, /early next train: ticket\/4-x/, "the full train didn't stack 4 on a top the quick train would leave behind");
  assert.deepEqual(retro(l.r.dir, 'early train · ticket/4-x · counted'), [retro(l.r.dir, 'early train · ticket/4-x · counted')[0]]);
  assert.deepEqual(l.cancelled(), [], 'no CI run was thrown away');
  assert.deepEqual(
    retro(l.r.dir, 'quick train ').filter((x) => !/would qualify|not: /.test(x)),
    ["quick train · ticket/5-x · planned onto ticket/2-x's train sha · riders: ticket/6-x", 'quick train · ticket/5-x · green · riders: sha', 'quick train shipped · ticket/5-x · 2 ships, no CI run · sha'],
  );
  assert.ok(!existsSync(join(l.state, 'quick-untested')), "the full train after it cleared the quick top's mark");
  assert.ok(!existsSync(join(l.state, 'quick-behind')), "the full train's green run over the quick top counted for its run behind (#2244)");
  assert.ok(!existsSync(join(l.state, 'quick-train')) && !existsSync(join(l.state, 'quick-stacked')));
  l.done();
});

test('gap train: off by default, the same line ships as it did before it existed', async () => {
  const l = await line(mixed, quick);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  // Today's line: each full train takes the next waiter (LAND_TRAIN_MAX=1), in line order, each with its CI run.
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5', 'f6.txt: 6', 's7.txt: 7']);
  assert.equal(l.deployed().length, 4);
  assert.deepEqual(quickCalls(l.r.dir), []);
  // Each full train's top had its CI run (2+3, 4+5, 6+7), and the early next trains went as they do today.
  for (const t of ['ticket/3-x', 'ticket/5-x', 'ticket/7-x']) assert.match(l.c.calls(), new RegExp(`head_sha=${git(l.r.source, 'rev-parse', t)}`), t);
  assert.deepEqual(
    retro(l.r.dir, 'early train').map((x) => x.replace(/ · \d+s head start$/, '')),
    ["early train · ticket/4-x + 1 riders onto ticket/2-x's train sha · pushed sha", 'early train · ticket/4-x · counted', "early train · ticket/6-x + 1 riders onto ticket/4-x's train sha · pushed sha", 'early train · ticket/6-x · counted'],
  );
  const said = done.map((d) => d.stderr).join('\n');
  assert.doesNotMatch(said, /quick train|quick check/);
  // Only the judged lines #1912 logs today.
  assert.deepEqual(
    retro(l.r.dir, 'quick train').filter((x) => !/^quick train · ticket\/\d-x · (would qualify|not: .*)$/.test(x)),
    [],
  );
  // Nor any full run owed behind a quick train (#2244): src/fast-mode.ts has nothing to run.
  for (const f of ['quick', 'quick-train', 'quick-stacked', 'quick-untested', 'quick-verdict', 'quick-behind']) assert.ok(!existsSync(join(l.state, f)), f);
  l.done();
});

test('gap train: with no side runner registered nothing is planned, and the line ships as with it off', async () => {
  const l = await line(mixed, (d) => ({ ...quick(d), FAKE_SIDE_RUNNERS: '0' }), on);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5', 'f6.txt: 6', 's7.txt: 7']);
  assert.match(done[1].stderr, /land: quick train: CI's side runner isn't registered, so ticket\/5-x waits for the full train/);
  assert.deepEqual(quickCalls(l.r.dir), []);
  l.done();
});

test('gap train: a ship a person placed keeps its spot, so no quick train goes ahead of it', async () => {
  const l = await line(mixed, quick, on);
  writeFileSync(join(l.state, 'queue', '.order'), '# Cara\n0000000002\n0000000003\n0000000004\n0000000005\n0000000006\n0000000007\n#pin 4\n');
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: quick train: a ship a person placed waits in line, so it keeps its spot/);
  assert.deepEqual(l.subjects().slice(0, 5), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  l.done();
});
