import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARK, markExit, markStop, pingEvery, restartDetail, startWatchdog, stopEvent, takeMark, readStop } from '../src/sd-watchdog.ts';
import { Store } from '../src/db.ts';
import { until } from './wait.ts';

test('pings a quarter of the limit apart, at most 15 s, only for the process systemd watches', () => {
  const env = { NOTIFY_SOCKET: '/run/user/1000/systemd/notify', WATCHDOG_USEC: '60000000', WATCHDOG_PID: '42' };
  assert.equal(pingEvery(env, 42), 15_000);
  assert.equal(pingEvery({ ...env, WATCHDOG_USEC: '20000000' }, 42), 5_000);
  assert.equal(pingEvery({ ...env, WATCHDOG_USEC: '600000000' }, 42), 15_000);
  assert.equal(pingEvery({ ...env, WATCHDOG_PID: undefined }, 42), 15_000);
  assert.equal(pingEvery(env, 43), null, 'a child that inherited the variables');
  assert.equal(pingEvery({ ...env, NOTIFY_SOCKET: undefined }, 42), null);
  assert.equal(pingEvery({ ...env, WATCHDOG_USEC: undefined }, 42), null, 'no WatchdogSec');
});

test("takes systemd's variables out of the environment, so children can't ping for the server", () => {
  const sockets: string[] = [];
  const env: Record<string, string | undefined> = { NOTIFY_SOCKET: '@/notify', WATCHDOG_USEC: '60000000', WATCHDOG_PID: '7', HOME: '/h' };
  const w = startWatchdog(env, { pid: 7, log: () => {}, notify: (s, done) => (sockets.push(s), done(null)) });
  w!.stop();
  assert.deepEqual(sockets, ['@/notify'], 'pinged once at start, on the socket it was given');
  assert.deepEqual(env, { HOME: '/h' });
  const off: Record<string, string | undefined> = { NOTIFY_SOCKET: '@/notify' };
  assert.equal(startWatchdog(off, { pid: 7, log: () => {}, notify: () => assert.fail('pinged with no watchdog') }), null);
  assert.deepEqual(off, {});
});

test('the pings come from the event loop: none while it is held, and they resume after', async () => {
  const at: number[] = [];
  const env = { NOTIFY_SOCKET: '@/test', WATCHDOG_USEC: '400000' };
  const w = startWatchdog(env, { pid: 1, log: () => {}, notify: (_s, done) => (at.push(Date.now()), done(null)) })!;
  try {
    await until('three pings before the hang', () => at.length >= 3);
    const before = at.length;
    const from = Date.now();
    while (Date.now() < from + 1000); // a hang: synchronous work on the loop
    const during = at.length;
    await until('two pings after the hang', () => at.length >= during + 2);
    assert.ok(before >= 3, `pinged every 100 ms before: ${at}`);
    assert.ok(at.slice(before).every((t) => t >= from + 1000), `no ping while the loop was held: ${at}`);
  } finally {
    w.stop();
  }
});

test('each ping is a systemd-notify WATCHDOG=1 on the socket systemd gave', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-watchdog-'));
  const path = process.env.PATH;
  try {
    const log = join(dir, 'pings');
    // A stand-in systemd-notify on PATH: each ping is a line, with the socket it was sent to.
    writeFileSync(join(dir, 'systemd-notify'), `#!/bin/sh\necho "$NOTIFY_SOCKET $1" >> ${log}\n`);
    chmodSync(join(dir, 'systemd-notify'), 0o755);
    process.env.PATH = `${dir}:${path}`;
    const w = startWatchdog({ NOTIFY_SOCKET: '@/test', WATCHDOG_USEC: '60000000' }, { pid: 1, log: () => {} })!;
    w.stop();
    await until('the first ping', () => existsSync(log) && readFileSync(log, 'utf8'), 10_000);
    assert.equal(readFileSync(log, 'utf8'), '@/test WATCHDOG=1\n');
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a watchdog stop leaves a mark that the next boot takes once; other stops leave none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-watchdog-'));
  try {
    assert.equal(markExit({ SERVICE_RESULT: 'success' }, dir, 5), false);
    assert.equal(markExit({ SERVICE_RESULT: 'exit-code' }, dir, 5), false);
    assert.equal(takeMark(dir), null);
    assert.equal(markExit({ SERVICE_RESULT: 'watchdog' }, dir, 1234), true);
    assert.equal(takeMark(dir), 1234);
    assert.equal(takeMark(dir), null, 'counted once');
    writeFileSync(join(dir, MARK), 'not json');
    assert.equal(takeMark(dir), null);
    assert.equal(existsSync(join(dir, MARK)), false, 'a broken mark is removed too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the restart names the last stall recorded before it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-watchdog-'));
  const store = new Store(join(dir, 'c.db'));
  try {
    store.addHealthEvent('loop-lag', 1_000, null, 'The event loop was held for 3.0 s: old');
    store.addHealthEvent('loop-lag', 50_000, null, 'The event loop was held for 9.0 s: Running: 80% spin');
    store.addHealthEvent('server-5xx', 55_000, null, 'not a stall');
    store.addHealthEvent('loop-lag', 90_000, null, 'after the restart');
    const text = restartDetail(70_000, store.lastHealthEvent('loop-lag', 70_000));
    assert.match(text, /^systemd's watchdog restarted the server/);
    assert.match(text, /20 s earlier: The event loop was held for 9\.0 s: Running: 80% spin$/);
    assert.match(restartDetail(70_000, store.lastHealthEvent('loop-lag', 500)), /No stall was recorded before it\.$/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every stop leaves a mark of how systemd says it ended, read at the next boot and kept until the next stop (#1325)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-stop-'));
  try {
    assert.equal(readStop(dir), null);
    markStop({ SERVICE_RESULT: 'oom-kill', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' }, dir, 1234);
    assert.deepEqual(readStop(dir), { at: 1234, result: 'oom-kill', code: 'killed', status: 'KILL' });
    assert.equal(readStop(dir)?.at, 1234, 'kept: a boot killed before its row was written reads it again');
    markStop({ SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0' }, dir, 5678);
    assert.equal(readStop(dir)?.result, 'success', 'the next stop overwrites it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stopEvent names each cause from systemd\'s words; only a ship and a stop by hand are planned', () => {
  const m = (result: string, code: string, status: string) => ({ at: 5, result, code, status });
  const cause = (mark: ReturnType<typeof m> | null, newCode = false) => stopEvent(mark, newCode, 9).cause;
  assert.equal(cause(m('success', 'exited', '0'), true), 'deploy');
  assert.equal(cause(m('success', 'exited', '0')), 'by-hand');
  assert.equal(cause(m('signal', 'killed', 'TERM')), 'by-hand');
  assert.equal(cause(m('watchdog', 'killed', 'KILL'), true), 'watchdog', "systemd's result wins over new code");
  assert.equal(cause(m('oom-kill', 'killed', 'KILL'), true), 'out-of-memory');
  assert.equal(cause(m('signal', 'killed', 'KILL')), 'killed');
  assert.equal(cause(m('exit-code', 'exited', '1')), 'crash');
  assert.equal(cause(m('core-dump', 'dumped', 'SEGV')), 'crash');
  assert.deepEqual(stopEvent(null, false, 9), { at: 9, cause: 'unknown', detail: 'unknown: no stop was noted: the box restarted, or the stop hook (watchdog.conf) is not installed' });
  assert.equal(stopEvent(m('oom-kill', 'killed', 'KILL'), false, 9).detail, 'out-of-memory: killed for memory, by systemd-oomd or the kernel (systemd: oom-kill, killed, KILL)');
});
