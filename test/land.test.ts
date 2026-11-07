import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

// tools/land.sh on throwaway repos: a scheme repo on main, a minion worktree, and a live clone. The
// worktree's tools/deploy.sh is a stand-in that notes whether it got the lock, and fails on request.
const land = join(import.meta.dirname, '..', 'tools', 'land.sh');
const root = mkdtempSync(join(tmpdir(), 'land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make land.sh's own `node --test` report to this runner instead of exiting red;
// COORDINATOR_* would have the real deploy.sh report to the live server; CITADEL_HEAVY_* would queue it in the host's slots.
const env = { ...process.env, COORDINATOR_CONTAINER: undefined, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: join(root, 'heavy'), NODE_TEST_CONTEXT: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

let n = 0;
function setup() {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  writeFileSync(join(source, 'test', 'ok.test.mjs'), "if (process.env.FAIL_TESTS) throw new Error('red');\n");
  writeFileSync(join(source, 'tools', 'deploy.sh'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
flock -n "$lock" true && held=no || held=yes
echo "locked=$DEPLOY_LOCKED held=$held" >"$DEPLOY_NOTE"
exit "\${FAKE_DEPLOY_EXIT:-0}"
`);
  chmodSync(join(source, 'tools', 'deploy.sh'), 0o755);
  writeFileSync(join(source, 'a.txt'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'base');
  const live = join(dir, 'live');
  git(dir, 'clone', '-q', source, live);
  const wt = join(dir, 'wt');
  git(source, 'worktree', 'add', '-q', '-b', 'ticket/1-x', wt);
  const run = (extra: Record<string, string> = {}) =>
    // A time limit, so a land.sh whose test run hangs fails this test instead of hanging it (#377).
    spawnSync('bash', [land], { cwd: wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: live, DEPLOY_SOURCE: source, DEPLOY_NOTE: join(dir, 'note'), ...extra } });
  const commit = (where: string, file: string, text: string) => {
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const note = () => (existsSync(join(dir, 'note')) ? readFileSync(join(dir, 'note'), 'utf8').trim() : null);
  return { dir, source, live, wt, run, commit, note };
}

test('rebases onto main, tests, fast-forwards main, and deploys holding the lock', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.source, 'c.txt', 'someone else\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  // The tests ran in a citadel-heavy slot (#325), here the test's own lock folder.
  assert.match(res.stderr, /running the tests \(in a citadel-heavy slot/);
  assert.ok(existsSync(join(env.CITADEL_HEAVY_DIR, 'slot-0')));
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(git(r.source, 'log', '--format=%s', '-3'), 'b.txt: mine\nc.txt: someone else\nbase');
  assert.ok(existsSync(join(r.source, 'b.txt')), "the scheme repo's checkout moves with main");
  assert.equal(r.note(), 'locked=1 held=yes');
});

test('red tests stop it before main moves', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ FAIL_TESTS: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(r.note(), null);
});

// The test run holds the deploy lock, so it must end however a test goes wrong (#377).
test('a red test that leaks a handle ends the run at once instead of holding the lock', () => {
  const r = setup();
  r.commit(r.wt, 'test/ok.test.mjs', "import { test } from 'node:test';\ntest('leaks', () => { setInterval(() => {}, 1000); throw new Error('red'); });\n");
  const main = git(r.source, 'rev-parse', 'main');
  const t = Date.now();
  const res = r.run({ DEPLOY_TEST_TIMEOUT: '60' });
  assert.ok(Date.now() - t < 30_000, `not the whole time limit: ${Date.now() - t} ms`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.doesNotMatch(res.stderr, /ran past/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('a test that hangs is stopped at the time limit, says so, and lets go of the lock', () => {
  const r = setup();
  r.commit(r.wt, 'test/ok.test.mjs', "import { test } from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ DEPLOY_TEST_TIMEOUT: '2' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the tests ran past 2s and were stopped: a test hung/);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'the deploy lock is free');
});

test('a conflict aborts the rebase and lands nothing', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed/);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip, 'the branch is as it was');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('a deploy that fails before going live puts main back', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ FAKE_DEPLOY_EXIT: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /main is back at/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.ok(!existsSync(join(r.source, 'b.txt')));
});

test("refuses uncommitted work, main itself, arguments, running inside a citadel-heavy slot, and a person's container", () => {
  const r = setup();
  writeFileSync(join(r.wt, 'a.txt'), 'dirty\n');
  assert.match(r.run().stderr, /uncommitted changes/);
  git(r.wt, 'checkout', '--', 'a.txt');
  assert.match(spawnSync('bash', [land, '--now'], { cwd: r.wt, encoding: 'utf8', env }).stderr, /takes no arguments/);
  // Under citadel-heavy it would take the deploy lock while holding a slot, the reverse of its own order.
  assert.match(r.run({ CITADEL_HEAVY_HELD: '1' }).stderr, /not under citadel-heavy/);
  // A person's Claude container has no deploy lock or GitHub login: the land tool runs it on the host.
  assert.match(r.run({ COORDINATOR_CONTAINER: '1' }).stderr, /runs in a container: call the land tool/);
  const onMain = spawnSync('bash', [land], { cwd: r.source, encoding: 'utf8', env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source } });
  assert.match(onMain.stderr, /not main/);
});

test('the real deploy.sh takes the lock land.sh holds, and lets go of it once the restart is queued', async () => {
  const r = setup();
  // The real script, a boot check that passes, and stand-ins for systemd: the queued "restart" waits
  // for the lock, then counts as live.
  for (const f of ['deploy.sh', 'run-tests.sh']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "console.log('v1');\n");
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real deploy.sh');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  const base = git(r.source, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const bin = join(r.dir, 'bin');
  const restarted = join(r.dir, 'restarted');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
(flock -w 20 "$lock" true && echo got >${JSON.stringify(restarted)}) >/dev/null 2>&1 &
`);
  for (const f of ['systemctl', 'systemd-run']) chmodSync(join(bin, f), 0o755);
  const server = createServer((_, res) => res.end(JSON.stringify({ ok: true, commit: existsSync(restarted) ? git(r.source, 'rev-parse', 'main') : base })));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const res = await promisify(execFile)('bash', [join(import.meta.dirname, '..', 'tools', 'land.sh')], {
      cwd: r.wt, encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_URL: url, DEPLOY_DB: join(r.dir, 'none.db'), DEPLOY_REMOTE: '' },
    });
    assert.match(res.stderr, /live now: the server restarted on/);
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'));
  } finally {
    server.close();
  }
});
