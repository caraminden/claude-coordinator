import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { freePort, listeningPort } from '../src/ports.ts';

const child = (code: string) => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });

test('listeningPort reads the port from the listening line, past other output', async () => {
  const proc = child(`console.log('migrating'); console.log('Citadel listening on http://127.0.0.1:43210'); setTimeout(() => {}, 5000);`);
  try {
    assert.equal(await listeningPort(proc), 43210);
  } finally {
    proc.kill();
  }
});

test('listeningPort fails at once when the server exits first', async () => {
  const proc = child(`console.log('Citadel listening on http://127.0.0.1:0'); process.exit(3);`);
  await assert.rejects(listeningPort(proc), /exited during boot \(code 3\)/);
});

test('freePort picks outside the range the kernel hands to listen(0) and outgoing connections', async () => {
  const [low] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
  for (let i = 0; i < 20; i++) {
    const port = await freePort();
    assert.ok(port >= 10_000 && port < low, `${port} is below ${low}`);
    // And nothing holds it: it binds.
    const srv = createServer();
    await new Promise<void>((r, j) => srv.once('error', j).listen(port, '127.0.0.1', r));
    await new Promise((r) => srv.close(r));
  }
});
