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
    turnsDir: '/fake/citadel-turns.slice', now: () => t, log: () => {},
    read: async () => [...scopes].map(([u, s]): ScopeReading => ({ unit: u, ...s })),
    set: async (u, bytes) => { calls.push(`${u} MemoryHigh=${bytes ?? 'infinity'}`); const s = scopes.get(u); if (s) s.high = bytes; },
  });
  const size = (ticket: number, gb: number) => { const s = scopes.get(unit(ticket)); if (s) s.current = gb * GB; else scopes.set(unit(ticket), { current: gb * GB, high: null }); };
  return { g, calls, scopes, size, wait: (ms: number) => { t += ms; } };
}

test('tight: the turn over 2 GB that grew most is held at its size plus 256 MB; ok lifts it', async () => {
  const r = rig();
  r.size(1, 3); r.size(2, 5); r.size(3, 1);
  await r.g.tick('easing');
  r.wait(60_000); r.size(1, 6); r.size(2, 5.5); r.size(3, 1.9); // #1 grew 3 GB, #2 0.5, #3 is under 2 GB
  await r.g.tick('easing');
  assert.deepEqual(r.calls, [], 'easing holds no turn');
  await r.g.tick('tight');
  assert.deepEqual(r.calls, [`${unit(1)} MemoryHigh=${6 * GB + STOP.headroom}`]);
  assert.deepEqual(r.g.slowed().map((s) => [s.ticket, s.bytes]), [[1, 6 * GB + STOP.headroom]]);
  await r.g.tick('tight');
  assert.equal(r.calls.length, 1, 'at most one more a minute');
  r.wait(60_000); r.size(2, 7);
  await r.g.tick('tight');
  assert.equal(r.calls.at(-1), `${unit(2)} MemoryHigh=${7 * GB + STOP.headroom}`, 'a minute later the next grower');
  await r.g.tick('easing');
  assert.deepEqual(r.calls.slice(-2).sort(), [`${unit(1)} MemoryHigh=infinity`, `${unit(2)} MemoryHigh=infinity`]);
  assert.deepEqual(r.g.slowed(), []);
  assert.ok(r.calls.every((c) => /MemoryHigh=/.test(c)), 'only MemoryHigh: no stop, kill or MemoryMax');
});

test('a turn that is not growing, or is under 2 GB, is never held', async () => {
  const r = rig();
  r.size(1, 10); r.size(2, 1.5);
  await r.g.tick('tight');
  r.wait(60_000); r.size(2, 1.9);
  await r.g.tick('tight');
  assert.deepEqual(r.calls, []);
});

test('a lift that fails is tried again; a turn that ended is forgotten; stop lifts every hold', async () => {
  const r = rig();
  r.size(1, 3); await r.g.tick('tight');
  r.wait(60_000); r.size(1, 4); await r.g.tick('tight');
  assert.equal(r.g.slowed().length, 1);
  const set = (r.g as any).d.set;
  (r.g as any).d.set = async () => { throw new Error('bus down'); };
  await r.g.tick('ok');
  assert.equal(r.g.slowed().length, 1, 'still held: lifted next reading');
  (r.g as any).d.set = set;
  await r.g.tick('ok');
  assert.equal(r.g.slowed().length, 0);

  r.wait(STOP.windowMs + 1); await r.g.tick('ok'); // #1's growth is out of the window now
  r.size(2, 3); r.wait(60_000); await r.g.tick('tight'); r.wait(60_000); r.size(2, 5); await r.g.tick('tight');
  assert.equal(r.g.slowed().length, 1);
  await r.g.stop();
  assert.equal(r.calls.at(-1), `${unit(2)} MemoryHigh=infinity`);
  r.scopes.clear();
  r.size(3, 3); r.wait(60_000); await r.g.tick('tight'); r.size(3, 5); r.wait(60_000); await r.g.tick('tight');
  assert.deepEqual(r.g.slowed().map((x) => x.ticket), [3]);
  r.scopes.delete(unit(3)); await r.g.tick('tight');
  assert.deepEqual(r.g.slowed(), [], 'the turn ended: nothing to show or lift');
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
    for (const [name, cur, high] of [[unit(5), '3221225472', 'max'], ['citadel-taskmaster-7.scope', '9000000000', 'max'], ['other.service', '9', 'max'], [unit(6), '100', '4000']]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'memory.current'), `${cur}\n`);
      writeFileSync(join(dir, name, 'memory.high'), `${high}\n`);
    }
    const got = (await readTurnScopes(dir)).sort((a, b) => a.unit.localeCompare(b.unit));
    assert.deepEqual(got, [{ unit: unit(5), current: 3221225472, high: null }, { unit: unit(6), current: 100, high: 4000 }]);
    assert.equal(scopeTicket(unit(5)), 5);
    assert.equal(scopeTicket('citadel-taskmaster-7.scope'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
  // And the server never calls anything but set-property MemoryHigh (no stop, kill or MemoryMax).
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'growth-stop.ts'), 'utf8');
  assert.doesNotMatch(src, /'(stop|kill)'|MemoryMax=|process\.kill/);
});
