// Brief 1: no request and no background job can take the server down.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, PASSWORD, REPO, SECRET, tempRoot, type Booted } from './helpers.ts';

let srv: Booted;
before(async () => {
  srv = await bootServer();
});
after(() => srv?.stop());

/** A GET with the path sent exactly as given (fetch would normalise it). */
function rawGet(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: srv.port, path }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject).end();
  });
}

test('a URL that can\'t be parsed or decoded gets a 400, and the server keeps answering', async () => {
  assert.equal(await rawGet('//'), 400);
  assert.equal(await rawGet('/%'), 400);
  assert.equal(await rawGet('/api/%zz'), 400);
  assert.equal((await srv.call('/api/health')).status, 200);
  assert.equal(srv.proc.exitCode, null);
});

test('a throwing background job, a stray rejection and an uncaught throw are logged, and the process lives on', () => {
  const script = `
    import { keepServing, safely } from ${JSON.stringify(join(REPO, 'src/safely.ts'))};
    keepServing();
    await safely('test job', () => { throw new Error('job boom'); });
    await safely('async job', async () => { throw new Error('async boom'); });
    Promise.reject(new Error('stray rejection'));
    setTimeout(() => { throw new Error('stray throw'); }, 10);
    setTimeout(() => console.log('still alive'), 100);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /still alive/);
  assert.match(r.stderr, /Background job "test job" failed:.*job boom/s);
  assert.match(r.stderr, /Background job "async job" failed:.*async boom/s);
  assert.match(r.stderr, /UNHANDLED REJECTION.*stray rejection/s);
  assert.match(r.stderr, /UNCAUGHT EXCEPTION.*stray throw/s);
});

test('a server that can\'t start still exits non-zero, so systemd restarts it', async () => {
  const tmp = tempRoot('crash-proof-');
  const root = tmp.dir;
  const busyPort = await tmp.serve(createServer());
  try {
    const proc = tmp.spawn(process.execPath, [join(REPO, 'server.ts')], {
      env: {
        ...process.env, MACHINES_URL: undefined, PORT: String(busyPort), DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
        CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    const code = await new Promise((r) => proc.on('exit', (c) => r(c)));
    clearTimeout(timer);
    assert.notEqual(code, 0);
    assert.notEqual(code, null, 'it exited by itself rather than hanging');
  } finally {
    await tmp.teardown();
  }
});
