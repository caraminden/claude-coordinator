// The CI runner agent (#328, public/runner-agent.mjs) runs elevated on Cara's desktop, so what it accepts is the whole
// of its reach: three ops with checked numbers, its own scripts only, one job at a time, tokens kept out of its output.
// Here the scripts are faked (a node one-liner stands in for PowerShell); the Windows side is untested until installed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJob, JobRunner, jobCommand, redact, runCommand } from '../public/runner-agent.mjs';

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
  const add = jobCommand({ op: 'add', scheme: 3, count: 2 }, dir, 'http://perigee:8574', 'C:\\Windows');
  assert.equal(add.command.replaceAll('\\', '/'), ps.replaceAll('\\', '/'));
  assert.deepEqual(add.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(add.args[5], /add-runner\.ps1$/);
  assert.deepEqual(add.args.slice(6), ['-Scheme', '3', '-CitadelUrl', 'http://perigee:8574', '-Count', '2']);
  assert.match(jobCommand({ op: 'remove', scheme: 3 }, dir, 'u').args[5], /remove-runner\.ps1$/);
  assert.deepEqual(jobCommand({ op: 'list' }, dir, 'u').args.slice(5).map((a: string) => a.replace(/.*[\\/]/, '')), ['list-runners.ps1']);
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
