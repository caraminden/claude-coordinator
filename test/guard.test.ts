import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

// The push guard's own cases (tools/guard.sh --self-test): Citadel's copy, and the scheme-setup
// template every auto-merge scheme copies, so neither can regress unseen.
const root = join(import.meta.dirname, '..');
for (const file of ['tools/guard.sh', 'kit/skills/scheme-setup/templates/guard.sh']) {
  test(`${file} --self-test passes`, () => {
    const r = spawnSync('bash', [join(root, file), '--self-test'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /self-test: \d+ passed, 0 failed/);
  });
}
