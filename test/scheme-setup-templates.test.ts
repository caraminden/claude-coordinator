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
