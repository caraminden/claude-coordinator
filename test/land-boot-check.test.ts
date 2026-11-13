// A boot check that fails, hangs or is stopped, and the rollback after it (#553).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tools, git, until, pipe, land, subjects } from './land-recover-fixture.ts';

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
  assert.match(readFileSync(join(p.state, 'refusing'), 'utf8'), /^\d+ the boot check hung on [0-9a-f]{7,}\n$/, 'the next landing checks before its CI run (#646)');
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base, 'the live checkout is back');
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base, 'main is back');
  assert.ok(p.lockFree(), 'the deploy lock is free');
  // The landing behind meets the same hang before its test run, and is told it is a hang, not a failed check.
  rmSync(gate, { force: true });
  const mark = join(p.dir, 'test-runs');
  const giveUp2 = setTimeout(() => writeFileSync(gate, ''), 30_000);
  const next = await p.run(land, p.wts[0], { BOOT_MARK: join(p.dir, 'boot-started'), BOOT_GATE: gate, DEPLOY_BOOT_TIMEOUT: '2', TEST_MARK: mark });
  clearTimeout(giveUp2);
  assert.equal(next.status, 1, next.stderr);
  assert.match(next.stderr, /the boot check hung on [0-9a-f]{7,} here too \(stopped after 2 s\)/);
  assert.doesNotMatch(next.stderr, /fails the same check/);
  assert.ok(!existsSync(mark), 'no test run was spent on it');
  assert.ok(p.lockFree(), 'the deploy lock is free');
});

// The boot check runs under timeout(1), in a process group of its own, and bash runs a trap only between commands:
// waited on in the foreground, a TERM to the deploy took effect only once the check ended.
test('a deploy stopped with TERM during its boot check stops the check and puts the checkout back at once', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'b.txt', 'innocent\n');
  const mark = join(p.dir, 'boot-started');
  const gate = join(p.dir, 'boot-go');
  const landing = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: gate });
  await until('the boot check to start', () => existsSync(mark));
  const giveUp = setTimeout(() => writeFileSync(gate, ''), 30_000);
  const at = performance.now();
  process.kill(Number(readFileSync(mark, 'utf8')), 'SIGTERM');
  const res = await landing.done; // ends once the boot check has let go of stderr
  clearTimeout(giveUp);
  assert.ok(performance.now() - at < 15_000, `not after the check ended by itself: ${Math.round(performance.now() - at)} ms`);
  assert.notEqual(res.status, 0, res.stderr);
  assert.match(res.stderr, /putting the checkout back/);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base);
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base, 'main is back');
  assert.ok(p.lockFree(), 'the deploy lock is free');
});

// #646: on Nov 13 nine landings each waited in line and for CI, to be refused by a boot check that failed on every commit.
const testRuns = (mark: string) => (existsSync(mark) ? readFileSync(mark, 'utf8').trim().split('\n').length : 0);
test('while the boot check fails on every commit, the next landing is refused before its test run, and the fix lands as usual', { timeout: 300_000 }, async (t) => {
  const p = await pipe(t, 2);
  const broken = join(p.dir, 'box-broken');
  const mark = join(p.dir, 'test-runs');
  const extra = { BOOT_BROKEN: broken, TEST_MARK: mark };
  const refusing = join(p.state, 'refusing');
  writeFileSync(broken, '');
  p.commit(p.wts[0], 'b.txt', 'innocent\n');
  p.commit(p.wts[1], 'c.txt', 'innocent too\n');

  const first = await p.run(land, p.wts[0], extra);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /boot check failed; nothing deployed/);
  assert.doesNotMatch(first.stderr, /deploy has been refusing/, 'the first to meet it finds out at the deploy');
  assert.equal(testRuns(mark), 1);
  const left = readFileSync(refusing, 'utf8');
  assert.match(left, /^\d+ the boot check failed on [0-9a-f]{7,}\n$/);

  const second = await p.run(land, p.wts[1], extra);
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /deploy has been refusing since .*: the boot check failed on [0-9a-f]{7,}, and [0-9a-f]{7,} fails the same check here/);
  assert.match(second.stderr, /no CI run was spent and main is untouched/);
  assert.equal(testRuns(mark), 1, 'no test run was spent on it');
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base);
  assert.ok(p.lockFree(), 'the deploy lock is free');
  assert.equal(readFileSync(refusing, 'utf8'), left, 'the first refusal\'s time stays');

  // Each off switch: the landing finds out at the deploy again, as before.
  const off = await p.run(land, p.wts[1], { ...extra, LAND_PREFLIGHT: '0' });
  assert.equal(off.status, 1, off.stderr);
  assert.doesNotMatch(off.stderr, /deploy has been refusing/);
  assert.match(off.stderr, /boot check failed; nothing deployed/);
  assert.equal(testRuns(mark), 2);
  writeFileSync(join(p.state, 'preflight-off'), '');
  const offFile = await p.run(land, p.wts[1], extra);
  assert.doesNotMatch(offFile.stderr, /deploy has been refusing/);
  assert.equal(testRuns(mark), 3);
  rmSync(join(p.state, 'preflight-off'));
  assert.equal(readFileSync(refusing, 'utf8'), left);

  // The box is fixed: the check passes before CI, the landing goes through and the note goes.
  rmSync(broken);
  const fixed = await p.run(land, p.wts[1], extra);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stderr, /the boot check passes on [0-9a-f]{7,}, so this landing goes on/);
  assert.match(fixed.stderr, /live now: the server restarted on/);
  assert.equal(testRuns(mark), 4);
  assert.ok(!existsSync(refusing), 'a boot check that passed in a deploy removes the note');
  assert.deepEqual(await p.restarts(1), ['0']);

  const after = await p.run(land, p.wts[0], extra);
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stderr, /deploy has been refusing|boot check passes on/, 'with no note, a landing runs no boot check of its own');
});

test('a boot check that failed for one landing\'s own change does not stop the next', { timeout: 200_000 }, async (t) => {
  const p = await pipe(t, 2);
  const mark = join(p.dir, 'test-runs');
  p.commit(p.wts[0], 'BOOT_BAD', 'fails the boot check\n');
  p.commit(p.wts[1], 'c.txt', 'innocent\n');
  const bad = await p.run(land, p.wts[0], { TEST_MARK: mark });
  assert.equal(bad.status, 1, bad.stderr);
  assert.ok(existsSync(join(p.state, 'refusing')));
  const again = await p.run(land, p.wts[0], { TEST_MARK: mark });
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stderr, /deploy has been refusing since/);
  assert.equal(testRuns(mark), 1, 'its own retry is refused before a test run');
  const next = await p.run(land, p.wts[1], { TEST_MARK: mark });
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, /the boot check passes on/);
  assert.ok(!existsSync(join(p.state, 'refusing')));
  assert.equal(git(p.source, 'rev-parse', 'main'), git(p.wts[1], 'rev-parse', 'HEAD'));
});
