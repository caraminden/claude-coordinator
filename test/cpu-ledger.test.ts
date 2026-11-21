// The CPU ledger (#1332): fake cgroup files in, the "CPU by source" table out; counters that restart; a reading's cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, cpuTable, cpuHours, type CpuLedger } from '../src/cpu-ledger.ts';

const UID = 1002;
function tree(use: Record<string, [number, number]>, proc = 'cpu  1000 0 400 8000 100 0 50 0\nprocesses 5000\n') {
  const root = mkdtempSync(join(tmpdir(), 'cg-'));
  for (const [rel, [u, s]] of Object.entries(use)) {
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, 'cpu.stat'), `usage_usec ${u}\nuser_usec ${u - s}\nsystem_usec ${s}\n`);
  }
  const procStat = join(root, 'stat');
  writeFileSync(procStat, proc);
  return { root, procStat };
}
const M = `user.slice/user-${UID}.slice/user@${UID}.service`;
const base = (k = 1): Record<string, [number, number]> => ({
  'user.slice': [100e6 * k, 20e6 * k], [`user.slice/user-${UID}.slice`]: [80e6 * k, 15e6 * k],
  [M]: [80e6 * k, 15e6 * k], [`${M}/citadel.slice`]: [60e6 * k, 10e6 * k],
  [`${M}/citadel.slice/claude-coordinator.service`]: [10e6 * k, 2e6 * k], [`${M}/citadel.slice/citadel-turns.slice`]: [30e6 * k, 6e6 * k],
  [`${M}/citadel.slice/citadel-claude-2.service`]: [8e6 * k, 1e6 * k], [`${M}/app.slice`]: [12e6 * k, 2e6 * k],
  [`${M}/app.slice/perigee-godot.service`]: [9e6 * k, 1e6 * k], [`${M}/contraptions.slice`]: [3e6 * k, 1e6 * k],
});

test('a reading names each source, splits the remainders and keeps other users as one total', async () => {
  const t = tree(base());
  const l = await readLedger({ ...t, uid: UID });
  assert.deepEqual(l.s.server, [10e6, 2e6]);
  assert.deepEqual(l.s['container:2'], [8e6, 1e6]);
  assert.deepEqual(l.s.godot, [9e6, 1e6]);
  assert.deepEqual(l.s.apps, [3e6, 1e6]); // app.slice less godot (no embed here)
  assert.deepEqual(l.s.others, [20e6, 5e6]);
  assert.deepEqual(l.s.mine, [17e6, 3e6]); // the manager's 5e6 nothing names, plus citadel.slice's 12e6 nothing names
  assert.deepEqual(l.h, [1450 * 10, 450 * 10, 1000, 5000]);
  assert.ok(!Object.keys(l.s).some((k) => /^\d+$/.test(k) || k.includes('user-')), 'no per-user names');
});

test('the table is the difference of two readings, per window, with kernel share and the host line', async () => {
  const a = await readLedger({ ...tree(base(1)), uid: UID });
  const b = await readLedger({ ...tree(base(2), 'cpu  2000 0 800 16000 200 0 100 0\nprocesses 8000\n'), uid: UID });
  const rows = [{ at: 0, cpu_ledger: JSON.stringify(a) }, { at: 300_000, cpu_ledger: JSON.stringify(b) }];
  const w = cpuTable(rows, 300_000, 3_600_000);
  assert.equal(w.seconds, 300);
  const turns = w.rows.find((r) => r.key === 'turns')!;
  assert.equal(turns.coreSeconds, 30); // 30e6 µs more
  assert.ok(Math.abs(turns.cores - 0.1) < 1e-9);
  assert.ok(Math.abs(turns.kernel - 0.2) < 1e-9);
  assert.equal(w.rows.find((r) => r.key === 'container:2')!.label, 'Container 2');
  assert.ok(Math.abs(w.host!.started - 10) < 1e-9); // 3000 processes in 300 s
  assert.ok(Math.abs(w.host!.busy - 14.5 / 300) < 1e-9);
  assert.equal(cpuHours(rows)[0].groups.turns, 30);
});

test('a counter that went down (a restart) counts from zero, and an old row without a ledger is skipped', () => {
  const l = (u: number): string => JSON.stringify({ v: 1, s: { server: [u, 0] }, h: null } satisfies CpuLedger);
  const w = cpuTable([{ at: 0, cpu_ledger: null }, { at: 1000, cpu_ledger: l(900e6) }, { at: 301_000, cpu_ledger: l(5e6) }], 301_000, 3_600_000);
  assert.equal(w.rows.find((r) => r.key === 'server')!.coreSeconds, 5);
  assert.equal(w.host, null);
});

test('a reading on this box costs under 50 ms of CPU and reads asynchronously', async () => {
  await readLedger();
  const before = process.cpuUsage();
  await Promise.all([readLedger(), readLedger(), readLedger(), readLedger(), readLedger()]);
  const used = process.cpuUsage(before);
  assert.ok((used.user + used.system) / 1000 / 5 < 50, `${(used.user + used.system) / 5000} ms a reading`);
});
