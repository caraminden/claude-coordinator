import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  // A git hook (pre-push running the checks) exports GIT_DIR and friends; the self-test's scratch
  // repos must not land in the repo being pushed (Peek Auras: core.bare=true, HEAD moved).
  test(`${file} --self-test under a git hook's GIT_DIR leaves that repo alone`, () => {
    const real = mkdtempSync(join(tmpdir(), 'guard-real-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'mine', real]);
      const before = { config: readFileSync(join(real, '.git', 'config'), 'utf8'), head: readFileSync(join(real, '.git', 'HEAD'), 'utf8') };
      // NESTED skips the self-test's own copy of this check, which would only run it a third time.
      const env = { ...process.env, GIT_DIR: join(real, '.git'), GIT_WORK_TREE: real, GIT_INDEX_FILE: join(real, '.git', 'index'), GUARD_SELF_TEST_NESTED: '1' };
      const r = spawnSync('bash', [join(root, file), '--self-test'], { encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(readFileSync(join(real, '.git', 'HEAD'), 'utf8'), before.head);
      assert.equal(readFileSync(join(real, '.git', 'config'), 'utf8'), before.config);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
}
