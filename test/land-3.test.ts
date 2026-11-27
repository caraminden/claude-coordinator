// Part 3 of 4 of the land tests (#2208); the shared setup is in land-setup.ts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, tickets, issued, ci, quietProc } from './land-fixture.ts';
import { until } from './wait.ts';
import { timings, waits, procAt, once, retries, flaky, killer, newerLandOnMain } from './land-setup.ts';

test('CI with no answer and a perigee busy past the limit refuse the ship: main untouched, no suite run', async () => {
  for (const extra of [{ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' }, { LAND_CI: '0' }]) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const main = git(r.source, 'rev-parse', 'main');
    const heavy = join(r.dir, 'heavy');
    mkdirSync(heavy);
    // A heavy job holding the slot is busy too, and named.
    writeFileSync(join(heavy, 'slot-0.who'), 'peek #9 cargo test');
    const holder = spawn('flock', [join(heavy, 'slot-0'), 'sleep', '30'], { stdio: 'ignore', detached: true });
    try {
      await until('the slot is held', () => spawnSync('flock', ['-n', join(heavy, 'slot-0'), 'true']).status !== 0);
      const res = c.run({ ...extra, ...procAt(r), LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2' });
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, /CI and perigee both busy, try again: CI: .*; perigee for 0 min: perigee's heavy slot is taken \(peek #9 cargo test\)/);
      assert.match(res.stderr, /not your change: keeping its place.*refused by the pipeline again \(CI and perigee both busy for 0 min\), after its one retry in place/s, 'alone in line, it goes again once, then refuses');
      assert.doesNotMatch(res.stderr, /CI FALLBACK/);
      assert.equal(c.localRuns(), 0);
      assert.equal(git(r.source, 'rev-parse', 'main'), main);
    } finally {
      process.kill(-(holder.pid as number), 'SIGKILL'); // flock's child, the sleep, goes too: it must not outlive the file
    }
  }
});

// A test that takes the runner down: every run is red with no failed step, so each gate ends with no answer, from runs
// that did finish. The time CI runs for doesn't count as a busy perigee's (#1361), so the runs do.
for (const [what, env] of [
  ['', {}],
  [', its runner gone for the fresh run', { FAKE_RUNNERS_ODD: '1' }],
] as const) {
  test(`a run that ends without a verdict every time holds the line for three goes, not for ever${what} (#1864)`, async () => {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = await c.runAsync({ FAKE_CI: 'red', FAKE_STEP: 'lost', FAKE_CI_SLOW: '1', ...env, ...procAt(r, { load: 999 }), LAND_QUIET_POLL: '0.2' }, () => {});
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /refused by the pipeline \(CI's runs were lost or cut off 3 times, and perigee is busy\), not your change: keeping its place/);
    assert.match(res.stderr, /CI and perigee both busy, try again: CI: .*\(its runs were lost or cut off 3 times\); perigee/);
    assert.equal(c.localRuns(), 0);
  });
}

test('a ship refused because CI and perigee were both busy keeps its ticket, goes again, and lands on that run (#1360)', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const p = procAt(r, { load: 999 });
  let flipped = false;
  const res = await c.runAsync({ LAND_CI: '0', ...p, LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2', COORDINATOR_SHARED_DIR: shared }, (s) => {
    if (!flipped && /not your change/.test(s)) {
      flipped = true;
      quietProc(p.LAND_QUIET_PROC);
    }
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /refused by the pipeline \(CI and perigee both busy for 0 min\), not your change: keeping its place in line and riding the next train, once/);
  assert.match(res.stderr, /back at the front after its retry in place: starting over from the rebase.*CI FALLBACK/s);
  assert.equal(c.localRuns(), 1);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  assert.equal(issued(state), 1, 'the same ticket, not a new one at the back');
  assert.deepEqual(
    retries(shared).map((l) => l.replace(/^- \S+ /, '')),
    ['· retry in place · ticket/1-x · CI and perigee both busy for 0 min · landed'],
  );
  assert.equal(timings(shared).length, 1, 'one landing, one timing line');
});

test('a retry in place that then conflicts with main is refused, and its retro line says refused (#1360)', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'a.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const p = procAt(r, { load: 999 });
  let moved = false;
  const res = await c.runAsync({ LAND_CI: '0', LAND_SMOKE: '0', ...p, LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2', COORDINATOR_SHARED_DIR: shared }, (s) => {
    if (!moved && /not your change/.test(s)) {
      moved = true;
      r.commit(r.source, 'a.txt', 'theirs\n');
      quietProc(p.LAND_QUIET_PROC);
    }
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /back at the front after its retry in place.*rebase onto main failed/s);
  assert.match(retries(shared)[0] ?? '', /· retry in place · ticket\/1-x · CI and perigee both busy for 0 min · refused$/);
});

test("a ship whose suite couldn't start because the heavy slot was taken goes again once, and lands (#1360)", async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const p = procAt(r);
  mkdirSync(p.CITADEL_HEAVY_DIR, { recursive: true });
  // A deploy build going first holds citadel-heavy up without quiet() seeing it, as one that takes the slot after it looked.
  const first = join(p.CITADEL_HEAVY_DIR, 'first');
  writeFileSync(first, 'deploy build: npm ci\n');
  const fresh = setInterval(() => {
    if (existsSync(first)) writeFileSync(first, 'deploy build: npm ci\n');
  }, 200);
  try {
    const res = await c.runAsync({ LAND_CI: '0', ...p, LAND_HEAVY_MAX_WAIT: '1', COORDINATOR_SHARED_DIR: shared }, (s) => {
      if (/not your change/.test(s)) rmSync(first, { force: true });
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /refused by the pipeline \(perigee's heavy slot was taken\), not your change/);
    assert.equal(c.localRuns(), 1);
    assert.match(retries(shared)[0], /· retry in place · ticket\/1-x · perigee's heavy slot was taken · landed$/);
  } finally {
    clearInterval(fresh);
  }
});

test('a perigee run killed from outside before any test failed goes again once, and lands on a green run (#1393)', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'test/killer.test.mjs', killer);
  const shared = join(r.dir, 'shared');
  const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', KILL_COUNT: join(r.dir, 'count'), KILL_ON: '1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /run-tests: the tests were killed \(exit 137\)/);
  assert.match(res.stderr, /refused by the pipeline \(the suite on perigee was killed from outside before any test failed\), not your change/);
  assert.doesNotMatch(res.stderr, /a test hung|tests failed on the rebased branch/);
  assert.match(retries(shared)[0], /· retry in place · ticket\/1-x · the suite on perigee was killed from outside before any test failed · landed$/);
});

test('a perigee red of flakes only goes again once: green lands, red again refuses for good (#1360)', () => {
  for (const [fails, status, outcome] of [
    ['1', 0, 'landed'],
    ['1,3', 1, 'refused'],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'test/flaky.test.mjs', flaky);
    const shared = join(r.dir, 'shared');
    const main = git(r.source, 'rev-parse', 'main');
    const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: fails, COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, status, res.stderr);
    assert.match(res.stderr, /refused by the pipeline \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), not your change/);
    assert.equal(readFileSync(join(r.dir, 'count'), 'utf8'), fails === '1' ? '3' : '4', 'the full run and the rerun alone, twice over at most');
    assert.match(retries(shared)[0], new RegExp(`· retry in place · ticket/1-x · failed in the full run but passed alone on perigee: test/flaky\\.test\\.mjs · ${outcome}$`));
    if (status) {
      assert.match(res.stderr, /refused by the pipeline again \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), after its one retry in place.*tests failed on the rebased branch/s);
      assert.equal(git(r.source, 'rev-parse', 'main'), main, 'red stays red');
    }
  }
});

test('the copy a rebase hands over to counts its gh calls and keeps the flake keeps the hand-off has used', () => {
  const r = setup();
  ci(r);
  const run = newerLandOnMain(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', LAND_FLAKE_KEPT: '2', COORDINATOR_SHARED_DIR: join(r.dir, 'shared') });
  assert.equal(res.status, 1, res.stderr);
  const state = join(r.live, '.git', 'cc-deploy');
  assert.match(readFileSync(join(state, 'gh-calls'), 'utf8'), /^\d+ ticket\/1-x api repos\/\S+\/actions\/runs\?head_sha=/m, "the rebased copy's CI asks are counted (#1655)");
  assert.doesNotMatch(res.stderr + (existsSync(join(state, 'ci.err')) ? readFileSync(join(state, 'ci.err'), 'utf8') : ''), /command not found/);
  assert.match(res.stderr, /only flakes failed again \(test\/busy\.test\.ts, test\/slow\.test\.ts\), but it has kept its place 2 times already, so it is refused this time/);
  assert.doesNotMatch(res.stderr, /keeping its place in line/, 'the rebased copy counts the 2 keeps the first copy was handed');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('the copy a rebase hands over to keeps the one retry in place the hand-off has used', () => {
  const r = setup();
  ci(r);
  const run = newerLandOnMain(r);
  r.commit(r.wt, 'test/flaky.test.mjs', flaky);
  const main = git(r.source, 'rev-parse', 'main');
  const res = run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', LAND_RETRIED: 'an earlier refusal', COORDINATOR_SHARED_DIR: join(r.dir, 'shared') });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /refused by the pipeline again \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), after its one retry in place \(an earlier refusal\)/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('the copy that starts over after main moved under the restart ahead keeps the one retry in place the hand-off has used', () => {
  const r = setup();
  ci(r);
  newerLandOnMain(r);
  // Its first run moves main on (as a restart ahead rolled back does), so the gate's commit is stale and land.sh starts
  // over from the rebase; its second full run fails on a flake, which passes alone.
  r.commit(
    r.wt,
    'test/move.test.mjs',
    "import { execFileSync } from 'node:child_process';\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.MOVE_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if (n === 1) execFileSync('git', ['-C', process.env.MOVE_MAIN, 'commit', '-q', '--allow-empty', '-m', 'someone else']);\n  if (n === 2) throw new Error('flaky');\n}\n",
  );
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], {
    cwd: r.wt,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), LAND_CI: '0', LAND_SMOKE: '0', MOVE_COUNT: join(r.dir, 'count'), MOVE_MAIN: r.source, LAND_RETRIED: 'an earlier refusal', COORDINATOR_SHARED_DIR: join(r.dir, 'shared') },
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /while this waited \(the restart ahead was rolled back\): rebasing ticket\/1-x onto it and testing again/);
  assert.match(res.stderr, /refused by the pipeline again \(failed in the full run but passed alone on perigee: test\/move\.test\.mjs\), after its one retry in place \(an earlier refusal\)/);
});

// A CI fallback's suite first waits for perigee's heavy slot, up to the busy limit and citadel-heavy's load and memory
// waits, longer than the 15 min the line behind waits on an unchanged phase: so the phase moves on meanwhile.
test('a CI fallback moves its phase on while it waits for a heavy slot and runs, so the line behind sees progress', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  mkdirSync(join(r.dir, 'heavy'));
  const queue = join(r.live, '.git', 'cc-deploy', 'queue');
  const phases = new Set<string>();
  const look = setInterval(() => {
    for (const f of tickets(join(r.live, '.git', 'cc-deploy')))
      try {
        phases.add(readFileSync(join(queue, f), 'utf8').split('\n')[3]);
      } catch {}
  }, 50);
  try {
    // A box citadel-heavy calls busy (any pressure at all), for 3 s before it starts anyway.
    // Its own slot folder: with no past runs to judge by, the suite takes a slot rather than run at once.
    const res = await c.runAsync({ LAND_CI: '0', LAND_SMOKE: '0', CITADEL_HEAVY_DIR: join(r.dir, 'heavy'), CITADEL_HEAVY_MAX_PRESSURE: '0', CITADEL_HEAVY_LOAD_WAIT: '3', CITADEL_HEAVY_POLL: '0.2', LAND_PHASE_EVERY: '0.5' }, () => {});
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /the box is busy/);
  } finally {
    clearInterval(look);
  }
  const during = [...phases].filter((p) => p.startsWith('running the tests since'));
  assert.ok(
    during.some((p) => / min so far/.test(p)),
    `the phase moved on while it waited: ${[...phases].join(' | ')}`,
  );
});

test("a CI fallback's phase ticker leaves the reruns' phase alone once they start, so the line behind reads their counts", async () => {
  const r = setup();
  const c = ci(r);
  // Fails in the full run; alone, it takes a few ticks and passes, so the reruns' phase has to outlast them.
  r.commit(r.wt, 'test/slow-flake.test.mjs', flaky + "if (Number(readFileSync(f, 'utf8')) > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n");
  const queue = join(r.live, '.git', 'cc-deploy', 'queue');
  const seen: string[] = [];
  const look = setInterval(() => {
    for (const f of tickets(join(r.live, '.git', 'cc-deploy')))
      try {
        const p = readFileSync(join(queue, f), 'utf8').split('\n')[3];
        if (p && p !== seen.at(-1)) seen.push(p);
      } catch {}
  }, 50);
  try {
    const res = await c.runAsync({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', LAND_PHASE_EVERY: '0.3' }, () => {});
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /slow-flake\.test\.mjs: failed in the full run, passed alone/);
  } finally {
    clearInterval(look);
  }
  const rerun = seen.findIndex((p) => p.startsWith('rerunning 1 failed test file since'));
  assert.ok(rerun >= 0, `the reruns set their phase: ${seen.join(' | ')}`);
  // What follows is the land's own next step (a flake goes again from the rebase), never the ticker's count.
  assert.doesNotMatch(seen[rerun + 1] ?? '', /^running the tests since/, `the ticker wrote over the reruns' phase: ${seen.join(' | ')}`);
});
