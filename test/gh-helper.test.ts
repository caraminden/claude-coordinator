// GitHub reads through a helper per login that stays up (#1542): no `gh` per read, each read as its own login,
// and gh again whenever the helper isn't there.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GhHelpers } from '../src/gh-api.ts';
import { until } from './wait.ts';

// /tmp, not TMPDIR: a unix socket's path must fit in 107 bytes.
const root = mkdtempSync('/tmp/ghh-');
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const github = createServer((req, res) => {
  seen.push({ url: req.url!, headers: req.headers });
  if (req.url!.includes('boom')) return req.socket.destroy(); // GitHub unreachable mid-read
  if (req.url!.includes('gone')) return res.writeHead(401).end('{"message":"Bad credentials"}');
  if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304, { etag: '"v1"' }).end();
  res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' }).end(JSON.stringify({ path: req.url, n: seen.length }));
});
await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
const helpers: GhHelpers[] = [];
after(() => {
  for (const h of helpers) h.stop();
  github.close();
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

function make(idleMs?: number) {
  const h = new GhHelpers();
  h.dir = join(root, `run-${helpers.length}`);
  h.api = api;
  h.idleMs = idleMs;
  helpers.push(h);
  return h;
}
/** Read until the helper answers (the first reads go through gh while it starts). */
const helped = (h: GhHelpers, path: string, etag: string | null, as: Record<string, string>) => until('the helper to answer', () => h.get(path, etag, as));
const live = (h: GhHelpers) => [...(h as any).live.values()] as { proc: import('node:child_process').ChildProcess; socket: string; nonce: string }[];

test('no run folder set: every read goes through gh, and nothing starts', async () => {
  const h = new GhHelpers();
  assert.equal(await h.get('repos/a/b', null, { GH_TOKEN: 'tok-a' }), null);
  assert.equal(live(h).length, 0);
});

test("a read starts the login's helper without waiting for it; later reads come from it, as that login, with the etag", async () => {
  const h = make();
  assert.equal(await h.get('repos/a/b/actions/runs?per_page=5', null, { GH_TOKEN: 'tok-a' }), null, 'the first read goes through gh');
  const a = await helped(h, 'repos/a/b/actions/runs?per_page=5', null, { GH_TOKEN: 'tok-a' });
  assert.equal(a.status, 200);
  assert.equal(a.etag, '"v1"');
  assert.equal((a.body as { path: string }).path, '/repos/a/b/actions/runs?per_page=5');
  assert.equal(seen.at(-1)!.headers.authorization, 'token tok-a');
  const again = await h.get('repos/a/b', '"v1"', { GH_TOKEN: 'tok-a' });
  assert.deepEqual(again, { status: 304, etag: '"v1"', body: null });
  assert.equal(live(h).length, 1, 'one helper for the login');
});

test('two logins get two helpers, and each read reaches GitHub as its own login', async () => {
  const h = make();
  await helped(h, 'x', null, { GH_TOKEN: 'tok-a' });
  await helped(h, 'y', null, { GH_TOKEN: 'tok-b' });
  assert.equal(live(h).length, 2);
  await h.get('x', null, { GH_TOKEN: 'tok-a' });
  assert.equal(seen.at(-1)!.headers.authorization, 'token tok-a');
  await h.get('y', null, { GH_TOKEN: 'tok-b' });
  assert.equal(seen.at(-1)!.headers.authorization, 'token tok-b');
});

test("the token is not in the helper's env", async () => {
  const h = make();
  await helped(h, 'x', null, { GH_TOKEN: 'tok-env' });
  assert.ok(!live(h)[0].proc.spawnargs.join(' ').includes('tok-env'));
  assert.ok(!readFileSync(`/proc/${live(h)[0].proc.pid}/environ`, 'utf8').includes('tok-env'));
});

test('a helper that dies: that read goes through gh, and the next one starts a new helper by itself', async () => {
  const h = make();
  await helped(h, 'x', null, { GH_TOKEN: 'tok-a' });
  const [first] = live(h);
  first.proc.kill('SIGKILL');
  await new Promise((r) => first.proc.once('exit', r));
  assert.equal(await h.get('x', null, { GH_TOKEN: 'tok-a' }), null, 'falls back');
  const a = await helped(h, 'x', null, { GH_TOKEN: 'tok-a' });
  assert.equal(a.status, 200);
  assert.notEqual(live(h)[0].proc.pid, first.proc.pid);
});

test('a request without the nonce gets nothing', async () => {
  const h = make();
  await helped(h, 'x', null, { GH_TOKEN: 'tok-a' });
  const before = seen.length;
  const got = await new Promise<string>((done) => {
    const c = connect(live(h)[0].socket);
    let out = '';
    c.on('data', (d) => (out += d));
    c.on('close', () => done(out));
    c.on('error', () => done(out));
    c.end(`${JSON.stringify({ nonce: 'guess', path: 'x', etag: null })}\n`);
  });
  assert.equal(got, '');
  assert.equal(seen.length, before, 'GitHub was not asked');
});

test('an idle helper exits, and the next read starts another', async () => {
  const h = make(300);
  await helped(h, 'x', null, { GH_TOKEN: 'tok-a' });
  const [first] = live(h);
  await new Promise((r) => first.proc.once('exit', r));
  assert.equal(live(h).length, 0);
  assert.equal((await helped(h, 'x', null, { GH_TOKEN: 'tok-a' })).status, 200);
});

test('GitHub failing mid-read: that read goes through gh, and the helper stays up', async () => {
  const h = make();
  await helped(h, 'x', null, { GH_TOKEN: 'tok-a' });
  const [first] = live(h);
  assert.equal(await h.get('boom', null, { GH_TOKEN: 'tok-a' }), null);
  assert.equal((await h.get('x', null, { GH_TOKEN: 'tok-a' }))?.status, 200);
  assert.equal(live(h)[0].proc.pid, first.proc.pid, 'the same helper');
});

test("a token GitHub refuses (401): gh reads it instead, and the login's helper stops and rests", async () => {
  const h = make();
  await helped(h, 'x', null, { GH_TOKEN: 'tok-old' });
  const [first] = live(h);
  assert.equal(await h.get('gone', null, { GH_TOKEN: 'tok-old' }), null);
  await until('the helper to stop', () => first.proc.exitCode !== null || first.proc.signalCode !== null);
  assert.equal(live(h).length, 0);
  assert.equal(await h.get('x', null, { GH_TOKEN: 'tok-old' }), null, 'resting: gh, no new helper');
  assert.equal(live(h).length, 0);
});
