// The self-review's base check (kit/skills/self-review/scripts/base-check.ts): a branch's new and changed tests run
// against the base's code, and the ones that pass there are flagged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cargoArgs, cargoNoTarget, casesOf, changedCases, isTestPath, judge, matches, nodeCommand, parseResults, pyLeaks, pyPath, spliceRust } from '../kit/skills/self-review/scripts/base-check.ts';
import { git } from './git.ts';

const SCRIPT = join(import.meta.dirname, '..', 'kit', 'skills', 'self-review', 'scripts', 'base-check.ts');
const root = mkdtempSync(join(tmpdir(), 'base-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', TMPDIR: root };

test('reads per-case results from node TAP, vitest tap-flat, cargo and pytest', () => {
  const out = [
    'ok 1 - adds two',
    '    not ok 2 - a nested \\# case',
    'ok 3 - pending # SKIP not yet',
    'ok 4 - src/a.test.ts > math > doubles # time=1.2ms',
    'test parse::tests::rejects_empty ... ok',
    'test parse::tests::reads_one ... FAILED',
    'test slow ... ignored',
    'PASSED ingest/tests/test_load.py::test_reads[case-1]',
    'FAILED ingest/tests/test_load.py::Loader::test_writes - AssertionError',
  ].join('\n');
  assert.deepEqual(parseResults(out), [
    { name: 'adds two', ok: true },
    { name: 'a nested # case', ok: false },
    { name: 'pending', ok: 'skip' },
    { name: 'src/a.test.ts > math > doubles', ok: true },
    { name: 'parse::tests::rejects_empty', ok: true },
    { name: 'parse::tests::reads_one', ok: false },
    { name: 'slow', ok: 'skip' },
    { name: 'ingest/tests/test_load.py::test_reads[case-1]', ok: true },
    { name: 'ingest/tests/test_load.py::Loader::test_writes', ok: false },
  ]);
  assert.ok(matches('src/a.test.ts > math > doubles', 'doubles'));
  assert.ok(matches('parse::tests::rejects_empty', 'rejects_empty'));
  assert.ok(matches('ingest/tests/test_load.py::test_reads[case-1]', 'test_reads'));
  assert.ok(!matches('parse::tests::rejects_empty_list', 'rejects_empty'));
});

test('finds the new and changed cases, not the untouched ones', () => {
  const base = "test('keeps', () => {\n  assert.equal(f(1), 1);\n});\n\ntest('edits', () => {\n  assert.equal(f(2), 2);\n});\n";
  const head = base.replace('f(2), 2', 'f(2), 4') + "\nit(\"adds\", async () => {\n  assert.ok(g());\n});\n";
  assert.deepEqual(changedCases(base, head, 'js'), ['edits', 'adds']);
  assert.deepEqual(changedCases(null, head, 'js'), ['keeps', 'edits', 'adds']);
  assert.deepEqual([...casesOf("t.test('it\\'s nested', () => {})", 'js').keys()], ["it's nested"]);
  const rs = '#[test]\nfn one() {\n    assert!(true);\n}\n\n#[tokio::test]\n#[ignore]\nasync fn two() {}\n';
  assert.deepEqual([...casesOf(rs, 'rs').keys()], ['one', 'two']);
  assert.deepEqual([...casesOf('class T:\n    def test_a(self):\n        pass\ndef helper(): pass\ndef test_b(): pass\n', 'py').keys()], ['test_a', 'test_b']);
});

test('splices the branch\'s trailing Rust test module onto the base\'s code', () => {
  const base = 'pub fn f() -> u8 { 1 }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn one() { assert_eq!(f(), 1); }\n}\n';
  const head = 'pub fn f() -> u8 { 2 }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn one() { assert_eq!(f(), 2); }\n}\n';
  assert.equal(spliceRust(base, head), 'pub fn f() -> u8 { 1 }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn one() { assert_eq!(f(), 2); }\n}\n');
  assert.equal(spliceRust('pub fn f() {}\n', head), 'pub fn f() {}\n\n' + head.slice(head.indexOf('#[cfg(test)]')), 'a base with no tests yet gets the module added');
  assert.equal(spliceRust(base, head.replace(/\n$/, '\n\npub fn g() {}\n')), null, 'code after the module: not one trailing module');
});

test('picks the runner\'s command and the cargo target', () => {
  assert.deepEqual(nodeCommand('tools/citadel-node --test --test-concurrency=${N:-2} --test-global-setup=test/leak-guard.ts test/', 'test/a.test.ts'), ['tools/citadel-node', '--test', '--test-force-exit', '--test-reporter=tap', '--test-global-setup=test/leak-guard.ts', 'test/a.test.ts']);
  assert.deepEqual(nodeCommand('node --test --test-concurrency=1 --test-timeout=120000 test/', 'test/a.test.ts'), ['node', '--test', '--test-force-exit', '--test-reporter=tap', '--test-timeout=120000', 'test/a.test.ts']);
  assert.deepEqual(nodeCommand('', 'a.test.ts'), ['node', '--test', '--test-force-exit', '--test-reporter=tap', 'a.test.ts']);
  const ws = join(root, 'cargo-ws');
  mkdirSync(join(ws, 'crates', 'core', 'src', 'parse'), { recursive: true });
  writeFileSync(join(ws, 'crates', 'core', 'Cargo.toml'), '[package]\nname = "peek-core"\nversion = "0.1.0"\n\n[dependencies]\nname = "x"\n');
  writeFileSync(join(ws, 'crates', 'core', 'src', 'lib.rs'), '');
  assert.deepEqual(cargoArgs(ws, 'crates/core/tests/busy_cara.rs'), ['-p', 'peek-core', '--test', 'busy_cara']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/parse/mod.rs'), ['-p', 'peek-core', '--lib', '--', 'parse::']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/lib.rs'), ['-p', 'peek-core', '--lib', '--']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/main.rs'), ['-p', 'peek-core', '--bins']);
  // With the changed cases known, only those run, not the whole lib or bin target.
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/lib.rs', ['clamps', 'rounds']), ['-p', 'peek-core', '--lib', '--', 'clamps', 'rounds']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/main.rs', ['clamps']), ['-p', 'peek-core', '--bins', '--', 'clamps']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/tests/busy_cara.rs', ['x']), ['-p', 'peek-core', '--test', 'busy_cara'], 'an integration test file is its own target');
  // A crate with no library (a binary-only app crate): its modules' tests run as the bin target, never `--lib`.
  mkdirSync(join(ws, 'crates', 'app', 'src'), { recursive: true });
  writeFileSync(join(ws, 'crates', 'app', 'Cargo.toml'), '[package]\nname = "peek-app"\nversion = "0.1.0"\n');
  writeFileSync(join(ws, 'crates', 'app', 'src', 'main.rs'), 'fn main() {}\n');
  assert.deepEqual(cargoArgs(ws, 'crates/app/src/auras.rs', ['pulses']), ['-p', 'peek-app', '--bins', '--', 'pulses']);
  assert.deepEqual(cargoArgs(ws, 'crates/app/src/auras/mod.rs'), ['-p', 'peek-app', '--bins']);
  assert.match(cargoNoTarget('error: no library targets found in package `peek-app`\n') ?? '', /^no library targets found/);
  assert.equal(cargoNoTarget('error[E0425]: cannot find value\n'), null);
  assert.ok(isTestPath('crates/core/tests/common/mod.rs') && isTestPath('src/a.spec.ts') && !isTestPath('src/latest.ts'));
});

test('judges a file: a case passing on the base is flagged; failing, not loading or skipped is not', () => {
  const run = (status: number, out: string) => ({ status, out, timedOut: false, parsed: true });
  const e = { path: 't.test.ts', cases: ['new', 'other'] };
  assert.deepEqual(judge(e, run(1, 'ok 1 - new\nnot ok 2 - other')).map((v) => v.kind), ['flag', 'red']);
  const load = judge(e, run(1, "# SyntaxError: The requested module '../m.ts' does not provide an export named 'g'\nnot ok 1 - t.test.ts\n  error: 'test failed'"));
  assert.deepEqual(load, [{ kind: 'red', label: 't.test.ts', detail: "didn't run on the base (2 new or changed cases): SyntaxError: The requested module '../m.ts' does not provide an export named 'g'" }], 'a file that never loaded: one line, with the cause');
  assert.deepEqual(judge(e, run(0, 'ok 1 - new # SKIP\nok 2 - other')).map((v) => v.kind), ['skipped', 'flag']);
  assert.deepEqual(judge(e, run(0, '')).map((v) => v.kind), ['skipped'], 'a run that reports nothing proves nothing');
  assert.deepEqual(judge(e, { ...run(0, ''), timedOut: true }).map((v) => v.kind), ['skipped']);
  assert.deepEqual(judge({ path: 't', cases: null }, { status: 0, out: 'whatever', timedOut: false, parsed: false }).map((v) => v.kind), ['flag'], 'a --cmd run with no parsed cases: the exit status decides');
  assert.deepEqual(judge({ path: 't.test.ts', cases: [] }, run(0, 'ok 1 - old')), [{ kind: 'skipped', label: 't.test.ts', detail: 'no new or changed case found (only shared setup or helpers changed): judge it by hand' }], 'a file whose cases are all unchanged is not a finding');
});

/** A repo with a little module and its test on main, and a branch on top. */
function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'test'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/' } }));
  writeFileSync(join(dir, 'math.ts'), 'export const double = (n: number) => n * 2;\n');
  writeFileSync(join(dir, 'test', 'math.test.ts'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { double } from '../math.ts';\n\ntest('doubles', () => assert.equal(double(2), 4));\n");
  git(dir, 'add', '-A');
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: dir, env });
  git(dir, 'switch', '-q', '-c', 'feature');
  return dir;
}

const commit = (dir: string) => spawnSync('git', ['commit', '-qam', 'change'], { cwd: dir, env });
const check = (dir: string) => spawnSync(process.execPath, [SCRIPT], { cwd: dir, env, encoding: 'utf8' });

test('end to end: a fix whose new test fails on main is not flagged; a test that passes on main is', () => {
  // A real fix: double(-0) should be 0, not -0; its test fails on main's code.
  const fix = repo('fix');
  writeFileSync(join(fix, 'math.ts'), 'export const double = (n: number) => n * 2 + 0;\n');
  writeFileSync(join(fix, 'test', 'math.test.ts'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { double } from '../math.ts';\n\ntest('doubles', () => assert.equal(double(2), 4));\n\ntest('negative zero doubles to zero', () => assert.ok(Object.is(double(-0), 0)));\n");
  commit(fix);
  let r = check(fix);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^red +test\/math\.test\.ts › negative zero doubles to zero$/m);
  assert.doesNotMatch(r.stdout, /› doubles/, 'the untouched test is not judged');
  assert.match(r.stdout, /Result: 0 pass on the base, 1 red, 0 skipped/);
  assert.equal(git(fix, 'worktree', 'list').trim().split('\n').length, 1, 'the scratch worktree is gone');

  // A test that only pins what main already does: flagged.
  const pin = repo('pin');
  writeFileSync(join(pin, 'test', 'math.test.ts'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { double } from '../math.ts';\n\ntest('doubles', () => assert.equal(double(2), 4));\n\ntest('doubles three', () => assert.equal(double(3), 6));\n");
  commit(pin);
  r = check(pin);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASSES ON BASE +test\/math\.test\.ts › doubles three$/m);

  // A new test file that imports what only the branch adds: red, it can't load on main.
  const load = repo('load');
  writeFileSync(join(load, 'math.ts'), 'export const double = (n: number) => n * 2;\nexport const half = (n: number) => n / 2;\n');
  writeFileSync(join(load, 'test', 'half.test.ts'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { half } from '../math.ts';\n\ntest('halves', () => assert.equal(half(4), 2));\n");
  git(load, 'add', '-A');
  commit(load);
  r = check(load);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^red +test\/half\.test\.ts: didn't run on the base \(1 new or changed case\): SyntaxError: .*does not provide an export named 'half'/m);

  // A test file of a stack it can't name: said, never dropped.
  const ruby = repo('ruby');
  writeFileSync(join(ruby, 'test', 'math_test.rb'), "assert true\n");
  writeFileSync(join(ruby, 'test', 'helper.rb'), "# shared\n");
  git(ruby, 'add', '-A');
  commit(ruby);
  r = check(ruby);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^skipped +test\/math_test\.rb: no runner for this kind of test file: run it on the base by hand$/m);
  assert.doesNotMatch(r.stdout, /helper\.rb/, 'a helper is not a test file');

  // No test changes: nothing to do.
  const none = repo('none');
  writeFileSync(join(none, 'math.ts'), 'export const double = (n: number) => n + n;\n');
  commit(none);
  r = check(none);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to check: the diff changes no test files/);
});

test('(a) a helper named self-test.ts is not a test file; a name the package\'s test script covers, and the usual names, still are', () => {
  assert.equal(isTestPath('app/shared/self-test.ts', 'node --test test/', 'shared/self-test.ts'), false);
  assert.equal(isTestPath('app/shared/self-test.ts'), false);
  assert.equal(isTestPath('app/shared/self-test.ts', 'node --test shared/', 'shared/self-test.ts'), true, 'the script runs that folder');
  assert.equal(isTestPath('app/x-test.ts', "node --test '**/*-test.ts'", 'x-test.ts'), true, 'a glob in the script');
  assert.doesNotThrow(() => isTestPath('app/x-test.ts', 'tools/citadel-node --test --test-concurrency=${N:-2} test/', 'x-test.ts'));
  assert.ok(isTestPath('test/x-test.ts') && isTestPath('src/a.spec.ts') && isTestPath('src/a.test.ts') && isTestPath('pkg/foo_test.py'));
});

test('(b) a tools/*-test.sh shell test is a test file, and its exit status judges it', () => {
  assert.ok(isTestPath('tools/land-test.sh') && isTestPath('scripts/a_test.sh'));
  assert.ok(!isTestPath('tools/land.sh') && !isTestPath('tools/test-lib.sh'));
  const sh = repo('shell');
  writeFileSync(join(sh, 'math.ts'), 'export const double = (n: number) => n * 2;\nexport const half = (n: number) => n / 2;\n');
  mkdirSync(join(sh, 'tools'));
  writeFileSync(join(sh, 'tools', 'half-test.sh'), "#!/bin/bash\ngrep -q half math.ts\n");
  writeFileSync(join(sh, 'tools', 'double-test.sh'), "#!/bin/bash\ngrep -q double math.ts\n");
  git(sh, 'add', '-A');
  commit(sh);
  const r = check(sh);
  assert.match(r.stdout, /^red +tools\/half-test\.sh/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASSES ON BASE +tools\/double-test\.sh: the whole file passed on the base$/m);
  assert.equal(r.status, 1);
});

test('(c) a Python run drops inherited paths into the branch and flags a module that resolves outside the base tree', () => {
  assert.equal(pyPath('/t/tree/app', '/r/repo', '/r/repo/app:/usr/lib/x', true), '/t/tree/app/src:/t/tree/app:/usr/lib/x');
  assert.equal(pyPath('/t/tree', '/r/repo', undefined, false), '/t/tree');
  assert.deepEqual(pyLeaks('MOD export /r/repo/app/export.py\nMOD util /t/tree/app/util.py\nMOD json /usr/lib/python3/json/__init__.py', '/r/repo', '/t/tree'), ['export']);
});

test('(d) --cmd runs from the repo root through sh -c, so `cd test && …` works', () => {
  const pin = repo('cmd');
  writeFileSync(join(pin, 'test', 'math.test.ts'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { double } from '../math.ts';\n\ntest('doubles', () => assert.equal(double(2), 4));\n\ntest('doubles three', () => assert.equal(double(3), 6));\n");
  commit(pin);
  const r = spawnSync(process.execPath, [SCRIPT, '--cmd', 'cd test && node --test --test-reporter=tap {file}'], { cwd: pin, env, encoding: 'utf8' });
  assert.match(r.stdout, /^PASSES ON BASE +test\/math\.test\.ts › doubles three$/m, r.stdout + r.stderr);
});

test('a setup error exits 2 with one line, not a stack trace and the findings code', () => {
  const dir = repo('nobase');
  git(dir, 'switch', '-q', '--orphan', 'island');
  writeFileSync(join(dir, 'x.txt'), 'x\n');
  git(dir, 'add', '-A');
  spawnSync('git', ['commit', '-qm', 'unrelated'], { cwd: dir, env });
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'feature'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^base-check: git merge-base/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack');
});

test('changed fixtures reach the base as the same bytes and mode, and a non-ASCII path keeps its name', () => {
  const dir = repo('bytes');
  const blob = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x0a]);
  writeFileSync(join(dir, 'test', 'tést.bin'), blob);
  writeFileSync(join(dir, 'test', 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  writeFileSync(join(dir, 'test', 'fixtures.test.ts'), `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('binary fixture is intact', () => assert.deepEqual([...readFileSync(new URL('./tést.bin', import.meta.url))], [255, 254, 0, 128, 195, 40, 10]));
test('helper is executable', () => assert.equal(execFileSync(new URL('./run.sh', import.meta.url).pathname, { encoding: 'utf8' }), 'ok\\n'));
`);
  git(dir, 'add', '-A');
  commit(dir);
  const r = check(dir);
  assert.match(r.stdout, /^PASSES ON BASE +test\/fixtures\.test\.ts › binary fixture is intact$/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASSES ON BASE +test\/fixtures\.test\.ts › helper is executable$/m, r.stdout + r.stderr);
});
