// The ship train (#1166, tools/land.sh): the landing at the front of the line takes the plain lands waiting behind it,
// tests them in one CI run and ships them in one deploy; a red train is bisected, and its first red ship refused.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, setup, landAsync, tickets, issued } from './land-fixture.ts';
import { until } from './wait.ts';

type Ship = { change?: [string, string]; env?: Record<string, string> };

// Ship 1 (ticket/1-x) lands alone and holds the lock in its deploy until every other ship is in line behind it, so
// ship 2 is the front of a train with the rest behind it. Ship i changes f<i>.txt unless it says otherwise.
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
    git(r.source, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[i - 1]);
  }
  ships.forEach((s, i) => r.commit(wts[i], ...(s.change ?? [`f${i + 1}.txt`, `${i + 1}\n`])));
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
