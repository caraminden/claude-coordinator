import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

// tools/who-uses (#1781) on a scratch repo with a TypeScript, a Python, a Rust and a Godot corner: the tests that reach a
// file directly, through another file or by naming its path, credited to the narrowest file they come through; a
// symbol's definitions (two files: twins), callers and tests; and an untracked file counting like a tracked one.
const tool = join(import.meta.dirname, '..', 'tools', 'who-uses');
const dir = mkdtempSync(join(tmpdir(), 'who-uses-'));
after(() => rmSync(dir, { recursive: true, force: true })); // timing-ok: own temp dir
const repo = join(dir, 'repo');
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

execFileSync('git', ['init', '-q', '-b', 'main', repo]);
// TypeScript: store <- api (imported as .js) <- api.test; store <- hub <- 3 tests; store <- narrow <- both.test (also via hub).
put('src/store.ts', 'export function save(x: number) {\n  return x;\n}\n');
put('src/api.ts', "import { save } from './store.js';\nexport const run = () => save(1);\n");
put('src/hub.ts', "import './store.ts';\n");
put('src/narrow.ts', "import { save } from './store.ts';\nsave(2);\n");
put('test/api.test.ts', "import { run } from '../src/api.ts';\nrun();\n");
put('test/a.test.ts', "import '../src/hub.ts';\n");
put('test/b.test.ts', "import '../src/hub.ts';\n");
put('test/both.test.ts', "import '../src/hub.ts';\nimport '../src/narrow.ts';\n");
put('test/guard.test.ts', "const src = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');\n");
put('test/fakes.ts', 'export class FakeStore {\n  save(x: number) {\n    return 0;\n  }\n}\n');
put('test/fake-user.test.ts', "import { FakeStore } from './fakes.ts';\nnew FakeStore().save(3);\n");
put('README.md', 'The store lives in src/store.ts.\n');
put('src/storex.ts', '// see src/store.tsx and xsrc/store.ts\n');
// Python: pkg/models.py <- pkg/service.py (relative import) <- tests/test_service.py.
put('pkg/__init__.py', '');
put('pkg/models.py', 'class Thing: pass\n');
put('pkg/service.py', 'from .models import Thing\n\ndef run():\n    return Thing()\n');
put('tests/test_service.py', 'from pkg.service import run\n');
// Rust: crate demo-core; lib.rs declares parse; parse.rs has inline tests; an integration test in a nested folder.
put('core/Cargo.toml', '[package]\nname = "demo-core"\nversion = "0.1.0"\n');
put('core/src/lib.rs', 'pub mod parse;\n');
put('core/src/parse.rs', 'pub fn go() -> u8 { 1 }\n#[cfg(test)]\nmod tests { #[test] fn t() {} }\n');
put('core/tests/suite/parse_it.rs', 'use demo_core::parse::go;\n#[test]\nfn it() { go(); }\n');
// Godot: enemy.gd (class_name) <- spawner.gd (by name) <- tests/test_spawner.gd (res:// preload).
put('game/project.godot', '[application]\n');
put('game/scripts/enemy.gd', 'class_name Enemy\nextends Node\n');
put('game/scripts/spawner.gd', 'extends Node\nfunc spawn():\n\treturn Enemy.new()\n');
put('game/tests/test_spawner.gd', 'extends Node\nconst S = preload("res://scripts/spawner.gd")\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: repo });
// Untracked, not ignored: still counts.
put('test/store.test.ts', "import { save } from '../src/store.ts';\nsave(4);\n");

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [tool, ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const section = (out: string, label: string) =>
  out
    .split('\n')
    .filter((l, i, all) => {
      const start = all.findIndex((x) => x.includes(label));
      if (start < 0 || i < start) return false;
      const next = all.findIndex((x, j) => j > start && /^ {2}\S/.test(x));
      return next < 0 || i < next;
    })
    .join('\n');

test('a TypeScript file: direct tests, tests through other files credited to the narrowest, path namers and docs', () => {
  const out = run('src/store.ts');
  const direct = section(out, 'tests, direct');
  assert.match(direct, /test\/store\.test\.ts/, 'the untracked test counts');
  assert.match(direct, /test\/guard\.test\.ts:1/, 'a test that names the path counts, with its line');
  assert.match(section(out, 'used by'), /src\/api\.ts/, "'./store.js' resolves to store.ts");
  assert.match(out, /via src\/api\.ts \(1\): test\/api\.test\.ts/);
  assert.match(out, /via src\/narrow\.ts \(1\): test\/both\.test\.ts/, 'both.test.ts is credited to the narrow file, not the hub');
  assert.match(out, /via src\/hub\.ts \(2\): test\/a\.test\.ts test\/b\.test\.ts/);
  assert.match(section(out, 'named in docs and lists'), /README\.md:1/);
  assert.doesNotMatch(out, /src\/storex\.ts/, 'a longer name containing the path does not count');
});

test('a symbol: two definitions are twins, with callers and the tests that name it', () => {
  const out = run('save');
  assert.match(out, /defined in 2 files: twins[^\n]*\n?[^\n]*src\/store\.ts:1/);
  assert.match(out, /test\/fakes\.ts:2/);
  assert.match(section(out, 'used in'), /src\/api\.ts:1[\s\S]*src\/narrow\.ts:1/);
  assert.match(section(out, 'tests naming it'), /test\/fake-user\.test\.ts:2/);
});

test('Python: a relative import, then an absolute one, reach the test', () => {
  const out = run('pkg/models.py');
  assert.match(section(out, 'used by'), /pkg\/service\.py/);
  assert.match(out, /via pkg\/service\.py \(1\): tests\/test_service\.py/);
});

test('Rust: a crate path from an integration test in a nested folder, and inline tests', () => {
  const out = run('core/src/parse.rs');
  assert.match(section(out, 'tests, direct'), /core\/tests\/suite\/parse_it\.rs/);
  assert.match(section(out, 'used by'), /core\/src\/lib\.rs/, 'mod parse; in lib.rs');
  assert.match(out, /tests inside the file/);
});

test('Godot: class_name use and a res:// preload', () => {
  const out = run('game/scripts/enemy.gd');
  assert.match(section(out, 'used by'), /game\/scripts\/spawner\.gd/);
  assert.match(out, /via game\/scripts\/spawner\.gd \(1\): game\/tests\/test_spawner\.gd/);
});

test('usage errors exit 2', () => {
  assert.equal(spawnSync(process.execPath, [tool], { cwd: repo }).status, 2);
  assert.equal(spawnSync(process.execPath, [tool, '--bogus', 'x'], { cwd: repo }).status, 2);
  assert.equal(spawnSync(process.execPath, [tool, 'x'], { cwd: dir }).status, 2, 'outside a repo');
});
