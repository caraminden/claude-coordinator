import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from './wait.ts';

// tools/test-gate.ts (#1928): one shared limit on the test files running at once, moved by CPU pressure.
process.env.CITADEL_TEST_FILES = '0'; // importing the gate must not hold this file back
const { limitAt } = await import('../tools/test-gate.ts');
const gate = join(import.meta.dirname, '..', 'tools', 'test-gate.ts');
const root = mkdtempSync(join(tmpdir(), 'test-gate-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const psi = (p: number) => `some avg10=1.00 avg60=${p}.50 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

// One "test file": it takes a place through the gate, then records how many such files are running right now.
const body = (ms: number) => `const fs=require('fs'),p=require('path');const r=process.env.RUN;fs.writeFileSync(p.join(r,'up-'+process.pid),'');const k=fs.readdirSync(r).filter(f=>f.startsWith('up-')).length;fs.appendFileSync(p.join(r,'seen'),k+'\\n');setTimeout(()=>{fs.rmSync(p.join(r,'up-'+process.pid));},${ms});`;
function setup(pressure = 20) {
  const dir = join(root, `heavy-${n++}`);
  const run = `${dir}-run`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(run);
  writeFileSync(`${dir}-psi`, psi(pressure));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CITADEL_HEAVY_DIR: dir,
    CITADEL_HEAVY_PRESSURE: `${dir}-psi`,
    RUN: run,
    CITADEL_TEST_FILES: '4',
    CITADEL_TEST_FILES_MIN: '2',
    CITADEL_TEST_FILES_MAX: '8',
    CITADEL_TEST_ROOM_WAIT: '60',
    NODE_OPTIONS: undefined,
    RUNNER_TEMP: undefined,
    GITHUB_ACTIONS: undefined,
    CITADEL_HEAVY_HELD: undefined,
    CITADEL_TEST_GATE_NOTE: join(root, `note-${n}`),
  };
  return { dir, run, env };
}
const file = (env: NodeJS.ProcessEnv, ms = 700) => {
  const c = spawn(process.execPath, ['--import', gate, '-e', body(ms)], { env, stdio: 'ignore' });
  return new Promise<number | null>((r) => c.on('close', r));
};
const peak = (run: string) => Math.max(...readFileSync(join(run, 'seen'), 'utf8').trim().split('\n').map(Number));

test('the limit steps with CPU pressure: the floor when busy, one less, the start, two more, the ceiling when calm', () => {
  assert.deepEqual(
    [60, 35, 34, 25, 24, 15, 14, 8, 7, 0].map((p) => limitAt(p, 4, 2, 8)),
    [2, 2, 3, 3, 4, 4, 6, 6, 8, 8],
  );
  assert.equal(limitAt(null, 4, 2, 8), 4, 'no reading: the start');
  assert.equal(limitAt(5, 4, 2, 5), 5, 'never past the ceiling');
  assert.equal(limitAt(40, 1, 2, 8), 2, 'never under the floor');
});

test('test files of separate runs keep to the one limit, arriving while others are picked', async () => {
  const { env, run } = setup(20);
  const jobs: Promise<number | null>[] = [];
  // Four runs of four files, the later runs' first files sorting ahead of the earlier runs' later ones.
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 4; i++) jobs.push(file({ ...env, CITADEL_TEST_GATE_NOTE: `${env.CITADEL_TEST_GATE_NOTE}-${r}` }, 400));
    await until(`run ${r} to have files in`, () => existsSync(`${env.CITADEL_TEST_GATE_NOTE}-${r}.n`));
  }
  assert.deepEqual(new Set(await Promise.all(jobs)), new Set([0]));
  assert.ok(peak(run) <= 4 && peak(run) >= 3, `peak ${peak(run)}`);
  assert.equal(readFileSync(join(run, 'seen'), 'utf8').trim().split('\n').length, 16, 'and all of them ran');
});

test('a busy box shrinks the limit and a calm one grows it, read at each file start', async () => {
  const busy = setup(40);
  await Promise.all(Array.from({ length: 6 }, () => file(busy.env, 400)));
  assert.equal(peak(busy.run), 2);
  const calm = setup(3);
  await Promise.all(Array.from({ length: 12 }, () => file({ ...calm.env, CITADEL_TEST_FILES_MAX: '6' }, 1500)));
  assert.ok(peak(calm.run) > 4 && peak(calm.run) <= 6, `peak ${peak(calm.run)}`);
});

test('a file killed while it holds a place frees it at once', async () => {
  const { env, run, dir } = setup(20);
  const one = { ...env, CITADEL_TEST_FILES: '1', CITADEL_TEST_FILES_MIN: '1', CITADEL_TEST_FILES_MAX: '1' };
  const holder = spawn(process.execPath, ['--import', gate, '-e', body(60_000)], { env: one, stdio: 'ignore' });
  await until('the holder up', () => readdirSync(run).some((f) => f.startsWith('up-')));
  let done = false;
  const second = file(one, 100).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 800)); // timing-ok: it must still be waiting
  assert.equal(done, false, 'waits while the place is held');
  holder.kill('SIGKILL');
  await until('the second ran', () => done);
  await second;
  assert.ok(existsSync(dir));
});

test('a file that waits prints one line, holds no place and starts anyway after the wait', async () => {
  const { env, run } = setup(20);
  const one = { ...env, CITADEL_TEST_FILES: '1', CITADEL_TEST_FILES_MIN: '1', CITADEL_TEST_FILES_MAX: '1', CITADEL_TEST_ROOM_WAIT: '2' };
  const holder = spawn(process.execPath, ['--import', gate, '-e', body(60_000)], { env: one, stdio: 'ignore' });
  await until('the holder up', () => readdirSync(run).some((f) => f.startsWith('up-')));
  assert.equal(await file(one, 50), 0, 'it started after the 2 s wait');
  assert.match(readFileSync(env.CITADEL_TEST_GATE_NOTE!, 'utf8'), /^waiting for room: 1 test files may run at once on this box \(CPU pressure 20%\)/);
  assert.equal(peak(run), 2, 'it started past the limit, as the cap says');
  holder.kill('SIGKILL');
});

test('off, on CI and inside a heavy slot, nothing waits: all six run at once on a box whose limit is two', async () => {
  for (const off of [{ CITADEL_TEST_FILES: '0' }, { RUNNER_TEMP: '/tmp' }, { GITHUB_ACTIONS: 'true' }, { CITADEL_HEAVY_HELD: '1' }]) {
    const { env, run } = setup(60);
    const all = Array.from({ length: 6 }, () => spawn(process.execPath, ['--import', gate, '-e', body(600_000)], { env: { ...env, ...off }, stdio: 'ignore' }));
    try {
      await until(`all six up with ${JSON.stringify(off)}`, () => readdirSync(run).filter((f) => f.startsWith('up-')).length === 6);
    } finally {
      for (const c of all) c.kill('SIGKILL');
    }
  }
});

// A place of the limit's, held by this test until it is let go.
async function holdPlace(dir: string, i: number) {
  const c = spawn('flock', [join(dir, `test-slot-${i}`), 'sh', '-c', 'echo held; exec sleep 600'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  let up = false;
  c.stdout!.on('data', () => (up = true));
  await until(`place ${i} held`, () => up);
  return () => process.kill(-c.pid!, 'SIGKILL');
}
const inLine = (dir: string) => (existsSync(join(dir, 'test-line')) ? readdirSync(join(dir, 'test-line')) : []);

test('after a shrink no file starts while the files still running fill the smaller limit, whichever places they hold', async () => {
  const { env, run, dir } = setup(40); // the floor: 2
  const free = [await holdPlace(dir, 5), await holdPlace(dir, 6)];
  const c = file({ ...env, CITADEL_TEST_ROOM_WAIT: '600' }, 10);
  try {
    await until('it says it waits', () => existsSync(env.CITADEL_TEST_GATE_NOTE!));
    assert.ok(!existsSync(join(run, 'seen')), 'two run and the limit is two');
    free.shift()!();
    assert.equal(await c, 0);
  } finally {
    for (const f of free) f();
  }
});

test("a one-file run goes before a long run's remaining files, though they were in line first", async () => {
  const { env, run, dir } = setup(20);
  const base: NodeJS.ProcessEnv = { ...env, CITADEL_TEST_FILES: '1', CITADEL_TEST_FILES_MIN: '1', CITADEL_TEST_FILES_MAX: '1', CITADEL_TEST_ROOM_WAIT: '600' };
  const free = await holdPlace(dir, 0);
  const named = (e: NodeJS.ProcessEnv, name: string) => {
    const c = spawn(process.execPath, ['--import', gate, '-e', `require('fs').appendFileSync(${JSON.stringify(join(run, 'order'))}, '${name}\\n')`], { env: e, stdio: 'ignore' });
    return new Promise((r) => c.on('close', r));
  };
  const jobs: Promise<unknown>[] = [];
  let letGo: (() => void) | undefined = free;
  try {
    for (let i = 1; i <= 3; i++) {
      jobs.push(named(base, `long-${i}`));
      await until(`long-${i} in line`, () => inLine(dir).length === i);
    }
    jobs.push(named({ ...base, CITADEL_TEST_GATE_NOTE: `${base.CITADEL_TEST_GATE_NOTE}-short` }, 'short'));
    await until('the short run in line', () => inLine(dir).length === 4);
    letGo();
    letGo = undefined;
    await Promise.all(jobs);
  } finally {
    letGo?.();
  }
  assert.deepEqual(readFileSync(join(run, 'order'), 'utf8').trim().split('\n'), ['long-1', 'short', 'long-2', 'long-3']);
});

test("the wait's cap is the run's, not each file's: past it the run's later files start at once", async () => {
  const { env, run, dir } = setup(20);
  const one: NodeJS.ProcessEnv = { ...env, CITADEL_TEST_FILES: '1', CITADEL_TEST_FILES_MIN: '1', CITADEL_TEST_FILES_MAX: '1', CITADEL_TEST_ROOM_WAIT: '600' };
  const free = await holdPlace(dir, 0);
  try {
    writeFileSync(one.CITADEL_TEST_GATE_NOTE!, 'waiting for room\n');
    const past = new Date(Date.now() - 601_000);
    utimesSync(one.CITADEL_TEST_GATE_NOTE!, past, past); // the run's first wait was 601 s ago
    assert.equal(await file(one, 10), 0);
    assert.ok(existsSync(join(run, 'seen')), 'it ran with the place still held');
  } finally {
    free();
  }
});

test('an entry a killed waiter left in line holds nobody up, and is removed', async () => {
  const { env, dir } = setup(20);
  const left = join(dir, 'test-line', '000000-000000000000000-dead');
  mkdirSync(join(dir, 'test-line'), { recursive: true });
  writeFileSync(left, '');
  const past = new Date(Date.now() - 120_000);
  utimesSync(left, past, past);
  assert.equal(await file({ ...env, CITADEL_TEST_ROOM_WAIT: '600' }, 10), 0);
  assert.ok(!existsSync(left));
});
