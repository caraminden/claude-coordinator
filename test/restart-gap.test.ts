import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, createServer as createHttpServer, request, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, freePort, tempRoot, testPins, until } from './helpers.ts';

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
  const closed = new Promise<string>((r) => server.once('close', (code, signal) => r(signal ? `killed by ${signal}` : `exit ${code}`)));
  server.kill('SIGTERM');
  await reading; // the stream ends rather than hanging on
  assert.equal(await closed, 'exit 0', readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
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

  const closed = new Promise<string>((r) => server.once('close', (code, signal) => r(signal ? `killed by ${signal}` : `exit ${code}`)));
  server.kill('SIGTERM');
  await Promise.all([streamEnded, wsClosed]);
  assert.equal(await closed, 'exit 0', readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  agent.destroy();
  // Exiting at once means server.close() finished; sitting out the grace logs how many connections it cut off.
  const out = readFileSync(log, 'utf8');
  assert.match(out, /SIGTERM: finishing requests/);
  assert.doesNotMatch(out, /still open after/, 'it sat out its grace period');
});

// Every event stream holds its connection until the exit cuts it, not only pages' /api/stream: an app's own stream
// through /apps/, a machine session, a contraption's event route. Before #1578 those sat out the whole 5 s grace on
// every restart ("exiting with N connection(s) still open after 5 s" on all 14 in the journal, Nov 21-22).
test('on SIGTERM the server exits at once despite an app event stream it proxies', async () => {
  const contraption = createHttpServer((req, res) => {
    if (req.url?.split('?')[0].endsWith('/events')) return void res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('data: hi\n\n');
    res.end('ok');
  });
  const contraptionPort = await tmp.serve(contraption);
  const log = join(mkdtempSync(join(root, 'log-')), 'server.log');
  const { base, cookie, call, proc: server } = await bootServer({ root: mkdtempSync(join(root, 'sse-')), log, env: { TURN_UNITS: '0' } });
  tmp.track(server);
  const made = await call('/api/contraptions', { name: 'stub', title: 'Stub', port: contraptionPort, open_paths: ['/events'] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const agent = new Agent({ keepAlive: true });
  const stream = await new Promise<IncomingMessage>((open, reject) => {
    const req = request(`${base}/apps/stub/events`, { agent, headers: { Cookie: cookie } }, open);
    req.on('error', reject);
    req.end();
  });
  assert.equal(stream.statusCode, 200);
  assert.match(String(stream.headers['content-type']), /text\/event-stream/);
  const first = new Promise((r) => stream.once('data', r));
  await first; // the app's stream is flowing through the server
  const streamGone = new Promise((r) => stream.on('end', r).on('error', r).on('close', r));

  const closed = new Promise<string>((r) => server.once('close', (code, signal) => r(signal ? `killed by ${signal}` : `exit ${code}`)));
  server.kill('SIGTERM');
  await streamGone;
  assert.equal(await closed, 'exit 0', readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  agent.destroy();
  const out = readFileSync(log, 'utf8');
  assert.match(out, /SIGTERM: finishing requests/);
  assert.doesNotMatch(out, /still open after/, 'it sat out its grace period');
});

// A reader thread (#1563) opens the database and builds the sign-in keys while it starts, and under load it was still
// at it when SIGTERM arrived. Terminating one then took the whole process down with it (V8's "Check failed:
// !is_null()", SIGTRAP), so the server died on a signal instead of exiting 0: what CI saw as `null !== 0` in the tests
// above, five times in two weeks (#1625). Here a reader stays mid-start until the test lets it go, after the stop.
test('on SIGTERM the server exits 0 while a reader thread is still starting', async () => {
  const dir = mkdtempSync(join(root, 'starting-'));
  const log = join(dir, 'server.log');
  const release = join(dir, 'reader-may-start');
  const { proc: server } = await bootServer({ root: dir, log, env: { TURN_UNITS: '0', CITADEL_READER_BOOT_WAIT: release } });
  tmp.track(server);
  const closed = new Promise<string>((r) => server.once('close', (code, signal) => r(signal ? `killed by ${signal}` : `exit ${code}`)));
  await until('a reader thread to be starting', () => readFileSync(log, 'utf8').includes('Reader test hook: starting slowly'));
  server.kill('SIGTERM');
  await until('the server to start exiting', () => readFileSync(log, 'utf8').includes('SIGTERM: finishing requests'));
  writeFileSync(release, ''); // the readers finish starting, and the exit waits for them
  assert.equal(await closed, 'exit 0', readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  assert.doesNotMatch(readFileSync(log, 'utf8'), /still open after/, 'it sat out its grace period');
});
