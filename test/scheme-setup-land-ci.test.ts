// The scheme-setup template land.sh: the CI gate and the stack.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, landLockFree, sleep, until, queueSetup, timingLines, ciSetup, rebasedHook, GREEN, RED, LOST } from './scheme-setup-land-fixture.ts';

test('CI gate: the commit goes to a scratch branch, and lands only once CI passed exactly that commit', async () => {
  const c = ciSetup(1, { stack: '1' });
  try {
    c.commit(c.main, 'c.txt', 'someone else\n');
    const before = c.mainAt();
    const a = c.land(1);
    const sha = await c.tip(a);
    assert.equal(c.parent(sha), before, 'it was rebased onto main');
    assert.deepEqual(c.scratch(), [`land/ticket/1-x ${sha}`]);
    c.verdict(git(c.wt, 'rev-parse', 'ticket/1-x').slice(0, 12), GREEN); // green on the branch as it was: another commit
    await sleep(400);
    assert.equal(c.mainAt(), before, 'a green run of another commit lands nothing');
    assert.equal(c.on(1), '', 'the worktree waits on the detached commit');
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.mainAt(), sha);
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), sha);
    assert.deepEqual(c.scratch(), [], 'the scratch branch is gone');
    assert.equal(c.on(1), 'ticket/1-x');
    assert.equal(git(c.wt, 'rev-parse', 'HEAD').slice(0, 12), sha, 'the branch is at what landed');
    assert.ok(landLockFree(c));
  } finally {
    c.stop();
  }
});

test('CI gate: red CI refuses with main untouched; no runner within the limit parks with exit 75', async () => {
  const c = ciSetup(2, { stack: '1' });
  try {
    const before = c.mainAt();
    const a = c.land(1);
    c.verdict(await c.tip(a), RED);
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    const b = c.land(2, { LAND_CI_START: '1' });
    assert.equal(await b.exit, 75, b.stderr());
    assert.match(b.stderr(), /no runner has started CI on [0-9a-f]{12} within 1 min .* nothing landed\. Park/);
    assert.equal(c.mainAt(), before);
    assert.deepEqual(c.scratch(), []);
    assert.deepEqual([c.on(1), c.on(2)], ['ticket/1-x', 'ticket/2-x']);
    assert.deepEqual(c.tickets(), []);
    // A run that never ends parks too. LAND_CI_DOWN=0: b's park left a note that would skip the wait.
    const again = c.land(2, { LAND_CI_TIMEOUT: '1', LAND_CI_DOWN: '0' });
    c.verdict(await c.tip(again), 2);
    assert.equal(await again.exit, 75, again.stderr());
    assert.match(again.stderr(), /hasn't finished within 1 min/);
    assert.equal(spawnSync('bash', [join(c.wt, 'tools', 'land.sh')], { cwd: c.wt, encoding: 'utf8', env: { ...env, LAND_CI_START: 'soon' } }).stderr.trim(), 'land: LAND_CI_START is in whole seconds, not "soon"');
  } finally {
    c.stop();
  }
});

// Citadel's pipeline failure drill, F11 (#553): with CI stuck, every landing in line waited out the same limit to learn
// the same thing.
test('CI gate: after a landing parked on a CI limit, those of the next minutes park at once and say why; a run already going is waited for, and green clears it', async () => {
  const c = ciSetup(2, { stack: '1' });
  const down = join(c.state, 'ci-down');
  try {
    const a = c.land(1, { LAND_CI_START: '1' });
    assert.equal(await a.exit, 75, a.stderr());
    assert.ok(existsSync(down), 'the landing that waited out the limit leaves a note');
    const b = c.land(2, { LAND_CI_START: '20' });
    assert.equal(await b.exit, 75, b.stderr());
    assert.match(b.stderr(), /CI gave no answer to a landing \d+ s ago \(no runner started CI on [0-9a-f]{12} within 1 min\), so this one doesn't wait for it and nothing landed; CI is asked again from \d\d:\d\d\. Park/);
    assert.doesNotMatch(b.stderr(), /no runner has started CI/);
    assert.deepEqual(c.tickets(), []);
    // A run that a runner has taken is no outage: it is waited for, and its green takes the note away.
    const sha = git(c.wts[1], 'rev-parse', 'HEAD').slice(0, 12); // main hasn't moved, so this is the commit CI gets
    c.verdict(sha, 2);
    const again = c.land(2, { LAND_CI_START: '1' });
    await until('it to see the run going', () => /CI is already running on/.test(again.stderr()));
    await sleep(1500);
    assert.equal(again.child.exitCode, null, again.stderr());
    c.verdict(sha, GREEN);
    assert.equal(await again.exit, 0, again.stderr());
    assert.ok(!existsSync(down), 'a green run takes the note away');
    assert.deepEqual(c.landed(), ['f2.txt: 2']);
  } finally {
    c.stop();
  }
});

// Review of the above: under a fresh note the head parked on its first look after its own push, before GitHub could hand
// the run to a runner, and on a red or lost verdict that CI_GRACE shows as "not started", calling either a runner outage.
test('CI gate: under a fresh outage note, a run is given CI_GRACE to be taken, and a red or lost one is red or run again, not parked', async () => {
  const c = ciSetup(3, { stack: '1' });
  const fresh = () => writeFileSync(join(c.state, 'ci-down'), `${Math.floor(Date.now() / 1000)} no runner started CI on 0123456789ab within 1 min\n`);
  const parked = /doesn't wait for it/;
  try {
    // Queued at first, then taken: it lands.
    fresh();
    const a = c.land(1, { LAND_CI_GRACE: '4' });
    const sa = await c.tip(a);
    await sleep(1000);
    assert.equal(a.child.exitCode, null, a.stderr());
    c.verdict(sa, 2);
    await sleep(300);
    c.verdict(sa, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.doesNotMatch(a.stderr(), parked);
    // Red, which the grace shows as not started for a while: red, not an outage.
    fresh();
    const b = c.land(2, { LAND_CI_GRACE: '2' });
    c.verdict(await c.tip(b), RED);
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    assert.doesNotMatch(b.stderr(), parked);
    // Lost: run again once, and the new run gets its own grace to be taken.
    const d = c.land(3, { LAND_CI_GRACE: '3' });
    const sd = await c.tip(d);
    c.verdict(sd, LOST);
    await until('the lost run to be run again', () => /running it again, once/.test(d.stderr()));
    c.verdict(sd, 3);
    await sleep(1000);
    assert.equal(d.child.exitCode, null, d.stderr());
    c.verdict(sd, GREEN);
    assert.equal(await d.exit, 0, d.stderr());
    assert.doesNotMatch(d.stderr(), parked);
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    c.stop();
  }
});

// A process and everything under it, parents first, so a stopped parent starts nothing new. Its children are listed
// before it is signalled, so a killed parent's children are still found.
function signalTree(pid: number, signal: NodeJS.Signals) {
  const children = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
  for (const child of children) signalTree(Number(child), signal);
}

// Review of the stopped-waiter port: a stacked waiter stopped mid-check keeps the check lock in its subshell, so the one
// that passed it waited on that lock for ever, and everyone behind it gave up at the stall limit.
test('the stack: a waiter stopped (SIGSTOP) mid-check keeps the check lock, and the one that passes it refuses at the limit, naming it', async () => {
  const c = ciSetup(3, { stack: '2', check: 'until [ -e "$GATE" ]; do sleep 0.05; done' });
  const gate = { a: join(c.dir, 'gate-a'), b: join(c.dir, 'gate-b'), c: join(c.dir, 'gate-c') };
  writeFileSync(gate.a, '');
  writeFileSync(gate.c, '');
  let b: ReturnType<typeof c.land> | undefined;
  try {
    const a = c.land(1, { GATE: gate.a });
    await c.tip(a); // checked, and waiting for CI
    b = c.land(2, { GATE: gate.b });
    await until('b to run its check, stacked on a', () => /running the check/.test(c.phase(c.tickets()[1] ?? '')));
    signalTree(b.child.pid!, 'SIGSTOP'); // its check's time limit is stopped with it
    const d = c.land(3, { GATE: gate.c, LAND_CHECK_TIMEOUT: '2', LAND_QUEUE_SLACK: '4' });
    assert.equal(await d.exit, 1, d.stderr());
    assert.match(d.stderr(), new RegExp(`the check lock \\(\\S+/land-check\\.lock\\) was still taken after 6s, so the check never ran and nothing landed: ticket/2-x's check holds it \\(its landing is pid ${b.child.pid}, stopped\\)`));
    assert.equal(a.child.exitCode, null, 'the head still waits for its CI');
    assert.deepEqual(c.landed(), []);
  } finally {
    if (b) {
      signalTree(b.child.pid!, 'SIGCONT');
      signalTree(b.child.pid!, 'SIGKILL');
    }
    for (const g of Object.values(gate)) writeFileSync(g, '');
    c.stop();
  }
});

test("CI gate: a landed commit's runs on the scratch branch are left to finish; stale ones, and a refused landing's, are cancelled", async () => {
  const c = ciSetup(2, { stack: '1' });
  const full = (sha: string) => git(c.main, 'rev-parse', sha);
  const cancelled = () => [...readFileSync(join(c.ci, 'gh.log'), 'utf8').matchAll(/actions\/runs\/(\d+)\/cancel/g)].map((m) => m[1]);
  try {
    const a = c.land(1);
    const sha = await c.tip(a);
    const old = 'b'.repeat(40); // an older commit of this branch, pushed by an earlier try: it won't land
    writeFileSync(join(c.ci, 'branch-runs'), `11\t${full(sha)}\n12\t${old}\n`);
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(cancelled(), ['12'], 'the landed run goes on; the stale one is cancelled');
    // The next landing's cleanup before its push spares the landed run too; a refused landing's run is cancelled.
    writeFileSync(join(c.ci, 'gh.log'), '');
    writeFileSync(join(c.ci, 'branch-runs'), `11\t${full(sha)}\n12\t${old}\n`);
    const b = c.land(2);
    const shb = await c.tip(b);
    writeFileSync(join(c.ci, 'branch-runs'), `11\t${full(sha)}\n21\t${full(shb)}\n`);
    c.verdict(shb, RED);
    assert.equal(await b.exit, 1, b.stderr());
    assert.deepEqual(cancelled(), ['12', '21'], 'nothing landed, so its run is cancelled; the landed one still goes on');
  } finally {
    c.stop();
  }
});

// #1894: GitHub lists a run some seconds after its push; a stop in between cancels it all the same, and only this branch's.
test('CI gate: a landing stopped before GitHub lists the run it pushed waits for it and cancels it, within a cap', async () => {
  const c = ciSetup(2, { stack: '1', builtin: true }); // two workflows
  const log = () => readFileSync(join(c.ci, 'gh.log'), 'utf8');
  const cancelled = () => [...new Set([...log().matchAll(/actions\/runs\/(\d+)\/cancel/g)].map((m) => m[1]))];
  const looks = () => log().split('runs?branch=land/').length;
  try {
    const a = c.land(1, { LAND_CI_LATE: '20' });
    const sha = git(c.origin, 'rev-parse', await c.tip(a));
    const before = looks();
    signalTree(a.child.pid!, 'SIGTERM');
    await until('its first look for the run', () => a.child.exitCode !== null || a.child.signalCode !== null || looks() > before);
    writeFileSync(join(c.ci, 'branch-runs'), `31\t${sha}\n`);
    const seen = looks();
    await until('two looks that list only its first workflow', () => a.child.exitCode !== null || a.child.signalCode !== null || looks() > seen + 2);
    writeFileSync(join(c.ci, 'branch-runs'), `32\t${sha}\n31\t${sha}\n`);
    await a.exit;
    assert.deepEqual(cancelled(), ['31', '32']);
    assert.deepEqual(c.scratch(), [], 'the scratch branch goes after it');
    // Never listed: it ends at the cap, on its own.
    writeFileSync(join(c.ci, 'branch-runs'), '');
    const b = c.land(2, { LAND_CI_LATE: '3' });
    await c.tip(b);
    signalTree(b.child.pid!, 'SIGTERM');
    await b.exit;
    assert.deepEqual(cancelled(), ['31', '32']);
    assert.deepEqual(c.scratch(), []);
  } finally {
    c.stop();
  }
});

test('the stack: three in line run CI at once, each on top of the one ahead, and land in order on one run each', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    assert.equal(c.parent(tb), ta, "the 2nd is built on the 1st's commit");
    assert.equal(c.parent(td), tb, "the 3rd on the 2nd's");
    assert.match(b.stderr(), /rebasing ticket\/2-x onto ticket\/1-x's commit [0-9a-f]{12}, 2nd in line/);
    assert.deepEqual(c.scratch(), [`land/ticket/1-x ${ta}`, `land/ticket/2-x ${tb}`, `land/ticket/3-x ${td}`]);
    assert.equal(git(c.main, 'rev-list', '--count', 'main..ticket/2-x'), '1', "the 2nd's branch holds only its own commit while it is stacked");
    // The last one's run ends first: nothing lands until the head's does.
    c.verdict(td, GREEN);
    c.verdict(tb, GREEN);
    await until('the 3rd to see its green run', () => /CI is green/.test(d.stderr()));
    assert.deepEqual(c.landed(), []);
    c.verdict(ta, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(c.mainAt(), td, 'main is the very commit CI passed for the 3rd');
    for (const l of [a, b, d]) assert.equal(c.sent(l).length, 1, `one CI run each: ${l.stderr()}`);
    assert.deepEqual(c.scratch(), []);
    assert.deepEqual([1, 2, 3].map(c.on), ['ticket/1-x', 'ticket/2-x', 'ticket/3-x']);
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), td);
    assert.deepEqual(c.tickets(), []);
    assert.ok(landLockFree(c));
  } finally {
    c.stop();
  }
});

test('the stack: a red run in the middle is refused, and the one behind it builds again on the one ahead and lands', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    c.verdict(td, RED); // red only because it sits on the 2nd: not believed while the 2nd hasn't landed
    // Two lines, written one after the other: wait for the second.
    await until('the 3rd to see red', () => /CI is red[^]*sits on ticket\/2-x's, which hasn't landed: waiting to see whether it does/.test(d.stderr()));
    c.verdict(tb, RED);
    await until('the 2nd to see red', () => /CI is red/.test(b.stderr()));
    assert.equal(c.parent(await c.tip(d, 2)), ta, "the 3rd builds again on the 1st's commit at once, past the red 2nd");
    await sleep(300);
    assert.equal(b.child.exitCode, null, 'the 2nd waits too: the 1st may yet be why it is red');
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    const again = await c.tip(d, 2);
    assert.equal(c.parent(again), ta, "the 3rd is built again on the 1st's commit, which is main now");
    assert.deepEqual(c.landed(), ['f1.txt: 1']);
    c.verdict(again, GREEN);
    assert.equal(await d.exit, 0, d.stderr());
    assert.doesNotMatch(d.stderr(), /rebasing ticket\/3-x onto main/, "the 3rd kept the run it had on the 1st's commit: it is not built a third time once the red 2nd is all that is ahead (#560)");
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3'], "none of the 2nd's commits reached main");
    assert.equal(c.mainAt(), again);
    assert.equal(c.on(2), 'ticket/2-x');
    assert.equal(git(c.wts[1], 'log', '--format=%s', 'main..ticket/2-x'), 'f2.txt: 2', "the 2nd's branch holds its own commit only");
    assert.deepEqual(c.scratch(), []);
  } finally {
    c.stop();
  }
});

test('the stack: a run lost mid-way is run again on the same commit, and the one behind keeps its run', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    c.verdict(tb, LOST, true);
    assert.equal(await c.tip(b, 2), tb, 'the same commit goes to CI again');
    assert.match(b.stderr(), /ended without a verdict \(a runner lost mid-run, or the run cancelled\): running it again, once/);
    c.verdict(tb, GREEN);
    c.verdict(td, GREEN);
    c.verdict(ta, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(c.sent(d).length, 1, 'the 3rd kept its run');
    assert.equal(c.mainAt(), td);
  } finally {
    c.stop();
  }
});

test('the stack: a run lost twice parks that landing with exit 75, and the one behind builds again', async () => {
  const c = ciSetup(2);
  try {
    const [a, b] = await c.lands(1, 2);
    const [ta, tb] = [await c.tip(a), await c.tip(b)];
    c.verdict(ta, LOST);
    assert.equal(await a.exit, 75, a.stderr());
    assert.match(a.stderr(), /ended without a verdict a second time/);
    const again = await c.tip(b, 2);
    assert.notEqual(again, tb);
    assert.equal(c.parent(again), c.mainAt(), 'the 2nd is built again on main');
    c.verdict(again, GREEN);
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(c.landed(), ['f2.txt: 2']);
    assert.equal(c.on(1), 'ticket/1-x');
  } finally {
    c.stop();
  }
});

// KT7 (#1519): a second land.sh in a worktree whose landing is still alive leaves that landing alone, where the
// killed-landing recovery used to take its detached HEAD back onto the branch and abort its rebase.
// CO4 (#1866): with land_rebased too, whose note of its commit named nobody.
for (const [hook, local] of [
  ['', undefined],
  [", after land_rebased's commit", rebasedHook],
] as const) {
  test(`a land.sh run again while the first is still landing in that worktree touches nothing, and the first lands${hook}`, async () => {
    const c = ciSetup(1, { local });
    try {
      const a = c.land(1);
      const ta = await c.tip(a);
      assert.equal(c.on(1), '', 'the first is detached on its rebased commit');
      const again = c.land(1);
      assert.equal(await again.exit, 1, again.stderr());
      assert.match(again.stderr(), /a landing is still running in .* \(pid \d+\) and has its HEAD detached on purpose, so this touched nothing/);
      assert.doesNotMatch(again.stderr(), /stopped mid-way/);
      assert.equal(git(c.wt, 'rev-parse', 'HEAD'), git(c.main, 'rev-parse', ta), "still on the first one's commit");
      c.verdict(ta, GREEN);
      assert.equal(await a.exit, 0, a.stderr());
      assert.equal(c.landed()[0], 'f1.txt: 1');
    } finally {
      c.stop();
    }
  });
}

test('the stack: when the head is killed mid-CI the ones behind build again on main, and its branch is as it was', async () => {
  const c = ciSetup(3);
  try {
    const was = git(c.wt, 'rev-parse', 'ticket/1-x');
    const [a, b, d] = await c.lands(1, 2, 3);
    const [, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    a.child.kill('SIGKILL');
    const [tb2, td2] = [await c.tip(b, 2), await c.tip(d, 2)];
    assert.notEqual(tb2, tb);
    assert.notEqual(td2, td);
    assert.equal(c.parent(tb2), c.mainAt());
    assert.equal(c.parent(td2), tb2);
    c.verdict(tb2, GREEN);
    c.verdict(td2, GREEN);
    assert.equal(await b.exit, 0, b.stderr());
    assert.equal(await d.exit, 0, d.stderr());
    assert.deepEqual(c.landed(), ['f2.txt: 2', 'f3.txt: 3']);
    // The killed one: its worktree is left on the detached commit, its branch where it was. Run again, it lands.
    assert.equal(c.on(1), '');
    assert.equal(git(c.wt, 'rev-parse', 'ticket/1-x'), was);
    const a2 = c.land(1);
    c.verdict(await c.tip(a2), GREEN);
    assert.equal(await a2.exit, 0, a2.stderr());
    assert.match(a2.stderr(), /an earlier landing here was stopped mid-way: .* is back on ticket\/1-x as it was/);
    assert.deepEqual(c.landed(), ['f2.txt: 2', 'f3.txt: 3', 'f1.txt: 1']);
  } finally {
    c.stop();
  }
});

test('the stack: a stacked landing that is killed and run again lands none of the unlanded commits it sat on', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    d.child.kill('SIGKILL'); // its worktree now sits on a commit holding the 1st's and the 2nd's work
    await d.exit;
    assert.equal(git(c.wts[2], 'log', '--topo-order', '--format=%s', 'main..HEAD'), 'f3.txt: 3\nf2.txt: 2\nf1.txt: 1');
    c.verdict(tb, RED);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 1, b.stderr());
    const d2 = c.land(3);
    const again = await c.tip(d2);
    assert.equal(c.parent(again), ta);
    c.verdict(again, GREEN);
    assert.equal(await d2.exit, 0, d2.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    c.stop();
  }
});

test('the stack: a conflict with an unlanded commit ahead waits; it lands if that one fails, and is refused if that one lands', async () => {
  for (const ahead of [RED, GREEN]) {
    // The 2nd and the 3rd both rewrite a.txt; the 1st touches something else.
    const c = ciSetup(3, { files: (i) => (i === 1 ? 'f1.txt' : 'a.txt') });
    try {
      const mine = git(c.wts[2], 'rev-parse', 'HEAD');
      const [a, b, d] = await c.lands(1, 2, 3);
      const [ta, tb] = [await c.tip(a), await c.tip(b)];
      await until('the 3rd to meet the conflict', () => /on top of ticket\/2-x's commit, which hasn't landed: the rebase onto main failed/.test(d.stderr()));
      assert.deepEqual(c.sent(d), [], 'nothing of the 3rd went to CI');
      c.verdict(tb, ahead);
      c.verdict(ta, GREEN);
      assert.equal(await a.exit, 0, a.stderr());
      if (ahead === RED) {
        assert.equal(await b.exit, 1, b.stderr());
        const sha = await c.tip(d);
        assert.equal(c.parent(sha), ta);
        c.verdict(sha, GREEN);
        assert.equal(await d.exit, 0, d.stderr());
        assert.deepEqual(c.landed(), ['f1.txt: 1', 'a.txt: 3']);
      } else {
        assert.equal(await b.exit, 0, b.stderr());
        assert.equal(await d.exit, 1, d.stderr());
        assert.match(d.stderr(), /the rebase onto main failed/);
        assert.deepEqual(c.landed(), ['f1.txt: 1', 'a.txt: 2']);
        assert.equal(c.on(3), 'ticket/3-x');
        assert.equal(git(c.wts[2], 'rev-parse', 'HEAD'), mine, 'the branch is where it was');
        assert.equal(git(c.wts[2], 'status', '--porcelain'), '');
      }
    } finally {
      c.stop();
    }
  }
});

test('the stack: the 4th in line builds nothing until a place frees, and a red check stacked on unlanded work waits like red CI', async () => {
  // The check is red for the 3rd only while the 2nd's file is there too.
  const c = ciSetup(4, { check: '[ ! -e f3.txt ] || [ ! -e f2.txt ]' });
  try {
    const lands = await c.lands(1, 2, 3);
    const [ta, tb] = [await c.tip(lands[0]), await c.tip(lands[1])];
    await until('the 3rd to fail its check on the 2nd', () => /which hasn't landed: the check failed/.test(lands[2].stderr()));
    lands.push(c.land(4));
    await until('the 4th to say its place', () => /4th in line/.test(lands[3].stderr()));
    await sleep(300);
    assert.doesNotMatch(lands[3].stderr(), /rebasing/, 'the 4th is outside the stack');
    assert.equal(lands[2].child.exitCode, null, 'the 3rd waits');
    c.verdict(tb, RED);
    // Red stacked on unlanded work: the 2nd marks itself skip (then says "CI is red") before the 1st lands. Landed first,
    // the 2nd is the head when it reads red, and the 4th, 3rd in line then, builds on its commit meanwhile.
    const t2 = c.tickets()[1];
    await until('the 2nd to read its red', () => c.phase(t2) === 'CI is red');
    c.verdict(ta, GREEN);
    assert.equal(await lands[0].exit, 0, lands[0].stderr());
    assert.equal(await lands[1].exit, 1, lands[1].stderr());
    const tc = await c.tip(lands[2]); // without the 2nd under it, its check passes
    const td = await c.tip(lands[3]);
    assert.equal(c.parent(tc), ta);
    assert.equal(c.parent(td), tc, 'the 4th joined the stack');
    c.verdict(tc, GREEN);
    c.verdict(td, GREEN);
    assert.equal(await lands[2].exit, 0, lands[2].stderr());
    assert.equal(await lands[3].exit, 0, lands[3].stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  } finally {
    c.stop();
  }
});

test('the stack: nobody builds on a ticket from a land.sh older than the stack, and a commit made on main under the head is built on again', async () => {
  const c = ciSetup(1);
  // A four-line ticket, first in line, for a process that stays alive.
  const older = spawn('sleep', ['600'], { stdio: 'ignore' });
  try {
    const stat = readFileSync(`/proc/${older.pid}/stat`, 'utf8');
    mkdirSync(join(c.state, 'land-queue'));
    writeFileSync(join(c.state, 'land-queue', '0000000001'), `${older.pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\n0\nticket/0-old\nrunning the check since 10:00\n`);
    writeFileSync(join(c.state, 'land-queue', '.seq'), '1\n');
    const a = c.land(1);
    await until('it to say its place', () => /2nd in line for the land lock, about 5 min \(ahead: ticket\/0-old, running the check since 10:00\)/.test(a.stderr()));
    await sleep(300);
    assert.doesNotMatch(a.stderr(), /rebasing/);
    older.kill('SIGKILL');
    const first = await c.tip(a);
    c.commit(c.main, 'c.txt', 'made on main by hand\n');
    const second = await c.tip(a, 2);
    assert.equal(c.parent(second), c.mainAt());
    c.verdict(first, GREEN); // the run nobody waits for
    await sleep(300);
    assert.deepEqual(c.landed(), ['c.txt: made on main by hand']);
    c.verdict(second, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(c.landed(), ['c.txt: made on main by hand', 'f1.txt: 1']);
  } finally {
    older.kill('SIGKILL');
    c.stop();
  }
});

test('CI gate: the built-in reader takes the newest run of each workflow, the worst of them, and tells a lost runner from a red step', async () => {
  const c = ciSetup(1, { builtin: true });
  const run = (workflow: string, id: number, status: string, result: string) => `.github/workflows/${workflow}\t${id}\t${status}\t${result}\thttps://ci.test/${id}\n`;
  const runs = (...rows: string[]) => writeFileSync(join(c.ci, 'runs.tsv'), rows.join(''));
  const gh = () => readFileSync(join(c.ci, 'gh.log'), 'utf8');
  try {
    const a = c.land(1);
    const sha = await c.tip(a);
    assert.match(gh(), new RegExp(`api repos/.*/actions/runs\\?head_sha=${sha}`), 'it asks about the exact commit');
    // Each CI wait says what is left of the login's hour (Citadel #1722).
    assert.match(a.stderr(), /waiting for CI on [0-9a-f]{12} \(origin's \S+\)\. GitHub calls left this hour: 4321\/5000, resets in 25 min\n/);
    // One workflow green, the other still running: not green.
    runs(run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 3, 'in_progress', '-'));
    await sleep(400);
    assert.deepEqual(c.landed(), []);
    // The newest run of slow.yml failed with no failed step (its runner went away); an older green one doesn't count.
    writeFileSync(join(c.ci, 'failed-steps'), '1 0\n'); // one job, no failed step
    writeFileSync(join(c.ci, 'runs.once.tsv'), [run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 5, 'completed', 'failure'), run('slow.yml', 1, 'completed', 'success')].join(''));
    await c.tip(a, 2);
    assert.match(a.stderr(), /slow\.yml: completed failure https:\/\/ci\.test\/5/);
    assert.match(a.stderr(), /running it again, once/);
    // The new run fails in a step: red.
    writeFileSync(join(c.ci, 'failed-steps'), '1 1\n');
    runs(run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 7, 'completed', 'failure'));
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /CI is red on/);
    assert.deepEqual(c.landed(), []);
    // Green on both: lands, without a push, since the commit's runs already passed.
    runs(run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 6, 'completed', 'success'));
    const b = c.land(1);
    assert.equal(await b.exit, 0, b.stderr());
    assert.match(b.stderr(), /CI already passed/);
    assert.deepEqual(c.landed(), ['f1.txt: 1']);
  } finally {
    c.stop();
  }
});

// KT6 (#1519): a run GitHub failed before any job started (a workflow file it can't read: "failure" with no jobs, or
// "startup_failure") is red with its cause named, never run again and parked "for the runners".
test('CI gate: a run that failed before any job started is red, not a lost runner', async () => {
  for (const [result, steps] of [
    ['failure', '0 0'],
    ['startup_failure', ''],
  ]) {
    const c = ciSetup(1, { builtin: true });
    try {
      writeFileSync(join(c.ci, 'failed-steps'), `${steps}\n`);
      writeFileSync(join(c.ci, 'runs.tsv'), `.github/workflows/ci.yml\t2\tcompleted\t${result}\thttps://ci.test/2\n.github/workflows/slow.yml\t3\tcompleted\tsuccess\thttps://ci.test/3\n`);
      const a = c.land(1);
      assert.equal(await a.exit, 1, a.stderr());
      assert.match(a.stderr(), /CI is red on/, result);
      assert.match(a.stderr(), /failed (before any job started|to start).*not a lost runner/, result);
      assert.doesNotMatch(a.stderr(), /running it again|runners/, result);
      assert.deepEqual(c.landed(), []);
    } finally {
      c.stop();
    }
  }
});

// A workflow whose jobs were skipped (an `if:` that came out false) concludes success with nothing run (ultra review B3).
test("CI gate: the built-in reader doesn't take a successful run with a skipped job for green", async () => {
  const c = ciSetup(1, { builtin: true });
  const run = (workflow: string, id: number) => `.github/workflows/${workflow}\t${id}\tcompleted\tsuccess\thttps://ci.test/${id}\n`;
  try {
    writeFileSync(join(c.ci, 'runs.tsv'), run('ci.yml', 2) + run('slow.yml', 3));
    writeFileSync(join(c.ci, 'skipped-jobs'), '1\n');
    const a = c.land(1);
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /1 of the jobs in (ci|slow)\.yml's run on [0-9a-f]{12} were skipped, so the commit's checks did not all run and nothing landed/);
    assert.match(a.stderr(), /Nothing is wrong with the runners/);
    assert.match(a.stderr(), /needs the scheme's own CI_STATUS script/);
    // Running it again would skip the same jobs again, and it is no lost runner.
    assert.equal(c.sent(a).length, 1, a.stderr());
    assert.doesNotMatch(a.stderr(), /running it again, once|runner lost|runners need/);
    assert.deepEqual(c.landed(), []);
    assert.match(readFileSync(join(c.ci, 'gh.log'), 'utf8'), /actions\/runs\/2\/jobs/, "it asked for the run's jobs");
    // No count of the skipped jobs is no verdict, never green: run again once, as for a lost runner, then park.
    writeFileSync(join(c.ci, 'skipped-jobs'), '');
    const e = c.land(1);
    assert.equal(await e.exit, 75, e.stderr());
    assert.match(e.stderr(), /ended without a verdict \(a runner lost mid-run, or the run cancelled\): running it again, once/);
    assert.match(e.stderr(), /ended without a verdict a second time/);
    assert.deepEqual(c.landed(), []);
    // Every job ran: green.
    writeFileSync(join(c.ci, 'skipped-jobs'), '0\n');
    const b = c.land(1);
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1']);
  } finally {
    c.stop();
  }
});

test('CI gate: an old red run of the same commit is not believed just after the push; a run queued behind busy runners waits, and no answer at all says so', async () => {
  const c = ciSetup(1, { stack: '1' });
  try {
    // Main hasn't moved, so the commit CI gets is the branch's own: red from an earlier try.
    const sha = git(c.wt, 'rev-parse', 'HEAD').slice(0, 12);
    c.verdict(sha, RED);
    // The fakes' answers are there before the landing starts: it parks CI_START (1 s) after its push on whatever it
    // reads then, and a test process the box starved for that second wrote them too late (#1551).
    writeFileSync(join(c.ci, 'busy'), '2\n');
    const a = c.land(1, { LAND_CI_GRACE: '600', LAND_CI_START: '1' });
    assert.equal(await c.tip(a), sha, 'it starts a new run');
    await until('it to see the runners are busy', () => /runners are busy with other runs: still waiting/.test(a.stderr()));
    assert.equal(a.child.exitCode, null, 'neither refused on the old red nor parked');
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    // A verdict command that can't answer: it parks saying that, not that the runners are off.
    c.commit(c.wt, 'g.txt', 'more\n');
    const next = git(c.wt, 'rev-parse', 'HEAD').slice(0, 12); // the branch is on main again, so CI gets this commit too
    c.verdict(next, 5);
    const b = c.land(1, { LAND_CI_START: '1' });
    assert.equal(await c.tip(b), next);
    assert.equal(await b.exit, 75, b.stderr());
    assert.match(b.stderr(), /CI gave no answer about [0-9a-f]{12} for 1 min \(exit 5 from "\$CI_FAKE"; above\)/);
  } finally {
    c.stop();
  }
});

test('CI gate: GitHub not answering past CI_LIMIT parks saying that, with no ci-down note; one missed answer is asked again', async () => {
  const c = ciSetup(1, { stack: '1' });
  // CI's answers in turn, one a line, the last one for good; each is logged.
  const answers = (...codes: number[]) => {
    writeFileSync(join(c.ci, 'answers'), codes.map((n) => `${n}\n`).join(''));
    writeFileSync(join(c.ci, 'asked'), '');
  };
  const asked = () => readFileSync(join(c.ci, 'asked'), 'utf8').trim().split('\n');
  try {
    writeFileSync(join(c.ci, 'status.sh'), '#!/bin/bash\nf=$CI_DIR/answers\nread -r code <"$f"\n[ "$(wc -l <"$f")" = 1 ] || sed -i 1d "$f"\necho "$code" >>"$CI_DIR/asked"\nexit "$code"\n', { mode: 0o755 });
    // The run was going when GitHub stopped answering (exit 5), and it hasn't answered since.
    answers(3, 2, 5);
    const a = c.land(1, { LAND_CI_TIMEOUT: '2' });
    assert.equal(await a.exit, 75, a.stderr());
    assert.match(a.stderr(), /GitHub didn't answer since \d\d:\d\d \(\d+ polls failed in a row; exit 5 from "\$CI_FAKE"; above\), so nothing landed, and whether CI on [0-9a-f]{12} finished isn't known\./);
    assert.doesNotMatch(a.stderr(), /hasn't finished within/);
    assert.ok(!existsSync(join(c.state, 'ci-down')), 'a GitHub outage is no word about the runners');
    // One missed answer at the limit says nothing: the next one, that the run still goes, decides.
    answers(3, 2, 5, 2);
    const b = c.land(1, { LAND_CI_TIMEOUT: '3', LAND_CI_POLL: '2' });
    assert.equal(await b.exit, 75, b.stderr());
    assert.match(b.stderr(), /CI on [0-9a-f]{12} hasn't finished within 1 min/);
    assert.deepEqual(asked(), ['3', '2', '5', '2']);
  } finally {
    c.stop();
  }
});

test('the stack: a commit made on the detached HEAD a killed landing left is not thrown away', async () => {
  const c = ciSetup(1, { stack: '1' });
  try {
    const a = c.land(1);
    await c.tip(a);
    a.child.kill('SIGKILL');
    await a.exit;
    c.commit(c.wt, 'late.txt', 'made on the detached commit\n');
    const again = c.land(1);
    assert.equal(await again.exit, 1, again.stderr());
    assert.match(again.stderr(), /left .* on a detached commit \([0-9a-f]{12}\), and HEAD has moved since\. If you committed here, put those commits on ticket\/1-x/);
    assert.equal(git(c.wt, 'log', '-1', '--format=%s'), 'late.txt: made on the detached commit', 'the commit is still there');
    assert.deepEqual(c.landed(), []);
  } finally {
    c.stop();
  }
});

test('CI gate: a commit put on the branch while its landing waited is not landed around, and the branch keeps it', async () => {
  const c = ciSetup(1);
  try {
    const a = c.land(1, { LAND_STACK_DEPTH: '2' });
    const sha = await c.tip(a);
    git(c.main, 'branch', '-f', 'ticket/1-x', git(c.main, 'commit-tree', '-p', 'ticket/1-x', '-m', 'late', 'ticket/1-x^{tree}'));
    const late = git(c.main, 'rev-parse', 'ticket/1-x');
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /moved while the landing waited, so what CI passed is not what is here now and nothing landed/);
    assert.deepEqual(c.landed(), []);
    assert.equal(git(c.wt, 'rev-parse', 'HEAD'), late, 'the worktree is back on the branch, late commit and all');
    assert.equal(spawnSync('bash', [join(c.wt, 'tools', 'land.sh')], { cwd: c.wt, encoding: 'utf8', env: { ...env, LAND_STACK_DEPTH: '0' } }).stderr.trim(), 'land: CI_STACK is a number from 1 up, not "0"');
  } finally {
    c.stop();
  }
});

// Batches (#600, the design in Citadel's specs/batched-landings.md): CI_BATCH landings share one CI run on the top commit.
// CI_STACK 1, as Peek Auras runs it: one batch runs CI, the next builds ahead.
const gated = 'until [ -e "$GATE" ]; do sleep 0.05; done';
const branchAt = (c: ReturnType<typeof ciSetup>, i: number) => git(c.main, 'rev-parse', `ticket/${i}-x`).slice(0, 12);

test('batches: three share one run on the top commit; main moves once, straight to it, and each lands on its own commit', async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated });
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open(); // the checks, once all three are in line: otherwise each is the top for a moment, and pushes
    const td = await c.tip(d);
    const tb = c.parent(td);
    const ta = c.parent(tb);
    assert.equal(c.parent(ta), c.mainAt(), 'the batch is stacked on main');
    assert.deepEqual(c.scratch(), [`land/ticket/3-x ${td}`], 'only the top pushed');
    c.verdict(td, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(c.mainAt(), td);
    assert.equal(
      git(c.main, 'reflog', '--format=%gs', 'main')
        .split('\n')
        .filter((l) => /merge/.test(l)).length,
      1,
      'main moved once',
    );
    assert.equal([a, b, d].filter((l) => /pushed main to origin/.test(l.stderr())).length, 1, 'and was pushed once');
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), td);
    assert.deepEqual([c.sent(a), c.sent(b)], [[], []], 'the members below the top sent nothing to CI');
    // Each names its own commit, which is what the server's ship note reads (KT3, #1519), and a member says the
    // head's push reached origin before it leaves.
    assert.match(a.stderr(), new RegExp(`landed ${ta.slice(0, 7)}[0-9a-f]* "[^"]*" in a batch with ticket/2-x, ticket/3-x, on ticket/3-x's CI run`));
    assert.match(b.stderr(), new RegExp(`landed ${tb.slice(0, 7)}[0-9a-f]* "[^"]*" in a batch with ticket/1-x, ticket/3-x, on ticket/3-x's CI run \\(main is now [0-9a-f]{12}\\)`));
    assert.match(d.stderr(), new RegExp(`landed ${td.slice(0, 7)}[0-9a-f]* "[^"]*" in a batch with ticket/1-x, ticket/2-x, on its own CI run`));
    for (const l of [b, d]) assert.match(l.stderr(), /main is on origin \(the batch head pushed it\)/);
    // The ship line (#1320): each its own commit and place; the timing lines, with no shared folder, in .git/land-log.
    assert.deepEqual(
      [a, b, d].map((l) => l.stderr().trimEnd().split('\n').pop()),
      [ta, tb, td].map((t, i) => `ship: landed ${t} batch ${i + 1} of 3 deploy none`),
    );
    const timed = timingLines(join(c.state, 'land-log')).sort((x, y) => x.split(' · ')[2].localeCompare(y.split(' · ')[2]));
    assert.equal(timed.length, 3, timed.join('\n'));
    timed.forEach((l, i) => assert.match(l, new RegExp(`· timing · ticket/${i + 1}-x · line \\d+ · rebase \\d+ · ci-queue ${i === 2 ? '\\d+' : '-'} · ci-run ${i === 2 ? '-' : '\\d+'} · landed · batch ${i + 1} of 3$`)));
    assert.deepEqual([1, 2, 3].map(c.on), ['ticket/1-x', 'ticket/2-x', 'ticket/3-x']);
    assert.deepEqual(
      [1, 2, 3].map((i) => branchAt(c, i)),
      [ta, tb, td],
      'each branch sits on its own commit',
    );
    assert.equal(
      readFileSync(join(c.state, 'land-queue', '.took'), 'utf8')
        .trim()
        .split('\n').length,
      1,
      'only the head held the lock, so only it is timed',
    );
    assert.deepEqual(c.scratch(), []);
    assert.deepEqual(c.tickets(), []);
    assert.ok(landLockFree(c));
    assert.equal(spawnSync('bash', [join(c.wt, 'tools', 'land.sh')], { cwd: c.wt, encoding: 'utf8', env: { ...env, LAND_BATCH: '0' } }).stderr.trim(), 'land: CI_BATCH is a number from 1 up, not "0"');
  } finally {
    c.stop();
  }
});

test('batches: the line follows land-queue/.order (#1007), so the batches form in the order set and land in it', async () => {
  const c = ciSetup(4, { stack: '1', batch: '2', check: gated });
  try {
    const [a, b, d, e] = await c.lands(1, 2, 3, 4);
    // Its ticket is out before it reads the line: an order written in between is no news to it, and it never says it.
    await until('the 4th to see its place', () => /4th in line/.test(e.stderr()));
    const [, t2, t3, t4] = c.tickets();
    writeFileSync(join(c.state, 'land-queue', '.order'), `# Cara moved ticket/4-x to land next\n${t4}\n${t2}\n${t3}\n`);
    await until('the 4th to move up', () => /queue: Cara moved ticket\/4-x to land next\nqueue: 2nd in line/.test(e.stderr()));
    c.open();
    // Each batch's top pushes; every run is green.
    const all = [a, b, d, e];
    const seen = new Set<string>();
    while (all.some((l) => l.child.exitCode === null)) {
      for (const sha of all.flatMap(c.sent))
        if (!seen.has(sha)) {
          seen.add(sha);
          c.verdict(sha, GREEN);
        }
      await sleep(50);
    }
    for (const l of all) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f4.txt: 4', 'f2.txt: 2', 'f3.txt: 3']);
    assert.match(a.stderr(), /landed [0-9a-f]+ "[^"]*" in a batch with ticket\/4-x/);
  } finally {
    c.stop();
  }
});

test('batches: a red top bisects; the bottom lands, the bad middle is refused on main, and the top builds again and lands on its own run', async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated });
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    const tb = c.parent(td);
    const ta = c.parent(tb);
    c.verdict(td, RED);
    assert.equal(await c.tip(a), ta, 'the halfway member pushes its commit as it is');
    assert.deepEqual(c.sent(b), []);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.mainAt(), ta);
    assert.equal(await c.tip(b), tb, 'then the next halfway one: the 2nd, now on main');
    c.verdict(tb, RED);
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    assert.equal(c.on(2), 'ticket/2-x');
    assert.equal(branchAt(c, 2), tb, "the refused one's branch moves to its rebased commit, on main");
    const again = await c.tip(d, 2);
    assert.equal(c.parent(again), ta, 'the top builds again on main');
    c.verdict(again, GREEN);
    assert.equal(await d.exit, 0, d.stderr());
    assert.doesNotMatch(d.stderr(), /landed [0-9a-f]+ "[^"]*" in a batch/);
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3']);
    assert.equal(c.mainAt(), again);
    assert.deepEqual(c.scratch(), []);
  } finally {
    c.stop();
  }
});

test('batches: a member in conflict where it sits is skipped and the batch closes over it with no run of its own; on main it is refused', async () => {
  // The 1st and 2nd both rewrite a.txt; the 3rd touches something else.
  const c = ciSetup(3, { stack: '1', batch: '3', files: (i) => (i === 3 ? 'f3.txt' : 'a.txt') });
  try {
    const mine = git(c.wts[1], 'rev-parse', 'HEAD');
    const [a, b, d] = await c.lands(1, 2, 3);
    const td = await c.tip(d);
    await until('the 2nd to meet the conflict', () => /on top of ticket\/1-x's commit, which hasn't landed: the rebase onto main failed/.test(b.stderr()));
    const ta = c.parent(td);
    assert.equal(c.parent(ta), c.mainAt(), "the top is built on the 1st's commit, past the 2nd");
    c.verdict(td, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await d.exit, 0, d.stderr());
    assert.match(d.stderr(), /landed [0-9a-f]+ "[^"]*" in a batch with ticket\/1-x, on its own CI run/);
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /the rebase onto main failed/);
    assert.deepEqual(c.sent(b), [], 'nothing of the 2nd went to CI');
    assert.deepEqual(c.landed(), ['a.txt: 1', 'f3.txt: 3']);
    assert.equal(git(c.wts[1], 'rev-parse', 'HEAD'), mine, "the 2nd's branch is where it was");
  } finally {
    c.stop();
  }
});

test('batches: a member killed mid-batch makes the ones behind build again, and nothing lands from a commit that held it', async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated });
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    const ta = c.parent(c.parent(td));
    assert.deepEqual([c.sent(a), c.sent(b)], [[], []]);
    b.child.kill('SIGKILL');
    await b.exit;
    const again = await c.tip(d, 2);
    assert.equal(c.parent(again), ta, "the top builds again on the 1st's commit");
    c.verdict(td, GREEN); // the run of the commit that held the killed one
    await sleep(400);
    assert.deepEqual(c.landed(), [], 'a green run on it lands nothing');
    c.verdict(again, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await d.exit, 0, d.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3']);
    assert.equal(c.mainAt(), again);
  } finally {
    c.stop();
  }
});

test('batches: a ticket from a land.sh older than batches (five lines) is a batch of its own, read as no verdict and never landed by another', async () => {
  const c = ciSetup(3, { batch: '3' }); // the template's stack, 3: each batch of one runs CI
  const older = spawn('sleep', ['600'], { stdio: 'ignore' });
  try {
    const [a] = await c.lands(1);
    const stat = readFileSync(`/proc/${older.pid}/stat`, 'utf8');
    const ticket = join(c.state, 'land-queue', '0000000002');
    const write = (commit: string) => writeFileSync(ticket, `${older.pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\n0\nticket/0-old\nwaiting for CI\n${commit}\n`);
    write('-');
    writeFileSync(join(c.state, 'land-queue', '.seq'), '2\n');
    const [d] = await c.lands(3);
    const ta = await c.tip(a);
    assert.equal(c.sent(a).length, 1, 'the 1st is a batch of its own, the older one being next, so it runs CI');
    // The older landing builds on the 1st's commit and says nothing of CI, as it would.
    const old = git(c.main, 'commit-tree', '-p', git(c.main, 'rev-parse', ta), '-m', 'old', `${ta}^{tree}`);
    write(old);
    const td = await c.tip(d);
    assert.equal(c.parent(td), old.slice(0, 12), "the 3rd builds on the older one's commit");
    c.verdict(old.slice(0, 12), GREEN);
    c.verdict(td, GREEN);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.mainAt(), ta, 'the 1st landed only itself');
    await sleep(400);
    assert.equal(d.child.exitCode, null, 'the 3rd waits behind the older one');
    older.kill('SIGKILL');
    const again = await c.tip(d, 2);
    assert.equal(c.parent(again), ta);
    c.verdict(again, GREEN);
    assert.equal(await d.exit, 0, d.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    older.kill('SIGKILL');
    c.stop();
  }
});

test('batches: a member whose branch got a commit while it waited says that commit is not on main, and exits 1', async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated });
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    git(c.main, 'branch', '-f', 'ticket/2-x', git(c.main, 'commit-tree', '-p', 'ticket/2-x', '-m', 'late', 'ticket/2-x^{tree}'));
    const late = git(c.main, 'rev-parse', 'ticket/2-x');
    c.verdict(td, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await d.exit, 0, d.stderr());
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /landed in a batch \(main is now [0-9a-f]{12}\), but ticket\/2-x or this worktree's HEAD moved while it waited, so what was committed since is not on main/);
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(git(c.main, 'rev-parse', 'ticket/2-x'), late, 'the branch keeps its late commit');
  } finally {
    c.stop();
  }
});

test("batches: a member whose commit the head lands while it is looking at the line is not checked against main (#770's in-line check) and leaves as landed", async () => {
  // The window is narrow: after batch_landed's look at the loop's top and before the in-line conflict check, once
  // queue_look has read the line. A git in front of the real one freezes the 2nd at the first process it starts after
  // that look (the in-line check's read of main; the look itself starts none, #1545), with the line it read (the 1st
  // still alive), until the head has landed all three. The 2nd deletes a line the 3rd inserts beside: the 3rd rebases onto it cleanly, but
  // the 2nd's commit as it was before the rebase conflicts with main, which holds the 3rd's change too.
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated });
  const bin = join(c.dir, 'bin');
  const real = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const hold = join(c.dir, 'hold');
  mkdirSync(hold);
  writeFileSync(join(bin, 'git'), `#!/bin/bash\nif [ -n "$HOLD_DIR" ] && [ "$1 $2" = 'rev-parse refs/heads/main' ] && [ -e "$HOLD_DIR/arm" ]; then rm "$HOLD_DIR/arm"; : >"$HOLD_DIR/at"; until [ -e "$HOLD_DIR/go" ]; do sleep 0.05; done; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  try {
    // A base with lines to share, and the three branches redone on it: 1 deletes L6, 2 deletes L3, and 3 deletes L3
    // too, then inserts a line where it was. Found by trying every pair of small edits for the 3rd.
    const lines = (...l: string[]) => l.join('\n') + '\n';
    const base = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'];
    const without = (...gone: string[]) => base.filter((l) => !gone.includes(l));
    git(c.main, 'config', 'user.name', 't');
    writeFileSync(join(c.main, 'lines.txt'), lines(...base));
    git(c.main, 'add', 'lines.txt');
    git(c.main, 'commit', '-qm', 'lines');
    for (const wt of c.wts) git(wt, 'reset', '-q', '--hard', 'main');
    const edit = (i: number, msg: string, ...l: string[]) => {
      writeFileSync(join(c.wts[i], 'lines.txt'), lines(...l));
      git(c.wts[i], 'commit', '-qam', msg);
    };
    edit(0, 'lines.txt: 1', ...without('L6'));
    edit(1, 'lines.txt: 2', ...without('L3'));
    edit(2, 'lines.txt: 3', ...without('L3'));
    edit(2, 'lines.txt: 3 again', 'L1', 'L2', 'NEW', ...without('L1', 'L2', 'L3'));
    const a = c.land(1);
    await until("landing 1's ticket", () => c.issued() === 1);
    const b2 = c.land(2, { HOLD_DIR: hold });
    await until("landing 2's ticket", () => c.issued() === 2);
    const d = c.land(3);
    await until("landing 3's ticket", () => c.issued() === 3);
    c.open();
    const td = await c.tip(d);
    writeFileSync(join(hold, 'arm'), '');
    await until('the 2nd to stop in its look at the line', () => existsSync(join(hold, 'at')));
    c.verdict(td, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await d.exit, 0, d.stderr());
    assert.equal(git(c.main, 'rev-parse', 'main').slice(0, 12), td, 'the head landed all three');
    writeFileSync(join(hold, 'go'), '');
    assert.equal(await b2.exit, 0, b2.stderr());
    assert.doesNotMatch(b2.stderr(), /won't rebase onto/);
    assert.match(b2.stderr(), /landed [0-9a-f]+ "[^"]*" in a batch with/);
  } finally {
    c.stop();
  }
});

test("batches: when the head's push of main fails, each member says so in the unpushed line, not that it landed and left (KT3, #1519)", async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated });
  try {
    writeFileSync(join(c.origin, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read o n r; do [ "$r" != refs/heads/main ] || { echo "main is protected here"; exit 1; }; done\n', { mode: 0o755 });
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    c.verdict(td, GREEN);
    for (const l of [a, b, d]) {
      assert.equal(await l.exit, 1, l.stderr());
      assert.match(l.stderr(), /land: main moved, but the push to origin failed: .*main is protected here/s);
    }
    assert.equal(c.mainAt(), td, 'main moved locally');
    assert.ok(landLockFree(c));
  } finally {
    c.stop();
  }
});

test('batches: a scheme that sets no LAND_BATCH batches up to 4 (#1321), and the fifth in line gets the next batch', async () => {
  const c = ciSetup(5, { stack: '1', batch: 'default', check: gated });
  try {
    const all = await c.lands(1, 2, 3, 4, 5);
    c.open();
    const t4 = await c.tip(all[3]);
    assert.deepEqual(c.scratch(), [`land/ticket/4-x ${t4}`], 'one run for the first four');
    c.verdict(t4, GREEN);
    for (const [i, l] of all.slice(0, 4).entries()) {
      assert.equal(await l.exit, 0, l.stderr());
      assert.match(l.stderr().trimEnd().split('\n').pop()!, new RegExp(`^ship: landed [0-9a-f]{12} batch ${i + 1} of 4 deploy none$`));
    }
    assert.equal(c.mainAt(), t4);
    const t5 = await c.tip(all[4]);
    c.verdict(t5, GREEN);
    assert.equal(await all[4].exit, 0, all[4].stderr());
    assert.equal(all[4].stderr().trimEnd().split('\n').pop(), `ship: landed ${t5} batch 1 of 1 deploy none`);
    assert.deepEqual(c.sent(all[4]), [t5], "one run, on main's new tip: never on a member that landed but hadn't left the line yet");
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5']);
  } finally {
    c.stop();
  }
});

// CO3 (#1866): members that landed leave one by one, and while they did the ones behind counted them into batches of
// their own, so each became a batch's top for a moment and pushed a run.
for (const stack of ['1', '']) {
  test(`batches: while a batch that landed leaves the line, the next one still pushes one run, its top's (CI_STACK ${stack || 'unset'})`, async () => {
    const c = ciSetup(8, { stack, batch: 'default', check: gated });
    try {
      // main's push is slow, as GitHub's is, so the members that wait for it leave after the head.
      writeFileSync(join(c.origin, 'hooks', 'update'), '#!/bin/bash\n[ "$1" != refs/heads/main ] || sleep 1\n', { mode: 0o755 });
      const all = await c.lands(1, 2, 3, 4, 5, 6, 7, 8);
      c.open();
      const t4 = await c.tip(all[3]);
      await until(
        "the second batch's builds",
        () =>
          c
            .tickets()
            .slice(4)
            .filter((t) => /^checked|CI/.test(c.phase(t))).length === 4,
      );
      c.verdict(t4, GREEN);
      for (const l of all.slice(0, 4)) assert.equal(await l.exit, 0, l.stderr());
      const t8 = await c.tip(all[7]);
      c.verdict(t8, GREEN);
      for (const l of all.slice(4)) assert.equal(await l.exit, 0, l.stderr());
      assert.deepEqual(
        all.map((l) => c.sent(l)),
        [[], [], [], [t4], [], [], [], [t8]],
        'one run for each batch, on its top',
      );
      assert.equal(c.mainAt(), t8);
      assert.equal(all[7].stderr().trimEnd().split('\n').pop(), `ship: landed ${t8} batch 4 of 4 deploy none`);
    } finally {
      c.stop();
    }
  });
}

test("batches: a landing that changes the pipeline (a PIPELINE_FILES path) ships alone, and the ones around it can't batch over it", async () => {
  const c = ciSetup(3, { batch: 'default', stack: '1', check: gated, files: (i) => (i === 2 ? 'deploy/run.sh' : `f${i}.txt`), local: 'PIPELINE_FILES=pipe.txt\n' });
  try {
    c.commit(c.main, 'pipe.txt', '# the deploy script\ndeploy/\n'); // main's list counts: a trailing / covers the folder
    const all = await c.lands(1, 2, 3);
    c.open();
    assert.match(all[1].stderr(), /deploy\/run\.sh is part of the pipeline, so this ships alone, in no batch/);
    for (const l of all) {
      const t = await c.tip(l);
      c.verdict(t, GREEN);
      assert.equal(await l.exit, 0, l.stderr());
      assert.equal(l.stderr().trimEnd().split('\n').pop(), `ship: landed ${t} batch 1 of 1 deploy none`);
      assert.deepEqual(c.sent(l), [t], 'its own run, on its own commit, once');
    }
    assert.doesNotMatch(all[0].stderr() + all[2].stderr(), /ships alone|landed in a batch/);
    assert.deepEqual(c.landed(), ['pipe.txt: # the deploy script deploy/', 'f1.txt: 1', 'deploy/run.sh: 2', 'f3.txt: 3']);
  } finally {
    c.stop();
  }
});

test("batches: a batch whose top's CI passed on its LAND_KNOWN_RED lands, though the head has none of its own", async () => {
  const c = ciSetup(2, { batch: '2', stack: '1', check: gated });
  try {
    writeFileSync(join(c.ci, 'status.sh'), '#!/bin/bash\nread -r code <"$CI_DIR/${1:0:12}" 2>/dev/null || code=3\n[ "$code" != 1 ] || echo "ci.yml: completed failure https://x"\nexit "$code"\n', { mode: 0o755 });
    const [a] = await c.lands(1);
    const b = c.land(2, { LAND_KNOWN_RED: 'ci:ci.yml\t#42 is fixing it' });
    await until('both tickets', () => c.issued() === 2);
    c.open();
    const tb = await c.tip(b);
    c.verdict(tb, RED);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.match(b.stderr(), /failed only on known reds, so it goes on: ci:ci\.yml: known red, #42 is fixing it/);
    assert.equal(git(c.main, 'rev-parse', 'main').slice(0, 12), tb);
  } finally {
    c.stop();
  }
});

// land_deploy (#1321): logs its commit and where main's checkout is, waits for deploy.go, fails with deploy.fail.
const deployHook = `land_deploy() {
  local c
  c=$(git rev-parse --path-format=absolute --git-common-dir)
  echo "$1 $(git rev-parse HEAD)" >>"$c/deploy.log"
  until [ -e "$c/deploy.go" ]; do sleep 0.05; done
  [ ! -e "$c/deploy.fail" ] || return 3
  echo deploying
  echo live
}
`;
const deploySetup = () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated, local: deployHook });
  const deploys = () => {
    try {
      return readFileSync(join(c.state, 'deploy.log'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const waiting = () => c.tickets().filter((t) => c.phase(t) === "waiting for its batch's deploy").length;
  return { ...c, deploys, waiting };
};

test('batches: with land_deploy the head deploys the batch once, in the main checkout, before main is pushed; the members wait for its word', async () => {
  const c = deploySetup();
  try {
    const before = c.mainAt();
    const all = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(all[2]);
    c.verdict(td, GREEN);
    // The members can wait on the deploy before the head's hook has written its line: wait for both.
    await until('the members waiting on the deploy, and the head deploying', () => c.waiting() === 2 && c.deploys().length > 0);
    const full = git(c.main, 'rev-parse', td);
    assert.deepEqual(c.deploys(), [`${full} ${full}`], 'once, for the deepest commit, with main checked out there');
    assert.equal(c.mainAt(), td, 'main moved');
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), before, 'and is not pushed while it deploys');
    assert.deepEqual(
      all.map((l) => l.child.exitCode),
      [null, null, null],
      'nobody has said it shipped',
    );
    writeFileSync(join(c.state, 'deploy.go'), '');
    for (const [i, l] of all.entries()) {
      assert.equal(await l.exit, 0, l.stderr());
      assert.match(l.stderr().trimEnd().split('\n').pop()!, new RegExp(`^ship: landed [0-9a-f]{12} batch ${i + 1} of 3 deploy live$`));
    }
    assert.match(all[0].stderr(), /main is now at [0-9a-f]+ "f3\.txt: 3"\ndeploying\nlive\nland: land_deploy deployed [0-9a-f]{12} \(live\)/);
    assert.equal(c.deploys().length, 1, 'the members deployed nothing');
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), td, 'pushed once deployed');
  } finally {
    c.stop();
  }
});

test('batches: a land_deploy that fails takes main back, and the head and every member say they did not ship', async () => {
  const c = deploySetup();
  try {
    const before = c.mainAt();
    const all = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(all[2]);
    c.verdict(td, GREEN);
    await until('the members waiting on the deploy', () => c.waiting() === 2);
    writeFileSync(join(c.state, 'deploy.fail'), '');
    writeFileSync(join(c.state, 'deploy.go'), '');
    for (const l of all) {
      assert.equal(await l.exit, 1, l.stderr());
      assert.match(l.stderr().trimEnd().split('\n').pop()!, /^ship: refused [0-9a-f]{12} batch \d of \d deploy back$/);
    }
    assert.match(all[0].stderr(), new RegExp(`land_deploy failed \\(exit 3\\), so main went back to ${before} and nothing shipped, nor did the others in its batch \\(ticket/2-x, ticket/3-x\\)`));
    for (const l of all.slice(1)) assert.match(l.stderr(), new RegExp(`didn't ship: its batch's deploy failed, so main went back to ${before} without`));
    assert.equal(c.mainAt(), before);
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), before, 'never pushed');
    assert.deepEqual(c.landed(), []);
    assert.deepEqual(c.tickets(), []);
    assert.ok(landLockFree(c));
  } finally {
    c.stop();
  }
});

test('batches: a head killed while deploying leaves the lock free; its members say they did not ship, and the next landing takes main back first', async () => {
  const c = deploySetup();
  try {
    const before = c.mainAt();
    const all = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(all[2]);
    c.verdict(td, GREEN);
    await until('the members waiting on the deploy', () => c.waiting() === 2);
    all[0].child.kill('SIGKILL'); // its land_deploy goes on, waiting for deploy.go, and must not hold the lock
    for (const l of all.slice(1)) {
      assert.equal(await l.exit, 1, l.stderr());
      assert.match(l.stderr(), new RegExp(`stopped while deploying [0-9a-f]{40}, which holds [0-9a-f]{12}, so it didn't ship: the next landing takes main back to ${before}`));
    }
    assert.equal(c.mainAt(), td, 'main still where the killed head moved it');
    const again = c.land(2);
    await until(`the next landing to take main back: ${again.stderr()}`, () => /the landing before this one stopped while deploying/.test(again.stderr()));
    assert.match(again.stderr(), new RegExp(`stopped while deploying ${td}, so main went back to ${before}, where it found it`));
    c.verdict(await c.tip(again), GREEN);
    writeFileSync(join(c.state, 'deploy.go'), '');
    assert.equal(await again.exit, 0, again.stderr());
    assert.deepEqual(c.landed(), ['f2.txt: 2'], "the killed batch's commits never shipped");
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), c.mainAt());
  } finally {
    c.stop();
  }
});

test("batches: the head runs land.local.sh's land_after for itself and each member it landed, once main is pushed", async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: gated, local: 'land_after() { echo "$1 $2" >>"$(git rev-parse --path-format=absolute --git-common-dir)/after.log"; }\n' });
  try {
    const log = join(c.state, 'after.log');
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    const tb = c.parent(td);
    const ta = c.parent(tb);
    c.verdict(td, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    // Every landing shares the log, so a member that ran the hook itself would add a line of its own.
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.replace(/^(.{12})\S*/, '$1'));
    assert.deepEqual(lines, [`${ta} ticket/1-x`, `${tb} ticket/2-x`, `${td} ticket/3-x`]);
  } finally {
    c.stop();
  }
});
