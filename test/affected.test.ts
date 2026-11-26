import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { affected, directImports, globRe, parseMap } from '../tools/affected.ts';

// tools/affected.ts and tools/affected-map.txt (#1112): the format is specs/affected-tests-map.md in the shared folder.
const repo = join(import.meta.dirname, '..');
const tracked = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const map = parseMap(readFileSync(join(repo, 'tools', 'affected-map.txt'), 'utf8'));
const lines = (p: string[], m = map) => affected(m, p, tracked, repo);

// Tests that read the repo (a snapshot, a budget, a lint over many files) instead of one module: a change anywhere can
// break them. shortcut: a hand-kept list, so a new repo-wide test must be added here; upgrade to detecting by what it reads.
const REPO_WIDE = [
  'access-matrix',
  'prompt-budget',
  'schema-compat',
  'pipeline-files',
  'db-setup',
  'host-check',
  'ui-contract',
  'hand-built-parts',
  'relative-urls',
  'theme',
  'sw',
  'ps1-lint',
  'raw-log-read',
  'one-until',
  'skill-evals',
  'format',
  'one-pacific',
  'one-home',
  'worker-tla',
  'frontend-syntax',
  'css-has-cost',
  'help-words',
  'unit-thp',
].map((n) => `test/${n}.test.ts`);

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
  assert.deepEqual(
    a.run.map((r) => r.test),
    ['test/a.test.ts', 'test/affected.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
  );
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
  assert.throws(() => parseMap('@pinned\n'), /map line 1: @pinned needs a test/);
});

test("Citadel's map: its tests exist, its globs match something, and every repo-wide test is mapped or always run", () => {
  const always = readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  const mapped = new Set(map.rules.flatMap((r) => r.tests.flatMap((t) => (/[*?]/.test(t) ? tracked.filter((f) => globRe(t).test(f)) : [t]))));
  for (const t of mapped) assert.ok(tracked.includes(t), `the map names ${t}, which is not a tracked file`);
  for (const r of map.rules) assert.ok(r.glob === '**' || tracked.some((f) => r.re.test(f)), `map:${r.line} ${r.glob} matches no tracked file`);
  for (const t of REPO_WIDE) {
    assert.ok(tracked.includes(t), `REPO_WIDE names ${t}, which is not a tracked file`);
    assert.ok(mapped.has(t) || always.includes(t), `${t} reads the repo but is on no rule of tools/affected-map.txt and not in tools/always-tests.txt`);
  }
});

// #1240: land.sh runs these four on the rebased branch before CI (its guards()), so a minion's `citadel-test --affected`
// must pick each for the paths that can break it, or the first a minion hears of one is a refused ship.
test('the guard tests land.sh runs before CI are picked for every path that can break them', () => {
  const always = readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8').split('\n');
  const picked = (path: string) => lines([path]).run.map((r) => r.test);
  for (const t of ['test/schema-compat.test.ts', 'test/prompt-budget.test.ts']) assert.ok(always.includes(t), `${t} runs on every citadel-test run`);
  for (const path of ['test/anything.test.ts', 'test/land-fixture.ts']) assert.ok(picked(path).includes('test/one-until.test.ts'), path);
  for (const path of ['public/app.js', 'public/ui/chat.js', 'public/style.css', 'src/theme.ts', 'test/ui-contract.json']) assert.ok(picked(path).includes('test/ui-contract.test.ts'), path);
  const sh = readFileSync(join(repo, 'tools', 'land.sh'), 'utf8');
  for (const t of ['test/schema-compat.test.ts', 'test/prompt-budget.test.ts', 'test/one-until.test.ts', 'test/ui-contract.test.ts', 'test/size-budget.test.ts']) assert.ok(sh.includes(t), `land.sh's guards run ${t}`);
});

// #1544: the route test is over 5 CPU-seconds, so it is on the map, not the always list.
test('the route test runs for the paths that can move the route table, and not on every run', () => {
  const always = readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8').split('\n');
  assert.ok(!always.includes('test/access-matrix.test.ts'));
  const picked = (path: string) => lines([path]).run.map((r) => r.test);
  for (const path of ['server.ts', 'src/http.ts', 'src/auth.ts', 'src/apps.ts', 'src/contraptions.ts', 'src/access.ts', 'src/routes/x.ts', 'src/db/people.ts', 'test/helpers.ts', 'test/access-matrix.snapshot.json', 'test/access-matrix.test.ts']) assert.ok(picked(path).includes('test/access-matrix.test.ts'), path);
  assert.ok(!picked('test/ports.test.ts').includes('test/access-matrix.test.ts'));
});

// Effort retro "Push failure gaps" (#2065): the slow source-tree guards ride the map, so each path that can break one picks it.
test('the slow source-tree guards are picked by every path they scan', () => {
  const picked = (path: string) => lines([path]).run.map((r) => r.test);
  for (const path of ['server.ts', 'src/runner.ts', 'src/routes/x.ts', 'public/progress.js']) assert.ok(picked(path).includes('test/worker-tla.test.ts'), path);
  for (const path of ['public/core.js', 'public/ui/chat.js']) assert.ok(picked(path).includes('test/frontend-syntax.test.ts'), path);
});

test('the command prints which rule picked each test', () => {
  const r = spawnSync('node', ['tools/affected.ts', '--paths', 'src/db.ts', 'NOTES.txt'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^run\ttest\/db-setup\.test\.ts\tmap:\d+ src\/db\.ts(, imports src\/db\.ts)?$/m);
  assert.match(r.stdout, /^unmapped\tNOTES\.txt$/m);
});

test('the command reads a real diff: committed, uncommitted and untracked changes, and a rename as both paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'affected-'));
  const g = (...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    mkdirSync(join(dir, 'tools'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'tools', 'affected-map.txt'), '@tests t/*.test.ts\nsrc/a.ts: t/a.test.ts\nsrc/b.ts: t/b.test.ts\nsrc/c.ts: t/c.test.ts\nsrc/d.ts: t/d.test.ts\nsrc/old.ts: t/o.test.ts\n');
    for (const f of ['a', 'b', 'c', 'old']) writeFileSync(join(dir, 'src', `${f}.ts`), f);
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g('commit', '-qm', 'base');
    g('checkout', '-qb', 'work');
    writeFileSync(join(dir, 'src', 'a.ts'), 'changed');
    g('commit', '-qam', 'committed');
    writeFileSync(join(dir, 'src', 'b.ts'), 'edited'); // uncommitted
    writeFileSync(join(dir, 'src', 'd.ts'), 'new'); // untracked
    g('mv', 'src/old.ts', 'src/new.ts'); // a rename: old.ts's rule fires too
    const r = spawnSync('node', [join(repo, 'tools', 'affected.ts'), '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ran = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('run\t'))
      .map((l) => l.split('\t')[1]);
    assert.deepEqual(ran, ['t/a.test.ts', 't/b.test.ts', 't/d.test.ts', 't/o.test.ts']);
    assert.match(r.stdout, /^unmapped\tsrc\/new\.ts$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const bad = spawnSync('node', ['tools/affected.ts', '--base', 'no-such-ref'], { cwd: repo, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

// #1413: a file CLAUDE.md names under "High risk by file" must have a map rule, so a broken guard shows in a pre-ship run.
// shortcut: the deploy files have no test that catches a break yet (not in R11), so they are exempt; map each and drop it here.
const DEPLOY_GAPS = ['tools/deploy.sh', 'tools/boot-check.ts', 'deploy/'];
test('every file CLAUDE.md lists as high risk by file is covered by a rule of the map', () => {
  const bullet =
    readFileSync(join(repo, 'CLAUDE.md'), 'utf8')
      .split('\n- ')
      .find((b) => b.startsWith('**High risk by file')) ?? '';
  const paths = [...bullet.matchAll(/`([^`<>\s]+)`/g)].map((m) => m[1]).filter((p) => /[/.]/.test(p) && !p.startsWith('test/') && !DEPLOY_GAPS.includes(p));
  assert.ok(paths.length >= 5, 'found the high-risk paths in CLAUDE.md');
  for (const p of paths) {
    const probe = p.endsWith('/') ? `${p}x` : p;
    assert.ok(
      map.rules.some((r) => r.glob !== '**' && r.re.test(probe)),
      `${p} is high risk in CLAUDE.md but no rule of tools/affected-map.txt covers it`,
    );
  }
});

// #1622: replay the map gaps behind the red ship-train runs of Nov 21-22 (reports/why-green-goes-red-2026-11-22.md). Each row:
// the ship, a path its commits changed, and the test CI then failed. Found from the retro log's "ship train suspects" lines
// and each ship's commits on main. Rows a name rule, the boot-check rule or a cheap explicit line catches are here (the report's 15
// distinct breaks were not listed by the report; this is rebuilt from the retro log). The rest of that day's 43 culprit pairs
// (judges, one-until, sync-calls, status-page, db-writer, 1522's boot-check from src/desktop-feed.ts ...) are coupling no
// name or line shows: an import-graph rule would catch them only by picking 320-377 of ~550 tests (ruled out).
const BREAKS: [ship: string, changed: string, failed: string][] = [
  ['#1532', 'public/base.js', 'test/boot-check.test.ts'],
  ['#1532', 'public/inbox.js', 'test/boot-check.test.ts'],
  ['#1533', 'public/inbox.js', 'test/inbox.test.js'],
  ['#1539', 'src/host-signals.ts', 'test/host-signals.test.ts'],
  ['#1590', 'src/front.ts', 'test/front.test.ts'],
  ['#1543', 'public/schemes.js', 'test/schemes.test.js'],
  ['#1607', 'src/ci-health.ts', 'test/ci-health.test.ts'],
  ['#1452', 'src/runner.ts', 'test/closed-cleanup.test.ts'],
  ['#1464', 'src/runner.ts', 'test/closed-cleanup.test.ts'],
  ['#1364', 'src/runner.ts', 'test/background-jobs.test.ts'],
];
test('each replayed break picks the test that failed', () => {
  for (const [ship, changed, failed] of BREAKS)
    assert.ok(
      lines([changed]).run.some((r) => r.test === failed),
      `${ship}: ${changed} must pick ${failed}`,
    );
});

test('a source file picks its same-name test by basename (.ts or .js), and only a test that is tracked', () => {
  const picked = (p: string) =>
    lines([p])
      .run.filter((r) => r.why.some((w) => w.startsWith('name')))
      .map((r) => r.test);
  assert.deepEqual(picked('src/inbox.ts'), ['test/inbox.test.js', 'test/inbox.test.ts']);
  assert.deepEqual(
    picked('public/ui/chat.js'),
    tracked.filter((f) => /^test\/chat\.test\.(ts|js)$/.test(f)),
  );
  assert.deepEqual(picked('src/no-such-module-xyz.ts'), []);
  assert.deepEqual(picked('tools/affected.ts'), ['test/affected.test.ts']);
});

test('any public/ change picks the boot-check test', () => {
  for (const p of ['public/base.js', 'public/ui/chat.js', 'public/style.css', 'public/x/new-file.html'])
    assert.ok(
      lines([p]).run.some((r) => r.test === 'test/boot-check.test.ts'),
      p,
    );
});

// #1912: the two cheap guards that #1910 found red on low ships whose own pick missed them.
test('a public/ change picks the show-parts guard, and a lens change the review-set one', () => {
  const picks = (p: string, t: string) => lines([p]).run.some((r) => r.test === t);
  for (const p of ['public/parts.js', 'public/style.css', 'tools/citadel-where']) assert.ok(picks(p, 'test/show-parts.test.ts'), p);
  for (const p of ['kit/skills/self-review/lenses/ui.md', 'src/review-backfill.json']) assert.ok(picks(p, 'test/review-set.test.ts'), p);
});

test('a test that directly imports a src/, public/ or tools/ module is picked when that module changes (#1809)', () => {
  const missed: string[] = [];
  for (const t of tracked.filter((f) => map.tests.some((re) => re.test(f)))) {
    for (const dep of directImports(repo, t)) {
      if (!/^(src|public|tools)\//.test(dep) || !tracked.includes(dep)) continue;
      if (!lines([dep]).run.some((r) => r.test === t)) missed.push(`${t} imports ${dep}`);
    }
  }
  assert.deepEqual(missed, [], "add the file to the map's @imports glob, or a rule line for it");
});

test('@imports picks only the test files that import the changed file directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aff-imp-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.ts'), '');
    writeFileSync(join(dir, 'test', 'x.test.ts'), "import { a } from '../src/a.ts';\n");
    writeFileSync(join(dir, 'test', 'y.test.ts'), "const z = await import('../src/b.ts');\n");
    const m = parseMap('@tests test/*.test.ts\n@imports src/**\n');
    const tr = ['src/a.ts', 'test/x.test.ts', 'test/y.test.ts'];
    assert.deepEqual(
      affected(m, ['src/a.ts'], tr, dir).run.map((r) => r.test),
      ['test/x.test.ts'],
    );
    assert.deepEqual(
      affected(m, ['src/b.ts'], tr, dir).run.map((r) => r.test),
      ['test/y.test.ts'],
    );
    assert.deepEqual(affected(parseMap('@tests test/*.test.ts\n'), ['src/a.ts'], tr, dir).run, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #1928: citadel-test's default pick is the tests you touched and the same-named ones; the wide pick keeps the rest.
test('--narrow picks only touched, same-name and @pinned tests, however many import the file; the wide pick still adds them', () => {
  const changed = ['src/runner.ts', 'src/db.ts', 'src/inbox.ts', 'test/affected.test.ts', 'NOTES.txt'];
  const narrow = affected(map, changed, tracked, repo, true);
  const wide = affected(map, changed, tracked, repo);
  const only = (a: typeof narrow) => a.run.map((r) => r.test);
  assert.ok(only(wide).length > only(narrow).length + 10, 'a change to runner.ts and db.ts has many dependants');
  assert.ok(only(narrow).every((t) => narrow.run.find((r) => r.test === t)!.why.every((w) => w === 'touched' || w.startsWith('name ') || (w.startsWith('map:') && map.pinned.includes(t)))));
  assert.ok(only(narrow).includes('test/affected.test.ts') && only(narrow).includes('test/inbox.test.ts'));
  assert.ok(only(wide).includes('test/db-setup.test.ts') && !only(narrow).includes('test/db-setup.test.ts'));
  assert.deepEqual([narrow.unmapped, narrow.full], [[], false], 'an unmapped path is not an error in the narrow pick');
  const full = parseMap('@tests test/*.test.ts\n@fallback full\n');
  assert.equal(affected(full, ['NOTES.txt'], tracked, repo, true).full, false);
  assert.equal(affected(full, ['NOTES.txt'], tracked, repo).full, true);
});

// #2037 (Josh, 2026-11-25, "Run when their code changes"): the pinning tests too slow for every run are @pinned, so the
// narrow pick takes them from the rules that name them; other rules' tests stay the wide pick's.
test('--narrow takes a @pinned test from the rules that pick it, and no other rule test', () => {
  const m = parseMap('@tests test/*.test.ts\n@pinned test/slow.test.ts\nsrc/a.ts: test/slow.test.ts test/other.test.ts\nsrc/b.ts: test/other.test.ts\n');
  const pick = (p: string, narrow: boolean) => affected(m, [p], [], repo, narrow).run.map((r) => `${r.test} ${r.why.join()}`);
  assert.deepEqual(pick('src/a.ts', true), ['test/slow.test.ts map:3 src/a.ts']);
  assert.deepEqual(pick('src/b.ts', true), []);
  assert.deepEqual(pick('src/a.ts', false), ['test/other.test.ts map:3 src/a.ts', 'test/slow.test.ts map:3 src/a.ts']);
});

test("Citadel's map: a change to runner.ts or db.ts runs the slow pinning tests in citadel-test's narrow pick (#2037)", () => {
  for (const t of map.pinned) assert.ok(tracked.includes(t), `@pinned names ${t}, which is not a tracked file`);
  const narrow = (p: string) => affected(map, [p], tracked, repo, true).run.map((r) => r.test);
  for (const t of ['test/list-reads.test.ts', 'test/boot-check.test.ts']) assert.ok(narrow('src/runner.ts').includes(t), `src/runner.ts picks ${t}`);
  for (const t of ['test/list-reads.test.ts', 'test/access-matrix.test.ts']) assert.ok(narrow('src/db.ts').includes(t), `src/db.ts picks ${t}`);
  assert.ok(narrow('src/http.ts').includes('test/access-matrix.test.ts'));
  assert.ok(!narrow('src/inbox.ts').some((t) => map.pinned.includes(t)), 'a file no rule ties to them runs none');
});

test('the command with --narrow says how many more tests the wide pick would run', () => {
  const r = spawnSync('node', ['tools/affected.ts', '--narrow', '--paths', 'src/db.ts', 'NOTES.txt'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^unmapped/m);
  assert.match(r.stdout, /^wide\t[1-9]\d*$/m);
});
