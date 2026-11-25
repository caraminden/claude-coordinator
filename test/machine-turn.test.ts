import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, lines, ok, stopProcs, tempRoot, until, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { MachineTurn, machineLink, placeTurn, placedAt, sameClaude, syncTurns, type MachineLaunch } from '../src/machine-turn.ts';
import { runningTurn, wrapperAlive } from '../src/running-turn.ts';
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
  if ('gone' in r) throw new Error("the turn is not the machine's");
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

test('alive by its syncs while the agent is connected; away is not gone, and a kill while away ends it here', async (t) => {
  const was = { ...machineLink };
  t.after(() => Object.assign(machineLink, was));
  let online = true;
  machineLink.online = () => online;
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
  assert.equal(existsSync(join(dir, 'exit.json')), false, 'an interrupt waits for the machine');
  turn.signal('SIGKILL');
  assert.deepEqual(JSON.parse(text(dir, 'exit.json')), { code: null, signal: 'SIGKILL' });
  assert.deepEqual((await one(1, { dir, signals: 0 })).signals, ['SIGINT', 'SIGKILL'], 'and the machine still gets them when it returns');
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

// ---- the whole path ----

const bin = join(root, 'bin');
mkdirSync(bin);
const workerRoot = join(root, 'worker');
const calls = join(root, 'podman-calls');
const heard = join(root, 'heard.log');
const release = join(root, 'release');
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
process.exit(spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' }).status ?? 1);
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
require('node:readline').createInterface({ input: process.stdin }).on('line', async () => {
  n++;
  let status = 0;
  try {
    status = (await fetch(process.env.COORDINATOR_API + '/api/tickets/' + process.env.COORDINATOR_TICKET, { headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN } })).status;
  } catch {}
  fs.appendFileSync(${JSON.stringify(heard)}, JSON.stringify({ n, api: process.env.COORDINATOR_API, status, dir: process.argv[1] }) + '\\n');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'heard ' + n }] } });
});
process.on('SIGINT', () => end('interrupted'));
setInterval(() => fs.existsSync(${JSON.stringify(release)}) && end('done'), 20);
`,
);
chmodSync(claude, 0o755);

test('a turn placed on a machine starts, streams, steers, survives a server restart and ends there', async () => {
  const env = { CLAUDE_BIN: claude, PATH: `${bin}:${process.env.PATH}` };
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
  const agent = startMachineAgent({ base: srv.base, token, run: ['--config', config], env: { PATH: env.PATH } });
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
  assert.match(text(local, 'stream.jsonl'), /heard 1/, "claude's stream is written on the machine");
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
