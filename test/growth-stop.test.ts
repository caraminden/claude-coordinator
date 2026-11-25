import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthStop, STOP, readTurnScopes, scopeTicket, type ScopeReading } from '../src/growth-stop.ts';

// The growth stop (#1748): while memory is tight, the fastest-growing host turn over 2 GB is held at its size, through
// `systemctl set-property --runtime MemoryHigh` (faked here); lifted when the box isn't tight. Nothing is stopped or killed.
const GB = 1024 ** 3;
const unit = (ticket: number) => `citadel-turn-ab12-${ticket}-1795000000000.scope`;

function rig() {
  let t = 1_800_000_000_000;
  const scopes = new Map<string, { current: number; high: number | null }>();
  const calls: string[] = [];
  const g = new GrowthStop({
    turnsDir: '/fake/citadel-turns.slice',
    now: () => t,
    log: () => {},
    read: async () => [...scopes].map(([u, s]): ScopeReading => ({ unit: u, ...s })),
    set: async (u, bytes) => {
      calls.push(`${u} MemoryHigh=${bytes ?? 'infinity'}`);
      const s = scopes.get(u);
      if (s) s.high = bytes;
    },
  });
  const size = (ticket: number, gb: number) => {
    const s = scopes.get(unit(ticket));
    if (s) s.current = gb * GB;
    else scopes.set(unit(ticket), { current: gb * GB, high: null });
  };
  return {
    g,
    calls,
    scopes,
    size,
    wait: (ms: number) => {
      t += ms;
    },
  };
}

test('tight: the turn over 2 GB that grew most is held at its size plus 256 MB; ok lifts it', async () => {
  const r = rig();
  r.size(1, 3);
  r.size(2, 5);
  r.size(3, 1);
  await r.g.tick('easing');
  r.wait(60_000);
  r.size(1, 6);
  r.size(2, 5.5);
  r.size(3, 1.9); // #1 grew 3 GB, #2 0.5, #3 is under 2 GB
  await r.g.tick('easing');
  assert.deepEqual(r.calls, [], 'easing holds no turn');
  await r.g.tick('tight');
  assert.deepEqual(r.calls, [`${unit(1)} MemoryHigh=${6 * GB + STOP.headroom}`]);
  assert.deepEqual(
    r.g.slowed().map((s) => [s.ticket, s.bytes]),
    [[1, 6 * GB + STOP.headroom]],
  );
  await r.g.tick('tight');
  assert.equal(r.calls.length, 1, 'at most one more a minute');
  r.wait(60_000);
  r.size(2, 7);
  await r.g.tick('tight');
  assert.equal(r.calls.at(-1), `${unit(2)} MemoryHigh=${7 * GB + STOP.headroom}`, 'a minute later the next grower');
  await r.g.tick('easing');
  assert.deepEqual(r.calls.slice(-2).sort(), [`${unit(1)} MemoryHigh=infinity`, `${unit(2)} MemoryHigh=infinity`]);
  assert.deepEqual(r.g.slowed(), []);
  assert.ok(
    r.calls.every((c) => /MemoryHigh=/.test(c)),
    'only MemoryHigh: no stop, kill or MemoryMax',
  );
});

test('a turn that is not growing, or is under 2 GB, is never held', async () => {
  const r = rig();
  r.size(1, 10);
  r.size(2, 1.5);
  await r.g.tick('tight');
  r.wait(60_000);
  r.size(2, 1.9);
  await r.g.tick('tight');
  assert.deepEqual(r.calls, []);
});

test('a lift that fails is tried again; a turn that ended is forgotten; stop lifts every hold', async () => {
  const r = rig();
  r.size(1, 3);
  await r.g.tick('tight');
  r.wait(60_000);
  r.size(1, 4);
  await r.g.tick('tight');
  assert.equal(r.g.slowed().length, 1);
  const set = (r.g as any).d.set;
  (r.g as any).d.set = async () => {
    throw new Error('bus down');
  };
  await r.g.tick('ok');
  assert.equal(r.g.slowed().length, 1, 'still held: lifted next reading');
  (r.g as any).d.set = set;
  await r.g.tick('ok');
  assert.equal(r.g.slowed().length, 0);

  r.wait(STOP.windowMs + 1);
  await r.g.tick('ok'); // #1's growth is out of the window now
  r.size(2, 3);
  r.wait(60_000);
  await r.g.tick('tight');
  r.wait(60_000);
  r.size(2, 5);
  await r.g.tick('tight');
  assert.equal(r.g.slowed().length, 1);
  await r.g.stop();
  assert.equal(r.calls.at(-1), `${unit(2)} MemoryHigh=infinity`);
  const n = rig();
  n.size(3, 3);
  n.wait(60_000);
  await n.g.tick('tight');
  n.size(3, 5);
  n.wait(60_000);
  await n.g.tick('tight');
  assert.deepEqual(
    n.g.slowed().map((x) => x.ticket),
    [3],
  );
  n.scopes.delete(unit(3));
  await n.g.tick('tight');
  assert.deepEqual(n.g.slowed(), [], 'the turn ended: nothing to show or lift');
});

test("a hold a restart left behind is lifted at the server's first reading", async () => {
  const r = rig();
  r.size(4, 3);
  r.scopes.get(unit(4))!.high = 3.2 * GB;
  await r.g.tick('ok');
  assert.deepEqual(r.calls, [`${unit(4)} MemoryHigh=infinity`]);
});

test('only turn scopes are read, so a Taskmaster or the server is never held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-slice-'));
  try {
    for (const [name, cur, high] of [
      [unit(5), '3221225472', 'max'],
      ['citadel-taskmaster-7.scope', '9000000000', 'max'],
      ['other.service', '9', 'max'],
      [unit(6), '100', '4000'],
    ]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'memory.current'), `${cur}\n`);
      writeFileSync(join(dir, name, 'memory.high'), `${high}\n`);
    }
    const got = (await readTurnScopes(dir)).sort((a, b) => a.unit.localeCompare(b.unit));
    assert.deepEqual(got, [
      { unit: unit(5), current: 3221225472, high: null },
      { unit: unit(6), current: 100, high: 4000 },
    ]);
    assert.equal(scopeTicket(unit(5)), 5);
    assert.equal(scopeTicket('citadel-taskmaster-7.scope'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('a hold and its lift run only set-property MemoryHigh: no stop, kill or MemoryMax', async (t) => {
  // The real setMemoryHigh, with a fake systemctl that records its arguments as the only one on PATH.
  const bin = mkdtempSync(join(tmpdir(), 'fake-systemctl-'));
  const log = join(bin, 'calls');
  const fake = `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`;
  writeFileSync(join(bin, 'systemctl'), fake, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = bin; // nothing else on it, so the real systemctl cannot be reached
  const kill = t.mock.method(process, 'kill', () => true);
  try {
    let now = 1_800_000_000_000;
    let current = 3 * GB;
    let high: number | null = null;
    const g = new GrowthStop({
      turnsDir: '/fake/citadel-turns.slice',
      now: () => now,
      log: () => {},
      read: async () => [{ unit: unit(7), current, high }],
    });
    await g.tick('tight');
    now += 60_000;
    current = 4 * GB;
    await g.tick('tight');
    high = 4 * GB + STOP.headroom; // what the next reading finds, or the hold counts as already lifted
    await g.tick('ok');
    const set = ['--user', 'set-property', '--runtime', unit(7)];
    assert.deepEqual(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
      [
        [...set, `MemoryHigh=${4 * GB + STOP.headroom}`],
        [...set, 'MemoryHigh=infinity'],
      ],
    );
    assert.equal(kill.mock.callCount(), 0, 'no signal sent');
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

test('a hold whose set was still running when the server stopped is lifted, and no reading after stop holds anyone', async () => {
  const r = rig();
  r.size(1, 3);
  await r.g.tick('tight');
  r.wait(60_000);
  r.size(1, 4);
  const real = (r.g as any).d.set;
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  (r.g as any).d.set = async (u: string, b: number | null) => {
    if (b !== null) await gate;
    return real(u, b);
  };
  const holding = r.g.tick('tight'); // blocks inside set, as a slow systemctl would
  const stopped = r.g.stop(); // nothing held yet to lift
  release();
  await Promise.all([holding, stopped]);
  assert.deepEqual(r.calls, [`${unit(1)} MemoryHigh=${4 * GB + STOP.headroom}`, `${unit(1)} MemoryHigh=infinity`]);
  assert.deepEqual(r.g.slowed(), []);
  r.wait(60_000);
  r.size(1, 6);
  await r.g.tick('tight');
  assert.equal(r.calls.length, 2, 'stopped: no new holds');
});
