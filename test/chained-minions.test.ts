import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { type Chain, LiveWaiters } from '../src/wake.ts';

// Chained minions: one created parked, whose brief is held until the minion it follows (its leader)
// has its work live, or merged. A temp repo stands in for both the live checkout and the scheme's repo,
// as for Citadel's own scheme; a second repo stands in for a scheme whose code the server doesn't run.
const root = mkdtempSync(join(tmpdir(), 'chained-minions-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

function makeRepo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  let n = 0;
  const commit = () => {
    writeFileSync(join(dir, 'f'), String(++n));
    git('add', '-A');
    git('commit', '-q', '-m', `c${n}`);
    return git('rev-parse', 'HEAD');
  };
  commit();
  /** A commit on `branch` only, made without checking it out; its reflog line is the one git commit writes. */
  const work = (branch: string) => {
    const c = git('commit-tree', '-p', `refs/heads/${branch}`, '-m', 'work', `refs/heads/${branch}^{tree}`);
    git('update-ref', '-m', 'commit: work', `refs/heads/${branch}`, c);
    return c;
  };
  return { dir, git, commit, work };
}
const live = makeRepo('live');
const other = makeRepo('other');

const store = new Store(join(root, 'test.db'));
const citadel = store.createProject('Citadel', null);
store.setProjectRepoDir(citadel.id, live.dir);
const delve = store.createProject('Delve', null);
store.setProjectRepoDir(delve.id, other.dir);

let branches = 0;
/** A minion with a branch off main in its scheme's repo. */
function minion(project = citadel.id, repo = live) {
  const t = store.createTicket({ project_id: project, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const branch = `ticket/${++branches}`;
  repo.git('branch', branch, 'main');
  store.setTicketDir(t.id, root, branch);
  store.updateTicket(t.id, { status: 'idle' });
  return { id: t.id, branch };
}

const started: { c: Chain; why: string }[] = [];
const held: { c: Chain; why: string }[] = [];
function waiters(head: string) {
  const w = new LiveWaiters(store, live.dir, head, () => {});
  w.start = (c, why) => started.push({ c, why });
  w.hold = (c, why) => held.push({ c, why });
  return w;
}
/** Chain a new minion after `leader`, as the create endpoint does. */
function chain(w: LiveWaiters, leader: number, when: Chain['when'], project = citadel.id, repo = live) {
  const f = w.follow(leader, when);
  assert.equal(f.state, 'wait');
  const follower = minion(project, repo).id;
  w.chain({ ticket: follower, after: leader, when, message: 'build part two', from: 'Taskmaster', base: f.base });
  return follower;
}
const reset = () => {
  started.length = 0;
  held.length = 0;
};

test('a live chain waits through the merge and starts once the server runs the leader\'s work', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const follower = chain(w, leader.id, 'live');
  assert.equal(w.check(), 0, 'no work of its own yet');

  live.work(leader.branch);
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(w.check(), 0, 'merged, but the server still runs the old commit');
  assert.equal(w.chains().length, 1);

  assert.equal(w.check(live.git('rev-parse', 'HEAD')), 1, 'the restart onto it');
  assert.equal(started.length, 1);
  assert.equal(started[0].c.ticket, follower);
  assert.equal(started[0].c.message, 'build part two');
  assert.match(started[0].why, /^#\d+'s work is live$/);
  assert.equal(w.chains().length, 0);
  assert.equal(w.check(), 0, 'started once');
});

test('a merged chain starts once the leader\'s work is on main, live or not', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  chain(w, leader.id, 'merged');
  live.work(leader.branch);
  assert.equal(w.check(), 0, 'committed on its branch only');
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(w.check(), 1);
  assert.match(started[0].why, /work is merged$/);
});

// #126: a leader whose branch had no commits of its own started its follower once the branch was
// caught up to a newer main, since that tip was on main and wasn't the one the chain recorded.
for (const when of ['merged', 'live'] as const) {
  test(`a ${when} chain ignores a leader branch caught up to main, and starts on the leader's own landed commit`, () => {
    reset();
    const w = waiters(live.git('rev-parse', 'HEAD'));
    const leader = minion();
    const dir = join(root, `wt-${leader.branch.replace('/', '-')}`);
    live.git('worktree', 'add', '-q', dir, leader.branch);
    const inTree = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    chain(w, leader.id, when);

    live.commit(); // another minion lands, and the server restarts onto it
    inTree('merge', '-q', '--ff-only', 'main'); // the leader catches up: a new tip, on main, none of its own
    assert.equal(w.check(live.git('rev-parse', 'HEAD')), 0, 'an empty branch caught up to main is not work');
    assert.equal(w.chains().length, 1);

    writeFileSync(join(dir, 'g'), when);
    inTree('add', '-A');
    inTree('commit', '-q', '-m', 'own work');
    assert.equal(w.check(), 0, 'committed but not merged');
    live.git('merge', '-q', '--ff-only', leader.branch); // as land.sh fast-forwards main
    if (when === 'live') assert.equal(w.check(), 0, 'merged, but the server still runs the old commit');
    assert.equal(w.check(live.git('rev-parse', 'HEAD')), 1);
    assert.match(started[0].why, new RegExp(`work is ${when}$`));
  });
}

test('a leader that shipped before the chain was set only counts once it commits again', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  // Its earlier work, an hour back: the reflog stamps entries with the committer date.
  const old = { ...process.env, GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 3600} +0000` };
  const shipped = execFileSync('git', ['commit-tree', '-p', 'main', '-m', 'old work', 'main^{tree}'], { cwd: live.dir, encoding: 'utf8', env: old }).trim();
  execFileSync('git', ['update-ref', '-m', 'commit: old work', `refs/heads/${leader.branch}`, shipped], { cwd: live.dir, env: old });
  live.git('merge', '-q', '--ff-only', leader.branch);
  chain(w, leader.id, 'merged');
  live.commit();
  live.git('update-ref', '-m', 'merge main: Fast-forward', `refs/heads/${leader.branch}`, 'main');
  assert.equal(w.check(), 0, 'its old work is not new work');
  live.work(leader.branch);
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(w.check(), 1);
});

test('a leader dismissed without its work merged holds the chain and tells people once; it starts if the work lands after all', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const follower = chain(w, leader.id, 'merged');
  live.work(leader.branch);
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(w.check(), 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].c.ticket, follower);
  assert.match(held[0].why, /^#\d+ was dismissed without its work being merged$/);
  assert.equal(w.check(), 0);
  assert.equal(held.length, 1, 'told once');
  assert.equal(w.follow(leader.id, 'merged').state, 'unshipped', 'nothing new can chain on it');

  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(w.check(), 1);
  assert.equal(started[0].c.ticket, follower);
});

test('a leader with no commits of its own counts as done once dismissed', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  chain(w, leader.id, 'live');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(w.check(), 1);
  assert.equal(held.length, 0);
});

test('a leader already live when the chain is set starts it at once', () => {
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  live.work(leader.branch);
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  w.head = live.git('rev-parse', 'HEAD');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(w.follow(leader.id, 'live').state, 'go');
});

test('in a scheme whose code the server does not run, live means merged', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion(delve.id, other);
  chain(w, leader.id, 'live', delve.id, other);
  other.work(leader.branch);
  other.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(w.check(), 1);
});

test('a dismissed follower is dropped; release hands back the held brief once', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const dropped = chain(w, leader.id, 'live');
  store.updateTicket(dropped, { status: 'closed' });
  w.check();
  assert.equal(w.chains().length, 0);

  const follower = chain(w, leader.id, 'live');
  assert.equal(w.release(follower)?.message, 'build part two');
  assert.equal(w.release(follower), null);
  assert.equal(w.chains().length, 0);
  assert.equal(started.length, 0);
});

test('through the server: start_after parks the minion with its brief held; the leader\'s dismissal or a message starts it', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  const base = `http://127.0.0.1:${port}`;
  procs.push(spawn(process.execPath, [join(import.meta.dirname, '..', 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  }));
  let cookie = '';
  for (const end = Date.now() + 10_000; !cookie; await new Promise((r) => setTimeout(r, 50))) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
    }).catch(() => undefined);
    if (res) cookie = res.headers.get('set-cookie')!.split(';')[0];
    else if (Date.now() > end) throw new Error('Timed out waiting for the server');
  }
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const said = async (id: number) => (await call(`/api/tickets/${id}/events`)).data
    .filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data).text);
  const idle = async (id: number) => {
    while ((await call(`/api/tickets/${id}`)).data.ticket.status === 'running') await new Promise((r) => setTimeout(r, 20));
  };

  const { data: p } = await call('/api/projects', { name: 'Scheme' });
  const create = (title: string, extra: object) => call(`/api/projects/${p.id}/tickets`, { title, message: `brief for ${title}`, ...extra });
  const leader = (await create('Leader', {})).data;

  assert.equal((await create('Bad', { start_after: 999 })).status, 400);
  const badWhen = await create('Bad', { start_after: leader.number, start_when: 'soon' });
  assert.equal(badWhen.status, 400);
  assert.match(badWhen.data.error, /start_when must be one of: live, merged/);

  const next = await create('Next', { start_after: leader.number, start_when: 'merged' });
  assert.equal(next.status, 201);
  assert.equal(next.data.state, 'parked');
  assert.equal(next.data.note, `starts when #${leader.number} is merged`);
  assert.ok(next.data.notes.some((n: string) => n.startsWith('Parked: it starts by itself')));
  assert.deepEqual(await said(next.data.id), [], 'its brief is held');

  // No repo, so the leader's dismissal is what it waits for.
  await idle(leader.id);
  assert.equal((await call(`/api/tickets/${leader.id}/status`, { status: 'closed' })).status, 200);
  for (const end = Date.now() + 5000; !(await said(next.data.id)).length; await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() > end) throw new Error('The chained minion never started');
  }
  assert.deepEqual(await said(next.data.id), ['brief for Next']);

  // Writing to a chained minion before its leader is done starts it, brief first.
  const later = (await create('Later', { start_after: next.data.number })).data;
  assert.equal(later.note, `starts when #${next.data.number} is live`);
  await call(`/api/tickets/${later.id}/messages`, { text: 'go now' });
  assert.deepEqual(await said(later.id), ['brief for Later', 'go now']);
  await idle(later.id);
  await idle(next.data.id);
  await call(`/api/tickets/${next.data.id}/status`, { status: 'closed' });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await said(later.id), ['brief for Later', 'go now'], 'started once');
});
