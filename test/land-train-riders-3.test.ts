// Part 3 of 3 of the land-train-riders tests (#2208); the shared setup is in land-train-riders-setup.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, setup, tickets, issued, quietProc } from './land-fixture.ts';
import { line, shipped, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';
import { landText } from './land-files.ts';
import { restart, busy, retried } from './land-train-riders-setup.ts';

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
  const l = await line(
    [{}, {}, {}],
    (dir) => ({ FAKE_CI_FILE: join(dir, 'ci-state'), LAND_CI_START: '1', LAND_CI_START_ONLINE: '60' }),
    (r) => writeFileSync(join(r.dir, 'ci-state'), 'green'),
  );
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
  const l = await line(
    [{}, {}, {}],
    (dir) => {
      const proc = quietProc(join(dir, 'proc'));
      return { FAKE_CI_FILE: join(dir, 'ci-state'), LAND_QUIET_POLL: '0.2', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy') };
    },
    (r) => writeFileSync(join(r.dir, 'ci-state'), 'green'),
  );
  writeFileSync(join(l.r.dir, 'ci-state'), 'down');
  quietProc(join(l.r.dir, 'proc'), { load: 999 });
  const all = l.go();
  await until(
    'the train waits on a busy perigee',
    () => /ship train: ticket\/2-x takes the 1 ships/.test(l.out[1]) && /CI: GitHub didn't answer, but perigee is busy/.test(l.out[1]),
    30_000,
    () => l.out[1],
  );
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
  await until(
    'the bisect waits on a busy perigee',
    () => /finding the first ship that turned it red/.test(l.out[1]) && /CI: GitHub didn't answer, but perigee is busy/.test(l.out[1]),
    30_000,
    () => l.out[1],
  );
  await new Promise((ok) => setTimeout(ok, 1000));
  writeFileSync(join(l.r.dir, 'ci-up'), '');
  const done = await all;
  assert.doesNotMatch(done[1].stderr, /goes back in line|CI FALLBACK/);
  assert.match(done[1].stderr, /bisect: the first 2 of 5 ships tested green, so they ship now; back in line with nobody refused: ticket\/4-x ticket\/5-x ticket\/6-x; the red may be: ticket\/4-x ticket\/5-x ticket\/6-x/);
  assert.equal(done[3].status, 1, done[3].stderr);
  for (const i of [1, 2, 3, 5, 6]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  shipped(l, done[2], 3, 2, 2);
  l.done();
});

test('a rider stopped while its train is tested: the train ships up to the ship before it, and the rest go back in line', async () => {
  const gate = (r: ReturnType<typeof setup>) => join(r.dir, 'ci-gate');
  const l = await line(
    [{}, {}, {}, {}, {}],
    (dir) => ({ FAKE_CI_GATE: join(dir, 'ci-gate') }),
    (r) => writeFileSync(gate(r), ''),
  );
  rmSync(gate(l.r)); // the train's run stays in progress until the rider is gone
  const all = l.go();
  await until('the train', () => /ship train: ticket\/2-x takes the 3 ships/.test(l.out[1]));
  await until('ship 5 riding', () => /land: riding/.test(l.out[4]));
  const ticket = tickets(l.state)
    .map((t) => readFileSync(join(l.state, 'queue', t), 'utf8').split('\n'))
    .find((t) => t[2] === 'ticket/4-x')!;
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
  const l = await line([{}, {}, { change: ['a.txt', 'three\n'] }, { change: ['a.txt', 'four\n'] }, { change: ['tools/pipe.sh', 'x\n'] }, {}, { env: { LAND_TRAIN: '0' } }], {}, (r) => r.commit(r.source, 'tools/pipeline-files.txt', '# the pipeline\ntools/pipe.sh\n'));
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

test("a rider that gets the lock while its train's restart is judged waits outside the line, and ships with it", async () => {
  const { l, done } = await restart(false);
  assert.equal(done[1].status, 0, done[1].stderr);
  shipped(l, done[2], 3, 2, 3);
  shipped(l, done[3], 4, 2, 3);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3', 'f4.txt: 4']);
  assert.equal(l.deployed().length, 2, "ship 1's deploy and the train's");
  l.done();
});

test("every rider's minion is handed to the train's deploy, with its own train commit, for the restart to report to (#1865)", async () => {
  const me = (n: number) => ({ env: { COORDINATOR_API: 'http://127.0.0.1:1', COORDINATOR_TOKEN: `tok${n}`, COORDINATOR_TICKET: String(n) } });
  const l = await line([me(1), me(2), me(3), {}, me(5)]);
  const done = await l.go();
  for (const d of done) assert.equal(d.status, 0, d.stderr);
  const at = (i: number) => git(l.r.source, 'rev-parse', `ticket/${i}-x`);
  assert.deepEqual(readFileSync(join(l.r.dir, 'deploys.riders'), 'utf8').trim().split('\n').sort(), [`http://127.0.0.1:1 tok3 3 ${at(3)}`, `http://127.0.0.1:1 tok5 5 ${at(5)}`]);
  assert.deepEqual(
    readdirSync(l.state).filter((f) => f.startsWith('riders-')),
    [],
    'no token is left behind',
  );
  l.done();
});

test('a train whose restart is rolled back: its riders go back in line and land on their own', async () => {
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

test('a retried ship whose train goes red goes back in line as any rider does, is tested by itself, and is refused for good (#1360)', async () => {
  const l = await line([{}, { change: ['red.txt', 'red\n'], env: busy() }, {}, {}], (d) => ({ FAKE_RED_PATH: 'red.txt', ...shared(d) }));
  const done = await l.go();
  assert.equal(done[1].status, 1, done[1].stderr);
  assert.match(done[1].stderr, /not your change: keeping its place/);
  assert.match(done[1].stderr, /back in line on its own: the ship train went without ticket\/2-x/);
  for (const i of [1, 3, 4]) assert.equal(done[i - 1].status, 0, `ship ${i}: ${done[i - 1].stderr}`);
  assert.deepEqual(l.subjects(), ['base', 'f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  assert.deepEqual(retried(l), ['· retry in place · ticket/2-x · CI and perigee both busy for 0 min · refused']);
  l.done();
});

test("a rider whose file its front removes as it reads it is back in line, like one with no file: it doesn't die (#1914)", () => {
  const land = landText();
  const body = /^train_verdict\(\) \{\n[\s\S]*?^\}$/m.exec(land)?.[0];
  assert.ok(body, 'tools/land.sh has no train_verdict()');
  const dir = mkdtempSync(join(tmpdir(), 'land-verdict-read-'));
  try {
    // The race in one step: a look at the file says it has text, and opening it fails.
    writeFileSync(join(dir, '7'), 'riding ticket/2-x\n');
    chmodSync(join(dir, '7'), 0);
    for (const [held, riding, want] of [
      ['', '', 'rc=0 riding=\n'],
      ['', '1', 'phase: waiting\nland: back in line on its own: the ship train went without ticket/7-x\nrc=0 riding=\n'],
      ['held', '1', 'phase: waiting\nland: back in line on its own: the ship train went without ticket/7-x\nrc=0 riding=\n'],
    ]) {
      const script: string = `set -euo pipefail\nsay() { echo "land: $*"; }\nqueue_phase() { echo "phase: $*"; }\n${body}\ntrain_dir=$1 riding=$2 branch=ticket/7-x DEPLOY_QUEUE_TICKET=queue/7 rc=0\ntrain_verdict $3 || rc=$?\necho "rc=$rc riding=$riding"`;
      const r = spawnSync('bash', ['-c', script, 'bash', dir, riding, held], { encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, want, `held "${held}", riding "${riding}"`);
      assert.equal(r.status, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
