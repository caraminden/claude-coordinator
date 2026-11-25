// A red ship train keeps splitting (#1899, train_bisect in tools/land.sh; Josh, 2026-11-24: "keep splitting and any green
// section gets shipped, until the bad change is found and then pulled out to be fixed and full train starts over"): each
// green section ships at once, only the bad ship goes back, and the rest form a full train again.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, land, setup } from './land-fixture.ts';
import { line, shared, shipped } from './land-train-fixture.ts';

type Line = Awaited<ReturnType<typeof line>>;
type Done = { status: number | null; stderr: string }[];
// A change no test maps to, so no guess cuts the train: the halves decide.
const redTxt = (n = '') => ({ change: [`red${n}.txt`, 'red\n'] as [string, string] });
const ships = (n: number, bad: Record<number, object>) => Array.from({ length: n }, (_, i) => bad[i + 1] ?? {});
const cuts = (done: Done) => done.flatMap((d) => [...d.stderr.matchAll(/^land: bisect: testing the first (\d+) of (\d+) ships$/gm)].map((m) => `${m[1]}/${m[2]}`));
// Every ship but these shipped, these went back for their own red, and main holds only the others, each whole.
function onlyBack(l: Line, done: Done, ...back: number[]) {
  done.forEach((d, i) => {
    const n = i + 1;
    if (!back.includes(n)) return assert.equal(d.status, 0, `ship ${n}: ${d.stderr}`);
    assert.equal(d.status, 1, `ship ${n}: ${d.stderr}`);
    assert.match(d.stderr, /land: tests failed on the rebased branch in CI/, `ship ${n}: refused for its own red`);
    assert.match(d.stderr, /not ok 1 - the red test's output/, `ship ${n}: with its failures`);
  });
  assert.deepEqual(
    l.subjects().sort(),
    [
      'base',
      ...done
        .map((_, i) => i + 1)
        .filter((n) => !back.includes(n))
        .map((n) => `f${n}.txt: ${n}`),
    ].sort(),
  );
  assert.equal(existsSync(join(l.state, 'split')), false, 'the split is over');
  l.done();
}

test('a green train ships whole on one run, with no split', async () => {
  const l = await line(ships(7, {}), { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  onlyBack(l, done);
  shipped(l, done[6], 7, 2, 6);
  assert.deepEqual(cuts(done), []);
  assert.equal(l.runs(), 2, "ship 1's and the train's");
});

// Ships 2 to 7 are a train of six; ships 8 and 9 wait behind it. <runs>: CI's, with ship 1's own, the red train's, the split's
// and the full train's that starts over (two of them after ship 2: seven ships are left).
for (const [where, bad, tested, runs, deploys, alone] of [
  ['first', 2, ['3/6', '1/6'], 6, 3, []],
  ['in the middle', 4, ['3/6', '1/6'], 7, 4, [3, 4]],
  ['last', 7, ['3/6'], 7, 5, [5, 6, 7]],
] as const) {
  test(`one bad ship ${where} of six: each green section ships at once, only it goes back, and the rest form a full train again`, async () => {
    const l = await line(ships(9, { [bad]: redTxt() }), (d) => ({ FAKE_RED_PATH: 'red.txt', LAND_TRAIN_MAX: '5', ...shared(d) }));
    const done = await l.go();
    onlyBack(l, done, bad);
    assert.deepEqual(cuts(done), tested);
    const retro = readdirSync(join(l.r.dir, 'shared/retro-log'))
      .map((d) => readFileSync(join(l.r.dir, 'shared/retro-log', d, 'land.md'), 'utf8'))
      .join('');
    // The retro log's verdict (src/land-reds.ts) names the train's leader and the ship found, once.
    assert.deepEqual(
      [...retro.matchAll(/ship train red · (\S+) · (\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
      [`ticket/2-x ticket/${bad}-x`],
    );
    for (const n of alone) assert.match(done[n - 1].stderr, new RegExp(`ship train: ticket/${n}-x is one of the \\d ships ticket/2-x's red train is down to, so this tests it alone`));
    assert.equal(l.runs(), runs);
    assert.equal(l.deployed().length, deploys, 'each section goes live by itself');
    // Ship 9 waited behind the first train: it rides the full one that starts over, or the one after it.
    const after = bad === 2 ? 3 : bad + 1;
    assert.match(done[after - 1].stderr, /takes the \d ships? waiting behind it/);
    if (bad !== 2) shipped(l, done[8], 9, after, 9 - bad);
  });
}

test('two bad ships: the first is found and goes back, the rest form a full train again, and that one splits down to the second', async () => {
  const l = await line(ships(9, { 3: redTxt(), 6: redTxt('6') }), { FAKE_REAL: 'test/real.test.ts=red.txt test/real.test.ts=red6.txt', LAND_TRAIN_MAX: '5' });
  const done = await l.go();
  onlyBack(l, done, 3, 6);
  assert.match(done[3].stderr, /ship train: ticket\/4-x takes the 5 ships waiting behind it/, 'a full train after the first is out');
});

test('a failure only in combination: the first of the two ships, and the second is red on main by itself and goes back', async () => {
  const l = await line(ships(7, { 3: redTxt('3'), 6: redTxt('6') }), { FAKE_RED_BOTH: 'red3.txt red6.txt', LAND_TRAIN_MAX: '5' });
  const done = await l.go();
  for (const n of [1, 2, 3, 4, 5, 7]) assert.equal(done[n - 1].status, 0, `ship ${n}: ${done[n - 1].stderr}`);
  assert.equal(done[5].status, 1, done[5].stderr);
  assert.match(done[5].stderr, /land: tests failed on the rebased branch in CI/);
  l.done();
});

test('a flake that reddens one run: every section passes when tested, so nobody goes back and all of them ship', async () => {
  const l = await line(ships(7, {}), { FAKE_FLAKY_PATH: 'f4.txt', LAND_TRAIN_MAX: '5' });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.deepEqual(cuts(done), ['3/6']);
  assert.equal(git(l.r.source, 'ls-tree', '--name-only', 'main').match(/^f\d/gm)?.length, 7);
  l.done();
});

// test/real.test.ts imports a.ts and b.ts and passes alone here: ship 6 adds b.ts and ship 7 changes a.ts, so the files name two ships.
const guessed = (red: string) =>
  [
    ships(7, { [red === 'red.txt' ? 3 : 0]: redTxt(), 6: { also: ['b.ts', 'export const b = 1;\n'] }, 7: { also: ['a.ts', 'export const a = 2;\n'] } }),
    { FAKE_RED_PATH: red, LAND_TRAIN_MAX: '5' },
    (r: ReturnType<typeof setup>) => {
      writeFileSync(join(r.source, 'a.ts'), 'export const a = 1;\n');
      r.commit(r.source, 'test/real.test.ts', "import { existsSync } from 'node:fs';\nimport '../a.ts';\nif (existsSync('b.ts')) await import('../b.ts');\n");
    },
  ] as const;

test('a guess from the files cuts just before its first ship: the ones ahead ship on one run, fewer runs than the middle takes', async () => {
  const l = await line(...guessed('b.ts'));
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: the files name more than one ship \(#6, #7\)/);
  assert.deepEqual(cuts(done), ['4/6'], 'the middle would be the first 3');
  for (const n of [3, 4, 5]) shipped(l, done[n - 1], n, 2, 4);
  assert.equal(done[5].status, 1, done[5].stderr);
  for (const n of [1, 2, 3, 4, 5, 7]) assert.equal(done[n - 1].status, 0, `ship ${n}: ${done[n - 1].stderr}`);
  assert.equal(l.runs(), 5, "ship 1's, the red train's, the four ahead, ship 6's own red, and ship 7's: the middle takes one more");
  l.done();
});

test('a wrong guess only costs its cut: the ships it named ship, and the bad one ahead of them is found and goes back', async () => {
  const l = await line(...guessed('red.txt'));
  const done = await l.go();
  assert.deepEqual(cuts(done).slice(0, 2), ['4/6', '2/6']);
  assert.equal(done[2].status, 1, done[2].stderr);
  for (const n of [1, 2, 4, 5, 6, 7]) assert.equal(done[n - 1].status, 0, `ship ${n}: ${done[n - 1].stderr}`);
  l.done();
});

// split_cut alone, over the trains the runs above don't reach.
test('where a red train is cut: before the first guess, the front by itself when it is the guess, else the middle', () => {
  const body = /^split_cut\(\) \{\n[\s\S]*?\n\}/m.exec(readFileSync(land, 'utf8'))?.[0] ?? assert.fail('no split_cut in land.sh');
  const cut = (...a: number[]) => Number(execFileSync('bash', ['-euc', `${body}\nsplit_cut "$@"`, '-', ...a.map(String)], { encoding: 'utf8' }));
  assert.deepEqual(
    [2, 3, 4, 5, 6, 7].map((n) => cut(n)),
    [0, 0, 1, 1, 2, 2],
    'no guess: the middle',
  );
  assert.equal(cut(6, 5), 4);
  assert.equal(cut(6, 5, 4), 3, 'in any order');
  assert.equal(cut(6, 0, 4), 0, 'the front itself is a guess');
  assert.equal(cut(6, 1, 2, 3, 4), 2, 'a guess naming over half of them says nothing');
  assert.equal(cut(3, 4, 5), 0, 'only guesses past the part left: the middle');
});

test("a ship sent back runs its failed test files in its next hand-off's smoke check, before it boards", () => {
  const r = setup();
  const c = ci(r);
  writeFileSync(join(r.source, 'tools', 'citadel-test'), '#!/usr/bin/env bash\necho "$*" >>"$SMOKE_ARGS"\nexit "${SMOKE_EXIT:-0}"\n');
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  writeFileSync(join(r.source, 'tools', 'always-tests.txt'), '');
  r.commit(r.source, 'test/real.test.ts', '');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const args = join(r.dir, 'smoke-args');
  const ran = () => (existsSync(args) ? readFileSync(args, 'utf8') : '');
  let res = c.run({ SMOKE_ARGS: args, FAKE_CI: 'red' });
  assert.match(res.stderr, /land: tests failed on the rebased branch in CI/);
  assert.doesNotMatch(ran(), /real/);
  res = c.run({ SMOKE_ARGS: args, SMOKE_EXIT: '1', FAKE_CI: 'green' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /smoke: test\/real\.test\.ts failed ticket\/1-x's last ship, so it runs here first/);
  assert.match(res.stderr, /land: smoke: tests failed \(exit 1\), before the line/);
  assert.match(ran(), /test\/real\.test\.ts/);
  res = c.run({ SMOKE_ARGS: args, FAKE_CI: 'green' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /smoke: test\/real\.test\.ts failed ticket\/1-x's last ship/, 'until it passes');
  assert.deepEqual(readdirSync(join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'pulled')), [], 'then forgotten');
});
