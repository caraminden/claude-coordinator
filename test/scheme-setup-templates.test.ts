// The scheme-setup template tests (size-budget.test.ts, format.test.ts), set up in a repo unlike Citadel: other source
// folders, another language, another style. A scheme sets the config at their top and must not touch the rest (#1866).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const repo = join(import.meta.dirname, '..');
const templates = join(repo, 'kit/skills/scheme-setup/templates');
const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env; // a nested `node --test` reports to the outer one otherwise

const scheme = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'templates-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const run = (f: string) => {
    const r = spawnSync(process.execPath, ['--no-warnings', '--test', join('test', f)], { cwd: dir, encoding: 'utf8', env });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  return { dir, run, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const sizeBudget = (roots: string, code: string) => {
  const t = readFileSync(join(templates, 'size-budget.test.ts'), 'utf8');
  const set = t.replace(/^const ROOTS = .*$/m, `const ROOTS = ${roots};`).replace(/^const CODE = .*$/m, `const CODE = ${code};`);
  assert.notEqual(set, t);
  return set;
};

test('the size-budget template passes in a repo with other folders and extensions, and still fails on its big file', () => {
  const s = scheme({ 'package.json': '{"type":"module"}', 'test/size-budget.test.ts': sizeBudget("['packages/app', 'server']", '/\\.py$/'), 'server/a.py': 'x\n' });
  try {
    const ok = s.run('size-budget.test.ts');
    assert.equal(ok.status, 0, ok.out);
    writeFileSync(join(s.dir, 'server/big.py'), 'x\n'.repeat(1501));
    const red = s.run('size-budget.test.ts');
    assert.equal(red.status, 1, red.out);
    assert.match(red.out, /server\/big\.py: 1501 lines, limit 1500/);
  } finally {
    s.done();
  }
});

test('the size-budget template lets a listed file grow 50 lines past its number, and not one more (#2139)', () => {
  const listed = sizeBudget("['server']", '/\\.py$/').replace(/^(export const ALLOWED: .*\{)$/m, "$1\n  'server/big.py': [1600, 'one file'],");
  const s = scheme({ 'package.json': '{"type":"module"}', 'test/size-budget.test.ts': listed, 'server/big.py': 'x\n'.repeat(1650) });
  try {
    const ok = s.run('size-budget.test.ts');
    assert.equal(ok.status, 0, ok.out);
    writeFileSync(join(s.dir, 'server/big.py'), 'x\n'.repeat(1651));
    const red = s.run('size-budget.test.ts');
    assert.equal(red.status, 1, red.out);
    assert.match(red.out, /server\/big\.py: 1651 lines, limit 1650, 1 over \(its ALLOWED size 1600 \+ 50 slack\)/);
  } finally {
    s.done();
  }
});

test("the format template passes in a repo with another style and includes, and still fails on that repo's unformatted file", () => {
  // Edited as text: Biome formats biome.json too.
  const template = readFileSync(join(templates, 'biome.config.json'), 'utf8');
  const config = template
    .replace(/"includes": \[.*\]/, '"includes": ["web/**/*.ts"]')
    .replace('"quoteStyle": "single"', '"quoteStyle": "double"')
    .replace('"semicolons": "always"', '"semicolons": "asNeeded"');
  assert.equal(JSON.parse(config).files.includes[0] + JSON.parse(config).javascript.formatter.semicolons, 'web/**/*.tsasNeeded');
  const s = scheme({ 'package.json': '{"type":"module"}', 'biome.json': config, 'web/a.ts': 'export const a = { b: "c" }\n' });
  try {
    mkdirSync(join(s.dir, 'test'));
    mkdirSync(join(s.dir, 'node_modules/.bin'), { recursive: true });
    symlinkSync(join(repo, 'node_modules/.bin/biome'), join(s.dir, 'node_modules/.bin/biome'));
    copyFileSync(join(templates, 'format.test.ts'), join(s.dir, 'test/format.test.ts'));
    const ok = s.run('format.test.ts');
    assert.equal(ok.status, 0, ok.out);
    assert.doesNotMatch(ok.out, /# SKIP|skipped [1-9]/);
    writeFileSync(join(s.dir, 'web/a.ts'), "export const a = {b:'c'};\n");
    const red = s.run('format.test.ts');
    assert.equal(red.status, 1, red.out);
    assert.match(red.out, /web\/a\.ts/);
  } finally {
    s.done();
  }
});

test("the biome.json template leaves a Python environment's JavaScript alone (#2007)", () => {
  const theirs = 'var  a=1\n';
  const dirs = ['.venv/lib/torch/x.js', 'ml/.venv/lib/torch/x.js'];
  const s = scheme({ 'biome.json': readFileSync(join(templates, 'biome.config.json'), 'utf8'), 'src/b.js': 'const  b=2\n', ...Object.fromEntries(dirs.map((f) => [f, theirs])) });
  try {
    const r = spawnSync(join(repo, 'node_modules/.bin/biome'), ['format', '--write', '.'], { cwd: s.dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(s.dir, 'src/b.js'), 'utf8'), 'const b = 2;\n');
    for (const f of dirs) assert.equal(readFileSync(join(s.dir, f), 'utf8'), theirs, f);
  } finally {
    s.done();
  }
});

test("the format template's way onto main replays a branch cut before the reformat, keeping both sides and a hand fix in the reformat (#2007)", () => {
  const steps = /^const REBASE = `([^`]*)`;$/m.exec(readFileSync(join(templates, 'format.test.ts'), 'utf8'))?.[1];
  assert.ok(steps);
  const lines = ['const a = {x:1}', 'const k1 = 1;', 'const k2 = 2;', 'const b = "two"', 'const k3 = 3;', 'const k4 = 4;', 'const c = [ 3 ]', ''];
  // The branch is cut before the formatter arrives. The list also holds a hash main lacks (a reformat noted before it
  // was rebased) and a later cleanup with no formatter yet: the steps must pass over both.
  const s = scheme({ '.gitignore': 'node_modules\n', 'f.js': lines.join('\n'), 'hand.txt': 'as it was\n' });
  const sh = (script: string) => {
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: s.dir, encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(r.status, 0, `${script}\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  const edit = (from: string, to: string) => writeFileSync(join(s.dir, 'f.js'), readFileSync(join(s.dir, 'f.js'), 'utf8').replace(from, to));
  try {
    sh('git init -q -b main && git add -A && git commit -qm base && git branch work && echo x > cleanup.txt && git add -A && git commit -qm cleanup');
    mkdirSync(join(s.dir, 'tools'));
    copyFileSync(join(templates, 'fmt'), join(s.dir, 'tools/fmt'));
    copyFileSync(join(templates, 'biome.config.json'), join(s.dir, 'biome.json'));
    writeFileSync(join(s.dir, 'package.json'), '{"devDependencies":{"@biomejs/biome":"2.6.9"}}\n');
    mkdirSync(join(s.dir, 'node_modules/.bin'), { recursive: true });
    symlinkSync(join(repo, 'node_modules/.bin/biome'), join(s.dir, 'node_modules/.bin/biome'));
    sh('chmod +x tools/fmt && git add -A && git commit -qm setup');
    sh("tools/fmt && echo 'fixed by hand' > hand.txt && git commit -qam reformat");
    sh("(echo '# list'; git commit-tree 'HEAD^{tree}' -p HEAD~1 -m 'before its rebase'; git rev-parse HEAD~2 HEAD) > .git-blame-ignore-revs && git add -A && git commit -qm ignore-revs");
    edit('const c = [3];', 'const c = [33];');
    sh("git commit -qam 'main edits c' && git switch -q work");
    edit('{x:1}', '{x:100}');
    sh("git commit -qam '#1: a'");
    edit('const k3 = 3;', 'const k3 = 33;');
    sh("git commit -qam '#1: k3'");
    for (const line of steps.trim().split('\n')) sh(line); // one shell each: nothing carries over
    assert.equal(readFileSync(join(s.dir, 'f.js'), 'utf8'), "const a = { x: 100 };\nconst k1 = 1;\nconst k2 = 2;\nconst b = 'two';\nconst k3 = 33;\nconst k4 = 4;\nconst c = [33];\n");
    assert.equal(readFileSync(join(s.dir, 'hand.txt'), 'utf8'), 'fixed by hand\n');
    assert.equal(sh('git branch --show-current && git log --format=%s main..HEAD && git status --porcelain'), 'work\n#1: k3\n');
    // Run again where nothing qualifies: an earlier run's ref must not carry the steps on.
    const [first, second] = steps.trim().split('\n') as [string, string];
    spawnSync('bash', ['-c', first], { cwd: s.dir, env });
    assert.notEqual(spawnSync('bash', ['-c', second], { cwd: s.dir, env }).status, 0);
  } finally {
    s.done();
  }
});

test('a Rust repo is set up with unsafe denied by default, and a note on every use', () => {
  const lints = readFileSync(join(templates, 'rust-lints.toml'), 'utf8');
  assert.match(lints, /^\[workspace\.lints\.rust\]\nunsafe_code = "deny"/m);
  assert.match(lints, /^\[workspace\.lints\.clippy\]\nundocumented_unsafe_blocks = "deny"/m);
  const skill = readFileSync(join(templates, '../SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  for (const part of ['templates/rust-lints.toml', '`workspace = true`', '#![allow(unsafe_code)]', '// SAFETY:', 'cargo clippy']) {
    assert.ok(skill.includes(part), part);
  }
});
