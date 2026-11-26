import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, until, pipe, land, subjects, tools } from './land-recover-fixture.ts';

// The restart lock (#566). After a landing queued its restart, that restart and the landing behind it raced for the
// one lock: either the landing behind waited out the settle, or the restart waited out that landing's whole test run
// (284 s on average, 2026-11-11) with the commit on main and not live. Now the restart has a lock of its own: it goes
// at once, the landing behind rebases and tests beside it, and nothing moves main or the checkout until its verdict.
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0);
// Two landings: the second waits in line behind the first. `second` is the second's extra environment.
async function pair(p: Awaited<ReturnType<typeof pipe>>, first: Record<string, string>, second: Record<string, string>) {
  const a = p.start(land, p.wts[0], first);
  await until('the first landing to be in line', () => existsSync(join(p.state, 'queue')) && spawnSync('sh', ['-c', `ls ${JSON.stringify(join(p.state, 'queue'))} | grep -q '^[0-9]'`]).status === 0);
  const b = p.start(land, p.wts[1], second);
  return { a, b };
}

test("the next landing rebases and tests while the restart ahead settles, and the restart doesn't wait for it", { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 2);
  const tipA = p.commit(p.wts[0], 'a.txt', 'first\n');
  p.commit(p.wts[1], 'b.txt', 'second\n');
  const mark = join(p.dir, 'b-tests');
  const gate = join(p.dir, 'b-go');
  const settle = join(p.dir, 'settled');
  const { a, b } = await pair(p, { DEPLOY_SETTLE: '4', SETTLE_GATE: settle }, { TEST_MARK: mark, TEST_GATE: gate });
  await until('the first to move main', () => git(p.source, 'rev-parse', 'main') === tipA);
  const moved = Date.now();
  await until("the second's test run to start", () => lines(mark) === 1, 10_000);
  assert.ok(Date.now() - moved < 10_000);
  assert.equal(p.restartsDone(), 0, "the second's gate runs while the first's restart is still being judged");
  assert.equal(git(p.wts[1], 'merge-base', 'HEAD', tipA), tipA, 'and it runs on the commit the first landed');
  // The second's tests are held: the restart must go ahead and end without them.
  writeFileSync(settle, '');
  assert.deepEqual(await p.restarts(1), ['0']);
  const first = await a.done;
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /live now: the server restarted on/);
  assert.equal(git(p.source, 'rev-parse', 'main'), tipA, 'the second has not moved main');
  writeFileSync(gate, '');
  const second = await b.done;
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /live now: the server restarted on/);
  assert.deepEqual(subjects(p.source), ['b.txt: second', 'a.txt: first', 'base']);
  assert.deepEqual(await p.restarts(2), ['0', '0'], 'each landing has a restart and a verdict of its own');
  assert.ok(p.lockFree() && p.restartLockFree());
});

test('a landing whose gate ends while the restart ahead settles moves neither main nor the checkout until that restart has its verdict', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 2);
  const tipA = p.commit(p.wts[0], 'a.txt', 'first\n');
  p.commit(p.wts[1], 'b.txt', 'second\n');
  // The second's gate is held until the restart has begun: a real gate takes a minute, the stand-in's well under the
  // 2 s the restart looks for busy turns first.
  const gate = join(p.dir, 'b-go');
  const settle = join(p.dir, 'settled');
  const { a, b } = await pair(p, { DEPLOY_SETTLE: '8', SETTLE_GATE: settle }, { TEST_GATE: gate });
  await until('the restart to begin', () => existsSync(join(p.state, 'restart')));
  writeFileSync(gate, '');
  await until('the second to wait for the restart', () => /waiting for the restart ahead/.test(b.stderr()));
  assert.equal(p.restartsDone(), 0);
  assert.equal(git(p.source, 'rev-parse', 'main'), tipA);
  assert.match(spawnSync('sh', ['-c', `cat ${JSON.stringify(join(p.state, 'queue'))}/[0-9]*`], { encoding: 'utf8' }).stdout, /waiting for the restart ahead: restarting citadel-test on .* since/, 'its place in line says so, with what the restart is doing');
  // timing-ok: the time a landing that wrongly went on would have to move main while the restart is still held
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(git(p.source, 'rev-parse', 'main'), tipA, 'still not moved, with the restart held');
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), tipA);
  writeFileSync(settle, '');
  await until('main or the checkout to move', () => git(p.source, 'rev-parse', 'main') !== tipA || git(p.live, 'rev-parse', 'HEAD') !== tipA);
  assert.equal(p.restartsDone(), 1, 'only once the restart ahead had ended');
  assert.equal((await a.done).status, 0);
  const second = await b.done;
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(subjects(p.source), ['b.txt: second', 'a.txt: first', 'base']);
  assert.deepEqual(await p.restarts(2), ['0', '0']);
});

// The landing behind rebased onto a commit that the restart then rolled back. It must not land on top of it as if
// nothing happened, and the gate must pass the commit that does land.
test('when the restart ahead is rolled back, the landing behind rebases without that commit, tests again and lands', { timeout: 200_000 }, async (t) => {
  for (const lander of ['takes its commit off main', 'was killed outright']) {
    const p = await pipe(t, 2);
    const bad = p.commit(p.wts[0], 'RUN_BAD', 'never comes up\n');
    p.commit(p.wts[1], 'b.txt', 'innocent\n');
    const mark = join(p.dir, 'b-tests');
    const gate = join(p.dir, 'b-go');
    // The bad restart goes down only once the second is in its test run, so the roll back can't beat its rebase (#1615).
    const down = join(p.dir, 'bad-go');
    const { a, b } = await pair(p, { RUN_BAD_GATE: down }, { TEST_MARK: mark, TEST_GATE: gate });
    await until("the second's test run to start", () => lines(mark) === 1);
    writeFileSync(down, '');
    assert.equal(git(p.wts[1], 'merge-base', 'HEAD', bad), bad, `${lander}: the second sits on the first's commit`);
    if (lander === 'was killed outright')
      process.kill(a.pid, 'SIGKILL'); // its deploy.sh lives on, and nothing runs main_back
    else assert.match((await a.done).stderr, /main is back at/);
    assert.deepEqual(await p.restarts(1), ['1'], lander);
    writeFileSync(gate, '');
    const second = await b.done;
    assert.equal(second.status, 0, `${lander}:\n${second.stderr}`);
    assert.match(second.stderr, /rebasing .* and testing again/, lander);
    assert.equal(lines(mark), 2, `${lander}: the gate ran again, on the commit that landed`);
    assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'base'], lander);
    assert.equal(git(p.live, 'rev-parse', 'HEAD'), git(p.wts[1], 'rev-parse', 'HEAD'), lander);
    assert.ok(!existsSync(join(p.live, 'RUN_BAD')), lander);
    assert.deepEqual(await p.restarts(2), ['1', '0'], lander);
  }
});

// F1's rule as #553 built it, for the landing that waited: the lander ahead is gone and so is its note, so main keeps
// the commit, and only its fix may land.
test('when the rolled-back commit stays on main, the landing that waited is refused like any other', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 2);
  const bad = p.commit(p.wts[0], 'RUN_BAD', 'never comes up\n');
  p.commit(p.wts[1], 'b.txt', 'innocent\n');
  const mark = join(p.dir, 'b-tests');
  const gate = join(p.dir, 'b-go');
  const down = join(p.dir, 'bad-go'); // as above: no roll back before the second is in its test run
  const { a, b } = await pair(p, { RUN_BAD_GATE: down }, { TEST_MARK: mark, TEST_GATE: gate });
  await until("the second's test run to start", () => lines(mark) === 1);
  writeFileSync(down, '');
  process.kill(a.pid, 'SIGKILL');
  assert.deepEqual(await p.restarts(1), ['1']);
  rmSync(join(p.state, 'moving'), { force: true }); // as after a lander that gave up waiting for a slow restart and left
  writeFileSync(gate, '');
  const second = await b.done;
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /whose deploy was rolled back/);
  assert.equal(git(p.source, 'rev-parse', 'main'), bad, 'main is as it was');
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base);
  assert.equal(p.restartsDone(), 1, 'nothing more restarted');
});

// A branch left sitting on the rolled-back commit (its own gate was red, or its second rebase hit a conflict) would
// carry that commit back onto main the next time it landed.
test("a branch that was rebased onto a commit since taken off main lands without it; the commit's own branch keeps it", { timeout: 200_000 }, async (t) => {
  const p = await pipe(t, 2);
  p.commit(p.wts[0], 'RUN_BAD', 'never comes up\n');
  p.commit(p.wts[1], 'b.txt', 'innocent\n');
  const { a, b } = await pair(p, {}, { TEST_FAIL: '1' });
  const red = await b.done;
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stderr, /tests failed on the rebased branch/);
  assert.match((await a.done).stderr, /main is back at/);
  assert.deepEqual(await p.restarts(1), ['1']);
  assert.ok(existsSync(join(p.wts[1], 'RUN_BAD')), 'the red branch still sits on the commit that came off main');

  const again = await p.run(land, p.wts[1]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /came off main .* leaving it behind/);
  assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'base']);
  assert.deepEqual(await p.restarts(2), ['1', '0']);

  git(p.wts[0], 'rm', '-q', 'RUN_BAD');
  git(p.wts[0], 'commit', '-qm', 'the fix');
  const fixed = await p.run(land, p.wts[0]);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(subjects(p.source), ['the fix', 'RUN_BAD: never comes up', 'b.txt: innocent', 'base'], 'its own branch lands whole');
});

test('a landing killed while it overlaps the restart ahead leaves main, the checkout and both locks clean', { timeout: 300_000 }, async (t) => {
  for (const where of ['in its gate', 'waiting for the restart']) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const what = `${where}, ${signal}`;
      const p = await pipe(t, 2);
      const tipA = p.commit(p.wts[0], 'a.txt', 'first\n');
      p.commit(p.wts[1], 'b.txt', 'second\n');
      const mark = join(p.dir, 'b-tests');
      const gate = join(p.dir, 'b-go');
      const settle = join(p.dir, 'settled');
      const { a, b } = await pair(p, { DEPLOY_SETTLE: '6', SETTLE_GATE: settle }, { TEST_MARK: mark, TEST_GATE: gate });
      await until("the second's test run to start", () => lines(mark) === 1);
      if (where === 'waiting for the restart') {
        await until('the restart to begin', () => existsSync(join(p.state, 'restart')));
        writeFileSync(gate, '');
        await until('the second to wait for the restart', () => /waiting for the restart ahead/.test(b.stderr()));
      }
      assert.equal(p.restartsDone(), 0, what);
      process.kill(-b.pid, signal);
      await b.done;
      // Its test run sits under timeout's own process group, which the kill doesn't reach: let it end, or it waits out its
      // 120 s limit after this file is done (a leak the faster fixture of #1615 left in sight).
      writeFileSync(gate, '');
      assert.equal(p.restartsDone(), 0, `${what}: the restart ahead was still unjudged when the landing died`);
      writeFileSync(settle, '');
      assert.equal((await a.done).status, 0, what);
      assert.deepEqual(await p.restarts(1), ['0'], what);
      assert.equal(git(p.source, 'rev-parse', 'main'), tipA, what);
      assert.equal(git(p.live, 'rev-parse', 'HEAD'), tipA, what);
      await until('both locks to be free', () => p.lockFree() && p.restartLockFree());
      const next = await p.run(land, p.wts[1]);
      assert.equal(next.status, 0, `${what}: the next landing lands:\n${next.stderr}`);
      assert.deepEqual(subjects(p.source), ['b.txt: second', 'a.txt: first', 'base'], what);
    }
  }
});

test('a restart lock that is not let go within the limit refuses loudly with main untouched, and a deploy by hand waits for it too', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'b.txt', 'mine\n');
  mkdirSync(p.state, { recursive: true });
  const holder = spawn('bash', ['-c', 'exec 7>"$0"; flock 7; exec sleep 600', join(p.state, 'restart.lock')], { stdio: 'ignore' }); // one process, so killing it frees the lock
  t.after(() => holder.kill('SIGKILL'));
  await until('the restart lock to be held', () => !p.restartLockFree());
  const res = await p.run(land, p.wts[0], { DEPLOY_RESTART_WAIT: '3' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /the restart lock .* has not been let go for 3 s/);
  assert.match(res.stderr, /nothing landed/);
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base);
  assert.ok(p.lockFree());

  const tip = p.commit(p.source, 'c.txt', 'by hand\n');
  const deploy = p.start(join(tools, 'deploy.sh'), p.source);
  await until('the deploy to wait for the restart', () => /waiting for the restart ahead/.test(deploy.stderr()));
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base, 'it has not pulled');
  holder.kill('SIGKILL');
  const done = await deploy.done;
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), tip);
});

// Review of #566: the recovery at the start of a landing ran under the deploy lock alone, which the restart no longer holds.
test("a landing doesn't put a killed deploy's checkout back under a restart that is still being judged on it", { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'b.txt', 'mine\n');
  // A deploy was killed after its pull; a restart queued before it then restarted on that commit, and holds its lock.
  const pulled = p.commit(p.live, 'x.txt', 'unchecked\n');
  mkdirSync(p.state, { recursive: true });
  writeFileSync(join(p.state, 'unchecked'), `${p.base}\n`);
  const restart = spawn('flock', ['-o', join(p.state, 'restart.lock'), 'sleep', '60'], { stdio: 'ignore' });
  t.after(() => restart.kill());
  await until('the restart to hold its lock', () => !p.restartLockFree());
  const mark = join(p.dir, 'tests');
  const gate = join(p.dir, 'go');
  const landing = p.start(land, p.wts[0], { TEST_MARK: mark, TEST_GATE: gate });
  await until('the test run to start', () => lines(mark) === 1);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), pulled, `the checkout is as the restart found it:\n${landing.stderr()}`);
  writeFileSync(gate, '');
  await until('the landing to wait for the restart', () => /waiting for the restart ahead/.test(landing.stderr()));
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), pulled);
  restart.kill();
  const res = await landing.done;
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /an earlier deploy was killed before its checks ended; putting the live checkout back/);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), git(p.source, 'rev-parse', 'main'));
  assert.deepEqual(subjects(p.source), ['b.txt: mine', 'base']);
  await p.restarts(1);
  assert.ok(p.lockFree() && p.restartLockFree());
});
