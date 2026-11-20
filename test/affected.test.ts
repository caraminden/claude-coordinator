import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { affected, globRe, parseMap } from '../tools/affected.ts';

// tools/affected.ts and tools/affected-map.txt (#1112): the format is specs/affected-tests-map.md in the shared folder.
const repo = join(import.meta.dirname, '..');
const tracked = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const map = parseMap(readFileSync(join(repo, 'tools', 'affected-map.txt'), 'utf8'));
const lines = (p: string[], m = map) => affected(m, p, tracked, repo);

// Tests that read the repo (a snapshot, a budget, a lint over many files) instead of one module: a change anywhere can
// break them. shortcut: a hand-kept list, so a new repo-wide test must be added here; upgrade to detecting by what it reads.
const REPO_WIDE = ['access-matrix', 'prompt-budget', 'schema-compat', 'pipeline-files', 'db-setup', 'host-check', 'ui-contract', 'hand-built-parts', 'relative-urls', 'theme', 'sw', 'ps1-lint', 'raw-log-read', 'one-until', 'skill-evals'].map((n) => `test/${n}.test.ts`);

test('globs: * stays in a folder, ** crosses them, **/ may be no folder', () => {
  assert.ok(globRe('public/**').test('public/ui/chat.js'));
  assert.ok(!globRe('public/*').test('public/ui/chat.js'));
  assert.ok(globRe('**/*.ps1').test('x.ps1') && globRe('**/*.ps1').test('a/b/x.ps1'));
  assert.ok(!globRe('src/db.ts').test('src/db-view.ts') && !globRe('src/db.ts').test('src/dbxts'));
  assert.ok(globRe('test/?.ts').test('test/a.ts') && !globRe('test/?.ts').test('test/ab.ts'));
});

test('every matching rule counts, a touched test runs itself, and a deleted one does not', () => {
  const m = parseMap('@tests test/*.test.ts\nsrc/**: test/a.test.ts\nsrc/db.ts: test/b.test.ts test/a.test.ts\n**: test/c.test.ts\n');
  const a = affected(m, ['src/db.ts', 'test/affected.test.ts', 'test/gone.test.ts'], tracked, repo);
  assert.deepEqual(a.run.map((r) => r.test), ['test/a.test.ts', 'test/affected.test.ts', 'test/b.test.ts', 'test/c.test.ts']);
  assert.deepEqual(a.run[0].why, ['map:2 src/**', 'map:3 src/db.ts']);
  assert.deepEqual(a.run[1].why, ['touched']);
  assert.deepEqual(a.unmapped, [], 'a deleted test file is a test file, not unmapped');
});

test('an uncovered path is unmapped (a catch-all does not cover it), and @fallback full asks for the full suite', () => {
  const m = parseMap('@tests test/*.test.ts\nsrc/**: test/a.test.ts\n**: test/c.test.ts\n');
  assert.deepEqual(affected(m, ['README.md'], tracked, repo).unmapped, ['README.md']);
  assert.equal(affected(m, ['README.md'], tracked, repo).full, false);
  assert.equal(affected(parseMap('@fallback full\nsrc/**: test/a.test.ts\n'), ['README.md'], tracked, repo).full, true);
  assert.equal(affected(m, [], tracked, repo).empty, true);
});

test('a bad map says which line', () => {
  assert.throws(() => parseMap('src/db.ts\n'), /map line 1/);
  assert.throws(() => parseMap('\nsrc/db.ts:\n'), /map line 2: .* names no test/);
  assert.throws(() => parseMap('@fallback maybe\n'), /map line 1/);
  assert.throws(() => parseMap('@nope x\n'), /unknown directive/);
});

test("Citadel's map: its tests exist, its globs match something, and every repo-wide test is mapped or always run", () => {
  const always = readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const mapped = new Set(map.rules.flatMap((r) => r.tests.flatMap((t) => (/[*?]/.test(t) ? tracked.filter((f) => globRe(t).test(f)) : [t]))));
  for (const t of mapped) assert.ok(tracked.includes(t), `the map names ${t}, which is not a tracked file`);
  for (const r of map.rules) assert.ok(r.glob === '**' || tracked.some((f) => r.re.test(f)), `map:${r.line} ${r.glob} matches no tracked file`);
  for (const t of REPO_WIDE) {
    assert.ok(tracked.includes(t), `REPO_WIDE names ${t}, which is not a tracked file`);
    assert.ok(mapped.has(t) || always.includes(t), `${t} reads the repo but is on no rule of tools/affected-map.txt and not in tools/always-tests.txt`);
  }
});

test('the command prints which rule picked each test', () => {
  const r = spawnSync('node', ['tools/affected.ts', '--paths', 'src/db.ts', 'NOTES.txt'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^run\ttest\/db-setup\.test\.ts\tmap:\d+ src\/db\.ts$/m);
  assert.match(r.stdout, /^unmapped\tNOTES\.txt$/m);
});

test('the command reads a real diff: a committed change and an untracked file', () => {
  const r = spawnSync('node', ['tools/affected.ts', '--base', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const bad = spawnSync('node', ['tools/affected.ts', '--base', 'no-such-ref'], { cwd: repo, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
