// Part 2 of 2 of the land-train-early tests (#2208); the shared setup is in land-train-early-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ci, git, landAsync } from './land-fixture.ts';
import { line, bad, realOf, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';
import { retro, own, pushLog, pushes, holdOn, refusedBehind, busyCheck, light, heavyCalls, lockHeld } from './land-train-early-setup.ts';

test('early next train: an early run that went red is dropped and runs again on its turn, and the train is bisected as usual (#1366)', async () => {
  const l = await line([{}, {}, {}, {}, { change: ['red.txt', 'red\n'] }], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', FAKE_RED_PATH: 'red.txt' }));
  const done = await l.go();
  assert.match(done[1].stderr, /land: early next train: ticket\/4-x \(with ticket\/5-x riding\) is stacked/);
  assert.match(done[3].stderr, /land: early next train: dropped the early CI run on ticket\/4-x's train \(the early run failed, so it runs again\)/);
  assert.equal(done[4].status, 1, 'ship 5 turned it red');
  for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.deepEqual(retro(l.r.dir, ' · discarded · '), ['early train · ticket/4-x · discarded · the early run failed, so it runs again']);
  assert.equal(git(l.r.dir + '/hub.git', 'for-each-ref', 'refs/heads/early-base/', 'refs/heads/early/', 'refs/heads/land-base/ticket/4-x', 'refs/heads/land/ticket/4-x'), '', 'no scratch branch of it is left on GitHub');
  l.done();
});

test("early next train: a record for a ship that wasn't next is dropped by the next landing to reach its gate (#1366)", async () => {
  const l = await line([{}], shared, (r) => {
    const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'early'), `${git(r.source, 'rev-parse', 'main')} ticket/9-x ${Math.floor(Date.now() / 1000)} ticket/8-x\n`);
  });
  const [d] = await l.go();
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /land: early next train: dropped the early CI run on ticket\/9-x's train \(ticket\/9-x wasn't next in line after all\)/);
  assert.ok(!existsSync(join(l.state, 'early')));
});

test('early next train: with no free runner nothing is pushed early, and with LAND_EARLY=0, <state>/early-off or the CI hold on nothing is tried (#1366, #1902)', async () => {
  // The one runner is online, so each ship's CI waits for its run, but busy (a heavy job holds it), so never free.
  const runners = JSON.stringify({ runners: [{ status: 'online', busy: true, labels: [{ name: 'citadel-ci-linux' }] }] });
  const l = await line(
    [{}, {}, {}, {}, {}],
    (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', FAKE_RUNNERS_FILE: join(d, 'runners') }),
    (r) => writeFileSync(join(r.dir, 'runners'), runners),
  );
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: early next train: no free citadel-ci-linux runner, so ticket\/4-x's CI waits for its turn/);
  assert.doesNotMatch(done[3].stderr, /early next train/);
  assert.deepEqual(retro(l.r.dir, ' · early train · '), []);
  l.done();
  for (const how of ['env', 'file', 'hold'] as const) {
    // With the hold on (#1906) it goes at a deploy alone, and not while another job is on the CI desktop.
    const off = await line([{}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', ...(how === 'env' ? { LAND_EARLY: '0' } : {}), ...(how === 'hold' ? { FAKE_ACTIVE: '1' } : {}) }), how === 'hold' ? holdOn : undefined);
    if (how === 'file') writeFileSync(join(off.state, 'early-off'), '');
    const offDone = await off.go();
    offDone.forEach((d, i) => assert.equal(d.status, 0, `${how}: ship ${i + 1}: ${d.stderr}`));
    const said = offDone.map((d) => d.stderr).join('\n');
    if (how === 'hold') assert.match(said, /early next train: another Citadel job is on the CI desktop or queued, so ticket\/\d-x's CI waits for its turn/);
    assert.doesNotMatch(said, how === 'hold' ? /is stacked on this train's top/ : /early next train/, how);
    assert.deepEqual(retro(off.r.dir, ' · early train · '), [], how);
    off.done();
  }
});

test('with the CI hold on, the next train goes early at the deploy on an idle desktop, and an own check only when nothing else runs (#1906)', async () => {
  const l = await line([{}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }), holdOn);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  const said = done.map((d) => d.stderr).join('\n');
  assert.match(said, /early next train: ticket\/\d-x.* its CI starts now, while this one deploys/);
  assert.doesNotMatch(said, /while this one's CI runs/);
  l.done();
  for (const active of ['0', '1']) {
    const c = await line([{}, {}], (d) => ({ ...own(d), FAKE_ACTIVE: active }), holdOn);
    const ships = await c.go();
    ships.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    if (active === '0') assert.match(ships[1].stderr, /own check: green/);
    else assert.match(ships[1].stderr, /own check: another Citadel job is on the CI desktop or queued, so this joins the line unchecked/);
    c.done();
  }
});

test('own check: green on the check runner, it joins the line and that run is its CI there, with no second run; alone in line, no check (#1567)', async () => {
  const l = await line([{}, {}], own, pushLog);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[0].stderr, /own check/, 'nobody was in line ahead of ship 1');
  assert.match(done[1].stderr, /land: own check: its CI runs now on the check runner, on [0-9a-f]{7,} \(rebased onto main [0-9a-f]{7,}\), before it joins the line/);
  assert.match(done[1].stderr, /land: own check: green in \d+ s \(https:\/\/ci\/\d+\), so it joins the line/);
  const p = pushes(l.r.dir);
  assert.ok(
    p.some((x) => x.endsWith(' refs/heads/check/ticket/2-x') && !/^0+ /.test(x)),
    `check/ticket/2-x pushed: ${p.join('; ')}`,
  );
  assert.ok(!p.some((x) => x.endsWith(' refs/heads/land/ticket/2-x')), `no land run pushed for ship 2: ${p.join('; ')}`);
  assert.ok(!git(join(l.r.dir, 'hub.git'), 'for-each-ref', 'refs/heads/check/', 'refs/heads/check-base/'), 'no check branch is left on GitHub');
  assert.equal(l.runs(), 2, "ship 1's run and ship 2's check, which was its CI in line too");
  assert.deepEqual(
    retro(l.r.dir, 'own check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
    ['own check · ticket/2-x · green · Ns'],
  );
  l.done();
});

// An earlier red check run of the same commit (handed off again unchanged) is no verdict on this one: the check waits
// for the run its own push starts, which GitHub lists a poll or two later.
test("own check: an earlier check run of the same commit is not taken for this one's (#1567)", async () => {
  const l = await line([{}, {}], (d) => ({ ...own(d), FAKE_CHECK_OLD: 'ticket/2-x 3' }));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: own check: green in \d+ s \(https:\/\/ci\/99\), so it joins the line/);
  assert.doesNotMatch(done[1].stderr, /ci\/3\b/);
  l.done();
});

test('own check: a burn-in red is refused before the line, with nobody waiting on it (#1567)', async () => {
  const { l, d } = await refusedBehind(bad(2).change as [string, string], { FAKE_REAL: realOf(2), FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  assert.equal(d.status, 1, d.stderr);
  assert.match(d.stderr, /own check: a new or changed test failed its burn-in in CI on its own check, on its commit rebased onto main \(https:\/\/ci\/\d+\): test\/p2\.test\.ts: failed in 3 of 10 copies at once\. A burn-in red is the ship's own, so it didn't join the line/);
  assert.doesNotMatch(d.stderr, /in line for the deploy lock/);
  assert.ok(!pushes(l.r.dir).some((x) => x.endsWith(' refs/heads/land/ticket/2-x')), 'it never got a run in line');
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1']);
  l.done();
});

test('own check: a file that failed again alone in CI, and here fails with the ship and passes on main, is refused before the line (#1567)', async () => {
  const { l, d } = await refusedBehind(bad(2).change as [string, string], { FAKE_REAL: realOf(2) });
  assert.equal(d.status, 1, d.stderr);
  assert.match(d.stderr, /own check: test\/p2\.test\.ts failed in its own CI run on its commit rebased onto main \(https:\/\/ci\/\d+\), and run alone here fail with this branch and pass on main, so it didn't join the line/);
  assert.match(d.stderr, /citadel-test test\/p2\.test\.ts/);
  assert.deepEqual(
    retro(l.r.dir, 'own check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
    ['own check · ticket/2-x · red: test/p2.test.ts · Ns'],
  );
  l.done();
});

test("own check: a refusal before the line has its timing line and leaves no times file, its own or an old killed landing's (#1864)", async () => {
  const { l, d } = await refusedBehind(bad(2).change as [string, string], { FAKE_REAL: realOf(2) }, (r) => {
    const old = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'times-999999');
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, 'start 1\n');
    utimesSync(old, 1, 1);
  });
  assert.equal(d.status, 1, d.stderr);
  assert.match(retro(l.r.dir, 'timing · ticket/2-x').join('\n'), /^timing · ticket\/2-x · .* · refused at line$/);
  assert.deepEqual(
    readdirSync(l.state).filter((f) => f.startsWith('times-')),
    [],
  );
  l.done();
});

test('own check: a red of flakes alone joins the line, where CI decides (#1567)', async () => {
  const l = await line([{}, { change: ['flaky.txt', 'x\n'] }], (d) => ({ ...own(d), FAKE_FLAKY_PATH: 'flaky.txt', FAKE_LOG: 'flakes' }));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /own check: red, but no test file failed again alone \(https:\/\/ci\/\d+\): flakes or a run cut off, so it joins the line/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'flaky.txt: x']);
  l.done();
});

test('own check: a check runner busy for longer than a ship waits sends it to the line unchecked; with no check runner nothing is tried (#1567)', async () => {
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const l = await line([{}, {}], own, (r) => {
      const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'own-check-run'), `${Math.floor(Date.now() / 1000)} ticket/9-x\n`);
      writeFileSync(join(state, 'own-check-secs'), '1000\n');
      holder = spawn('flock', [join(state, 'own-check.lock'), 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
    });
    await until('the check lock is held', () => spawnSync('flock', ['-n', join(l.state, 'own-check.lock'), 'true']).status === 1);
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    assert.match(done[1].stderr, /own check: ticket\/9-x's check has about 17 min to go, more than the 120 s a ship waits for it, so this one skips its own check/);
    assert.match(done[1].stderr, /light check: CI's side runner isn't registered, so this joins the line unchecked/);
    assert.doesNotMatch(done[1].stderr, /check runner, on/);
    l.done();
  } finally {
    holder?.stdin?.end();
  }
  const off = await line([{}, {}], (d) => ({ ...own(d), FAKE_CHECK_RUNNERS: '0' }));
  const done = await off.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /own check/);
  off.done();
});

test("light check: with the check runner busy, a ship's own tests run on the side runner, on its branch rebased onto main, and green joins the line (#1620)", async () => {
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const l = await line([{}, {}], light, (r) => (holder = busyCheck(r)));
    await until('the check lock is held', () => lockHeld(l.state));
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    assert.match(done[1].stderr, /land: light check: its own and affected test files run now on CI's side runner instead, on [0-9a-f]{7,} \(rebased onto main [0-9a-f]{7,}\)/);
    assert.match(done[1].stderr, /land: light check: green in \d+ s, so it joins the line/);
    const calls = heavyCalls(l.r.dir);
    const got = (k: string) => calls.match(new RegExp(`^${k} (.*)$`, 'm'))?.[1] ?? '';
    assert.equal(got('ship'), '1', 'it skips the wait for ships');
    assert.equal(got('log'), 'f2.txt: 2|f1.txt: 1|base|', 'ship 2 rebased onto ship 1');
    assert.equal(got('args'), `bash tools/light-check-run.sh ${git(l.r.source, 'rev-parse', `${got('head')}^`)}`, 'against main, its base');
    assert.notEqual(got('pwd'), l.wts[1], "in a scratch worktree, not the ship's");
    assert.ok(!existsSync(got('pwd')), 'its scratch worktree is gone');
    assert.deepEqual(
      retro(l.r.dir, 'light check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
      ['light check · ticket/2-x · green · Ns'],
    );
    l.done();
  } finally {
    holder?.stdin?.end();
  }
});

test("light check: a red that is the ship's own is refused before the line, with nobody waiting on it (#1620)", async () => {
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const l = await line(
      [{}],
      (d) => ({ ...light(d), FAKE_LIGHT_OUT: '✖ test/p2.test.ts:3 › breaks\\nlight check: red: test/p2.test.ts, test/p3.test.ts' }),
      (r) => (holder = busyCheck(r)),
    );
    await until('the check lock is held', () => lockHeld(l.state));
    const wt = join(l.r.dir, 'wt2');
    git(l.r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-x', wt);
    l.r.commit(wt, 'f2.txt', '2\n');
    const d = await landAsync(wt, l.env, 150_000, () => {});
    const [first] = await l.go();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(d.status, 1, d.stderr);
    assert.match(d.stderr, /light check: test\/p2\.test\.ts, test\/p3\.test\.ts failed on CI's side runner, on its commit rebased onto main, and run alone there fail with this branch and pass on main \(or are new with it\), so it didn't join the line/);
    assert.match(d.stderr, /citadel-test test\/p2\.test\.ts test\/p3\.test\.ts\)/);
    assert.match(d.stderr, /✖ test\/p2\.test\.ts:3 › breaks/, "the run's output is shown");
    assert.doesNotMatch(d.stderr, /in line for the deploy lock/);
    assert.deepEqual(
      retro(l.r.dir, 'light check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
      ['light check · ticket/2-x · red: test/p2.test.ts, test/p3.test.ts · Ns'],
    );
    assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1']);
    l.done();
  } finally {
    holder?.stdin?.end();
  }
});

test('light check: no verdict joins the line; with no side runner registered, or LAND_LIGHT_CHECK=0, nothing runs (#1620, #2242)', async () => {
  for (const [extra, said, logged] of [
    [{ FAKE_LIGHT_OUT: 'light check: no verdict: test/p2.test.ts passed alone (flakes)' }, /light check: test\/p2\.test\.ts passed alone \(flakes\), so it joins the line, where CI decides/, ['light check · ticket/2-x · no verdict: test/p2.test.ts passed alone (flakes) · Ns']],
    [{ FAKE_LIGHT_OUT: 'citadel-heavy: no runner took it' }, /light check: the run ended without one \(citadel-heavy: no runner took it\), so it joins the line/, ['light check · ticket/2-x · no verdict: the run ended without one (citadel-heavy: no runner took it) · Ns']],
    [{ FAKE_SIDE_RUNNERS: '0' }, null, ['light check · ticket/2-x · skipped: no side runner registered']],
    [{ LAND_LIGHT_CHECK: '0' }, null, []],
  ] as [Record<string, string>, RegExp | null, string[]][]) {
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      const l = await line(
        [{}, {}],
        (d) => ({ ...light(d), ...extra }),
        (r) => (holder = busyCheck(r)),
      );
      await until('the check lock is held', () => lockHeld(l.state));
      const done = await l.go();
      done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
      if (said) assert.match(done[1].stderr, said);
      else assert.equal(heavyCalls(l.r.dir), '', 'no light check ran');
      assert.deepEqual(
        retro(l.r.dir, 'light check · ').map((x) => x.replace(/\d+s$/, 'Ns')),
        logged,
      );
      assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2']);
      l.done();
    } finally {
      holder?.stdin?.end();
    }
  }
});

// #2242: a busy or asleep side runner is waited for, not skipped (the fake heavy-ci's FAKE_QUEUED: its CI queue wait),
// with the wait in the retro line; nothing taking it in the queue limit, or another ship's light check holding the side
// runner past LAND_LIGHT_CHECK_LOCK_WAIT, joins the line unchecked, saying so.
test("light check: a busy side runner or another ship's light check is waited for, the wait in its retro line; nothing taking it joins the line unchecked (#2242)", async () => {
  for (const [extra, hold, said, logged] of [
    [{ FAKE_QUEUED: '14' }, false, /land: light check: green in \d+ s, so it joins the line/, [/^light check · ticket\/2-x · green · \d+s · runner after (1[4-9]|[2-9]\d|\d{3})s$/]],
    [
      { FAKE_NO_RUNNER: 'no runner took it within 360 s (busy with a longer job, or asleep or off), so the CI run is cancelled', LAND_LIGHT_CHECK_LIMIT: '400' },
      false,
      /land: light check: nothing ran on CI \(no runner took it within 360 s \(busy with a longer job, or asleep or off\), so the CI run is cancelled\), so this joins the line unchecked/,
      [/^light check · ticket\/2-x · skipped: nothing ran on CI \(no runner took it within 360 s \(busy with a longer job, or asleep or off\), so the CI run is cancelled\) · \d+s$/],
    ],
    [{ LAND_LIGHT_CHECK_LOCK_WAIT: '1' }, true, /land: light check: another ship's light check held the side runner for [1-9]\d* s, so this joins the line unchecked/, [/^light check · ticket\/2-x · skipped: another ship's light check held the side runner · \d+s$/]],
  ] as [Record<string, string>, boolean, RegExp, RegExp[]][]) {
    let holder: ReturnType<typeof spawn> | undefined;
    let side: ReturnType<typeof spawn> | undefined;
    try {
      const l = await line(
        [{}, {}],
        (d) => ({ ...light(d), ...extra }),
        (r) => {
          holder = busyCheck(r);
          // Another ship's light check, holding the side runner till the end: waited for 1 s (flock -w, not -n), then skipped.
          if (hold) side = spawn('flock', [join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'light-check.lock'), 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
        },
      );
      await until('the check lock is held', () => lockHeld(l.state));
      if (hold) await until('the light check lock is held', () => spawnSync('flock', ['-n', join(l.state, 'light-check.lock'), 'true']).status === 1);
      const done = await l.go();
      done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
      assert.match(done[1].stderr, said);
      const got = retro(l.r.dir, 'light check · ');
      assert.equal(got.length, logged.length, got.join('\n'));
      got.forEach((x, i) => assert.match(x, logged[i]));
      if (extra.LAND_LIGHT_CHECK_LOCK_WAIT) assert.equal(heavyCalls(l.r.dir), '', 'no light check ran');
      else {
        assert.match(heavyCalls(l.r.dir), /^ship 1$/m);
        // The CI queue leaves the run 150 s of the limit: 360 s by default, 250 s of a 400 s limit.
        assert.match(heavyCalls(l.r.dir), extra.LAND_LIGHT_CHECK_LIMIT ? /^queue 250$/m : /^queue 360$/m);
      }
      assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2']);
      l.done();
    } finally {
      holder?.stdin?.end();
      side?.stdin?.end();
    }
  }
});

// #1417: the front's restart held for a starved box (deploy.sh's <state>/hold) tells each rider when it expects to be
// live, and an urgent fix riding the train (the land tool's outage: true) marks that restart to skip the hold.
test('riders of a restart held for a starved box say when it expects to be live; only an urgent rider marks it to skip the hold (#1417)', async () => {
  for (const urgent of [false, true]) {
    const l = await line([{}, { env: { FAKE_NOT_LIVE: '1' } }, { env: urgent ? { LAND_URGENT: '1' } : {} }, {}]);
    writeFileSync(join(l.state, 'hold'), `${Math.floor(Date.now() / 1000) + 600} CPU pressure 63%\n`);
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    for (const i of [3, 4]) assert.match(done[i - 1].stderr, /^deploy: not live yet: the restart ticket\/2-x's ship train queued carries it; the box is starved \(CPU pressure 63%\), so it waits for it to ease, live by about \d\d?:\d\d P[SD]T at the latest/m, `ship ${i}`);
    assert.equal(existsSync(join(l.state, 'urgent')), urgent, urgent ? 'the urgent rider marks the restart' : 'no urgent rider, no mark');
    l.done();
  }
});

// Its restart takes the mark as it starts (#1865): one left later would let the next, unrelated restart skip the hold.
test('an urgent rider marks its restart only while it still waits: for turns, yes; once it is under way or over, no', async () => {
  for (const [at, active, underWay] of [
    ['waiting', true, false],
    ['under way', true, true],
    ['over', false, false],
  ] as const) {
    const l = await line([{}, { env: { FAKE_NOT_LIVE: '1' } }, { env: { LAND_URGENT: '1' } }], {}, (r) => {
      writeFileSync(join(r.dir, 'bin', 'systemctl'), `#!/bin/sh\ncase "$*" in *'is-active -q cc-restart-when-idle'*) exit ${active ? 0 : 3} ;; esac\nexit 1\n`, { mode: 0o755 });
    });
    if (underWay) writeFileSync(join(l.state, 'restart'), `${process.pid} ${readFileSync('/proc/self/stat', 'utf8').split(') ').pop()!.split(' ')[19]}\nrestarting claude-coordinator since 10:00\n`);
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    assert.match(done[2].stderr, /^deploy: not live yet: the restart ticket\/2-x's ship train queued carries it, and reports here too/m);
    assert.equal(existsSync(join(l.state, 'urgent')), at === 'waiting', at);
    l.done();
  }
});
