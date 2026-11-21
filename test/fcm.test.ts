// Push to contraptions' Android apps through Firebase (#1138, src/fcm.ts): the FCM message's exact shape, the send
// API's checks, dead tokens, the access token's cache, and the phones' registration at /apps/_citadel/push/<app>.
// Google is never called: unit tests hand Fcm a fake fetch, and the real server's test points at a local stub.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Fcm, fcmMessage, parsePush } from '../src/fcm.ts';
import { HttpError } from '../src/http.ts';
import { bootServer, tempRoot, type Booted } from './helpers.ts';

const tmp = tempRoot('fcm-');
const root = tmp.dir;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** A service account file like the Firebase console's, signing in at `tokenUri`. */
function account(dir: string, tokenUri: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'fcm-service-account.json');
  writeFileSync(path, JSON.stringify({ type: 'service_account', project_id: 'proj-1', client_email: 'push@proj-1.iam.gserviceaccount.com', private_key: PEM, token_uri: tokenUri }));
  chmodSync(path, 0o600);
  return path;
}

test('the FCM message is data-only: the app data, then citadel_* keys, all strings, priority HIGH', () => {
  const send = parsePush('mandate', { to: 'cara', title: 'Due', body: 'Pay rent', open: '/apps/mandate/items/4', tag: 'rent', data: { item: '4' } }).send;
  assert.deepEqual(fcmMessage('mandate', 'tok-1', send), {
    message: {
      token: 'tok-1',
      android: { priority: 'HIGH' },
      data: { item: '4', citadel_title: 'Due', citadel_body: 'Pay rent', citadel_open: '/apps/mandate/items/4', citadel_tag: 'rent', citadel_app: 'mandate' },
    },
  });
  // A title alone: body "", no open or tag.
  assert.deepEqual(fcmMessage('mandate', 't', parsePush('mandate', { to: ['cara'], title: 'Hi' }).send).message.data, { citadel_title: 'Hi', citadel_body: '', citadel_app: 'mandate' });
  // Silent app data: no citadel_title, so the shell shows nothing.
  assert.deepEqual(fcmMessage('mandate', 't', parsePush('mandate', { to: 'cara', data: { sync: '1' } }).send).message.data, { sync: '1', citadel_app: 'mandate' });
});

test('the send body is checked: recipients, lengths, the open path and data keys', () => {
  const bad = (b: unknown, re: RegExp) => assert.throws(() => parsePush('mandate', b), (e: any) => e instanceof HttpError && e.status === 400 && re.test(e.message), JSON.stringify(b));
  bad({ title: 'x' }, /to/);
  bad({ to: [], title: 'x' }, /to/);
  bad({ to: Array.from({ length: 101 }, (_, i) => `p${i}`), title: 'x' }, /to/);
  bad({ to: [3], title: 'x' }, /to/);
  bad({ to: 'cara' }, /title or data/);
  bad({ to: 'cara', data: {} }, /title or data/);
  bad({ to: 'cara', title: 'x'.repeat(201) }, /title/);
  bad({ to: 'cara', title: 'x', body: 'x'.repeat(2001) }, /body/);
  bad({ to: 'cara', title: 'x', tag: 'x'.repeat(101) }, /tag/);
  bad({ to: 'cara', title: 'x', open: '/apps/other/x' }, /open/);
  bad({ to: 'cara', title: 'x', open: '/apps/mandate' }, /open/);
  bad({ to: 'cara', title: 'x', open: '/apps/mandate/../other/' }, /open/);
  bad({ to: 'cara', title: 'x', open: '/apps/mandate/%2e%2e/other/' }, /open/);
  bad({ to: 'cara', title: 'x', open: `/apps/mandate/${'x'.repeat(1000)}` }, /open/);
  bad({ to: 'cara', data: { n: 1 } }, /data/);
  bad({ to: 'cara', data: ['a'] }, /data/);
  for (const key of ['citadel_title', 'citadel_x', 'from', 'notification', 'message_type', 'google.c.a', 'gcm.n.e']) bad({ to: 'cara', data: { [key]: 'v' } }, /data/);
  bad({ to: 'cara', data: { big: 'x'.repeat(4097) } }, /4 KB|4096/);
  // At the limits it passes; logins are deduplicated.
  const ok = parsePush('mandate', { to: ['cara', 'cara', 'josh'], title: 'x'.repeat(200), body: 'x'.repeat(2000), tag: 'x'.repeat(100), open: '/apps/mandate/', data: { k: 'x'.repeat(100) } });
  assert.deepEqual(ok.to, ['cara', 'josh']);
});

test('the access token is cached until a minute before it ends, and a dead token says so', async () => {
  const calls: { url: string; body: any; auth?: string }[] = [];
  let now = 1_000_000;
  let answer: { status: number; body: unknown } = { status: 200, body: { name: 'projects/proj-1/messages/1' } };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    if (url === 'https://oauth.test/token') {
      calls.push({ url, body: Object.fromEntries(new URLSearchParams(body)) });
      return new Response(JSON.stringify({ access_token: `at-${calls.length}`, expires_in: 3600 }), { status: 200 });
    }
    calls.push({ url, body: JSON.parse(body), auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const fcm = new Fcm(account(join(root, 'unit'), 'https://oauth.test/token'), { fetch: fakeFetch, clock: () => now });
  assert.equal(await fcm.send('t1', fcmMessage('a', 't1', { title: 'x' })), 'sent');
  assert.equal(await fcm.send('t2', fcmMessage('a', 't2', { title: 'x' })), 'sent');
  assert.deepEqual(calls.map((c) => c.url), ['https://oauth.test/token', 'https://fcm.googleapis.com/v1/projects/proj-1/messages:send', 'https://fcm.googleapis.com/v1/projects/proj-1/messages:send']);
  assert.equal(calls[0].body.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = JSON.parse(Buffer.from(calls[0].body.assertion.split('.')[1], 'base64url').toString());
  assert.deepEqual([claims.iss, claims.scope, claims.aud, claims.exp - claims.iat], ['push@proj-1.iam.gserviceaccount.com', 'https://www.googleapis.com/auth/firebase.messaging', 'https://oauth.test/token', 3600]);
  assert.equal(calls[1].auth, 'Bearer at-1');
  assert.equal(calls[2].auth, 'Bearer at-1');
  now += (3600 - 61) * 1000;
  await fcm.send('t3', fcmMessage('a', 't3', { title: 'x' }));
  assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 1, 'still cached 61 s before it ends');
  now += 2000;
  await fcm.send('t4', fcmMessage('a', 't4', { title: 'x' }));
  assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 2, 'renewed in its last minute');
  assert.equal(calls.at(-1)!.auth, 'Bearer at-5');

  answer = { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } };
  assert.equal(await fcm.send('t', fcmMessage('a', 't', { title: 'x' })), 'gone');
  answer = { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] }] } } };
  assert.equal(await fcm.send('t', fcmMessage('a', 't', { title: 'x' })), 'gone');
  // A 400 about something else, an outage or a refused key: the phone stays.
  answer = { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Message is too big', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.data' }] }] } } };
  assert.equal(await fcm.send('t', fcmMessage('a', 't', { title: 'x' })), 'failed');
  answer = { status: 503, body: { error: { status: 'UNAVAILABLE' } } };
  assert.equal(await fcm.send('t', fcmMessage('a', 't', { title: 'x' })), 'failed');
});

test('with no key file, Fcm says where it goes', () => {
  const fcm = new Fcm(join(root, 'none', 'fcm-service-account.json'), { fetch: (() => assert.fail('no fetch')) as typeof fetch });
  assert.throws(() => fcm.account(), (e: any) => e.status === 503 && e.message.includes(join(root, 'none', 'fcm-service-account.json')));
});

// ---- The real server: registration on both hosts, and the send API against a stub Firebase ----

const DOMAIN = 'apps.test';
const APP = `stub.${DOMAIN}`;
const home = join(root, 'home');
let srv: Booted;
let port = 0;
let key = '';
let cara = 0;

const sent: any[] = [];
let tokenCalls = 0;
/** What the stub Firebase answers a send to each token, by default 200. */
const fcmAnswers = new Map<string, { status: number; body: unknown }>();

const google = createServer((req: IncomingMessage, res) => {
  let text = '';
  req.on('data', (d) => (text += d));
  req.on('end', () => {
    if (req.url === '/token') {
      tokenCalls++;
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    }
    assert.equal(req.url, '/v1/projects/proj-1/messages:send');
    assert.equal(req.headers.authorization, 'Bearer at');
    const body = JSON.parse(text);
    sent.push(body);
    const a = fcmAnswers.get(body.message.token) ?? { status: 200, body: { name: 'm' } };
    res.writeHead(a.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(a.body));
  });
});

type Got = { status: number; body: any };
function ask(host: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Got> {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // Content-Length, as a phone sends it: node's client sends a DELETE's body without one, so the server would see none.
    const sized = data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) };
    const r = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...sized, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}
const citadel = () => `127.0.0.1:${port}`;
const pushApi = (body: unknown, bearer = key) => ask(citadel(), 'POST', '/api/contraptions/push', { Authorization: `Bearer ${bearer}` }, body);

before(async () => {
  const gPort = await tmp.serve(google);
  account(join(home, '.config', 'citadel-android'), `http://127.0.0.1:${gPort}/token`);
  srv = await bootServer({ root: join(root, 'srv'), env: { APPS_DOMAIN: DOMAIN, HOME: home, CITADEL_FCM_API: `http://127.0.0.1:${gPort}` } });
  port = Number(new URL(srv.base).port);
  const made = await srv.call('/api/contraptions', { name: 'stub', title: 'Stub', port: await tmp.down() });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  key = readFileSync(join(made.data.keys_dir, 'contraption.key'), 'utf8');
  assert.equal((await srv.call('/api/contraptions', { name: 'other', title: 'Other', port: await tmp.down() })).status, 201);
  cara = (await srv.call('/api/me')).data.id;
  assert.equal((await srv.call('/api/people', { name: 'Olive' })).data.person.login, 'olive');
  assert.equal((await srv.call(`/api/contraptions/stub/people/${cara}`, { enabled: true }, 'PUT')).status, 200);
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

/** A cc_app cookie for Cara on the stub's host, through the real handoff. */
async function appCookie(): Promise<Record<string, string>> {
  const header = (host: string, path: string, headers: Record<string, string>, name: string) => new Promise<string>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { Host: host, ...headers } }, (res) => (res.resume(), resolve(String(res.headers[name])))).on('error', reject).end();
  });
  const to = new URL(await header(citadel(), '/apps/stub/', { Accept: 'text/html', Cookie: srv.cookie }, 'location'));
  return { Cookie: (await header(APP, to.pathname + to.search, {}, 'set-cookie')).split(';')[0] };
}

test('a phone registers on the app host or on Citadel\'s, and only for a signed-in, enabled person', async () => {
  const app = await appCookie();
  const reg = '/apps/_citadel/push/stub';
  assert.equal((await ask(APP, 'POST', reg, {}, { token: 'phone-1', platform: 'android' })).status, 401, 'signed out');
  assert.equal((await ask(APP, 'POST', reg, app, { token: 'phone-1', platform: 'android' })).status, 204);
  assert.equal((await ask(citadel(), 'POST', reg, { Cookie: srv.cookie }, { token: 'phone-2', platform: 'android' })).status, 204, "on Citadel's host");
  assert.equal((await ask(APP, 'GET', reg, app)).status, 405, 'wrong method');
  assert.equal((await ask(APP, 'PUT', reg, app, { token: 'x' })).status, 405, 'wrong method');
  assert.equal((await ask(APP, 'POST', '/apps/_citadel/push/other', app, { token: 'x' })).status, 404, "another app, on this one's host");
  assert.equal((await ask(citadel(), 'POST', '/apps/_citadel/push/nope', { Cookie: srv.cookie }, { token: 'x' })).status, 404, 'unknown app');
  assert.equal((await ask(citadel(), 'POST', '/apps/_citadel/push/other', { Cookie: srv.cookie }, { token: 'x' })).status, 403, 'not enabled');
  assert.equal((await ask(APP, 'POST', reg, { ...app, Origin: 'http://evil.test' }, { token: 'x' })).status, 403, 'cross-origin');
  for (const body of [{}, { token: '' }, { token: 7 }, { token: 'x'.repeat(4097) }, { token: 'x', platform: 'ios' }]) {
    assert.equal((await ask(APP, 'POST', reg, app, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await ask(APP, 'POST', reg, app, { token: 'x'.repeat(4096), platform: 'android' })).status, 204, 'at the limit');
  assert.equal((await ask(APP, 'DELETE', reg, app, { token: 'x'.repeat(4096) })).status, 204);

  // Sent to both of Cara's phones; Olive (exists, not enabled) and a stranger are skipped.
  const r = await pushApi({ to: ['cara', 'olive', 'nobody'], title: 'Hello', data: { k: 'v' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { devices: 2, sent: 2, dropped: 0, skipped: ['olive', 'nobody'] });
  assert.deepEqual(sent.map((m) => m.message.token).sort(), ['phone-1', 'phone-2']);
  assert.deepEqual(sent[0], { message: { token: sent[0].message.token, android: { priority: 'HIGH' }, data: { k: 'v', citadel_title: 'Hello', citadel_body: '', citadel_app: 'stub' } } });
  assert.equal(tokenCalls, 1);

  // Forgotten, it gets nothing.
  assert.equal((await ask(APP, 'DELETE', reg, app, { token: 'phone-2' })).status, 204);
  sent.length = 0;
  assert.deepEqual((await pushApi({ to: 'cara', data: { s: '1' } })).body, { devices: 1, sent: 1, dropped: 0, skipped: [] });
  assert.deepEqual(sent.map((m) => m.message.token), ['phone-1']);
  assert.equal(tokenCalls, 1, 'the access token is reused');
});

test('re-registering a token moves it to the person and app now signed in', async () => {
  // phone-1 is Cara's for stub; registered again for other, it is other's alone.
  assert.equal((await srv.call(`/api/contraptions/other/people/${cara}`, { enabled: true }, 'PUT')).status, 200);
  assert.equal((await ask(citadel(), 'POST', '/apps/_citadel/push/other', { Cookie: srv.cookie }, { token: 'phone-1', platform: 'android' })).status, 204);
  sent.length = 0;
  assert.deepEqual((await pushApi({ to: 'cara', title: 'x' })).body, { devices: 0, sent: 0, dropped: 0, skipped: [] }, 'stub no longer reaches phone-1');
  assert.equal(sent.length, 0);
});

test('the send API: dead tokens are dropped, other failures kept, a bad body is 400, a bad key 401', async () => {
  const app = await appCookie();
  for (const token of ['live', 'dead', 'flaky']) assert.equal((await ask(APP, 'POST', '/apps/_citadel/push/stub', app, { token, platform: 'android' })).status, 204);
  fcmAnswers.set('dead', { status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } });
  fcmAnswers.set('flaky', { status: 500, body: { error: { status: 'INTERNAL' } } });
  assert.deepEqual((await pushApi({ to: 'cara', title: 'x', open: '/apps/stub/a', tag: 't' })).body, { devices: 3, sent: 1, dropped: 1, skipped: [] });
  assert.deepEqual((await pushApi({ to: 'cara', title: 'x' })).body, { devices: 2, sent: 1, dropped: 0, skipped: [] }, 'dead is gone, flaky stays');
  assert.equal((await pushApi({ to: 'cara', title: 'x', open: '/apps/other/a' })).status, 400);
  assert.equal((await pushApi({ to: 'cara', data: { citadel_app: 'other' } })).status, 400);
  assert.equal((await pushApi({ to: 'cara', title: 'x' }, 'ck_wrong')).status, 401);
});

test('without the key file the send API answers 503 naming where it goes', async () => {
  const bare = await bootServer({ root: join(root, 'bare'), env: { HOME: join(root, 'bare-home') } });
  try {
    const made = await bare.call('/api/contraptions', { name: 'stub', title: 'Stub', port: await tmp.down() });
    const k = readFileSync(join(made.data.keys_dir, 'contraption.key'), 'utf8');
    const res = await fetch(`${bare.base}/api/contraptions/push`, { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'cara', title: 'x' }) });
    assert.equal(res.status, 503);
    assert.ok((await res.json()).error.includes(join(root, 'bare-home', '.config/citadel-android/fcm-service-account.json')));
  } finally {
    await bare.stop();
  }
});
