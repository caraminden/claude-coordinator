import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { tempRoot } from './helpers.ts';

test('teardown waits for a tracked child to exit before it deletes the folder', async () => {
  const tmp = tempRoot();
  const child = tmp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.equal(child.exitCode, null);
  await tmp.teardown();
  assert.notEqual(child.exitCode ?? child.signalCode, null, 'the child had exited when teardown returned');
  assert.equal(existsSync(tmp.dir), false);
});

test('serve binds port 0 and teardown closes the server and its open connections', async () => {
  const tmp = tempRoot();
  const server = createServer((_req, res) => res.end('hi'));
  const port = await tmp.serve(server);
  assert.ok(port > 0);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hi');
  await tmp.teardown();
  assert.equal(server.listening, false);
});

test('down gives a port that never answers, and the folder is gone after teardown', async () => {
  const tmp = tempRoot();
  const port = await tmp.down();
  writeFileSync(tmp.path('f'), 'x');
  const outcome = await new Promise<string>((r) => {
    const s = connect(port, '127.0.0.1');
    s.on('data', () => r('data'));
    s.on('close', () => r('closed'));
    s.on('error', () => r('closed'));
  });
  assert.equal(outcome, 'closed');
  await tmp.teardown();
  assert.equal(existsSync(tmp.dir), false);
});
