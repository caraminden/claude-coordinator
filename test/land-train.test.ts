// The ship train (#1166, tools/land.sh): the landing at the front of the line takes the plain lands waiting behind it,
// tests them in one CI run and ships them in one deploy; a red train is bisected, and its first red ship refused.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen, setup, landAsync, tickets, issued, quietProc } from './land-fixture.ts';
import { until } from './wait.ts';

type Ship = { change?: [string, string]; also?: [string, string]; env?: Record<string, string>; on?: number };

// Ship 1 (ticket/1-x) lands alone and holds the lock in its deploy until every other ship is in line behind it, so
// ship 2 is the front of a train with the rest behind it. Ship i changes f<i>.txt unless it says otherwise, and starts
// from main, or from ship <on>'s branch.
async function line(ships: Ship[], extra: Record<string, string> | ((dir: string) => Record<string, string>) = {}, before?: (r: ReturnType<typeof setup>) => void) {
  const r = setup();
  const c = ci(r);
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  before?.(r);
  const deploys = join(r.dir, 'deploys');
  const env = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FAKE_DEPLOY_GATE: join(r.dir, 'gate'), FAKE_DEPLOY_LOG: deploys, DEPLOY_QUEUE_POLL: '0.05', PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', ...(typeof extra === 'function' ? extra(r.dir) : extra) };
  const wts = [r.wt];
  for (let i = 2; i <= ships.length; i++) {
    wts.push(join(r.dir, `wt${i}`));
    git(r.source, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[i - 1], ...(ships[i - 1].on ? [`ticket/${ships[i - 1].on}-x`] : []));
  }
  ships.forEach((s, i) => s.on || r.commit(wts[i], ...(s.change ?? [`f${i + 1}.txt`, `${i + 1}\n`])));
  ships.forEach((s, i) => s.on && (git(wts[i], 'reset', '-q', '--hard', `ticket/${s.on}-x`), r.commit(wts[i], ...(s.change ?? [`f${i + 1}.txt`, `${i + 1}\n`]))));
  ships.forEach((s, i) => s.also && r.commit(wts[i], ...s.also));
  const was = wts.map((wt) => git(wt, 'rev-parse', 'HEAD'));
  const out = wts.map(() => '');
  const lands = [landAsync(wts[0], { ...env, ...ships[0].env }, 150_000, (s) => (out[0] = s))];
  await until('ship 1 in its deploy', () => r.note() !== null);
  for (let i = 2; i <= ships.length; i++) {
    lands.push(landAsync(wts[i - 1], { ...env, ...ships[i - 1].env }, 150_000, (s) => (out[i - 1] = s)));
    await until(`ship ${i}'s ticket`, () => issued(state) === i);
    await until(`ship ${i} in line`, () => / in line for the deploy lock/.test(out[i - 1]));
  }
  const go = async () => {
    writeFileSync(join(r.dir, 'gate'), '');
    return Promise.all(lands);
  };
  const runs = () => new Set(c.calls().match(/head_sha=[0-9a-f]+/g)).size; // the commits CI was asked about
  const deployed = () => (existsSync(deploys) ? readFileSync(deploys, 'utf8').trim().split('\n') : []);
  const subjects = () => git(r.source, 'log', '--reverse', '--format=%s', 'main').split('\n');
  const done = () => {
    assert.deepEqual(tickets(state), [], 'every ticket is gone');
    assert.deepEqual(existsSync(join(state, 'train')) ? readdirSync(join(state, 'train')) : [], [], 'no verdict is left');
  };
  return { r, c, state, wts, was, out, go, runs, deployed, subjects, done };
}
// A rider's own shipped line: main at its own train commit, which its branch now points at, and how it went live.
function shipped(l: Awaited<ReturnType<typeof line>>, d: { status: number | null; stderr: string }, i: number, front: number, of: number) {
  assert.equal(d.status, 0, `ship ${i}: ${d.stderr}`);
  assert.match(d.stderr, new RegExp(`shipped in ticket/${front}-x's ship train of ${of} ships`));
  const tip = git(l.r.source, 'rev-parse', `ticket/${i}-x`);
  const subject = git(l.r.source, 'log', '-1', '--format=%s', l.was[i - 1]);
  assert.notEqual(tip, l.was[i - 1], `ship ${i}'s branch moved to its train commit`);
  assert.equal(git(l.r.source, 'log', '-1', '--format=%s', tip), subject);
  assert.equal(git(l.r.source, 'merge-base', '--is-ancestor', tip, 'main'), '');
  // What the server reads (src/land.ts landResult): the last "main is now at", and deploy.sh's "live now:".
  assert.equal([...d.stderr.matchAll(/main is now at ([0-9a-f]{7,40}) "(.*)"/g)].pop()?.slice(1).join(' '), `${tip.slice(0, 7)} ${subject}`);
  assert.match(d.stderr, /^deploy: live now:/m);
}

test('five ships waiting in line ship as one train: one CI run, one deploy, each with its own shipped line', async () => {
  const l = await line([{}, {}, {}, {}, {}, {}]);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.deepEqual(l.subjects(), ['base', ...done.map((_, i) => `f${i + 1}.txt: ${i + 1}`)]);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 4 ships waiting behind it \(ticket\/3-x ticket\/4-x ticket\/5-x ticket\/6-x\): CI runs once on all 5/);
  assert.equal(l.runs(), 2, "ship 1's run and the train's");
  assert.deepEqual(l.deployed(), [git(l.r.source, 'rev-parse', 'main~5'), git(l.r.source, 'rev-parse', 'main')], "ship 1's deploy and the train's");
  for (let i = 3; i <= 6; i++) {
    shipped(l, done[i - 1], i, 2, 5);
    assert.doesNotMatch(done[i - 1].stderr, /land: rebasing/, 'a rider never rebases or tests on its own');
  }
  l.done();
});

test("a red train is bisected: the ship that turned it red is refused with its own failure, and the other four ship", async () => {
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\), and its bisect found ticket\/4-x the first ship that turned it red/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'its own failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the red ship is as it was');
  assert.match(done[1].stderr, /suspects: no ship on the train touched test\/real\.test\.ts or what it imports, so the bisect looks for the ship/, 'the real failure maps to no ship (#1346)');
  assert.match(done[1].stderr, /the bisect found ticket\/4-x the first ship that turned the train red \(https:\/\/ci\/\d+\): it is refused, and the 1 before it ship/);
  for (const i of [1, 2, 3, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  // The ships after the red one went back in line, and shipped as the next train.
  assert.match(done[4].stderr, /back in line on its own: the ship train went without ticket\/5-x/);
  shipped(l, done[5], 6, 5, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6']);
  assert.equal(l.runs(), 5, "ship 1's, the train's, two for the bisect, and the next train's");
  assert.equal(l.deployed().length, 3);
  l.done();
});

// Suspects first (#1346): a real failure (the fake's log says test/real.test.ts failed again alone) is pinned on the ships
// whose change touched that test or what it imports; they are refused, and the train runs again without them.
test('a red train whose real failure maps to one ship: only it is refused, the next in line takes its place, and the rest ship on one more CI run', async () => {
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', 'red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'test/real.test.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /land: tests failed in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\) in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed, so it is likely the cause/);
  assert.match(done[3].stderr, /not ok 1 - the red test's output/, 'the failure, on its own stderr');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'the suspect is as it was');
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 3 ships waiting behind it \(ticket\/3-x ticket\/5-x ticket\/6-x\)/, 'ship 6 takes its place');
  assert.doesNotMatch(done[1].stderr, /bisect/);
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 5, 6]) shipped(l, done[i - 1], i, 2, 4);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 4, "ship 1's, the red train's, the refilled train's, and ship 7's");
  assert.equal(l.deployed().length, 3);
  l.done();
});

test("a suspect found through what the failing test imports is refused, and a ship stacked on it stays out of the refill rather than bring its change back", async () => {
  // Ship 1 adds the test, importing x.ts; ship 4 adds x.ts, which turns CI red; ship 5 starts from ship 4's branch.
  const l = await line([{ change: ['test/real.test.ts', "import '../x.ts';\n"] }, {}, {}, { change: ['x.ts', 'x\n'] }, { on: 4 }, {}, {}], { FAKE_RED_PATH: 'x.ts', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.match(done[3].stderr, /in test\/real\.test\.ts, which ticket\/4-x changed or which imports what it changed, so it is likely the cause.*Look into it: fix it if it is yours, re-test, commit, then run this again/s);
  assert.match(done[1].stderr, /ship train: ticket\/5-x stays in line \(it sits on a ship this train just refused\)/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 3 ships waiting behind it \(ticket\/3-x ticket\/6-x ticket\/7-x\)/);
  assert.doesNotMatch(done[1].stderr, /red again|bisect/);
  for (const i of [1, 2, 3, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  for (const i of [3, 6, 7]) shipped(l, done[i - 1], i, 2, 4);
  assert.equal(done[3].status, 1);
  assert.equal(done[4].status, 1, 'ship 5 carries ship 4\'s change, so it is red on its own turn');
  assert.deepEqual(l.subjects(), ['base', 'test/real.test.ts: import \'../x.ts\';', 'f2.txt: 2', 'f3.txt: 3', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 4, "ship 1's, the red train's, the refilled train's, and ship 5's");
  l.done();
});

// #1443: a red burn-in names its racy file, so the ship that added or changed it is the suspect, with no bisect.
test('a train red in its burn-in: the ship that changed the racy test is refused with the burn-in\'s words, and the rest ship', async () => {
  const l = await line([{}, {}, { change: ['test/real.test.ts', 'racy\n'] }, {}], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn' });
  const done = await l.go();
  assert.equal(done[2].status, 1, done[2].stderr);
  assert.match(done[2].stderr, /land: a new or changed test failed its burn-in in CI on ticket\/2-x's ship train \(https:\/\/ci\/\d+\): test\/real\.test\.ts, which ticket\/3-x changed or which imports what it changed, so it is likely the cause, and it was taken off the train/);
  assert.match(done[1].stderr, /suspects: #3 \(test\/real\.test\.ts\)/);
  assert.doesNotMatch(done[1].stderr, /bisect|running CI once more/);
  for (const i of [1, 2, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[3], 4, 2, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f4.txt: 4']);
  l.done();
});

test('a refilled train red again on the same test: the guess was wrong, so the bisect finds the ship', async () => {
  // Ship 4 touched the failing test, but ship 5 is what turns CI red.
  const l = await line([{}, {}, {}, { change: ['test/real.test.ts', 'x\n'] }, { change: ['red.txt', 'red\n'] }, {}, {}], { FAKE_RED_PATH: 'red.txt', LAND_TRAIN_MAX: '3' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\)/);
  assert.match(done[3].stderr, /so it is likely the cause/, 'the innocent suspect is bounced: the accepted cost');
  assert.match(done[1].stderr, /red again on test\/real\.test\.ts with the likely causes off the train, so the guess was wrong: the bisect looks for the ship/);
  assert.match(done[1].stderr, /the bisect found ticket\/5-x the first ship that turned the train red \(https:\/\/ci\/\d+\): it is refused, and the 1 before it ship/);
  assert.equal(done[4].status, 1, done[4].stderr);
  assert.match(done[4].stderr, /its bisect found ticket\/5-x the first ship that turned it red/);
  for (const i of [1, 2, 3, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  shipped(l, done[6], 7, 6, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f6.txt: 6', 'f7.txt: 7']);
  assert.equal(l.runs(), 6, "ship 1's, the red train's, the refilled train's, two for the bisect, and the next train's");
  l.done();
});

test("a failed test file CI didn't rerun alone may be load or real, so it names no suspect and the bisect finds the ship", async () => {
  const l = await line([{}, {}, {}, { change: ['test/busy.test.ts', 'x\n'] }], { FAKE_RED_PATH: 'test/busy.test.ts', FAKE_LOG: 'due' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: CI's log doesn't say which tests really failed, so the bisect looks for the ship/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /its bisect found ticket\/4-x the first ship that turned it red/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  l.done();
});

test("a file CI didn't rerun because a real failure already made the run red names no suspect: only the confirmed failure's ship is refused", async () => {
  const l = await line([{}, {}, { change: ['test/busy.test.ts', 'x\n'] }, { change: ['test/real.test.ts', 'red\n'] }], { FAKE_RED_PATH: 'test/real.test.ts', FAKE_LOG: 'after-real' });
  const done = await l.go();
  assert.match(done[1].stderr, /suspects: #4 \(test\/real\.test\.ts\): CI is red/);
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.match(done[3].stderr, /so it is likely the cause/);
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  assert.equal(l.runs(), 3, "ship 1's, the red train's and the refilled train's");
  l.done();
});

test("a train's red of flakes only is unchanged: one fresh run, and a ship that touched the flaky test still rides", async () => {
  const l = await line([{}, {}, { change: ['test/slow.test.ts', 'x\n'] }, {}], { FAKE_FLAKY_PATH: 'test/slow.test.ts', FAKE_LOG: 'flakes' });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /only flakes failed \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more/);
  assert.doesNotMatch(done[1].stderr, /suspects|bisect/);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[3], 4, 2, 3);
  assert.equal(l.runs(), 2, "ship 1's and the train's, run twice");
  assert.equal(l.deployed().length, 2);
  l.done();
});

// #1419: known flakes (seen passing alone on another branch) ship the whole train with no fresh run, and every rider
// says so; a known flake one rider touched isn't excused, so the train gets #769's one fresh run as before.
test("a train's red of known flakes only ships every rider on that one run; one a rider touched gets the fresh run", async () => {
  for (const touched of [false, true]) {
    let shared = '';
    const l = await line([{}, {}, touched ? { change: ['test/slow.test.ts', 'x\n'] } : {}, {}], (dir) => ({ FAKE_FLAKY_PATH: touched ? 'test/slow.test.ts' : 'f2.txt', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: join(dir, 'shared') }),
      (r) => seen(shared = join(r.dir, 'shared'), ['test/busy.test.ts', 'test/slow.test.ts']));
    const done = await l.go();
    done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
    if (touched) {
      assert.match(done[1].stderr, /test\/slow\.test\.ts is a known flake, but #3 changed it or what it imports, so it isn't excused/);
      assert.match(done[1].stderr, /only flakes failed \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more/);
      assert.doesNotMatch(done.map((d) => d.stderr).join('\n'), /shipped past/);
    } else {
      assert.doesNotMatch(done[1].stderr, /running CI once more/);
      for (const i of [1, 2, 3]) assert.match(done[i].stderr, /^land: shipped past known flakes test\/busy\.test\.ts \(seen on 1 other branch in 14 days\), test\/slow\.test\.ts \(seen on 1 other branch in 14 days\)$/m, `ship ${i + 1}`);
      // The train's sighting names its riders, so none of them ships past it later as "another branch's" flake.
      const log = readdirSync(join(shared, 'retro-log')).map((d) => readFileSync(join(shared, 'retro-log', d, 'land.md'), 'utf8')).join('');
      assert.match(log, /· flake · test\/busy\.test\.ts · load [\d.]+ · \S+ · in CI · with \S+ \S+$/m);
    }
    assert.equal(l.runs(), 2, "ship 1's and the train's");
    assert.equal(l.deployed().length, 2);
    l.done();
  }
});

// #1377: on Nov 20 a bisect refused #1302 for a run interrupted at 55 s with no failing test (#1372's report).
test('a bisect run cut off twice before any test failed refuses nobody: the train goes back in line, and only a real red refuses', async () => {
  // Ship 1's run and the red train's are real; every run of the bisect's first look (the front alone) is cut off: the
  // one GitHub lists for it, the run pushed for it and its one fresh run.
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }], { FAKE_RED_PATH: 'red.txt', FAKE_CUT: '2 3' });
  const done = await l.go();
  assert.match(done[1].stderr, /finding the first ship that turned it red.*cut off before any test failed \(https:\/\/ci\/\d+\).*the ship train goes back in line, since CI gave no answer \(CI was cut off twice before any test failed \(https:\/\/ci\/\d+, https:\/\/ci\/\d+\)\)/s);
  assert.doesNotMatch(done[1].stderr, /the bisect found/, 'the cut-off bisect named nobody');
  for (const i of [1, 2, 3]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  // Ship 4 is refused only later, by a run that really failed.
  assert.equal(done[3].status, 1, done[3].stderr);
  assert.doesNotMatch(done[3].stderr, /cut off/);
  assert.match(done[3].stderr, /the first ship that turned it red/);
  l.done();
});

test('a train whose front is red: the front is refused as alone, and the ships behind it ship as the next train', async () => {
  const l = await line([{}, { change: ['red.txt', 'red\n'] }, {}, {}, {}], { FAKE_RED_PATH: 'red.txt' });
  const done = await l.go();
  assert.equal(done[1].status, 1);
  assert.match(done[1].stderr, /the bisect found ticket\/2-x itself red, so the ships behind it go back in line/);
  assert.match(done[1].stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\)/);
  for (const i of [3, 4, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[3], 4, 3, 3);
  shipped(l, done[4], 5, 3, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5']);
  l.done();
});

test('CI gives no answer on a train: the riders go back in line, and each lands on its own', async () => {
  // LAND_CI_DOWN=0: the note the first no-answer leaves would keep the next fronts from making a train at all.
  const l = await line([{}, {}, {}, {}], { FAKE_CI: 'down', LAND_CI_DOWN: '0' });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 2 ships/);
  assert.match(done[1].stderr, /the ship train goes back in line, since CI gave no answer \(.*\): ticket\/2-x goes on alone/);
  assert.match(done[1].stderr, /CI FALLBACK/);
  assert.match(done[2].stderr, /back in line on its own/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.equal(l.deployed().length, 4, 'one deploy each');
  l.done();
});

// #1361 (Cara 2026-11-20, "Wait for a busy desktop"): a train keeps its riders while it waits for a busy runner, or for a
// runner to come back while perigee is busy, and they go back only when the gate gives up for good. 1 s stands for the
// 90 s bound, and the few seconds the job sits queued for a 3-min wait.
test('a train keeps its riders while a busy runner takes its time to start the job, and ships them in one CI run', async () => {
  const l = await line([{}, {}, {}], (dir) => ({ FAKE_CI_FILE: join(dir, 'ci-state'), LAND_CI_START: '1', LAND_CI_START_ONLINE: '60' }), (r) => writeFileSync(join(r.dir, 'ci-state'), 'green'));
  const file = join(l.r.dir, 'ci-state');
  writeFileSync(file, 'queued');
  const all = l.go();
  await until('the train waits for the busy runner', () => /ship train: ticket\/2-x takes the 1 ships/.test(l.out[1]) && /runner is online but hasn't started the job/.test(l.out[1]), 30_000);
  await new Promise((ok) => setTimeout(ok, 2500));
  writeFileSync(file, 'green');
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  shipped(l, done[2], 3, 2, 2);
  assert.equal(l.deployed().length, 2, "ship 1's deploy and the train's");
  l.done();
});

test('a train keeps its riders while perigee is busy and CI gives no answer, and ships them once CI answers', async () => {
  const l = await line([{}, {}, {}], (dir) => {
    const proc = quietProc(join(dir, 'proc'));
    return { FAKE_CI_FILE: join(dir, 'ci-state'), LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
  }, (r) => writeFileSync(join(r.dir, 'ci-state'), 'green'));
  writeFileSync(join(l.r.dir, 'ci-state'), 'down');
  quietProc(join(l.r.dir, 'proc'), { load: 999 });
  const all = l.go();
  await until('the train waits on a busy perigee', () => /ship train: ticket\/2-x takes the 1 ships/.test(l.out[1]) && /CI: GitHub didn't answer, but perigee is busy/.test(l.out[1]), 30_000, () => l.out[1]);
  await new Promise((ok) => setTimeout(ok, 1000));
  writeFileSync(join(l.r.dir, 'ci-state'), 'green');
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  shipped(l, done[2], 3, 2, 2);
  l.done();
});

test("a red train's bisect keeps its riders while CI gives no answer on a busy perigee, and finds the ship once CI answers", async () => {
  const l = await line([{}, {}, {}, { change: ['red.txt', 'red\n'] }, {}, {}], (dir) => {
    const proc = quietProc(join(dir, 'proc'), { load: 999 });
    // GitHub stops answering from the bisect's first probe: the third commit asked about, after ship 1's and the train's.
    return { FAKE_RED_PATH: 'red.txt', FAKE_CI_DOWN_AT: '3', FAKE_CI_UP: join(dir, 'ci-up'), LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
  });
  const all = l.go();
  await until('the bisect waits on a busy perigee', () => /finding the first ship that turned it red/.test(l.out[1]) && /CI: GitHub didn't answer, but perigee is busy/.test(l.out[1]), 30_000, () => l.out[1]);
  await new Promise((ok) => setTimeout(ok, 1000));
  writeFileSync(join(l.r.dir, 'ci-up'), '');
  const done = await all;
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  assert.match(done[1].stderr, /the bisect found ticket\/4-x the first ship that turned the train red \(https:\/\/ci\/\d+\): it is refused, and the 1 before it ship/);
  assert.equal(done[3].status, 1, done[3].stderr);
  for (const i of [1, 2, 3, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  l.done();
});

test('a rider stopped while its train is tested: the train ships up to the ship before it, and the rest go back in line', async () => {
  const gate = (r: ReturnType<typeof setup>) => join(r.dir, 'ci-gate');
  const l = await line([{}, {}, {}, {}, {}], (dir) => ({ FAKE_CI_GATE: join(dir, 'ci-gate') }), (r) => writeFileSync(gate(r), ''));
  rmSync(gate(l.r)); // the train's run stays in progress until the rider is gone
  const all = l.go();
  await until('the train', () => /ship train: ticket\/2-x takes the 3 ships/.test(l.out[1]));
  await until('ship 5 riding', () => /land: riding/.test(l.out[4]));
  const ticket = tickets(l.state).map((t) => readFileSync(join(l.state, 'queue', t), 'utf8').split('\n')).find((t) => t[2] === 'ticket/4-x')!;
  process.kill(-Number(ticket[0].split(' ')[0]), 'SIGKILL');
  writeFileSync(gate(l.r), '');
  const done = await all;
  assert.equal(done[3].status, null, 'killed');
  assert.match(done[1].stderr, /ship train: ticket\/4-x left the line while the train was tested, so it ships without it/);
  for (const i of [1, 2, 3, 5]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  assert.match(done[4].stderr, /back in line on its own/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f5.txt: 5']);
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3]);
  assert.equal(l.deployed().length, 3);
});

test('the train passes over a ship that conflicts with it, one that changes the pipeline, and one landed with LAND_TRAIN=0', async () => {
  const l = await line(
    [{}, {}, { change: ['a.txt', 'three\n'] }, { change: ['a.txt', 'four\n'] }, { change: ['tools/pipe.sh', 'x\n'] }, {}, { env: { LAND_TRAIN: '0' } }],
    {},
    (r) => r.commit(r.source, 'tools/pipeline-files.txt', '# the pipeline\ntools/pipe.sh\n'),
  );
  const done = await l.go();
  assert.match(done[1].stderr, /ship train: ticket\/4-x stays in line \(it doesn't rebase cleanly onto the train\)/);
  assert.match(done[1].stderr, /ship train: ticket\/5-x stays in line \(it changes the ship pipeline, which ships alone\)/);
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 2 ships waiting behind it \(ticket\/3-x ticket\/6-x\)/);
  assert.equal(done[3].status, 1, 'the conflict is refused on its own');
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[5], 6, 2, 3);
  assert.doesNotMatch(done[6].stderr, /land: riding/);
  assert.deepEqual(l.subjects(), ['base', 'tools/pipeline-files.txt: # the pipeline tools/pipe.sh', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: three', 'f6.txt: 6', 'tools/pipe.sh: x', 'f7.txt: 7']);
  l.done();
});

test('with <state>/train-off, every ship lands on its own', async () => {
  const l = await line([{}, {}, {}, {}], {}, (r) => {
    const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'train-off'), '');
  });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.doesNotMatch(done[1].stderr, /ship train/);
  assert.equal(l.runs(), 4);
  assert.equal(l.deployed().length, 4);
  l.done();
});

// deploy.sh lets go of the line once its restart is queued, while the restart is still judged (#566), so a rider can get
// the lock before its front has a verdict to give.
async function restart(rolledBack: boolean) {
  const l = await line([{ env: { FAKE_RESTART_GATE: '' } }, rolledBack ? { env: { FAKE_ROLLED_BACK: '1' } } : {}, {}, {}], (dir) => ({ FAKE_RESTART_GATE: join(dir, 'restarted') }));
  const all = l.go();
  await until('ships 3 and 4 wait outside the line', () => [2, 3].every((i) => /waiting outside the line for the restart of ticket\/2-x's ship train/.test(l.out[i])));
  writeFileSync(join(l.r.dir, 'restarted'), '');
  return { l, done: await all };
}

test("a rider that gets the lock while its train's restart is judged waits outside the line, and ships with it", async () => {
  const { l, done } = await restart(false);
  assert.equal(done[1].status, 0, done[1].stderr);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[3], 4, 2, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.equal(l.deployed().length, 2, "ship 1's deploy and the train's");
  l.done();
});

test("a train whose restart is rolled back: its riders go back in line and land on their own", async () => {
  const { l, done } = await restart(true);
  assert.equal(done[1].status, 1, done[1].stderr);
  for (const i of [3, 4]) {
    assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
    assert.match(done[i - 1].stderr, /back in line on its own: ticket\/2-x's ship train went without/);
    assert.doesNotMatch(done[i - 1].stderr, /shipped in ticket\/2-x's ship train/);
  }
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  l.done();
});

// #1360 (Cara, 2026-11-20, "Refused ships keep their place"): ship 2, at the front, is refused by the pipeline (no CI and a
// busy perigee); it keeps its ticket, lets ship 3 take the lock, and rides ship 3's train as its first rider.
const busy = (): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), 'land-busy-'));
  const proc = quietProc(join(dir, 'proc'), { load: 999 });
  return { LAND_CI: '0', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy'), LAND_QUIET_LIMIT: '0', LAND_QUIET_POLL: '0.2' };
};
const retried = (l: Awaited<ReturnType<typeof line>>) => {
  const log = join(l.r.dir, 'shared', 'retro-log');
  return readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8').split('\n').filter((x) => x.includes(' · retry in place · ')).map((x) => x.replace(/^- \S+ /, ''));
};
const shared = (dir: string) => ({ COORDINATOR_SHARED_DIR: join(dir, 'shared') });

test("a front refused by the pipeline keeps its ticket and rides the next ship's train as its first rider, never ahead of it (#1360)", async () => {
  const l = await line([{}, { env: busy() }, {}, {}], shared);
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /refused by the pipeline \(CI and perigee both busy for 0 min\), not your change: keeping its place in line and riding the next train, once/);
  assert.match(done[2].stderr, /ship train: ticket\/3-x takes the 2 ships waiting behind it \(ticket\/2-x ticket\/4-x\)/, 'ship 2 first, ship 3 at the front');
  shipped(l, done[1], 2, 3, 3);
  shipped(l, done[3], 4, 3, 3);
  assert.doesNotMatch(done[1].stderr, /back at the front/, 'it never took the lock again');
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f2.txt: 2', 'f4.txt: 4']);
  assert.equal(issued(l.state), 4, 'no new ticket');
  assert.deepEqual(retried(l), ['· retry in place · ticket/2-x · CI and perigee both busy for 0 min · landed']);
  l.done();
});

test('a front refused by the pipeline stays first in a Releases order set while it held the lock (#1360)', async () => {
  const l = await line([{}, { env: { ...busy(), LAND_QUIET_LIMIT: '2' } }, {}, {}], shared);
  const all = l.go();
  await until('ship 2 waiting on a busy perigee', () => /waiting for CI or a quiet perigee/.test(l.out[1]));
  writeFileSync(join(l.state, 'queue', '.order'), '# set by a test\n0000000004\n0000000003\n'); // Releases ranks only the waiters
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /ship train: ticket\/4-x takes the 2 ships waiting behind it \(ticket\/2-x ticket\/3-x\)/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f4.txt: 4', 'f2.txt: 2', 'f3.txt: 3']);
  l.done();
});

test('a retried ship whose train goes red is bisected like any rider, and refused for good (#1360)', async () => {
  const l = await line([{}, { change: ['red.txt', 'red\n'], env: busy() }, {}, {}], (d) => ({ FAKE_RED_PATH: 'red.txt', ...shared(d) }));
  const done = await l.go();
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.match(done[1].stderr, /not your change: keeping its place/);
  assert.match(done[1].stderr, /land: tests failed in CI on ticket\/3-x's ship train \(https:\/\/ci\/\d+\), and its bisect found ticket\/2-x the first ship that turned it red/);
  for (const i of [1, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  assert.deepEqual(retried(l), ['· retry in place · ticket/2-x · CI and perigee both busy for 0 min · refused']);
  l.done();
});

// Conflict prep (#1366, Cara, 2026-11-20: "we know what main WILL look like, and we can deal with the merge issues before
// we try to ship"): ship 4 waits behind ship 2's train, which carries ship 3, and conflicts with ship 3 in a.txt. While the
// train is tested, land.sh tells it so; its minion records the fix with git rerere in a scratch worktree (prepMessage's
// steps), off its branch; once the train ships, ship 4's real rebase replays the fix and it ships.
// keep: the fix keeps the train's side whole, so ship 4's a.txt commit drops out and only its second commit ships.
async function prepped(red: boolean, keep = false, early = false) {
  let gate = '';
  const l = await line(
    [{}, {}, { change: ['a.txt', 'three\n'], ...(red ? { also: ['red.txt', 'red\n'] as [string, string] } : {}) }, { change: ['a.txt', 'four\n'], ...(keep ? { also: ['g.txt', 'g\n'] as [string, string] } : {}) }],
    (dir) => ({ ...shared(dir), ...(early ? {} : { LAND_EARLY: '0' }), FAKE_CI_GATE: (gate = join(dir, 'ci-gate')), ...(red ? { FAKE_RED_PATH: 'red.txt' } : {}) }),
    (r) => writeFileSync(join(r.dir, 'ci-gate'), ''), // ship 1's run goes through; the train's waits
  );
  rmSync(gate);
  const all = l.go();
  await until("ship 4's prep line", () => /land: prep: ticket\/4-x will conflict/.test(l.out[3]));
  const m = /land: prep: ticket\/4-x will conflict with ticket\/3-x once ticket\/2-x's ship train ships; conflicted files: a\.txt; record the fix against ([0-9a-f]{40}) from ([0-9a-f]{40}) to ([0-9a-f]{40})$/m.exec(l.out[3]);
  assert.ok(m, l.out[3]);
  assert.equal(m[3], l.was[3], "ship 4's own head");
  // What the minion runs, in a scratch worktree of its own.
  const wt = join(l.r.dir, 'train-prep');
  git(l.wts[3], 'worktree', 'add', '-q', '--detach', wt, m[1]);
  assert.throws(() => git(wt, '-c', 'rerere.enabled=true', 'cherry-pick', `${m[2]}..${m[3]}`));
  writeFileSync(join(wt, 'a.txt'), keep ? 'three\n' : 'three\nfour\n');
  git(wt, 'add', 'a.txt');
  if (keep) {
    assert.throws(() => git(wt, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'cherry-pick', '--continue'), 'nothing to commit');
    git(wt, '-c', 'rerere.enabled=true', 'rerere');
    git(wt, 'cherry-pick', '--skip');
  } else git(wt, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'cherry-pick', '--continue');
  git(l.wts[3], 'worktree', 'remove', '--force', wt);
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'its branch is as it was');
  await until('the fix is seen', () => /land: prep: ticket\/4-x conflicts with ticket\/3-x on ticket\/2-x's ship train \(a\.txt\), but the fix recorded ahead of time \(git rerere\) resolves it/.test(l.out[3]));
  writeFileSync(gate, '');
  return { l, done: await all };
}

test('conflict prep: a ship that will conflict with a rider is told while the train is tested, records the fix, and ships on it (#1366)', async () => {
  const { l, done } = await prepped(false);
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /land: the fix recorded ahead of time \(git rerere, conflict prep\) resolved the rebase's conflicts/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: three', 'a.txt: four']);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'three\nfour');
  assert.equal(git(l.r.source, 'config', '--get', 'rerere.enabled'), 'false', "rerere stays land.sh's: rr-cache would turn it on for every command");
  const log = join(l.r.dir, 'shared', 'retro-log');
  const lines = readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8').split('\n').filter((x) => x.includes(' · train prep ')).map((x) => x.replace(/^- \S+ · /, '').replace(/\(([0-9a-f]{7,})\)/, '(sha)'));
  assert.deepEqual(lines, ["train prep conflict · ticket/4-x onto ticket/2-x's train (sha) · ticket/3-x: a.txt", 'train prep replayed · ticket/4-x onto main (sha)']);
  l.done();
});

test('conflict prep: when the train goes red and the rider drops out, the ship carries no foreign commits and the record goes unused (#1366)', async () => {
  const { l, done } = await prepped(true);
  assert.equal(done[2].status, 1, 'ship 3 turned the train red');
  for (const i of [1, 2, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.doesNotMatch(done[3].stderr, /resolved the rebase's conflicts/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: four']);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'four');
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/3-x'), l.was[2], 'the red ship is as it was');
  l.done();
});

test("conflict prep: a fix that keeps the train's side whole drops that commit, and the ship's other commits ship (#1366)", async () => {
  const { l, done } = await prepped(false, true);
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /resolved the rebase's conflicts/);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'a.txt: three', 'g.txt: g']);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'three');
  l.done();
});

test('conflict prep with the early next train: the early stack replays the recorded fix, and its run counts (#1366)', async () => {
  const { l, done } = await prepped(false, false, true);
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[3].stderr, /that run is its CI/);
  assert.equal(git(l.r.source, 'show', 'main:a.txt'), 'three\nfour');
  assert.deepEqual(retro(l.r.dir, ' · train prep replayed · '), ["train prep replayed · ticket/4-x onto ticket/2-x's train sha, early"]);
  l.done();
});

test('conflict prep off: <state>/prep-off, and no prep line is said (#1366)', async () => {
  const l = await line([{}, {}, { change: ['a.txt', 'three\n'] }, { change: ['a.txt', 'four\n'] }], {}, (r) => {
    const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'prep-off'), '');
  });
  const done = await l.go();
  assert.equal(done[3].status, 1, 'the conflict is refused as before');
  assert.doesNotMatch(done[3].stderr, /land: prep:/);
  assert.throws(() => git(l.r.source, 'config', '--get', 'rerere.enabled'), 'land.sh leaves the repo\'s rerere setting alone');
  l.done();
});

// Early next train (#1366): once a train's CI is green, the ship next in line and the train it would take are stacked
// on its top and pushed to CI while it deploys. LAND_TRAIN_MAX=1: ship 2 takes ship 3, and ship 4 is next, with ship 5.
const retro = (dir: string, what: string) => {
  const log = join(dir, 'shared', 'retro-log');
  return readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8').split('\n').filter((x) => x.includes(what)).map((x) => x.replace(/^- \S+ · /, '').replace(/\(([0-9a-f]{7,})\)|[0-9a-f]{7,}$/g, 'sha'));
};

test("early next train: the next ship's train is stacked and its CI started while the train ahead deploys, and its run counts (#1366)", async () => {
  const l = await line([{}, {}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1' }), (r) => writeFileSync(join(r.dir, 'hub.git', 'hooks', 'post-receive'), `#!/bin/sh\nwhile read -r old new ref; do echo "$new $ref" >>'${join(r.dir, 'pushes')}'; done\n`, { mode: 0o755 }));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: early next train: ticket\/4-x \(with ticket\/5-x riding\) is stacked on this train's top and its CI starts now, while this one deploys \(([0-9a-f]{7,})\)/);
  const top = /while this one deploys \(([0-9a-f]{7,})\)/.exec(done[1].stderr)![1];
  assert.match(done[3].stderr, /land: early next train: CI started on this train at \d\d:\d\d while ticket\/2-x's deployed, and it came out the same, so that run is its CI \(\d+ s head start\)/);
  assert.equal(git(l.r.source, 'rev-parse', '--short=7', 'main').slice(0, 7), top.slice(0, 7), 'the train that shipped is the one stacked early');
  shipped(l, done[4], 5, 4, 2);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4', 'f5.txt: 5']);
  assert.deepEqual(retro(l.r.dir, ' · early train · '), ["early train · ticket/4-x + 1 riders onto ticket/2-x's train sha · pushed sha", 'early train · ticket/4-x · counted · 0s head start'.replace('0s', retro(l.r.dir, ' · counted · ')[0]?.match(/(\d+)s head/)?.[1] + 's')]);
  assert.match(retro(l.r.dir, 'timing · ticket/4-x').join('\n'), / · ci early \d+s · landed/);
  assert.ok(!existsSync(join(l.state, 'early')), 'the record is used up');
  // The early run goes with its base, ship 2's train top, for the burn-in (#1443), and both scratch branches are deleted.
  const pushes = readFileSync(join(l.r.dir, 'pushes'), 'utf8').trim().split('\n');
  const base = pushes.find((x) => x.endsWith(' refs/heads/land-base/ticket/4-x') && !/^0+ /.test(x))?.split(' ')[0];
  assert.ok(base, `land-base/ticket/4-x pushed: ${pushes.join('; ')}`);
  assert.equal(git(l.r.source, 'log', '-1', '--format=%s', base!), 'f3.txt: 3', "its base is ship 2's train top (ship 3 rode it)");
  const tails = pushes.filter((x) => / refs\/heads\/land(-base)?\/ticket\/4-x$/.test(x)).map((x) => /^0+ /.test(x) ? 'gone' : 'set');
  assert.equal(tails.at(-1), 'gone', `land refs for ticket/4-x end deleted: ${pushes.join('; ')}`);
  l.done();
});

test('early next train: an early run that went red is dropped and runs again on its turn, and the train is bisected as usual (#1366)', async () => {
  const l = await line([{}, {}, {}, {}, { change: ['red.txt', 'red\n'] }], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', FAKE_RED_PATH: 'red.txt' }));
  const done = await l.go();
  assert.match(done[1].stderr, /land: early next train: ticket\/4-x \(with ticket\/5-x riding\) is stacked/);
  assert.match(done[3].stderr, /land: early next train: dropped the early CI run on ticket\/4-x's train \(the early run failed, so it runs again\)/);
  assert.equal(done[4].status, 1, 'ship 5 turned it red');
  for (const i of [1, 2, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.deepEqual(retro(l.r.dir, ' · discarded · '), ['early train · ticket/4-x · discarded · the early run failed, so it runs again']);
  assert.ok(!git(l.r.dir + '/hub.git', 'for-each-ref', 'refs/heads/land-base/ticket/4-x', 'refs/heads/land/ticket/4-x'), 'no scratch branch of it is left on GitHub');
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

test('early next train: with no free runner nothing is pushed early, and with LAND_EARLY=0 or <state>/early-off nothing is tried (#1366)', async () => {
  // The one runner is online, so each ship's CI waits for its run, but busy (a heavy job holds it), so never free.
  const runners = JSON.stringify({ runners: [{ status: 'online', busy: true, labels: [{ name: 'citadel-ci-linux' }] }] });
  const l = await line([{}, {}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', FAKE_RUNNERS_FILE: join(d, 'runners') }), (r) => writeFileSync(join(r.dir, 'runners'), runners));
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /land: early next train: no free citadel-ci-linux runner, so ticket\/4-x's CI waits for its turn/);
  assert.doesNotMatch(done[3].stderr, /early next train/);
  assert.deepEqual(retro(l.r.dir, ' · early train · '), []);
  l.done();
  for (const how of ['env', 'file'] as const) {
    const off = await line([{}, {}, {}, {}], (d) => ({ ...shared(d), LAND_TRAIN_MAX: '1', ...(how === 'env' ? { LAND_EARLY: '0' } : {}) }));
    if (how === 'file') { mkdirSync(off.state, { recursive: true }); writeFileSync(join(off.state, 'early-off'), ''); }
    const offDone = await off.go();
    offDone.forEach((d, i) => assert.equal(d.status, 0, `${how}: ship ${i + 1}: ${d.stderr}`));
    assert.doesNotMatch(offDone.map((d) => d.stderr).join('\n'), /early next train/, how);
    off.done();
  }
});
