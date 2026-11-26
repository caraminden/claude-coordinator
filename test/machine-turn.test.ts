import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, lines, ok, stopProcs, tempRoot, until, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { askCheckpoint, awayTimes, MachineTurn, machineLink, placeTurn, placedAt, sameClaude, syncTurns, type MachineLaunch } from '../src/machine-turn.ts';
import { runningTurn, wrapperAlive } from '../src/running-turn.ts';
import { machineEnv } from '../src/turn-launch.ts';
import { containerArgs, workerConfig, Worker } from '../public/machine-worker.mjs';

// A turn on a connected machine (Build 7 T2): the sync contract by itself, then the whole path with the real server,
// the real agent and its worker, a stand-in podman that runs the "container's" commands here with the turns folder
// mapped to the worker's own copy, and a stand-in claude that answers steers and a stop.
const tmp = tempRoot('machine-turn-');
const root = tmp.dir;
const procs: ChildProcess[] = [];
let srv: Booted | undefined;
after(async () => {
  try {
    await srv?.settled();
  } finally {
    await stopProcs(procs);
    await tmp.teardown();
  }
});

const launch: MachineLaunch = { wrapper: ['node', 'w.mjs', 'dir'], cwd: null, home: '/home/x', roots: ['/data/turns'] };
let n = 0;
/** A turn folder placed on machine `id`, as the runner leaves one. */
async function placed(id: number) {
  const dir = join(root, 'unit', `turn-${++n}`);
  mkdirSync(dir, { recursive: true });
  for (const f of ['stream.jsonl', 'stderr.log', 'steer.jsonl']) writeFileSync(join(dir, f), '');
  await placeTurn(dir, { id, name: `box-${id}` }, launch);
  return dir;
}
const b64 = (s: string) => Buffer.from(s).toString('base64');
const text = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const one = async (id: number, turn: Record<string, unknown> & { dir: string }) => {
  const r = (await syncTurns(id, { turns: [turn] })).turns[turn.dir];
  if (!('sizes' in r)) throw new Error(`the turn is not the machine's: ${JSON.stringify(r)}`);
  return r;
};

test('a placed turn is offered to its own machine until the agent holds it, and to no other', async () => {
  const dir = await placed(1);
  assert.deepEqual(
    (await syncTurns(1, {})).start.filter((s) => s.dir === dir),
    [{ dir, launch }],
  );
  assert.deepEqual((await syncTurns(2, {})).start, []);
  assert.deepEqual(
    (await syncTurns(1, { turns: [{ dir }] })).start.filter((s) => s.dir === dir),
    [],
    'not offered again once held',
  );
  assert.deepEqual((await syncTurns(2, { turns: [{ dir, append: { 'stream.jsonl': { at: 0, data: b64('forged\n') } } }] })).turns[dir], { gone: true }, "another machine's turn is not this one's");
  assert.equal(text(dir, 'stream.jsonl'), '');
  // One stopped before the agent took it has ended here: there is nothing to start.
  new MachineTurn(dir, placedAt(dir)!).endStart();
  assert.deepEqual(
    (await syncTurns(1, {})).start.filter((s) => s.dir === dir),
    [],
  );
});

test('the stream is appended only at the size the server holds, so a resend or a gap changes nothing', async () => {
  const dir = await placed(1);
  assert.equal((await one(1, { dir, append: { 'stream.jsonl': { at: 0, data: b64('a\n') } } })).sizes['stream.jsonl'], 2);
  // The same bytes again (the answer was lost), then bytes past a gap: both refused, and told where to send from.
  assert.equal((await one(1, { dir, append: { 'stream.jsonl': { at: 0, data: b64('a\n') } } })).sizes['stream.jsonl'], 2);
  assert.equal((await one(1, { dir, append: { 'stream.jsonl': { at: 9, data: b64('z\n') } } })).sizes['stream.jsonl'], 2);
  assert.equal((await one(1, { dir, append: { 'stream.jsonl': { at: 2, data: b64('b\n') }, 'stderr.log': { at: 0, data: b64('oops') } } })).sizes['stream.jsonl'], 4);
  assert.equal(text(dir, 'stream.jsonl'), 'a\nb\n');
  assert.equal(text(dir, 'stderr.log'), 'oops');
  // An agent that names a file of its own choosing writes nothing.
  await one(1, { dir, append: { 'spec.json': { at: 0, data: b64('{}') } }, put: { machine: '{}', 'pid.json': '{"claude":7}' } });
  assert.equal(existsSync(join(dir, 'spec.json')), false);
  assert.equal(placedAt(dir)?.id, 1);
  assert.equal(text(dir, 'pid.json'), '{"claude":7}');
});

test('steers and signals go down past what the agent has, and a turn ended here keeps its end', async () => {
  const dir = await placed(1);
  writeFileSync(join(dir, 'steer.jsonl'), '{"s":1}\n{"s":2}\n{"half');
  assert.equal(Buffer.from((await one(1, { dir, steer: 0 })).steer!, 'base64').toString(), '{"s":1}\n{"s":2}\n', 'whole lines only');
  assert.equal(Buffer.from((await one(1, { dir, steer: 8 })).steer!, 'base64').toString(), '{"s":2}\n');
  assert.equal((await one(1, { dir, steer: 16 })).steer, undefined);
  const turn = runningTurn({ dir, unit: null, container: null });
  assert.ok(turn instanceof MachineTurn, 'a folder with a machine file is a machine turn');
  turn.signal('SIGINT');
  turn.signal('SIGTERM');
  assert.deepEqual((await one(1, { dir, signals: 0 })).signals, ['SIGINT', 'SIGTERM']);
  assert.deepEqual((await one(1, { dir, signals: 1 })).signals, ['SIGTERM']);
  assert.deepEqual((await one(1, { dir, signals: 2 })).signals, []);
  // Stopped before it started: the end written here stands, whatever the machine sends after.
  turn.endStart();
  await one(1, { dir, append: { 'stream.jsonl': { at: 0, data: b64('late\n') } }, put: { 'exit.json': '{"code":0,"signal":null}' } });
  assert.equal(text(dir, 'stream.jsonl'), '');
  assert.deepEqual(JSON.parse(text(dir, 'exit.json')), { code: null, signal: null, stopped: true });
});

test('alive by its syncs while the agent is connected; away is not gone, and a stop while away ends it here at once', async (t) => {
  const was = { ...machineLink };
  t.after(() => Object.assign(machineLink, was));
  let online = true;
  machineLink.online = () => online;
  // Just after this server starts, or a machine comes back, a stale beat is no sign yet: the grace is the away tests'.
  awayTimes.back = 0;
  t.after(() => void (awayTimes.back = 30_000));
  const dir = await placed(1);
  const old = new Date(Date.now() - 120_000);
  assert.equal(wrapperAlive(dir), true, 'its first beat counts while the agent fetches it');
  utimesSync(join(dir, 'beat'), old, old);
  assert.equal(wrapperAlive(dir), false, 'silent with its agent connected: gone');
  await one(1, { dir, alive: true });
  assert.ok(statSync(join(dir, 'beat')).mtimeMs > old.getTime(), 'a sync that says it runs is its beat');
  assert.equal(wrapperAlive(dir), true);
  utimesSync(join(dir, 'beat'), old, old);
  await one(1, { dir, alive: false });
  assert.equal(wrapperAlive(dir), false, "a sync that says it doesn't run is no beat");
  online = false;
  assert.equal(wrapperAlive(dir), true, 'its machine away: still counted as running');
  const turn = runningTurn({ dir, unit: null, container: null });
  turn.signal('SIGINT');
  await until("a person's stop frees the minion without waiting for its machine", () => existsSync(join(dir, 'exit.json')));
  const end = JSON.parse(text(dir, 'exit.json'));
  assert.deepEqual({ ...end, away: { ...end.away, since: 0 } }, { code: null, signal: 'SIGINT', away: { name: 'box-1', since: 0, checkpoint: null, home: true } });
  assert.ok(end.away.since > old.getTime(), 'away since its last sync');
  assert.deepEqual((await one(1, { dir, signals: 0 })).signals, ['SIGINT'], 'and the machine still gets it when it returns');
});

test("the worker container holds only the turn's folders, and the home volume", () => {
  const cfg = workerConfig({ root: '/w', image: 'img', mounts: [{ src: '/mnt/c', dst: '/mnt/c' }] });
  const mounts = (args: string[]) => args.filter((_, i) => ['--mount', '-v'].includes(args[i - 1]));
  // Nothing in the owner's file adds a folder: only the turn's own roots are in it.
  assert.deepEqual(mounts(containerArgs(cfg, { home: '/home/x', roots: ['/data/turns', '/data/projects'] })), ['citadel-worker-home:/home/x:U', 'type=bind,src=/w/fs/data/turns,dst=/data/turns', 'type=bind,src=/w/fs/data/projects,dst=/data/projects']);
  // The seam host reach (T8) fills, for a marked minion only: nothing unless it is passed.
  assert.deepEqual(mounts(containerArgs(cfg, { home: '/home/x', roots: [] }, [{ src: '/mnt/c/art', dst: '/host/art', ro: true }])), ['citadel-worker-home:/home/x:U', 'type=bind,src=/mnt/c/art,dst=/host/art,ro']);
  assert.throws(() => workerConfig({ root: 'relative', image: 'img' }));
  assert.throws(() => workerConfig({ root: '/w' }));
  // A turn is placed only when both versions are known and the same.
  assert.equal(sameClaude('2.1.9 (Claude Code)', '2.1.9 (Claude Code)'), true);
  assert.equal(sameClaude('2.1.9 (Claude Code)', '2.1.10 (Claude Code)'), false);
  assert.equal(sameClaude('2.1.9 (Claude Code)', null), false);
  assert.equal(sameClaude(null, null), false);
});

const state = { ticket: 1, config: { here: '/c', there: '/c' } };
async function stateful(id: number) {
  const dir = await placed(id);
  await placeTurn(dir, { id, name: `box-${id}` }, { ...launch, state });
  return dir;
}

test('a checkpoint asked for here waits for the agent to finish it, and says why when it cannot', async (t) => {
  const was = { ...machineLink };
  t.after(() => Object.assign(machineLink, was));
  machineLink.online = () => true;
  assert.equal(await askCheckpoint(await placed(5)), null, 'a turn with no state to sync has nothing to wait for');
  const dir = await stateful(5);
  let done: string | null | undefined;
  const asked = askCheckpoint(dir).then((p) => (done = p));
  const r = await one(5, { dir });
  assert.ok(r.checkpoint! > 0);
  assert.match(r.script!, /^[0-9a-f]{16}$/);
  await one(5, { dir, home: r.checkpoint! - 1 });
  assert.equal(done, undefined, 'an earlier checkpoint does not answer it');
  await one(5, { dir, home: r.checkpoint! });
  await asked;
  assert.equal(done, null);
  assert.equal((await one(5, { dir })).checkpoint, undefined, 'asked once');

  const second = askCheckpoint(dir);
  await one(5, { dir, home: (await one(5, { dir })).checkpoint!, homeFailed: 'disk full' });
  assert.equal(await second, 'disk full');
  assert.match((await askCheckpoint(dir, 1))!, /did not send/);
  machineLink.online = () => false;
  assert.match((await askCheckpoint(dir))!, /box-5.* is not connected/);
  // What the agent is sent of it: where its record goes, and what runs one at a time; not the server's paths.
  const start = (await syncTurns(5, {})).start.find((s) => s.dir === dir)!;
  assert.deepEqual(start.launch, { ...launch, sync: { at: join(root, 'unit', '.sync'), key: dir } });
});

/** A worker holding one seeded turn, whose sync program answers from `say`. */
async function seededWorker(say: (arg: Record<string, unknown>) => unknown) {
  const ran: Record<string, unknown>[] = [];
  const run = async (_cmd: string, args: string[]) => {
    const arg = JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString());
    ran.push(arg);
    return { code: 0, out: `${JSON.stringify(await say(arg))}\n`, err: '' };
  };
  const dir = '/data/turns/t';
  const home = join(root, `w-${++n}`);
  const local = join(home, 'fs', dir);
  mkdirSync(local, { recursive: true });
  for (const f of ['beat', 'stream.jsonl', 'stderr.log', 'steer.jsonl']) writeFileSync(join(local, f), '');
  writeFileSync(join(home, 'turns.json'), JSON.stringify([{ dir, launch: { ...launch, sync: { at: '/data/turns/.sync', key: 'k' } }, applied: 0, seeded: true, script: 'x' }]));
  mkdirSync(join(home, 'fs', 'data', 'turns', '.sync'));
  writeFileSync(join(home, 'fs', 'data', 'turns', '.sync', 'machine-sync-x.mjs'), '');
  const w = new Worker({ config: { root: home, image: 'img' }, appUrl: 'http://127.0.0.1:9', token: 't', run, checkpointMs: 60_000 });
  w.poke = () => {};
  const ensured: unknown[] = [];
  w.ensureContainer = async (l: unknown) => void ensured.push(l);
  const posts: string[] = [];
  w.call = async (path: string) => (posts.push(path), new Response('{}'));
  const t = w.turns.get(dir)!;
  t.ref = 0;
  t.acked = { 'stream.jsonl': 0, 'stderr.log': 0 };
  return { w, t, local, ran, ensured, posts, idle: () => until('the checkpoint', () => !t.checking && !t.steering) };
}

test("a turn's end is told only once its last checkpoint is home; out of reach it waits, and broken it gives up and says so", async () => {
  let answer: unknown = { error: 'no route', offline: true };
  const s = await seededWorker(() => answer);
  writeFileSync(join(s.local, 'exit.json'), '{"code":0}');
  const tick = async () => {
    s.t.nextTry = 0;
    s.w.checkpointIfDue(s.t);
    await s.idle();
    return s.w.report(s.t).body;
  };
  for (let i = 0; i < 5; i++) {
    const body = await tick();
    assert.equal(body.put['exit.json'], undefined);
    assert.equal(body.alive, true, 'and it still counts as running');
  }
  answer = { ok: true };
  assert.equal((await tick()).put['exit.json'], '{"code":0}');
  assert.equal(s.ran.length, 6);
  await tick();
  assert.equal(s.ran.length, 6, 'one last checkpoint, no more');
  assert.deepEqual(s.posts, []);

  const broken = await seededWorker(() => ({ error: 'bad object' }));
  writeFileSync(join(broken.local, 'exit.json'), '{"code":0}');
  for (let i = 0; i < 3; i++) {
    assert.equal(broken.w.report(broken.t).body.put['exit.json'], undefined);
    broken.t.nextTry = 0;
    broken.w.checkpointIfDue(broken.t);
    await broken.idle();
  }
  assert.equal(broken.w.report(broken.t).body.put['exit.json'], '{"code":0}');
  assert.match(broken.posts.join(), /state\/failed\?dir=/);

  // Its program can't be had: the app out of reach is waited out, an answer that will not mend is not.
  for (const [call, offline] of [
    [async () => Promise.reject(new TypeError('fetch failed')), true],
    [async () => new Response('', { status: 503 }), true],
    [async () => new Response('', { status: 500 }), false],
  ] as const) {
    const s2 = await seededWorker(() => ({ ok: true }));
    s2.t.script = 'other';
    s2.w.call = call;
    const r = await s2.w.stateSync(s2.t, {});
    assert.ok(r.error);
    assert.equal(r.offline ?? false, offline);
  }
});

test('a checkpoint is made on a commit, when the server asks, and every couple of minutes, and not otherwise', async () => {
  const s = await seededWorker(() => ({ ok: true }));
  const tick = async () => {
    s.w.checkpointIfDue(s.t);
    await s.idle();
    return s.ran.length;
  };
  assert.equal(await tick(), 0);
  s.t.asked = 5;
  assert.equal(await tick(), 1);
  assert.equal(s.w.report(s.t).body.home, 5);
  assert.equal(s.ran[0].final, true, 'a tool waits for it: nothing is left for the next');
  assert.equal(s.ensured.length, 1, 'its container may have stopped with the machine');
  s.w.headLog = () => 200;
  assert.equal(await tick(), 2);
  assert.equal(await tick(), 2);
  s.t.checked = Date.now() - 61_000;
  assert.equal(await tick(), 3);
  assert.equal(s.ran[2].final, false);
  assert.equal(s.w.lines.size, 0, 'its line is let go');

  // Kept aside at home: whoever waits is told why, and the turn's end isn't held for it.
  const kept = await seededWorker(() => ({ ok: true, kept: 'the worktree here moved' }));
  kept.t.asked = 5;
  kept.w.checkpointIfDue(kept.t);
  await kept.idle();
  assert.equal(kept.w.report(kept.t).body.homeFailed, 'the worktree here moved');
});

test('a steer reaches the turn after the pictures it may name', async () => {
  let there = '';
  const s: Awaited<ReturnType<typeof seededWorker>> = await seededWorker(() => {
    there = text(s.local, 'steer.jsonl');
    return { ok: true };
  });
  await s.w.heard(s.t, { put: {} }, { sizes: {}, signals: [], steer: b64('{"s":1}\n') });
  await s.w.heard(s.t, { put: {} }, { sizes: {}, signals: [], steer: b64('{"s":1}\n') });
  await s.idle();
  assert.equal(there, '', 'not before the sync');
  assert.equal(text(s.local, 'steer.jsonl'), '{"s":1}\n', 'once, though it was sent twice');
  assert.deepEqual(s.ran[0].roots, ['uploads', 'files']);
});

// ---- the whole path ----

const bin = join(root, 'bin');
mkdirSync(bin);
const workerRoot = join(root, 'worker');
const calls = join(root, 'podman-calls');
const heard = join(root, 'heard.log');
const release = join(root, 'release');
/** With it, claude says it is this session. */
const sessionFile = join(root, 'session');
/** The machine's agent in the whole-path tests, and a fresh one in its place. */
type Agent = ReturnType<ReturnType<typeof machineFakes>['startMachineAgent']>;
let agentNow: () => Agent;
let restartAgent: () => Agent;
// podman: `exec [-d] <container> <command…>` runs the command here, the server's turns folder mapped to the worker's
// copy as the container's mount does; `run` and `inspect` are only recorded (no container runs yet, each time).
const podman = join(bin, 'podman');
const fakePodman = (turnsDir: string) =>
  writeFileSync(
    podman,
    `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process');
const a = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(calls)}, a.join(' ') + '\\n');
if (a.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
if (a[0] !== 'exec') process.exit(a[0] === 'run' ? 0 : 1);
const detached = a[1] === '-d';
const cmd = a.slice(detached ? 3 : 2).map((s) => (s === ${JSON.stringify(turnsDir)} || s.startsWith(${JSON.stringify(turnsDir + '/')}) ? ${JSON.stringify(join(workerRoot, 'fs'))} + s : s));
if (cmd.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
if (detached) { spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' }).unref(); process.exit(0); }
// The state sync program (T3) reads the server's paths from its call: where the container would mount them, it is told.
process.exit(spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, CITADEL_SYNC_PREFIX: ${JSON.stringify(join(workerRoot, 'fs'))} } }).status ?? 1);
`,
  );
// claude: says what it hears on stdin (the prompt, then steers), asks the app who it is through COORDINATOR_API as its
// tools would, ends on the release file, and on an interrupt ends with a result as claude does.
const claude = join(root, 'claude-steer');
writeFileSync(
  claude,
  `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
const fs = require('node:fs');
const out = (o) => console.log(JSON.stringify(o));
const end = (result) => { out({ type: 'result', subtype: 'success', is_error: false, result }); process.exit(0); };
let n = 0;
if (fs.existsSync(${JSON.stringify(sessionFile)})) out({ type: 'system', subtype: 'init', session_id: fs.readFileSync(${JSON.stringify(sessionFile)}, 'utf8') });
require('node:readline').createInterface({ input: process.stdin }).on('line', async () => {
  n++;
  let status = 0;
  try {
    status = (await fetch(process.env.COORDINATOR_API + '/api/tickets/' + process.env.COORDINATOR_TICKET, { headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN } })).status;
  } catch {}
  fs.appendFileSync(${JSON.stringify(heard)}, JSON.stringify({ n, api: process.env.COORDINATOR_API, status, dir: process.argv[1], config: process.env.CLAUDE_CONFIG_DIR ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.COORDINATOR_TOKEN, resume: process.argv[process.argv.indexOf('--resume') + 1] }) + '\\n');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'heard ' + n }] } });
});
process.on('SIGINT', () => end('interrupted'));
setInterval(() => fs.existsSync(${JSON.stringify(release)}) && end('done'), 20);
`,
);
chmodSync(claude, 0o755);

test("a machine turn's environment carries no Claude or GitHub sign-in", () => {
  const sent = machineEnv({
    PATH: '/bin',
    GIT_AUTHOR_NAME: 'Josh',
    COORDINATOR_TOKEN: 't',
    CLAUDE_CODE_TMPDIR: '/t',
    GH_TOKEN: 'gho_x',
    GITHUB_TOKEN: 'x',
    GH_CONFIG_DIR: '/srv/gh',
    CLAUDE_CONFIG_DIR: '/srv/claude',
    CLAUDE_CODE_OAUTH_TOKEN: 'x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'x',
    ANTHROPIC_CUSTOM_HEADERS: 'x',
    ANTHROPIC_FOUNDRY_API_KEY: 'x',
  });
  assert.deepEqual(Object.keys(sent).sort(), ['CLAUDE_CODE_TMPDIR', 'COORDINATOR_TOKEN', 'GIT_AUTHOR_NAME', 'PATH']);
});

test('a turn placed on a machine starts, streams, steers, survives a server restart and ends there', async () => {
  // HOME is the scratch root: a scheme's folder must be under the server's home, and on CI the temp folder isn't under the runner's.
  const env = { HOME: root, CLAUDE_BIN: claude, ANTHROPIC_API_KEY: 'the-servers-key', PATH: `${bin}:${process.env.PATH}` };
  srv = await bootServer({ root, env });
  procs.push(srv.proc);
  const turnsDir = join(srv.data, 'run', 'turns');
  fakePodman(turnsDir);
  chmodSync(podman, 0o755);
  let call = async (path: string, body?: unknown, method?: string) => ok(await srv!.call(path, body, method));
  const { machine, token } = await call('/api/machines', { name: 'w1', mine: true });
  const other = await call('/api/machines', { name: 'w2', mine: true });
  const config = join(root, 'machine-agent.json');
  writeFileSync(config, JSON.stringify({ worker: { root: workerRoot, image: 'citadel-worker', max: 2 } }));
  const { startMachineAgent } = machineFakes(root, procs);
  restartAgent = () => startMachineAgent({ base: srv!.base, token, run: ['--config', config], env: { PATH: env.PATH } });
  let agent = restartAgent();
  agentNow = () => agent;
  restartAgent = () => (agent = startMachineAgent({ base: srv!.base, token, run: ['--config', config], env: { PATH: env.PATH } }));
  await until('the machine to come online', async () => (await call('/api/machines')).find((m: { name: string; online: boolean }) => m.name === 'w1' && m.online));
  const project = await call('/api/projects', { name: 'P' });

  // The switch is off: a turn runs here, as before.
  const home = await call(`/api/projects/${project.id}/tickets`, { message: 'at home' });
  await until('the home turn to say what it heard', () => lines(heard).length === 1);
  assert.equal(existsSync(join(workerRoot, 'turns.json')), false, 'nothing reached the worker');
  assert.equal(JSON.parse(lines(heard)[0]).api, srv.base.replace('localhost', '127.0.0.1'));
  writeFileSync(release, '');
  await until('the home turn to end', async () => (await call(`/api/tickets/${home.id}`)).ticket.status !== 'running');
  writeFileSync(heard, '');

  // Switched on by its owner and lent to the scheme: a minion marked for it runs there, its worker's claude being the server's, with perigee's own workers all free.
  await until("the worker to say its claude's version", () => /claude here is 9\.9\.9/.test(agent.output()));
  await call(`/api/machines/${machine.id}`, { lend: { server: null, workspaces: [], worker: true }, projects: [project.id] }, 'PATCH');
  rmSync(release);
  const ticket = await call(`/api/projects/${project.id}/tickets`, { message: 'on the machine', runs_on: 'w1' });
  const first = JSON.parse((await until('the machine turn to say what it heard', () => lines(heard).length === 1 && lines(heard)))[0]);
  const dir = join(turnsDir, (await until('its folder', () => require_dirs(turnsDir).find((d) => existsSync(join(turnsDir, d, 'machine')))))!);
  const local = join(workerRoot, 'fs', dir);
  assert.notEqual(first.api, srv.base.replace('localhost', '127.0.0.1'), "its tools call home through the agent's forwarder");
  assert.equal(first.status, 200, "and the call arrives as the turn's own");
  assert.equal(first.config, null, "the sign-in is the machine's own: the server's config folder is not named there");
  const placedHere = JSON.parse(text(dir, 'machine'));
  assert.equal(placedHere.account, 1, "the account it runs on goes with it (#2061): account 1, Claude Code's default folder there");
  assert.equal(placedHere.state.config.there, join(root, '.claude'), 'and its session goes to that folder');
  assert.equal(first.key, null, "and the server's own key never leaves it");
  await until("claude's stream to be written on the machine", () => /heard 1/.test(text(local, 'stream.jsonl')));
  await until('the stream to come home', () => /heard 1/.test(text(dir, 'stream.jsonl')));
  await until('its pid to come home', () => existsSync(join(dir, 'pid.json')) && JSON.parse(text(dir, 'pid.json')).claude > 0);
  assert.match(readFileSync(calls, 'utf8'), /^run -d .*--userns=keep-id.* citadel-worker sleep infinity$/m);

  // The tool route serves only that machine's turns, with the turn's token.
  const direct = (machineToken: string, turn: string) => fetch(`${srv!.base}/api/machines/turn-call/api/tickets/${ticket.id}`, { headers: { Authorization: `Bearer ${machineToken}`, 'X-Turn-Authorization': turn } });
  assert.equal((await direct(other.token, `Bearer ${ticket.id}.x.y`)).status, 403, "another machine's token");
  assert.equal((await direct(token, `Bearer ${home.id}.x.y`)).status, 403, 'a turn that is not on a machine');
  assert.equal((await direct(token, `Bearer ${ticket.id}.x.y`)).status, 401, "a forged turn token is the main route's to refuse");

  // A steer goes down to claude's stdin there.
  await call(`/api/tickets/${ticket.id}/messages`, { text: 'steer it' });
  await until('the steer to reach claude on the machine', () => lines(heard).length === 2);
  await until('its answer to come home', () => /heard 2/.test(text(dir, 'stream.jsonl')));

  // The server restarts mid-turn: the turn runs on, and what it said meanwhile arrives once the agent is back.
  const port = srv.port;
  await srv.settled();
  await stopProcs([srv.proc]);
  const before = text(dir, 'stream.jsonl');
  // Said while the server was down, straight into the machine's stream as claude's stdout would be.
  writeFileSync(join(local, 'stream.jsonl'), `${text(local, 'stream.jsonl')}${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'said while away' }] } })}\n`);
  assert.equal(text(dir, 'stream.jsonl'), before);
  srv = await bootServer({ root, env: { ...env, PORT: String(port) } });
  procs.push(srv.proc);
  call = async (path: string, body?: unknown, method?: string) => ok(await srv!.call(path, body, method));
  await until('the rest of the stream after the restart', () => /said while away/.test(text(dir, 'stream.jsonl')));
  assert.equal(text(dir, 'stream.jsonl'), text(local, 'stream.jsonl'), 'byte for byte, nothing twice');
  assert.equal((await call(`/api/tickets/${ticket.id}`)).ticket.status, 'running', 'the restarted server took the turn up again');

  // It ends there, and its end comes home after its stream.
  writeFileSync(release, '');
  await until('the turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  const events = JSON.stringify(await call(`/api/tickets/${ticket.id}/events?after=0`));
  assert.match(events, /heard 1/);
  assert.match(events, /said while away/);
  await until("the machine's copy of the folder to go, once the server is done with it", () => !existsSync(local));

  // Stop: the interrupt is applied on the machine, and claude's own result ends the turn.
  // Its syncs come back sooner than its link after the restart: marked for it, the turn waits for the link rather than run at home.
  rmSync(release);
  writeFileSync(heard, '');
  await call(`/api/tickets/${ticket.id}/messages`, { text: 'again' });
  await until('the second machine turn', () => lines(heard).length === 1);
  // Once its pid is home the stop is an interrupt, as for any turn (before that it is a stop before the start).
  await until("the second turn's pid to come home", () => require_dirs(turnsDir).some((d) => d !== basename(dir) && existsSync(join(turnsDir, d, 'machine')) && existsSync(join(turnsDir, d, 'pid.json'))));
  await call(`/api/tickets/${ticket.id}/stop`, {});
  await until('the stopped turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  assert.match(readFileSync(calls, 'utf8'), /kill -INT -\d+/, 'signalled inside the container');
  assert.doesNotMatch(agent.output(), /could not start/);
});

test("a minion's worktree, session and files go to the machine before its turn, come home at checkpoints, and go on from either side", async () => {
  const s = srv!;
  const call = async (path: string, body?: unknown, method?: string) => ok(await s.call(path, body, method));
  const there = (p: string) => join(workerRoot, 'fs', p);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, 'a.txt'), 'one\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'first');
  const turn = async (text: string, id?: number) => {
    rmSync(release, { force: true });
    writeFileSync(heard, '');
    const t = id ? (await call(`/api/tickets/${id}/messages`, { text }), { id }) : await call(`/api/projects/${project.id}/tickets`, { message: text, runs_on: 'w1' });
    return { ...t, ...JSON.parse((await until('the turn to say what it heard', () => lines(heard).length === 1 && lines(heard)))[0]) };
  };
  const end = async (id: number) => {
    writeFileSync(release, '');
    await until('the turn to end', async () => (await call(`/api/tickets/${id}`)).ticket.status !== 'running');
  };
  const online = () => until('the machine to be online', async () => (await call('/api/machines')).find((m: { name: string; online: boolean }) => m.name === 'w1' && m.online));
  const machine = await online();
  const project = await call('/api/projects', { name: 'Repo', source: 'folder', folder: src });
  await call(`/api/machines/${machine.id}`, { projects: [project.id] }, 'PATCH');
  const session = '11111111-2222-3333-4444-555555555555';
  writeFileSync(sessionFile, session);

  // A turn there: the worktree is there before claude is.
  const t = await turn('on the machine');
  const { cwd, branch } = (await call(`/api/tickets/${t.id}`)).ticket;
  assert.ok(existsSync(there(join(cwd, '..', '..', 'tmp', basename(cwd)))), 'its temp folder is there');
  assert.equal(text(there(cwd), 'a.txt'), 'one\n');
  assert.equal(git(there(cwd), 'symbolic-ref', '--short', 'HEAD'), branch);

  // A commit comes home by itself, with what is not committed yet; so do its conversation and its files.
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  // Here in the server's config folder; there in the machine's own home, which the turn's sign-in is in.
  const jsonl = (at: string) => join(at, 'claude', 'projects', slug, `${session}.jsonl`);
  const jsonlThere = there(join(root, '.claude', 'projects', slug, `${session}.jsonl`));
  mkdirSync(join(jsonlThere, '..'), { recursive: true });
  writeFileSync(jsonlThere, '{"n":1}\n');
  writeFileSync(there(join(cwd, 'a.txt')), 'two\n');
  git(there(cwd), 'commit', '-qam', 'on the machine');
  await until('the commit to come home', () => git(cwd, 'log', '-1', '--format=%s') === 'on the machine' && git(cwd, 'status', '--porcelain') === '');
  assert.equal(text(cwd, 'a.txt'), 'two\n');
  assert.equal(git(cwd, 'symbolic-ref', '--short', 'HEAD'), branch);

  // A tool that reads its files here waits for them: the picture was only on the machine.
  writeFileSync(there(join(cwd, 'shot.png')), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const mark = await fetch(`${t.api}/api/tickets/${t.id}/mark-image`, { method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: join(cwd, 'shot.png'), marks: [{ kind: 'box', at: [1, 1], to: [50, 50] }] }) });
  assert.equal(mark.status, 200, await mark.text());
  assert.ok(existsSync(join(cwd, 'shot.png')));

  // What it left uncommitted at its end is here by the time the turn is over, and its session is in the database's keeping.
  writeFileSync(there(join(cwd, 'left.txt')), 'uncommitted\n');
  writeFileSync(jsonlThere, '{"n":1}\n{"n":2}\n');
  await end(t.id);
  assert.equal(text(cwd, 'left.txt'), 'uncommitted\n');
  assert.equal(readFileSync(jsonl(root), 'utf8'), '{"n":1}\n{"n":2}\n');
  assert.match(git(cwd, 'status', '--porcelain'), /\?\? left\.txt/);

  // It goes on here from that conversation, even with the machine's copy of it all that was left.
  await call(`/api/tickets/${t.id}/runs-on`, { on: 'perigee' }, 'PUT');
  await s.settled();
  rmSync(jsonl(root));
  const home = await turn('at home', t.id);
  assert.equal(home.resume, session);
  assert.equal(readFileSync(jsonl(root), 'utf8'), '{"n":1}\n{"n":2}\n', 'restored from the database');
  writeFileSync(jsonl(root), '{"n":3}\n', { flag: 'a' });
  writeFileSync(join(cwd, 'left.txt'), 'changed at home\n');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'at home');
  await end(t.id);

  // And there again from what happened here.
  await call(`/api/tickets/${t.id}/runs-on`, { on: 'w1' }, 'PUT');
  const again = await turn('there again', t.id);
  assert.notEqual(again.api, home.api);
  assert.equal(again.resume, session);
  assert.equal(readFileSync(jsonlThere, 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n');
  assert.equal(text(there(cwd), 'left.txt'), 'changed at home\n');
  assert.equal(git(there(cwd), 'log', '-1', '--format=%s'), 'at home');
  await end(t.id);
  assert.doesNotMatch(JSON.stringify(await call(`/api/tickets/${t.id}/events?after=0`)), /could not send|is kept in/);

  // The machine drops off mid-turn (T6): a person's stop frees the minion at once; what the machine did meanwhile
  // comes home beside the minion's work when it is back, and nothing of it merges.
  await turn('there, then away', t.id);
  const turnsDir = join(s.data, 'run', 'turns');
  await until('its pid to come home', () => require_dirs(turnsDir).some((d) => existsSync(join(turnsDir, d, 'pid.json')) && !existsSync(join(turnsDir, d, 'exit.json'))));
  const a = agentNow();
  a.agent.kill('SIGKILL');
  await until('the machine to be away', async () => !(await call('/api/machines')).find((m: { name: string; online: boolean }) => m.name === 'w1').online);
  writeFileSync(there(join(cwd, 'a.txt')), 'three, while away\n');
  git(there(cwd), 'commit', '-qam', 'while away');
  const mine = git(there(cwd), 'rev-parse', 'HEAD');
  await call(`/api/tickets/${t.id}/stop`, {});
  await until('the stop to free it while its machine is away', async () => (await call(`/api/tickets/${t.id}`)).ticket.status !== 'running');
  const here = git(cwd, 'rev-parse', 'HEAD');
  assert.notEqual(here, mine);
  restartAgent();
  await online();
  const refs = await until('the work it held to come home aside', () => git(cwd, 'for-each-ref', '--format=%(refname)', `refs/citadel/away/${t.id}`) || null);
  const snapshot = refs.split('\n').find((r) => /\/\d{8}-\d{6}$/.test(r));
  assert.ok(snapshot, refs);
  assert.equal(git(cwd, 'show', `${snapshot}:work/a.txt`), 'three, while away');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), here, 'nothing merged by itself');
  assert.equal(text(cwd, 'a.txt'), 'two\n');
  await until('the minion to be told', async () => /never came home is here now/.test(JSON.stringify(await call(`/api/tickets/${t.id}/events?after=0`))));
  // Being told starts its next turn (there again): let it end.
  await end(t.id);
});

function require_dirs(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((d) => !d.startsWith('.')) : [];
}

test("the worker starts nothing past its owner's cap and refuses a start it cannot read", async () => {
  const w = new Worker({ config: { root: join(root, 'w-cap'), image: 'img', max: 1 }, appUrl: 'http://127.0.0.1:9', token: 't', run: async () => ({ code: 1, out: '', err: 'no podman here' }) });
  assert.equal(w.mine('/a/b'), true);
  assert.equal(w.mine('/a/../etc'), false);
  assert.equal(w.mine('relative'), false);
  assert.equal(basename(w.local('/data/turns/1-2')), '1-2');
  assert.ok(w.local('/data/turns/1-2').startsWith(join(root, 'w-cap', 'fs')));
});
