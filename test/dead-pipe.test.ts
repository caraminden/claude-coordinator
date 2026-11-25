// #1965: a server whose stdout/stderr reader died must not spin at a full core logging that to the dead pipe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { listeningPort } from '../src/ports.ts';
import { until } from './wait.ts';
import { PASSWORD, REPO, SECRET, tempRoot, TEST_ZONE } from './helpers.ts';

/** utime+stime of `pid` in clock ticks. */
const cpu = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const parts = f.slice(f.lastIndexOf(')') + 2).split(' ');
  return Number(parts[11]) + Number(parts[12]);
};
const exited = (p: { exitCode: number | null; signalCode: string | null }) => p.exitCode !== null || p.signalCode !== null;

/** A server with piped stdio, whose read ends are closed, then made to write. */
async function deadPipeServer(exitWithParent: boolean) {
  const tmp = tempRoot('dead-pipe-');
  const proc = tmp.spawn(process.execPath, [join(REPO, 'server.ts')], {
    env: {
      ...process.env,
      MACHINES_URL: undefined,
      CITADEL_HOST_SIGNALS: 'fixed',
      CITADEL_ZONE: TEST_ZONE,
      CITADEL_EXIT_WITH_PARENT: exitWithParent ? '1' : undefined,
      TURN_POOL: '0',
      PORT: '0',
      DATA_DIR: join(tmp.dir, 'data'),
      CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(tmp.dir, 'claude'),
      COORDINATOR_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await listeningPort(proc);
  proc.stdout!.destroy();
  proc.stderr!.destroy();
  return { tmp, proc, port };
}

/** CPU ticks used over `ms` by `pid`. */
const burned = async (pid: number, ms: number) => {
  const before = cpu(pid);
  await sleep(ms);
  return cpu(pid) - before;
};

test('SIGTERM ends a server whose output pipes died (its handler logs, and that write is the first to fail)', { timeout: 60_000 }, async () => {
  const { tmp, proc } = await deadPipeServer(false);
  try {
    proc.kill('SIGTERM');
    await until(
      'the server to exit',
      () => exited(proc),
      undefined,
      () => `still running, ${cpu(proc.pid!)} ticks of CPU`,
    );
  } finally {
    proc.kill('SIGKILL');
    await tmp.teardown();
  }
});

test('a test server whose output pipes died exits by itself', { timeout: 60_000 }, async () => {
  const { tmp, proc } = await deadPipeServer(true);
  try {
    process.kill(proc.pid!, 'SIGHUP'); // reloads the front end and logs it: the first write to the dead pipe
    await until('the server to exit', () => exited(proc));
  } finally {
    proc.kill('SIGKILL');
    await tmp.teardown();
  }
});

test('a live-style server (no exit-with-parent) whose pipes died keeps serving and stays idle', { timeout: 60_000 }, async () => {
  const { tmp, proc, port } = await deadPipeServer(false);
  try {
    process.kill(proc.pid!, 'SIGHUP');
    await sleep(2000); // timing-ok: lets the reload's own work finish before CPU is measured
    assert.ok((await burned(proc.pid!, 1500)) < 50, 'under half a core over 1.5 s'); // 100 ticks a second
    assert.equal(exited(proc), false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally {
    proc.kill('SIGKILL');
    await tmp.teardown();
  }
});
