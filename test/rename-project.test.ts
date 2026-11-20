import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, stopProcs, type Booted } from './helpers.ts';

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

let srv: Booted;
const call = (path: string, opts: { method?: string; body?: unknown } = {}) => srv.call(path, opts.body || undefined, opts.method ?? 'GET');

before(async () => {
  srv = await bootServer({ root, stdout: true });
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

test('PATCH Shipping keeps the merge approval and the go threshold agreeing, and refuses a pr-person go below every change (#1043)', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Shipping' } });
  assert.deepEqual([p.ship_path, p.go_from, p.try_first], ['citadel', 'high', 'never'], "today's behaviour by default");
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { ship_path: 'by-hand' } })).status, 400);
  const all = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { ship_path: 'pr-auto', go_from: 'all', approval_rules: 'Edit(CLAUDE.md)' } });
  assert.equal(all.status, 200);
  assert.equal(all.data.approval_rules, 'Edit(CLAUDE.md)\nBash(gh pr merge:*)\nmcp__*__merge_pull_request', 'every change on a PR path ticks the merge approval');
  const high = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { go_from: 'high' } });
  assert.equal(high.data.approval_rules, 'Edit(CLAUDE.md)', 'a go by label leaves it off');
  const clash = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { ship_path: 'pr-person', go_from: 'medium' } });
  assert.equal(clash.status, 400);
  assert.match(clash.data.error, /every change/i);
  const person = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { ship_path: 'pr-person', try_first: 'ui' } });
  assert.deepEqual([person.data.ship_path, person.data.go_from, person.data.try_first], ['pr-person', 'all', 'ui'], 'a person merging means every change needs a go');
  assert.match(person.data.approval_rules, /gh pr merge/);
  // The gate's two rules are checked like typed ones: a list already at the cap can't take them.
  const { data: full } = await call('/api/projects', { method: 'POST', body: { name: `Rules at the limit ${Date.now()}` } });
  const fifty = Array.from({ length: 50 }, (_, i) => `Bash(tool${i}:*)`).join('\n');
  assert.equal((await call(`/api/projects/${full.id}`, { method: 'PATCH', body: { approval_rules: fifty } })).status, 200);
  const over = await call(`/api/projects/${full.id}`, { method: 'PATCH', body: { ship_path: 'pr-person' } });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /Merge a pull request.*At most/);
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

test('PATCH saves a scheme\'s screenshot widths, themes, requirement and note, and defaults to today\'s rule (#1044)', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Shots' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  assert.deepEqual([page.project.shot_widths, page.project.shot_themes, page.project.shots_required, page.project.shot_note], ['1440,390', 'light', 1, '']);
  const ok = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { shot_widths: [390, '1024', 390], shot_themes: 'dark,light', shots_required: false, shot_note: '  1x in her   window ' } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.shot_widths, ok.data.shot_themes, ok.data.shots_required, ok.data.shot_note], ['390,1024', 'light,dark', 0, '1x in her window']);
  for (const body of [{ shot_widths: [] }, { shot_widths: 'wide' }, { shot_widths: [50] }, { shot_themes: 'sepia' }, { shot_themes: [] }, { shots_required: 'yes' }, { shot_note: 5 }, { shot_note: 'x'.repeat(201) }]) {
    assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
});

test('PATCH saves a scheme\'s never-hold kinds on their own and refuses unknown ones (#1067)', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Never hold' } });
  const ok = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { msg_never_hold: ['note', 'decision', 'note'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.msg_never_hold, 'decision,note');
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { msg_never_hold: [] } })).data.msg_never_hold, '');
  for (const body of [{ msg_never_hold: 'note' }, { msg_never_hold: ['shout'] }]) assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body })).status, 400, JSON.stringify(body));
});

test('a save refused for too many approval rules changes nothing, its rename included (#1287 F2)', async () => {
  const { data: p, status: s0 } = await call('/api/projects', { method: 'POST', body: { name: `Rules at the limit ${Date.now()}` } });
  assert.ok(p.id, JSON.stringify([s0, p]));
  await call(`/api/projects/${p.id}`);
  const rules = Array.from({ length: 50 }, (_, i) => `mcp__tool__r${i}`);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { approval_rules: rules } })).status, 200);
  const refused = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: 'Renamed anyway', ship_path: 'pr-person' } });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /At most 50/);
  const { data: page } = await call(`/api/projects/${p.id}`);
  assert.match(page.project.name, /^Rules at the limit \d+$/);
});
