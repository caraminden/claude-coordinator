// The proxy and an app that restarts (#1173): a GET or HEAD asks again while the app refuses or drops it, a POST never
// does, and an asker who left is no 502 in the error digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { forward } from '../src/proxy.ts';

const portOf = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server, port = 0) => new Promise<Server>((ok) => s.listen(port, '127.0.0.1', () => ok(s)));
const close = (s: Server) => new Promise((ok) => (s.closeAllConnections(), s.close(ok)));

/** A free port nothing listens on (yet). */
async function freePort() {
  const s = await listen(createServer());
  const port = portOf(s);
  await close(s);
  return port;
}

/** Citadel's side: forwards to `appPort`, noting each failure it would put in the digest. */
async function front(appPort: number, retryMs = 2000) {
  const failed: string[] = [];
  const s = await listen(createServer((req, res) => forward(req, res, appPort, '/x', { ...req.headers }, { what: 'App', retryMs, failed: (st, note) => failed.push(`${st} ${note ?? ''}`) })));
  return { s, failed };
}

function ask(port: number, method = 'GET', body?: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((ok, fail) => {
    const r = request({ port, host: '127.0.0.1', method, path: '/x', headers: body ? { 'content-length': Buffer.byteLength(body) } : extra }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d)).on('end', () => ok({ status: res.statusCode ?? 0, text }));
    });
    r.on('error', fail);
    r.end(body);
  });
}

test('a GET asks again until a restarting app listens, and no 502 is recorded', async () => {
  const appPort = await freePort();
  const { s, failed } = await front(appPort);
  const app = createServer((_req, res) => res.end('up'));
  setTimeout(() => void listen(app, appPort), 600);
  try {
    assert.deepEqual(await ask(portOf(s)), { status: 200, text: 'up' });
    assert.deepEqual(failed, []);
  } finally {
    await close(s);
    await close(app);
  }
});

test('a GET the app drops mid-request (its stop) asks again', async () => {
  let n = 0;
  const app = await listen(createServer((req, res) => (++n === 1 ? req.socket.destroy() : res.end(`answer ${n}`))));
  const { s, failed } = await front(portOf(app));
  try {
    assert.deepEqual(await ask(portOf(s)), { status: 200, text: 'answer 2' });
    assert.deepEqual(failed, []);
  } finally {
    await close(s);
    await close(app);
  }
});

test('a HEAD saying Content-Length: 0 has no body, so it asks again too', async () => {
  let n = 0;
  const app = await listen(createServer((req, res) => (++n === 1 ? req.socket.destroy() : res.end())));
  const { s, failed } = await front(portOf(app));
  try {
    assert.equal((await ask(portOf(s), 'HEAD', undefined, { 'content-length': '0' })).status, 200);
    assert.equal(n, 2);
    assert.deepEqual(failed, []);
  } finally {
    await close(s);
    await close(app);
  }
});

test('a POST is never asked again: one try, then a 502 naming why', async () => {
  let posts = 0;
  const app = await listen(createServer((req) => (posts++, req.socket.destroy())));
  const { s, failed } = await front(portOf(app));
  try {
    const r = await ask(portOf(s), 'POST', '{"snap":1}');
    assert.equal(r.status, 502);
    assert.equal(posts, 1, 'the snap reached the app once');
    assert.deepEqual(failed, ['502 not answering: ECONNRESET']);
  } finally {
    await close(s);
    await close(app);
  }
});

test('an app that stays down still fails, once the retry time is up', async () => {
  const { s, failed } = await front(await freePort(), 400);
  try {
    const t = Date.now();
    assert.equal((await ask(portOf(s))).status, 502);
    assert.ok(Date.now() - t >= 400, 'it kept asking for the retry time');
    assert.deepEqual(failed, ['502 not answering: ECONNREFUSED']);
  } finally {
    await close(s);
  }
});

test('an asker who leaves before the app answers is no 502', async () => {
  const app = await listen(createServer((_req, res) => setTimeout(() => res.end('late'), 300)));
  const { s, failed } = await front(portOf(app));
  try {
    const r = request({ port: portOf(s), host: '127.0.0.1', path: '/x' });
    r.on('error', () => {});
    r.end();
    await new Promise((ok) => setTimeout(ok, 100));
    r.destroy();
    await new Promise((ok) => setTimeout(ok, 400));
    assert.deepEqual(failed, []);
  } finally {
    await close(s);
    await close(app);
  }
});
