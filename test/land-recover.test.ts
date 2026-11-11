import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// A bad commit can't stay on main (#553, the pipeline failure drill): the real land.sh and deploy.sh on a throwaway
// pipeline, with a boot check and a service that fail on request, and a queued restart that really runs
// `deploy.sh restart`. A checkout holding BOOT_BAD fails the boot check; one holding RUN_BAD never comes up.
const tools = join(import.meta.dirname, '..', 'tools');
const root = mkdtempSync(join(tmpdir(), 'land-recover-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined,
  NODE_TEST_CONTEXT: undefined, DEPLOY_TEST_CPU_WEIGHT: '', LAND_CI: '0', LAND_FIX: undefined, DEPLOY_REMOTE: '', DEPLOY_NOW: undefined,
  DEPLOY_HEALTHY_WAIT: '2', DEPLOY_SETTLE: '1', DEPLOY_QUEUE_STALL: '120', DEPLOY_QUEUE_POLL: '1', DEPLOY_IDLE_TRIES: '30', DEPLOY_TEST_TIMEOUT: '120', DEPLOY_BACKUPS: '3',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(what: string, cond: () => boolean, ms = 60_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(50)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

let n = 0;
async function pipe(t: { after: (fn: () => void) => void }, worktrees: number) {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  for (const f of ['land.sh', 'deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(tools, f), join(source, 'tools', f));
  writeFileSync(join(source, 'test', 'ok.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
  // BOOT_MARK: say it started (with its parent's pid) and wait for BOOT_GATE, so a test can kill the deploy mid-check.
  writeFileSync(join(source, 'tools', 'boot-check.ts'), `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { BOOT_MARK: mark, BOOT_GATE: gate } = process.env;
if (mark) {
  writeFileSync(mark, String(process.ppid));
  while (gate && !existsSync(gate)) await new Promise((r) => setTimeout(r, 50));
}
if (existsSync(join(process.argv[2], 'BOOT_BAD'))) process.exit(1);
console.log('v1');
`);
  writeFileSync(join(source, 'a.txt'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'main');
  const live = join(dir, 'live');
  git(dir, 'clone', '-q', source, live);
  git(live, 'tag', 'last-good');
  const wts = Array.from({ length: worktrees }, (_, i) => {
    const wt = join(dir, `wt${i + 1}`);
    git(source, 'worktree', 'add', '-q', '-b', `ticket/${i + 1}-x`, wt);
    return wt;
  });
  const running = join(dir, 'running'); // the commit the "server" runs; empty when it is down
  writeFileSync(running, base);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
for a; do case $a in
  restart) if [ -e "$DEPLOY_LIVE/RUN_BAD" ]; then : >"$PIPE/running"; else git -C "$DEPLOY_LIVE" rev-parse HEAD >"$PIPE/running"; fi; exit 0 ;;
  show) echo 100; exit 0 ;;
esac; done
exit 0
`, { mode: 0o755 });
  // The queued restart: the real \`deploy.sh restart\`, in the background, with what the unit would be given.
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
while [ $# -gt 0 ] && [ "$1" != bash ]; do case $1 in --setenv=*) export "\${1#--setenv=}" ;; esac; shift; done
unset DEPLOY_LOCKED DEPLOY_TESTED DEPLOY_QUEUE_TICKET
("$@" >>"$PIPE/restart.log" 2>&1; echo $? >>"$PIPE/restart.done") 9>&- </dev/null >/dev/null 2>&1 &
`, { mode: 0o755 });
  const server = createServer((_, res) => {
    const commit = readFileSync(running, 'utf8').trim();
    if (!commit) { res.statusCode = 503; res.end(); return; }
    // An "interruptible" file: how many running turns a restart would cut off.
    const busy = join(dir, 'interruptible');
    res.end(JSON.stringify({ ok: true, commit, interruptible: existsSync(busy) ? Number(readFileSync(busy, 'utf8')) : 0 }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const penv = { ...env, PATH: `${bin}:${process.env.PATH}`, PIPE: dir, DEPLOY_LIVE: live, DEPLOY_SOURCE: source, DEPLOY_URL: `http://127.0.0.1:${(server.address() as any).port}`, DEPLOY_DB: join(dir, 'none.db'), DEPLOY_SERVICE: 'citadel-test', DEPLOY_UNIT: 'citadel-test-restart' };
  const state = join(git(live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  return {
    dir, source, live, wts, base, state,
    commit(where: string, file: string, text: string) {
      writeFileSync(join(where, file), text);
      git(where, 'add', '-A');
      git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
      return git(where, 'rev-parse', 'HEAD');
    },
    // Never spawnSync: the stand-in server above answers from this process. In its own process group, so a test can
    // kill the landing alone or with everything it started.
    start(script: string, cwd: string, extra: Record<string, string> = {}) {
      const child = spawn('bash', [script], { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...penv, ...extra } });
      let stderr = '';
      child.stderr!.on('data', (d) => (stderr += d));
      const done = new Promise<{ status: number | null; stderr: string }>((ok) => child.once('close', (status) => ok({ status, stderr })));
      return { pid: child.pid!, done };
    },
    run(script: string, cwd: string, extra: Record<string, string> = {}) { return this.start(script, cwd, extra).done; },
    lockFree: () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status === 0,
    // Every queued restart runs on after the deploy that queued it: wait for the k-th to end. Its exit codes so far.
    async restarts(k: number) {
      const done = join(dir, 'restart.done');
      const codes = () => (existsSync(done) ? readFileSync(done, 'utf8').trim().split('\n') : []);
      await until(`restart ${k} to end`, () => codes().length >= k);
      return codes();
    },
    restartLog: () => (existsSync(join(dir, 'restart.log')) ? readFileSync(join(dir, 'restart.log'), 'utf8') : ''),
  };
}
const land = join(tools, 'land.sh');
const subjects = (dir: string) => git(dir, 'log', '--format=%s', 'main').split('\n');

// The drill's worst (F2): with land.sh gone nothing put main back, and every later landing failed its own boot
// check on the stranded commit and was told to fix its own change.
test('a landing killed outright while its deploy checks a commit that breaks the boot does not leave that commit on main', { timeout: 300_000 }, async (t) => {
  for (const scope of ['land.sh alone', 'its whole process group']) {
    const p = await pipe(t, 2);
    const bad = p.commit(p.wts[0], 'BOOT_BAD', 'breaks the boot\n');
    p.commit(p.wts[1], 'b.txt', 'innocent\n');
    const mark = join(p.dir, 'boot-started');
    const gate = join(p.dir, 'boot-go');
    const first = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: gate });
    await until('the boot check to start', () => existsSync(mark));
    process.kill(scope === 'land.sh alone' ? first.pid : -first.pid, 'SIGKILL');
    writeFileSync(gate, ''); // an orphaned deploy.sh goes on, fails its boot check and puts the checkout back
    await first.done; // ends once that orphan has let go of stderr
    await until('the lock to be free', p.lockFree);
    assert.equal(git(p.source, 'rev-parse', 'main'), bad, `${scope}: the killed landing had moved main`);

    const res = await p.run(land, p.wts[1]);
    assert.equal(res.status, 0, `${scope}: the next landing lands:\n${res.stderr}`);
    assert.match(res.stderr, /an earlier landing was killed .* main is back at/, scope);
    assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'base'], `${scope}: main holds the innocent change and not the one that breaks the boot`);
    assert.equal(git(p.live, 'rev-parse', 'HEAD'), git(p.wts[1], 'rev-parse', 'HEAD'), scope);
    assert.deepEqual(await p.restarts(1), ['0'], scope);
  }
});

// Review of the fix: a restart queued by an earlier deploy restarts on whatever the checkout holds, the killed one's
// commit included. Once it has come up healthy there (last-good), taking that commit away would undo a live deploy.
test('a killed landing whose commit an earlier queued restart has since made live keeps the checkout and main', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 2);
  const tip = p.commit(p.wts[0], 'a.txt', 'first\n');
  p.commit(p.wts[1], 'b.txt', 'innocent\n');
  const mark = join(p.dir, 'boot-started');
  const first = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: join(p.dir, 'boot-go') });
  await until('the boot check to start', () => existsSync(mark));
  process.kill(-first.pid, 'SIGKILL');
  await first.done;
  await until('the lock to be free', p.lockFree);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), tip, 'the killed deploy had pulled it');
  git(p.live, 'tag', '-f', 'last-good', tip); // what that restart does once the server stays healthy on it

  const res = await p.run(land, p.wts[1]);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /was killed/);
  assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'a.txt: first', 'base']);
  assert.deepEqual(await p.restarts(1), ['0']);
});

// F9: the pull comes before the checks, and only a trap undid it. main_back took "the live checkout has it" for "deployed".
test('a deploy killed outright before its checks end leaves neither the live checkout nor main on the unchecked commit', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'b.txt', 'mine\n');
  const mark = join(p.dir, 'boot-started');
  const gate = join(p.dir, 'boot-go');
  const landing = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: gate });
  await until('the boot check to start', () => existsSync(mark));
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), git(p.wts[0], 'rev-parse', 'HEAD'), 'the live checkout had pulled it');
  // deploy.sh and any subshell of it between the boot check and land.sh.
  for (let pid = Number(readFileSync(mark, 'utf8')); ; ) {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('deploy.sh')) break;
    const parent = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1]);
    process.kill(pid, 'SIGKILL');
    pid = parent;
  }
  writeFileSync(gate, '');
  const res = await landing.done;
  assert.equal(res.status, 1, res.stderr);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base, `the live checkout is back:\n${res.stderr}`);
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base, `main is back:\n${res.stderr}`);
  assert.match(res.stderr, /main is back at/);
  await until('the lock to be free', p.lockFree);
});

// F1: land.sh said "landed" (or "live now") and left before the restart's own check could fail.
test('a landing whose restart is rolled back says so, fails, and takes its commit off main', { timeout: 200_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'RUN_BAD', 'never comes up\n');
  const res = await p.run(land, p.wts[0]);
  assert.deepEqual(await p.restarts(1), ['1']);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /was rolled back/);
  assert.doesNotMatch(res.stderr, /live now|not live yet/);
  assert.match(res.stderr, /main is back at/);
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base);
});

// F1, when the commit stays on main (a deploy by hand, or others landed on top before the rollback): every later
// landing pulled it back in, was rolled back and was told its own commit had failed.
test('while main holds a commit whose deploy was rolled back, only a landing that touches what it changed (or says LAND_FIX=1) goes ahead', { timeout: 400_000 }, async (t) => {
  const p = await pipe(t, 2);
  const bad = p.commit(p.source, 'RUN_BAD', 'never comes up\n');
  const first = await p.run(join(tools, 'deploy.sh'), p.source);
  assert.deepEqual(await p.restarts(1), ['1']);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /was rolled back/);
  assert.equal(git(p.source, 'rev-parse', 'main'), bad, 'a deploy by hand leaves main alone');

  p.commit(p.wts[0], 'b.txt', 'innocent\n');
  const before = p.restartLog();
  assert.match(before, /restarting citadel-test/);
  const refused = await p.run(land, p.wts[0]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, new RegExp(`main holds ${bad.slice(0, 7)} "RUN_BAD: never comes up", whose deploy was rolled back`));
  assert.match(refused.stderr, /LAND_FIX=1/);
  assert.equal(git(p.source, 'rev-parse', 'main'), bad);
  assert.equal(p.restartLog(), before, 'nothing was deployed: no restart ran');

  const forced = await p.run(land, p.wts[0], { LAND_FIX: '1' });
  assert.doesNotMatch(forced.stderr, /whose deploy was rolled back/);
  assert.deepEqual(await p.restarts(2), ['1', '1'], 'it went ahead, and was rolled back like the first');
  assert.equal(git(p.source, 'rev-parse', 'main'), bad, forced.stderr);
  assert.match((await p.run(land, p.wts[0])).stderr, /whose deploy was rolled back/, 'main still holds the first one, so the next is still refused');

  git(p.wts[1], 'rebase', '-q', 'main');
  git(p.wts[1], 'rm', '-q', 'RUN_BAD');
  git(p.wts[1], 'commit', '-qm', 'the fix');
  const fix = await p.run(land, p.wts[1]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.stderr, /nothing to deploy: the server already runs/, 'a plain revert leaves the server on the code it runs');

  const later = await p.run(land, p.wts[0]);
  assert.equal(later.status, 0, `once the fix is on main, anything lands again:\n${later.stderr}`);
  assert.match(later.stderr, /live now: the server restarted on/);
  assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'the fix', 'RUN_BAD: never comes up', 'base']);
  assert.deepEqual(await p.restarts(3), ['1', '1', '0']);
});

// F5: boot-check.ts's own backstop is a timer a blocking call defeats; nothing outside bounded it, so the lock
// stayed held until a person killed it.
test('a boot check that never returns is stopped at its time limit, called a hang, and lets go of the lock', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'b.txt', 'innocent\n');
  const gate = join(p.dir, 'boot-go');
  const giveUp = setTimeout(() => writeFileSync(gate, ''), 30_000); // so a missing limit fails this test instead of hanging it
  const res = await p.run(land, p.wts[0], { BOOT_MARK: join(p.dir, 'boot-started'), BOOT_GATE: gate, DEPLOY_BOOT_TIMEOUT: '2' });
  clearTimeout(giveUp);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /the boot check hung: stopped after 2 s/);
  assert.doesNotMatch(res.stderr, /boot check failed/, 'a hang is not a verdict on the change');
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base, 'the live checkout is back');
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base, 'main is back');
  assert.ok(p.lockFree(), 'the deploy lock is free');
});

// F6: the landing said only "not live yet", then nothing for up to 2 h.
test('a restart waiting on running turns says so to the landing: how many, for how long at most, and how to skip the wait', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  const tip = p.commit(p.wts[0], 'b.txt', 'innocent\n');
  writeFileSync(join(p.dir, 'interruptible'), '1');
  t.after(() => writeFileSync(join(p.dir, 'interruptible'), '0')); // a failed test leaves no restart waiting
  const res = await p.run(land, p.wts[0], { DEPLOY_IDLE_POLL: '0.2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /not live yet: the restart is waiting for 1 running turn a restart would cut off to finish \(at most \d+ min more\).*tools\/deploy\.sh --now/);
  assert.match(p.restartLog(), /waiting for 1 running turn a restart would cut off/, 'the restart says so in its own log too');
  writeFileSync(join(p.dir, 'interruptible'), '0');
  assert.deepEqual(await p.restarts(1), ['0']);
  assert.equal(git(p.live, 'rev-parse', 'last-good'), tip);
});
