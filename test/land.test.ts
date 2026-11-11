import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

// tools/land.sh on throwaway repos: a scheme repo on main, a minion worktree, and a live clone. The
// worktree's tools/deploy.sh is a stand-in that notes whether it got the lock, and fails on request.
const land = join(import.meta.dirname, '..', 'tools', 'land.sh');
const root = mkdtempSync(join(tmpdir(), 'land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make land.sh's own `node --test` report to this runner instead of exiting red;
// COORDINATOR_* would have the real deploy.sh report to the live server; CITADEL_HEAVY_* would queue it in the host's slots;
// DEPLOY_LOCKED and DEPLOY_TESTED, set when a real land runs these tests, would have a test's deploy.sh skip its own lock
// ("flock: 9: Bad file descriptor") or its tests; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope.
const env = { ...process.env, COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: join(root, 'heavy'), DEPLOY_TEST_CPU_WEIGHT: '', DEPLOY_LOCKED: undefined, DEPLOY_TESTED: undefined, DEPLOY_QUEUE_TICKET: undefined, NODE_TEST_CONTEXT: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

let n = 0;
function setup() {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  // TEST_RUNS: a file that gets a line per test run, naming the checkout it ran in.
  writeFileSync(join(source, 'test', 'ok.test.mjs'), "import { appendFileSync } from 'node:fs';\nif (process.env.TEST_RUNS) appendFileSync(process.env.TEST_RUNS, process.cwd() + '\\n');\nif (process.env.FAIL_TESTS) throw new Error('red');\n");
  writeFileSync(join(source, 'tools', 'deploy.sh'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
flock -n "$lock" true && held=no || held=yes
echo "locked=$DEPLOY_LOCKED held=$held" >"$DEPLOY_NOTE"
until [ -z "\${FAKE_DEPLOY_GATE:-}" ] || [ -e "\$FAKE_DEPLOY_GATE" ]; do sleep 0.05; done
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
  assert.match(res.stderr, /running the tests/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(git(r.source, 'log', '--format=%s', '-3'), 'b.txt: mine\nc.txt: someone else\nbase');
  assert.ok(existsSync(join(r.source, 'b.txt')), "the scheme repo's checkout moves with main");
  assert.equal(r.note(), 'locked=1 held=yes');
});

test("a rebase that changes land.sh hands over to the rebased copy, which keeps the lock and lands (#500)", () => {
  const r = setup();
  // The worktree runs its own tools/land.sh, as a minion does; main's newer one says it is the one running.
  for (const f of ['land.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real land.sh');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const script = join(r.source, 'tools', 'land.sh');
  writeFileSync(script, readFileSync(script, 'utf8').replace('say "running the tests"', 'say "running the tests (the rebased land.sh)"'));
  git(r.source, 'commit', '-qam', 'newer land.sh');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running the tests \(the rebased land\.sh\)/);
  assert.equal(res.stderr.match(/rebasing/g)?.length, 1, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes', 'the deploy still runs under the lock');
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

// The tests run from the worktree's top, wherever in it land.sh was started (#468 S10-7).
test('run from a subfolder of the worktree, it tests and lands the same', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  // By a relative path, as a person in the subfolder would type it: its helpers are found all the same.
  const res = spawnSync('bash', [relative(join(r.wt, 'test'), land)], { cwd: join(r.wt, 'test'), encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes');
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

// The one day's folder, whichever UTC day the run fell on.
const landLog = (shared: string) => readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');

test('a conflict is logged to the retro-log with its files, and the refusal names them', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed.*conflicted files: a\.txt\./);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const log = landLog(shared);
  assert.match(log, new RegExp(`^- \\d\\d:\\d\\d:\\d\\dZ · land conflict · ticket/1-x onto ${main.slice(0, 7)}: a\\.txt$`, 'm'));
});

test('a rebase that cannot start logs no conflicted files', () => {
  const r = setup();
  r.commit(r.wt, 'x.txt', 'mine\n');
  writeFileSync(join(r.source, 'c.txt'), 'x\n');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'c');
  // main adds c.txt; an untracked c.txt in the worktree is in the way of the rebase.
  writeFileSync(join(r.wt, 'c.txt'), 'untracked\n');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  const log = landLog(shared);
  assert.match(log, /land conflict · ticket\/1-x: no conflicted files found/m);
});

test('a conflict still refuses the same when there is no shared dir or it cannot be written', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const main = git(r.source, 'rev-parse', 'main');
  const blocker = join(r.dir, 'blocker');
  writeFileSync(blocker, 'a file, not a folder\n');
  for (const shared of ['', blocker]) {
    const res = r.run({ COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rebase onto main failed/);
    assert.equal(git(r.source, 'rev-parse', 'main'), main);
    assert.equal(git(r.wt, 'status', '--porcelain'), '');
  }
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

// Run land.sh in its own process group, so a run that hangs can be stopped with everything it started.
function landAsync(cwd: string, extra: Record<string, string>, limit: number, seen?: (stderr: string) => void): Promise<{ status: number | null; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn('bash', [land], { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => seen?.((stderr += d)));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, limit);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr, ms: Date.now() - t }); });
  });
}

// Other schemes' builds can hold every heavy slot for an hour. A landing that waited for one while
// holding the deploy lock held up every other landing (#499): landings run their tests without one.
test('two landings both land while other jobs hold every heavy slot', async () => {
  const r = setup();
  const wt2 = join(r.dir, 'wt2');
  git(r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-y', wt2);
  r.commit(r.wt, 'b.txt', 'one\n');
  r.commit(wt2, 'c.txt', 'two\n');
  const heavy = join(r.dir, 'heavy');
  mkdirSync(heavy);
  writeFileSync(join(heavy, 'slots'), '1\n');
  // A stand-in for someone's cargo build, holding the only slot until this test stops it.
  const build = spawn('flock', [join(heavy, 'slot-0'), 'sleep', '600'], { detached: true, stdio: 'ignore' });
  try {
    while (spawnSync('flock', ['-n', join(heavy, 'slot-0'), 'true']).status === 0) await new Promise((ok) => setTimeout(ok, 50));
    const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), CITADEL_HEAVY_DIR: heavy };
    const [a, b] = await Promise.all([landAsync(r.wt, extra, 60_000), landAsync(wt2, extra, 60_000)]);
    assert.equal(a.status, 0, `first landing: ${a.stderr}`);
    assert.equal(b.status, 0, `second landing: ${b.stderr}`);
    assert.doesNotMatch(a.stderr + b.stderr, /heavy slots .* busy/, 'neither waited on the build');
    assert.deepEqual(git(r.source, 'log', '--format=%s', 'main').split('\n').sort(), ['b.txt: one', 'base', 'c.txt: two']);
  } finally {
    try { process.kill(-build.pid!, 'SIGKILL'); } catch {}
  }
});

test("refuses uncommitted work, main itself, arguments, running inside a citadel-heavy slot, and a person's container", () => {
  const r = setup();
  writeFileSync(join(r.wt, 'a.txt'), 'dirty\n');
  assert.match(r.run().stderr, /uncommitted changes/);
  git(r.wt, 'checkout', '--', 'a.txt');
  assert.match(spawnSync('bash', [land, '--now'], { cwd: r.wt, encoding: 'utf8', env }).stderr, /takes no arguments/);
  // Under citadel-heavy it would hold a slot other schemes need while it waits on the deploy lock.
  assert.match(r.run({ CITADEL_HEAVY_HELD: '1' }).stderr, /not under citadel-heavy/);
  // A person's Claude container has no deploy lock or GitHub login: the land tool runs it on the host.
  assert.match(r.run({ COORDINATOR_CONTAINER: '1' }).stderr, /runs in a container: call the land tool/);
  const onMain = spawnSync('bash', [land], { cwd: r.source, encoding: 'utf8', env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source } });
  assert.match(onMain.stderr, /not main/);
});

// The real deploy.sh and run-tests.sh on main, a boot check that passes, and stand-ins for systemd: the
// queued "restart" waits for the lock, then counts as live. run() runs a script with them; runs() lists
// where the tests ran.
async function withRealDeploy(body: (r: ReturnType<typeof setup>, run: (script: string, cwd: string, extra?: Record<string, string>) => Promise<{ stderr: string }>, runs: () => string[]) => Promise<void>) {
  const r = setup();
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "console.log('v1');\n");
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real deploy.sh');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  const base = git(r.source, 'rev-parse', 'main');
  const bin = join(r.dir, 'bin');
  const restarted = join(r.dir, 'restarted');
  const testRuns = join(r.dir, 'test-runs');
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
    const run = (script: string, cwd: string, extra: Record<string, string> = {}) => promisify(execFile)('bash', [script], {
      cwd, encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_URL: url, DEPLOY_DB: join(r.dir, 'none.db'), DEPLOY_REMOTE: '', TEST_RUNS: testRuns, ...extra },
    });
    const runs = () => (existsSync(testRuns) ? readFileSync(testRuns, 'utf8').trim().split('\n') : []);
    await body(r, run, runs);
  } finally {
    server.close();
  }
}

test('the real deploy.sh takes the lock land.sh holds, lets go of it once the restart is queued, and skips the tests land.sh just ran', () =>
  withRealDeploy(async (r, run, runs) => {
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = await run(land, r.wt);
    assert.match(res.stderr, /live now: the server restarted on/);
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'));
    assert.match(res.stderr, /skipping the tests: land\.sh just ran them on/);
    assert.deepEqual(runs(), [r.wt], 'the suite ran once, in the worktree');
  }));

test('deploy.sh tests again when a file outside the commit was in the worktree (untracked or ignored) or is in the live checkout', async () => {
  for (const stray of ['wt/scratch.txt', 'wt/notes.ignored', 'live/test/stray.test.mjs']) {
    await withRealDeploy(async (r, run, runs) => {
      r.commit(r.wt, 'b.txt', 'mine\n');
      appendFileSync(join(r.source, '.git', 'info', 'exclude'), '*.ignored\n'); // the worktree shares it
      const [where, file] = stray.split(/\/(.*)/);
      writeFileSync(join(where === 'wt' ? r.wt : r.live, file), '\n');
      const res = await run(land, r.wt);
      assert.match(res.stderr, /live now: the server restarted on/, stray);
      assert.doesNotMatch(res.stderr, /skipping the tests/, stray);
      assert.deepEqual(runs(), [r.wt, r.live], stray);
    });
  }
});

test('deploy.sh on its own, or told of a different tested commit, still runs the tests', async () => {
  for (const tested of [undefined, 'stale']) {
    await withRealDeploy(async (r, run, runs) => {
      r.commit(r.source, 'b.txt', 'theirs\n');
      // A commit land.sh tested that isn't the one the pull lands on (main moved on, or a hand-made deploy).
      const extra = tested ? { DEPLOY_TESTED: git(r.source, 'rev-parse', 'main~1') } : {};
      const res = await run(join(import.meta.dirname, '..', 'tools', 'deploy.sh'), r.source, extra);
      assert.match(res.stderr, /running the tests/);
      assert.doesNotMatch(res.stderr, /skipping the tests/);
      assert.deepEqual(runs(), [r.live]);
      assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.source, 'rev-parse', 'main'));
    });
  }
});

// DEPLOY_LOCKED and DEPLOY_TESTED leaked into a deploy land.sh didn't start (an inherited env, a test run under
// a deploy, a nested run): with no fd 9, or fd 9 on another file, it takes the lock itself and runs the tests (#514).
test('deploy.sh told DEPLOY_LOCKED without the lock on fd 9 takes the lock itself and runs the tests', async () => {
  for (const fd9 of ['', 'exec 9>/dev/null; ']) {
    await withRealDeploy(async (r, run, runs) => {
      r.commit(r.source, 'b.txt', 'theirs\n');
      const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
      mkdirSync(join(lock, '..'), { recursive: true });
      // Someone else holds the lock for a while: the deploy must wait for it rather than go ahead.
      const holder = spawn('flock', [lock, 'sleep', '2'], { stdio: 'ignore' });
      const released = new Promise((ok) => holder.once('exit', ok));
      while (spawnSync('flock', ['-n', lock, 'true']).status === 0) await new Promise((ok) => setTimeout(ok, 20));
      const script = join(r.dir, 'leaky.sh');
      writeFileSync(script, `${fd9}exec bash ${JSON.stringify(join(import.meta.dirname, '..', 'tools', 'deploy.sh'))}\n`);
      let holderDone = false;
      void released.then(() => (holderDone = true));
      const res = await run(script, r.source, { DEPLOY_LOCKED: '1', DEPLOY_TESTED: git(r.source, 'rev-parse', 'main') });
      await released;
      assert.ok(holderDone, `the deploy waited for the lock (fd9: ${fd9 || 'closed'})`);
      assert.match(res.stderr, /taking the lock/, fd9);
      assert.match(res.stderr, /running the tests/, fd9);
      assert.doesNotMatch(res.stderr, /skipping the tests/, fd9);
      assert.deepEqual(runs(), [r.live], fd9);
      assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.source, 'rev-parse', 'main'), fd9);
    });
  }
});

// A person pressing Stop, or a Bash time limit, ends the whole run with a signal (#468 S10-5).
test('a land killed while the deploy tests the live checkout puts the checkout and main back', async () => {
  const r = setup();
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  // Run in the live checkout (the deploy's own test run), it says so and takes a few seconds.
  writeFileSync(join(r.source, 'test', 'slow.test.mjs'), `import { realpathSync, writeFileSync } from 'node:fs';
if (process.env.KILL_MARK && realpathSync(process.cwd()) === realpathSync(process.env.DEPLOY_LIVE)) {
  writeFileSync(process.env.KILL_MARK + '.started', '');
  await new Promise((r) => setTimeout(r, 3000));
  writeFileSync(process.env.KILL_MARK + '.done', '');
}
`);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real deploy.sh');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  const base = git(r.source, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  writeFileSync(join(r.wt, 'scratch.txt'), ''); // a file outside the commit, so the deploy runs its own tests (#500)
  const bin = join(r.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const mark = join(r.dir, 'kill');
  const child = spawn('bash', [land], {
    cwd: r.wt, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_URL: 'http://127.0.0.1:9', DEPLOY_DB: join(r.dir, 'none.db'), DEPLOY_REMOTE: '', KILL_MARK: mark },
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const exited = new Promise((ok) => child.once('exit', ok));
  const until = async (file: string) => {
    for (const end = Date.now() + 60_000; !existsSync(file); await new Promise((ok) => setTimeout(ok, 50))) {
      if (Date.now() > end) throw new Error(`no ${file}:\n${stderr}`);
    }
  };
  await until(`${mark}.started`);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'), 'main had moved');
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'), 'the live checkout had pulled it');
  process.kill(-child.pid!, 'SIGTERM');
  await exited;
  await until(`${mark}.done`); // the test run itself (in a process group of its own) ends by itself
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), base, `the live checkout is back:\n${stderr}`);
  assert.equal(git(r.source, 'rev-parse', 'main'), base, `main is back:\n${stderr}`);
  assert.match(stderr, /putting the checkout back/);
  assert.match(stderr, /main is back at/);
});

// The line for the deploy lock (tools/deploy-queue.sh, #502). The kernel grants a flock in no order, so ten
// landings waiting on it at once (2026-11-10) meant some lost every round and timed out.
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(what: string, cond: () => boolean, ms = 30_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const tickets = (state: string) => (existsSync(join(state, 'queue')) ? readdirSync(join(state, 'queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
const issued = (state: string) => (existsSync(join(state, 'queue', '.seq')) ? Number(readFileSync(join(state, 'queue', '.seq'), 'utf8')) : 0);

test('ten landings started together land in the order they arrived, each told its place in line', async () => {
  const r = setup();
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FAKE_DEPLOY_GATE: join(r.dir, 'gate'), DEPLOY_QUEUE_POLL: '0.05' };
  const wts = [r.wt];
  for (let i = 2; i <= 10; i++) git(r.source, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[wts.push(join(r.dir, `wt${i}`)) - 1]);
  wts.forEach((wt, i) => r.commit(wt, `f${i + 1}.txt`, `${i + 1}\n`));
  const lands: ReturnType<typeof landAsync>[] = [];
  let last = '';
  for (let i = 1; i <= 10; i++) {
    lands.push(landAsync(wts[i - 1], extra, 120_000, (stderr) => i === 10 && (last = stderr)));
    await until(`landing ${i}'s ticket`, () => issued(state) === i); // arrival order is the order of the tickets
  }
  // The first holds the lock until all ten are in line and the last has been told its place.
  await until('the last to say its place', () => /queue: 10th in line for the deploy lock, about 45 min \(ahead: ticket\/1-x, deploying\)/.test(last));
  writeFileSync(join(r.dir, 'gate'), '');
  const done = await Promise.all(lands);
  done.forEach((d, i) => assert.equal(d.status, 0, `landing ${i + 1}: ${d.stderr}`));
  assert.deepEqual(git(r.source, 'log', '--reverse', '--format=%s', 'main').split('\n'), ['base', ...done.map((_, i) => `f${i + 1}.txt: ${i + 1}`)]);
  assert.doesNotMatch(done[0].stderr, /in line/, 'the first had nobody to wait for');
  assert.match(done[9].stderr, /queue: 2nd in line for the deploy lock, about \d+ min \(ahead: ticket\/9-x, /);
  assert.match(done[9].stderr, /queue: got the deploy lock/);
  assert.deepEqual(tickets(state), [], 'every ticket is gone');
  assert.equal(readFileSync(join(state, 'queue', '.took'), 'utf8').trim().split('\n').length, 5, 'the newest five landings were timed, for the estimate');
  assert.equal(spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status, 0, 'the deploy lock is free');
});

// Fake work for the line itself: wait in line, note the turn, then hold the lock while $3 runs.
const queueLib = join(import.meta.dirname, '..', 'tools', 'deploy-queue.sh');
function waiter(state: string, label: string, work: string, extra: Record<string, string> = {}) {
  const child = spawn('bash', ['-c', '. "$0"; queue_lock "$1" "$2" || exit 1; echo "$2" >>"$1/order"; eval "$3"; queue_done ok', queueLib, state, label, work], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, DEPLOY_QUEUE_POLL: '0.05', ...extra } });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const exit = new Promise<number | null>((ok) => child.on('close', ok));
  return { child, exit, stderr: () => stderr };
}
const order = (state: string) => (existsSync(join(state, 'order')) ? readFileSync(join(state, 'order'), 'utf8').trim().split('\n') : []);
const queueState = () => {
  const state = join(root, `queue-${++n}`);
  mkdirSync(state);
  return state;
};

test('a waiter that is killed leaves the line, and the one behind it goes next', async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true');
  await until("b's ticket", () => issued(state) === 2);
  const c = waiter(state, 'c', 'true');
  await until('c to see its place', () => /3rd in line/.test(c.stderr()));
  b.child.kill('SIGKILL');
  await b.exit;
  assert.equal(tickets(state).length, 3, 'a killed waiter leaves its ticket behind');
  await until('c to move up past the dead ticket', () => /2nd in line/.test(c.stderr()));
  assert.equal(tickets(state).length, 2, 'the waiter behind it removed it');
  writeFileSync(join(state, 'go'), '');
  assert.equal(await a.exit, 0);
  assert.equal(await c.exit, 0, c.stderr());
  assert.deepEqual(order(state), ['a', 'c']);
});

test('a holder that is killed leaves the line too, and its lock goes with it', async () => {
  const state = queueState();
  const a = waiter(state, 'a', 'exec sleep 600');
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true');
  await until('b to wait', () => /2nd in line/.test(b.stderr()));
  a.child.kill('SIGKILL');
  assert.equal(await b.exit, 0, b.stderr());
  assert.deepEqual(order(state), ['a', 'b']);
});

test('waiters outlast the stall limit while the holder moves on, and give up once nothing moves', async () => {
  const state = queueState();
  // Three seconds of work in phases, against a two-second limit on no progress (bash counts whole seconds, so it can be a second short).
  const a = waiter(state, 'a', `for i in $(seq 10); do queue_phase "step $i"; sleep 0.3; done; touch '${state}/stuck'; exec sleep 600`);
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '2' });
  const t = Date.now();
  assert.equal(await b.exit, 1, 'it gives up in the end');
  try {
    assert.ok(existsSync(join(state, 'stuck')), `not while the holder was still moving: gave up after ${Date.now() - t} ms\n${b.stderr()}`);
    assert.match(b.stderr(), /2nd in line for the deploy lock, about 5 min \(ahead: a, step 1\)/);
    assert.match(b.stderr(), /nothing has moved for .* \(ahead: a, step 10\), so this gave up/);
    assert.deepEqual(tickets(state).length, 1, 'its ticket went with it');
    assert.deepEqual(order(state), ['a']);
  } finally {
    a.child.kill('SIGKILL');
  }
});

test('the head of the line waits for a lock held outside it (the queued restart), and the estimate comes from past landings', async () => {
  const state = queueState();
  mkdirSync(join(state, 'queue'));
  writeFileSync(join(state, 'queue', '.took'), '100\n140\n');
  const restart = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(state, 'lock')], { stdio: 'ignore' }); // one process, so killing it frees the lock
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    const a = waiter(state, 'a', 'sleep 1.2');
    await until('a to say it waits', () => /next in line for the deploy lock \(ahead: a queued restart/.test(a.stderr()));
    const b = waiter(state, 'b', 'true');
    await until('b to say its place', () => /2nd in line for the deploy lock, about 2 min \(ahead: a, waiting\)/.test(b.stderr()));
    assert.deepEqual(order(state), []);
    restart.kill('SIGKILL');
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(order(state), ['a', 'b']);
    // Each noted how long it held the lock; a held it for a second or two.
    const took = readFileSync(join(state, 'queue', '.took'), 'utf8').trim().split('\n').map(Number);
    assert.equal(took.length, 4);
    assert.ok(took[2] >= 1 && took[2] <= 30, `a's time: ${took[2]}`);
  } finally {
    restart.kill('SIGKILL');
  }
});
