import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';
import { listeningPort, stopTurns, stopProcs } from './helpers.ts';

// Saved views: named property filters, each person's own list per scheme (#194).
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'saved-views-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
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

let joshId = 0;
async function login(name: string) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: 'test-password-123' }),
  });
  cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
}

before(async () => {
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: '0', DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(server);
  base = `http://127.0.0.1:${await listeningPort(server)}`;
  await login('Cara');
  // Josh signs in through an invite: the shared password signs in only an admin.
  const { data: made } = await call('Cara', '/api/people', { method: 'POST', body: { name: 'Josh' } });
  joshId = made.person.id;
  const res = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'josh-password-1' }) });
  cookies.Josh = res.headers.get('set-cookie')!.split(';')[0];
});

test("views are each person's own per scheme, replaced by name, deletable only by their owner, and validated", async () => {
  const { data: p } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Views' } });
  const { data: other } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Elsewhere' } });
  await call('Cara', `/api/projects/${p.id}/members`, { method: 'POST', body: { person: joshId } });
  const url = `/api/projects/${p.id}/views`;
  assert.deepEqual((await call('Cara', url)).data, []);

  const saved = await call('Cara', url, { method: 'POST', body: { name: ' Build 8 art ', picks: { type: ['art'], build: [8] } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.map((v: any) => [v.name, v.picks, v.owner]), [['Build 8 art', { type: ['art'], build: [8] }, 'Cara']]);
  await call('Cara', url, { method: 'POST', body: { name: 'Bugs', picks: { type: ['bug'] } } });
  assert.deepEqual((await call('Cara', url)).data.map((v: any) => v.name), ['Bugs', 'Build 8 art']);
  assert.deepEqual((await call('Josh', url)).data, [], "Josh doesn't see Cara's");
  assert.deepEqual((await call('Cara', `/api/projects/${other.id}/views`)).data, [], 'another scheme has its own');

  const josh = await call('Josh', url, { method: 'POST', body: { name: 'Bugs', picks: { type: ['bug', 'feature'] } } });
  assert.deepEqual(josh.data.map((v: any) => [v.name, v.picks, v.owner]), [['Bugs', { type: ['bug', 'feature'] }, 'Josh']], 'the same name is his own view');
  const caras = (await call('Cara', url)).data;
  assert.deepEqual(caras.find((v: any) => v.name === 'Bugs').picks, { type: ['bug'] }, "and leaves Cara's alone");

  const replaced = await call('Cara', url, { method: 'POST', body: { name: 'Bugs', picks: { type: ['bug', 'idea'] } } });
  assert.deepEqual(replaced.data.find((v: any) => v.name === 'Bugs').picks, { type: ['bug', 'idea'] });
  assert.equal(replaced.data.length, 2);

  for (const picks of [undefined, {}, [], { type: [] }, { type: 'bug' }, { type: [{}] }, { type: [null] }]) {
    assert.equal((await call('Cara', url, { method: 'POST', body: { name: 'Bad', picks } })).status, 400, JSON.stringify(picks));
  }
  assert.equal((await call('Cara', url, { method: 'POST', body: { name: '  ', picks: { type: ['bug'] } } })).status, 400);

  const art = replaced.data.find((v: any) => v.name === 'Build 8 art');
  assert.equal((await call('Cara', `/api/projects/${other.id}/views/${art.id}`, { method: 'DELETE' })).status, 404, 'not through another scheme');
  assert.equal((await call('Josh', `${url}/${art.id}`, { method: 'DELETE' })).status, 404, "not someone else's");
  const left = await call('Cara', `${url}/${art.id}`, { method: 'DELETE' });
  assert.deepEqual(left.data.map((v: any) => v.name), ['Bugs']);
  assert.equal((await call('Cara', `${url}/${art.id}`, { method: 'DELETE' })).status, 404);
});

test("the scheme's shared views become their saver's own, also after a rollback made the old table again", () => {
  const file = join(root, 'move.db');
  const store = new Store(file);
  const p = store.createProject('Moved', null);
  store.saveView(p.id, 'Josh', 'Mine', { type: ['bug'] });
  store.db.close();
  // What the last release reads and writes (schema version 14).
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE saved_views (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, picks TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (project_id, name))`);
  const add = old.prepare('INSERT INTO saved_views (project_id, name, picks, created_by, created_at) VALUES (?, ?, ?, ?, 1)');
  add.run(p.id, 'Josh Test', '{"type":["art"]}', 'Josh');
  add.run(p.id, 'Mine', '{"type":["idea"]}', 'Josh');
  add.run(p.id, 'Cara bugs', '{"type":["bug"]}', 'Cara');
  old.close();

  const again = new Store(file);
  assert.deepEqual(again.listViews(p.id, 'Josh').map((v) => [v.name, v.picks]), [['Josh Test', { type: ['art'] }], ['Mine', { type: ['bug'] }]], 'a name he already had keeps his');
  assert.deepEqual(again.listViews(p.id, 'Cara').map((v) => v.name), ['Cara bugs']);
  assert.equal(again.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'saved_views'").get(), undefined, 'the shared table is gone');
  again.db.close();
});
