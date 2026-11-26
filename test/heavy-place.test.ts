// Heavy CI jobs placed by Citadel (src/heavy-place.ts, #2120): a real MachineBalancer, GitHub faked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Listed } from '../src/ci-runner.ts';
import { AGENT_LEASE_MS, HAND_MS, HeavyPlacer, heavyKind, LEASE_MS, type PlaceMachine, type QueuedHeavy } from '../src/heavy-place.ts';
import { HEAVY_WAIT_MS, MachineBalancer } from '../src/machine-balancer.ts';

const REPO = 'cara/peek';

function world() {
  let now = 1_000_000;
  // Turns running on each PC; 8 threads each, a turn 3: two turns leave 2 threads, too few for an 8-thread build.
  const running = new Map<number, number>([
    [1, 2],
    [2, 2],
  ]);
  const balancer = new MachineBalancer({
    machines: () => [1, 2],
    input: (id) => ({ threads: 8, caps: { workers: null, runners: null, turnThreads: null, ciThreads: null }, ship: false, ciWaiting: 0, running: running.get(id) ?? 0 }),
    changed: () => {},
    now: () => now,
  });
  const machines: PlaceMachine[] = [
    { id: 2, name: 'second', priority: 2, hosts: ['desk2'] },
    { id: 1, name: 'first', priority: 1, hosts: ['desk1'] },
  ];
  const runners: Listed[] = [
    { id: 11, name: 'desk1-linux-1', status: 'online', busy: false, labels: ['self-hosted', 'Linux', 'peek-ci-linux'] },
    { id: 21, name: 'desk2-linux-1', status: 'online', busy: false, labels: ['self-hosted', 'Linux', 'peek-ci-linux'] },
    { id: 22, name: 'desk2-win-1', status: 'online', busy: false, labels: ['self-hosted', 'Windows', 'peek-ci'] },
  ];
  const jobs = new Map<number, { status: string; runner: string | null } | null>();
  const log: string[] = [];
  const placer = new HeavyPlacer({
    balancer,
    machines: () => machines,
    runners: async () => runners,
    addLabel: async (_repo, id, label) => {
      runners.find((r) => r.id === id)!.labels.push(label);
      return true;
    },
    dropLabel: async (_repo, id, label) => {
      const r = runners.find((x) => x.id === id)!;
      r.labels = r.labels.filter((l) => l !== label);
    },
    job: async (_repo, id) => (jobs.has(id) ? jobs.get(id)! : { status: 'queued', runner: null }),
    now: () => now,
    log: (l) => log.push(l),
  });
  const q: QueuedHeavy = { repo: REPO, id: 501, run: 77, name: 'build', labels: ['self-hosted', 'peek-ci-linux', 'citadel-heavy-apk'] };
  const labelled = () => runners.filter((r) => r.labels.includes('citadel-heavy-apk')).map((r) => r.name);
  const pass = (queued: QueuedHeavy[] = [q]) => placer.pass(queued, new Set([REPO]));
  return { balancer, placer, running, runners, jobs, log, q, labelled, pass, tick: (ms: number) => (now += ms) };
}

test('heavyKind reads the heavy label and its kind, in any case', () => {
  assert.deepEqual(heavyKind(['self-hosted', 'Citadel-Heavy-APK']), { label: 'citadel-heavy-apk', kind: 'apk' });
  assert.equal(heavyKind(['self-hosted', 'citadel-heavy-']), null);
  assert.equal(heavyKind(['self-hosted', 'peek-ci']), null);
});

test('a heavy job held 30 min moves to the second machine in the owner order once it has room', async () => {
  const w = world();
  await w.pass();
  assert.deepEqual(w.labelled(), [], 'neither PC has 8 threads free: it waits');
  // It waits on the owner's first PC, which starts no new turn meanwhile; the second is left alone.
  assert.equal(w.balancer.plan(1)!.workers, 0);
  assert.equal(w.balancer.plan(2)!.workers, 2);
  w.tick(HEAVY_WAIT_MS);
  w.running.set(2, 0);
  await w.pass();
  assert.deepEqual(w.labelled(), ['desk2-linux-1'], 'the label goes to the runner with its labels on the second PC');
  assert.equal(w.balancer.plan(1)!.workers, 2, 'the first PC is let go');
  assert.equal(w.balancer.plan(2)!.workers, 0, 'the second holds its 8 threads');
  assert.equal(w.placer.view()[0].late, false);
});

test('the first PC in the owner order with room takes it at once, the first when both have room', async () => {
  const w = world();
  w.running.set(2, 0);
  await w.pass();
  assert.deepEqual(w.labelled(), ['desk2-linux-1'], 'the first is full, the second has room: no 30 min wait');
  const v = world();
  v.running.set(1, 0);
  v.running.set(2, 0);
  await v.pass();
  assert.deepEqual(v.labelled(), ['desk1-linux-1']);
});

test('with no room anywhere after 30 min it starts late on the first PC', async () => {
  const w = world();
  await w.pass();
  w.tick(HEAVY_WAIT_MS);
  await w.pass();
  assert.deepEqual(w.labelled(), ['desk1-linux-1']);
  assert.equal(w.placer.view()[0].late, true);
});

test('GitHub taking the job takes the label off; its end frees the room', async () => {
  const w = world();
  w.running.set(1, 0);
  await w.pass();
  w.jobs.set(501, { status: 'in_progress', runner: 'desk1-linux-1' });
  await w.pass([]);
  assert.deepEqual(w.labelled(), [], 'the runner takes no second heavy job');
  assert.equal(w.placer.view()[0].state, 'running');
  assert.equal(w.balancer.plan(1)!.workers, 0);
  w.jobs.set(501, { status: 'completed', runner: 'desk1-linux-1' });
  await w.pass([]);
  assert.deepEqual(w.placer.view(), []);
  assert.equal(w.balancer.plan(1)!.workers, 2);
});

test('a job that never says done frees its room when its lease ends', async () => {
  const w = world();
  w.running.set(1, 0);
  await w.pass();
  w.jobs.set(501, { status: 'in_progress', runner: 'desk1-linux-1' });
  await w.pass([]);
  w.jobs.set(501, null); // GitHub stops showing it, and no last step calls
  w.tick(LEASE_MS - 1);
  await w.pass([]);
  assert.equal(w.balancer.plan(1)!.workers, 0, 'held until the lease ends');
  w.tick(1);
  await w.pass([]);
  assert.deepEqual(w.placer.view(), []);
  assert.equal(w.balancer.plan(1)!.workers, 2);
});

test("a job's last step frees its room at once, for its own runner only", async () => {
  const w = world();
  w.running.set(1, 0);
  await w.pass();
  w.jobs.set(501, { status: 'in_progress', runner: 'desk1-linux-1' });
  await w.pass([]);
  assert.equal(await w.placer.doneRun(REPO, 77, 'desk2-linux-1'), false);
  assert.equal(await w.placer.doneRun('Cara/Peek', 77, 'DESK1-linux-1'), true);
  assert.equal(w.balancer.plan(1)!.workers, 2);
});

test('a label no runner took in time comes off and the job is placed again', async () => {
  const w = world();
  w.running.set(1, 0);
  await w.pass();
  w.tick(HAND_MS);
  await w.pass();
  assert.ok(w.log.some((l) => /no runner took it/.test(l)));
  await w.pass();
  assert.deepEqual(w.labelled(), ['desk1-linux-1'], 'handed out again');
});

test('with no PC Citadel balances for the repo, any runner with its labels takes it at once', async () => {
  const w = world();
  w.runners[0].name = 'elsewhere-1'; // on no PC Citadel knows
  w.runners[1].labels = ['self-hosted'];
  await w.pass();
  assert.deepEqual(w.labelled(), ['elsewhere-1']);
  assert.equal(w.balancer.plan(1)!.workers, 2, 'no room held anywhere');
});

test('a heavy label Citadel did not hand out comes off on the first look', async () => {
  const w = world();
  w.runners[2].labels.push('citadel-heavy-desktop');
  await w.pass([]);
  assert.ok(!w.runners[2].labels.includes('citadel-heavy-desktop'));
});

test("a Windows test run holds its PC's room while its agent asks, and lets go when the agent stops", () => {
  const w = world();
  w.running.set(1, 0);
  assert.equal(w.placer.agentAsk(1, 'job-a', 'Windows test run'), 'start');
  assert.equal(w.balancer.plan(1)!.workers, 1, '4 threads held: one turn fits in the 4 left');
  w.tick(AGENT_LEASE_MS);
  w.placer.expire();
  assert.equal(w.balancer.plan(1)!.workers, 2);
  w.placer.agentAsk(1, 'job-b', 'Windows test run');
  w.placer.agentDone(1, 'job-b');
  assert.equal(w.balancer.plan(1)!.workers, 2);
});
