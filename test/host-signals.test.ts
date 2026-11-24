// A server a test boots never reads the real box's signals (#1485): its CPU, memory and IO pressure, load, memory, CPU
// counters and cgroups, or the real Pacific clock for a day or an hour (#1536). A busy box paused a test server's indexers
// (#1301) and a test went red after midnight (#1421). src/host-signals.ts is the one place those are read, and
// CITADEL_HOST_SIGNALS=fixed (bootServer sets it) pins them: fixed readings, no cgroup, and its day and hour in the zone
// the test hands it (CITADEL_ZONE: TEST_ZONE, which the test's own fixtures use too).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { dayZone } from '../src/host-signals.ts';
import { bootServer, ok, tempRoot, TEST_ZONE, zoneDay } from './helpers.ts';
import { until } from './wait.ts';

test('a booted server reads no host signal, and its day and hour in the zone the test handed it', async () => {
  const tmp = tempRoot('host-signals-');
  const log = tmp.path('trap.log');
  const serverLog = tmp.path('server.log');
  try {
    const srv = await bootServer({ root: tmp.dir, log: serverLog, env: { NODE_OPTIONS: `--import=${join(import.meta.dirname, 'host-signal-trap.ts')}`, HOST_SIGNAL_TRAP: log } });
    try {
      // The status page's first host sample (memory, load, pressure, the CPU ledger) is taken at boot; the host-load page reads pressure.
      await until('the first host sample', async () => ok(await srv.call('/api/status')).citadel?.host?.latest);
      ok(await srv.call('/api/host-load'));
      await srv.settled();
    } finally {
      await srv.stop(); // the zone line is written as the server exits
    }
    const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    // An empty zone line means the server ended without its exit hook (a signal, a crash): say how, and what it printed last (03:34 on Nov 22).
    const ended = `the server ended with ${srv.proc.signalCode ? `signal ${srv.proc.signalCode}` : `exit code ${srv.proc.exitCode}`}; its last output:\n${(existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '').split('\n').slice(-30).join('\n')}`;
    assert.deepEqual(
      lines.filter((l) => !l.startsWith('zone ')),
      [],
      `reads that reached the real box (${ended})`,
    );
    assert.deepEqual(
      lines.filter((l) => l.startsWith('zone ')),
      [`zone ${TEST_ZONE}`],
      `the local clock runs in the zone the test handed over (${ended})`,
    );
  } finally {
    await tmp.teardown();
  }
});

test("the fixed zone keeps Pacific's date and an afternoon hour", () => {
  const at = (iso: string) => {
    const ms = Date.parse(iso),
      zone = dayZone(ms);
    return [zone, new Date(ms).toLocaleString('en-CA', { timeZone: zone, hourCycle: 'h23' })];
  };
  assert.deepEqual(at('2026-11-21T08:30:00Z'), ['Etc/GMT-4', '2026-11-21, 12:30:00'], '00:30 PST');
  assert.deepEqual(at('2026-11-21T20:00:00Z'), ['Etc/GMT+8', '2026-11-21, 12:00:00'], 'noon PST');
  assert.deepEqual(at('2026-11-22T07:45:00Z'), ['Etc/GMT+12', '2026-11-21, 19:45:00'], '23:45 PST: still the 21st');
  assert.deepEqual(at('2026-07-02T06:10:00Z'), ['Etc/GMT+12', '2026-07-01, 18:10:00'], '23:10 PDT');
  assert.deepEqual(at('2026-07-01T19:00:00Z'), ['Etc/GMT+7', '2026-07-01, 12:00:00'], 'noon PDT');
});

test('every hour of a Pacific day gets a zone that reads back under its own name, as the local clock does', () => {
  for (const [day, utcOffset] of [
    ['2026-11-21', '-08:00'],
    ['2026-07-01', '-07:00'],
  ]) {
    for (let h = 0; h < 24; h++) {
      const ms = Date.parse(`${day}T00:00:00${utcOffset}`) + h * 3_600_000 + 30 * 60_000;
      const zone = dayZone(ms);
      const read = spawnSync(process.execPath, ['-e', 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'], { env: { ...process.env, TZ: zone }, encoding: 'utf8' }).stdout.trim();
      assert.equal(read, zone, `${day} ${h}:30 Pacific`);
    }
  }
});

/** The whole-hour zone whose clock reads 00:xx at `ms`: just after its midnight. */
function midnightZone(ms: number): string {
  let ahead = (24 - new Date(ms).getUTCHours()) % 24; // hours ahead of UTC
  if (ahead > 14) ahead -= 24; // Etc runs from 12 behind to 14 ahead
  return ahead === 0 ? 'Etc/GMT' : `Etc/GMT${ahead > 0 ? '-' : '+'}${Math.abs(ahead)}`; // Etc's sign is POSIX's, the reverse of ISO's
}

test('a server booted just after midnight reads that day: restarts before it count yesterday, after it today', async () => {
  const tmp = tempRoot('midnight-');
  const now = Date.now();
  const zone = midnightZone(now);
  const midnight = now - (now % 3_600_000); // a whole-hour zone's midnight is the top of the UTC hour
  assert.equal(new Date(midnight).toLocaleString('en-CA', { timeZone: zone, hourCycle: 'h23' }).slice(-8), '00:00:00', zone);
  // Two restarts on the record: ten minutes before that midnight, and at it. The server's own boot adds a third, today.
  mkdirSync(join(tmp.dir, 'data'));
  const pre = new Store(join(tmp.dir, 'data', 'coordinator.db'));
  pre.addHealthEvent('boot', midnight - 10 * 60_000, null, 'before midnight');
  pre.addHealthEvent('boot', midnight, null, 'at midnight');
  pre.db.close();
  try {
    const srv = await bootServer({ root: tmp.dir, env: { CITADEL_ZONE: zone } });
    try {
      const status = ok(await srv.call('/api/status'));
      assert.deepEqual(status.days.slice(-2), [zoneDay(midnight - 60_000, zone), zoneDay(midnight, zone)], `the last two days in ${zone}`);
      assert.deepEqual(status.citadel.uptime.restarts.slice(-2), [1, 2], "yesterday's restart, then today's two (the one at midnight and this boot)");
      await srv.settled();
    } finally {
      await srv.stop();
    }
  } finally {
    await tmp.teardown();
  }
});
