// The format check before a ship joins the line (#1885): on tools/always-tests.txt, so citadel-test and land.sh's smoke
// check run it. Only files this branch changed can fail it; test/format.test.ts checks the whole repo, on CI. It never
// skips for a missing Biome (tools/fmt gets the pinned one through npx, or fails saying nothing was checked).
// Its own tests: test/fmt.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

test('every .ts, .js and .mjs file this branch changed is formatted', { skip: process.env.CI ? 'test/format.test.ts checks every file here' : false }, () => {
  const r = spawnSync(join(root, 'tools/fmt'), ['--check', '--own'], { cwd: root, encoding: 'utf8' });
  assert.equal(
    r.status,
    0,
    `${r.stderr
      .split('\n')
      .filter((l) => l.startsWith('fmt: '))
      .join('\n')}\n\n${(r.stdout + r.stderr).slice(0, 3000)}`,
  );
});
