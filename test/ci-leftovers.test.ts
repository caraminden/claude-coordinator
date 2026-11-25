// The sweep of what a killed CI job left running (test/ci-leftovers.ts, #1900). Stand-in jobs (a process named like
// Runner.Worker, but under a name of this test's own) and a temp folder of its own: it never looks at the box's real ones.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ciLeftovers, jobTmp, sweep } from './ci-leftovers.ts';
import { until } from './wait.ts';

const base = mkdtempSync(join(tmpdir(), 'cileft-'));
const worker = `Wk${process.pid}`; // a comm is at most 15 characters
const pids: number[] = [];
const children: ChildProcess[] = [];
const alive = (pid: number) => {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
};
after(async () => {
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const p of children) p.kill('SIGKILL');
  await until('all to be gone', () => !pids.some(alive));
  rmSync(base, { recursive: true, force: true }); // timing-ok: own temp dir, its processes gone
});

const script = join(base, worker);
writeFileSync(script, '#!/bin/sh\necho $$ >"$1"; shift; "$@" & wait\n');
chmodSync(script, 0o755);
let n = 0;
const pidIn = async (file: string) => {
  await until(`${file} to be written`, () => existsSync(file) && readFileSync(file, 'utf8').trim() !== '');
  const pid = Number(readFileSync(file, 'utf8'));
  pids.push(pid);
  return pid;
};
/** A live job running `cmd`. */
const job = async (...cmd: string[]) => {
  const file = join(base, `pid${n++}`);
  children.push(spawn(script, [file, ...cmd], { stdio: 'ignore', detached: true }));
  return pidIn(file);
};
/** An orphan, its parent gone, naming `arg`. */
const orphan = async (arg: string, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) => {
  const file = join(base, `pid${n++}`);
  spawn('sh', ['-c', '(setsid sh -c \'echo $$ >"$1"; sleep 300; :\' left "$1" "$2" </dev/null >/dev/null 2>&1 &)', 'sh', file, arg], { stdio: 'ignore', env });
  return pidIn(file);
};
/** A process of a job: its shell writes its pid. */
const shell = (file: string, arg: string) => ['sh', '-c', 'echo $$ >"$1"; sleep 300; :', 'step', file, arg];

const tmp = join(base, 'tmp');
const own = join(tmp, 'j-000001');
const other = join(tmp, 'j-000002');
mkdirSync(own, { recursive: true });

test('a killed job’s leftovers go, and nothing of a live one’s or outside', async () => {
  // Left by jobs that are over, before any live job started.
  const old = [await orphan(join(other, 'f-abcdef/turns/x')), await orphan(join(tmp, 'mut-y38MA1/c5'))];
  const outside = [await orphan('/opt/a-service/x'), await orphan(join(tmp, 'noscratch')), await orphan(join(tmp, 'named-longer1/x'))];
  const uptime = () => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  const t0 = uptime();
  await until('the start times to tell apart', () => uptime() > t0 + 0.02);
  // Another live job, its step, and an orphan a step of it started (a supervisor in its unit is one).
  const otherStep = join(base, 'other-step');
  const live = [await job(...shell(otherStep, join(other, 'f-ghijkl'))), await pidIn(otherStep), await orphan(join(other, 'f-ghijkl/turns'))];
  // This runner: its worker, whose job is running the sweep; a killed earlier job left two, one known by its TMPDIR only.
  const step = join(base, 'own-step');
  const mine = [await job(...shell(step, 'x')), await pidIn(step)];
  const left = [await orphan(join(own, 'f-mnopqr/turns')), await orphan('nothing', { PATH: process.env.PATH, TMPDIR: join(own, 'f-mnopqr') })];
  const o = { own: [own], tmp, worker, self: mine[1] };

  const found = new Set(ciLeftovers(o).map((p) => p.pid));
  for (const pid of [...old, ...left]) assert.ok(found.has(pid), `${pid} is a leftover: ${[...found]}`);
  for (const pid of [...live, ...mine, ...outside]) assert.ok(!found.has(pid), `${pid} is not`);

  const said: string[] = [];
  assert.deepEqual(
    sweep(o, (l) => said.push(l)),
    [],
  );
  assert.deepEqual([...old, ...left].filter(alive), []);
  assert.deepEqual(
    [...live, ...mine, ...outside].filter((p) => !alive(p)),
    [],
  );
  assert.match(said[0], /^\d+ leftover process\(es\) stopped$/);

  // Once the other job is over, what it left goes at the next job's start.
  process.kill(live[0], 'SIGKILL');
  await until('the other job to be over', () => !alive(live[0]));
  const next = join(base, 'next-step');
  process.kill(mine[0], 'SIGKILL');
  await until('this runner’s job to be over', () => !alive(mine[0]));
  await job(...shell(next, 'x'));
  sweep({ ...o, self: await pidIn(next) }, () => {});
  assert.ok(!alive(live[2]), 'the finished job’s orphan');
  assert.deepEqual(
    outside.filter((p) => !alive(p)),
    [],
  );
});

test('outside a job nothing is a leftover', async () => {
  await orphan(join(own, 'f-aaaaaa'));
  assert.deepEqual(ciLeftovers({ own: [own], tmp, worker: 'NoSuchWorker', self: process.pid }), []);
});

test('a supervisor’s unit is stopped, not just killed: it would start again', async (t) => {
  if (spawnSync('systemd-run', ['--user', '--quiet', '--collect', '--wait', 'true'], { stdio: 'ignore' }).status !== 0) return t.skip('no user systemd');
  const unit = `citadel-cileft-${process.pid}.service`;
  const step = join(base, 'unit-step');
  await job(...shell(step, 'x'));
  const self = await pidIn(step);
  spawnSync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unit}`, '-p', 'Restart=always', '-p', 'RestartSec=0', 'sh', '-c', 'sleep 300; :', 'left', join(own, 'f-unitxx')]);
  try {
    await until('the unit to run', () => ciLeftovers({ own: [own], tmp, worker, self }).some((p) => p.args.includes('left')));
    assert.deepEqual(
      sweep({ own: [own], tmp, worker, self }, () => {}),
      [],
    );
    assert.notEqual(spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).stdout.trim(), 'active');
  } finally {
    spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
  }
});

test('each runner has a short temp folder of its own', () => {
  const [a, b] = ['/opt/actions-runner-x/_work/_temp', '/opt/actions-runner-x-2/_work/_temp'].map(jobTmp);
  assert.notEqual(a, b);
  assert.match(a, /^\/tmp\/j-[0-9a-f]{6}$/);
});

// Every workflow that runs Citadel's tests on the shared runner sweeps at its start and, however the job went, as its last step.
test('every job that runs tests on the runners sweeps at its start and end', () => {
  for (const f of ['tests.yml', 'flake-proof.yml', 'citadel-heavy.yml']) {
    const text = readFileSync(join(import.meta.dirname, '../.github/workflows', f), 'utf8');
    const start = text.indexOf('node test/ci-leftovers.ts start');
    assert.ok(start > text.indexOf('actions/setup-node') && start < text.indexOf('- name: pwsh and PSScriptAnalyzer'), `${f}: after node, before the work`);
    assert.match(text.trimEnd().split('\n      - ').at(-1)!, /if: always\(\)[\s\S]*node test\/ci-leftovers\.ts end/, `${f}: its last step, however the job went`);
  }
});
