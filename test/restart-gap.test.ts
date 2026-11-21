import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { Agent, createServer as createHttpServer, request, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, freePort, tempRoot, testPins } from './helpers.ts';

const { MCP_SERVER } = testPins();

// While the server restarts, a turn keeps running: its MCP calls wait for the next server, and the
// old one finishes what it can within a few seconds instead of dropping requests.
const tmp = tempRoot('restart-gap-');
const root = tmp.dir;
after(() => tmp.teardown());

/** A thread's MCP server pointed at `port`, and a way to call its tools. */
function threadMcp(port: number) {
  const mcp = tmp.spawn(process.execPath, [MCP_SERVER], {
    env: { PATH: process.env.PATH, COORDINATOR_API: `http://127.0.0.1:${port}`, COORDINATOR_TOKEN: '7.sig', COORDINATOR_PROJECT: '2', COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: '7' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
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

async function listen(handler: Parameters<typeof createHttpServer>[0]): Promise<Server> {
  const api = createHttpServer(handler);
  await tmp.serve(api);
  return api;
}

test('an MCP call made while the server is down goes through once the next one is up', async () => {
  // Left on freePort on purpose: the MCP must see ECONNREFUSED (a refused connect is retried, a reset one is not, as the next test
  // shows), so the port has to be closed, not held by a listener that resets.
  const port = await freePort();
  const call = threadMcp(port);
  const result = call('set_thread_status', { note: 'still going' });
  // timing-ok: setup pacing only. If the box is slow and the server comes up first, the call just goes through on its first try; nothing asserts how long this took.
  await new Promise((r) => setTimeout(r, 700)); // the first try was refused and the retry (after 500 ms) is pending
  const seen: string[] = [];
  const api = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume().on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
  });
  await new Promise<void>((r) => api.listen(port, '127.0.0.1', r));
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
  const api = await listen((req) => {
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
  const log = join(mkdtempSync(join(root, 'log-')), 'server.log');
  const { base, cookie, proc: server } = await bootServer({ root, log, env: { TURN_UNITS: '0' } });
  tmp.track(server);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.interruptible, 0);
  const stream = await fetch(`${base}/api/stream`, { headers: { Cookie: cookie } });
  const reading = (async () => {
    for await (const _ of stream.body!);
  })();
  const closed = new Promise<number | null>((r) => server.once('close', r));
  server.kill('SIGTERM');
  await reading; // the stream ends rather than hanging on
  assert.equal(await closed, 0);
  // It left through server.close(), not by its grace timer, which logs how many connections it cut off.
  const out = readFileSync(log, 'utf8');
  assert.match(out, /SIGTERM: finishing requests/);
  assert.doesNotMatch(out, /still open after/, 'the grace period ran out');
});

// Requests made while the server restarts wait in systemd's socket for the next one, so every second the old
// one lingers is a second every click and page load stalls. It used to sit out its whole grace: a keep-alive
// connection (Caddy keeps its connections open) whose request was still running stayed open once answered,
// and a contraption's websocket never closes by itself (#493).
test('on SIGTERM the server exits at once despite keep-alive connections and open websockets', async () => {
  const contraption = createHttpServer((_req, res) => res.end('ok'));
  contraption.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  const contraptionPort = await tmp.serve(contraption);
  const log = join(mkdtempSync(join(root, 'log-')), 'server.log');
  const { base, cookie, call, proc: server } = await bootServer({ root: mkdtempSync(join(root, 'ws-')), log, env: { TURN_UNITS: '0' } });
  tmp.track(server);
  const made = await call('/api/contraptions', { name: 'stub', title: 'Stub', port: contraptionPort, open_paths: ['/ws'] });
  assert.equal(made.status, 201, JSON.stringify(made.data));

  const ws = await new Promise<Duplex>((resolve, reject) => {
    const req = request(`${base}/apps/stub/ws`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (_res, socket) => resolve(socket));
    req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
  const wsClosed = new Promise((r) => ws.on('close', r).on('error', () => {}));
  // Caddy's way: one kept-alive connection, here holding the event stream.
  const agent = new Agent({ keepAlive: true });
  const stream = await new Promise<IncomingMessage>((open, reject) => {
    const req = request(`${base}/api/stream`, { agent, headers: { Cookie: cookie } }, open);
    req.on('error', reject);
    req.end();
  });
  const streamEnded = new Promise((r) => stream.resume().on('end', r));

  const closed = new Promise<number | null>((r) => server.once('close', r));
  server.kill('SIGTERM');
  await Promise.all([streamEnded, wsClosed]);
  assert.equal(await closed, 0);
  agent.destroy();
  // Exiting at once means server.close() finished; sitting out the grace logs how many connections it cut off.
  const out = readFileSync(log, 'utf8');
  assert.match(out, /SIGTERM: finishing requests/);
  assert.doesNotMatch(out, /still open after/, 'it sat out its grace period');
});
