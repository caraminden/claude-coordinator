// The burn-in (#1443, tools/burn-in.sh): a ship's new and changed tests run as 10 copies at once, each with its own
// TMPDIR, before the full suite; one failed copy refuses the ship. Pinned here (the handoff's three cases): a file
// failing 1 copy in 10 is refused, a clean file passes, and a change with no test in it starts no copy. Since #1456 a
// changed source file also burns in the tests that import it, directly or through one more file, nearest first.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'burn-in-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const CLEAN = "import { test } from 'node:test';\ntest('ok', () => {});\n";
// Fails in one copy of ten, as a race does: the copy whose own TMPDIR is the third.
const ONE_IN_TEN = "import { test } from 'node:test';\ntest('racy', () => { if (process.env.TMPDIR?.endsWith('/tmp3')) throw new Error('lost the race'); });\n";

let n = 0;
// A repo with the burn-in's tools and a map, one base commit, and the ship's change on top of it.
function repo(change: Record<string, string>, map = '', base: Record<string, string> = {}) {
  const dir = join(scratch, `r${++n}`);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  mkdirSync(join(dir, 'src'));
  for (const f of ['burn-in.sh', 'affected.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(root, 'tools', f), join(dir, 'tools', f));
  writeFileSync(join(dir, 'tools/affected-map.txt'), `@tests test/*.test.ts\n@fallback always\n${map}`);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  for (const [f, body] of Object.entries(base)) writeFileSync(join(dir, f), body);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  for (const [f, body] of Object.entries(change)) writeFileSync(join(dir, f), body);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'the ship');
  return dir;
}
const ship = (dir: string, env: Record<string, string> = {}) => spawnSync('bash', ['tools/burn-in.sh', '--ship', 'HEAD~1'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, '..'), ...env } });

test('a test file failing 1 copy in 10 is refused, with that copy named and its output shown', () => {
  const r = ship(repo({ 'test/racy.test.ts': ONE_IN_TEN, 'test/clean.test.ts': CLEAN }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/racy\.test\.ts: failed in 1 of 10 copies at once \(copies 3\), in \d+ s$/m);
  assert.match(r.stdout, /lost the race/, "the failing copy's output");
  assert.match(r.stdout, /^burn-in: refused: a copy of test\/racy\.test\.ts failed when run 10 at once/m);
});

test('every file runs past a racy one, and each racy file is named, so a train hears of all of them in one red run (#1564)', () => {
  const r = ship(repo({ 'test/a-racy.test.ts': ONE_IN_TEN, 'test/b-clean.test.ts': CLEAN, 'test/c-racy.test.ts': ONE_IN_TEN }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/b-clean\.test\.ts: 10 of 10 copies at once passed/m, 'the file after the first red still ran');
  for (const f of ['a-racy', 'c-racy']) {
    assert.match(r.stdout, new RegExp(`^burn-in: test/${f}\\.test\\.ts: failed in 1 of 10 copies at once \\(copies 3\\)`, 'm'));
    assert.match(r.stdout, new RegExp(`^burn-in: refused: a copy of test/${f}\\.test\\.ts failed when run 10 at once`, 'm'));
  }
});

// #2141: every copy failing is run once more alone, and the line says which case it is.
test('a file failing every copy that fails alone too is named a plain red or a CI environment fault, not a race', () => {
  const r = ship(repo({ 'test/red.test.ts': "import { test } from 'node:test';\ntest('red', () => { throw new Error('plainly red'); });\n" }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/red\.test\.ts: failed in 10 of 10 copies at once/m);
  assert.match(r.stdout, /^burn-in: test\/red\.test\.ts: alone: failed too, so it is no race: a plain red, or a fault of CI's own environment/m);
  assert.match(r.stdout, /^burn-in: refused: test\/red\.test\.ts: alone: failed too, after every copy failed: a plain red or a fault of CI's own environment, not a race/m);
  assert.doesNotMatch(r.stdout, /refused: a copy of test\/red\.test\.ts failed when run 10 at once, so it is racy/);
});

test('a file failing every copy that passes alone is a race, refused as before', () => {
  // Fails whenever it runs as one of the copies (their TMPDIRs end in /tmp<n>), passes by itself.
  const r = ship(repo({ 'test/crowd.test.ts': "import { test } from 'node:test';\ntest('crowd', () => { if (/\\/tmp\\d+$/.test(process.env.TMPDIR ?? '')) throw new Error('crowded'); });\n" }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/crowd\.test\.ts: failed in 10 of 10 copies at once/m);
  assert.match(r.stdout, /^burn-in: test\/crowd\.test\.ts: alone: passed, so it fails only beside its copies: a race$/m);
  assert.match(r.stdout, /^burn-in: refused: a copy of test\/crowd\.test\.ts failed when run 10 at once, so it is racy/m);
});

test('a file failing every copy with no time left to run it alone says so: it may be a plain red or a race', () => {
  const r = ship(repo({ 'test/red.test.ts': "import { test } from 'node:test';\ntest('red', () => { throw new Error('plainly red'); });\n" }), { BURN_IN_ALONE_MIN: '100000' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/red\.test\.ts: alone: no time left to run it, so it may be a plain red or a race$/m);
  assert.match(r.stdout, /^burn-in: refused: test\/red\.test\.ts: alone: no time left to run it, after every copy failed: a plain red or a race/m);
  assert.doesNotMatch(r.stdout, /so it is racy/);
});

test('a file failing only some copies is not run alone', () => {
  const r = ship(repo({ 'test/racy.test.ts': ONE_IN_TEN }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /alone:/);
});

test('a clean new test passes all 10 copies at once', () => {
  const r = ship(repo({ 'test/clean.test.ts': CLEAN }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: 1 file\(s\), 10 copies of each at once, one file after another, within 150 s: changed: test\/clean\.test\.ts$/m);
  assert.match(r.stdout, /^burn-in: test\/clean\.test\.ts: 10 of 10 copies at once passed, in \d+ s$/m);
});

test('a change with no test file and no mapped test starts no copy', () => {
  const r = ship(repo({ 'README.md': 'changed\n', 'test/helper.ts': 'export const x = 1;\n' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'burn-in: this change adds or changes no test file, and no test is mapped to it or imports it: nothing to burn in');
});

test("a changed source file burns in the tests the map gives it, up to the cap; a whole-folder ** rule's tests are left out", () => {
  const map = 'src/a.ts: test/a.test.ts test/b.test.ts test/c.test.ts\nsrc/**: test/guard.test.ts\n';
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' }, map, { 'src/a.ts': 'export {};\n', 'test/a.test.ts': CLEAN, 'test/b.test.ts': CLEAN, 'test/c.test.ts': CLEAN, 'test/guard.test.ts': CLEAN });
  const r = ship(dir, { BURN_IN_MAPPED: '2', BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: 3 tests are mapped to the change or import it; only the first 2 are burned in \(left out: test\/c\.test\.ts\)$/m);
  assert.match(r.stdout, /mapped from the change: test\/a\.test\.ts test\/b\.test\.ts$/m);
  assert.doesNotMatch(r.stdout, /guard\.test\.ts/);
});

// A test that imports `spec` from test/, so the walk sees it; it still passes in every copy.
const importing = (...specs: string[]) => specs.map((p) => `import '${p}';\n`).join('') + CLEAN;

test('a source-only change burns in the tests that import it, directly or through one more file, each pick named', () => {
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' }, '', {
    'src/a.ts': 'export {};\n',
    'src/b.ts': "import './a.ts';\n",
    'src/c.ts': "import './b.ts';\n",
    'test/direct.test.ts': importing('../src/a.ts'),
    'test/via.test.ts': importing('../src/b.ts'),
    'test/too-far.test.ts': importing('../src/c.ts'),
    'test/other.test.ts': CLEAN,
  });
  const r = ship(dir, { BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: picked test\/direct\.test\.ts: it imports src\/a\.ts$/m);
  assert.match(r.stdout, /^burn-in: picked test\/via\.test\.ts: it imports src\/b\.ts, which imports src\/a\.ts$/m);
  assert.match(r.stdout, /^burn-in: 2 file\(s\), 2 copies of each at once, one file after another, within 150 s: importing the change: test\/direct\.test\.ts test\/via\.test\.ts$/m);
  assert.match(r.stdout, /^burn-in: test\/via\.test\.ts: 2 of 2 copies at once passed/m);
  assert.doesNotMatch(r.stdout, /too-far|other\.test/, 'two files away, or not importing it at all, is not burned in');
});

test('the cap holds over the map and importers together, nearest importers first', () => {
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' }, 'src/a.ts: test/mapped.test.ts\n', {
    'src/a.ts': 'export {};\n',
    'src/b.ts': "import './a.ts';\n",
    'test/mapped.test.ts': CLEAN,
    'test/a.test.ts': importing('../src/a.ts'),
    'test/aa.test.ts': importing('../src/a.ts'),
    'test/0via.test.ts': importing('../src/b.ts'),
  });
  const r = ship(dir, { BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The importer named like the file, then the other direct one; the one through src/b.ts is left out.
  assert.match(r.stdout, /^burn-in: 4 tests are mapped to the change or import it; only the first 3 are burned in \(left out: test\/0via\.test\.ts\)$/m);
  assert.match(r.stdout, /mapped from the change: test\/mapped\.test\.ts; importing the change: test\/a\.test\.ts test\/aa\.test\.ts$/m);
  assert.doesNotMatch(r.stdout, /picked test\/0via/);
});

test("a full map doesn't crowd importers out: the map's picks and the importers take turns within the cap", () => {
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' }, 'src/a.ts: test/m1.test.ts test/m2.test.ts test/m3.test.ts\n', {
    'src/a.ts': 'export {};\n',
    'test/m1.test.ts': CLEAN,
    'test/m2.test.ts': CLEAN,
    'test/m3.test.ts': CLEAN,
    'test/a.test.ts': importing('../src/a.ts'),
  });
  const r = ship(dir, { BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: 4 tests are mapped to the change or import it; only the first 3 are burned in \(left out: test\/m3\.test\.ts\)$/m);
  assert.match(r.stdout, /mapped from the change: test\/m1\.test\.ts test\/m2\.test\.ts; importing the change: test\/a\.test\.ts$/m);
  assert.match(r.stdout, /^burn-in: picked test\/a\.test\.ts: it imports src\/a\.ts$/m);
});

test('a changed source file no test imports burns in nothing', () => {
  const dir = repo({ 'src/lone.ts': 'export const x = 2;\n' }, '', { 'src/lone.ts': 'export {};\n', 'test/other.test.ts': importing('../src/other.ts'), 'src/other.ts': 'export {};\n' });
  const r = ship(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'burn-in: this change adds or changes no test file, and no test is mapped to it or imports it: nothing to burn in');
});

// #2138: a file stopped at the ship's limit gives no verdict, so one whose last burn-in at the same content took longer
// than the time left is not started (Build 7's machine-sync burned 67-93 s a run to that end, Nov 26).
test('a file whose last burn-in here took longer than the time left is not started, and the next file still runs (#2138)', () => {
  const dir = repo({ 'test/a-slow.test.ts': CLEAN, 'test/b-clean.test.ts': CLEAN });
  const times = join(dir, '..', `times-${n}.tsv`);
  const blob = spawnSync('git', ['hash-object', 'test/a-slow.test.ts'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  // The same file at other content, and another file, say nothing about it.
  writeFileSync(times, `400\ttest/a-slow.test.ts\t${blob}\n1\ttest/a-slow.test.ts\t0000\n`);
  const r = ship(dir, { BURN_IN_TIMES: times, BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/a-slow\.test\.ts: not started: its last burn-in here, at this same content, took 400 s or more and 1\d\d s are left/m);
  assert.doesNotMatch(r.stdout, /a-slow\.test\.ts: \d+ of 2 copies/, 'no copy of it ran');
  assert.match(r.stdout, /^burn-in: test\/b-clean\.test\.ts: 2 of 2 copies at once passed/m);
  assert.match(r.stdout, /^burn-in: NO VERDICT on test\/a-slow\.test\.ts: not started/m);
  // The file that ran keeps its time at its content; the skipped one keeps its old line.
  const lines = readFileSync(times, 'utf8').trim().split('\n');
  const cleanBlob = spawnSync('git', ['hash-object', 'test/b-clean.test.ts'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.match(lines.at(-1)!, new RegExp(`^\\d+\\ttest/b-clean\\.test\\.ts\\t${cleanBlob}$`));
  assert.equal(lines.length, 3);
});

test('with no times file kept, every file starts as before, and a time at other content or not in whole seconds is no reason to skip (#2138)', () => {
  const dir = repo({ 'test/clean.test.ts': CLEAN });
  const times = join(dir, '..', `times-${n}.tsv`);
  const blob = spawnSync('git', ['hash-object', 'test/clean.test.ts'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  writeFileSync(times, `400\ttest/clean.test.ts\t0000\n1e9\ttest/clean.test.ts\t${blob}\n`);
  // A folder where the file should be: the run goes on as with none, and says nothing of it.
  const folder = join(dir, '..', `times-dir-${n}`);
  mkdirSync(folder);
  for (const env of [{}, { BURN_IN_TIMES: times }, { BURN_IN_TIMES: folder }] as Record<string, string>[]) {
    const r = ship(dir, { ...env, BURN_IN_COPIES: '2' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^burn-in: test\/clean\.test\.ts: 2 of 2 copies at once passed/m);
    assert.equal(r.stderr, '', 'no error from the times file');
  }
});

test('a file stopped at the limit keeps a second more than it was given, so the same time left will not start it again (#2138)', () => {
  const slow = "import { test } from 'node:test';\nimport { setTimeout as sleep } from 'node:timers/promises';\ntest('slow', () => sleep(120_000));\n";
  const dir = repo({ 'test/slow.test.ts': slow });
  const times = join(dir, '..', `times-${n}.tsv`);
  const r = ship(dir, { BURN_IN_TIMES: times, BURN_IN_COPIES: '2', BURN_IN_LIMIT: '15' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [took, file] = readFileSync(times, 'utf8').trim().split('\t');
  assert.equal(file, 'test/slow.test.ts');
  assert.ok(Number(took) > 15, `kept ${took} s, more than the 15 s it was given`);
});

// The real case (#795, Nov 16): the write queue changed src/db-writer.ts and src/routes/tickets.ts, and
// test/fresh-session.test.ts went flaky though its file hadn't changed. The import walk can't pick it: fresh-session
// imports neither file, nor any file that imports one (only server.ts and two routes do). Its race (the idle-handoff
// test, fixed by #862) was latent and surfaced under the new load, which no import line shows; the walk picks the
// write queue's own importers instead.
test("#795's change picks its importers on the real repo, and can't reach fresh-session: no import path leads there", () => {
  const r = spawnSync('bash', ['tools/burn-in.sh', '--importers', 'src/db-writer.ts', 'src/routes/tickets.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const picks = r.stdout
    .trim()
    .split('\n')
    .map((l) => l.split('\t')[0]);
  assert.equal(picks[0], 'test/db-writer.test.ts', 'the importer named like the changed file comes first');
  assert.ok(picks.includes('test/own-writes.test.ts'), r.stdout);
  assert.ok(!picks.includes('test/fresh-session.test.ts'), r.stdout);
});

// #1725: a burn-in run by hand on perigee (no CI env) is one queued heavy job: citadel-heavy with its slot and load
// gate forced, each copy nice 19, at most 4 copies. On CI (tests.yml, the flake proof) it runs as before.
const NO_CI = { RUNNER_TEMP: '', CI: '', GITHUB_ACTIONS: '', BURN_IN_QUEUED: '', BURN_IN_NICE: '', CITADEL_HEAVY_HELD: '' };
function single(env: Record<string, string>) {
  const dir = repo({ 'test/clean.test.ts': CLEAN });
  // A fake citadel-heavy beside the script logs how it was called, then runs the command; a fake nice logs each copy.
  writeFileSync(join(dir, 'tools/citadel-heavy'), `#!/usr/bin/env bash\necho "heavy JUDGE=$CITADEL_HEAVY_JUDGE $*" >>${dir}/log\nshift\nexec "$@"\n`);
  writeFileSync(join(dir, 'nice'), `#!/usr/bin/env bash\necho "nice $1 $2" >>${dir}/log\nshift 2\nexec "$@"\n`);
  for (const f of ['tools/citadel-heavy', 'nice']) chmodSync(join(dir, f), 0o755);
  const r = spawnSync('bash', ['tools/burn-in.sh', 'test/clean.test.ts'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, '..'), PATH: `${dir}:${process.env.PATH}`, ...env } });
  return { r, log: existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '' };
}

test('outside CI, a burn-in queues as one heavy job, clamps 10 copies to 4 and nices each copy (#1725)', () => {
  const { r, log } = single({ ...NO_CI, BURN_IN_COPIES: '10' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: 10 copies\b.*\b4\b.*queued/m, 'one line: asked 10, runs 4, queued');
  assert.match(log, /^heavy JUDGE=0 --here bash .*\/tools\/burn-in\.sh test\/clean\.test\.ts 4$/m, 'one citadel-heavy job, the slot forced');
  assert.equal(log.match(/^heavy /gm)?.length, 1, 'the queued run does not queue again');
  assert.equal(log.match(/^nice -n 19$/gm)?.length, 4, 'four copies, each nice 19');
  assert.match(r.stdout, /^burn-in: test\/clean\.test\.ts: 4 of 4 copies at once passed/m);
});

test('outside CI, 4 copies or fewer run as asked, still queued', () => {
  const { r, log } = single({ ...NO_CI, BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /CI's; here it runs/);
  assert.match(log, /^heavy JUDGE=0 --here bash .* test\/clean\.test\.ts 2$/m);
});

test('a copy count that is not a whole number is refused, not run as 4', () => {
  const { r, log } = single({ ...NO_CI, BURN_IN_COPIES: 'abc' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: copies must be a whole number, not abc$/m);
  assert.equal(log, '', 'nothing queued or ran');
});

test('on CI a burn-in runs as before: no citadel-heavy, no clamp, no nice of its own', () => {
  const { r, log } = single({ ...NO_CI, GITHUB_ACTIONS: 'true', BURN_IN_COPIES: '6' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(log, '', 'neither citadel-heavy nor nice was called');
  assert.match(r.stdout, /^burn-in: test\/clean\.test\.ts: 6 of 6 copies at once passed/m);
});

// #2073: copies × the file's own concurrency fits the slot. Each test of an 8-way concurrent describe holds a marker in
// a folder every copy shares for 300 ms and records how many markers it saw, so the run's peak is the box's peak.
const SLOT = 4;
const wide = (concurrency: string) =>
  [
    "import { describe, it } from 'node:test';",
    "import { mkdirSync, readdirSync, rmdirSync, appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { setTimeout as sleep } from 'node:timers/promises';",
    'const probe = process.env.BURN_IN_PROBE as string;',
    `describe('eight at once', { concurrency: ${concurrency} }, () => {`,
    '  for (let i = 0; i < 8; i++) it(`check ${i}`, async () => {',
    '    const me = join(probe, `${process.pid}-${i}`);',
    '    mkdirSync(me);',
    "    appendFileSync(join(probe, '..', 'peaks'), `${readdirSync(probe).length}\\n`);",
    '    await sleep(300); // timing-ok: holds the marker so overlapping checks see it',
    "    appendFileSync(join(probe, '..', 'peaks'), `${readdirSync(probe).length}\\n`);",
    '    rmdirSync(me);',
    '  });',
    '});',
    '',
  ].join('\n');
function inFile(body: string, env: Record<string, string>) {
  const dir = repo({ 'test/wide.test.ts': body });
  writeFileSync(join(dir, 'tools/citadel-heavy'), `#!/usr/bin/env bash\necho "heavy $*" >>${dir}/log\nshift\nexec "$@"\n`);
  chmodSync(join(dir, 'tools/citadel-heavy'), 0o755);
  mkdirSync(join(dir, 'probe'));
  const r = spawnSync('bash', ['tools/burn-in.sh', 'test/wide.test.ts'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, '..'), BURN_IN_PROBE: join(dir, 'probe'), ...env } });
  const peaks = existsSync(join(dir, 'peaks')) ? readFileSync(join(dir, 'peaks'), 'utf8').trim().split('\n').map(Number) : [];
  return { r, peak: Math.max(0, ...peaks), log: existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '' };
}
const HONOURS = 'Number(process.env.BURN_IN_INNER) || true';

test('outside CI, 4 copies of a file with an 8-way concurrent describe run at most the slot (4) checks at once (#2073)', () => {
  const { r, peak } = inFile(wide(HONOURS), { ...NO_CI, BURN_IN_COPIES: '4' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/wide\.test\.ts: 4 of 4 copies at once passed/m);
  assert.ok(peak >= 1 && peak <= SLOT, `peak ${peak} checks at once, slot ${SLOT}`);
});

test('outside CI, one copy of it still runs at most the slot at once', () => {
  const { r, peak } = inFile(wide(HONOURS), { ...NO_CI, BURN_IN_COPIES: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(peak >= 1 && peak <= SLOT, `peak ${peak}`);
});

test('outside CI, a file with a fixed concurrency of 2 runs 2 copies, not 4', () => {
  const { r, peak, log } = inFile(wide('2'), { ...NO_CI, BURN_IN_COPIES: '4' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: .*concurrency 2.*2 copies/m, 'says why it runs fewer');
  assert.match(log, /test\/wide\.test\.ts 2$/m);
  assert.ok(peak <= SLOT, `peak ${peak}`);
});

test("outside CI, a file asking concurrency: true that can't be capped is refused before any copy runs", () => {
  const { r, peak, log } = inFile(wide('true'), { ...NO_CI, BURN_IN_COPIES: '4' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: test\/wide\.test\.ts asks concurrency: true.*BURN_IN_INNER/m);
  assert.equal(log, '', 'nothing queued');
  assert.equal(peak, 0);
});

test('on CI the file runs at its own concurrency: no cap', () => {
  const { r, peak } = inFile(wide(HONOURS), { ...NO_CI, GITHUB_ACTIONS: 'true', BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(peak > SLOT, `peak ${peak}: CI's runner sizes itself`);
});
