// The kit's ci-store scripts ride out a Citadel restart: a curl that gets no answer (refused, empty reply) is tried again like a 503.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'ci-restart-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DIR = join(import.meta.dirname, '..', 'kit', 'skills', 'ci-store');
writeFileSync(join(root, 'app.apk'), 'apk');

const listen = (s: Server, port = 0) => new Promise<number>((r) => s.listen(port, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const github = createServer((_q, res) => res.end('{"count":1,"value":"tok"}'));
const ghPort = await listen(github); // up for the whole file, so a port a test frees is never taken by it
after(() => github.close());

// A store that drops the first `drop` requests with no reply, then answers `status`.
const store = (drop: number, status: number) => {
  const seen = { n: 0 };
  const s = createServer((req, res) => {
    req.resume();
    if (seen.n++ < drop) return void req.socket.destroy();
    req.on('end', () => res.writeHead(status, { 'Content-Type': 'application/json' }).end(status === 200 ? '{"files":[]}' : '{"ok":true}'));
  });
  return { s, seen };
};

const run = async (script: string, args: readonly string[], storeUrl: string) => {
  const gh = ghPort;
  return new Promise<{ status: number | null; stdout: string }>((done) => {
    const p = spawn('bash', [join(DIR, script), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH!, RUNNER_TEMP: root, CITADEL_STORE_URL: storeUrl, CI_UPLOAD_WAIT: '1', CI_DOWNLOAD_WAIT: '1', ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${gh}/t?v=2`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 's' },
    });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (status) => done({ status, stdout }));
  });
};

for (const [script, args, ok] of [
  ['ci-upload.sh', ['--kind', 'build', '--name', 'a.apk', 'app.apk'], 201],
  ['ci-download.sh', ['--list'], 200],
  ['ci-numbers.sh', ['x=1ms'], 201],
] as const) {
  test(`${script} tries again after the store drops its connection, then succeeds`, async () => {
    const { s, seen } = store(2, ok);
    const port = await listen(s);
    const r = await run(script, args, `http://127.0.0.1:${port}`);
    s.close();
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /::(error|warning)::/);
    assert.equal(seen.n, 3);
  });

  test(`${script} tries again while nothing listens (a restart), then succeeds`, async () => {
    // A port below the ephemeral range (32768+), so no other copy's listen(0) can be handed it while it is free.
    let port = 0;
    for (;;) {
      const probe = createServer();
      port = 20000 + Math.floor(Math.random() * 10000);
      const got = await listen(probe, port).catch(() => 0);
      if (got) {
        await new Promise((r) => probe.close(r));
        break;
      }
    }
    const { s, seen } = store(0, ok);
    setTimeout(() => void listen(s, port), 1500);
    const r = await run(script, args, `http://127.0.0.1:${port}`);
    s.close();
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /::(error|warning)::/);
    assert.ok(seen.n >= 1);
  });
}

test('a refused upload (4xx) is not tried again', async () => {
  const { s, seen } = store(0, 403);
  const port = await listen(s);
  const r = await run('ci-upload.sh', ['--kind', 'build', '--name', 'a.apk', 'app.apk'], `http://127.0.0.1:${port}`);
  s.close();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the store refused a\.apk \(HTTP 403\)/);
  assert.equal(seen.n, 1);
});

test('a store that never answers still gives up with the old message', async () => {
  const { s, seen } = store(99, 201);
  const port = await listen(s);
  const r = await run('ci-upload.sh', ['--kind', 'build', '--name', 'a.apk', 'app.apk'], `http://127.0.0.1:${port}`);
  s.close();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::ci-upload: the store at .* didn't answer/);
  assert.equal(seen.n, 6);
});
