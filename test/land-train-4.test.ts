// Part 4 of 4 of the land-train tests (#2208); the shared setup is in land-train-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git } from './land-fixture.ts';
import { type Ship, line, shipped, bad } from './land-train-fixture.ts';
import {} from './land-train-setup.ts';

// Ship 3 turns CI red; ship 4 adds the failing test file, which perigee can't fail for real: a pin that took one bad
// run as red would blame an innocent ship, so each must give no pin, the files hold ship 4, and the bisect finds ship 3.
for (const [what, body, env] of [
  ['fails only on its first run here (load)', "import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync(process.env.FLAKE_ONCE)) { writeFileSync(process.env.FLAKE_ONCE, ''); throw new Error('load'); }\n", {}],
  // timing-ok: the body of a fake test land.sh runs alone, slower than LAND_PIN_LIMIT; nothing here waits on it
  ['runs past LAND_PIN_LIMIT here', 'await new Promise((r) => setTimeout(r, 8000));\n', { LAND_PIN_LIMIT: '1' }],
] as const) {
  test(`a failing test that ${what} pins no ship: the run once more on each side, or a stop, is no answer (#1403)`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'land-pin-'));
    const l = await line([{}, {}, { change: ['red.txt', 'red\n'] }, { change: ['test/real.test.ts', body] }, {}], { FAKE_RED_PATH: 'red.txt', FLAKE_ONCE: join(tmp, 'flag'), ...env });
    const done = await l.go();
    rmSync(tmp, { recursive: true, force: true });
    assert.doesNotMatch(done[1].stderr, /Run alone on main here, the tests failed with/, 'no pin');
    assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; a guess: waits for the verdict\): CI is red .* #4: not red alone here/);
    assert.match(done[1].stderr, /#4 goes back in line/);
    assert.equal(done[2].status, 1, done[2].stderr);
    assert.match(done[2].stderr, /land: tests failed on the rebased branch in CI/);
    for (const i of [1, 2, 4, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });
}

test('a front whose failing test fails alone here with it and passes on main is refused as the cause, and its riders ship next (#1403)', async () => {
  const l = await line([{}, { change: ['src/props.ts', "throw new Error('props.propose');\n"] }, {}, {}], { FAKE_RED_TEXT: 'props.propose' }, (r) => {
    mkdirSync(join(r.source, 'src'));
    writeFileSync(join(r.source, 'src', 'props.ts'), 'export const props = 1;\n');
    r.commit(r.source, 'test/real.test.ts', "import '../src/props.ts';\n");
  });
  const done = await l.go();
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.match(done[1].stderr, /land: tests failed in CI on its ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, and run alone on perigee it passed on main and failed with ticket\/2-x on it, so it is the cause/);
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// The Nov 20 case (#1403, shared reports/incident-2026-11-20-2106-cause.md): the failing test reaches the culprit's file
// only through a hub it imports (level 2), and an innocent ship changed that hub (level 1), so the files alone blame the
// innocent one. Run alone here on the train's prefixes, the test names the ship that turns it red.
test('a failing test that fails alone here pins the ship that turns it red: the culprit behind a hub is refused, the ship that changed the hub ships, with no bisect', async () => {
  const l = await line([{}, {}, { change: ['src/db.ts', "import './props.ts';\nexport const db = 2;\n"] }, { change: ['src/props.ts', "throw new Error('props.propose');\n"] }, {}], { FAKE_RED_TEXT: 'props.propose' }, (r) => {
    mkdirSync(join(r.source, 'src'));
    writeFileSync(join(r.source, 'src', 'db.ts'), "import './props.ts';\nexport const db = 1;\n");
    writeFileSync(join(r.source, 'src', 'props.ts'), 'export const props = 1;\n');
    r.commit(r.source, 'test/real.test.ts', "import '../src/db.ts';\n");
  });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, and run alone on perigee it passed on main and failed with ticket\/4-x by itself on main, so it is the cause/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the culprit is as it was');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts; failed alone: sent back\): CI is red .* Run alone on main here, the tests failed with #4 and passed without, so that is the cause/);
  assert.doesNotMatch(done[1].stderr, /#3 \(|bisect/, 'the ship that changed the hub is no suspect, and no bisect runs');
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5]) shipped(l, done[i - 1], i, 2, 3);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the smaller train's");
  l.done();
});

// A red that names the file behind it: the ship that changed that file is the suspect, not the one that changed only
// what the red test reads, so no bisect runs. A guard that scans files rather than importing them (#1451:
// test/one-pacific.test.ts on Nov 20, 23:03 PST), where the files guess can never name a ship but run alone here on the
// train's prefixes it still names the one that turns it red; and a judge-replay red (#1538, from #1488, bounced twice on
// Nov 21): test/judges.test.ts goes red when a judge's pinned code changed without a re-recorded replay, and says which
// files are pinned.
for (const [what, read, reader, culprit, env] of [
  ['a guard that names the file behind its failure (#1451)', 'test/flake-baseline.json', 'test/real.test.ts', 'test/loop-lag.test.ts', { FAKE_RED_NAMES: 'loop-lag.test.ts:22 5 `sleep` hits, the baseline allows 3' }],
  ['a judge-replay red that names the pinned code (#1538)', 'test/judge-replays.json', 'test/judges.test.ts', 'test/pinned-judge.ts', { FAKE_REAL_FILE: 'test/judges.test.ts', FAKE_RED_NAMES: 'the flake counter code changed since its last replay (pinned code: test/pinned-judge.ts)' }],
] as const) {
  test(`${what}: the ship that changed that file is the suspect, not the one that changed the file the test reads`, async () => {
    const l = await line([{}, {}, { change: [read, '{"a":2}\n'] }, { change: [culprit, '// changed\n'] }, {}], { FAKE_RED_PATH: culprit, ...env }, (r) => {
      mkdirSync(join(r.source, 'test'), { recursive: true });
      writeFileSync(join(r.source, read), '{"a":1}\n');
      r.commit(r.source, reader, `import { readFileSync } from 'node:fs';\nreadFileSync('${read}');\n`);
    });
    const done = await l.go();
    assert.match(done[1].stderr, new RegExp(`suspects: #4 \\(${reader.replaceAll('.', '\\.')}; a guess`));
    assert.doesNotMatch(done[1].stderr, /#3 \(|bisect/, 'the ship that changed only what the test reads is no suspect');
    assert.equal(done[3].status, 1, done[3].stderr);
    for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    l.done();
  });
}

test('a scan-style guard test that imports nothing still pins the ship that turns it red, with no bisect (#1403)', async () => {
  const l = await line([{}, {}, { change: ['public/other.js', 'x\n'] }, { change: ['public/sidebar.js', "const at = 'props.propose';\n"] }, {}], { FAKE_RED_TEXT: 'props.propose' }, (r) => {
    mkdirSync(join(r.source, 'public'));
    writeFileSync(join(r.source, 'public', 'sidebar.js'), 'const at = 1;\n');
    r.commit(r.source, 'test/real.test.ts', "import { readFileSync } from 'node:fs';\nif (readFileSync('public/sidebar.js', 'utf8').includes('props.' + 'propose')) throw new Error('scan');\n");
  });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /run alone on perigee it passed on main and failed with ticket\/4-x by itself on main, so it is the cause/);
  assert.doesNotMatch(done[1].stderr, /no ship on the train touched|bisect/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

// #1827: a ship that declares Regenerate files holds the line. In line behind ship 1's deploy with ships 2 and 3 ahead
// of it, ship 4 goes next, alone; the ships behind may stack on it (early next) but none ships before it.
test('a ship that declares Regenerate files goes first among the waiters, alone, and the ships ahead of it in line wait for it', async () => {
  const l = await line([{}, {}, {}, { trailers: 'Regenerate: true\nRegenerate-files: f4.txt' }, {}]);
  assert.match(l.out[3], /ticket\/4-x declares Regenerate files \(f4\.txt\), so it holds the line/);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f4.txt: 4', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5']);
  assert.doesNotMatch(done[3].stderr, /ship train:/, 'it ships alone');
  assert.match(done[1].stderr, /in line for the deploy lock, about \d+ min \(ahead: ticket\/4-x/, 'ship 2, first in line before it, waited behind it');
  l.done();
});
