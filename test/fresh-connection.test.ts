// A test's requests survive a stall in the test longer than its server's keep-alive (#235).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { listeningPort, stopProcs } from './helpers.ts';

test("a request after a synchronous stall past the server's keep-alive still gets its answer (#235)", async () => {
  // Drops an idle connection after 100 ms while telling the client it keeps it for 60 s, so the client's
  // own idle timer can't save it: only a request on a fresh connection does.
  const proc = spawn(
    process.execPath,
    [
      '-e',
      `
    const srv = require('node:http').createServer((req, res) => res.setHeader('Keep-Alive', 'timeout=60').end('ok'));
    srv.keepAliveTimeout = 100;
    srv.keepAliveTimeoutBuffer = 0;
    srv.listen(0, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + srv.address().port));
  `,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    const url = `http://127.0.0.1:${await listeningPort(proc)}/`;
    // Back-to-back requests leave fetch two idle connections, as a test's calls to its server do.
    for (let i = 0; i < 3; i++) assert.equal(await (await fetch(url)).text(), 'ok');
    // A synchronous step: this process can't see the server close the idle connections meanwhile.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    assert.equal(await (await fetch(url)).text(), 'ok');
  } finally {
    await stopProcs([proc]);
  }
});
