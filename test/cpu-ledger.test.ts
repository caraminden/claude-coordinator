// The CPU ledger (#1332): fake cgroup files in, the "CPU by source" table out; counters that restart; a reading's cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, ledgerSteps, cpuTable, cpuHours, type CpuLedger } from '../src/cpu-ledger.ts';

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
  'user.slice': [100e6 * k, 20e6 * k],
  [`user.slice/user-${UID}.slice`]: [80e6 * k, 15e6 * k],
  [M]: [80e6 * k, 15e6 * k],
  [`${M}/citadel.slice`]: [60e6 * k, 10e6 * k],
  [`${M}/citadel.slice/claude-coordinator.service`]: [10e6 * k, 2e6 * k],
  [`${M}/citadel.slice/citadel-turns.slice`]: [30e6 * k, 6e6 * k],
  [`${M}/citadel.slice/citadel-claude-2.service`]: [8e6 * k, 1e6 * k],
  [`${M}/app.slice`]: [12e6 * k, 2e6 * k],
  [`${M}/app.slice/perigee-godot.service`]: [9e6 * k, 1e6 * k],
  [`${M}/contraptions.slice`]: [3e6 * k, 1e6 * k],
});

test('a reading names each source and keeps raw totals; other users are one total', async () => {
  const l = await readLedger({ ...tree(base()), uid: UID });
  assert.deepEqual(l.s.server, [10e6, 2e6]);
  assert.deepEqual(l.s['container:2'], [8e6, 1e6]);
  assert.deepEqual(l.s.godot, [9e6, 1e6]);
  assert.deepEqual(l.s['t:citadel'], [60e6, 10e6]);
  assert.deepEqual(l.h, [1450 * 10, 450 * 10, 1000, 5000]);
  assert.ok(!Object.keys(l.s).some((k) => /^\d+$/.test(k) || k.includes('user-')), 'no per-user names');
});

test('the godot-ai bridges the server starts in app-godot.slice are a perigee-godot source of their own (#2179)', async () => {
  const t = tree({ ...base(), [`${M}/app.slice/app-godot.slice`]: [2e6, 1e6] });
  try {
    const l = await readLedger({ ...t, uid: UID });
    assert.deepEqual(l.s.godot, [9e6, 1e6]);
    assert.deepEqual(l.s['godot-mcp'], [2e6, 1e6]);
  } finally {
    rmSync(t.root, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('the remainders come from each step: the rest of the account, other apps and other users', async () => {
  const a = await readLedger({ ...tree(base(1)), uid: UID });
  const b = await readLedger({ ...tree(base(2)), uid: UID });
  const w = cpuTable(
    ledgerSteps([
      { at: 0, cpu_ledger: JSON.stringify(a) },
      { at: 300_000, cpu_ledger: JSON.stringify(b) },
    ]),
    300_000,
    3_600_000,
  );
  const sec = (k: string) => w.rows.find((r) => r.key === k)!.coreSeconds;
  assert.equal(sec('mine'), 5); // the manager's own
  assert.equal(sec('citadel-other'), 12); // citadel.slice's unnamed (an ended container lands here)
  assert.equal(sec('apps'), 3); // app.slice less godot
  assert.equal(sec('others'), 20);
});

test('a restarted named unit does not show as a burst in the remainders', async () => {
  const a = await readLedger({ ...tree(base(1)), uid: UID });
  const after = base(1);
  after[`${M}/citadel.slice/claude-coordinator.service`] = [1e6, 0]; // the server restarted: its own counter fell
  const b = await readLedger({ ...tree(after), uid: UID });
  const w = cpuTable(
    ledgerSteps([
      { at: 0, cpu_ledger: JSON.stringify(a) },
      { at: 300_000, cpu_ledger: JSON.stringify(b) },
    ]),
    300_000,
    3_600_000,
  );
  assert.equal(w.rows.find((r) => r.key === 'mine')?.coreSeconds ?? 0, 0);
  assert.equal(w.rows.find((r) => r.key === 'citadel-other')?.coreSeconds ?? 0, 0);
});

test('the table is the difference of two readings, per window, with kernel share and the host line', async () => {
  const a = await readLedger({ ...tree(base(1)), uid: UID });
  const b = await readLedger({ ...tree(base(2), 'cpu  2000 0 800 16000 200 0 100 0\nprocesses 8000\n'), uid: UID });
  const rows = [
    { at: 0, cpu_ledger: JSON.stringify(a) },
    { at: 300_000, cpu_ledger: JSON.stringify(b) },
  ];
  const w = cpuTable(ledgerSteps(rows), 300_000, 3_600_000);
  assert.equal(w.seconds, 300);
  const turns = w.rows.find((r) => r.key === 'turns')!;
  assert.equal(turns.coreSeconds, 30); // 30e6 µs more
  assert.ok(Math.abs(turns.cores - 0.1) < 1e-9);
  assert.ok(Math.abs(turns.kernel - 0.2) < 1e-9);
  assert.equal(w.rows.find((r) => r.key === 'container:2')!.label, 'Container 2');
  assert.ok(Math.abs(w.host!.started - 10) < 1e-9); // 3000 processes in 300 s
  assert.ok(Math.abs(w.host!.busy - 14.5 / 300) < 1e-9);
  assert.equal(cpuHours(ledgerSteps(rows))[0].groups.turns, 30);
});

test('a counter that went down (a restart) counts from zero, and an old row without a ledger is skipped', () => {
  const l = (u: number): string => JSON.stringify({ v: 1, s: { server: [u, 0] }, h: null } satisfies CpuLedger);
  const w = cpuTable(
    ledgerSteps([
      { at: 0, cpu_ledger: null },
      { at: 1000, cpu_ledger: l(900e6) },
      { at: 301_000, cpu_ledger: l(5e6) },
    ]),
    301_000,
    3_600_000,
  );
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
