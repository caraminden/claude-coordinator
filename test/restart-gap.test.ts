import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, freePort, testPins } from './helpers.ts';

const { MCP_SERVER } = testPins();

// While the server restarts, a turn keeps running: its MCP calls wait for the next server, and the
// old one finishes what it can within a few seconds instead of dropping requests.
const root = mkdtempSync(join(tmpdir(), 'restart-gap-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

/** A thread's MCP server pointed at `port`, and a way to call its tools. */
function threadMcp(port: number) {
  const mcp = spawn(process.execPath, [MCP_SERVER], {
    env: { PATH: process.env.PATH, COORDINATOR_API: `http://127.0.0.1:${port}`, COORDINATOR_TOKEN: '7.sig', COORDINATOR_PROJECT: '2', COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: '7' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(mcp);
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (l) => {
    const r = JSON.parse(l);
    replies.get(r.id)?.(r);
  });
  let rid = 0;
  return (name: string, args: object): Promise<any> => {
    const id = ++rid;
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    return new Promise((r) => replies.set(id, (m) => r(m.result)));
  };
}

function listen(port: number, handler: Parameters<typeof createHttpServer>[0]): Promise<Server> {
  const api = createHttpServer(handler);
  return new Promise((r) => api.listen(port, '127.0.0.1', () => r(api)));
}

test('an MCP call made while the server is down goes through once the next one is up', async () => {
  const port = await freePort();
  const call = threadMcp(port);
  const result = call('set_thread_status', { note: 'still going' });
  await new Promise((r) => setTimeout(r, 1500));
  const seen: string[] = [];
  const api = await listen(port, (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume().on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
  });
  try {
    const r = await result;
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(seen.length, 1);
  } finally {
    api.close();
  }
});

test('a write cut off mid-request is not sent again, as it may have run', async () => {
  let seen = 0;
  const api = await listen(0, (req) => {
    seen++;
    req.socket.destroy();
  });
  try {
    const r = await threadMcp((api.address() as AddressInfo).port)('set_thread_status', { note: 'x' });
    assert.ok(r.isError);
    assert.equal(seen, 1);
  } finally {
    api.close();
  }
});

test('on SIGTERM the server ends its event streams and exits within the grace period', async () => {
  const { base, cookie, proc: server } = await bootServer({ root, env: { TURN_UNITS: '0' } });
  procs.push(server);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.interruptible, 0);
  const stream = await fetch(`${base}/api/stream`, { headers: { Cookie: cookie } });
  const reading = (async () => {
    for await (const _ of stream.body!);
  })();
  const started = Date.now();
  const exited = new Promise<number | null>((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await reading; // the stream ends rather than hanging on
  assert.equal(await exited, 0);
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
});
