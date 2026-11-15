// Contraptions on their own hosts (#709, docs/adr/0005-contraptions-on-subdomains.md): with APPS_DOMAIN set, each is
// served at <name>.<domain>, signed in through a one-time token from Citadel's host, and that host serves nothing of
// Citadel's. A real server with APPS_DOMAIN=apps.test, asked with Host headers, and a stub contraption behind it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { verifyIdentity } from '../src/contraptions.ts';
import { bootServer, freePort, type Booted } from './helpers.ts';

const DOMAIN = 'apps.test';
const APP = `stub.${DOMAIN}`;
let srv: Booted;
let port = 0;
let pub = '';
const seen: { path: string; headers: IncomingHttpHeaders; sub: string | null }[] = [];

const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const stub = createServer((req: IncomingMessage, res: ServerResponse) => {
  const identity = verifyIdentity(req.headers['x-citadel-identity'] as string | undefined, pub, 'stub');
  seen.push({ path: req.url!, headers: req.headers, sub: identity?.sub ?? null });
  const path = req.url!.split('?')[0];
  if (path === '/apps/stub/icon.svg') return void res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg);
  if (path !== '/apps/stub/link' && !identity) return void res.writeHead(401).end('no identity');
  if (path === '/apps/stub/cookie') res.setHeader('Set-Cookie', ['cc_session=forged; Path=/', 'cc_app=forged; Path=/', `wide=1; Domain=${DOMAIN}; Path=/`, 'stub=1; Path=/apps/stub/']);
  req.resume();
  req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: req.url, sub: identity?.sub ?? null })));
});
stub.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
  seen.push({ path: req.url!, headers: req.headers, sub: null });
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});

type Got = { status: number; headers: IncomingHttpHeaders; body: string };
/** A request to the server as host `host` (fetch can't set Host). */
function ask(host: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
/** The status line a websocket handshake gets, as host `host`. */
function upgrade(host: string, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    let got = '';
    s.on('data', (d) => {
      got += d;
      if (got.includes('\r\n')) {
        resolve(got.split('\r\n')[0]);
        s.destroy();
      }
    });
    s.on('error', reject);
  });
}

const page = { Accept: 'text/html' };
let citadel = '127.0.0.1';
let cara = '';
let olive = '';
/** A cc_app cookie for Cara on the stub's host, through the real handoff. */
async function enter(): Promise<string> {
  const moved = await ask(citadel, '/apps/stub/hello', { ...page, Cookie: cara });
  const to = new URL(moved.headers.location!);
  const got = await ask(APP, to.pathname + to.search);
  return got.headers['set-cookie']![0].split(';')[0];
}

before(async () => {
  const stubPort = await freePort();
  await new Promise<void>((r) => stub.listen(stubPort, '127.0.0.1', r));
  srv = await bootServer({ env: { APPS_DOMAIN: DOMAIN } });
  port = Number(new URL(srv.base).port);
  citadel = `127.0.0.1:${port}`;
  cara = srv.cookie;
  const made = await srv.call('/api/contraptions', { name: 'stub', title: 'Stub', port: stubPort, open_paths: ['/link'], icon: '/icon.svg' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  pub = readFileSync(join(made.data.keys_dir, 'identity.pub'), 'utf8');
  const me = (await srv.call('/api/me')).data.id;
  assert.equal((await srv.call(`/api/contraptions/stub/people/${me}`, { enabled: true }, 'PUT')).status, 200);
  const invited = await srv.call('/api/people', { name: 'Olive' });
  const res = await fetch(`${srv.base}/api/invite/${invited.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  olive = res.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  await srv?.stop();
  stub.closeAllConnections();
  stub.close();
});

test("on Citadel's host a contraption's page goes to its own host with a sign-in token; nothing reaches the contraption there", async () => {
  const before = seen.length;
  const got = await ask(citadel, '/apps/stub/hello?x=1', { ...page, Cookie: cara });
  assert.equal(got.status, 302);
  const to = new URL(got.headers.location!);
  assert.equal(to.origin, `http://${APP}`);
  assert.equal(to.pathname, '/_citadel/enter');
  assert.equal(to.searchParams.get('next'), '/apps/stub/hello?x=1');
  assert.ok(to.searchParams.get('t'));
  assert.equal(got.headers['referrer-policy'], 'no-referrer');
  assert.equal(got.headers['cache-control'], 'no-store');
  // Behind Caddy, over HTTPS.
  assert.match((await ask(citadel, '/apps/stub/', { ...page, Cookie: cara, 'X-Forwarded-Proto': 'https' })).headers.location!, new RegExp(`^https://${APP}/_citadel/enter\\?`));
  // Signed out: Citadel's login, then back here. Not enabled: no access. Not a page: told where it went.
  assert.equal((await ask(citadel, '/apps/stub/hello', page)).headers.location, '/c/?next=%2Fapps%2Fstub%2Fhello');
  assert.equal((await ask(citadel, '/apps/stub/hello', { ...page, Cookie: olive })).status, 403);
  const api = await ask(citadel, '/apps/stub/api', { Cookie: cara });
  assert.equal(api.status, 404);
  assert.match(api.body, new RegExp(`moved to http://${APP}/apps/stub/api`));
  assert.equal(await upgrade(citadel, '/apps/stub/ws', { Cookie: cara }), 'HTTP/1.1 404 Not Found');
  assert.equal(seen.length, before, 'the contraption saw none of it');
});

test("an open path still works on Citadel's host for what isn't a page (Peek Auras' PC link), with no login or identity", async () => {
  const before = seen.length;
  assert.equal(await upgrade(citadel, '/apps/stub/link', { Cookie: cara, 'X-Citadel-Identity': 'forged' }), 'HTTP/1.1 101 Switching Protocols');
  const last = seen.at(-1)!;
  assert.equal(seen.length, before + 1);
  assert.equal(last.headers.cookie, undefined);
  assert.equal(last.headers['x-citadel-identity'], undefined);
  // What it answers there can't open as a document on Citadel's origin (an <object> asks with Accept */*).
  const fetched = await ask(citadel, '/apps/stub/link', { Accept: '*/*' });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers['content-security-policy'], 'sandbox');
  assert.equal(fetched.headers['x-content-type-options'], 'nosniff');
  // Its page opens on its own host, with no sign-in, for someone it isn't enabled for too.
  assert.equal((await ask(citadel, '/apps/stub/link', page)).headers.location, `http://${APP}/apps/stub/link`);
  assert.equal((await ask(citadel, '/apps/stub/link', { ...page, Cookie: olive })).headers.location, `http://${APP}/apps/stub/link`);
  // On its own host the answer is the contraption's to shape.
  assert.equal((await ask(APP, '/apps/stub/link', { Accept: '*/*' })).headers['content-security-policy'], undefined);
});

test("the token signs in once, for this app's host only, and the host checks the cookie stuck before going on", async () => {
  const moved = await ask(citadel, '/apps/stub/hello', { ...page, Cookie: cara });
  const to = new URL(moved.headers.location!);
  // Not on another app's host (it has no such app, nor would the token fit it).
  assert.equal((await ask(`other.${DOMAIN}`, to.pathname + to.search)).status, 404);
  const got = await ask(APP, to.pathname + to.search);
  assert.equal(got.status, 302);
  assert.equal(got.headers.location, '/_citadel/entered?next=%2Fapps%2Fstub%2Fhello');
  const [cookie, ...more] = got.headers['set-cookie']!;
  assert.equal(more.length, 0);
  assert.match(cookie, /^cc_app=[^;]+; Path=\/; HttpOnly; Max-Age=15552000; SameSite=Lax$/);
  const jar = cookie.split(';')[0];
  assert.equal((await ask(APP, '/_citadel/entered?next=%2Fapps%2Fstub%2Fhello', { Cookie: jar })).headers.location, '/apps/stub/hello');
  // A browser that dropped the cookie gets told so, not a loop.
  const blocked = await ask(APP, '/_citadel/entered?next=%2Fapps%2Fstub%2Fhello');
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /blocked Stub&#39;s sign-in cookie/);
  // Spent: on to the page, no cookie.
  const again = await ask(APP, to.pathname + to.search);
  assert.equal(again.headers.location, '/apps/stub/hello');
  assert.equal(again.headers['set-cookie'], undefined);
  // next only ever names this app's own pages.
  for (const next of ['//evil.test/', 'https://evil.test/', '/apps/other/', '/apps/stub/\\evil', '/api/me']) {
    assert.equal((await ask(APP, `/_citadel/entered?next=${encodeURIComponent(next)}`, { Cookie: jar })).headers.location, '/apps/stub/', next);
  }
  // Over HTTPS the cookie works in Citadel's frame from either of its hosts.
  const secure = new URL((await ask(citadel, '/apps/stub/', { ...page, Cookie: cara, 'X-Forwarded-Proto': 'https' })).headers.location!);
  assert.match((await ask(APP, secure.pathname + secure.search, { 'X-Forwarded-Proto': 'https' })).headers['set-cookie']![0], /; SameSite=None; Secure; Partitioned$/);
});

test('signed in on its host, the contraption gets the identity and none of the login cookies, and sets none for Citadel or a wider domain', async () => {
  const jar = await enter();
  const got = await ask(APP, '/apps/stub/cookie', { Cookie: `${jar}; ${cara}; mine=1`, 'X-Citadel-Whatever': 'yes' });
  assert.equal(got.status, 200);
  assert.ok(JSON.parse(got.body).sub, 'signed identity');
  const last = seen.at(-1)!;
  assert.equal(last.headers.cookie, 'mine=1');
  assert.equal(last.headers['x-citadel-whatever'], undefined);
  assert.deepEqual(got.headers['set-cookie'], ['stub=1; Path=/apps/stub/']);
});

test("a contraption's host serves only that contraption: none of Citadel, nor another app, and Citadel's session is no use there", async () => {
  const jar = await enter();
  for (const path of ['/api/me', '/c/', '/c/app.js', '/backup', '/backup/messages', '/apps/other/', '/login', '/_citadel/nope']) {
    assert.equal((await ask(APP, path, { Cookie: `${jar}; ${cara}` })).status, 404, path);
  }
  assert.equal((await ask(APP, '/?a=1')).headers.location, '/apps/stub/?a=1');
  // Links on the contraption's page to Citadel or another app (Mandate's /c/#/p/5/t/12, /c/?next=), opened as pages, go to
  // Citadel's host, which shows them or sends them on; the contraption's server sees none of it.
  assert.equal((await ask(APP, '/c/?next=%2Fapps%2Fstub%2F', page)).headers.location, `http://${DOMAIN}/c/?next=%2Fapps%2Fstub%2F`);
  assert.equal((await ask(APP, '/apps/other/x?y=1', { ...page, Cookie: `${jar}; ${cara}` })).headers.location, `http://${DOMAIN}/apps/other/x?y=1`);
  assert.equal((await ask(APP, '/c/api/me', { Cookie: `${jar}; ${cara}` })).status, 404, 'a fetch is no page');
  assert.equal((await ask(APP, '/c/', { ...page, 'Upgrade': 'websocket' })).status, 404, 'nor an upgrade');
  assert.equal((await ask(`nope.${DOMAIN}`, '/apps/nope/', page)).status, 404);
  // Citadel's cookie alone: a page signs in through Citadel's host (its apex), anything else is refused.
  assert.equal((await ask(APP, '/apps/stub/hello', { ...page, Cookie: cara })).headers.location, `http://${DOMAIN}/apps/stub/hello`);
  assert.equal((await ask(APP, '/apps/stub/hello', { Cookie: cara })).status, 401);
  // Citadel UI's files are there, for the contraption's page.
  const rail = await ask(APP, '/apps/_citadel/rail.js');
  assert.equal(rail.status, 200);
  assert.match(rail.body, /export function railItems/);
});

test("a write or websocket from another origin is refused on a contraption's host; its own goes through", async () => {
  const jar = await enter();
  const json = { Cookie: jar, 'Content-Type': 'application/json' };
  assert.equal((await ask(APP, '/apps/stub/save', { ...json, Origin: 'http://evil.test' }, 'POST', '{}')).status, 403);
  assert.equal((await ask(APP, '/apps/stub/save', { ...json, Origin: `http://${DOMAIN}` }, 'POST', '{}')).status, 403, "Citadel's own host too");
  assert.equal((await ask(APP, '/apps/stub/save', { ...json, Origin: 'null' }, 'POST', '{}')).status, 403);
  assert.equal((await ask(APP, '/apps/stub/save', { ...json, Origin: `http://${APP}` }, 'POST', '{}')).status, 200);
  assert.equal((await ask(APP, '/apps/stub/save', json, 'POST', '{}')).status, 200, 'no Origin: not a browser page');
  assert.equal(await upgrade(APP, '/apps/stub/ws', { Cookie: jar, Origin: 'http://evil.test' }), 'HTTP/1.1 403 Forbidden');
  assert.equal(await upgrade(APP, '/apps/stub/ws', { Cookie: jar, Origin: `http://${APP}` }), 'HTTP/1.1 101 Switching Protocols');
});

test("Citadel's own writes refuse a contraption's host as their origin, even with Citadel's cookie (same site)", async () => {
  const got = await ask(citadel, '/api/me/order/apps', { Cookie: cara, 'Content-Type': 'application/json', Origin: `http://${APP}` }, 'PUT', '{"keys":[]}');
  assert.equal(got.status, 403);
  // /backup/send checks Origin the same way (src/backup.ts), past checks a test server has no Taskmaster for.
});

test("the rail's answers on a contraption's host: who you are, where Citadel is, your apps, and their icons fetched here", async () => {
  const jar = await enter();
  const mine = await ask(APP, '/apps/_citadel/api/mine', { Cookie: jar });
  assert.equal(mine.status, 200);
  assert.deepEqual(JSON.parse(mine.body), { name: 'Cara', citadel: `http://${DOMAIN}/c/`, apps: [{ name: 'stub', title: 'Stub', icon: '/icon.svg', up: true }] });
  assert.equal((await ask(APP, '/apps/_citadel/api/mine', { Cookie: cara })).status, 401, "Citadel's cookie is no use here");
  const icon = await ask(APP, '/apps/_citadel/icon/stub', { Cookie: jar });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/svg+xml');
  assert.match(icon.headers['content-security-policy']!, /^sandbox/);
  assert.equal(icon.headers['x-content-type-options'], 'nosniff');
  assert.equal((await ask(APP, '/apps/_citadel/icon/nope', { Cookie: jar })).status, 404);
  // On Citadel's host the same answers, with Citadel where it already is.
  assert.equal(JSON.parse((await ask(citadel, '/apps/_citadel/api/mine', { Cookie: cara })).body).citadel, null);
  assert.equal((await ask(citadel, '/apps/_citadel/icon/stub', { Cookie: olive })).status, 404, 'not enabled: no icon');
});

test("Citadel's page may frame its contraptions' hosts and be framed by them, and no other site", async () => {
  const got = await ask(citadel, '/c/', page);
  const csp = got.headers['content-security-policy']!;
  assert.match(csp, new RegExp(`frame-src 'self' \\*\\.${DOMAIN.replace('.', '\\.')}`));
  assert.match(csp, new RegExp(`frame-ancestors 'self' \\*\\.${DOMAIN.replace('.', '\\.')}`));
});
