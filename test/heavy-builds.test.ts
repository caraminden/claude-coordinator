import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { BuildPlacer, buildsReady, KIND_SIZE, place } from '../src/heavy-builds.ts';
import { MachineBalancer } from '../src/machine-balancer.ts';
import { type AgentJobMessage, type BuildKind, DEFAULT_SETTINGS, type JobKind, MachineJobs } from '../src/machine-jobs.ts';
import { kindOf } from '../tools/heavy-builds.ts';
import { tempRoot } from './helpers.ts';

// H2: where a heavy job runs (place(), perigee last) and the Builds role's lane on a machine's job queue.
const none = { workers: null, runners: null, turnThreads: null, ciThreads: null };
const NOW = Date.parse('2026-11-26T12:00:00Z');

/** Cara's desktop (her order 1) and Josh's PC, 16 threads each, with `turns` minion turns running on each (3 threads a turn). */
function two(turns: { cara: number; josh: number }, opts: { online?: number[]; cap?: number | null; warm?: number | null } = {}) {
  const ids = { cara: 1, josh: 2 };
  const balancer = new MachineBalancer({
    machines: () => [1, 2],
    input: (id) => ({ threads: 16, caps: none, ship: false, ciWaiting: 0, running: id === 1 ? turns.cara : turns.josh }),
    changed() {},
    now: () => NOW,
  });
  const online = opts.online ?? [1, 2];
  const placer = new BuildPlacer({
    machines: () =>
      [
        { id: 1, name: "Cara's desktop", priority: 1 },
        { id: 2, name: "Josh's PC", priority: 1 },
      ].filter((m) => online.includes(m.id)),
    builds: () => true,
    free: (id) => balancer.free(id, opts.cap ?? null, 'build:'),
    warm: () => opts.warm ?? null,
  });
  return { ids, balancer, placer, ask: (kind: 'cargo' | 'apk' = 'cargo') => placer.place({ projectId: 1, kind }).map((s) => s.name) };
}

test("Cara's desktop full and Josh's idle: a cargo job goes to Josh's", () => {
  const { ask } = two({ cara: 4, josh: 0 });
  assert.deepEqual(ask(), ["Josh's PC"]);
});

test("both full: nobody takes it, so it goes to perigee's line (an empty answer)", () => {
  assert.deepEqual(two({ cara: 4, josh: 4 }).ask(), []);
});

test("both away: nobody takes it, so it waits in perigee's line", () => {
  assert.deepEqual(two({ cara: 0, josh: 0 }, { online: [] }).ask(), []);
});

test('with room on both: the most room first at the same order, and a warm machine before more room', () => {
  assert.deepEqual(two({ cara: 1, josh: 0 }).ask(), ["Josh's PC", "Cara's desktop"]);
  assert.deepEqual(two({ cara: 1, josh: 0 }, { warm: 1 }).ask(), ["Cara's desktop", "Josh's PC"]);
});

test("the Builds role's threads cap counts its own builds there, held or waiting", () => {
  const { balancer, ask } = two({ cara: 0, josh: 4 }, { cap: 10 });
  assert.deepEqual(ask(), ["Cara's desktop"]);
  assert.equal(balancer.ask(1, { key: 'build:7', label: 'cargo build 7', size: 8 }), 'start');
  assert.equal(balancer.free(1, 10, 'build:'), 2, 'the cap less the build it holds');
  assert.deepEqual(ask(), [], 'no room left under the cap for another cargo job');
  balancer.done('build:7');
  assert.deepEqual(ask(), ["Cara's desktop"]);
});

test('place() keeps only machines with room for the whole job, best first', () => {
  const spots = [
    { id: 1, name: 'a', priority: 2, free: 20 },
    { id: 2, name: 'b', priority: 1, free: 7 },
    { id: 3, name: 'c', priority: 1, free: 9 },
  ];
  assert.deepEqual(
    place(8, spots).map((s) => s.name),
    ['c', 'a'],
  );
  assert.equal(KIND_SIZE.cargo, 8);
});

test('a machine whose Builds role is off, not lent or not set up is never placed on', () => {
  const placer = new BuildPlacer({ machines: () => [{ id: 1, name: 'x', priority: null }], builds: () => false, free: () => 16, warm: () => null });
  assert.deepEqual(placer.place({ projectId: 1, kind: 'apk' }), []);
  assert.equal(placer.buildsMay(1, 1), false);
});

test("set up green for this release's images, and only those", () => {
  const shipped = { android: 'ghcr.io/caraminden/citadel-build-android@sha256:1', rust: 'ghcr.io/caraminden/citadel-build-rust@sha256:2' };
  assert.equal(buildsReady({ run: { role: 'builds', ok: true, images: shipped } }, shipped), true);
  assert.equal(buildsReady({ run: { role: 'builds', ok: false, images: shipped } }, shipped), false);
  assert.equal(buildsReady({ run: { role: 'builds', ok: true, images: { ...shipped, rust: 'old' } } }, shipped), false, 'images moved on since its Set up');
  assert.equal(buildsReady({ run: { role: 'ci', ok: true, images: shipped } }, shipped), false);
  assert.equal(buildsReady(null, shipped), false);
  assert.equal(buildsReady({ run: { role: 'builds', ok: true, images: {} } }, {}), false, 'no images published yet');
});

test("a command's kind is its first word past env settings and wrappers", () => {
  assert.equal(kindOf(['cargo', 'build', '--release']), 'cargo');
  assert.equal(kindOf(['RUSTFLAGS=-Dwarnings', 'nice', '-n', '19', 'cargo', 'test']), 'cargo');
  assert.equal(kindOf(['./gradlew', 'assembleDebug']), 'apk');
  assert.equal(kindOf(['timeout', '30m', 'npm', 'test']), 'suite');
  assert.equal(kindOf(['make', 'all']), 'other');
});

// The lane on a machine's job queue: no go card, its room from the balancer, apart from the one GPU slot.
const tmp = tempRoot('heavy-builds');
const stores: Store[] = [];
after(async () => {
  for (const s of stores) s.db.close();
  await tmp.teardown();
});
let n = 0;
function world(opts: { room?: 'start' | 'wait'; may?: boolean } = {}) {
  const dir = tmp.path(`w${n++}`);
  mkdirSync(dir);
  const store = new Store(join(dir, 'coordinator.db'));
  stores.push(store);
  const owner = store.createUser({ name: 'Owner', login: 'owner' });
  const p = store.createProject('U', null, owner.id);
  const box = store.createMachine('box', 'x', 'Owner', owner.id).id;
  const sent: AgentJobMessage[] = [];
  const woke: string[] = [];
  const cards: object[] = [];
  const asked: string[] = [];
  const done: string[] = [];
  const state = { room: opts.room ?? 'start', may: opts.may ?? true };
  const jobs = new MachineJobs({
    store,
    send: (_m, msg) => (sent.push(msg), true),
    online: () => true,
    broadcast() {},
    postCard: (_j, c) => (cards.push(c), { ticket: 1, question: `q${cards.length}` }),
    settleCard() {},
    wake: (_t, text) => void woke.push(text),
    note() {},
    resultsDir: (j) => join(dir, 'jobs', String(j.id)),
    room: (_id, job) => (asked.push(job.key), state.room),
    heavyDone: (key) => void done.push(key),
    buildsMay: () => state.may,
    now: () => NOW,
  });
  const ticket = store.createTicket({ project_id: p.id, title: 'asker', permission_mode: 'default', created_by: 'owner' } as Parameters<Store['createTicket']>[0]).id;
  const m = () => store.getMachine(box)!;
  const kind: BuildKind = {
    name: 'cargo',
    image: `ghcr.io/caraminden/citadel-build-rust@sha256:${'a'.repeat(64)}`,
    command: ['/bin/sh', '-c', 'true'],
    reads: [],
    gpu: false,
    network: true,
    resumable: false,
    max_limit_s: 7200,
    threads: 8,
    volume: 'citadel-cargo',
    at: '/cache/cargo',
    lane: 'builds',
  };
  const build = () => jobs.queueBuild({ machine: m(), projectId: p.id, ticketId: ticket, askedBy: '#1 asker', kind, inputs: [{ name: 'snapshot.tgz', size: 1, sha256: 'b'.repeat(64), path: join(dir, 'snapshot.tgz') }], limitS: 7200, reason: 'cargo build' }).id;
  return { store, jobs, sent, woke, cards, asked, done, state, m, build, box, p, ticket, owner };
}

test('a build starts once its machine has room for it, with no go card, and says done to the balancer when it ends', () => {
  const w = world();
  const id = w.build();
  assert.deepEqual(w.asked, [`build:${id}`]);
  assert.equal(w.cards.length, 0, 'the Builds role switch is its go');
  const start = w.sent.find((s) => s.type === 'job.start');
  assert.ok(start && start.type === 'job.start');
  assert.equal(start.kind.lane, 'builds');
  assert.equal(w.store.getMachineJob(id)!.state, 'starting');
  w.jobs.report(w.m(), { id, state: 'running', run_s: 0 });
  w.jobs.report(w.m(), { id, state: 'done', run_s: 5, exit_code: 0 });
  assert.deepEqual(w.done, [`build:${id}`]);
  assert.equal(w.woke.length, 0, 'citadel-heavy follows it itself: no wake');
});

test('a build waits queued while its machine has no room, and starts when the balancer has some', () => {
  const w = world({ room: 'wait' });
  const id = w.build();
  assert.equal(w.store.getMachineJob(id)!.state, 'queued');
  assert.equal(w.jobs.view(w.store.getMachineJob(id)!).waits, 'waiting for room');
  w.state.room = 'start';
  w.jobs.pump(w.box);
  assert.equal(w.store.getMachineJob(id)!.state, 'starting');
});

test('a build whose machine switched its Builds role off is refused, not started', () => {
  const w = world({ room: 'wait' });
  const id = w.build();
  w.state.may = false;
  w.jobs.pump(w.box);
  assert.equal(w.store.getMachineJob(id)!.state, 'refused');
  assert.ok(!w.sent.some((s) => s.type === 'job.start'));
});

test("a running build doesn't take the machine's one GPU job slot", () => {
  const w = world();
  w.store.updateMachine(w.box, { jobs: JSON.stringify({ folders: [], max_limit_h: 12, max_disk_gb: null, gpu: true }), job_settings: JSON.stringify(DEFAULT_SETTINGS) });
  const b = w.build();
  w.jobs.report(w.m(), { id: b, state: 'running', run_s: 0 });
  const gpu: JobKind = { name: 'k', image: `docker.io/x/y@sha256:${'c'.repeat(64)}`, command: ['run'], reads: [], gpu: true, network: false, resumable: false, max_limit_s: 3600 };
  const g = w.jobs.queue({ machine: w.m(), projectId: w.p.id, ticketId: w.ticket, contraptionId: null, askedBy: 'test', kind: gpu, inputs: [], limitS: 600, when: 'now', reason: 'test' }).id;
  w.jobs.decide(g, 'now', { uid: w.owner.id, name: 'Owner', admin: false });
  assert.ok(
    w.sent.some((s) => s.type === 'job.start' && s.id === g),
    'the GPU job starts beside the build',
  );
});
