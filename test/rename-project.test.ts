import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';

// A project's name is display-only: renaming it changes nothing that goes by id (repo, folders, links).
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'rename-project-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

test('renameProject trims, refuses empty and taken names, and leaves the repo alone', () => {
  const store = new Store(join(root, 'store.db'));
  const a = store.createProject('Alpha', 'https://example.com/a.git');
  store.setProjectRepoDir(a.id, '/data/projects/1/repo');
  store.createProject('Beta', null);
  const renamed = store.renameProject(a.id, '  Gamma  ');
  assert.equal(renamed.name, 'Gamma');
  assert.equal(renamed.repo_url, 'https://example.com/a.git');
  assert.equal(renamed.repo_dir, '/data/projects/1/repo');
  assert.throws(() => store.renameProject(a.id, '   '), /cannot be empty/);
  assert.throws(() => store.renameProject(a.id, 'Beta'), /already a scheme called "Beta"/);
  assert.equal(store.renameProject(a.id, 'Gamma').name, 'Gamma', 'keeping its own name is fine');
  assert.equal(store.getProject(a.id)!.name, 'Gamma');
});

let base = '';
let cookie = '';

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
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
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
    }).catch(() => undefined);
    if (res) {
      cookie = res.headers.get('set-cookie')!.split(';')[0];
      break;
    }
    if (Date.now() > end) throw new Error('Timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('PATCH /api/projects/:id renames, with friendly errors', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Old name' } });
  await call('/api/projects', { method: 'POST', body: { name: 'Taken' } });
  await call(`/api/projects/${p.id}`); // opening the page makes its coordinator

  const ok = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: '  New name ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.name, 'New name');
  assert.equal(ok.data.id, p.id);

  const empty = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: '  ' } });
  assert.equal(empty.status, 400);
  const taken = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: 'Taken', instructions: 'not saved' } });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /already a scheme called "Taken"/);

  const { data: page } = await call(`/api/projects/${p.id}`);
  assert.equal(page.project.name, 'New name');
  assert.equal(page.project.instructions, '', 'a refused rename saves none of the other fields');
  const notes = await call(`/api/tickets/${page.coordinator.id}/events?after=0`);
  const texts = notes.data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(texts.includes('Cara renamed the scheme from "Old name" to "New name".'), 'the coordinator hears about it');
});

test('GET /api/projects/:id/instructions/history shows the last saves with their diffs', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'History' } });
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { instructions: 'keep\nold' } });
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { instructions: 'keep\nold' } }); // unchanged: no row
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { instructions: 'keep\nnew' } });
  const { status, data } = await call(`/api/projects/${p.id}/instructions/history`);
  assert.equal(status, 200);
  assert.deepEqual(data.history.map((h: any) => [h.by, h.diff]), [
    ['Cara', [{ op: '-', text: 'old' }, { op: '+', text: 'new' }]],
    ['Cara', [{ op: '+', text: 'keep' }, { op: '+', text: 'old' }]],
  ]);
  assert.equal(typeof data.history[0].at, 'number');
});
