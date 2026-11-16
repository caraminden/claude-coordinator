// The self-review's base check (kit/skills/self-review/scripts/base-check.ts): a branch's new and changed tests run
// against the base's code, and the ones that pass there are flagged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cargoArgs, casesOf, changedCases, isTestPath, judge, matches, nodeCommand, parseResults, spliceRust } from '../kit/skills/self-review/scripts/base-check.ts';
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
  assert.deepEqual(cargoArgs(ws, 'crates/core/tests/busy_cara.rs'), ['-p', 'peek-core', '--test', 'busy_cara']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/parse/mod.rs'), ['-p', 'peek-core', '--lib', '--', 'parse::']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/lib.rs'), ['-p', 'peek-core', '--lib', '--']);
  assert.deepEqual(cargoArgs(ws, 'crates/core/src/main.rs'), ['-p', 'peek-core', '--bins']);
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

  // No test changes: nothing to do.
  const none = repo('none');
  writeFileSync(join(none, 'math.ts'), 'export const double = (n: number) => n + n;\n');
  commit(none);
  r = check(none);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to check: the diff changes no test files/);
});
