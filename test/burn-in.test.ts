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
// BURN_IN_CPUS 16 and BURN_IN_WEIGHT 0 by default, so neither the runner's CPU count (4 on GitHub's) nor a weighing run
// paces these copies (#2290's tests set them); a weighing run counts its own processes, not a GitHub shard's other tests.
const ship = (dir: string, env: Record<string, string> = {}) => spawnSync('bash', ['tools/burn-in.sh', '--ship', 'HEAD~1'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, '..'), BURN_IN_CPUS: '16', BURN_IN_WEIGHT: '0', BURN_IN_WEIGH_BY: 'tree', ...env } });

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
  assert.match(r.stdout, /^burn-in: 1 file\(s\), 10 copies of each at once, one file after another, within 135 s: changed: test\/clean\.test\.ts$/m);
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
  assert.match(r.stdout, /^burn-in: 2 file\(s\), 2 copies of each at once, one file after another, within 135 s: importing the change: test\/direct\.test\.ts test\/via\.test\.ts$/m);
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

// #2290: a ship's burn-in fits its runner. All 10 copies still run and must pass, but a heavy file's at most
// BURN_IN_CPUS x BURN_IN_LOAD (3) / its weight at a time, each next one starting as one ends: ten copies at once of a
// server-booting file on GitHub's 4-CPU runners failed boots on load alone (#2286), while a light file's race needs all
// ten at once (#1327's fresh-session). The weight is what one copy run alone kept busy; BURN_IN_WEIGHT sets it here.
// Each copy holds a marker in a shared folder and records how many it saw, so the peak is the most copies at once.
const held = [
  "import { test } from 'node:test';",
  "import { mkdirSync, readdirSync, rmdirSync, appendFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { setTimeout as sleep } from 'node:timers/promises';",
  'const probe = process.env.BURN_IN_PROBE as string;',
  "test('held', async () => {",
  '  const me = join(probe, String(process.pid));',
  '  mkdirSync(me);',
  "  appendFileSync(join(probe, '..', 'peaks'), `${readdirSync(probe).length}\\n`);",
  '  await sleep(Number(process.env.BURN_IN_HOLD) || 400); // timing-ok: holds the marker so overlapping copies see it',
  "  appendFileSync(join(probe, '..', 'peaks'), `${readdirSync(probe).length}\\n`);",
  '  rmdirSync(me);',
  "  appendFileSync(join(probe, '..', 'ran'), 'x\\n');",
  '});',
  '',
].join('\n');
function paced(files: Record<string, string>, env: Record<string, string>) {
  const dir = repo(files);
  mkdirSync(join(dir, 'probe'));
  const r = ship(dir, { BURN_IN_PROBE: join(dir, 'probe'), ...env });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { r, peak: Math.max(0, ...read('peaks').map(Number)), ran: read('ran').length };
}

test('a heavy file on a small runner runs all 10 copies, at most CPUs x 3 / its weight at a time, and says so', () => {
  const { r, peak, ran } = paced({ 'test/held.test.ts': held }, { BURN_IN_CPUS: '2', BURN_IN_WEIGHT: '2.5' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ran, 10, 'every copy ran');
  assert.ok(peak >= 1 && peak <= 2, `peak ${peak} copies at once`);
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: one copy alone kept 2\.5 of this runner's 2 CPUs busy, so its 10 copies run at most 2 at a time \(a load of up to 3 x its CPUs\)$/m);
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: 10 of 10 copies at once \(at most 2 at a time\) passed, in \d+ s$/m);
});

test("a light file runs all 10 at once on the same runner, as a light file's race needs (#1327's fresh-session)", () => {
  const { r, ran, peak } = paced({ 'test/held.test.ts': held }, { BURN_IN_CPUS: '4', BURN_IN_WEIGHT: '1', BURN_IN_HOLD: '3000' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ran, 10);
  assert.equal(peak, 10, 'all 10 copies were running at the same moment');
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: one copy alone kept 1\.0 of this runner's 4 CPUs busy, so all 10 copies run at once/m);
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: 10 of 10 copies at once passed, in \d+ s$/m);
});

// Weighed for real: a copy that sleeps keeps almost nothing busy; one whose child process spins two threads keeps
// about 2 CPUs busy, counted though the CPU time is a grandchild's (a server's, in the real files).
const BURNS = [
  "import { test } from 'node:test';",
  "import { spawnSync } from 'node:child_process';",
  "test('a server that works hard', () => {",
  "  const spin = 'const t = Date.now(); while (Date.now() - t < 10000) { const u = process.cpuUsage(); if (u.user + u.system > 1.5e6) break }';",
  "  const code = `const { Worker } = require('node:worker_threads'); for (let i = 0; i < 2; i++) new Worker(${JSON.stringify(spin)}, { eval: true });`;",
  "  spawnSync(process.execPath, ['-e', code]);",
  '});',
  '',
].join('\n');
const weighed = (r: ReturnType<typeof ship>, file: string) => {
  const m = r.stdout.match(new RegExp(`^burn-in: ${file}: one copy alone kept ([0-9.]+) of this runner's \\d+ CPUs busy, so (?:all 10 copies run at once|its 10 copies run at most (\\d+) at a time)`, 'm'));
  assert.ok(m, r.stdout + r.stderr);
  return { weight: Number(m[1]), k: m[2] ? Number(m[2]) : 10 };
};

test("one copy is weighed alone first, its child processes' CPU time counted: a sleeper runs 10 at once, a spinner fewer", () => {
  const { r: sleeps } = paced({ 'test/held.test.ts': held }, { BURN_IN_CPUS: '4', BURN_IN_WEIGHT: '', BURN_IN_HOLD: '1500' });
  assert.equal(sleeps.status, 0, sleeps.stdout + sleeps.stderr);
  const light = weighed(sleeps, 'test/held\\.test\\.ts');
  assert.ok(light.weight < 1 && light.k === 10, `a sleeper weighed ${light.weight}, ran ${light.k} at once`);
  // One CPU: anything over a quarter of a CPU paces it, so a busy box still slows the spinners too little to pass.
  const spins = ship(repo({ 'test/burns.test.ts': BURNS }), { BURN_IN_CPUS: '1', BURN_IN_WEIGHT: '' });
  assert.equal(spins.status, 0, spins.stdout + spins.stderr);
  const heavy = weighed(spins, 'test/burns\\.test\\.ts');
  assert.ok(heavy.weight > 0.25 && heavy.k < 10, `two spinning threads weighed ${heavy.weight}, ran ${heavy.k} at a time`);
});

// A process the test leaves to run on (a Chromium, a systemd unit) isn't its child: the run's own CPU time misses it,
// the whole machine's busy time doesn't (GitHub's runners, where the job has the machine to itself).
const ESCAPES = [
  "import { test } from 'node:test';",
  "import { spawnSync } from 'node:child_process';",
  "import { setTimeout as sleep } from 'node:timers/promises';",
  "test('starts a server it leaves to run', async () => {",
  "  const spin = 'const t = Date.now(); while (Date.now() - t < 10000) { const u = process.cpuUsage(); if (u.user + u.system > 1.5e6) break }';",
  "  const grand = `const { Worker } = require('node:worker_threads'); for (let i = 0; i < 2; i++) new Worker(${JSON.stringify(spin)}, { eval: true });`;",
  "  const child = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { detached: true, stdio: 'ignore' }); console.log(c.pid); c.unref(); process.exit(0);`;",
  "  const pid = Number(spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' }).stdout);",
  '  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } };',
  '  while (alive()) await sleep(50); // timing-ok: waits for the left-behind spinner to finish',
  '});',
  '',
].join('\n');

test("on GitHub's runners the whole machine's busy time weighs a file, so what it leaves running counts too", () => {
  const tree = weighed(ship(repo({ 'test/escapes.test.ts': ESCAPES }), { BURN_IN_WEIGHT: '', BURN_IN_WEIGH_BY: 'tree' }), 'test/escapes\\.test\\.ts');
  const machine = weighed(ship(repo({ 'test/escapes.test.ts': ESCAPES }), { BURN_IN_WEIGHT: '', BURN_IN_WEIGH_BY: 'machine' }), 'test/escapes\\.test\\.ts');
  assert.ok(machine.weight - tree.weight > 0.3, `left-behind spinners: the run's own CPU time weighed ${tree.weight}, the machine's ${machine.weight}`);
});

test('a weighing run stopped at its limit counts as filling the runner, so the copies are paced, not all run at once', () => {
  const { r, ran } = paced({ 'test/held.test.ts': held }, { BURN_IN_CPUS: '4', BURN_IN_WEIGHT: '', BURN_IN_HOLD: '3000', BURN_IN_WEIGH_LIMIT: '1', BURN_IN_COPIES: '4' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ran, 4);
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: one copy alone kept 4\.0 of this runner's 4 CPUs busy, so its 4 copies run at most 3 at a time \(a load of up to 3 x its CPUs\); that run alone was stopped at 1 s, so it counts as filling the runner$/m);
});

test("the weighing runs get room on top of the limit, so a file's copies keep the time a file alone took", () => {
  const { r, ran } = paced({ 'test/held.test.ts': held }, { BURN_IN_WEIGHT: '', BURN_IN_HOLD: '9000', BURN_IN_LIMIT: '16', BURN_IN_WEIGH_ROOM: '25' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ran, 11, 'the weighing copy and all 10 ran to the end, about 20 s against a 16 s limit');
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: 10 of 10 copies at once passed/m);
});

test('past their room the weighing runs come out of the limit, so the step stays within what land.sh waits for', () => {
  // The run above with 1 s of room: about 9 s of weighing leaves the copies about 8 s of the 16, too few to finish.
  const { r } = paced({ 'test/held.test.ts': held }, { BURN_IN_WEIGHT: '', BURN_IN_HOLD: '9000', BURN_IN_LIMIT: '16', BURN_IN_WEIGH_ROOM: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: NO VERDICT on test\/held\.test\.ts: stopped at the 16 s limit/m);
  const done = Number(r.stdout.match(/^burn-in: done in (\d+) s$/m)?.[1]);
  assert.ok(done <= 19, `done in ${done} s: the limit and the 1 s of room, give or take the stop`);
});

test('a race failing 1 copy in 10 is still refused when its copies run 3 at a time, in the line land.sh reads', () => {
  const r = ship(repo({ 'test/racy.test.ts': ONE_IN_TEN }), { BURN_IN_CPUS: '3', BURN_IN_WEIGHT: '2.5' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('failed in')) ?? '';
  assert.match(line, /^burn-in: test\/racy\.test\.ts: failed in 1 of 10 copies at once \(at most 3 at a time\) \(copies 3\), in \d+ s$/);
  // tools/land/ci.sh's burn_lines and tools/land/common.sh's racy-file pick read it as before.
  assert.match(line, /burn-in: [^ ]*: failed in [0-9]* of [0-9]* copies at once/);
  assert.match(r.stdout, /^burn-in: refused: a copy of test\/racy\.test\.ts failed when run 10 at once \(at most 3 at a time\), so it is racy/m);
});

// A race between copies: each takes a lock folder every copy shares and fails if another copy holds it, so it fails
// only when two copies overlap, never one at a time (#1327's make-app "No free app port left" was this kind).
const CLASH = [
  "import { test } from 'node:test';",
  "import { mkdirSync, rmdirSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { setTimeout as sleep } from 'node:timers/promises';",
  "test('takes the one shared port', async () => {",
  "  const lock = join(process.env.BURN_IN_PROBE as string, 'port');",
  '  mkdirSync(lock); // throws EEXIST while another copy holds it',
  '  await sleep(400); // timing-ok: holds the lock so an overlapping copy finds it',
  '  rmdirSync(lock);',
  '});',
  '',
].join('\n');

test('a race between copies is still caught when they run 2 at a time, and passes only when nothing overlaps', () => {
  const caught = paced({ 'test/clash.test.ts': CLASH }, { BURN_IN_CPUS: '2', BURN_IN_WEIGHT: '2.5' });
  assert.equal(caught.r.status, 1, caught.r.stdout + caught.r.stderr);
  assert.match(caught.r.stdout, /^burn-in: test\/clash\.test\.ts: failed in \d+ of 10 copies at once \(at most 2 at a time\)/m);
  // One copy alone passes, so the fixture is a race between copies, not a plain red.
  const alone = paced({ 'test/clash.test.ts': CLASH }, { BURN_IN_CPUS: '2', BURN_IN_COPIES: '1' });
  assert.equal(alone.r.status, 0, `one copy can't clash: ${alone.r.stdout}`);
});

test('copies never run fewer than 2 at a time, so they still overlap, however heavy the file or small the runner', () => {
  const r = paced({ 'test/clash.test.ts': CLASH }, { BURN_IN_CPUS: '1', BURN_IN_WEIGHT: '30' });
  assert.equal(r.r.status, 1, r.r.stdout);
  assert.match(r.r.stdout, /so its 10 copies run at most 2 at a time/);
  assert.match(r.r.stdout, /^burn-in: test\/clash\.test\.ts: failed in \d+ of 10 copies at once \(at most 2 at a time\)/m);
});

test("a file that reads BURN_IN_INNER isn't weighed: copies x its in-file checks stay within the 4 CPUs (#2073's rule)", () => {
  const dir = repo({ 'test/wide.test.ts': wide(HONOURS) });
  mkdirSync(join(dir, 'probe'));
  const r = ship(dir, { BURN_IN_PROBE: join(dir, 'probe'), BURN_IN_CPUS: String(SLOT), BURN_IN_WEIGHT: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /one copy alone kept/);
  // A file that only names it in a string (this file's fixtures) is weighed like any other.
  const named = ship(repo({ 'test/named.test.ts': `import { test } from 'node:test';\nconst s = ${JSON.stringify(HONOURS)};\ntest('x', () => {});\n` }), { BURN_IN_WEIGHT: '' });
  assert.match(named.stdout, /^burn-in: test\/named\.test\.ts: one copy alone kept/m, named.stdout + named.stderr);
  const peaks = readFileSync(join(dir, 'peaks'), 'utf8').trim().split('\n').map(Number);
  assert.ok(Math.max(...peaks) <= SLOT, `peak ${Math.max(...peaks)} checks at once`);
  assert.equal(peaks.length, 10 * 8 * 2, 'all 10 copies ran all 8 checks');
});

test('copies waiting their turn get only the time left: the last are stopped at the limit or never start, so no verdict', () => {
  const { r, ran } = paced({ 'test/held.test.ts': held }, { BURN_IN_CPUS: '2', BURN_IN_WEIGHT: '2.5', BURN_IN_HOLD: '4000', BURN_IN_LIMIT: '15' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(ran >= 1 && ran <= 8, `${ran} copies finished in 15 s at 2 at a time: some, never all 10`);
  assert.match(r.stdout, /^burn-in: test\/held\.test\.ts: \d+ of 10 copies at once \(at most 2 at a time\) were stopped at 15 s/m);
  assert.match(r.stdout, /^burn-in: NO VERDICT on test\/held\.test\.ts: stopped at the 15 s limit/m);
});
