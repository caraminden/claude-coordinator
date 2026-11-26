// A red train pulls every likely ship at once, tests only what is left and ships the first green (#1918, train_suspects in
// tools/land.sh; Josh, 2026-11-24: "we bisect out the likely failures and run 1, 2, 4, 6, 7 if they are green they get
// shipped and we send 5 and 3 back to debug their failures. If they are still red and we guess 1 is the issue based on the
// failure, then we take it out and run 2, 4, 6, 7 then we finally get a green and ship those 4"). Ship 1 ships by itself
// and holds the line while the train forms, so ship 2 fronts it.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bad, line, realOf, shared, shipped } from './land-train-fixture.ts';
import { git, seen, type setup } from './land-fixture.ts';

type Line = Awaited<ReturnType<typeof line>>;
type Done = { status: number | null; stderr: string }[];
const IMPORT = 'import'; // spelled out, test/pipeline-files.test.ts would follow the fixture's imports as this file's own

// A change perigee can't fail alone: main's test/<name>.test.ts imports <name><n>.ts once it exists, ship n adds it, and
// CI's red is the fake's. So the files name ship n, and its run alone here passes.
const guess = (name: string, n: number): { change: [string, string] } => ({ change: [`${name}${n}.ts`, `export const x = ${n};\n`] });
const tests =
  (...names: string[]) =>
  (r: ReturnType<typeof setup>) =>
    names.forEach((name) => r.commit(r.source, `test/${name}.test.ts`, `import { existsSync } from 'node:fs';\n${[2, 3, 4, 5, 6, 7, 8].map((n) => `if (existsSync(new URL('../${name}${n}.ts', import.meta.url))) await ${IMPORT}('../${name}${n}.ts');`).join('\n')}\n`));
const ships = (n: number, some: Record<number, object>) => Array.from({ length: n }, (_, i) => some[i + 1] ?? {});
const env =
  (real: string, more: Record<string, string> = {}) =>
  (d: string) => ({ FAKE_REAL: real, ...shared(d), ...more });
const real = (name: string, ...paths: string[]) => paths.map((p) => `test/${name}.test.ts=${p}`).join(' ');
const back = (done: Done, ...ns: number[]) => done.forEach((d, i) => assert.equal(d.status, ns.includes(i + 1) ? 1 : 0, `ship ${i + 1}: ${d.stderr}`));
const taken = (d: Done[number]) => [...d.stderr.matchAll(/waiting behind it \(([^)]*)\)/g)].map((m) => m[1].replace(/ticket\/|-x/g, ''));
const retro = (l: Line) => {
  const dir = join(l.r.dir, 'shared/retro-log');
  return readdirSync(dir)
    .map((d) => readFileSync(join(dir, d, 'land.md'), 'utf8'))
    .join('');
};
// CI's runs, but for the early ones of a next train (#1568) that a red train dropped.
const runs = (l: Line, done: Done) => l.runs() - done.flatMap((d) => d.stderr.match(/^land: early next train: dropped the early CI run /gm) ?? []).length;
// The line is as it was found: no verdict, ticket, split or hand-over left.
function clean(l: Line) {
  l.done();
  for (const f of ['split', 'pull']) assert.equal(existsSync(join(l.state, f)), false, `no ${f} file is left`);
}
// A ship pulled on a guess is never refused for it (#2098): back in line, it ships alone, and the fake's CI, red on its
// change, refuses it with that run of its own.
const guessed = (d: Done[number], files: string, then: 'refused' | 'shipped' = 'refused') => {
  assert.match(
    d.stderr,
    new RegExp(
      `back in line to ship alone: ticket/\\d+-x's ship train was red in ${files.replaceAll('.', '\\.')}, which ticket/\\d+-x changed or which imports what it changed\\. It was pulled off the train on that guess: run alone on perigee it did not stay red with ticket/\\d+-x by itself on main\\. The train without it passed, but no ship pulled for it failed it by itself on main, so that proves nothing, and its own CI run decides`,
    ),
  );
  if (then === 'refused') assert.match(d.stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\)/, 'refused by its own run alone');
  else assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stderr.slice(d.stderr.indexOf('back in line to ship alone')), /ship train: \S+ takes/, 'it took no riders after');
};
const proven = (d: Done[number], file: string) => assert.match(d.stderr, new RegExp(`in ${file.replaceAll('.', '\\.')}, and run alone on perigee it passed on main and failed with .*, so it is the cause`));

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

test('two ships that fail only together: both are pulled, neither fails alone, both go back in line, and the first ships alone while the second is refused by its own run on top of it', async () => {
  const l = await line(ships(6, { 3: guess('real', 3), 5: guess('real', 5) }), (d) => ({ FAKE_RED_BOTH: 'real3.ts real5.ts', ...shared(d) }), tests('real'));
  const done = await l.go();
  back(done, 5);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts; a guess: waits for the verdict\), #5 \(test\/real\.test\.ts; a guess: waits for the verdict\)/);
  guessed(done[2], 'test/real.test.ts', 'shipped');
  guessed(done[4], 'test/real.test.ts');
  assert.equal(runs(l, done), 5, "ship 1's, the red train's, the smaller train's, and #3's and #5's own");
  clean(l);
});

test('no guess: the back half is pulled and the front half is tested, with nobody from the line in the empty seats', async () => {
  const l = await line(ships(8, { 6: { change: ['red.txt', 'red\n'] } }), env(real('a', 'red.txt'), { LAND_TRAIN_MAX: '5' }), tests('a'));
  const done = await l.go();
  back(done, 6);
  assert.match(done[1].stderr, /bisect: testing the first 3 of 6 ships/);
  assert.deepEqual(taken(done[1]), ['3 4 5 6 7']);
  for (const i of [3, 4]) shipped(l, done[i - 1], i, 2, 3);
  clean(l);
});

test('every ship on the train named and none red alone: nothing would be left to test, so the train is cut in half', async () => {
  const l = await line(ships(4, { 2: guess('a', 2), 3: guess('a', 3), 4: guess('a', 4) }), env(real('a', 'a3.ts')), tests('a'));
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: the files name every ship there is to pull for test\/a\.test\.ts and none of them failed alone, so the bisect looks for the ship/);
  back(done, 3);
  clean(l);
});

test('a front and a rider that both changed the red test, the rider red alone: it goes back, and the front ships on the next train (#1918)', async () => {
  const l = await line(ships(5, { 2: { change: ['h2.ts', 'export {};\n'] }, 4: { change: ['h4.ts', "throw new Error('racy');\n"] } }), env('test/h.test.ts=h4.ts', { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' }), tests('h'));
  const done = await l.go();
  back(done, 4);
  assert.match(done[1].stderr, /suspects: #2 \(test\/h\.test\.ts; passed alone: waits for the next train\), #4 \(test\/h\.test\.ts; failed alone: sent back\)/);
  clean(l);
});

test('a front that steps aside takes no ship built on a pulled one into the next front: those go back in line', async () => {
  const l = await line(ships(7, { 2: guess('a', 2), 3: guess('a', 3), 4: { on: 3 }, 5: { on: 2 } }), env(real('a', 'a2.ts', 'a3.ts')), tests('a'));
  const done = await l.go();
  for (const i of [4, 5]) assert.match(done[1].stderr, new RegExp(`ticket/${i}-x goes back in line: it sits on a ship this train pulled`));
  for (const i of [2, 3]) guessed(done[i - 1], 'test/a.test.ts');
  shipped(l, done[6], 7, 6, 2);
  assert.equal(taken(done[5])[0], '7');
  clean(l);
});

// Ship 5's test fails here only with ship 3 under it, so its runs on the train's prefixes name ship 5, and that is no proof.
test('a test that fails here only with two ships together is proof against neither: the one its runs on the train name is pulled on a guess, and the words say which run failed', async () => {
  const pair = "import { existsSync } from 'node:fs';\nif (existsSync('x3.txt') && existsSync('x5.txt')) throw new Error('only together');\n";
  const l = await line(
    ships(6, { 3: { change: ['x3.txt', '3\n'] }, 5: { change: ['x5.txt', '5\n'] } }),
    (d) => ({ FAKE_RED_BOTH: 'x3.txt x5.txt', ...shared(d) }),
    (r) => r.commit(r.source, 'test/real.test.ts', pair),
  );
  const done = await l.go();
  back(done, 5);
  assert.match(done[1].stderr, /suspects: #5 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red/);
  assert.match(done[4].stderr, /in test\/real\.test\.ts\. It was pulled off the train on that guess: run alone on perigee it passed on the train up to the ship before ticket\/5-x and failed with ticket\/5-x on it\. The train without it passed, but no ship pulled for it failed it by itself on main/);
  for (const t of [retro(l), ...done.map((d) => d.stderr)]) assert.doesNotMatch(t, /failed alone( here)?:|so it is the cause/);
  clean(l);
});

test('a likely ship that sits on another ship of the train has no run of its own, and is never said to have had one', async () => {
  const l = await line(ships(6, { 3: { change: ['n.txt', '3\n'] }, 4: { on: 3, also: ['a4.ts', 'export {};\n'] } }), env(real('a', 'a4.ts')), tests('a'));
  const done = await l.go();
  back(done, 4);
  assert.match(done[3].stderr, /pulled off the train on that guess: it couldn't be run on perigee with ticket\/4-x by itself on main\. The train without it passed, but no ship pulled for it failed it by itself on main/);
  assert.doesNotMatch(done.map((d) => d.stderr).join(''), /it did not stay red with/);
  clean(l);
});

test("a last red whose log doesn't name every failed file proves nothing of a held ship: it goes back in line", async () => {
  // The front alone is the last run: red on its own test/c, and the log names one file of the two it counts.
  const l = await line(ships(3, { 2: { change: ['red.txt', 'red\n'] }, 3: guess('a', 3) }), env(`${real('a', 'a3.ts')} ${real('c', 'red.txt')}`, { FAKE_REAL_FIRST: '1', FAKE_REAL_SHORT: 'test/c.test.ts' }), tests('a'));
  const done = await l.go();
  back(done, 2, 3);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.doesNotMatch(done[2].stderr, /pulled off the train on that guess/);
  clean(l);
});

test('a ship held on a guess whose train loses its last rider too goes back in line: the front alone says nothing of it', async () => {
  const l = await line(ships(4, { 3: guess('a', 3), 4: { on: 3 } }), env(real('a', 'a3.ts')), tests('a'));
  const done = await l.go();
  assert.match(done[1].stderr, /ticket\/4-x stays in line \(it sits on a ship this train holds off as a likely cause\)/);
  assert.equal(done[1].status, 0, done[1].stderr);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.doesNotMatch(done[2].stderr, /on ticket\/2-x's ship train/);
  clean(l);
});

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

// Refuse only on proof (#2098; Josh, 2026-11-26, "Have we not analyzed the guessing at all?"): of the first 10 ships
// refused because the train passed without them, 6 were innocent, 3 of those on flaky tests. Here CI fails test/real once
// (the fake's one-off red, logged as a real failure) with ship 3, which test/real imports, on the train.
const once = (d: string) => ({ FAKE_FLAKY_PATH: 'real3.ts', ...shared(d) });
const verdicts = (l: Line) => retro(l).split('\n').filter((x) => x.includes('ship train verdict'));

test('a ship pulled on a guess, not red alone, whose train passes without it, goes back in line and ships alone: nobody is refused on a guess', async () => {
  const l = await line(ships(6, { 3: guess('real', 3) }), once, tests('real'));
  const done = await l.go();
  back(done);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts; a guess: waits for the verdict\)/);
  assert.match(done[1].stderr, /#3 goes back in line to ship alone: it was pulled on a guess, and the train without it passed test\/real\.test\.ts, but no ship pulled for it failed it alone, so its own CI run decides/);
  guessed(done[2], 'test/real.test.ts', 'shipped');
  assert.equal(git(l.r.source, 'log', '-1', '--format=%s', 'main'), 'real3.ts: export const x = 3;', 'it shipped last, by itself');
  for (const d of done) assert.doesNotMatch(d.stderr, /is refused|tests failed in CI on/);
  assert.deepEqual(verdicts(l).map((x) => x.replace(/^.*?ship train verdict · /, '').replace(/https:\/\/ci\/\d+/, 'ci')), ['ticket/2-x · #3 back in line to ship alone on a guess: the train without it passed, and nothing proves it · test/real.test.ts · ci']);
  clean(l);
});

test('a guess on a test that flaked on other ships: the train passing without it proves nothing, so the ship goes back in line and rides the next train', async () => {
  const l = await line(ships(8, { 3: guess('real', 3) }), (d) => ({ ...once(d), LAND_TRAIN_MAX: '3' }), (r) => {
    tests('real')(r);
    seen(join(r.dir, 'shared'), ['test/real.test.ts']);
  });
  const done = await l.go();
  back(done);
  assert.match(done[1].stderr, /#3 goes back in line: test\/real\.test\.ts flaked on other ships, so the train passing without it proves nothing/);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.doesNotMatch(done[2].stderr, /to ship alone/);
  assert.match(done[2].stderr, /ship train: ticket\/3-x takes the \d ships waiting behind it/, 'it fronts the next train');
  assert.match(verdicts(l).join('\n'), /ship train verdict · ticket\/2-x · #3 back in line on a guess: test\/real\.test\.ts known flakes, so the pass without it proves nothing ·/);
  assert.doesNotMatch(retro(l), /refused on a guess/);
  clean(l);
});

// LB5 (the pipeline review): a ship pulled on a burn-in red, whose train without it is red in another file's burn-in. Its
// test never ran without it (a burn-in runs only the train's new and changed tests), yet it was refused on that guess.
test('LB5: a ship pulled on a burn-in guess is never refused by a burn-in red of another file without it; it ships alone, and its own run decides', async () => {
  const l = await line(
    ships(6, { 3: guess('a', 3), 5: guess('b', 5) }),
    env(`${real('a', 'a3.ts')} ${real('b', 'b5.ts')}`, { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', FAKE_REAL_FIRST: '1' }),
    tests('a', 'b'),
  );
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
