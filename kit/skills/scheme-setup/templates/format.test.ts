// The format gate (Citadel #1792; Citadel's copy is test/format.test.ts): every TypeScript and JavaScript file is as Biome (biome.json) writes it.
// never makes two branches conflict. The failure message is the way out for a branch that predates the reformat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const bin = join(root, 'node_modules/.bin/biome');

export const FIX = 'Run `tools/fmt` and commit the result. A branch that was started before the reformat: run `tools/fmt` on your branch, commit it, then rebase onto main (`git rebase main -X theirs` keeps your side of every formatting-only conflict, and the formatter fixes the rest again).';

test('every .ts, .js and .mjs file is formatted', { skip: !existsSync(bin) && !process.env.CI ? 'Biome is not installed here (run `npm ci`); CI runs this check' : false }, () => {
  assert.ok(existsSync(bin), 'Biome is missing: run `npm ci`');
  const r = spawnSync(bin, ['format', '--max-diagnostics=10', '.'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `${FIX}\n\n${(r.stdout + r.stderr).slice(0, 3000)}`);
});

test('the check is red on an unformatted file and green once formatted', { skip: !existsSync(bin) ? 'Biome is not installed here' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmt-'));
  try {
    copyFileSync(join(root, 'biome.json'), join(dir, 'biome.json'));
    writeFileSync(join(dir, 'x.ts'), 'const  a = {b:1}\n');
    const run = (...args: string[]) => spawnSync(bin, ['format', ...args, '.'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(run().status, 0);
    assert.equal(run('--write').status, 0);
    assert.equal(readFileSync(join(dir, 'x.ts'), 'utf8'), 'const a = { b: 1 };\n');
    assert.equal(run().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
