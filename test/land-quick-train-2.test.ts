// The gap train (#2243, tools/land/quick.sh), part 2 of 2: a red quick check, the full run kept, an empty line, and
// at most one quick train between full ones. The shared setup is in land-quick-train-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, landAsync } from './land-fixture.ts';
import { line } from './land-train-fixture.ts';
import { retro } from './land-train-early-setup.ts';
import { mixed, on, quick, quickCalls } from './land-quick-train-setup.ts';

const low = { LAND_RISK: 'low' };

test('gap train: a red quick check sends the ship that changed the failing file back to the full train, and the rest ship on a second check', async () => {
  const l = await line(mixed, (d) => ({ ...quick(d), FAKE_QUICK_OUT_1: 'light check: red: f6.txt' }), on);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[4].stderr, /land: quick train: ticket\/6-x changed f6.txt, red in its quick check, so it leaves for the full train/);
  assert.match(done[4].stderr, /land: quick train: checked again without them, green on/);
  assert.match(done[4].stderr, /land: no CI run: a quick train, green on its quick check/);
  assert.doesNotMatch(done[5].stderr, /it was a quick train/);
  // 5 alone on the quick train; 6 back in line, behind 4, on the full trains.
  assert.deepEqual(l.subjects().slice(0, 5), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5']);
  assert.deepEqual(l.subjects().slice(5).sort(), ['f4.txt: 4', 'f6.txt: 6', 's7.txt: 7']);
  const calls = quickCalls(l.r.dir);
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[0], /^head f6.txt: 6 /);
  assert.match(calls[1], /^head f5.txt: 5 /);
  assert.ok(retro(l.r.dir, 'quick train · ticket/5-x · red: f6.txt · pinned: ').length === 1, retro(l.r.dir, 'quick train').join('\n'));
  l.done();
});

test('gap train: a red quick check in a file the front changed sends the whole quick train to CI as a full train', async () => {
  const l = await line(mixed, (d) => ({ ...quick(d), FAKE_QUICK_OUT: 'light check: red: f5.txt' }), on);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[4].stderr, /land: quick train: its quick check was red in f5.txt, which ticket\/5-x changed, so it goes on as a full train's front/);
  assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /no CI run: a quick train/);
  const at = [...done[4].stderr.matchAll(/main is now at ([0-9a-f]{7,40}) /g)].pop()?.[1];
  assert.ok(at, done[4].stderr);
  assert.match(l.c.calls(), new RegExp(`head_sha=${at}`), "5's train ran on CI");
  assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /unbound variable|command not found/);
  // 5's full train took 4 and planned 6 as a gap train of its own: 6's check is the second call, red too here.
  const calls = quickCalls(l.r.dir);
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[0], /^head f6.txt: 6 /);
  assert.match(done[4].stderr, /land: quick train: ticket\/6-x goes right after this train/);
  assert.ok(!existsSync(join(l.state, 'quick-untested')));
  l.done();
});

test('gap train: a full run already stacked for a qualifying ship is kept, never thrown away for a quick train', async () => {
  // Ship 2 plans no gap train (LAND_QUICK=0 for it), so it stacks the next full train, 4, early on its top.
  const l = await line([{}, { env: { ...low, LAND_QUICK: '0' } }, { env: low }, { env: low }], quick, on);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: early next train: ticket\/4-x is stacked on this train's top/);
  assert.equal(retro(l.r.dir, 'early train · ticket/4-x · counted').length, 1, retro(l.r.dir, 'early train').join('\n'));
  assert.deepEqual(quickCalls(l.r.dir), []);
  assert.doesNotMatch(done[3].stderr, /quick train/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  l.done();
});

test('gap train: with nothing in line that needs the full suite it ships at once, and the ship after it goes on CI as a full one', async () => {
  const l = await line([{}, { env: low }, { env: low }], quick, on);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: quick train: nothing in line needs the full suite, so ticket\/2-x ships at once/);
  assert.match(done[1].stderr, /land: no CI run: a quick train, green on its quick check/);
  assert.match(done[2].stderr, /shipped in ticket\/2-x's ship train of 2 ships/);
  assert.equal(quickCalls(l.r.dir).length, 1);
  assert.doesNotMatch(l.c.calls(), new RegExp(`head_sha=${git(l.r.source, 'rev-parse', 'ticket/3-x')}`), 'CI was never asked about the quick top');
  const top = git(l.r.source, 'rev-parse', 'main');
  assert.equal(readFileSync(join(l.state, 'quick-untested'), 'utf8').trim(), top);
  // The next qualifying ship, alone in line: a quick top is on main with no full run over it, so this one goes full.
  const wt = join(l.r.dir, 'wt4');
  git(l.r.source, 'worktree', 'add', '-q', '-b', 'ticket/4-x', wt, 'main');
  l.r.commit(wt, 'f4.txt', '4\n');
  const four = await landAsync(wt, { ...l.env, ...low }, 150_000);
  assert.equal(four.status, 0, four.stderr);
  assert.doesNotMatch(four.stderr, /quick train/);
  assert.match(l.c.calls(), new RegExp(`head_sha=${git(l.r.source, 'rev-parse', 'main')}`), '4 ran on CI');
  assert.equal(quickCalls(l.r.dir).length, 1);
  assert.ok(!existsSync(join(l.state, 'quick-untested')), "the full ship's CI run cleared the quick top's mark");
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  l.done();
});
