import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { BuildPlacer, buildRoom, buildsReady, KIND_SIZE, place, SCRIPT } from '../src/heavy-builds.ts';
import { balance, MachineBalancer } from '../src/machine-balancer.ts';
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
  assert.equal(kindOf(['citadel-test', 'test/x.test.ts']), null, "Citadel's own tools aren't in a build image");
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
  const held: string[] = [];
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
    heavyHeld: (_id, job) => void held.push(job.key),
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
  return { store, jobs, sent, woke, cards, asked, done, held, state, m, build, box, p, ticket, owner };
}

test('a build starts once its machine has room for it, with no go card, and says done to the balancer when it ends', () => {
  const w = world();
  const id = w.build();
  assert.deepEqual(w.asked, [`build:${id}`]);
  assert.equal(w.cards.length, 0, 'the Builds role switch is its go');
  const start = w.sent.find((s) => s.type === 'job.start');
  assert.ok(start && start.type === 'job.start');
  assert.equal((start.kind as Partial<BuildKind>).lane, 'builds');
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

test("two builds placed at once don't both start past the Builds role's threads cap, and one bigger than the cap still starts alone", () => {
  const { balancer } = two({ cara: 0, josh: 0 });
  const job = (id: number, size = 8) => ({ key: `build:${id}`, label: `cargo build ${id}`, size });
  assert.equal(buildRoom(balancer, 1, job(1), 10), 'start');
  assert.equal(buildRoom(balancer, 1, job(2), 10), 'wait', '8 + 8 is past the cap of 10');
  assert.equal(buildRoom(balancer, 1, { key: 'gpu:3', label: 'GPU job 3', size: 4 }, null), 'start', 'not a build: no cap');
  balancer.done('build:1');
  assert.equal(buildRoom(balancer, 1, job(4, 12), 10), 'start', 'bigger than the cap, with no other build there');
});

test('after a server restart a build still running holds its threads again, and a builds-only list loses only builds', () => {
  const w = world();
  const id = w.build();
  w.jobs.report(w.m(), { id, state: 'running', run_s: 0 });
  w.store.updateMachineJob(id, { started_at: 1 });
  const lost = w.build();
  w.store.updateMachineJob(lost, { state: 'running', started_at: 1 });
  const { id: _id, ...row } = w.store.getMachineJob(id)!;
  const gpu = w.store.addMachineJob({ ...row, kind_name: 'k', go: 'now', state: 'running' });
  w.store.updateMachineJob(gpu.id, { started_at: 1 });
  w.jobs.reconcile(w.m(), null, NOW, [{ id, state: 'running' }]);
  assert.ok(w.held.includes(`build:${id}`), 'held again');
  assert.equal(w.store.getMachineJob(lost)!.state, 'failed', 'a build the agent lost');
  assert.equal(w.store.getMachineJob(gpu.id)!.state, 'running', "a GPU job isn't judged by a builds-only list");
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

// The script the build image runs (src/heavy-builds.ts), run under sh here with its /tmp moved into a test folder.
test("the image's script unpacks the snapshot, runs in the caller's folder and packs the files to bring back from the top", () => {
  const d = tmp.path(`script${n++}`);
  mkdirSync(join(d, 'src', 'sub'), { recursive: true });
  writeFileSync(join(d, 'src', 'sub', 'build.sh'), 'mkdir -p out && echo bin > out/app.bin && echo built\nexit 3\n');
  const snap = execFileSync('tar', ['-czf', '-', '-C', join(d, 'src'), 'sub']);
  const script = SCRIPT.replaceAll('/tmp/', `${d}/`);
  assert.match(SCRIPT, /tar --no-same-owner -xzf/, 'root with no capabilities cannot chown');
  const r = spawnSync('sh', ['-c', script, 'citadel-heavy', 'sub', 'sub/out/app.bin\nsub/missing', 'sh', 'build.sh'], { input: snap, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /built/);
  assert.deepEqual(
    execFileSync('tar', ['-tzf', join(d, 'back.tgz')], { encoding: 'utf8' })
      .trim()
      .split('\n'),
    ['sub/out/app.bin'],
  );
});

// tools/heavy-builds.ts against a stand-in Citadel: what it sends, and what it does with each way a job ends.
type Stub = { states: object[]; startHangs?: boolean; back?: boolean };
async function client(stub: Stub, args: string[]) {
  const top = tmp.path(`wc${n++}`);
  mkdirSync(join(top, 'sub'), { recursive: true });
  execFileSync('git', ['init', '-q', top]);
  for (const [f, body] of [
    ['sub/main.rs', 'fn main(){}'],
    ['.env', 'SECRET=1'],
    ['sub/release.key', 'k'],
    ['sub/.env.local', 'x'],
  ])
    writeFileSync(join(top, f), body);
  const seen = { start: null as Record<string, unknown> | null, files: [] as string[], stops: 0, done: 0 };
  let look = 0;
  const backTar = tmp.path(`back${n++}`);
  mkdirSync(join(backTar, 'src', 'sub', 'out'), { recursive: true });
  writeFileSync(join(backTar, 'src', 'sub', 'out', 'app.bin'), 'remote');
  execFileSync('tar', ['-czf', join(backTar, 'back.tgz'), '-C', join(backTar, 'src'), 'sub/out/app.bin']);
  execFileSync('tar', ['-cf', join(backTar, 'back.tar'), '-C', backTar, 'back.tgz']);
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (code: number, v: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST') {
      const b = JSON.parse(body) as Record<string, unknown>;
      if (b.do === 'place') return send(200, { spots: [{ id: 2, name: "Josh's PC", free: 8 }] });
      if (b.do === 'start') {
        if (stub.startHangs) return req.socket.destroy();
        seen.start = b;
        seen.files = execFileSync('tar', ['-tzf', String(b.snapshot)], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .sort();
        return send(201, { job: 5, machine: "Josh's PC" });
      }
      if (b.do === 'stop') return (seen.stops++, send(200, {}));
      if (b.do === 'done') return (seen.done++, send(200, { ok: true }));
    }
    if (url.pathname.endsWith('/5')) return send(200, { id: 5, online: true, waits: null, error: null, exit_code: null, ...stub.states[Math.min(look++, stub.states.length - 1)] });
    if (url.searchParams.get('name') === 'log') return (res.writeHead(200), res.end('remote log\n'));
    if (url.searchParams.get('name') === 'back' && stub.back) return (res.writeHead(200), res.end(readFileSync(join(backTar, 'back.tar'))));
    send(404, { error: 'none' });
  });
  const port = await tmp.serve(server);
  const fell = tmp.path(`fell${n++}`);
  const env = { ...process.env, COORDINATOR_API: `http://127.0.0.1:${port}`, COORDINATOR_TOKEN: 't', COORDINATOR_TICKET: '9', CITADEL_HEAVY_BUILD_POLL_MS: '20', CITADEL_HEAVY_AWAY_MS: '100', CITADEL_HEAVY_FALLBACK_FILE: fell, CITADEL_HEAVY_WAITED_FILE: `${fell}-waited`, CITADEL_HEAVY_UNATTENDED: undefined };
  const p = tmp.spawn(process.execPath, [join(import.meta.dirname, '..', 'tools', 'heavy-builds.ts'), ...args], { cwd: join(top, 'sub'), env });
  let out = '';
  let err = '';
  p.stdout!.on('data', (c) => (out += c));
  p.stderr!.on('data', (c) => (err += c));
  const status = await new Promise<number | null>((ok) => p.on('close', ok));
  const waited = existsSync(`${fell}-waited`) ? readFileSync(`${fell}-waited`, 'utf8') : '';
  return { status, out, err, seen, top, fell: existsSync(fell), waited };
}

test('a job that ran there: the snapshot leaves out .env and keys, its log and --back files come back from this folder, and done is said', async () => {
  const c = await client({ states: [{ state: 'running' }, { state: 'done', exit_code: 0 }], back: true }, ['--back', 'out/app.bin', '--', 'cargo', 'build']);
  assert.equal(c.status, 0, c.err);
  assert.deepEqual(c.seen.files, ['sub/main.rs'], 'no .env, .env.local or key file');
  assert.equal(c.seen.start!.dir, 'sub');
  assert.deepEqual(c.seen.start!.back, ['sub/out/app.bin'], 'a path from here, sent from the top');
  assert.equal(readFileSync(join(c.top, 'sub', 'out', 'app.bin'), 'utf8'), 'remote');
  assert.match(c.out, /remote log/);
  assert.equal(c.seen.done, 1);
  assert.ok(!c.fell);
});

test("a job that waited for room there says so for the history line (#2109); one that started at once doesn't", async () => {
  const waited = await client({ states: [{ state: 'queued' }, { state: 'done', exit_code: 0 }] }, ['--', 'cargo', 'build']);
  assert.equal(waited.waited, 'room', waited.err);
  const atOnce = await client({ states: [{ state: 'done', exit_code: 0 }] }, ['--', 'cargo', 'build']);
  assert.equal(atOnce.waited, '');
});

test("a green build whose --back files don't come back fails here, and its results stay on Citadel", async () => {
  const c = await client({ states: [{ state: 'done', exit_code: 0 }] }, ['--back', 'out/app.bin', '--', 'cargo', 'build']);
  assert.equal(c.status, 1, c.err);
  assert.match(c.err, /stay on Citadel/);
  assert.equal(c.seen.done, 0);
});

test('podman never ran it there (125): it falls back to perigee; a command that ran and failed does not', async () => {
  const never = await client({ states: [{ state: 'failed', error: "podman couldn't start the build (125): no image" }] }, ['--', 'cargo', 'build']);
  assert.equal(never.status, 120, never.err);
  assert.ok(never.fell);
  const ran = await client({ states: [{ state: 'failed', error: 'podman run failed', exit_code: null }] }, ['--', 'cargo', 'build']);
  assert.equal(ran.status, 1, ran.err);
  assert.ok(!ran.fell, 'it may have run: never twice');
});

test('its machine goes away: still waiting there it falls back to perigee; running there it is stopped and says so', async () => {
  const queued = await client({ states: [{ state: 'queued', online: false }] }, ['--', 'cargo', 'build']);
  assert.equal(queued.status, 120, queued.err);
  assert.ok(queued.fell);
  const running = await client({ states: [{ state: 'running', online: false }] }, ['--', 'cargo', 'build']);
  assert.equal(running.status, 1, running.err);
  assert.match(running.err, /went away mid-job/);
  assert.equal(running.seen.stops, 1);
  assert.ok(!running.fell);
});

test('no answer to its start: it may run there, so it never falls back to perigee', async () => {
  const c = await client({ states: [], startHangs: true }, ['--', 'cargo', 'build']);
  assert.equal(c.status, 1, c.err);
  assert.match(c.err, /may run there/);
  assert.ok(!c.fell);
});

test("a release APK queued by Citadel (a contraption's build job) goes ahead of the builds already waiting", () => {
  const w = world({ room: 'wait' });
  const first = w.build();
  const kind = JSON.parse(w.store.getMachineJob(first)!.kind) as BuildKind;
  const c = w.store.createContraption({ name: 'reader', title: 'Reader', icon: null, port: 9, home_scheme: w.p.id, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
  const release = w.jobs.queueBuild({ machine: w.m(), projectId: w.p.id, ticketId: null, contraptionId: c.id, askedBy: 'Reader APK build', kind, inputs: [], limitS: 7200, reason: 'release' }).id;
  w.state.room = 'start';
  w.asked.length = 0;
  w.jobs.pump(w.box);
  assert.deepEqual(w.asked, [`build:${release}`, `build:${first}`]);
});

test('a release build is next for the room even when an older build already holds a place in the wait', () => {
  const job = (key: string, since: number, first?: boolean) => ({ key, label: key, size: 8, since, first });
  const plan = balance({ threads: 8, caps: { workers: null, runners: null, turnThreads: null, ciThreads: null }, ship: false, ciWaiting: 0, running: 0, heavy: [job('build:1', 1), job('build:2', 2, true)], now: 3 });
  assert.deepEqual(plan.start, ['build:2']);
});
