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
const ship = (dir: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['tools/burn-in.sh', '--ship', 'HEAD~1'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, '..'), ...env } });

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
    'src/a.ts': 'export {};\n', 'src/b.ts': "import './a.ts';\n", 'src/c.ts': "import './b.ts';\n",
    'test/direct.test.ts': importing('../src/a.ts'), 'test/via.test.ts': importing('../src/b.ts'),
    'test/too-far.test.ts': importing('../src/c.ts'), 'test/other.test.ts': CLEAN,
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
    'src/a.ts': 'export {};\n', 'src/b.ts': "import './a.ts';\n", 'test/mapped.test.ts': CLEAN,
    'test/a.test.ts': importing('../src/a.ts'), 'test/aa.test.ts': importing('../src/a.ts'), 'test/0via.test.ts': importing('../src/b.ts'),
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
    'src/a.ts': 'export {};\n', 'test/m1.test.ts': CLEAN, 'test/m2.test.ts': CLEAN, 'test/m3.test.ts': CLEAN, 'test/a.test.ts': importing('../src/a.ts'),
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

// The real case (#795, Nov 16): the write queue changed src/db-writer.ts and src/routes/tickets.ts, and
// test/fresh-session.test.ts went flaky though its file hadn't changed. The import walk can't pick it: fresh-session
// imports neither file, nor any file that imports one (only server.ts and two routes do). Its race (the idle-handoff
// test, fixed by #862) was latent and surfaced under the new load, which no import line shows; the walk picks the
// write queue's own importers instead.
test("#795's change picks its importers on the real repo, and can't reach fresh-session: no import path leads there", () => {
  const r = spawnSync('bash', ['tools/burn-in.sh', '--importers', 'src/db-writer.ts', 'src/routes/tickets.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const picks = r.stdout.trim().split('\n').map((l) => l.split('\t')[0]);
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
  assert.match(r.stdout, /^burn-in: 10 copies at once is CI's; here it runs 4, queued for a heavy slot/m);
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

test('on CI a burn-in runs as before: no citadel-heavy, no clamp, no nice of its own', () => {
  const { r, log } = single({ ...NO_CI, GITHUB_ACTIONS: 'true', BURN_IN_COPIES: '6' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(log, '', 'neither citadel-heavy nor nice was called');
  assert.match(r.stdout, /^burn-in: test\/clean\.test\.ts: 6 of 6 copies at once passed/m);
});
