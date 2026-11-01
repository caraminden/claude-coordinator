import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { type Chain, LiveWaiters, mergedPr, mergedPrOf, type PrMerge } from '../src/wake.ts';
import { bootServer } from './helpers.ts';

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

// GitHub as the waiters see it: the pull requests merged so far, newest last.
const prs: (PrMerge & { branch: string })[] = [];
/** Squash-merge `branch` into main as a merged PR would: main gets one new commit, none of the branch's. */
function squash(repo: typeof live, branch: string) {
  repo.git('merge', '--squash', '-q', branch);
  repo.git('commit', '-q', '--allow-empty', '-m', `squashed ${branch}`);
  prs.push({ branch, number: prs.length + 1, head: repo.git('rev-parse', `refs/heads/${branch}`), commit: repo.git('rev-parse', 'HEAD') });
}

const started: { c: Chain; why: string }[] = [];
const held: { c: Chain; why: string }[] = [];
function waiters(head: string) {
  const w = new LiveWaiters(store, live.dir, head, () => {});
  w.prs = {
    branch: (_repo, branch) => prs.findLast((p) => p.branch === branch) ?? null,
    commit: () => null,
  };
  w.start = (c, why) => started.push({ c, why });
  w.hold = (c, why) => held.push({ c, why });
  return w;
}
/** Chain a new minion after `leader`, as the create endpoint does. */
function chain(w: LiveWaiters, leader: number, when: Chain['when'], project = citadel.id, repo = live) {
  const f = w.follow(leader, when);
  assert.equal(f.state, 'wait');
  const follower = minion(project, repo).id;
  w.chain({ ticket: follower, after: leader, when, message: 'build part two', from: 'Taskmaster', base: f.base, since: f.since });
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

// #229: a squash (or rebase) merge on GitHub leaves none of the branch's commits on main, so a leader
// whose PR was merged that way read as dismissed without its work merged.
test('a leader whose PR was squash-merged counts as merged, and a held chain starts once its PR shows merged', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const follower = chain(w, leader.id, 'merged');
  live.work(leader.branch);
  squash(live, leader.branch);
  assert.throws(() => live.git('merge-base', '--is-ancestor', leader.branch, 'main'), 'none of its commits are on main');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(w.check(), 1);
  assert.equal(held.length, 0, 'no false alarm');
  assert.equal(started[0].c.ticket, follower);
  assert.match(started[0].why, /work is merged$/);

  // A chain held before its leader's PR showed as merged (#87's) starts at the next check.
  reset();
  const late = minion();
  chain(w, late.id, 'merged');
  live.work(late.branch);
  store.updateTicket(late.id, { status: 'closed' });
  assert.equal(w.check(), 0);
  assert.equal(held.length, 1);
  squash(live, late.branch);
  assert.equal(w.check(), 1);
});

test('GitHub\'s answers read as a merged PR or none', () => {
  const head = 'bd6f4c67cf2aac6092ffcb39fea1df1d43e024bd';
  const merge = '28f4915f1bdea4505501ed04412272a36941d760';
  assert.deepEqual(mergedPr([{ number: 204, state: 'MERGED', headRefOid: head, mergeCommit: { oid: merge } }]), { number: 204, head, commit: merge });
  assert.equal(mergedPr([{ number: 205, state: 'OPEN', headRefOid: head, mergeCommit: null }]), null, 'only the newest PR counts');
  assert.equal(mergedPr([]), null);
  const pulls = [
    { number: 3, merged_at: null, head: { sha: head }, merge_commit_sha: 'abc' },
    { number: 204, merged_at: '2026-10-31T21:12:16Z', head: { sha: head }, merge_commit_sha: merge },
  ];
  assert.deepEqual(mergedPrOf(pulls), { number: 204, head, commit: merge });
  assert.equal(mergedPrOf(pulls.slice(0, 1)), null);
});

test('a live chain on a squash-merged leader waits for the server to run the merge commit', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  chain(w, leader.id, 'live');
  live.work(leader.branch);
  squash(live, leader.branch);
  assert.equal(w.check(), 0, 'merged, but the server still runs the old commit');
  assert.equal(w.check(live.git('rev-parse', 'HEAD')), 1);
  assert.match(started[0].why, /work is live$/);
});

test('a leader that commits after its PR was squash-merged waits for that work; catching up to main is not work', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  // Its first PR, an hour back (the reflog stamps entries with the committer date).
  const old = { ...process.env, GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 3600} +0000` };
  const shipped = execFileSync('git', ['commit-tree', '-p', leader.branch, '-m', 'old work', 'main^{tree}'], { cwd: live.dir, encoding: 'utf8', env: old }).trim();
  execFileSync('git', ['update-ref', '-m', 'commit: old work', `refs/heads/${leader.branch}`, shipped], { cwd: live.dir, env: old });
  squash(live, leader.branch);
  chain(w, leader.id, 'merged');
  assert.equal(w.check(), 0, 'its merged PR is not new work');
  live.work(leader.branch);
  assert.equal(w.check(), 0, 'its newest commit is in no merged PR');
  squash(live, leader.branch);
  // Main moves on and the leader merges it in: a merge commit and main's commits, none of its own.
  live.commit();
  live.git('update-ref', '-m', 'merge main', `refs/heads/${leader.branch}`,
    live.git('commit-tree', '-p', `refs/heads/${leader.branch}`, '-p', 'main', '-m', 'merge main', 'main^{tree}'));
  assert.equal(w.check(), 1);
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

/** A commit with a real change on `branch`, made in its own worktree, as a minion commits. */
function own(repo: typeof live, branch: string, file: string) {
  const dir = join(root, `wt-${branch.replace('/', '-')}`);
  if (!existsSync(dir)) repo.git('worktree', 'add', '-q', dir, branch);
  writeFileSync(join(dir, file), file);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `own ${file}`], { cwd: dir });
  return repo.git('rev-parse', `refs/heads/${branch}`);
}
/** Land `commits` on main from a temporary branch, as one minion landed another's (#250 landing #247's): new hashes, same changes. */
function landElsewhere(repo: typeof live, commits: string[]) {
  repo.git('checkout', '-q', '-b', `tmp-${++branches}`, 'main');
  repo.commit(); // the lander's own work first, so the picks get new parents
  for (const c of commits) repo.git('cherry-pick', c);
  const tip = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--ff-only', tip);
}

// #261: a leader's commits landed by another minion from a temporary branch reach main with new
// hashes, so neither its tip nor a PR of its branch is on main: it read as still waiting, or as
// dismissed unshipped, until it happened to rebase.
for (const when of ['merged', 'live'] as const) {
  test(`a ${when} chain starts once all of the leader's commits are on main by their changes, landed from another branch`, () => {
    reset();
    const w = waiters(live.git('rev-parse', 'HEAD'));
    const leader = minion();
    chain(w, leader.id, when);
    const first = own(live, leader.branch, `${when}-a`);
    const second = own(live, leader.branch, `${when}-b`);
    landElsewhere(live, [first]);
    assert.equal(w.check(live.git('rev-parse', 'HEAD')), 0, 'only one of its two commits is in');
    landElsewhere(live, [second]);
    assert.throws(() => live.git('merge-base', '--is-ancestor', leader.branch, 'main'), 'its tip is not on main');
    store.updateTicket(leader.id, { status: 'closed' });
    if (when === 'live') {
      assert.equal(w.check(), 0, 'on main, but the server still runs the old commit');
      assert.equal(held.length, 0, 'not dismissed unshipped: its work is merged');
    }
    assert.equal(w.check(live.git('rev-parse', 'HEAD')), 1);
    assert.equal(held.length, 0);
    assert.match(started[0].why, new RegExp(`work is ${when}$`));
  });
}

test('a running leader whose branch has no commits of its own never counts, even on a stale base main has moved past', () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  live.commit(); // main moves on after the leader's branch was cut, as origin/main lags local main
  const follower = chain(w, leader.id, 'merged');
  live.commit();
  assert.equal(w.check(live.git('rev-parse', 'HEAD')), 0);
  live.git('update-ref', '-m', 'merge main: Fast-forward', `refs/heads/${leader.branch}`, 'main');
  assert.equal(w.check(live.git('rev-parse', 'HEAD')), 0, 'caught up to main: still nothing of its own');
  assert.equal(w.chains().length, 1);
  store.updateTicket(follower, { status: 'closed' });
  w.check();
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

test('through the server: start_after parks the minion with its brief held; the leader\'s dismissal or Start now starts it, a message only gets an answer; a brief is marked as one', async () => {
  const { base, cookie, proc } = await bootServer({ root });
  procs.push(proc);
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const messages = async (id: number) => (await call(`/api/tickets/${id}/events?after=0`)).data
    .filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data));
  const said = async (id: number) => (await messages(id)).map((m: any) => m.text);
  // The brief that starts a minion is marked, so the chat shows it unfolded; later messages aren't.
  const briefs = async (id: number) => (await messages(id)).map((m: any) => !!m.brief);
  const idle = async (id: number) => {
    while ((await call(`/api/tickets/${id}`)).data.ticket.status === 'running') await new Promise((r) => setTimeout(r, 20));
  };

  const { data: p } = await call('/api/projects', { name: 'Scheme' });
  const create = (title: string, extra: object) => call(`/api/projects/${p.id}/tickets`, { title, message: `brief for ${title}`, ...extra });
  const leader = (await create('Leader', {})).data;
  assert.deepEqual(await briefs(leader.id), [true]);

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
  assert.deepEqual(await briefs(next.data.id), [true]);

  // #261: writing to a chained minion before its leader is done gets an answer, and it stays parked
  // with its brief held (Cara, 2026-11-01: "Answer, keep it parked"); Start now starts it, brief and all.
  const later = (await create('Later', { start_after: next.data.number })).data;
  assert.equal(later.note, `starts when #${next.data.number} is live`);
  assert.equal(later.held, `#${next.data.number} Next's work is live`);
  assert.equal((await call(`/api/tickets/${leader.id}/start`, {})).status, 409, 'only a parked chained minion starts early');
  await call(`/api/tickets/${later.id}/messages`, { text: 'what is this?' });
  assert.deepEqual(await said(later.id), ['what is this?'], 'its brief is still held');
  await idle(later.id);
  const parked = (await call(`/api/tickets/${later.id}`)).data.ticket;
  assert.equal(parked.state, 'parked', 'its turn left it parked');
  assert.equal(parked.note, `starts when #${next.data.number} is live`);
  assert.equal(parked.held, `#${next.data.number} Next's work is live`);
  const started = await call(`/api/tickets/${later.id}/start`, {});
  assert.equal(started.status, 200);
  assert.equal(started.data.held, null);
  assert.deepEqual(await said(later.id), ['what is this?', 'brief for Later']);
  assert.deepEqual(await briefs(later.id), [false, true]);
  assert.equal((await call(`/api/tickets/${later.id}/start`, {})).status, 409, 'started once');
  await idle(later.id);
  await idle(next.data.id);
  await call(`/api/tickets/${next.data.id}/status`, { status: 'closed' });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await said(later.id), ['what is this?', 'brief for Later'], 'its leader shipping later sends nothing more');
});
