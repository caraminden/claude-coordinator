import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, stopProcs } from './helpers.ts';

// A project's name is display-only: renaming it changes nothing that goes by id (repo, folders, links).
const root = mkdtempSync(join(tmpdir(), 'rename-project-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
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
  const srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
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

test('PATCH sets a scheme\'s repo_url, refuses to replace one without replace_repo, and notes what a person still does', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Repoless' } });
  await call(`/api/projects/${p.id}`);
  const bad = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { repo_url: 'ftp://nope' } });
  assert.equal(bad.status, 400);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { repo_url: 'https://tok:x@github.com/me/one' } })).status, 400, 'no login in the URL');
  const ok = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { repo_url: ' https://github.com/me/one ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.repo_url, 'https://github.com/me/one');
  assert.equal(ok.data.repo_dir, null, 'no clone is made or re-pointed');
  const clash = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { repo_url: 'https://github.com/me/two', name: 'Renamed too' } });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /replace_repo/);
  assert.equal((await call(`/api/projects/${p.id}`)).data.project.name, 'Repoless', 'a refused repo saves nothing');
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { repo_url: 'https://github.com/me/one' } })).status, 200, 'the same URL is no change');
  const swap = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { repo_url: 'https://github.com/me/two', replace_repo: true } });
  assert.equal(swap.data.repo_url, 'https://github.com/me/two');
  const { data: page } = await call(`/api/projects/${p.id}`);
  const notes = (await call(`/api/tickets/${page.coordinator.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(notes.some((t: string) => /set the scheme's repo to https:\/\/github.com\/me\/one.*clone/.test(t)), notes.join('\n'));
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

test("PATCH /api/projects/:id saves list groups checked against the scheme's own keys", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Groups' } });
  const global = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { list_groups: ['type: bug'] } });
  assert.equal(global.status, 400);
  assert.match(global.data.error, /global key/);
  const none = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { list_groups: [] } });
  assert.equal(none.status, 200);
  assert.equal(none.data.list_groups, '[]');
});

test('PATCH /api/projects/:id saves the watched CI workflows, cleaned like the quiet ones (#774)', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Watched' } });
  const ok = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { ci_watch: ' windows.yml\n\ndesktop.yml ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ci_watch, 'windows.yml\ndesktop.yml');
  assert.equal(ok.data.ci_quiet, '', 'the quiet list stays as it was');
});

test("PATCH land_mode turns fast mode on only once the scheme's land.sh knows it, and tells the Taskmaster (#1017)", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Fast' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { land_mode: 'quick' } })).status, 400);
  const none = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { land_mode: 'fast' } });
  assert.equal(none.status, 409);
  assert.match(none.data.error, /tools\/land\.sh is missing/);
  const repo = join(root, 'fast-repo');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  new Store(join(root, 'data', 'coordinator.db')).setProjectRepoDir(p.id, repo);
  writeFileSync(join(repo, 'tools', 'land.sh'), '#!/bin/bash\n# an old template\n');
  const old = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { land_mode: 'fast' } });
  assert.equal(old.status, 409);
  assert.match(old.data.error, /doesn't know fast mode yet.*re-sync/);
  writeFileSync(join(repo, 'tools', 'land.sh'), '#!/bin/bash\n[ "$1" = --verify ] && exit 0\n[ -n "${LAND_FAST:-}" ]\n');
  const on = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { land_mode: 'fast' } });
  assert.equal(on.status, 200);
  assert.equal(on.data.land_mode, 'fast');
  const off = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { land_mode: 'off' } });
  assert.equal(off.data.land_mode, 'off');
  const notes = (await call(`/api/tickets/${page.coordinator.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.equal(notes.filter((t: string) => /fast mode/i.test(t)).length, 2, notes.join('\n'));
});
