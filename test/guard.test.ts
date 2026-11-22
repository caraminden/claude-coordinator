import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The push guard's own cases (tools/guard.sh --self-test): Citadel's copy, and the scheme-setup
// template every auto-merge scheme copies, so neither can regress unseen.
const root = join(import.meta.dirname, '..');
// A scheme that opts in to LIVE_APPS (env or written into its copy) must still pass the self-test.
test('the template --self-test passes with LIVE_APPS set by env and written into the file', () => {
  const tpl = join(root, 'kit/skills/scheme-setup/templates/guard.sh');
  const dir = mkdtempSync(join(tmpdir(), 'guard-live-'));
  try {
    const copy = join(dir, 'guard.sh');
    writeFileSync(copy, readFileSync(tpl, 'utf8').replace(/^LIVE_APPS=\(\)$/m, 'LIVE_APPS=(x)'));
    for (const [path, env] of [[tpl, { ...process.env, GUARD_LIVE_APPS: 'x' }], [copy, process.env]] as const) {
      const r = spawnSync('bash', [path, '--self-test'], { encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /self-test: \d+ passed, 0 failed/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

  // Ultra review A9/B9: git reads --al as --all and --no-verif as --no-verify, a -c setting can redirect a push,
  // and heads/main is main. The pushes a minion makes every day still pass.
  test(`${file} refuses shortened push options, push-changing -c settings and heads/main, and still lets ordinary pushes through`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-push-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'topic', dir]);
      const hook = (command: string) => spawnSync('bash', [join(root, file), '--hook', 'bash'], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }) });
      for (const cmd of ['git push --al --no-verif origin', 'git push --al origin', 'git push --mirr origin', 'git push --branc origin', 'git push --no-verif origin topic', 'git push --forc origin topic']) {
        const r = hook(cmd);
        assert.equal(r.status, 2, cmd);
        assert.match(r.stderr, /Write git push options out in full/, cmd);
      }
      for (const cmd of ['git -c remote.origin.push=refs/heads/topic:refs/heads/main push origin', 'git -c push.default=matching push', 'git -c url.x.insteadOf=origin push origin topic', 'git -c branch.topic.merge=refs/heads/main push', 'git -c include.path=/tmp/x push origin topic', 'git -c includeIf.gitdir:/.path=/tmp/x push origin topic', 'git push origin topic:heads/main', 'git push origin heads/main']) {
        assert.equal(hook(cmd).status, 2, cmd);
      }
      for (const cmd of ['git push origin topic', 'git push -u origin topic', 'git push --set-upstream origin topic', 'git push --force-with-lease origin topic', 'git push --force-with-lease --force-if-includes origin topic', 'git push --force-with-l origin topic', 'git push --tags origin', 'git push', 'git push origin HEAD', 'git -c push.default=current status']) {
        const r = hook(cmd);
        assert.equal(r.status, 0, cmd + r.stderr);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The rare push forms the self-test list lacks: an absolute git path, --repo=, and a trailing-colon refspec.
  test(`${file} refuses rare ways to name a push to main`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-rare-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'topic', dir]);
      for (const cmd of ['/usr/bin/git push origin main', 'git push --repo=origin main', 'git push origin main:']) {
        const r = spawnSync('bash', [join(root, file), '--hook', 'bash'], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: dir }) });
        assert.equal(r.status, 2, cmd + r.stderr);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --install turns the backstop on: a fresh clone gets core.hooksPath = .githooks.
  test(`${file} --install sets core.hooksPath to .githooks in a fresh clone`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-install-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'topic', dir]);
      const run = () => spawnSync('bash', [join(root, file), '--install'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
      const get = () => spawnSync('git', ['-C', dir, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();
      assert.equal(get(), '');
      const r = run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(get(), '.githooks');
      assert.equal(run().status, 0); // a second run leaves it alone
      assert.equal(get(), '.githooks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The backstop itself: git feeds .githooks/pre-push "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
const sha = '0123456789abcdef0123456789abcdef01234567';
for (const hookFile of ['.githooks/pre-push', 'kit/skills/scheme-setup/templates/pre-push']) {
  const push = (remote: string) => spawnSync('sh', [join(root, hookFile)], { encoding: 'utf8', input: `refs/heads/x ${sha} ${remote} ${sha}\n` });
  test(`${hookFile} refuses a push to main or master and lets a feature branch through`, () => {
    for (const branch of ['main', 'master']) {
      const r = push(`refs/heads/${branch}`);
      assert.equal(r.status, 1, branch);
      assert.match(r.stderr, new RegExp(`push to ${branch} refused`));
    }
    assert.equal(push('refs/heads/feature').status, 0);
    assert.equal(push('refs/heads/mainline').status, 0);
    assert.equal(spawnSync('sh', [join(root, hookFile)], { encoding: 'utf8', input: '' }).status, 0);
    // Main on a later line of a multi-ref push still refuses.
    const multi = spawnSync('sh', [join(root, hookFile)], { encoding: 'utf8', input: `refs/heads/a ${sha} refs/heads/a ${sha}\nrefs/heads/b ${sha} refs/heads/main ${sha}\n` });
    assert.equal(multi.status, 1);
  });
}
