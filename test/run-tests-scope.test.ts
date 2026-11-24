import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/run-tests.sh: a landing's test run gets a CPU-weighted systemd scope when it can (#503), with a stand-in
// systemd-run, so no test makes a real scope.
const runTests = join(import.meta.dirname, '..', 'tools', 'run-tests.sh');
const root = mkdtempSync(join(tmpdir(), 'run-tests-'));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, 'repo');
mkdirSync(join(repo, 'test'), { recursive: true });
writeFileSync(join(repo, 'test', 'a.test.mjs'), "import test from 'node:test';\ntest('the one test', () => {});\n");
const bin = join(root, 'bin');
mkdirSync(bin);
// Records its arguments, then fails (FAKE_SYSTEMD_FAIL) or runs what follows `--`, as a scope would.
writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\necho "$*" >>"$FAKE_SYSTEMD_LOG"\n[ -z "$FAKE_SYSTEMD_FAIL" ] || exit 1\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n');
chmodSync(join(bin, 'systemd-run'), 0o755);
let n = 0;
function run(env: Record<string, string | undefined> = {}) {
  const calls = join(root, `calls-${n}`);
  const log = join(root, `log-${n++}`);
  const r = spawnSync(runTests, [log], { cwd: repo, encoding: 'utf8', env: { ...scriptEnv(), PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMD_LOG: calls, DEPLOY_TEST_CPU_WEIGHT: undefined, NODE_TEST_CONTEXT: undefined, COORDINATOR_SHARED_DIR: undefined, ...env }, timeout: 60_000 });
  return { status: r.status, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [], log: readFileSync(log, 'utf8') };
}

test('the tests run in a scope in citadel.slice with CPUWeight=500, bound to the user unit it runs in', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.log, /ℹ pass 1/);
  assert.equal(r.calls.length, 2, 'a probe, then the run');
  assert.match(r.calls[1], /^--user --scope --quiet --collect --slice=citadel\.slice -p CPUWeight=500 .*-- \S*\/citadel-node \S*\/suite-runner\.ts --concurrency \d+ --timeout \d+ .*-- test\/$/);
  const cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim();
  const unit = /\/user@\d+\.service\/.+\/([^/]+\.(?:service|scope))$/.exec(cgroup)?.[1];
  if (unit) assert.ok(r.calls[1].includes(`-p BindsTo=${unit} --`), 'stopping the landing turn still stops its tests');
  else assert.doesNotMatch(r.calls[1], /BindsTo/, "nothing of the user manager's to bind to");
});

test('without a systemd to ask it runs unweighted, and an empty weight asks none', () => {
  let r = run({ FAKE_SYSTEMD_FAIL: '1' });
  assert.equal(r.status, 0);
  assert.match(r.log, /ℹ pass 1/);
  assert.equal(r.calls.length, 1, 'only the probe');
  r = run({ DEPLOY_TEST_CPU_WEIGHT: '' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  r = run({ DEPLOY_TEST_CPU_WEIGHT: '200' });
  assert.match(r.calls[1], /CPUWeight=200/);
});

test('a failing test still fails the run through the scope, and its rerun alone is weighted too', () => {
  writeFileSync(join(repo, 'test', 'b.test.mjs'), "import test from 'node:test';\ntest('red', () => { throw new Error('no'); });\n");
  try {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.calls[2], /CPUWeight=500 .*-- \S*\/citadel-node --test --test-force-exit --test-timeout=\d+ test\/b\.test\.mjs$/);
  } finally {
    rmSync(join(repo, 'test', 'b.test.mjs'));
  }
});

test('a file that leaves something behind fails its rerun alone too: a real failure, never a flake (#1763)', () => {
  // The real guard, as the repo's own test/leak-guard.ts: each file counts what it leaves (test/leak-file.ts).
  const guard = join(repo, 'test', 'leak-guard.ts');
  symlinkSync(join(import.meta.dirname, 'leak-guard.ts'), guard);
  writeFileSync(join(repo, 'test', 'c.test.mjs'), "import test from 'node:test';\nimport { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\ntest('green, but leaves a folder', () => { mkdtempSync(join(tmpdir(), 'left-')); });\n");
  try {
    const r = run();
    assert.equal(r.status, 1, r.log);
    assert.match(r.log, /leak guard: \S*c\.test\.mjs left these behind/, r.log);
    assert.match(r.calls[2], /--test-global-setup=test\/leak-guard\.ts test\/c\.test\.mjs$/);
    assert.match(r.log, /run-tests: test\/c\.test\.mjs: failed again alone: a real failure/, r.log);
    assert.doesNotMatch(r.log, /passed alone/, r.log);
  } finally {
    rmSync(join(repo, 'test', 'c.test.mjs'));
    rmSync(guard);
  }
});
