import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARK, markExit, pingEvery, restartDetail, startWatchdog, takeMark } from '../src/sd-watchdog.ts';
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

test('a hung event loop stops the pings; they resume when it frees', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-watchdog-'));
  try {
    const log = join(dir, 'pings');
    // A stand-in systemd-notify on PATH: each ping is a line, with the socket it was sent to.
    writeFileSync(join(dir, 'systemd-notify'), `#!/bin/sh\necho "$NOTIFY_SOCKET $1 $(date +%s%3N)" >> ${log}\n`);
    chmodSync(join(dir, 'systemd-notify'), 0o755);
    const script = `import { startWatchdog } from ${JSON.stringify(new URL('../src/sd-watchdog.ts', import.meta.url).href)};
      startWatchdog(process.env, { log: () => {} });
      setInterval(() => {}, 1000);
      setTimeout(() => { const end = Date.now() + 1500; while (Date.now() < end); }, 600);`;
    // WATCHDOG_USEC 400 ms: a ping every 100 ms.
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NOTIFY_SOCKET: '@/test', WATCHDOG_USEC: '400000' },
      stdio: 'ignore',
    });
    try {
      await until('25 pings', () => existsSync(log) && readFileSync(log, 'utf8').split('\n').length > 25, 10_000);
    } finally {
      child.kill();
    }
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(lines.every((l) => l.startsWith('@/test WATCHDOG=1 ')), lines[0]);
    const at = lines.map((l) => Number(l.split(' ')[2]));
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    assert.ok(Math.max(...gaps) >= 1200, `the 1.5 s hang left a gap in the pings: ${gaps}`);
    assert.ok(gaps.filter((g) => g >= 1200).length === 1, `only the hang did: ${gaps}`);
  } finally {
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
