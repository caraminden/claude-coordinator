import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runnerSource } from './runner-files.ts';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPressure, MAX_CPU_PRESSURE, MAX_MEM_PRESSURE, RUN_ANYWAY_MS } from '../src/pressure.ts';

const psi = (avg60: number) => `some avg10=0.00 avg60=${avg60.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'psi-'));
  const cpuFile = join(dir, 'cpu'),
    memFile = join(dir, 'memory'),
    ioFile = join(dir, 'io');
  let t = 1_000_000;
  const logs: string[] = [];
  const p = createPressure({ cpuFile, memFile, ioFile, now: () => t, log: (l) => logs.push(l) });
  return {
    cpuFile,
    memFile,
    ioFile,
    p,
    logs,
    tick: (ms: number) => {
      t += ms;
    },
    dir,
  };
}

test('starved by CPU at the line, not below it', async () => {
  const s = setup();
  writeFileSync(s.cpuFile, psi(MAX_CPU_PRESSURE - 1));
  writeFileSync(s.memFile, psi(0));
  assert.equal((await s.p.read()).starved, false);
  s.tick(6000);
  writeFileSync(s.cpuFile, psi(MAX_CPU_PRESSURE));
  const r = await s.p.read();
  assert.equal(r.starved, true);
  assert.equal(r.why, 'CPU pressure 50%');
});

test('starved by memory', async () => {
  const s = setup();
  writeFileSync(s.cpuFile, psi(1));
  writeFileSync(s.memFile, psi(MAX_MEM_PRESSURE));
  const r = await s.p.read();
  assert.deepEqual([r.starved, r.mem, r.why], [true, 20, 'memory pressure 20%']);
});

test('IO pressure is read for the host samples (#1325) but never starves a pass', async () => {
  const s = setup();
  writeFileSync(s.cpuFile, psi(1));
  writeFileSync(s.memFile, psi(1));
  writeFileSync(s.ioFile, psi(95));
  const r = await s.p.read();
  assert.deepEqual([r.io, r.starved], [95, false]);
});

test('no PSI file: never starved', async () => {
  const s = setup();
  const r = await s.p.read();
  assert.deepEqual([r.cpu, r.mem, r.io, r.starved], [null, null, null, false]);
  assert.equal(await s.p.gate('memory index'), true);
});

test('the reading is cached for 5 s', async () => {
  const s = setup();
  writeFileSync(s.cpuFile, psi(1));
  writeFileSync(s.memFile, psi(1));
  await s.p.read();
  writeFileSync(s.cpuFile, psi(90));
  assert.equal((await s.p.read()).starved, false);
  s.tick(5000);
  assert.equal((await s.p.read()).starved, true);
});

test('a starved pass skips, logs once per stretch, and runs anyway after 10 minutes of skips', async () => {
  const s = setup();
  writeFileSync(s.cpuFile, psi(63));
  writeFileSync(s.memFile, psi(0));
  assert.equal(await s.p.gate('memory index'), false);
  for (let i = 0; i < 5; i++) {
    s.tick(60_000);
    assert.equal(await s.p.gate('memory index'), false);
  }
  assert.deepEqual(s.logs, ['memory index paused: CPU pressure 63%']);
  assert.equal(await s.p.gate('minion index'), false, 'each pass has its own count');
  s.tick(RUN_ANYWAY_MS - 5 * 60_000);
  assert.equal(await s.p.gate('memory index'), true, 'ten minutes in a row: run anyway');
  assert.equal(await s.p.gate('memory index'), false, 'then a fresh stretch');
  assert.equal(s.logs.length, 3);
  writeFileSync(s.cpuFile, psi(1));
  s.tick(6000);
  assert.equal(await s.p.gate('memory index'), true);
});

test('citadel-heavy and pressure.ts agree on the defaults', () => {
  const script = readFileSync(new URL('../tools/citadel-heavy', import.meta.url), 'utf8');
  assert.equal(Number(script.match(/max_pressure=\$\{CITADEL_HEAVY_MAX_PRESSURE:-(\d+)\}/)?.[1]), MAX_CPU_PRESSURE);
  // #1298 adds the memory line; until it ships here, the memory default is pinned to 20.
  const mem = script.match(/\$\{CITADEL_HEAVY_MAX_MEM_PRESSURE:-(\d+)\}/)?.[1];
  assert.equal(mem === undefined ? 20 : Number(mem), MAX_MEM_PRESSURE);
});

test("deploy.sh's starved-box hold and pressure.ts agree on the line (#1417)", () => {
  const script = readFileSync(new URL('../tools/deploy.sh', import.meta.url), 'utf8');
  assert.equal(Number(script.match(/MAX_CPU=\$\{CITADEL_HEAVY_MAX_PRESSURE:-(\d+)\}/)?.[1]), MAX_CPU_PRESSURE);
  assert.equal(Number(script.match(/MAX_MEM=\$\{CITADEL_HEAVY_MAX_MEM_PRESSURE:-(\d+)\}/)?.[1]), MAX_MEM_PRESSURE);
});

test('no turn start reads the pressure reader', () => {
  const src = runnerSource();
  assert.ok(!/pressure\.ts|\bpressure\.(read|gate)\b/.test(src), 'runner.ts and the files split out of it must not import or use the pressure reader');
});
