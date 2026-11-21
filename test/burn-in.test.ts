// The burn-in (#1443, tools/burn-in.sh): a ship's new and changed tests run as 10 copies at once, each with its own
// TMPDIR, before the full suite; one failed copy refuses the ship. Pinned here (the handoff's three cases): a file
// failing 1 copy in 10 is refused, a clean file passes, and a change with no test in it starts no copy.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('a clean new test passes all 10 copies at once', () => {
  const r = ship(repo({ 'test/clean.test.ts': CLEAN }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: 1 file\(s\), 10 copies of each at once, one file after another, within 150 s: changed: test\/clean\.test\.ts$/m);
  assert.match(r.stdout, /^burn-in: test\/clean\.test\.ts: 10 of 10 copies at once passed, in \d+ s$/m);
});

test('a change with no test file and no mapped test starts no copy', () => {
  const r = ship(repo({ 'README.md': 'changed\n', 'test/helper.ts': 'export const x = 1;\n' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'burn-in: this change adds or changes no test file and maps to none: nothing to burn in');
});

test("a changed source file burns in the tests the map gives it, up to the cap; a whole-folder ** rule's tests are left out", () => {
  const map = 'src/a.ts: test/a.test.ts test/b.test.ts test/c.test.ts\nsrc/**: test/guard.test.ts\n';
  const dir = repo({ 'src/a.ts': 'export const a = 1;\n' }, map, { 'src/a.ts': 'export {};\n', 'test/a.test.ts': CLEAN, 'test/b.test.ts': CLEAN, 'test/c.test.ts': CLEAN, 'test/guard.test.ts': CLEAN });
  const r = ship(dir, { BURN_IN_MAPPED: '2', BURN_IN_COPIES: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^burn-in: the change maps to 3 tests; only the first 2 are burned in \(left out: test\/c\.test\.ts\)$/m);
  assert.match(r.stdout, /mapped from the change: test\/a\.test\.ts test\/b\.test\.ts$/m);
  assert.doesNotMatch(r.stdout, /guard\.test\.ts/);
});
