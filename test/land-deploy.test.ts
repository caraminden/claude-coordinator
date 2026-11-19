// tools/land.sh with the real tools/deploy.sh.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { land, env, git, setup } from './land-fixture.ts';
import { until } from './wait.ts';

// The real deploy.sh and run-tests.sh on main, a boot check that passes, and stand-ins for systemd: the
// queued "restart" waits for the lock, then counts as live and checked (it tags last-good, as the real one does). run() runs a script with them; runs() lists
// where the tests ran.
// health: more for /api/health to say, a function asked on each request with whether a SIGHUP came yet (reload: 'sighup'
// has the systemctl stand-in take one, noting it in <dir>/sighups; after it the stand-in reports the live checkout's HEAD,
// as the real server does).
async function withRealDeploy(body: (r: ReturnType<typeof setup>, run: (script: string, cwd: string, extra?: Record<string, string>, args?: string[]) => Promise<{ stderr: string }>, runs: () => string[]) => Promise<void>, health: (hup: boolean) => Record<string, unknown> = () => ({})) {
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
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\ncase "$*" in *' kill -s HUP '*) echo "$*" >>${JSON.stringify(join(r.dir, 'sighups'))}; exit 0 ;; esac\nexit 1\n`);
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/restart.lock
echo "$*" >>${JSON.stringify(join(r.dir, 'systemd-run.args'))}
(flock -w 20 "$lock" true && echo got >${JSON.stringify(restarted)} && git -C "$DEPLOY_LIVE" tag -f last-good HEAD) 7>&- >/dev/null 2>&1 &
`);
  for (const f of ['systemctl', 'systemd-run']) chmodSync(join(bin, f), 0o755);
  const sighups = join(r.dir, 'sighups');
  const server = createServer((_, res) => {
    const hup = existsSync(sighups);
    res.end(JSON.stringify({ ok: true, commit: existsSync(restarted) ? git(r.source, 'rev-parse', 'main') : hup ? git(r.live, 'rev-parse', 'HEAD') : base, ...health(hup) }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const run = (script: string, cwd: string, extra: Record<string, string> = {}, args: string[] = []) => promisify(execFile)('bash', [script, ...args], {
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

// The light lane (#753): a land touching only light paths in tools/lanes runs no tests anywhere, starts no CI, and the
// real deploy.sh skips the boot check and goes live by SIGHUP, with no restart.
let running = '';
// Main gets a map with docs/ light, the server runs it, and the worktree commits a doc.
const lightLand = (r: ReturnType<typeof setup>) => {
  copyFileSync(join(import.meta.dirname, '..', 'tools', 'lane.sh'), join(r.source, 'tools', 'lane.sh'));
  writeFileSync(join(r.source, 'tools', 'lanes'), 'light docs/*\n');
  writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "process.exit(1);\n"); // would refuse, if it ran
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'the map');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  running = git(r.source, 'rev-parse', 'main'); // the server already runs the map's commit, as after its own deploy
  mkdirSync(join(r.wt, 'docs'));
  r.commit(r.wt, 'docs/a.md', 'mine\n');
};
test('a light land runs no tests and no boot check, and goes live without a restart (#753)', () =>
  withRealDeploy(async (r, run, runs) => {
    lightLand(r);
    const res = await run(land, r.wt);
    assert.match(res.stderr, /lane: light \(tools\/lanes; the path that decided it: docs\/a\.md\)/);
    assert.match(res.stderr, /no tests and no CI/);
    assert.doesNotMatch(res.stderr, /CI FALLBACK|running the tests|boot check: the new code/);
    assert.match(res.stderr, /live now: docs and config only, nothing to reload\. No restart\./);
    assert.deepEqual(runs(), [], 'no test ran anywhere');
    assert.equal(readFileSync(join(r.dir, 'sighups'), 'utf8').trim().split('\n').length, 1);
    assert.ok(!existsSync(join(r.dir, 'restarted')), 'no restart was queued');
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'));
  }, (hup) => ({ reload: 'sighup', version: 'v1', ...(running && !hup && { commit: running }) })));

// The front end's version doesn't move on a light change, so only the live commit says the reload took: a server still
// on the old commit after the SIGHUP gets a restart, never a "live now" (#753 review).
test("a light land whose SIGHUP the server doesn't take queues a restart rather than calling it live (#753)", () =>
  withRealDeploy(async (r, run) => {
    lightLand(r);
    const res = await run(land, r.wt);
    assert.match(res.stderr, /the server did not pick up the new commit on SIGHUP; queuing a restart instead/);
    assert.doesNotMatch(res.stderr, /live now: docs and config only/);
    assert.match(res.stderr, /live now: the server restarted on/);
  }, () => ({ reload: 'sighup', version: 'v1', ...(running && { commit: running }) })));

// A killed deploy must not leave its test run or boot check holding the lock (ultra review A4), and the boot check
// runs under a name ananicy's node rule doesn't match (A5b).
test("deploy.sh's test run and boot check don't get the deploy lock's fd 9 or the restart lock's fd 7, and the boot check isn't named node", () =>
  withRealDeploy(async (r, run) => {
    const fd9 = join(r.dir, 'fd9');
    writeFileSync(join(r.source, 'tools', 'run-tests.sh'), '#!/usr/bin/env bash\n{ [ -e /proc/self/fd/9 ] || [ -e /proc/self/fd/7 ]; } && echo tests open >>"$FD9_NOTE" || echo tests closed >>"$FD9_NOTE"\n');
    // node opens descriptors of its own, so the boot check looks at what its fd 9 is.
    writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "import { appendFileSync, readlinkSync } from 'node:fs';\nimport { basename } from 'node:path';\nlet fd9 = '', fd7 = '';\ntry { fd9 = readlinkSync('/proc/self/fd/9'); } catch {}\ntry { fd7 = readlinkSync('/proc/self/fd/7'); } catch {}\nappendFileSync(process.env.FD9_NOTE, `boot ${fd9.endsWith('/cc-deploy/lock') || fd7.endsWith('/cc-deploy/restart.lock') ? 'open' : 'closed'} ${basename(process.argv0)}\\n`);\nconsole.log('v1');\n");
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
  // Run in the live checkout (the deploy's own test run), it says so and waits for the test to write the release file,
  // so a slow box can't finish it before the SIGTERM.
  writeFileSync(join(r.source, 'test', 'slow.test.mjs'), `import { existsSync, realpathSync, writeFileSync } from 'node:fs';
if (process.env.KILL_MARK && realpathSync(process.cwd()) === realpathSync(process.env.DEPLOY_LIVE)) {
  writeFileSync(process.env.KILL_MARK + '.started', '');
  for (const end = Date.now() + 60000; !existsSync(process.env.KILL_MARK + '.release') && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
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
  const reach = (file: string) => until(`${file}`, () => existsSync(file), 60_000, () => stderr);
  await reach(`${mark}.started`);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'), 'main had moved');
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), git(r.wt, 'rev-parse', 'HEAD'), 'the live checkout had pulled it');
  process.kill(-child.pid!, 'SIGTERM');
  await exited;
  writeFileSync(`${mark}.release`, ''); // now the test may finish
  await reach(`${mark}.done`); // the test run itself (in a process group of its own) ends by itself
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), base, `the live checkout is back:\n${stderr}`);
  assert.equal(git(r.source, 'rev-parse', 'main'), base, `main is back:\n${stderr}`);
  assert.match(stderr, /putting the checkout back/);
  assert.match(stderr, /main is back at/);
});

// M10: when systemd-run can't queue the restart, the reporter line stayed for some later restart to post to, and the
// landing said "Read the deploy's output above" instead of what to do.
test("a restart that can't be queued says to run deploy.sh again, and leaves nobody to report to", () =>
  withRealDeploy(async (r, run) => {
    const failing = join(r.dir, 'failing-bin');
    mkdirSync(failing);
    writeFileSync(join(failing, 'systemd-run'), '#!/bin/sh\necho "Failed to start transient service unit: Access denied" >&2\nexit 1\n', { mode: 0o755 });
    r.commit(r.wt, 'b.txt', 'mine\n');
    const err = await run(land, r.wt, { PATH: `${failing}:${join(r.dir, 'bin')}:${process.env.PATH}`, COORDINATOR_TICKET: '7', COORDINATOR_TOKEN: 'tok', COORDINATOR_API: 'http://127.0.0.1:1' }).then(() => assert.fail('the landing should fail'), (e) => e);
    assert.equal(err.code, 1, err.stderr);
    assert.match(err.stderr, /deploy: could not queue the restart \(Failed to start transient service unit: Access denied\), so nothing restarted: the live checkout is at \w+ "b\.txt: mine", but the server still runs \w+\. Run tools\/deploy\.sh again to queue it/);
    assert.match(err.stderr.trimEnd().split('\n').at(-1)!, /land: the deploy failed after main moved; main keeps \w+\. The deploy's lines above say why and what to do$/);
    for (const f of ['reporters', 'reporter-commits']) assert.ok(!existsSync(join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', f)), `no ${f} line left behind`);
  }));

// F12a, in deploy.sh: its test run that can't write its temp file never ran a test.
test("deploy.sh's test run that can't write its temp file says no test ran, and puts the checkout back", () =>
  withRealDeploy(async (r, run, runs) => {
    r.commit(r.source, 'b.txt', 'theirs\n');
    const before = git(r.live, 'rev-parse', 'HEAD');
    const tmp = join(r.dir, 'ro-tmp');
    mkdirSync(tmp, { mode: 0o555 });
    const err = await run(join(import.meta.dirname, '..', 'tools', 'deploy.sh'), r.source, { TMPDIR: tmp }).then(() => assert.fail('the deploy should fail'), (e) => e);
    assert.match(err.stderr, /run-tests: could not make a temp file in \S+ro-tmp/);
    assert.match(err.stderr, /deploy: no test ran: the test run could not write its files \(the run-tests line above says which\); nothing deployed/);
    assert.doesNotMatch(err.stderr, /tests failed/);
    assert.deepEqual(runs(), []);
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), before);
  }));

// Roll back to last green (#1016): deploy.sh --to <commit> boots and restarts an older commit of main with no tests
// (CI passed the full suite on it), leaves main alone, and hands the restart the commit it rolled back from, whose
// healthy restart then holds lands until the fix (tools/deploy.sh restart, test/deploy.test.ts).
test('deploy.sh --to rolls the server back to an older commit of main, with the boot check and no tests, and leaves main alone', () =>
  withRealDeploy(async (r, run, runs) => {
    const deploy = join(import.meta.dirname, '..', 'tools', 'deploy.sh');
    const green = git(r.source, 'rev-parse', 'main');
    mkdirSync(join(r.source, 'src'), { recursive: true });
    r.commit(r.source, 'src/broken.ts', 'throw 1;\n');
    await run(deploy, r.source); // the server runs it now
    const broken = git(r.source, 'rev-parse', 'main');
    r.commit(r.wt, 'mine.txt', 'mine\n');
    const offMain = git(r.wt, 'rev-parse', 'HEAD');
    const refused = await run(deploy, r.source, {}, ['--to', offMain]).then(() => assert.fail('a commit off main should be refused'), (e) => e);
    assert.match(refused.stderr, /isn't on main; nothing changed/);
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), broken);
    const ran = runs().length;
    const res = await run(deploy, r.source, {}, ['--to', green]);
    assert.match(res.stderr, /skipping the tests: [0-9a-f]{7} "real deploy\.sh" is last green/);
    assert.match(res.stderr, /live now: the server restarted on/);
    assert.equal(runs().length, ran, 'no tests ran');
    assert.equal(git(r.live, 'rev-parse', 'HEAD'), green);
    assert.equal(git(r.source, 'rev-parse', 'main'), broken, 'main keeps the broken commit, so the fix lands on top');
    const [plain, rolled] = readFileSync(join(r.dir, 'systemd-run.args'), 'utf8').trim().split('\n');
    assert.match(plain, /--setenv=DEPLOY_PIN= /, 'a plain deploy hands its restart no pin');
    assert.match(rolled, new RegExp(`--setenv=DEPLOY_PIN=${broken} `));
  }));
