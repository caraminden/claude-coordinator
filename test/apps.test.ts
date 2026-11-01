// The /apps/<name>/ proxy (src/apps.ts, the brief's section 2), against a stub contraption that checks
// X-Citadel-Identity with the identity.pub Citadel wrote for it, as a real one does.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { isOpenPath } from '../src/apps.ts';
import { verifyIdentity } from '../src/contraptions.ts';
import { agentToken, bootServer, freePort, until, type Booted } from './helpers.ts';

let srv: Booted;
let pub = '';
/** What the stub saw, newest last: its path and headers, and the identity it verified (null when none or bad). */
const seen: { path: string; headers: IncomingHttpHeaders; identity: ReturnType<typeof verifyIdentity> }[] = [];
let release: (() => void) | null = null;
let stubPort = 0;

/** The stub contraption: answers with what it saw; /events streams, /cookie sets cookies; upgrades echo bytes. */
const stub = createServer((req: IncomingMessage, res: ServerResponse) => {
  const identity = verifyIdentity(req.headers['x-citadel-identity'] as string | undefined, pub, 'stub');
  seen.push({ path: req.url!, headers: req.headers, identity });
  const path = req.url!.split('?')[0];
  // A contraption refuses gated paths without a valid header.
  if (path !== '/apps/stub/link' && !identity) return void res.writeHead(401).end('no identity');
  if (path === '/apps/stub/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: one\n\n');
    release = () => res.end('data: two\n\n');
    return;
  }
  if (path === '/apps/stub/drop') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: one\n\n');
    return void setTimeout(() => res.socket!.destroy(), 100);
  }
  if (path === '/apps/stub/cookie') res.setHeader('Set-Cookie', ['cc_session=forged; Path=/', 'stub=1; Path=/apps/stub/']);
  let size = 0;
  req.on('data', (c) => (size += c.length));
  req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: req.url, size, sub: identity?.sub ?? null })));
});
stub.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
  const identity = verifyIdentity(req.headers['x-citadel-identity'] as string | undefined, pub, 'stub');
  seen.push({ path: req.url!, headers: req.headers, identity });
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.pipe(socket);
});

const forged = { 'X-Citadel-Identity': 'v1.e30.AAAA', 'X-Citadel-Whatever': 'yes' };
let cara = 0;
let olive = { id: 0, cookie: '' };
const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => fetch(srv.base + path, { redirect: 'manual', ...init, headers });
const asCara = (h: Record<string, string> = {}) => ({ Cookie: srv.cookie, ...h });
const enable = (id: number, enabled: boolean) => srv.call(`/api/contraptions/stub/people/${id}`, { enabled }, 'PUT');
const lastSeen = () => seen.at(-1)!;
/** Whether a stream ends (or fails) within ms, reading past whatever else arrives. */
const ends = async (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) => {
  const timeout = new Promise<'open'>((r) => setTimeout(() => r('open'), ms).unref());
  for (;;) {
    const r = await Promise.race([reader.read().then((x) => x.done, () => true), timeout]);
    if (r !== false) return r === true;
  }
};
const citadelHeaders = (h: IncomingHttpHeaders) => Object.keys(h).filter((k) => k.startsWith('x-citadel-') && k !== 'x-citadel-identity');

before(async () => {
  stubPort = await freePort();
  await new Promise<void>((r) => stub.listen(stubPort, '127.0.0.1', r));
  srv = await bootServer();
  const made = await srv.call('/api/contraptions', { name: 'stub', title: 'Stub & Co', port: stubPort, open_paths: ['/link'] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  pub = readFileSync(join(made.data.keys_dir, 'identity.pub'), 'utf8');
  cara = (await srv.call('/api/me')).data.id;
  const invited = await srv.call('/api/people', { name: 'Olive' });
  const res = await fetch(`${srv.base}/api/invite/${invited.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  olive = { id: invited.data.person.id, cookie: res.headers.get('set-cookie')!.split(';')[0] };
  assert.equal((await enable(cara, true)).status, 200);
});
after(async () => {
  await srv?.stop();
  stub.closeAllConnections();
  stub.close();
});

test('an enabled person reaches the contraption with a signed identity and none of the client\'s X-Citadel headers', async () => {
  const res = await get('/apps/stub/hello?q=1', asCara({ ...forged, Cookie: `${srv.cookie}; stub=7` }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: '/apps/stub/hello?q=1', size: 0, sub: cara });
  const s = lastSeen();
  assert.equal(s.identity?.app, 'stub');
  assert.equal(s.identity?.login, 'cara');
  assert.notEqual(s.headers['x-citadel-identity'], forged['X-Citadel-Identity']);
  assert.deepEqual(citadelHeaders(s.headers), []);
  assert.equal(s.headers.cookie, 'stub=7', 'Citadel\'s session cookie never reaches the contraption; its own does');
  // What a contraption does with a forged, foreign or expired header: refuse it.
  assert.equal(verifyIdentity(forged['X-Citadel-Identity'], pub, 'stub'), null);
  assert.equal(verifyIdentity(s.headers['x-citadel-identity'] as string, pub, 'other'), null);
  assert.equal(verifyIdentity(s.headers['x-citadel-identity'] as string, pub, 'stub', Date.now() + 61_000), null);
  const direct = await fetch(`http://127.0.0.1:${stubPort}/apps/stub/hello`, { headers: forged });
  assert.equal(direct.status, 401, 'a forged header sent straight to the stub is refused');
});

test('no session: a page goes to the login and back, anything else is refused, and the contraption sees neither', async () => {
  const n = seen.length;
  const page = await get('/apps/stub/notes/1?x=2', { Accept: 'text/html', ...forged });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), `/?next=${encodeURIComponent('/apps/stub/notes/1?x=2')}`);
  assert.equal((await get('/apps/stub/api/x', forged)).status, 401);
  assert.equal((await get('/apps/stub/api/x', { Authorization: `Bearer ${agentToken(srv.data, 1)}` })).status, 401, 'a minion\'s token is no person');
  assert.equal((await get('/apps/stub/linkage')).status, 401, 'only the open path itself and what is under it are open');
  assert.equal((await get('/apps/stub/link/..%2F..%2Fsecret')).status, 401);
  assert.equal(seen.length, n);
});

test('signed in but not enabled: a plain no-access page, and the contraption sees nothing', async () => {
  const n = seen.length;
  const res = await get('/apps/stub/', { Cookie: olive.cookie, Accept: 'text/html' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /You don&#39;t have access to Stub &#38; Co\./);
  assert.equal(seen.length, n);
});

test('an open path needs no login and carries no identity, forged or not', async () => {
  for (const path of ['/apps/stub/link', '/apps/stub/link/pair?code=1']) {
    const res = await get(path, forged);
    // The stub answers 401 under /link/ (not its device path), which shows the request got there.
    assert.ok(res.status === 200 || res.status === 401, `${path}: ${res.status}`);
    assert.equal(lastSeen().path, path);
    assert.equal(lastSeen().headers['x-citadel-identity'], undefined);
    assert.deepEqual(citadelHeaders(lastSeen().headers), []);
  }
  // An enabled person on an open path gets no identity either.
  await get('/apps/stub/link', asCara(forged));
  assert.equal(lastSeen().headers['x-citadel-identity'], undefined);
});

/** Ask the proxy to upgrade to a websocket: the status line, and on 101 an echo of what we write. */
function upgrade(path: string, headers: Record<string, string>): Promise<{ status: number; echo?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${srv.base}${path}`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('upgrade', (res, socket) => {
      socket.once('data', (d) => {
        resolve({ status: res.statusCode!, echo: d.toString() });
        socket.destroy();
      });
      socket.write('ping');
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode! });
    });
    req.on('error', reject);
    req.end();
  });
}

test('websockets: an open path upgrades without a login, a gated one only for an enabled person, and forged headers never arrive', async () => {
  assert.deepEqual(await upgrade('/apps/stub/link', forged), { status: 101, echo: 'ping' });
  assert.equal(lastSeen().headers['x-citadel-identity'], undefined);
  assert.deepEqual(citadelHeaders(lastSeen().headers), []);
  const n = seen.length;
  assert.deepEqual(await upgrade('/apps/stub/live', forged), { status: 401 });
  assert.deepEqual(await upgrade('/apps/stub/live', { Cookie: olive.cookie }), { status: 403 });
  assert.equal(seen.length, n);
  assert.deepEqual(await upgrade('/apps/stub/live', asCara(forged)), { status: 101, echo: 'ping' });
  assert.equal(lastSeen().identity?.sub, cara);
  assert.deepEqual(citadelHeaders(lastSeen().headers), []);
});

test('event streams arrive event by event', async () => {
  const res = await get('/apps/stub/events', asCara());
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: one\n\n', 'the first event arrives before the second is sent');
  release!();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: two\n\n');
});

test('a stream the contraption drops ends for the browser too, so it reconnects', async () => {
  const reader = (await get('/apps/stub/drop', asCara())).body!.getReader();
  await reader.read();
  assert.equal(await ends(reader, 3000), true);
});

test('bodies up to 20 MiB go through; bigger ones are refused', async () => {
  const ok = await get('/apps/stub/upload', asCara(), { method: 'POST', body: Buffer.alloc(20 * 1024 * 1024) });
  assert.equal((await ok.json()).size, 20 * 1024 * 1024);
  const n = seen.length;
  const big = await get('/apps/stub/upload', asCara(), { method: 'POST', body: Buffer.alloc(20 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  assert.equal(seen.length, n);
  // A streamed body says no length up front, so it is counted as it comes and cut off at the limit.
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream({ pull: (c) => (sent++ < 21 ? c.enqueue(chunk) : c.close()) });
  const streamed = await get('/apps/stub/upload', asCara(), { method: 'POST', body, duplex: 'half' } as RequestInit).catch((err) => err);
  assert.equal(streamed.status, 413, String(streamed));
});

test('a contraption can set its own cookies, never Citadel\'s session', async () => {
  const res = await get('/apps/stub/cookie', asCara());
  assert.deepEqual(res.headers.getSetCookie(), ['stub=1; Path=/apps/stub/']);
});

test('unknown contraptions are 404 and the bare name gets its slash', async () => {
  assert.equal((await get('/apps/nope/', asCara())).status, 404);
  const res = await get('/apps/stub?a=1', asCara());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/apps/stub/?a=1');
});

test('disabling someone refuses their next request and ends the streams and websockets they have open', async () => {
  const stream = await get('/apps/stub/events', asCara());
  const reader = stream.body!.getReader();
  await reader.read();
  const ws = await new Promise<Duplex>((resolve) => {
    const req = request(`${srv.base}/apps/stub/live`, { headers: { ...asCara(), Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (_res, socket) => resolve(socket));
    req.end();
  });
  let wsClosed = false;
  ws.on('close', () => (wsClosed = true));
  ws.on('error', () => {});
  assert.equal((await enable(cara, false)).status, 200);
  assert.equal((await get('/apps/stub/hello', asCara())).status, 403);
  assert.equal(await ends(reader, 10_000), true, 'the open stream ends');
  await until('the open websocket closes', () => wsClosed, 10_000);
  await enable(cara, true);
});

test('isOpenPath matches the path or under it, never an encoded way round it', () => {
  assert.equal(isOpenPath(['/link'], '/link'), true);
  assert.equal(isOpenPath(['/link'], '/link/x'), true);
  assert.equal(isOpenPath(['/link'], '/linkx'), false);
  assert.equal(isOpenPath(['/link'], '/link/%2e%2e/admin'), false);
  assert.equal(isOpenPath(['/link'], '/link\\..\\admin'), false);
  assert.equal(isOpenPath([], '/link'), false);
});
