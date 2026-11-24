// A reader thread only reads (#1628, src/only-reads.ts): on a reader, a process or a file write throws, also through a
// copy a module took at load time; the main thread keeps them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { tempRoot } from './helpers.ts';

const guard = new URL('../src/only-reads.ts', import.meta.url).href;
// Loads the guard, then the way src/branch.ts and the like take their own copy, then tries each.
const tries = (dir: string) => `
  const { parentPort } = require('node:worker_threads');
  (async () => {
    await import(${JSON.stringify(guard)});
    const { promisify } = await import('node:util');
    const { execFile, spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const run = promisify(execFile);
    const out = {};
    const tryIt = async (name, f) => { try { await f(); out[name] = 'ran'; } catch (e) { out[name] = e.message; } };
    await tryIt('promisified execFile', () => run('true'));
    await tryIt('spawnSync', () => { if (spawnSync('true').error) throw spawnSync('true').error; });
    await tryIt('writeFileSync', () => fs.writeFileSync(${JSON.stringify(join(dir, 'a'))}, 'x'));
    await tryIt('promises.writeFile', () => fs.promises.writeFile(${JSON.stringify(join(dir, 'b'))}, 'x'));
    await tryIt('readFileSync', () => fs.readFileSync(${JSON.stringify(guard.replace('file://', ''))}));
    parentPort.postMessage(out);
  })();`;
const inWorker = (dir: string, reader: boolean) =>
  new Promise<Record<string, string>>((resolve, reject) => {
    const w = new Worker(tries(dir), { eval: true, workerData: reader ? { reader: {} } : {} });
    w.once('message', (m) => {
      resolve(m);
      void w.terminate();
    });
    w.once('error', reject);
  });

test('on a reader thread processes and file writes throw, a load-time copy too; reads work; elsewhere all run', async () => {
  const tmp = tempRoot('only-reads-');
  try {
    const reader = await inWorker(tmp.dir, true);
    for (const k of ['promisified execFile', 'spawnSync', 'writeFileSync', 'promises.writeFile']) assert.match(reader[k], /A reader thread doesn't/, k);
    assert.equal(reader.readFileSync, 'ran');
    assert.deepEqual(Object.values(await inWorker(tmp.dir, false)), ['ran', 'ran', 'ran', 'ran', 'ran']);
  } finally {
    await tmp.teardown();
  }
});

test('src/reader.ts loads the guard before any other module', () => {
  const first = readFileSync(new URL('../src/reader.ts', import.meta.url), 'utf8').match(/^import .*$/m)?.[0];
  assert.match(first ?? '', /from '\.\/only-reads\.ts';$/);
});

test('a reader hands back an answer made while something was refused, though the route caught it', async () => {
  const { answer } = await import('../src/reader.ts');
  const { refusal } = await import('../src/only-reads.ts');
  const { Auth } = await import('../src/auth.ts');
  const { json, router } = await import('../src/http.ts');
  let refuse = false;
  const routes = router([
    {
      method: 'GET',
      path: '/x',
      who: 'anyone',
      handler: ({ res }) => {
        let owner: string | null = 'someone';
        try {
          if (refuse) throw refusal('run git');
        } catch {
          owner = null;
        }
        json(res, 200, { owner });
      },
    },
  ]);
  const ask = () => answer({} as never, new Auth('a-long-password', 'x'.repeat(32)), routes, { method: 'GET', url: '/x', headers: {} });
  assert.equal((await ask())?.status, 200);
  refuse = true;
  assert.equal(await ask(), null);
});
