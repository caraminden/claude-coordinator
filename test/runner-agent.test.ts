// The CI runner agent (#328, public/runner-agent.mjs) runs elevated on Cara's desktop, so what it accepts is the whole
// of its reach: three ops with checked numbers, its own scripts only, one job at a time, tokens kept out of its output.
// Here the scripts are faked (a node one-liner stands in for PowerShell); the Windows side is untested until installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkJob, JobRunner, jobCommand, personIdle, redact, runCommand, runnerUse, Sampler } from '../public/runner-agent.mjs';
import { bootServer, stopProcs, until } from './helpers.ts';

const ID = 'a'.repeat(24);

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
  ]) assert.throws(() => checkJob(bad), undefined, JSON.stringify(bad));
});

test('each op runs its own script from the agent\'s folder in Windows PowerShell, with numbers for arguments', () => {
  const dir = 'C:\\ProgramData\\citadel-runner-agent';
  const ps = 'C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const add = jobCommand({ op: 'add', scheme: 3, count: 2 }, dir, 'http://perigee:8574', 'C:\\Windows', 'windows');
  assert.equal(add.command.replaceAll('\\', '/'), ps.replaceAll('\\', '/'));
  assert.deepEqual(add.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(add.args[5], /add-runner\.ps1$/);
  assert.deepEqual(add.args.slice(6), ['-Scheme', '3', '-CitadelUrl', 'http://perigee:8574', '-Count', '2']);
  assert.match(jobCommand({ op: 'remove', scheme: 3 }, dir, 'u', 'C:\\Windows', 'windows').args[5], /remove-runner\.ps1$/);
  assert.deepEqual(jobCommand({ op: 'list' }, dir, 'u', 'C:\\Windows', 'windows').args.slice(5).map((a: string) => a.replace(/.*[\\/]/, '')), ['list-runners.ps1']);
});

test('the Linux agent (#510) runs the bash twin of each script from its folder, with the same checked numbers as arguments', () => {
  assert.deepEqual(jobCommand({ op: 'add', scheme: 3, count: 2 }, '/opt/citadel-runner-agent', 'http://perigee:8574', undefined, 'linux'),
    { command: '/bin/bash', args: ['/opt/citadel-runner-agent/add-runner.sh', '3', 'http://perigee:8574', '2'] });
  assert.deepEqual(jobCommand({ op: 'remove', scheme: 3 }, '/a', 'u', undefined, 'linux').args, ['/a/remove-runner.sh', '3', 'u']);
  assert.deepEqual(jobCommand({ op: 'list' }, '/a', 'u', undefined, 'linux').args, ['/a/list-runners.sh']);
});

test('tokens are blanked from what goes back to Citadel', () => {
  const said = redact('token ccm_12_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG and --token AABCDEFGHIJKLMNOPQRSTUVWXYZ12 and gho_abcdefghijklmnopqrstuv');
  assert.doesNotMatch(said, /ccm_12_a|AABCDEF|gho_a/);
  assert.equal(redact('Done: actions.runner.caraminden-peek-auras.DESKTOP-G248IJ8 is Running.'), 'Done: actions.runner.caraminden-peek-auras.DESKTOP-G248IJ8 is Running.');
});

test('one job at a time: the script gets the machine token in its environment, and its exit code decides ok', async () => {
  const calls: any[] = [];
  let release!: () => void;
  const run = (cmd: any, env: any) => {
    calls.push({ cmd, token: env.CC_MACHINE_TOKEN });
    return new Promise((r) => { release = () => r({ code: 0, output: 'Done. --token AABCDEFGHIJKLMNOPQRSTUVWXYZ12' }); });
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

test('a script\'s output is collected, and one that runs too long is stopped', async () => {
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

test('end to end: the agent connects as a runner agent, a member\'s list runs its script, and Citadel serves the install files', async () => {
  const srv = await bootServer();
  const agentFile = join(import.meta.dirname, '..', 'public', 'runner-agent.mjs');
  let agent: ReturnType<typeof spawn> | undefined;
  try {
    // Stands in for Windows PowerShell: says what it was given, and the token it found in its environment.
    const ps = join(srv.root, 'win', 'System32', 'WindowsPowerShell', 'v1.0');
    mkdirSync(ps, { recursive: true });
    // For sample-load.ps1 it prints a line like the real one's: a runner with a child, two threads waiting, Cara at the PC.
    const line = JSON.stringify({ procs: [[10, 1, 'C:\\actions-runner-vault\\bin\\Runner.Listener.exe', 1, 1000], [11, 10, 'C:\\cargo\\rustc.exe', 5, 2000]], queue: 2, quser: [' USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME', '>cara console 1 Active 3 11/10/2026 8:01 AM'], hv: null, temp: null, restarts: ['2026-10-30T13:34:00.0000000Z'] });
    writeFileSync(join(srv.root, 'sample.json'), line);
    writeFileSync(join(ps, 'powershell.exe'), `#!/bin/sh\ncase "$*" in *sample-load.ps1*) cat '${join(srv.root, 'sample.json')}'; exit 0;; esac\necho "fake ps: $*"\necho "token was $CC_MACHINE_TOKEN"\n`);
    chmodSync(join(ps, 'powershell.exe'), 0o755);
    const made = await srv.call('/api/machines', { name: 'desk-runners' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const tokenFile = join(srv.root, 'machine-token');
    writeFileSync(tokenFile, `${made.data.token}\n`);
    agent = spawn(process.execPath, [agentFile, srv.base, '--token-file', tokenFile, '--os', 'windows', '--sample-ms', '200'], { env: { ...process.env, SystemRoot: join(srv.root, 'win') }, stdio: 'ignore' });
    const online = await until('the runner agent to connect', async () => (await srv.call('/api/machines')).data.find((m: any) => m.name === 'desk-runners' && m.online));
    assert.equal(online.runners, true);
    assert.deepEqual(online.servers, [], 'turns never get it as an MCP machine');

    const project = (await srv.call('/api/projects', { name: 'Vault' })).data;
    // A new runner host starts with no scheme (#438): until an admin adds one, it acts for none.
    assert.equal((await srv.call(`/api/projects/${project.id}/ci-runners`, { op: 'list' })).status, 409);
    assert.equal((await srv.call(`/api/machines/${made.data.machine.id}`, { projects: [project.id] }, 'PATCH')).status, 200);
    const started = await srv.call(`/api/projects/${project.id}/ci-runners`, { op: 'list' });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const { job } = (await srv.call(`/api/projects/${project.id}/ci-runners?wait=20`)).data;
    assert.equal(job.ok, true, job.text);
    assert.match(job.text, /fake ps: -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \S+list-runners\.ps1/);
    assert.match(job.text, /token was ccm_…/);
    assert.doesNotMatch(job.text, new RegExp(made.data.token));

    // Its load samples (#534) reach the CI desktop view: the second look on, since CPU needs two.
    const pc = await until('a load sample', async () => (await srv.call('/api/ci-desktop')).data.pcs.find((p: any) => p.now));
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

    for (const name of ['install-runner-agent.ps1', 'add-runner.ps1', 'list-runners.ps1', 'remove-runner.ps1', 'start-runner.ps1', 'sample-load.ps1', 'keep-wsl-up.ps1',
      'install-runner-agent.sh', 'add-runner.sh', 'list-runners.sh', 'remove-runner.sh']) {
      assert.equal((await fetch(`${srv.base}/ci-runner/${name}`)).status, 200, name);
    }
    assert.match(await (await fetch(`${srv.base}/runner-agent.mjs`)).text(), /Citadel's CI runner agent/);
    assert.equal((await fetch(`${srv.base}/ci-runner/README.md`)).status, 404);
  } finally {
    if (agent) await stopProcs([agent]);
    await srv.stop();
  }
});

test('who is at the PC, from quser: the least idle active session, nobody, or can\'t tell', () => {
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

test('a runner\'s use is its Runner.Listener and everything under it, as CPU since the last look', () => {
  const procs = [
    { pid: 10, ppid: 1, path: 'C:\\actions-runner-peek-auras-2\\bin\\Runner.Listener.exe', cpu: 3, mem: 100 },
    { pid: 11, ppid: 10, path: 'C:\\actions-runner-peek-auras-2\\bin\\Runner.Worker.exe', cpu: 4, mem: 200 },
    { pid: 12, ppid: 11, path: 'C:\\Users\\x\\.cargo\\bin\\cargo.exe', cpu: 50, mem: 300 },
    { pid: 20, ppid: 1, path: '/opt/actions-runner-claude-coordinator/bin/Runner.Listener', cpu: 1, mem: 10 },
    { pid: 30, ppid: 1, path: 'C:\\Games\\game.exe', cpu: 900, mem: 5000 },
    { pid: 31, ppid: 30, path: null, cpu: 1, mem: 1 },
  ];
  const first = runnerUse(procs, null);
  assert.deepEqual(first.runners, [{ dir: 'C:\\actions-runner-peek-auras-2', cpu: null, mem: 600 }, { dir: '/opt/actions-runner-claude-coordinator', cpu: null, mem: 10 }]);
  // 30 seconds on: cargo used 20 more, a new rustc (pid 13) used 25 since it began, and pid 11 is a new process under an old number.
  const next = [...procs.map((p) => (p.pid === 12 ? { ...p, cpu: 70 } : p.pid === 11 ? { ...p, cpu: 1 } : p)), { pid: 13, ppid: 12, path: 'rustc.exe', cpu: 25, mem: 400 }];
  assert.deepEqual(runnerUse(next, first.seen).runners, [{ dir: 'C:\\actions-runner-peek-auras-2', cpu: 46, mem: 1000 }, { dir: '/opt/actions-runner-claude-coordinator', cpu: 0, mem: 10 }]);
  // A pid used again that points a process at its own child doesn't loop.
  assert.equal(runnerUse([{ ...procs[0], ppid: 11 }, procs[1]], first.seen).runners.length, 1);
});

test('a sample: nothing on the first look, then percentages of the whole PC, named from each runner\'s .runner file', async () => {
  let t = 1_000_000;
  let procs = [{ pid: 10, ppid: 1, path: '/opt/actions-runner-vault/bin/Runner.Listener', cpu: 2, mem: 100 }];
  let times = { idle: 1000, total: 2000 };
  const sampler = new Sampler({ os: 'linux', dir: '/', now: () => t, times: () => times, procs: () => procs, identity: (dir: string) => ({ name: `PC-${dir.length}`, repo: 'caraminden/vault' }) });
  assert.equal(await sampler.take(), null);
  t += 30_000;
  times = { idle: 1250, total: 3000 };
  procs = [{ ...procs[0], cpu: 2 + 48 }];
  const s = await sampler.take();
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
