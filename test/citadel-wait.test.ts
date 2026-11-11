import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/citadel-wait (#481): the one blocking command a minion waits with, since Claude Code refuses `sleep N; check`.
const bin = join(import.meta.dirname, '..', 'tools', 'citadel-wait');
const root = mkdtempSync(join(tmpdir(), 'citadel-wait-'));
after(() => rmSync(root, { recursive: true, force: true }));

function wait(args: string[], seconds = 20): Promise<{ code: number | null; err: string; ms: number }> {
  const start = Date.now();
  const child = spawn(bin, args, { env: { ...process.env, CITADEL_WAIT_SECONDS: String(seconds) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b) => (err += b));
  return new Promise((r) => child.on('close', (code) => r({ code, err, ms: Date.now() - start })));
}
const soon = (f: () => void) => setTimeout(f, 700);

test('pid: returns once the process has exited', async () => {
  const sleeper = spawn('sleep', ['30']);
  const waiting = wait(['pid', String(sleeper.pid)]);
  soon(() => sleeper.kill());
  const r = await waiting;
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms >= 600, 'it waited for the exit');
  assert.match(r.err, /done waiting for process/);
});

test('port: returns once something listens', async () => {
  const server = createServer();
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => probe.once('listening', r));
  const port = (probe.address() as any).port;
  await new Promise((r) => probe.close(r));
  const waiting = wait(['port', String(port)]);
  soon(() => server.listen(port, '127.0.0.1'));
  const r = await waiting;
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms >= 600, 'it waited for the listener');
});

test('file: returns once the file exists', async () => {
  const file = join(root, 'done');
  const waiting = wait(['file', file]);
  soon(() => writeFileSync(file, ''));
  const r = await waiting;
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms >= 600);
});

test('cmd: returns once the test succeeds', async () => {
  const flag = join(root, 'flag');
  const waiting = wait(['cmd', `grep -q ready '${flag}'`]);
  soon(() => writeFileSync(flag, 'ready\n'));
  const r = await waiting;
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms >= 600);
});

test('gives up with 124 and says so; bad usage is 2', async () => {
  const r = await wait(['cmd', 'false'], 1);
  assert.equal(r.code, 124);
  assert.match(r.err, /still waiting for `false` to succeed after \d+s; run it again/);
  assert.equal((await wait(['pid', 'abc'])).code, 2);
  assert.equal((await wait(['soon'])).code, 2);
});
