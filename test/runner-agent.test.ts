// The CI runner agent (#328, public/runner-agent.mjs) runs elevated on Cara's desktop, so what it accepts is the whole
// of its reach: three ops with checked numbers, its own scripts only, one job at a time, tokens kept out of its output.
// Here the scripts are faked (a node one-liner stands in for PowerShell); the Windows side is untested until installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { linuxProcs, checkJob, keeperCommand, ownerCaps, SLICE, sliceCap, cleanShips, JobRunner, jobCommand, LinuxSqueeze, personIdle, redact, runCommand, runnerUse, Sampler, SHIP_HOLD_MS, SLOT_IDLE_MS, COPY_EVERY_MS, COPY_MAX_MS, COPY_RETRY_MS, SlotWatch, slotStates, writeShips } from '../public/runner-agent.mjs';
import { bootServer, stopProcs, tempRoot, until } from './helpers.ts';

const ID = 'a'.repeat(24);
const scratch = tempRoot('runner-agent-');
after(() => scratch.teardown());

test('it accepts add, list and remove with exactly their fields, and refuses everything else', () => {
  assert.deepEqual(checkJob({ id: ID, op: 'add', scheme: 3, count: 4 }), { id: ID, op: 'add', scheme: 3, count: 4 });
  assert.deepEqual(checkJob({ id: ID, op: 'list' }), { id: ID, op: 'list' });
  assert.deepEqual(checkJob({ id: ID, op: 'remove', scheme: 3 }), { id: ID, op: 'remove', scheme: 3 });
  for (const bad of [
    { id: ID, op: 'run', command: 'shutdown /r' },
    { id: ID, op: 'add', scheme: 3, count: 5 },
    { id: ID, op: 'add', scheme: 3, count: 0 },
    { id: ID, op: 'add', scheme: 3 },
    { id: ID, op: 'add', scheme: '3; Restart-Computer', count: 1 },
    { id: ID, op: 'add', scheme: 3, count: 1, label: 'delve-ci' },
    { id: ID, op: 'remove', scheme: 3, folder: 'C:\\actions-runner' },
    { id: ID, op: 'remove', scheme: -1 },
    { id: ID, op: 'list', scheme: 1 },
    { id: 'x', op: 'list' },
    null,
  ])
    assert.throws(() => checkJob(bad), undefined, JSON.stringify(bad));
});

test("each op runs its own script from the agent's folder in Windows PowerShell, with numbers for arguments", () => {
  const dir = 'C:\\ProgramData\\citadel-runner-agent';
  const ps = 'C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const add = jobCommand({ op: 'add', scheme: 3, count: 2 }, dir, 'http://perigee:8574', 'C:\\Windows', 'windows');
  assert.equal(add.command.replaceAll('\\', '/'), ps.replaceAll('\\', '/'));
  assert.deepEqual(add.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(add.args[5], /add-runner\.ps1$/);
  assert.deepEqual(add.args.slice(6), ['-Scheme', '3', '-CitadelUrl', 'http://perigee:8574', '-Count', '2']);
  assert.match(jobCommand({ op: 'remove', scheme: 3 }, dir, 'u', 'C:\\Windows', 'windows').args[5], /remove-runner\.ps1$/);
  assert.deepEqual(
    jobCommand({ op: 'list' }, dir, 'u', 'C:\\Windows', 'windows')
      .args.slice(5)
      .map((a: string) => a.replace(/.*[\\/]/, '')),
    ['list-runners.ps1'],
  );
});

test('the Linux agent (#510) runs the bash twin of each script from its folder, with the same checked numbers as arguments', () => {
  assert.deepEqual(jobCommand({ op: 'add', scheme: 3, count: 2 }, '/opt/citadel-runner-agent', 'http://perigee:8574', undefined, 'linux'), { command: '/bin/bash', args: ['/opt/citadel-runner-agent/add-runner.sh', '3', 'http://perigee:8574', '2'] });
  assert.deepEqual(jobCommand({ op: 'remove', scheme: 3 }, '/a', 'u', undefined, 'linux').args, ['/a/remove-runner.sh', '3', 'u']);
  assert.deepEqual(jobCommand({ op: 'list' }, '/a', 'u', undefined, 'linux').args, ['/a/list-runners.sh']);
});

test('tokens are blanked from what goes back to Citadel', () => {
  const said = redact('token ccm_12_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG and --token AABCDEFGHIJKLMNOPQRSTUVWXYZ12 and gho_abcdefghijklmnopqrstuv');
  assert.doesNotMatch(said, /ccm_12_a|AABCDEF|gho_a/);
  assert.equal(redact('Done: actions.runner.caraminden-peek-auras.DESKTOP-G248IJ8 is Running.'), 'Done: actions.runner.caraminden-peek-auras.DESKTOP-G248IJ8 is Running.');
});

test('one job at a time: the script gets the machine token in its environment, and its exit code decides ok', async () => {
  const calls: { cmd: { command: string; args: string[] }; token?: string }[] = [];
  let release!: () => void;
  const run = (cmd: { command: string; args: string[] }, env: NodeJS.ProcessEnv) => {
    calls.push({ cmd, token: env.CC_MACHINE_TOKEN });
    return new Promise((r) => {
      release = () => r({ code: 0, output: 'Done. --token AABCDEFGHIJKLMNOPQRSTUVWXYZ12' });
    });
  };
  const jobs = new JobRunner({ dir: '/agent', appUrl: 'http://citadel', token: 'ccm_1_x', run });
  const first = jobs.handle({ id: ID, op: 'add', scheme: 2, count: 1 });
  const second = await jobs.handle({ id: 'b'.repeat(24), op: 'list' });
  assert.deepEqual(second, { id: 'b'.repeat(24), ok: false, output: 'runner agent: busy with add for scheme 2, 1 runner(s); try again when it ends' });
  release();
  assert.deepEqual(await first, { id: ID, ok: true, output: 'Done. --token …' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'ccm_1_x');
  assert.ok(!calls[0].cmd.args.includes('ccm_1_x'), 'never on the command line');
  const refused = await jobs.handle({ id: ID, op: 'shell', command: 'whoami' });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /only adds, lists and removes/);
  assert.equal(calls.length, 1, 'a refused job runs nothing');
  const failed = await new JobRunner({ dir: '/a', appUrl: 'u', token: 't', run: async () => ({ code: 1, output: 'add-runner: Citadel refused' }) }).handle({ id: ID, op: 'list' });
  assert.deepEqual(failed, { id: ID, ok: false, output: 'add-runner: Citadel refused' });
});

test("a script's output is collected, and one that runs too long is stopped", async () => {
  const ok = await runCommand({ command: process.execPath, args: ['-e', 'console.log("out"); console.error("err"); process.exit(3)'] }, process.env);
  assert.equal(ok.code, 3);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);
  const slow = await runCommand({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] }, process.env, 200);
  assert.notEqual(slow.code, 0);
  assert.match(slow.output, /Stopped after/);
  const missing = await runCommand({ command: '/no/such/powershell', args: [] }, process.env);
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /could not start/);
});

test("end to end: the agent connects as a runner agent, a member's list runs its script, and Citadel serves the install files", async () => {
  const srv = await bootServer();
  const agentFile = join(import.meta.dirname, '..', 'public', 'runner-agent.mjs');
  let agent: ReturnType<typeof spawn> | undefined;
  try {
    // Stands in for Windows PowerShell: says what it was given, and the token it found in its environment.
    const ps = join(srv.root, 'win', 'System32', 'WindowsPowerShell', 'v1.0');
    mkdirSync(ps, { recursive: true });
    // For sample-load.ps1 it prints a line like the real one's: a runner with a child, two threads waiting, Cara at the PC.
    const line = JSON.stringify({
      procs: [
        [10, 1, 'C:\\actions-runner-vault\\bin\\Runner.Listener.exe', 1, 1000],
        [11, 10, 'C:\\cargo\\rustc.exe', 5, 2000],
      ],
      queue: 2,
      quser: [' USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME', '>cara console 1 Active 3 11/10/2026 8:01 AM'],
      hv: null,
      temp: null,
      restarts: ['2026-10-30T13:34:00.0000000Z'],
    });
    writeFileSync(join(srv.root, 'sample.json'), line);
    writeFileSync(join(ps, 'powershell.exe'), `#!/bin/sh\ncase "$*" in *sample-load.ps1*) cat '${join(srv.root, 'sample.json')}'; exit 0;; *keep-runners.ps1*) echo "holding: $*"; exit 0;; esac\necho "fake ps: $*"\necho "token was $CC_MACHINE_TOKEN"\n`);
    chmodSync(join(ps, 'powershell.exe'), 0o755);
    // Its owner is a member who is no admin (an admin is in every scheme), with a scheme of their own.
    const person = (await srv.call('/api/people', { name: 'Mira' })).data;
    const invited = await fetch(`${srv.base}/api/invite/${person.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    const mira = srv.as({ cookie: invited.headers.get('set-cookie')!.split(';')[0] });
    const made = await mira('/api/machines', { name: 'desk-runners' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const tokenFile = join(srv.root, 'machine-token');
    writeFileSync(tokenFile, `${made.data.token}\n`);
    // Installed as on the PC, with its scripts beside it: a Windows agent keeps keep-runners.ps1 running (#552).
    const installed = join(srv.root, 'agent');
    mkdirSync(installed);
    copyFileSync(agentFile, join(installed, 'runner-agent.mjs'));
    writeFileSync(join(installed, 'keep-runners.ps1'), '');
    const logFile = join(srv.root, 'agent.log');
    agent = spawn(process.execPath, [join(installed, 'runner-agent.mjs'), srv.base, '--token-file', tokenFile, '--os', 'windows', '--sample-ms', '200', '--log', logFile], { env: { ...process.env, SystemRoot: join(srv.root, 'win') }, stdio: 'ignore' });
    const online = await until('the runner agent to connect', async () => (await srv.call('/api/machines')).data.find((m: { name: string; online?: boolean }) => m.name === 'desk-runners' && m.online));
    assert.equal(online.runners, true);
    // The yield (#552): started from its folder with the agent's pid, its lines in the agent's log; no CPU cap since #2262.
    const held = await until('keep-runners.ps1 to start', async () => existsSync(logFile) && /keep-runners: holding: .*/.exec(readFileSync(logFile, 'utf8'))?.[0]);
    assert.ok(held.includes(`-File ${join(installed, 'keep-runners.ps1')} -CpuPercent 0 -AgentPid ${agent.pid} -SqueezePercent 30 -CitadelSqueezePercent 10`), held);
    assert.deepEqual(online.servers, [], 'turns never get it as an MCP machine');

    // A new runner host acts for every scheme its owner is in (Build 10: one kind of machine, spec section 3), and for none they aren't.
    const other = (await srv.call('/api/projects', { name: 'Vault' })).data;
    assert.equal((await srv.call(`/api/projects/${other.id}/ci-runners`, { op: 'list' })).status, 409, "a scheme its owner isn't in");
    const project = (await mira('/api/projects', { name: "Mira's" })).data;
    const started = await srv.call(`/api/projects/${project.id}/ci-runners`, { op: 'list' });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const { job } = (await srv.call(`/api/projects/${project.id}/ci-runners?wait=20`)).data;
    assert.equal(job.ok, true, job.text);
    assert.match(job.text, /fake ps: -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \S+list-runners\.ps1/);
    assert.match(job.text, /token was ccm_…/);
    assert.doesNotMatch(job.text, new RegExp(made.data.token));

    // Its load samples (#534) reach the CI desktop view: the second look on, since CPU needs two.
    const pc = await until('a load sample', async () => (await srv.call('/api/ci-desktop')).data.pcs.find((p: { now?: unknown }) => p.now));
    assert.equal(pc.now.queue, 2);
    assert.equal(pc.now.idle_sec, 180);
    assert.deepEqual(pc.restarts, [], 'a restart from before the last day is history');
    // The CPU is this machine's own, so a busy test host may be judged overloaded: only that it was judged is this test's.
    assert.notEqual(pc.verdict.kind, 'none', pc.verdict.text);
    // Only a runner host's token sends them, and only a sample that checks out.
    const post = (token: string, body: unknown) => fetch(`${srv.base}/api/machines/runner-load`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(made.data.token, { os: 'windows', host: 'x', cores: 1, cpu: 500, mem_total: 1, mem_free: 1, runners: [] })).status, 400);
    assert.equal((await post('ccm_1_nope', {})).status, 401);
    const laptop = await srv.call('/api/machines', { name: 'a-laptop' });
    assert.equal((await post(laptop.data.token, { os: 'windows', host: 'x', cores: 1, cpu: 5, mem_total: 1, mem_free: 1, runners: [] })).status, 403);
    // One-job runners (P2, #2269): a config only for a live one-time id, which no guess is; a slot report needs a machine token.
    const jit = (body: unknown) => fetch(`${srv.base}/api/machines/runner-jit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await jit({ once: 'ab'.repeat(24) })).status, 410);
    assert.equal((await jit({ once: 'nope' })).status, 410);
    const slotPost = (token: string) => fetch(`${srv.base}/api/machines/runner-slot`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheme: 1, slot: 1, os: 'windows', event: 'ended', runner: `pool-m${laptop.data.machine.id}-w1-abc123` }) });
    assert.equal((await slotPost('ccm_1_nope')).status, 401);
    assert.equal((await slotPost(laptop.data.token)).status, 404);

    for (const name of [
      'install-runner-agent.ps1',
      'add-runner.ps1',
      'list-runners.ps1',
      'remove-runner.ps1',
      'start-runner.ps1',
      'sample-load.ps1',
      'keep-wsl-up.ps1',
      'keep-runners.ps1',
      'install-runner-agent.sh',
      'add-runner.sh',
      'list-runners.sh',
      'remove-runner.sh',
      'runner-slot.ps1',
      'launch-slot.ps1',
      'runner-slot.sh',
      'launch-slot.sh',
    ]) {
      assert.equal((await fetch(`${srv.base}/ci-runner/${name}`)).status, 200, name);
    }
    assert.match(await (await fetch(`${srv.base}/runner-agent.mjs`)).text(), /Citadel's CI runner agent/);
    assert.equal((await fetch(`${srv.base}/ci-runner/README.md`)).status, 404);
    // The Android emulator's distro on the same desktop downloads its setup the same way (#533).
    for (const name of ['setup.sh', 'citadel-android', 'install-sdk.sh']) assert.equal((await fetch(`${srv.base}/android-desktop/${name}`)).status, 200, name);
    assert.equal((await fetch(`${srv.base}/android-desktop/perigee-key.sh`)).status, 404);
    assert.equal((await fetch(`${srv.base}/android-desktop/constructor`)).status, 404);
  } finally {
    if (agent) await stopProcs([agent]);
    await srv.stop();
  }
});

test('no ship squeezes a runner (Cara, 2026-11-27: "if a machine doesnt have room, we can wait and load balance, not run the job starved"): with no plan held, a ship still leaves ships.json empty', async () => {
  // #2262: a Citadel ship on the PC's WSL runners held every Windows runner to 10% of the PC together, and a Worker
  // squeezed that hard missed the listener's 30 s handshake. A ship goes first through the plan's sleep only.
  const root = mkdtempSync(join(scratch.dir, 'no-squeeze-'));
  const ps = join(root, 'win', 'System32', 'WindowsPowerShell', 'v1.0');
  mkdirSync(ps, { recursive: true });
  writeFileSync(join(ps, 'powershell.exe'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(ps, 'powershell.exe'), 0o755);
  const installed = join(root, 'agent');
  mkdirSync(installed);
  copyFileSync(join(import.meta.dirname, '..', 'public', 'runner-agent.mjs'), join(installed, 'runner-agent.mjs'));
  writeFileSync(join(installed, 'keep-runners.ps1'), '');
  writeFileSync(join(root, 'token'), 'ccm_1_test\n');
  const ship = { repo: 'caraminden/claude-coordinator', runner: 'desktop-g248ij8-linux', first: true };
  // After the ship, a list job: its answer coming back means the agent has handled the ship before it.
  let answered = false;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/machines/runner-result') answered = true;
    if (!req.url?.startsWith('/api/machines/connect')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ hello: 'pc' })}\n\ndata: ${JSON.stringify({ ships: [ship] })}\n\ndata: ${JSON.stringify({ runners: { id: ID, op: 'list' } })}\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const logFile = join(root, 'agent.log');
  const agent = spawn(process.execPath, [join(installed, 'runner-agent.mjs'), `http://127.0.0.1:${port}`, '--token-file', join(root, 'token'), '--os', 'windows', '--sample-ms', '60000', '--log', logFile], { env: { ...process.env, SystemRoot: join(root, 'win') }, stdio: 'ignore' });
  try {
    await until('the agent to answer the job after the ship', async () => answered);
    assert.deepEqual(JSON.parse(readFileSync(join(installed, 'ships.json'), 'utf8')).ships, [], 'keep-runners.ps1 is told of no ship');
  } finally {
    await stopProcs([agent]);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("who is at the PC, from quser: the least idle active session, nobody, or can't tell", () => {
  const head = ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME';
  assert.equal(personIdle([head, '>cara                  console             1  Active      none   11/10/2026 8:01 AM']), 0);
  assert.equal(personIdle([head, '>cara                  console             1  Active         .   11/10/2026 8:01 AM']), 0);
  assert.equal(personIdle([head, ' cara                  console             1  Active      1:05   11/10/2026 8:01 AM', ' josh                  rdp-tcp#0           2  Active         7   11/10/2026 9:00 AM']), 420);
  assert.equal(personIdle([head, ' cara                                      3  Disc     2+03:04   11/9/2026 8:01 AM']), 1e6, 'a disconnected session is nobody at the PC');
  assert.equal(personIdle([head, ' cara                  console             1  Active   1+00:00   11/10/2026 8:01 AM']), 86400);
  assert.equal(personIdle([head]), 1e6);
  assert.equal(personIdle([]), 1e6);
  assert.equal(personIdle(null), null);
  assert.equal(personIdle([' BENUTZERNAME SITZUNGSNAME ID STATUS LEERLAUF ANMELDEZEIT', ' cara console eins Aktiv keine 10.11.2026 08:01']), null, 'lines it can\'t read are "can\'t tell", which Citadel reads as someone there');
});

test("a runner's use is its Runner.Listener and everything under it, as CPU since the last look", () => {
  const procs = [
    { pid: 10, ppid: 1, path: 'C:\\actions-runner-peek-auras-2\\bin\\Runner.Listener.exe', cpu: 3, mem: 100 },
    { pid: 11, ppid: 10, path: 'C:\\actions-runner-peek-auras-2\\bin\\Runner.Worker.exe', cpu: 4, mem: 200 },
    { pid: 12, ppid: 11, path: 'C:\\Users\\x\\.cargo\\bin\\cargo.exe', cpu: 50, mem: 300 },
    { pid: 20, ppid: 1, path: '/opt/actions-runner-claude-coordinator/bin/Runner.Listener', cpu: 1, mem: 10 },
    { pid: 30, ppid: 1, path: 'C:\\Games\\game.exe', cpu: 900, mem: 5000 },
    { pid: 31, ppid: 30, path: null, cpu: 1, mem: 1 },
  ];
  const first = runnerUse(procs, null);
  assert.deepEqual(first.runners, [
    { dir: 'C:\\actions-runner-peek-auras-2', cpu: null, mem: 600 },
    { dir: '/opt/actions-runner-claude-coordinator', cpu: null, mem: 10 },
  ]);
  // 30 seconds on: cargo used 20 more and a new rustc (pid 13) used 25 since it began.
  const next = [...procs.map((p) => (p.pid === 12 ? { ...p, cpu: 70 } : p)), { pid: 13, ppid: 12, path: 'rustc.exe', cpu: 25, mem: 400 }];
  assert.deepEqual(runnerUse(next, first.seen).runners, [
    { dir: 'C:\\actions-runner-peek-auras-2', cpu: 45, mem: 1000 },
    { dir: '/opt/actions-runner-claude-coordinator', cpu: 0, mem: 10 },
  ]);
  // A pid used again that points a process at its own child doesn't loop.
  assert.equal(runnerUse([{ ...procs[0], ppid: 11 }, procs[1]], first.seen).runners.length, 1);
  // A Linux runner that updated itself runs from bin.<version> (bin is a symlink to it, and /proc/<pid>/exe resolves it).
  assert.deepEqual(runnerUse([{ pid: 40, ppid: 1, path: '/opt/actions-runner-twireader/bin.2.330.0/Runner.Listener', cpu: 1, mem: 7 }], null).runners, [{ dir: '/opt/actions-runner-twireader', cpu: null, mem: 7 }]);
});

test("CPU of a child that started and ended between two looks still counts, through its parent's reaped-children time", () => {
  const root = { pid: 10, ppid: 1, path: '/opt/actions-runner-peek/bin/Runner.Listener', cpu: 1, mem: 1 };
  const worker = { pid: 11, ppid: 10, path: '/opt/actions-runner-peek/bin/Runner.Worker', cpu: 2, mem: 1, reaped: 0 };
  const first = runnerUse([{ ...root, reaped: 0 }, worker], null);
  // rustc (pid 12) lived and died inside the 30 s, 40 CPU seconds, taken into the worker's reaped time; the worker used 1 more itself.
  const next = runnerUse(
    [
      { ...root, reaped: 0 },
      { ...worker, cpu: 3, reaped: 40 },
    ],
    first.seen,
  );
  assert.equal(next.runners[0].cpu, 41);
  // A child seen at one look and gone at the next is not counted twice.
  const seenKid = runnerUse(
    [
      { ...root, reaped: 0 },
      { ...worker, cpu: 3, reaped: 0 },
      { pid: 12, ppid: 11, path: 'rustc', cpu: 10, mem: 1 },
    ],
    first.seen,
  );
  const gone = runnerUse(
    [
      { ...root, reaped: 0 },
      { ...worker, cpu: 3, reaped: 25 },
    ],
    seenKid.seen,
  );
  assert.equal(seenKid.runners[0].cpu, 11);
  assert.equal(gone.runners[0].cpu, 15);
});

test("linuxProcs reads the time of a process's reaped children", () => {
  const dir = mkdtempSync(join(tmpdir(), 'proc-'));
  mkdirSync(join(dir, '77'));
  // fields after the command: state ppid ... utime(14) stime(15) cutime(16) cstime(17)
  writeFileSync(join(dir, '77', 'stat'), '77 (a b) S 5 0 0 0 0 0 0 0 0 0 100 50 300 100 ' + '0 '.repeat(10) + '\n');
  assert.equal(linuxProcs(dir)[0].reaped, 4);
});

test("a sample: nothing on the first look, then percentages of the whole PC, named from each runner's .runner file", async () => {
  let t = 1_000_000;
  let procs = [{ pid: 10, ppid: 1, path: '/opt/actions-runner-vault/bin/Runner.Listener', cpu: 2, mem: 100 }];
  let times = { idle: 1000, total: 2000 };
  const sampler = new Sampler({ os: 'linux', dir: '/', now: () => t, times: () => times, procs: () => procs, identity: (dir: string) => ({ name: `PC-${dir.length}`, repo: 'caraminden/vault' }) });
  assert.equal(await sampler.take(), null);
  t += 30_000;
  times = { idle: 1250, total: 3000 };
  procs = [{ ...procs[0], cpu: 2 + 48 }];
  const s = (await sampler.take())!;
  assert.equal(s.cpu, 75);
  assert.equal(s.os, 'linux');
  assert.ok(s.cores >= 1 && s.mem_total > s.mem_free);
  // 48 CPU seconds in 30 seconds is 1.6 cores' worth: that over the PC's cores.
  assert.deepEqual(s.runners, [{ name: 'PC-25', repo: 'caraminden/vault', dir: '/opt/actions-runner-vault', cpu: Math.round((48 / (30 * s.cores)) * 1000) / 10, mem: 100 }]);
});

test('a Windows agent asks for the hard restarts on its second look, the first that makes a sample', async () => {
  let t = 1_000_000;
  const asked: boolean[] = [];
  const run = async ({ args }: { args: string[] }) => {
    asked.push(args.includes('-Restarts'));
    return { code: 0, output: JSON.stringify({ procs: [], queue: 1, quser: null, hv: null, temp: null, ...(args.includes('-Restarts') ? { restarts: ['2026-11-11T13:29:00.0000000Z'] } : {}) }) };
  };
  const sampler = new Sampler({ os: 'windows', dir: '/', run, now: () => t, times: () => ({ idle: t / 2, total: t }) });
  assert.equal(await sampler.take(), null);
  t += 30_000;
  assert.deepEqual((await sampler.take()).restarts, ['2026-11-11T13:29:00.0000000Z']);
  t += 30_000;
  assert.equal((await sampler.take()).restarts, undefined);
  assert.deepEqual(asked, [false, true, false]);
});

test('a line that arrives in pieces comes back whole: the sampler reads one long line of JSON', async () => {
  const { code, output } = await runCommand({ command: '/bin/sh', args: ['-c', 'echo first; printf "%s" \'{"procs":[[1,0,"sy\'; sleep 0.2; printf "%s" \'stem32",2,3]]\'; sleep 0.2; echo "}"'] }, process.env);
  assert.equal(code, 0);
  assert.deepEqual(output.split('\n'), ['first', '{"procs":[[1,0,"system32",2,3]]}']);
});

// Ships go first (#1268): the agent's half. The units and runners are faked; systemctl is a recorder.
function linuxRunners() {
  const units = mkdtempSync(join(scratch.dir, 'squeeze-'));
  const unit = (name: string, dir: string) => writeFileSync(join(units, name), `# citadel-repo=x\n[Service]\nExecStart=/bin/bash ${dir}/bin/runsvc.sh\n`);
  unit('citadel-runner-caraminden-claude-coordinator.service', '/opt/r/actions-runner-claude-coordinator');
  unit('citadel-runner-caraminden-claude-coordinator-2.service', '/opt/r/actions-runner-claude-coordinator-2');
  unit('citadel-runner-caraminden-twireader.service', '/opt/r/actions-runner-twireader');
  unit('citadel-runner-caraminden-twireader-2.service', '/opt/r/actions-runner-twireader-2');
  writeFileSync(join(units, 'citadel-runner-agent.service'), 'ExecStart=/usr/bin/node agent.mjs\n');
  const who: Record<string, { name: string; repo: string }> = {
    '/opt/r/actions-runner-claude-coordinator': { name: 'DESKTOP-G248IJ8-linux', repo: 'caraminden/claude-coordinator' },
    '/opt/r/actions-runner-claude-coordinator-2': { name: 'DESKTOP-G248IJ8-linux-2', repo: 'caraminden/claude-coordinator' },
    '/opt/r/actions-runner-twireader': { name: 'DESKTOP-G248IJ8-linux', repo: 'caraminden/twireader' },
    '/opt/r/actions-runner-twireader-2': { name: 'DESKTOP-G248IJ8-linux-2', repo: 'caraminden/twireader' },
  };
  const calls: string[] = [];
  let clock = 0;
  let working = ['/opt/r/actions-runner-claude-coordinator-2', '/opt/r/actions-runner-twireader'];
  const squeeze = new LinuxSqueeze({
    units,
    cores: 16,
    identity: (dir: string) => who[dir],
    now: () => clock,
    procs: () => working.map((d, i) => ({ pid: i, ppid: 1, path: `${d}/bin/Runner.Worker`, cpu: 0, mem: 0 })),
    run: async ({ args }: { args: string[] }) => (calls.push(`${args[2]} ${args[3]}`), { code: 0, output: '' }),
  });
  return { squeeze, calls, units, tick: (ms: number) => (clock += ms), work: (dirs: string[]) => (working = dirs) };
}

test('Linux: while a ship runs, every other runner unit gets a CPUQuota sharing about 30% of the cores among those running a job', async () => {
  const { squeeze, calls, units } = linuxRunners();
  try {
    await squeeze.update(cleanShips([{ repo: 'caraminden/claude-coordinator', runner: 'DESKTOP-G248IJ8-linux-2' }]));
    // 16 cores: 30% is 480% of one core; one other unit (twireader's first) runs a job, so each other unit may use all of it.
    assert.deepEqual(calls.sort(), ['citadel-runner-caraminden-claude-coordinator-2.service CPUQuota=', 'citadel-runner-caraminden-claude-coordinator.service CPUQuota=480%', 'citadel-runner-caraminden-twireader-2.service CPUQuota=480%', 'citadel-runner-caraminden-twireader.service CPUQuota=480%']);
  } finally {
    rmSync(units, { recursive: true, force: true });
  }
});

test('Linux: a quota changes only when its share does, and the squeeze lifts when the list empties or stops coming for 2 minutes', async () => {
  const { squeeze, calls, units, tick, work } = linuxRunners();
  try {
    const ship = cleanShips([{ repo: 'CaraMinden/claude-coordinator', runner: 'DESKTOP-G248IJ8-linux-2' }]);
    await squeeze.update(ship);
    calls.length = 0;
    await squeeze.update(ship);
    assert.deepEqual(calls, [] as string[], 'the same share is not set again every 15 seconds');
    work(['/opt/r/actions-runner-claude-coordinator-2', '/opt/r/actions-runner-twireader', '/opt/r/actions-runner-twireader-2']);
    await squeeze.update(ship);
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every((c) => c.endsWith('CPUQuota=240%')),
      calls.join('; '),
    );
    calls.length = 0;
    await squeeze.update([]);
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every((c) => c.endsWith('CPUQuota=')),
      calls.join('; '),
    );
    await squeeze.update(ship);
    calls.length = 0;
    tick(SHIP_HOLD_MS - 1);
    await squeeze.tick();
    assert.deepEqual(calls, [] as string[]);
    tick(1);
    await squeeze.tick();
    assert.ok(calls.length === 3 && calls.every((c) => c.endsWith('CPUQuota=')), 'Citadel silent for 2 minutes: lifted');
  } finally {
    rmSync(units, { recursive: true, force: true });
  }
});

test("Linux: a new agent clears every unit's quota at its first look, as one before it may have died mid-ship", async () => {
  const { squeeze, calls, units } = linuxRunners();
  try {
    await squeeze.next();
    assert.equal(calls.length, 4);
    assert.ok(
      calls.every((c) => c.endsWith('CPUQuota=')),
      calls.join('; '),
    );
    calls.length = 0;
    await squeeze.update([]);
    assert.deepEqual(calls, [], 'once cleared, an empty list sets nothing');
  } finally {
    rmSync(units, { recursive: true, force: true });
  }
});

test('Windows: the ships go to ships.json beside keep-runners.ps1 with a 2-minute expiry, malformed entries dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ships-'));
  try {
    writeShips(dir, cleanShips([{ repo: 'CaraMinden/Peek-Auras', runner: 'DESKTOP-G248IJ8' }, { repo: 5 }, null, { repo: 'a/b', runner: 'x'.repeat(201) }, { repo: 'c/d', runner: 'r', first: true }]), 1000);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ships.json'), 'utf8')), {
      until: 1000 + SHIP_HOLD_MS,
      ships: [
        { repo: 'caraminden/peek-auras', runner: 'desktop-g248ij8' },
        { repo: 'c/d', runner: 'r', first: true },
      ],
    });
    assert.ok(!existsSync(join(dir, 'ships.json.new')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner's caps.json sets the caps on that PC; today's numbers without one (#1933)", () => {
  const dir = mkdtempSync(join(scratch.dir, 'caps-'));
  const caps = (text?: string) => {
    const said: string[] = [];
    if (text !== undefined) writeFileSync(join(dir, 'caps.json'), text);
    return { caps: ownerCaps(dir, (l: string) => said.push(l)), said };
  };
  assert.deepEqual(caps(), { caps: { cpu: 75, squeeze: 30, citadel: 10 }, said: [] });
  assert.deepEqual(caps('{"cpu_percent": 50, "squeeze_percent": 20}').caps, { cpu: 50, squeeze: 20, citadel: 10 });
  assert.deepEqual(caps('{"cpu_percent": 50}').caps, { cpu: 50, squeeze: 30, citadel: 10 });
  // Notepad saves UTF-8 with a byte-order mark, which JSON.parse refuses.
  assert.deepEqual(caps('\ufeff{"cpu_percent": 60}').caps, { cpu: 60, squeeze: 30, citadel: 10 });
  // A squeeze is never more than the cap it sits in: keep-runners.ps1 divides one by the other.
  assert.deepEqual(caps('{"cpu_percent": 20}').caps, { cpu: 20, squeeze: 20, citadel: 10 });
  assert.deepEqual(caps('{"squeeze_percent": 5}').caps, { cpu: 75, squeeze: 5, citadel: 5 });
  // Anything wrong is said, and that cap keeps its default: the agent never stops for it.
  for (const bad of ['{not json', '[]', '{"cpu_percent": 0}', '{"cpu_percent": 101}', '{"cpu_percent": "50"}', '{"cpu_percent": 1.5}', '{"cpu": 50}']) {
    const r = caps(bad);
    assert.deepEqual(r.caps, { cpu: 75, squeeze: 30, citadel: 10 }, bad);
    assert.equal(r.said.length, 1, bad);
  }
  // Cara, 2026-11-27, "Drop the cap, keep low priority" (#2262): Windows runners get no CPU cap, cpu_percent or not.
  assert.match(keeperCommand(dir, 7, 'C:\\Windows', { cpu: 50, squeeze: 20, citadel: 10 }).args.join(' '), /-CpuPercent 0 -AgentPid 7 -SqueezePercent 20 -CitadelSqueezePercent 10$/);
});

test("Linux: the owner's squeeze is used, and the all-CI cap goes on the runners' slice only where the installer made one", async () => {
  const { squeeze, calls, units } = linuxRunners();
  Object.assign(squeeze, { percent: 10 });
  await squeeze.update(cleanShips([{ repo: 'caraminden/claude-coordinator', runner: 'DESKTOP-G248IJ8-linux-2' }]));
  assert.ok(calls.includes('citadel-runner-caraminden-twireader.service CPUQuota=160%'), calls.join('; '));
  const ran: string[] = [];
  const run = async (c: { command: string; args: string[] }) => (ran.push([c.command, ...c.args].join(' ')), { code: 0, output: '' });
  // Inside WSL no slice was made: .wslconfig caps that VM.
  await sliceCap({ cpu: 50 }, { run, units, cores: 8 });
  assert.deepEqual(ran, []);
  writeFileSync(join(units, SLICE), '');
  await sliceCap({ cpu: 50 }, { run, units, cores: 8 });
  assert.deepEqual(ran, [`systemctl set-property --runtime ${SLICE} CPUQuota=400%`]);
});

// One-job runners (runner pool P2, #2269): Citadel's start op, and the agent's own watch on the slots it started.
const ONCE = 'ab'.repeat(24);
const NAME = 'pool-m7-w1-j123';
const start = (slot: number, name = `pool-m7-w${slot}-j${slot}00`) => ({ id: ID, op: 'start', scheme: 3, slot, once: ONCE, name });

test("a start names a scheme, a slot of 1 to 16, a one-time id and the runner's pool name, and runs only runner-slot", () => {
  assert.deepEqual(checkJob({ id: ID, op: 'start', scheme: 3, slot: 16, once: ONCE, name: NAME }), { id: ID, op: 'start', scheme: 3, slot: 16, once: ONCE, name: NAME });
  for (const bad of [{ slot: 0 }, { slot: 17 }, { slot: '1' }, { once: ONCE.toUpperCase() }, { once: `${ONCE}; calc` }, { once: undefined }, { name: undefined }, { name: 'peek-desktop' }, { name: `${NAME}; calc` }, { extra: 1 }]) {
    assert.throws(() => checkJob({ id: ID, op: 'start', scheme: 3, slot: 1, once: ONCE, name: NAME, ...bad }), Error, JSON.stringify(bad));
  }
  // The agent's own slot ops never come from Citadel.
  for (const op of ['stop', 'state', 'update']) assert.throws(() => checkJob({ id: ID, op, scheme: 3, slot: 1 }), /refused/);
  const win = jobCommand(checkJob(start(2)), 'C:\\agent', 'http://perigee:8574', 'C:\\Windows', 'windows');
  assert.match(win.command, /powershell\.exe$/);
  assert.deepEqual(win.args.slice(5), [join('C:\\agent', 'runner-slot.ps1'), '-Op', 'Start', '-Scheme', '3', '-Slot', '2', '-Once', ONCE, '-CitadelUrl', 'http://perigee:8574']);
  assert.deepEqual(jobCommand(checkJob(start(2)), '/a', 'u', undefined, 'linux').args, ['/a/runner-slot.sh', 'start', '3', '2', ONCE, 'u']);
  // A stop goes by the slot folder's repo name only: it asks Citadel nothing, so it works once the loan has ended.
  assert.deepEqual(jobCommand({ op: 'stop', repo: 'peek', slot: 2 }, '/a', 'u', undefined, 'linux').args, ['/a/runner-slot.sh', 'stop', 'peek', '2']);
  assert.deepEqual(jobCommand({ op: 'stop', repo: 'peek', slot: 2 }, 'C:\\agent', 'u', 'C:\\Windows', 'windows').args.slice(6), ['-Op', 'Stop', '-Repo', 'peek', '-Slot', '2']);
  for (const repo of [undefined, '..', 'a b', 'x;calc']) assert.throws(() => jobCommand({ op: 'stop', repo, slot: 2 }, '/a', 'u', undefined, 'linux'), /repo name/, String(repo));
  assert.deepEqual(jobCommand({ op: 'state' }, '/a', 'u', 'C:\\Windows', 'windows').args.slice(6), ['-Op', 'State']);
});

test("the state op's lines read, and what doesn't read is skipped", () => {
  assert.deepEqual(slotStates('{"repo":"peek","slot":1,"running":true,"job":"test"}\r\nnoise\n{"repo":"peek","slot":"2","running":false}\n{"running":false,"repo":"delve","slot":3,"exit":0}'), [
    { repo: 'peek', slot: 1, running: true, job: 'test' },
    { repo: 'delve', slot: 3, running: false, exit: 0 },
  ]);
});

/** A SlotWatch over faked scripts: `states` is what the state op prints next; every op run is kept, with its arguments in `args`. */
function slotWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  const f = {
    dir,
    now: Date.UTC(2026, 10, 28),
    states: [] as object[],
    ran: [] as string[],
    args: [] as string[][],
    posted: [] as Record<string, unknown>[],
    down: false,
    failUpdate: false,
    unpooled: false,
    /** While set, a start waits on it: the agent can be "killed" mid-start. */
    hold: null as Promise<void> | null,
  };
  const run = async ({ args }: { args: string[] }) => {
    const op = args.includes('-Op') ? args[args.indexOf('-Op') + 1].toLowerCase() : args[1];
    f.ran.push(op);
    f.args.push(args.slice(args.indexOf('-Op')));
    if (op === 'state') return { code: 0, output: f.states.map((x) => JSON.stringify(x)).join('\n') };
    if (op === 'start') {
      if (f.hold) await f.hold;
      return { code: 0, output: `started peek slot 1\nslot: C:\\citadel-pool\\peek\\slot-${args[args.indexOf('-Slot') + 1]}` };
    }
    if (op === 'update' && f.failUpdate) return { code: 1, output: 'GitHub is away' };
    return { code: 0, output: 'ok' };
  };
  const make = () => {
    const jobs = new JobRunner({ dir, appUrl: 'http://citadel', token: 'ccm_1_x', run, os: 'windows' });
    const watch = new SlotWatch({
      jobs,
      now: () => f.now,
      post: async (b: Record<string, unknown>) => {
        if (f.down) return false;
        f.posted.push(b);
        return true;
      },
    });
    // Citadel's pool message: a machine that lends to a pooled scheme. `unpooled` leaves a fresh agent's default, which is idle.
    if (!f.unpooled) watch.pool(true);
    return { jobs, watch };
  };
  return { f, ...make(), make };
}

test("a started slot is watched: its job, its end with the launcher's code, each naming its runner, and a copy update once no slot runs", async () => {
  const { f, jobs, watch } = slotWorld();
  try {
    // At its first start the copy is due: the update runs under the job lock.
    await watch.tick();
    assert.deepEqual(f.ran, ['state', 'update']);
    f.ran.length = 0;
    assert.equal((await jobs.handle(start(1, NAME))).ok, true);
    assert.deepEqual(f.posted, [{ scheme: 3, slot: 1, os: 'windows', event: 'started', runner: NAME }]);
    f.now += 1000;
    f.states = [{ repo: 'peek', slot: 1, running: true, job: 'test (linux)' }];
    await watch.tick();
    f.states = [{ repo: 'peek', slot: 1, running: false, job: 'test (linux)', exit: 0 }];
    f.now += SLOT_IDLE_MS * 2;
    await watch.tick();
    assert.deepEqual(f.posted.slice(1), [
      { scheme: 3, slot: 1, os: 'windows', event: 'took', runner: NAME, job: 'test (linux)' },
      { scheme: 3, slot: 1, os: 'windows', event: 'ended', runner: NAME, code: 0 },
    ]);
    // Watching nothing, with the copy fresh: no script runs at all.
    assert.deepEqual(f.ran, ['start', 'state', 'state']);
    await watch.tick();
    assert.deepEqual(f.ran, ['start', 'state', 'state']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('a machine no pooled scheme lends to does nothing: no state, no update, no job lock, until Citadel says a pooled scheme uses it', async () => {
  const { f, make } = slotWorld();
  try {
    f.unpooled = true;
    const { jobs, watch } = make();
    // A fresh agent (copied 0) is due an update, but not before a pooled scheme uses the machine.
    await watch.tick();
    assert.deepEqual(f.ran, []);
    assert.equal(jobs.busy, null);
    watch.pool(true);
    await watch.tick();
    assert.deepEqual(f.ran, ['state', 'update']);
    watch.pool(false);
    watch.copied = 0;
    f.ran.length = 0;
    await watch.tick();
    assert.deepEqual(f.ran, [], 'switched off again: no update');
  } finally {
    rmSync(f.dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('a runner with no job after 2 minutes is stopped by its repo, and an agent started again carries on its watch and its unsent reports', async () => {
  const { f, jobs, watch, make } = slotWorld();
  try {
    await watch.tick();
    await jobs.handle(start(2));
    await jobs.handle({ ...start(5), scheme: 4 });
    f.states = [
      { repo: 'peek', slot: 2, running: true },
      { repo: 'peek', slot: 5, running: true },
    ];
    f.now += SLOT_IDLE_MS - 1;
    f.ran.length = 0;
    await watch.tick();
    assert.deepEqual(f.ran, ['state']);
    // Citadel is away when the idle runners are stopped: the reports wait.
    f.down = true;
    f.now += 2;
    f.states = [{ repo: 'peek', slot: 2, running: true }];
    await watch.tick();
    assert.deepEqual(f.ran, ['state', 'state', 'stop']);
    assert.deepEqual(f.args.at(-1), ['-Op', 'Stop', '-Repo', 'peek', '-Slot', '2']);
    assert.equal(f.posted.length, 2);
    // A new agent (the old one killed) reads slots.json: slot 5 ended while it was gone, and the stop's report goes too.
    f.down = false;
    f.states = [];
    await make().watch.tick();
    assert.deepEqual(
      f.posted.slice(2).map((p) => `${p.slot} ${p.event} ${p.runner}`),
      ['2 stopped pool-m7-w2-j200', '5 ended pool-m7-w5-j500'],
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('a slot started again before a tick saw its last runner end reports that one ended first', async () => {
  const { f, jobs, watch } = slotWorld();
  try {
    await watch.tick();
    await jobs.handle(start(1, 'pool-m7-w1-aaaaaa'));
    // Its runner exits within the 15 seconds before the next look, and Citadel starts the slot again.
    await jobs.handle(start(1, 'pool-m7-w1-bbbbbb'));
    assert.deepEqual(
      f.posted.map((p) => `${p.event} ${p.runner}`),
      ['started pool-m7-w1-aaaaaa', 'ended pool-m7-w1-aaaaaa', 'started pool-m7-w1-bbbbbb'],
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('an agent killed during a start reports that runner ended at its next start, so Citadel takes it off GitHub', async () => {
  const { f, jobs, watch, make } = slotWorld();
  try {
    await watch.tick();
    let release = () => {};
    f.hold = new Promise((r) => {
      release = r;
    });
    const going = jobs.handle(start(3, NAME));
    await until('the start is running', () => f.ran.includes('start'));
    // The agent dies here: its watch never hears the start end. The next one finds the start it saved before running it.
    const next = make();
    await next.watch.flush();
    assert.deepEqual(f.posted, [{ scheme: 3, slot: 3, os: 'windows', event: 'ended', runner: NAME }]);
    f.hold = null;
    release();
    await going;
    assert.ok(!Object.keys(next.watch.slots).some((k) => k.startsWith('pending/')), 'the next agent keeps no pending start');
  } finally {
    rmSync(f.dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('a copy 25 days past its last good update drains the slots: no start meanwhile, the update once they end, and a failed one tried again in 10 minutes', async () => {
  const { f, jobs, watch } = slotWorld();
  try {
    await watch.tick();
    await jobs.handle(start(1, NAME));
    f.states = [{ repo: 'peek', slot: 1, running: true, job: 'build' }];
    // A busy slot all along: a day on, the update waits for it.
    f.now += COPY_EVERY_MS + 1;
    f.ran.length = 0;
    await watch.tick();
    assert.deepEqual(f.ran, ['state']);
    assert.equal(jobs.busy, null);
    f.now += COPY_MAX_MS;
    await watch.tick();
    assert.match(String(jobs.draining), /draining/);
    assert.match((await jobs.handle(start(2))).output, /draining slots/);
    // Only starts wait: Citadel's other jobs still run.
    assert.equal((await jobs.handle({ id: ID, op: 'list' })).ok, true);
    // The slot ends; the update takes the lock over, fails, and lets starts in until its next try.
    f.failUpdate = true;
    f.states = [{ repo: 'peek', slot: 1, running: false, exit: 0 }];
    await watch.tick();
    assert.deepEqual(f.ran.slice(-2), ['state', 'update']);
    assert.equal(jobs.busy, null);
    assert.equal(jobs.draining, null);
    f.ran.length = 0;
    // With a slot busy again, a failed update's drain waits a day: starts run meanwhile.
    await jobs.handle(start(4));
    f.states = [{ repo: 'peek', slot: 4, running: true, job: 'build' }];
    f.now += COPY_RETRY_MS + 1;
    await watch.tick();
    assert.equal(jobs.draining, null);
    f.now += COPY_EVERY_MS;
    await watch.tick();
    assert.match(String(jobs.draining), /draining/);
    f.states = [{ repo: 'peek', slot: 4, running: false, exit: 0 }];
    await watch.tick();
    assert.equal(jobs.draining, null, 'the update ran and failed again, ending the drain');
    f.ran.length = 0;
    f.states = [];
    f.now += COPY_RETRY_MS - 1;
    await watch.tick();
    assert.deepEqual(f.ran, []);
    f.failUpdate = false;
    f.now += 2;
    await watch.tick();
    assert.deepEqual(f.ran, ['state', 'update']);
    f.ran.length = 0;
    f.now += 1000;
    await watch.tick();
    assert.deepEqual(f.ran, [], 'a good update is good for a day');
  } finally {
    rmSync(f.dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
