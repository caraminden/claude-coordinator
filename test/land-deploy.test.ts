// tools/land.sh with the real tools/deploy.sh.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { land, env, git, setup } from './land-fixture.ts';

// The real deploy.sh and run-tests.sh on main, a boot check that passes, and stand-ins for systemd: the
// queued "restart" waits for the lock, then counts as live and checked (it tags last-good, as the real one does). run() runs a script with them; runs() lists
// where the tests ran.
async function withRealDeploy(body: (r: ReturnType<typeof setup>, run: (script: string, cwd: string, extra?: Record<string, string>) => Promise<{ stderr: string }>, runs: () => string[]) => Promise<void>) {
  const r = setup();
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
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
(flock -w 20 "$lock" true && echo got >${JSON.stringify(restarted)} && git -C "$DEPLOY_LIVE" tag -f last-good HEAD) >/dev/null 2>&1 &
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

// A killed deploy must not leave its test run or boot check holding the lock (ultra review A4), and the boot check
// runs under a name ananicy's node rule doesn't match (A5b).
test("deploy.sh's test run and boot check don't get the deploy lock's fd 9, and the boot check isn't named node", () =>
  withRealDeploy(async (r, run) => {
    const fd9 = join(r.dir, 'fd9');
    writeFileSync(join(r.source, 'tools', 'run-tests.sh'), '#!/usr/bin/env bash\n[ -e /proc/self/fd/9 ] && echo tests open >>"$FD9_NOTE" || echo tests closed >>"$FD9_NOTE"\n');
    // node opens descriptors of its own, so the boot check looks at what its fd 9 is.
    writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "import { appendFileSync, readlinkSync } from 'node:fs';\nimport { basename } from 'node:path';\nlet fd9 = '';\ntry { fd9 = readlinkSync('/proc/self/fd/9'); } catch {}\nappendFileSync(process.env.FD9_NOTE, `boot ${fd9.endsWith('/cc-deploy/lock') ? 'open' : 'closed'} ${basename(process.argv0)}\\n`);\nconsole.log('v1');\n");
    git(r.source, 'commit', '-qam', 'stand-ins that look for fd 9');
    const res = await run(join(import.meta.dirname, '..', 'tools', 'deploy.sh'), r.source, { FD9_NOTE: fd9 });
    assert.match(res.stderr, /live now: the server restarted on/);
    assert.equal(readFileSync(fd9, 'utf8'), 'tests closed\nboot closed citadel-node\n');
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
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
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
