// A copy of the checkout boots from the checkout's compile cache (test/helpers.ts mirroredCopy, #1895): Node keys a portable
// cache by each file's path from the cache folder, so a copy laid out the same way from a link to the cache adds no entries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { mirroredCopy } from './helpers.ts';

const entries = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
const run = (script: string, cache: string, portable = true) => execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH, NODE_COMPILE_CACHE: cache, ...(portable ? { NODE_COMPILE_CACHE_PORTABLE: '1' } : {}) }, encoding: 'utf8' });

for (const [name, at] of [
  ['beside the checkout, as a worktree has it', (root: string) => ({ repo: join(root, 'tickets', '7'), cache: join(root, 'repo', '.git', 'worktrees', '7', 'compile-cache') })],
  ['inside the checkout, as a clone has it', (root: string) => ({ repo: join(root, 'clone'), cache: join(root, 'clone', '.git', 'compile-cache') })],
] as const) {
  test(`a copy of a checkout runs from its compile cache: the cache ${name}`, () => {
    const root = mkdtempSync(join(resolve(tmpdir()), 'boot-copy-'));
    try {
      const { repo, cache } = at(root);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'part.ts'), 'export const part: number = 2;\n');
      writeFileSync(join(repo, 'main.ts'), "import { part } from './src/part.ts';\nconst twice: number = part * 2;\nconsole.log(twice);\n");
      assert.equal(run(join(repo, 'main.ts'), cache), '4\n');
      const warm = entries(cache);
      assert.ok(warm >= 2, `the checkout's run fills the cache (${warm} entries)`);
      assert.equal(run(join(repo, 'main.ts'), cache), '4\n');
      assert.equal(entries(cache), warm, 'a second run from the checkout adds nothing');

      const mirror = mirroredCopy(join(root, 'mirror'), repo, cache);
      cpSync(repo, mirror.copy, { recursive: true, filter: (src) => !/[/\\]\.git$/.test(src) });
      assert.equal(run(join(mirror.copy, 'main.ts'), mirror.cache), '4\n');
      assert.equal(entries(cache), warm, 'the copy found every file in the cache');

      // The cases this replaces: a copy at some other path, or a cache keyed by full paths, compiles everything again.
      const plain = join(root, 'plain');
      cpSync(repo, plain, { recursive: true, filter: (src) => !/[/\\]\.git$/.test(src) });
      assert.equal(run(join(plain, 'main.ts'), cache), '4\n');
      assert.ok(entries(cache) > warm, 'a copy at any other path misses the cache');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
