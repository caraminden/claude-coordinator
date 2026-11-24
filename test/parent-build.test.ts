import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { buildOwnerKey, Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, stopTurns } from './helpers.ts';
import { until } from './wait.ts';

// A minion started for another minion (#273) records it as its parent and rides its build, unless the
// create says otherwise. The Taskmaster names the parent with `parent`; left out, it is the minion
// whose relay the Taskmaster's turn answers.
const root = mkdtempSync(join(tmpdir(), 'parent-build-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

// A turn's fake claude keeps its turn token, which the Taskmaster's calls need once a turn has started.
// It writes the token under another name and renames it: the test would read a half-made file as an empty token (401).
const fake = join(root, 'claude-fake');
writeFileSync(fake, '#!/bin/sh\nprintf %s "$COORDINATOR_TOKEN" > token.tmp && mv token.tmp token\n');
chmodSync(fake, 0o755);

const store = new Store(join(data, 'coordinator.db'));
store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
// Delve has a `build` property key, so the property follows the column there.
const Delve = store.createProject('Delve', null);
const Citadel = store.createProject('Citadel', null);
// A scheme with a repo, for the build branch base (#592).
const repo = join(root, 'repo');
execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'init'], { cwd: repo });
const Repo = store.createProject('Repo', null);
store.setProjectRepoDir(Repo.id, repo);

function ticket(p: { id: number }, kind: 'coordinator' | 'ticket', build: number | null = null) {
  const t = store.createTicket({ project_id: p.id, kind, title: kind === 'ticket' ? 'Parent' : 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  store.updateTicket(t.id, { status: 'idle', build });
  return t;
}
const DelveTM = ticket(Delve, 'coordinator');
const withBuild = ticket(Delve, 'ticket', 8); // Delve #1
ticket(Delve, 'ticket'); // Delve #2, no build
ticket(Delve, 'ticket', 5); // Delve #3, a leader to chain after
ticket(Citadel, 'coordinator');
for (let i = 0; i < 30; i++) ticket(Citadel, 'ticket', 3); // Citadel #1-#30, so #30 is only Citadel's

test('a new minion rides its parent\'s build unless the create sets one', async () => {
  const tokens = new Auth(PASSWORD, SECRET);
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fake } });
  after(() => srv.stop());
  const tokenFile = join(root, `t${DelveTM.id}`, 'token');
  const as = async (who: number, method: string, path: string, body?: object) => {
    const token = who === DelveTM.id && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : tokens.agentToken(who);
    const res = await fetch(srv.base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const create = (extra: object) => as(DelveTM.id, 'POST', `/api/projects/${Delve.id}/tickets`, { message: 'do it', properties: { type: 'chore' }, model: 'claude-sonnet-5-5', effort: 'medium', ...extra });
  const made = async (extra: object) => {
    const r = await create(extra);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { ...store.getTicket(r.body.id)!, props: r.body.properties as Record<string, unknown> };
  };

  // A Taskmaster's create names its model and effort on purpose (#698): leaving either out is refused, with no minion made.
  const minionsBefore = store.listTickets(Delve.id).length;
  for (const missing of [{ model: undefined }, { effort: null }]) {
    const r = await create(missing);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /needs a model and an effort/);
  }
  assert.equal(store.listTickets(Delve.id).length, minionsBefore);

  // No parent and no relay: as before.
  let t = await made({});
  assert.deepEqual([t.model, t.effort], ['claude-sonnet-5-5', 'medium']);
  assert.deepEqual([t.parent, t.build, t.props.build], [null, null, undefined]);

  // parent with a build: the child gets it, as the column and Delve's build property, and shows from #1.
  t = await made({ parent: 1 });
  assert.deepEqual([t.parent, t.build, t.props.build], [1, 8, 8]);
  const listed = await as(DelveTM.id, 'GET', `/api/projects/${Delve.id}/tickets`);
  assert.equal(listed.body.tickets.find((x: any) => x.number === t.number)?.parent, 1, 'list_tickets carries the parent');

  // An explicit build wins, and null means no build; so does the build property.
  t = await made({ parent: 1, build: 9 });
  assert.deepEqual([t.parent, t.build, t.props.build], [1, 9, 9]);
  t = await made({ parent: 1, build: null });
  assert.deepEqual([t.parent, t.build, t.props.build], [1, null, undefined]);
  t = await made({ parent: 1, properties: { type: 'chore', build: 7 } });
  assert.deepEqual([t.build, t.props.build], [7, 7]);

  // A parent with no build leaves it without one.
  t = await made({ parent: 2 });
  assert.deepEqual([t.parent, t.build], [2, null]);

  // A start_after follower rides its leader's build, without the leader becoming its parent.
  t = await made({ start_after: 3 });
  assert.deepEqual([t.parent, t.build, t.props.build], [null, 5, 5]);
  t = await made({ start_after: 3, build: null });
  assert.deepEqual([t.parent, t.build], [null, null]);
  // A parent's build beats the leader's; a parent with none leaves the leader's.
  t = await made({ parent: 1, start_after: 3 });
  assert.deepEqual([t.parent, t.build], [1, 8]);
  t = await made({ parent: 2, start_after: 3 });
  assert.deepEqual([t.parent, t.build], [2, 5]);

  // Its effort (#1751): an unnamed chain is named after its leader, and the leader takes the name too.
  const leader3 = store.listTickets(Delve.id).find((x) => x.number === 3)!;
  assert.equal(t.props.effortName, 'chain from #3');
  assert.equal(store.props.forTarget('minion', leader3.id).effortName, 'chain from #3');
  // A name given in another spelling is the same key, not a second one; the minions it starts carry it.
  const named = await made({ start_after: 3, parent: null, properties: { type: 'chore', effort_name: 'Overlay rewrite' } });
  assert.equal(named.props.effortName, 'Overlay rewrite');
  t = await made({ parent: named.number });
  assert.equal(t.props.effortName, 'Overlay rewrite');

  // Another scheme's minion (Citadel #30) is no parent here: refused, and nothing is made.
  const before = store.listTickets(Delve.id).length;
  for (const parent of [30, 'x', 0]) {
    const r = await create({ parent });
    assert.equal(r.status, 400, `parent ${parent}`);
    assert.match(r.body.error, /parent must be a minion number in this scheme/);
  }
  assert.equal(store.listTickets(Delve.id).length, before);

  // Left out, the parent is the minion whose relay the Taskmaster's turn answers; null opts out.
  assert.equal((await as(withBuild.id, 'POST', `/api/tickets/${withBuild.id}/coordinator`, { text: 'start a follow-up', need: 'start' })).status, 202);
  await until('the token file', async () => existsSync(tokenFile), 5000);
  assert.ok(existsSync(tokenFile), 'the relay started a Taskmaster turn');
  t = await made({});
  assert.deepEqual([t.parent, t.build], [1, 8]);
  t = await made({ parent: null });
  assert.deepEqual([t.parent, t.build], [null, null]);
  // A person's create names no relay: only the parent they pass.
  const mine = await srv.call(`/api/projects/${Delve.id}/tickets`, { message: 'mine', parent: 2 });
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  assert.deepEqual([store.getTicket(mine.data.id)!.parent, store.getTicket(mine.data.id)!.build], [2, null]);

  // Build branches (#592): build_owner marks the build's own minion, and needs a build.
  t = await made({ build: 11, build_owner: true, parent: null });
  assert.equal(store.getSetting(buildOwnerKey(Delve.id, 11)), t.id);
  t = await made({ properties: { type: 'chore', build: 12 }, build_owner: true, parent: null });
  assert.equal(store.getSetting(buildOwnerKey(Delve.id, 12)), t.id, 'a build given as the property counts');
  t = await made({ build: 11, parent: null });
  assert.notEqual(store.getSetting(buildOwnerKey(Delve.id, 11)), t.id, 'a feeder is no owner');
  const count = store.listTickets(Delve.id).length;
  const refused = await create({ build_owner: true, parent: null });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /build_owner needs a build/);
  assert.equal(store.listTickets(Delve.id).length, count, 'nothing made');

  // A minion created in a build whose branch exists starts from it; another build, from main.
  const g = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'on build 4']);
  g(['branch', 'build/4']);
  g(['reset', '--quiet', '--hard', 'HEAD~1']);
  const inRepo = async (build: number) => {
    const r = await srv.call(`/api/projects/${Repo.id}/tickets`, { message: 'feed it', build });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: store.getTicket(r.data.id)!.cwd, encoding: 'utf8' }).trim();
  };
  assert.equal(await inRepo(4), g(['rev-parse', 'build/4']));
  assert.equal(await inRepo(5), g(['rev-parse', 'main']));
});
