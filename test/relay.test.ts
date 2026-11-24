// The relay between contraptions (src/relay.ts): Peek calls a stub Mandate for a person, through Citadel.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { verifyIdentity } from '../src/contraptions.ts';
import { bootServer, tempRoot, type Booted } from './helpers.ts';

const tmp = tempRoot('relay-');
let srv: Booted;
let mandatePub = '';
let peekKey = '';
let mandateKey = '';
let cara = 0;
let olive = 0;
const seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];

// The stub Mandate: /apps/mandate/app-api/teapot answers 418 with its own type; anything else echoes what it saw.
// Only relayed calls are recorded: Citadel also GETs an app's page to read its manifest and icons (server.ts's static-paths
// backfill, 20 s after boot), which would break an exact count or `seen.at(-1)` on a loaded box (#1666, as #1660).
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url!.startsWith('/apps/mandate/app-api/')) seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
    if (req.url!.startsWith('/apps/mandate/app-api/hang')) return;
    if (req.url!.startsWith('/apps/mandate/app-api/teapot')) return void res.writeHead(418, { 'Content-Type': 'application/vnd.teapot+json', 'X-Other': 'dropped' }).end('{"short":"and stout"}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
});

const relay = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, person = cara) =>
  fetch(`${srv.base}/api/contraptions/relay/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${peekKey}`, 'X-Citadel-Person': String(person), ...init.headers },
  });
const error = async (res: Response) => [res.status, (await res.json()).error];

before(async () => {
  const port = await tmp.serve(stub);
  srv = await bootServer({ env: { CITADEL_RELAY_TIMEOUT_MS: '400' } });
  const mandate = await srv.call('/api/contraptions', { name: 'mandate', title: 'Mandate', port, relay_paths: ['/app-api/'] });
  assert.equal(mandate.status, 201, JSON.stringify(mandate.data));
  assert.deepEqual(mandate.data.relay_paths, ['/app-api/']);
  const peek = await srv.call('/api/contraptions', { name: 'peek', title: 'Peek Auras', port: await tmp.down() });
  assert.deepEqual(peek.data.relay_paths, [], 'nothing is callable until a contraption opts in');
  mandatePub = readFileSync(join(mandate.data.keys_dir, 'identity.pub'), 'utf8');
  mandateKey = readFileSync(join(mandate.data.keys_dir, 'contraption.key'), 'utf8');
  peekKey = readFileSync(join(peek.data.keys_dir, 'contraption.key'), 'utf8');
  cara = (await srv.call('/api/me')).data.id;
  olive = (await srv.call('/api/people', { name: 'Olive' })).data.person.id;
  for (const [name, id] of [
    ['mandate', cara],
    ['peek', cara],
    ['mandate', olive],
  ] as const) {
    assert.equal((await srv.call(`/api/contraptions/${name}/people/${id}`, { enabled: true }, 'PUT')).status, 200);
  }
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

test('the target gets a fresh identity signed with its own key that names the caller, and nothing the caller forged', async () => {
  const n = seen.length;
  const res = await relay('mandate/app-api/items?due=today', {
    method: 'POST',
    body: '{"title":"Water the plants"}',
    headers: { 'Content-Type': 'application/json', 'X-Citadel-Identity': 'v1.e30.AAAA', 'X-Citadel-Whatever': 'yes', Cookie: 'mandate=1' },
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, n + 1);
  const s = seen.at(-1)!;
  assert.deepEqual([s.method, s.path, s.body], ['POST', '/apps/mandate/app-api/items?due=today', '{"title":"Water the plants"}']);
  assert.notEqual(s.headers['x-citadel-identity'], 'v1.e30.AAAA');
  assert.deepEqual(
    Object.keys(s.headers).filter((k) => k.startsWith('x-citadel-')),
    ['x-citadel-identity'],
  );
  assert.equal(s.headers.authorization, undefined, "the caller's key never reaches the target");
  assert.equal(s.headers.cookie, undefined);
  const claims = verifyIdentity(s.headers['x-citadel-identity'] as string, mandatePub, 'mandate');
  assert.ok(claims, "the header verifies with the target's identity.pub");
  assert.deepEqual([claims.sub, claims.login, claims.from, claims.fromTitle, claims.exp - claims.iat], [cara, 'cara', 'peek', 'Peek Auras', 60]);
});

test("the target's status, content type and body come back unchanged", async () => {
  const res = await relay('mandate/app-api/teapot', { method: 'DELETE' });
  assert.equal(res.status, 418);
  assert.equal(res.headers.get('content-type'), 'application/vnd.teapot+json');
  assert.equal(res.headers.get('x-other'), null);
  assert.equal(await res.text(), '{"short":"and stout"}');
});

test('refusals, in order: key, route, person, path, body', async () => {
  const n = seen.length;
  assert.equal((await relay('mandate/app-api/items', { headers: { Authorization: 'Bearer ck_nope' } })).status, 401);
  assert.deepEqual(await error(await relay('nobody/app-api/items')), [404, 'no_route']);
  assert.deepEqual(
    await error(
      await fetch(`${srv.base}/api/contraptions/relay/mandate/app-api/items`, {
        headers: { Authorization: `Bearer ${mandateKey}`, 'X-Citadel-Person': String(cara) },
      }),
    ),
    [404, 'no_route'],
    'not to itself',
  );
  assert.deepEqual(await error(await relay('mandate/app-api/items', {}, olive)), [403, 'not_enabled'], 'Olive has Mandate but not Peek');
  assert.deepEqual(await error(await relay('mandate/app-api/items', {}, 999)), [403, 'not_enabled']);
  assert.equal((await relay('mandate/app-api/items', { headers: { 'X-Citadel-Person': 'cara' } })).status, 400);
  for (const path of ['mandate/app-apis', 'mandate/settings', 'mandate/app-api%2f..%2fsettings', 'mandate/app-api/..%2Fsettings']) {
    assert.deepEqual(await error(await relay(path)), [404, 'no_route'], path);
  }
  const big = JSON.stringify({ text: 'x'.repeat(64 * 1024) });
  assert.equal((await relay('mandate/app-api/items', { method: 'PUT', body: big, headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.equal((await relay('mandate/app-api/items', { method: 'PUT', body: 'title=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  const getWithBody = await new Promise<number>((done, fail) => {
    const req = request(
      `${srv.base}/api/contraptions/relay/mandate/app-api/items`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${peekKey}`, 'X-Citadel-Person': String(cara), 'Content-Type': 'application/json', 'Content-Length': '2' },
      },
      (res) => done(res.resume().statusCode!),
    );
    req.on('error', fail).end('{}');
  });
  assert.equal(getWithBody, 400);
  const patch = await relay('mandate/app-api/items', { method: 'PATCH', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.ok(patch.status >= 400, 'only GET, PUT, POST and DELETE are relayed');
  assert.equal(seen.length, n, `none of these reached the target: ${JSON.stringify(seen.slice(n).map((s) => [s.method, s.path]))}`);
});

test('a relay through Caddy or from a browser is refused before the key is looked at', async () => {
  const n = seen.length;
  assert.equal((await relay('mandate/app-api/items', { headers: { 'X-Forwarded-For': '100.64.0.1' } })).status, 403);
  assert.equal((await relay('mandate/app-api/items', { headers: { Cookie: srv.cookie } })).status, 403);
  assert.equal(seen.length, n);
});

test('relay paths are edited like open paths', async () => {
  const edited = await srv.call('/api/contraptions/peek', { relay_paths: ['/mandate-hook'] }, 'PATCH');
  assert.deepEqual([edited.status, edited.data.relay_paths], [200, ['/mandate-hook']]);
  assert.equal((await srv.call('/api/contraptions/peek', { relay_paths: '/mandate-hook' }, 'PATCH')).status, 400);
  assert.equal((await srv.call('/api/contraptions/peek', { relay_paths: ['no-slash'] }, 'PATCH')).status, 400);
  assert.equal((await srv.call('/api/contraptions', { name: 'relay', title: 'Relay', port: 9999 })).status, 400, 'relay is a reserved name');
});

test('a target that is down is a 502, one that never answers a 504 once its timeout passes', { timeout: 30_000 }, async () => {
  assert.equal((await relay('mandate/app-api/hang')).status, 504);
  const down = await srv.call('/api/contraptions', { name: 'down', title: 'Down', port: await tmp.down(), relay_paths: ['/'] });
  assert.equal((await srv.call(`/api/contraptions/down/people/${cara}`, { enabled: true }, 'PUT')).status, 200);
  assert.equal(down.status, 201);
  assert.deepEqual(await error(await relay('down/anything')), [502, 'Down is not answering']);
});
