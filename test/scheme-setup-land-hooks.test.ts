// The scheme-setup template land.sh: the extras Citadel's own land.sh had, as core hooks and settings any scheme can
// turn on (#1322, ADR 0026): GUARD_CMD, land_preflight, land_flaky (the check and CI), land_fallback, LOCK_FILE and
// QUEUE_DIR. Each is off by default, which the template's other tests pin by passing unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ciSetup, git, GREEN, queueSetup, RED, setup, until } from './scheme-setup-land-fixture.ts';

const mainAt = (main: string) => git(main, 'rev-parse', 'main');

test('guards: GUARD_CMD runs on the rebased commit; a failure refuses it, and exit 2 or a timeout does not decide', () => {
  // m.txt is only on main: the guard sees it only on the rebased commit. g holds what the guard does.
  const r = setup('true', {}, `GUARD_CMD='test -e m.txt || exit 9; [ ! -e g ] || case $(cat g) in sleep) sleep 5 ;; *) exit "$(cat g)" ;; esac'\nGUARD_TIMEOUT=1\n`);
  r.commit(r.main, 'm.txt', 'main\n');
  r.commit(r.wt, 'g', '1\n');
  const before = mainAt(r.main);
  const red = r.run();
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stderr, /the guards \(.*\) failed on the rebased branch \(exit 1, full log: .*land-guards-ticket-1-x\.log\), so main is untouched/);
  assert.equal(mainAt(r.main), before);
  assert.equal(git(r.main, 'rev-parse', 'ticket/1-x^'), before, 'the branch keeps the rebased commit, as on a red check');
  r.commit(r.wt, 'g', '2\n');
  const two = r.run();
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stderr, /the guards didn't decide \(exit 2\), so the check decides/);
  r.commit(r.wt, 'g', 'sleep\n');
  const slow = r.run();
  assert.equal(slow.status, 0, slow.stderr);
  assert.match(slow.stderr, /the guards didn't decide \(exit 124, past 1s\), so the check decides/);
});

test('land_preflight gets the rebased commit and its lane before the guards, and refuses it when it fails', () => {
  const r = setup('true', {}, `land_preflight() { echo "$1 $2" >>"$PF_LOG"; [ ! -e pf-red ]; }\nGUARD_CMD='echo guard >>"$PF_LOG"'\n`);
  const log = join(r.dir, 'pf.log');
  r.commit(r.main, 'm.txt', 'main\n');
  r.commit(r.wt, 'pf-red', 'x\n');
  const red = r.run({ PF_LOG: log });
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stderr, /land\.local\.sh's land_preflight refused [0-9a-f]{12} \(exit 1, above\), so main is untouched/);
  const rebased = git(r.main, 'rev-parse', 'ticket/1-x');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`${rebased} full`], 'on the rebased commit, and no guard after a refusal');
  git(r.wt, 'rm', '-q', 'pf-red');
  git(r.wt, 'commit', '-qm', 'fixed');
  const ok = r.run({ PF_LOG: log });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').slice(1), [`${mainAt(r.main)} full`, 'guard']);
});

test('land_flaky: a red check it calls flakes only runs once more and lands on a green run; red twice is refused', () => {
  // The check fails until it has run PASS_AT times, counting in $COUNT.
  const check = 'n=$(cat "$COUNT" 2>/dev/null || echo 0); echo $((n + 1)) >"$COUNT"; [ "$n" -ge "$PASS_AT" ] || { echo "not ok 1 - the flaky one"; exit 1; }';
  const r = setup(check, {}, `land_flaky() { grep -q 'the flaky one' && echo 'test/a.test.ts::the flaky one'; }\n`);
  const count = join(r.dir, 'count');
  r.commit(r.wt, 'b.txt', 'b\n');
  const ok = r.run({ COUNT: count, PASS_AT: '1' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /the check's red was flakes only \(land_flaky: test\/a\.test\.ts::the flaky one\): running it once more/);
  assert.equal(readFileSync(count, 'utf8').trim(), '2');
  r.commit(r.wt, 'c.txt', 'c\n');
  writeFileSync(count, '0\n');
  const red = r.run({ COUNT: count, PASS_AT: '9' });
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stderr, /the check failed on the rebased branch/);
  assert.equal(readFileSync(count, 'utf8').trim(), '2', 'once more, not again and again');
});

test('land_flaky: a red CI run it calls flakes only gets one fresh run; green lands, and a second red is refused', async () => {
  const c = ciSetup(2, { stack: '1', local: `land_flaky() { [ -e "$CI_DIR/flaky" ] && echo 'ci:tests'; }\n` });
  try {
    writeFileSync(join(c.ci, 'flaky'), '');
    const a = c.land(1);
    const ta = await c.tip(a);
    c.verdict(ta, RED, true);
    assert.equal(await c.tip(a, 2), ta, 'the same commit, pushed again');
    assert.match(a.stderr(), /CI's red on [0-9a-f]{12} was flakes only \(land_flaky: ci:tests\): one fresh run/);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.mainAt(), ta);
    const b = c.land(2);
    const tb = await c.tip(b);
    c.verdict(tb, RED, true);
    await c.tip(b, 2);
    c.verdict(tb, RED);
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    assert.equal(c.sent(b).length, 2, 'one fresh run only');
  } finally {
    c.stop();
  }
});

test("land_fallback's pass lands with batches on (the template's default): the head takes its word when CI still has none", async () => {
  const c = ciSetup(1, { stack: '1', batch: 'default', local: 'land_fallback() { return 0; }\n' });
  try {
    const a = c.land(1, { LAND_CI_START: '1' });
    assert.equal(await a.exit, 0, a.stderr());
    assert.match(a.stderr(), /land_fallback passed [0-9a-f]{12} in CI's place/);
    assert.deepEqual(c.landed(), ['f1.txt: 1']);
  } finally {
    c.stop();
  }
});

test('land_fallback decides when CI gives no answer: 0 lands, 75 parks, anything else refuses; it runs on the commit', async () => {
  const c = ciSetup(3, { stack: '1', local: `land_fallback() { echo "$1 $(git rev-parse HEAD)" >>"$CI_DIR/fallback.log"; return "$(cat "$CI_DIR/fallback-rc")"; }\n` });
  try {
    const log = join(c.ci, 'fallback.log');
    writeFileSync(join(c.ci, 'fallback-rc'), '0\n');
    const a = c.land(1, { LAND_CI_START: '1' });
    assert.equal(await a.exit, 0, a.stderr());
    assert.match(a.stderr(), /no runner has started CI on [0-9a-f]{12} within 1 min \(.*\): land\.local\.sh's land_fallback decides in CI's place/);
    assert.match(a.stderr(), /land_fallback passed [0-9a-f]{12} in CI's place/);
    const ta = c.mainAt();
    assert.deepEqual(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.split(' ').map((s) => s.slice(0, 12))),
      [[ta, ta]],
      'given the commit, and sitting on it',
    );
    writeFileSync(join(c.ci, 'fallback-rc'), '1\n');
    const b = c.land(2, { LAND_CI_START: '1' });
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /land\.local\.sh's land_fallback failed on [0-9a-f]{12} in CI's place \(exit 1\) \(above\), so main is untouched/);
    writeFileSync(join(c.ci, 'fallback-rc'), '75\n');
    const d = c.land(3, { LAND_CI_START: '1' });
    assert.equal(await d.exit, 75, d.stderr());
    assert.match(d.stderr(), /land_fallback gave no verdict either \(exit 75\)/);
    assert.equal(c.mainAt(), ta);
  } finally {
    c.stop();
  }
});

test('LOCK_FILE and QUEUE_DIR: a land waits on the lock another script holds there, keeps its place in that folder, then lands', async () => {
  // Citadel's deploy queue shares one lock and line this way. A folder outside the repo, as the deploy queue's is.
  const q = queueSetup(1, 'true', {}, undefined, 'LOCK_FILE="$SHARED/lock"\nQUEUE_DIR="$SHARED/queue"\n');
  const shared = join(q.dir, 'shared');
  mkdirSync(shared);
  // The holder is the process with the lock open itself, so killing it frees the lock (flock's own child would keep it).
  const holder = spawn('bash', ['-c', 'exec 9>"$1"; flock 9; echo held >"$1.held"; exec sleep 600', '-', join(shared, 'lock')], { stdio: 'ignore' });
  try {
    await until('the outside holder takes the lock', () => existsSync(join(shared, 'lock.held')));
    const a = q.land(1, { SHARED: shared });
    await until(`it waits in the shared folder's line: ${a.stderr()}`, () => /queue: .*\(ahead: /.test(a.stderr()) && existsSync(join(shared, 'queue', '.seq')));
    assert.equal(a.child.exitCode, null, a.stderr());
    assert.deepEqual(q.landed(), []);
    assert.ok(!existsSync(join(q.state, 'land-queue')), 'not the default line');
    holder.kill('SIGKILL');
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1']);
  } finally {
    holder.kill('SIGKILL');
  }
});
