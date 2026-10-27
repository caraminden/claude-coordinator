import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createECDH, createHmac, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// When the real server sends pushes: a stand-in push service (https, self-signed) records what
// arrives, and stand-in browsers decrypt it. A stand-in `claude -p` fails any turn whose message
// says "fail".
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'push-triggers-'));
const procs: ChildProcess[] = [];
const SECRET = 'x'.repeat(40);
after(() => {
  for (const p of procs) p.kill();
  pushService?.close();
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const fail = input.includes('fail');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: fail, result: fail ? 'API Error: overloaded' : 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

let base = '';
let pushBase = '';
let pushService: ReturnType<typeof createHttpsServer> | undefined;
const received: { path: string; body: Buffer }[] = [];
const cookies: Record<string, string> = {};

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  return port;
}

async function call(who: string, path: string, opts: { method?: string; body?: unknown } = {}) {
  const auth = who.startsWith('agent:') ? { Authorization: `Bearer ${who.slice(6)}.${createHmac('sha256', SECRET).update(`agent:${who.slice(6)}`).digest('base64url')}` } : { Cookie: cookies[who] };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const browsers: Record<string, { ecdh: ReturnType<typeof createECDH>; auth: string; endpoint: string }> = {};

function decrypt(name: string, body: Buffer) {
  const b = browsers[name];
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', b.ecdh.computeSecret(asPublic), Buffer.from(b.auth, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + body[20]);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).subarray(0, -1).toString());
}

/** Subscribe a stand-in browser for `who`; the push service answers 410 for names ending in "gone". */
async function subscribe(who: string, name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  browsers[name] = { ecdh, auth: randomBytes(16).toString('base64url'), endpoint: `${pushBase}/${name}` };
  return call(who, '/api/push/subscription', {
    method: 'PUT',
    body: { subscription: { endpoint: browsers[name].endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: browsers[name].auth } } },
  });
}

/** Pushes that arrived since `from`, as { browser: message }, once `count` have. */
async function pushes(from: number, count: number) {
  await until(`${count} pushes`, () => received.length >= from + count);
  await new Promise((r) => setTimeout(r, 200)); // and no more than that
  return Object.fromEntries(received.slice(from).map((r) => [r.path.slice(1), decrypt(r.path.slice(1), r.body)]));
}

before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' });
  pushService = createHttpsServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url!, body: Buffer.concat(chunks) });
      res.writeHead(req.url!.endsWith('gone') ? 410 : 201).end();
    });
  });
  await new Promise<void>((r) => pushService!.listen(0, '127.0.0.1', r));
  pushBase = `https://127.0.0.1:${(pushService.address() as any).port}`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: fakeClaude,
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: SECRET,
      // Trust the stand-in push service's self-signed certificate.
      NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(server);
  for (const name of ['Cara', 'Josh']) {
    const res = await until('the server', () => fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: 'test-password-123' }),
    }).catch(() => undefined));
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
  }
});

test('pushes go out for questions, results, blockers and failed turns, to everyone but whoever caused it', async () => {
  const project = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'P' } });
  const { coordinator } = await call('Cara', `/api/projects/${project.id}`);
  const t = await call('Cara', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'build it', title: 'Build it' } });
  await until('the first turn to end', async () => (await call('Cara', `/api/tickets/${t.id}`)).ticket.status === 'idle');

  assert.deepEqual(await subscribe('Cara', 'cara'), { subscribed: true, muted: [] });
  await subscribe('Josh', 'josh');
  await subscribe('Josh', 'josh-gone');
  const url = `/#/p/${project.id}/t/${t.number}`;

  // The thread asks a question: everyone.
  let n = received.length;
  await call(`agent:${t.id}`, `/api/tickets/${t.id}/questions`, { method: 'POST', body: { questions: [{ question: 'Tabs or list?', options: [{ label: 'Tabs' }, { label: 'List' }] }] } });
  let got = await pushes(n, 3);
  assert.deepEqual(got.cara, { title: '#1 Build it', body: 'Tabs or list?', tag: `thread-${t.id}`, url });
  assert.deepEqual(got.josh, got.cara);
  // The push service said Josh's old browser is gone, so it is forgotten.
  assert.deepEqual(await call('Josh', '/api/push/subscription', { method: 'POST', body: { endpoint: browsers['josh-gone'].endpoint } }), { subscribed: false, muted: [] });

  // The thread says it's ready: everyone. Josh marks it blocked by hand: only Cara.
  n = received.length;
  await call(`agent:${t.id}`, `/api/tickets/${t.id}`, { method: 'PATCH', body: { state: 'ready', note: 'PR open' } });
  assert.deepEqual(Object.keys(await pushes(n, 2)).sort(), ['cara', 'josh']);
  n = received.length;
  await call('Josh', `/api/tickets/${t.id}`, { method: 'PATCH', body: { state: 'blocked', note: 'needs a key' } });
  got = await pushes(n, 1);
  assert.deepEqual(Object.keys(got), ['cara']);
  assert.equal(got.cara.body, 'needs a key');

  // Parked, a note alone, and plain replies stay quiet.
  n = received.length;
  await call(`agent:${t.id}`, `/api/tickets/${t.id}`, { method: 'PATCH', body: { state: 'parked', note: 'later' } });
  await call('Cara', `/api/tickets/${t.id}/messages`, { method: 'POST', body: { text: 'thanks' } });
  await until('the turn to end', async () => (await call('Cara', `/api/tickets/${t.id}`)).ticket.status === 'idle');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, n);

  // A failed turn: everyone, with Claude's own words on what went wrong.
  await call('Cara', `/api/tickets/${t.id}/messages`, { method: 'POST', body: { text: 'please fail' } });
  got = await pushes(n, 2);
  assert.equal(got.josh.body, 'Turn failed: API Error: overloaded');

  // Josh mutes the project on his browser; the coordinator's question then reaches only Cara.
  assert.deepEqual(await call('Josh', '/api/push/subscription', { method: 'PATCH', body: { endpoint: browsers.josh.endpoint, projectId: project.id, muted: true } }),
    { subscribed: true, muted: [project.id] });
  n = received.length;
  await call(`agent:${coordinator.id}`, `/api/tickets/${coordinator.id}/questions`, { method: 'POST', body: { questions: [{ question: 'Which first?', options: [{ label: 'A' }, { label: 'B' }] }] } });
  got = await pushes(n, 1);
  assert.deepEqual(got.cara, { title: 'Coordinator · P', body: 'Which first?', tag: `thread-${coordinator.id}`, url: `/#/p/${project.id}` });
});

test('only people subscribe, and only https push services', async () => {
  await assert.rejects(call('agent:1', '/api/push/key'), /403/);
  await assert.rejects(call('Cara', '/api/push/subscription', { method: 'PUT', body: { subscription: { endpoint: 'http://127.0.0.1/x', keys: {} } } }), /400/);
  const { publicKey } = await call('Cara', '/api/push/key');
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  // Turning it off forgets the browser.
  await call('Cara', '/api/push/subscription', { method: 'DELETE', body: { endpoint: browsers.cara.endpoint } });
  assert.deepEqual(await call('Cara', '/api/push/subscription', { method: 'POST', body: { endpoint: browsers.cara.endpoint } }), { subscribed: false, muted: [] });
});
