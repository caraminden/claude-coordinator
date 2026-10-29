// Brief 1: no request and no background job can take the server down.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, REPO, type Booted } from './helpers.ts';

let srv: Booted;
before(async () => {
  srv = await bootServer();
});
after(() => srv.stop());

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
