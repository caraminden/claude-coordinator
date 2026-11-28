// The CI runner agent updates itself (#2310; Cara, 2026-11-28: "Can we make it able to update itself?"): Citadel sends
// the SHA-256 of each of its files, the agent fetches what differs, checks each hash, swaps only between jobs, starts
// again on the new files under its supervisor, and a version that never connects is put back.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AGENT_FILES, filesVersion as serverVersion, runnerManifests, runnerUpdate } from '../src/ci-runner.ts';
import { MachineRelay } from '../src/machines.ts';
import { checkFiles, filesVersion, rollBack, SelfUpdate, sha256, supervise, UPDATE_DRAIN_MS, UPDATE_RETRY_MS, UPDATED } from '../public/runner-agent.mjs';
import { Store } from '../src/db.ts';
import { stopProcs } from './helpers.ts';
import { until } from './wait.ts';

const repo = join(import.meta.dirname, '..');

const manifest = (files: Record<string, string>) => ({ version: filesVersion(files), files });

/** An agent's folder with two files, and Citadel's newer copies of them plus one file it adds. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-'));
  writeFileSync(join(dir, 'runner-agent.mjs'), 'old agent');
  writeFileSync(join(dir, 'add-runner.ps1'), 'old add');
  const served: Record<string, string> = { '/runner-agent.mjs': 'new agent', '/ci-runner/add-runner.ps1': 'old add', '/ci-runner/runner-slot.ps1': 'new slot' };
  const want = manifest({ 'runner-agent.mjs': sha256('new agent'), 'add-runner.ps1': sha256('old add'), 'runner-slot.ps1': sha256('new slot') });
  const fetched: string[] = [];
  const get = async (url: URL) => {
    fetched.push(url.pathname);
    const body = served[url.pathname];
    return body === undefined ? new Response('no', { status: 404 }) : new Response(body);
  };
  const jobs = { dir, os: 'windows', appUrl: 'http://citadel.test:8574', busy: null as string | null, draining: null as string | null };
  const slots = { slots: {} as Record<string, unknown>, ticking: false };
  const reports: { state: string; version: string; why: string }[] = [];
  const exits: number[] = [];
  let clock = 1_000_000;
  const updater = new SelfUpdate({ jobs, slots, supervised: true, report: async (b: { state: string; version: string; why: string }) => void reports.push(b), exit: (c: number) => void exits.push(c), get, now: () => clock });
  return { dir, served, want, fetched, jobs, slots, reports, exits, updater, tick: (ms: number) => (clock += ms), done: () => rmSync(dir, { recursive: true, force: true }) }; // timing-ok: own temp dir
}

test("Citadel's list and the agent's: both installers' download lists, one version for the same files, and every file served", () => {
  const ps1 = readFileSync(join(repo, 'tools/ci-runner/install-runner-agent.ps1'), 'utf8');
  const listed = [...(/\$files = \[ordered\]@\{([\s\S]*?)\n\}/.exec(ps1)?.[1] ?? '').matchAll(/^\s*'([\w.-]+)'\s*=/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...AGENT_FILES.windows].sort(), 'install-runner-agent.ps1 downloads what Citadel hashes for Windows');
  const sh = readFileSync(join(repo, 'tools/ci-runner/install-runner-agent.sh'), 'utf8');
  const shList = (/^for f in (.+); do$/m.exec(sh)?.[1] ?? '').split(' ').map((f) => f.replace(/^ci-runner\//, ''));
  assert.deepEqual([...shList].sort(), [...AGENT_FILES.linux].sort(), 'install-runner-agent.sh downloads what Citadel hashes for Linux');
  // Each script must be one server.ts serves under /ci-runner/.
  const served = /const RUNNER_FILES = new Set\(\[([\s\S]*?)\]\);/.exec(readFileSync(join(repo, 'server.ts'), 'utf8'))?.[1] ?? '';
  for (const n of [...AGENT_FILES.windows, ...AGENT_FILES.linux]) if (n !== 'runner-agent.mjs') assert.ok(served.includes(`'${n}'`), `${n} is served`);
  // The installers start it supervised, so it can start itself again on new files.
  assert.match(ps1, /runner-agent\.mjs`" --supervise /);
  assert.match(sh, /runner-agent\.mjs --supervise /);

  const files = { 'b.ps1': 'f'.repeat(64), 'runner-agent.mjs': 'a'.repeat(64) };
  assert.equal(serverVersion(files), filesVersion(files));
  const m = runnerManifests((name) => readFileSync(name === 'runner-agent.mjs' ? join(repo, 'public', name) : join(repo, 'tools/ci-runner', name)));
  assert.ok(m.windows && m.linux);
  assert.deepEqual(checkFiles(m.windows), m.windows, 'the agent takes the list the server makes');
  assert.equal(m.linux.files['runner-agent.mjs'], m.windows.files['runner-agent.mjs']);
  assert.equal(runnerManifests((n) => (n === 'launch-slot.sh' ? undefined : Buffer.from(n))).linux, null, 'a file missing: nothing to chase');
});

test('the agent refuses a file list naming anything but a file of its own folder, or with a hash or version that is wrong', () => {
  const ok = manifest({ 'runner-agent.mjs': 'a'.repeat(64) });
  assert.deepEqual(checkFiles(ok), ok);
  for (const name of ['../evil.ps1', 'sub/x.ps1', 'machine-token', 'slots.json', 'C:\\x.ps1', 'X.ps1', 'run.cmd']) assert.throws(() => checkFiles(manifest({ 'runner-agent.mjs': 'a'.repeat(64), [name]: 'b'.repeat(64) })), /not one of this folder's/, name);
  assert.throws(() => checkFiles(manifest({ 'add-runner.ps1': 'a'.repeat(64) })), /must name runner-agent\.mjs/);
  assert.throws(() => checkFiles(manifest({ 'runner-agent.mjs': 'A'.repeat(64) })), /not a SHA-256/);
  assert.throws(() => checkFiles({ ...ok, version: '000000000000' }), /version doesn't match/);
  assert.throws(() => checkFiles(null), /no files/);
});

test('a new version: every changed file fetched and checked, swapped in with the old kept, then it starts again', async () => {
  const s = setup();
  try {
    await s.updater.want(s.want);
    assert.deepEqual(s.fetched.sort(), ['/ci-runner/runner-slot.ps1', '/runner-agent.mjs'], 'only the files that differ');
    assert.deepEqual(s.exits, [UPDATED]);
    assert.equal(readFileSync(join(s.dir, 'runner-agent.mjs'), 'utf8'), 'new agent');
    assert.equal(readFileSync(join(s.dir, 'runner-slot.ps1'), 'utf8'), 'new slot');
    assert.equal(readFileSync(join(s.dir, 'runner-agent.mjs.old'), 'utf8'), 'old agent');
    assert.ok(!readdirSync(s.dir).some((f) => f.endsWith('.new')));
    assert.equal(s.reports.at(-1)?.state, 'updating');
    assert.equal(s.jobs.busy, null, 'the job lock is let go');
    // Started again and connected: the old files go, and Citadel hears it is current.
    const again = new SelfUpdate({ jobs: s.jobs, slots: s.slots, supervised: true, report: async (b: { state: string }) => void s.reports.push(b as never), exit: () => assert.fail('no update left') });
    again.connected();
    assert.ok(!existsSync(join(s.dir, 'runner-agent.mjs.old')) && !existsSync(join(s.dir, 'update.json')));
    await again.want(s.want);
    assert.deepEqual(s.reports.at(-1), { os: 'windows', version: s.want.version, state: 'current', why: '' });
  } finally {
    s.done();
  }
});

test("a download that doesn't match its SHA-256, or doesn't come, leaves every file as it was and says why", async () => {
  const s = setup();
  try {
    s.served['/ci-runner/runner-slot.ps1'] = 'tampered slot';
    await s.updater.want(s.want);
    assert.deepEqual(s.exits, []);
    assert.equal(readFileSync(join(s.dir, 'runner-agent.mjs'), 'utf8'), 'old agent', 'the file that did match is not swapped alone');
    assert.ok(!existsSync(join(s.dir, 'runner-slot.ps1')) && !readdirSync(s.dir).some((f) => /\.(new|old)$/.test(f) || f === 'update.json'));
    const failed = s.reports.at(-1);
    assert.equal(failed?.state, 'failed');
    assert.match(failed!.why, /runner-slot\.ps1 as downloaded doesn't match its SHA-256.*the old files run on/);
    assert.equal(failed?.version, filesVersion({ 'add-runner.ps1': sha256('old add'), 'runner-agent.mjs': sha256('old agent'), 'runner-slot.ps1': '' }), 'the version it still runs');
    // Not again until the retry is due; then the next try (Citadel away now) fails the same way.
    s.fetched.length = 0;
    await s.updater.check();
    assert.deepEqual(s.fetched, []);
    s.tick(UPDATE_RETRY_MS + 1);
    delete s.served['/runner-agent.mjs'];
    await s.updater.check();
    assert.match(s.reports.at(-1)!.why, /couldn't download runner-agent\.mjs: Citadel answered 404/);
    assert.deepEqual(s.exits, []);
  } finally {
    s.done();
  }
});

test('it never swaps under a job or a one-job runner, and after a while holds new starts so it gets its turn', async () => {
  const s = setup();
  try {
    s.jobs.busy = 'add for scheme 3';
    await s.updater.want(s.want);
    assert.deepEqual(s.fetched, []);
    assert.match(s.reports.at(-1)!.why, /waits for add for scheme 3/);
    s.jobs.busy = null;
    s.slots.slots['vault/1'] = { scheme: 3, slot: 1 };
    await s.updater.check();
    assert.match(s.reports.at(-1)!.why, /waits for 1 one-job runner to end/);
    assert.equal(s.jobs.draining, null, 'starts still run at first');
    s.tick(UPDATE_DRAIN_MS + 1);
    await s.updater.check();
    assert.match(String(s.jobs.draining), /update the runner agent/, 'no new start once it has waited long');
    assert.deepEqual(s.fetched, []);
    s.slots.ticking = true;
    delete s.slots.slots['vault/1'];
    await s.updater.check();
    assert.deepEqual(s.fetched, [], "not while the slots' watch runs a script");
    s.slots.ticking = false;
    await s.updater.check();
    assert.deepEqual(s.exits, [UPDATED]);
    assert.equal(s.jobs.draining, null);
  } finally {
    s.done();
  }
});

test("an agent started without its supervisor doesn't swap, as it couldn't start itself again", async () => {
  const s = setup();
  try {
    const bare = new SelfUpdate({ jobs: s.jobs, slots: s.slots, supervised: false, report: async (b) => void s.reports.push(b), exit: () => assert.fail('no swap') });
    await bare.want(s.want);
    assert.deepEqual(s.fetched, []);
    assert.match(s.reports.at(-1)!.why, /without --supervise/);
  } finally {
    s.done();
  }
});

test('the supervisor starts it again on UPDATED, rolls back a new version that ends before it connects, and passes any other end on', async () => {
  const s = setup();
  try {
    await s.updater.want(s.want);
    const ends = [UPDATED, 3, 0];
    const started: string[][] = [];
    const lines: string[] = [];
    const start = (args: string[]) => {
      started.push(args);
      // What the files are as each child starts: the new version, then the old one again after the roll back.
      args.push(readFileSync(join(s.dir, 'runner-agent.mjs'), 'utf8'));
      const child = new EventEmitter() as ChildProcess;
      setImmediate(() => child.emit('exit', ends.shift()));
      return child;
    };
    assert.equal(await supervise(['http://citadel.test', '--token-file', 't'], { dir: s.dir, log: (l: string) => lines.push(l), start }), 0);
    assert.deepEqual(
      started.map((a) => a.at(-1)),
      ['new agent', 'new agent', 'old agent'],
    );
    assert.deepEqual(started[0].slice(0, -1), [join(s.dir, 'runner-agent.mjs'), 'http://citadel.test', '--token-file', 't', '--supervised']);
    assert.match(lines.join('\n'), /stopped before it connected \(exit 3\)/);
    assert.ok(!existsSync(join(s.dir, 'runner-slot.ps1')), 'a file the update added goes too');
    // The old version, connected again, doesn't take the version that failed.
    const old = new SelfUpdate({ jobs: s.jobs, slots: s.slots, supervised: true, report: async (b) => void s.reports.push(b), exit: () => assert.fail('not the failed version again') });
    s.fetched.length = 0;
    await old.want(s.want);
    assert.deepEqual(s.fetched, []);
    assert.match(s.reports.at(-1)!.why, new RegExp(`version ${s.want.version} stopped before it connected \\(exit 3\\)`));
    assert.equal(rollBack(s.dir, 1), false, 'nothing under way');
  } finally {
    s.done();
  }
});

test('Citadel sends each runner agent the files list on connect and after a reload that changed it, and shows its version', () => {
  const store = new Store(':memory:');
  const streams: EventEmitter[] = [];
  try {
    const relay = new MachineRelay(store, () => {});
    let files = manifest({ 'runner-agent.mjs': 'a'.repeat(64) });
    relay.runnerFiles = (os) => (os === 'windows' ? files : null);
    const machine = store.createMachine('desk', 'x', 'Cara', store.createUser({ name: 'Cara', login: 'cara', admin: true }).id);
    const res = Object.assign(new EventEmitter(), {
      written: [] as string[],
      writeHead() {},
      write(s: string) {
        this.written.push(s);
        return true;
      },
      end() {},
    });
    streams.push(res);
    relay.connectAgent(machine, res as never, { host: 'desk', command: 'citadel runner agent', runners: true, os: 'windows', selfUpdate: true });
    const sent = () => res.written.filter((w) => w.includes('"files"')).map((w) => JSON.parse(w.slice(6)).files.version);
    assert.deepEqual(sent(), [files.version]);
    relay.pushRunnerFiles();
    assert.deepEqual(sent(), [files.version], 'a reload that changed nothing sends nothing');
    files = manifest({ 'runner-agent.mjs': 'b'.repeat(64) });
    relay.pushRunnerFiles();
    assert.deepEqual(sent(), [manifest({ 'runner-agent.mjs': 'a'.repeat(64) }).version, files.version]);

    const row = () => relay.list().find((m) => m.id === machine.id)!;
    assert.equal(row().runner_update, null, 'one that updates itself needs no install line');
    assert.equal(relay.runnerUpdated(machine.id, 'linux', runnerUpdate({ version: 'abcdef012345', state: 'current' })), false, 'no Linux agent there');
    assert.ok(relay.runnerUpdated(machine.id, 'windows', runnerUpdate({ version: 'abcdef012345', state: 'failed', why: 'a\nb' }, 5)));
    assert.deepEqual(row().runner_agents?.[0].update, { version: 'abcdef012345', state: 'failed', why: 'a b', at: 5 });
    assert.equal(row().runner_agents?.[0].latest, files.version);
    assert.throws(() => runnerUpdate({ version: 'abc', state: 'current' }), /12 hex/);
    assert.throws(() => runnerUpdate({ version: 'abcdef012345', state: 'done' }), /state must be/);

    // One from before (no update=1) gets the row's install line.
    const old = Object.assign(new EventEmitter(), {
      written: [] as string[],
      writeHead() {},
      write(s: string) {
        this.written.push(s);
        return true;
      },
      end() {},
    });
    streams.push(old);
    relay.connectAgent(machine, old as never, { host: 'desk', command: 'citadel runner agent', runners: true, os: 'linux' });
    assert.deepEqual(row().runner_update?.os, ['linux']);
    assert.equal(row().runner_update?.plans, false);
  } finally {
    for (const r of streams) r.emit('close');
  }
});

test('end to end: a supervised agent takes a new runner-agent.mjs from Citadel, starts again on it and says it is current', async () => {
  const root = mkdtempSync(join(tmpdir(), 'self-update-e2e-'));
  const ps = join(root, 'win', 'System32', 'WindowsPowerShell', 'v1.0');
  mkdirSync(ps, { recursive: true });
  writeFileSync(join(ps, 'powershell.exe'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(ps, 'powershell.exe'), 0o755);
  const installed = join(root, 'agent');
  mkdirSync(installed);
  copyFileSync(join(repo, 'public', 'runner-agent.mjs'), join(installed, 'runner-agent.mjs'));
  writeFileSync(join(installed, 'keep-runners.ps1'), '');
  writeFileSync(join(root, 'token'), 'ccm_1_test\n');
  // Citadel's copy is the same agent with one line more.
  const newer = `${readFileSync(join(repo, 'public', 'runner-agent.mjs'), 'utf8')}\n// the newer one\n`;
  const files = { 'runner-agent.mjs': sha256(newer), 'keep-runners.ps1': sha256('') };
  const connects: string[] = [];
  const updates: { state: string; version: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/runner-agent.mjs') return void res.end(newer);
      if (req.url === '/api/machines/runner-update') updates.push(JSON.parse(body));
      if (!req.url?.startsWith('/api/machines/connect')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      connects.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ hello: 'pc' })}\n\ndata: ${JSON.stringify({ files: manifest(files) })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const agent = spawn(process.execPath, [join(installed, 'runner-agent.mjs'), '--supervise', `http://127.0.0.1:${port}`, '--token-file', join(root, 'token'), '--os', 'windows', '--sample-ms', '60000', '--log', join(root, 'agent.log')], { env: { ...process.env, SystemRoot: join(root, 'win') }, stdio: 'ignore' });
  try {
    await until('the agent to say it is current after starting again', async () => updates.some((u) => u.state === 'current'));
    assert.equal(readFileSync(join(installed, 'runner-agent.mjs'), 'utf8'), newer);
    assert.equal(connects.length, 2, 'it connected, updated and connected again');
    assert.ok(connects.every((u) => u.includes('update=1')));
    assert.equal(updates.find((u) => u.state === 'current')?.version, filesVersion(files));
    assert.ok(!existsSync(join(installed, 'runner-agent.mjs.old')), 'the old copy goes once the new one connected');
    assert.match(readFileSync(join(root, 'agent.log'), 'utf8'), /Swapped in version .*starting again on it/);
  } finally {
    await stopProcs([agent]);
    await until('the supervised child to stop with it', async () => !(await psList()).split('\n').some((l) => l.includes(installed) && l.includes('--supervised')));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

const psList = () =>
  new Promise<string>((done) => {
    const p = spawn('ps', ['-eo', 'args'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', () => done(out));
  });
