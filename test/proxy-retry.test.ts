// The proxy and an app that restarts (#1173): a GET or HEAD asks again while the app refuses or drops it, a POST never
// does, and an asker who left is no 502 in the error digest.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { forward } from '../src/proxy.ts';
import { tempRoot, holds } from './helpers.ts';

const tmp = tempRoot('proxy-retry-');
after(() => tmp.teardown());

const portOf = (s: Server) => (s.address() as AddressInfo).port;
const listen = async (s: Server) => (await tmp.serve(s), s);
const close = (s: Server) => new Promise((ok) => (s.closeAllConnections(), s.close(ok)));

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
  // The app's port resets every connection until it is "up" at 600 ms (a port that is only closed could be handed to another test).
  const app = createServer((_req, res) => res.end('up'));
  let up = false;
  const gate = createNetServer((sock) => (up ? app.emit('connection', sock) : sock.destroy()));
  const appPort = await tmp.serve(gate);
  const { s, failed } = await front(appPort);
  setTimeout(() => (up = true), 600);
  try {
    assert.deepEqual(await ask(portOf(s)), { status: 200, text: 'up' });
    assert.deepEqual(failed, []);
  } finally {
    await close(s);
    app.closeAllConnections();
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
  const { s, failed } = await front(await tmp.down(), 400);
  try {
    const t = Date.now();
    assert.equal((await ask(portOf(s))).status, 502);
    assert.ok(Date.now() - t >= 400, 'it kept asking for the retry time');
    assert.deepEqual(failed, ['502 not answering: ECONNRESET']);
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
    // timing-ok: lets the request reach the app before the asker leaves; no signal from the front
    await new Promise((ok) => setTimeout(ok, 100));
    r.destroy();
    await holds('an asker who leaves is no 502', () => failed.length === 0, { ms: 400 });
    assert.deepEqual(failed, []);
  } finally {
    await close(s);
    await close(app);
  }
});

// A contraption's static files (#1394): gzipped when the browser accepts it, revalidated by ETag, and the app's own say kept.
async function files(app: Server, headers: Record<string, string>, path = '/x') {
  const s = await listen(createServer((req, res) => forward(req, res, portOf(app), path, { ...req.headers }, { what: 'App', files: true })));
  const got = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
    request({ port: portOf(s), host: '127.0.0.1', path: '/x', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d)).on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', fail).end();
  });
  await close(s);
  return got;
}
const big = 'function f() { return 1; }\n'.repeat(200);

test('a plain script is gzipped for a browser that accepts it, with an ETag and no-cache', async () => {
  const app = await listen(createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': Buffer.byteLength(big) }).end(big)));
  try {
    const r = await files(app, { 'accept-encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.match(String(r.headers['vary']), /Accept-Encoding/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.ok(r.headers['etag']);
    assert.equal((await import('node:zlib')).gunzipSync(r.body).toString(), big);
    assert.equal(r.headers['content-length'], String(r.body.length));
    assert.ok(r.body.length < big.length / 4);
    const again = await files(app, { 'accept-encoding': 'gzip', 'if-none-match': String(r.headers['etag']) });
    assert.equal(again.status, 304);
    assert.equal((await files(app, { 'accept-encoding': 'gzip', 'if-none-match': `"x", W/${r.headers['etag']}` })).status, 304);
    const plain = await files(app, {});
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), big);
  } finally {
    await close(app);
  }
});

test('an app that already compresses or sets its own cache headers keeps them; API replies and streams are left alone', async () => {
  const own = await listen(createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/css', 'content-length': Buffer.byteLength(big), 'cache-control': 'max-age=3600', etag: '"mine"' }).end(big)));
  const gz = await listen(createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'br', 'content-length': 3 }).end('abc')));
  const stream = await listen(createServer((_q, res) => (res.writeHead(200, { 'content-type': 'text/event-stream' }), res.write('data: 1\n\n'))));
  const noLen = await listen(createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.write(big); res.end(); }));
  try {
    const a = await files(own, { 'accept-encoding': 'gzip' });
    assert.equal(a.headers['cache-control'], 'max-age=3600');
    assert.match(String(a.headers['etag']), /mine/);
    assert.equal((await import('node:zlib')).gunzipSync(a.body).toString(), big);
    const b = await files(gz, { 'accept-encoding': 'gzip' });
    assert.equal(b.headers['content-encoding'], 'br');
    assert.equal(b.body.toString(), 'abc');
    const c = await new Promise<string>((ok) => request({ port: portOf(stream), host: '127.0.0.1', path: '/' }, (r) => ok(String(r.headers['content-type']))).end());
    assert.equal(c, 'text/event-stream');
    const d = await files(noLen, { 'accept-encoding': 'gzip' });
    assert.equal(d.headers['content-encoding'], undefined);
    assert.equal(d.body.toString(), big);
  } finally {
    for (const s of [own, gz, stream, noLen]) await close(s);
  }
});
