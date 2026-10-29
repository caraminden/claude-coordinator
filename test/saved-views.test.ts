import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Saved views: named property filters, one list per scheme, shared by everyone in it.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'saved-views-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

let base = '';
const cookies: Record<string, string> = {};

async function call(who: string, path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookies[who], ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function login(name: string) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: 'test-password-123' }),
  });
  cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
}

before(async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  base = `http://127.0.0.1:${port}`;
  procs.push(spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  }));
  for (const end = Date.now() + 10_000; ; ) {
    if (await fetch(`${base}/api/me`).catch(() => undefined)) break;
    if (Date.now() > end) throw new Error('Timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 50));
  }
  await login('Cara');
  await login('Josh');
});

test('views are saved per scheme, replaced by name, deletable by anyone, and validated', async () => {
  const { data: p } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Views' } });
  const { data: other } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Elsewhere' } });
  const url = `/api/projects/${p.id}/views`;
  assert.deepEqual((await call('Cara', url)).data, []);

  const saved = await call('Cara', url, { method: 'POST', body: { name: ' Build 8 art ', picks: { type: ['art'], build: [8] } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.map((v: any) => [v.name, v.picks, v.created_by]), [['Build 8 art', { type: ['art'], build: [8] }, 'Cara']]);
  await call('Cara', url, { method: 'POST', body: { name: 'Bugs', picks: { type: ['bug'] } } });
  assert.deepEqual((await call('Josh', url)).data.map((v: any) => v.name), ['Bugs', 'Build 8 art'], 'everyone sees them');
  assert.deepEqual((await call('Cara', `/api/projects/${other.id}/views`)).data, [], 'another scheme has its own');

  const replaced = await call('Josh', url, { method: 'POST', body: { name: 'Bugs', picks: { type: ['bug', 'feature'] } } });
  assert.deepEqual(replaced.data.find((v: any) => v.name === 'Bugs').picks, { type: ['bug', 'feature'] });
  assert.equal(replaced.data.length, 2);

  for (const picks of [undefined, {}, [], { type: [] }, { type: 'bug' }, { type: [{}] }, { type: [null] }]) {
    assert.equal((await call('Cara', url, { method: 'POST', body: { name: 'Bad', picks } })).status, 400, JSON.stringify(picks));
  }
  assert.equal((await call('Cara', url, { method: 'POST', body: { name: '  ', picks: { type: ['bug'] } } })).status, 400);

  const art = replaced.data.find((v: any) => v.name === 'Build 8 art');
  assert.equal((await call('Cara', `/api/projects/${other.id}/views/${art.id}`, { method: 'DELETE' })).status, 404, 'not through another scheme');
  const left = await call('Josh', `${url}/${art.id}`, { method: 'DELETE' });
  assert.deepEqual(left.data.map((v: any) => v.name), ['Bugs'], 'anyone can delete');
  assert.equal((await call('Josh', `${url}/${art.id}`, { method: 'DELETE' })).status, 404);
});
