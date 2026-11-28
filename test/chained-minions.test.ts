import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildOwnerKey, Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { type Chain, chainIs, githubPrs, LiveWaiters, mergedPr, mergedPrOf, missingCommits, type PrMerge, startChained } from '../src/wake.ts';
import { bootServer, holds, stopTurns, stopProcs, testPins } from './helpers.ts';
import { json, type Reply } from './typed.ts';
import { until } from './wait.ts';
testPins();

// Chained minions: one created parked, whose brief is held until the minion it follows (its leader)
// has its work live, or merged. A temp repo stands in for both the live checkout and the scheme's repo,
// as for Citadel's own scheme; a second repo stands in for a scheme whose code the server doesn't run.
const root = mkdtempSync(join(tmpdir(), 'chained-minions-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
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
  // As the server's start does once the follower's branch is caught up: the brief leaves the chain as it is sent.
  w.start = (c, why) => {
    started.push({ c, why });
    w.release(c.ticket);
  };
  w.hold = (c, why) => held.push({ c, why });
  return w;
}
/** Chain a new minion after `leader`, as the create endpoint does. */
async function chain(w: LiveWaiters, leader: number, when: Chain['when'], project = citadel.id, repo = live) {
  const f = await w.follow(leader, when);
  assert.equal(f.state, 'wait');
  const follower = minion(project, repo).id;
  w.chain({ ticket: follower, after: leader, when, message: 'build part two', from: 'Taskmaster', base: f.base, since: f.since });
  return follower;
}
const reset = () => {
  started.length = 0;
  held.length = 0;
  store.setSetting('chained-minions', []); // chains a failed test left behind don't fail the tests after it (#633)
};

test("a live chain waits through the merge and starts once the server runs the leader's work", async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const follower = await chain(w, leader.id, 'live');
  assert.equal(await w.check(), 0, 'no work of its own yet');

  live.work(leader.branch);
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(await w.check(), 0, 'merged, but the server still runs the old commit');
  assert.equal(w.chains().length, 1);

  assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 1, 'the restart onto it');
  assert.equal(started.length, 1);
  assert.equal(started[0].c.ticket, follower);
  assert.equal(started[0].c.message, 'build part two');
  assert.match(started[0].why, /^#\d+'s work is live$/);
  assert.equal(w.chains().length, 0);
  assert.equal(await w.check(), 0, 'started once');
});

test("a merged chain starts once the leader's work is on main, live or not", async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  await chain(w, leader.id, 'merged');
  live.work(leader.branch);
  assert.equal(await w.check(), 0, 'committed on its branch only');
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(await w.check(), 1);
  assert.match(started[0].why, /work has shipped$/);
});

// #126: a leader whose branch had no commits of its own started its follower once the branch was
// caught up to a newer main, since that tip was on main and wasn't the one the chain recorded.
for (const when of ['merged', 'live'] as const) {
  test(`a ${when} chain ignores a leader branch caught up to main, and starts on the leader's own landed commit`, async () => {
    reset();
    const w = waiters(live.git('rev-parse', 'HEAD'));
    const leader = minion();
    const dir = join(root, `wt-${leader.branch.replace('/', '-')}`);
    live.git('worktree', 'add', '-q', dir, leader.branch);
    const inTree = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    await chain(w, leader.id, when);

    live.commit(); // another minion lands, and the server restarts onto it
    inTree('merge', '-q', '--ff-only', 'main'); // the leader catches up: a new tip, on main, none of its own
    assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 0, 'an empty branch caught up to main is not work');
    assert.equal(w.chains().length, 1);

    writeFileSync(join(dir, 'g'), when);
    inTree('add', '-A');
    inTree('commit', '-q', '-m', 'own work');
    assert.equal(await w.check(), 0, 'committed but not merged');
    live.git('merge', '-q', '--ff-only', leader.branch); // as land.sh fast-forwards main
    if (when === 'live') assert.equal(await w.check(), 0, 'merged, but the server still runs the old commit');
    assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 1);
    assert.match(started[0].why, new RegExp(`work ${chainIs(when)}$`));
  });
}

test('a leader that shipped before the chain was set only counts once it commits again', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  // Its earlier work, an hour back: the reflog stamps entries with the committer date.
  const old = { ...process.env, GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 3600} +0000` };
  const shipped = execFileSync('git', ['commit-tree', '-p', 'main', '-m', 'old work', 'main^{tree}'], { cwd: live.dir, encoding: 'utf8', env: old }).trim();
  execFileSync('git', ['update-ref', '-m', 'commit: old work', `refs/heads/${leader.branch}`, shipped], { cwd: live.dir, env: old });
  live.git('merge', '-q', '--ff-only', leader.branch);
  await chain(w, leader.id, 'merged');
  live.commit();
  live.git('update-ref', '-m', 'merge main: Fast-forward', `refs/heads/${leader.branch}`, 'main');
  assert.equal(await w.check(), 0, 'its old work is not new work');
  live.work(leader.branch);
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(await w.check(), 1);
});

test('a leader dismissed without its work merged holds the chain and tells people once; it starts if the work lands after all', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const follower = await chain(w, leader.id, 'merged');
  assert.equal(w.wakesOn(follower), w.heldFor(follower), 'waiting on its leader: it wakes by itself');
  live.work(leader.branch);
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(await w.check(), 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].c.ticket, follower);
  assert.match(held[0].why, /^#\d+ was dismissed without its work shipping$/);
  assert.equal(await w.check(), 0);
  assert.equal(held.length, 1, 'told once');
  assert.equal((await w.follow(leader.id, 'merged')).state, 'unshipped', 'nothing new can chain on it');
  assert.match(w.heldFor(follower)!, /^#\d+ T's work has shipped, and #\d+ T was dismissed without it, so only Unseal starts you$/);
  assert.equal(w.wakesOn(follower), null, 'held: nothing wakes it by itself, so the list shows it under Parked (#718)');

  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(await w.check(), 1);
  assert.equal(started[0].c.ticket, follower);
});

// Build branches (#592): a feeder merges into build/<n> and closes. That is merged as far as it goes alone,
// so a merged chain starts, and a live one waits for the build to land rather than being held as unshipped.
test('a feeder merged into its build and dismissed is merged for a chain, and live once the build lands', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  live.git('branch', 'build/7', 'main');
  const merged = minion();
  const forLive = minion();
  store.updateTicket(merged.id, { build: 7 });
  store.updateTicket(forLive.id, { build: 7 });
  const afterMerged = await chain(w, merged.id, 'merged');
  const afterLive = await chain(w, forLive.id, 'live');
  for (const t of [merged, forLive]) {
    // tools/land.sh --into build/7: the branch is rebased onto build/7's tip, then the build fast-forwards to it.
    // Rebase first (#633): two feeders committing on main's tip were one commit only when made in the same second.
    live.git('update-ref', `refs/heads/${t.branch}`, live.git('rev-parse', 'build/7'));
    live.git('update-ref', 'refs/heads/build/7', live.work(t.branch));
    store.updateTicket(t.id, { status: 'closed' });
  }
  assert.equal(await w.check(), 1);
  assert.deepEqual([started.map((s) => s.c.ticket), held.length], [[afterMerged], 0], 'merged starts, live waits, nothing held');
  assert.match(started[0].why, /work is merged into Plot 7$/, 'in its build, not landed');
  live.git('merge', '-q', '--ff-only', 'build/7'); // the build lands
  assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 1);
  assert.deepEqual(
    started.map((s) => s.c.ticket),
    [afterMerged, afterLive],
  );

  // In a scheme whose code this server doesn't run, live means merged: in the build is enough.
  reset();
  other.git('branch', 'build/3', 'main');
  const feeder = minion(delve.id, other);
  store.updateTicket(feeder.id, { build: 3 });
  const follower = await chain(w, feeder.id, 'live', delve.id, other);
  other.git('update-ref', 'refs/heads/build/3', other.work(feeder.branch));
  store.updateTicket(feeder.id, { status: 'closed' });
  assert.equal(await w.check(), 1);
  assert.deepEqual([started.map((s) => s.c.ticket), held.length], [[follower], 0]);
});

// A build's own minion (its owner) is not a feeder: its work sitting on build/<n> says nothing about the build
// reaching main, so a merged chain on it holds until the build ships (create_ticket start_after on a build owner).
test('a merged chain on a build owner waits for the build to ship to main; a feeder in the same build still goes', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  live.git('branch', 'build/8', 'main');
  const owner = minion();
  const feeder = minion();
  store.updateTicket(owner.id, { build: 8 });
  store.updateTicket(feeder.id, { build: 8 });
  store.setSetting(buildOwnerKey(citadel.id, 8), owner.id);
  for (const t of [owner, feeder]) {
    live.git('update-ref', `refs/heads/${t.branch}`, live.git('rev-parse', 'build/8'));
    live.git('update-ref', 'refs/heads/build/8', live.work(t.branch));
  }
  const f = await w.follow(owner.id, 'merged');
  assert.equal(f.state, 'wait', 'at create time: the owner is on build/8, not on main');
  assert.equal((await w.follow(feeder.id, 'merged')).state, 'go', 'a feeder merged into its build is done');
  const follower = minion().id;
  w.chain({ ticket: follower, after: owner.id, when: 'merged', message: 'part two', from: 'Taskmaster', base: f.base, since: f.since });
  assert.equal(await w.check(), 0, 'later: still waiting');
  assert.match(w.heldFor(follower) ?? '', /waits for Plot 8 to ship/);
  live.git('merge', '-q', '--ff-only', 'build/8'); // the build ships
  assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 1);
  assert.equal(started[0].c.ticket, follower);
});

// #229: a squash (or rebase) merge on GitHub leaves none of the branch's commits on main, so a leader
// whose PR was merged that way read as dismissed without its work merged.
test('a leader whose PR was squash-merged counts as merged, and a held chain starts once its PR shows merged', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const follower = await chain(w, leader.id, 'merged');
  live.work(leader.branch);
  squash(live, leader.branch);
  assert.throws(() => live.git('merge-base', '--is-ancestor', leader.branch, 'main'), 'none of its commits are on main');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(await w.check(), 1);
  assert.equal(held.length, 0, 'no false alarm');
  assert.equal(started[0].c.ticket, follower);
  assert.match(started[0].why, /work has shipped$/);

  // A chain held before its leader's PR showed as merged (#87's) starts at the next check.
  reset();
  const late = minion();
  await chain(w, late.id, 'merged');
  live.work(late.branch);
  store.updateTicket(late.id, { status: 'closed' });
  assert.equal(await w.check(), 0);
  assert.equal(held.length, 1);
  squash(live, late.branch);
  assert.equal(await w.check(), 1);
});

// #321: Threadspace merges PRs on GitHub, in a private repo only its owner's login can read, and the
// server's own fetch can't reach it either, so its local main and origin/main both lag. Asking GitHub
// as the box's login found nothing, and the leader read as dismissed without its work merged.
test("a leader squash-merged into origin/main only, in a repo only the scheme owner's login can read, counts as merged", async () => {
  reset();
  const remote = join(root, 'obsidian.git');
  execFileSync('git', ['clone', '-q', '--bare', other.dir, remote]);
  const scheme = join(root, 'obsidian');
  execFileSync('git', ['clone', '-q', remote, scheme]);
  const sg = (...args: string[]) => execFileSync('git', args, { cwd: scheme, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Its origin is on GitHub, out of the server's reach: nothing merged there reaches this clone.
  sg('remote', 'set-url', 'origin', 'https://github.com/josh/obsidian.git');
  const threadspace = store.createProject('Threadspace', null);
  store.setProjectRepoDir(threadspace.id, scheme);
  const repo = { dir: scheme, git: sg, commit: () => '', work: other.work };
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion(threadspace.id, repo);
  const follower = await chain(w, leader.id, 'merged', threadspace.id, repo);
  sg('switch', '-q', leader.branch);
  writeFileSync(join(scheme, 'docs'), 'one');
  sg('add', '-A');
  sg('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one');
  writeFileSync(join(scheme, 'docs'), 'two');
  sg('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'two');
  const tip = sg('rev-parse', 'HEAD');
  sg('switch', '-q', 'main');
  // GitHub squash-merges its PR: origin's main gets one new commit, none of the branch's.
  const merger = join(root, 'merger');
  execFileSync('git', ['clone', '-q', remote, merger]);
  const mg = (...args: string[]) => execFileSync('git', args, { cwd: merger, encoding: 'utf8' }).trim();
  mg('fetch', '-q', scheme, `${leader.branch}:${leader.branch}`);
  mg('merge', '--squash', '-q', leader.branch);
  mg('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'Squashed (#10)');
  mg('push', '-q', 'origin', 'main');
  const merge = mg('rev-parse', 'HEAD');
  assert.throws(() => sg('cat-file', '-e', `${merge}^{commit}`), "the scheme's clone has not got the merge");

  // gh as the box runs it: GitHub only answers the owner's token.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const answer = join(root, 'pr-list.json');
  writeFileSync(answer, JSON.stringify([{ number: 10, state: 'MERGED', headRefOid: tip, mergeCommit: { oid: merge } }]));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ "$GH_TOKEN" = owner-token ] && [ "$1 $2" = "pr list" ] || { echo 'GraphQL: Could not resolve to a Repository' >&2; exit 1; }\ncat '${answer}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    w.prs = githubPrs((dir) => (dir === scheme ? { GH_TOKEN: 'owner-token' } : undefined));
    store.updateTicket(leader.id, { status: 'closed' });
    assert.equal(await w.check(), 1);
    assert.equal(held.length, 0, 'no "dismissed without its work shipping"');
    assert.equal(started[0].c.ticket, follower);
  } finally {
    process.env.PATH = path;
  }
});

test("GitHub's answers read as a merged PR or none", async () => {
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

test('a live chain on a squash-merged leader waits for the server to run the merge commit', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  await chain(w, leader.id, 'live');
  live.work(leader.branch);
  squash(live, leader.branch);
  assert.equal(await w.check(), 0, 'merged, but the server still runs the old commit');
  assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 1);
  assert.match(started[0].why, /work is live$/);
});

test('a leader that commits after its PR was squash-merged waits for that work; catching up to main is not work', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  // Its first PR, an hour back (the reflog stamps entries with the committer date).
  const old = { ...process.env, GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 3600} +0000` };
  const shipped = execFileSync('git', ['commit-tree', '-p', leader.branch, '-m', 'old work', 'main^{tree}'], { cwd: live.dir, encoding: 'utf8', env: old }).trim();
  execFileSync('git', ['update-ref', '-m', 'commit: old work', `refs/heads/${leader.branch}`, shipped], { cwd: live.dir, env: old });
  squash(live, leader.branch);
  await chain(w, leader.id, 'merged');
  assert.equal(await w.check(), 0, 'its merged PR is not new work');
  live.work(leader.branch);
  assert.equal(await w.check(), 0, 'its newest commit is in no merged PR');
  squash(live, leader.branch);
  // Main moves on and the leader merges it in: a merge commit and main's commits, none of its own.
  live.commit();
  live.git('update-ref', '-m', 'merge main', `refs/heads/${leader.branch}`, live.git('commit-tree', '-p', `refs/heads/${leader.branch}`, '-p', 'main', '-m', 'merge main', 'main^{tree}'));
  assert.equal(await w.check(), 1);
});

test('a leader with no commits of its own counts as done once dismissed', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  await chain(w, leader.id, 'live');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(await w.check(), 1);
  assert.equal(held.length, 0);
});

test("a chained minion's brief stays held until its start sends it: a start that never gets there isn't repeated, and runs again after a restart (#468 S04-5)", async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  w.start = (c, why) => started.push({ c, why }); // still catching up its branch when the server dies
  const leader = minion();
  const follower = await chain(w, leader.id, 'live');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal(await w.check(), 1);
  assert.deepEqual(
    w.chains().map((c) => c.message),
    ['build part two'],
    'the brief is still stored',
  );
  assert.equal(await w.check(), 0, 'not started twice while its start runs');

  const restarted = waiters(live.git('rev-parse', 'HEAD'));
  assert.equal(await restarted.check(), 1, 'a restart starts it again');
  assert.equal(started.at(-1)!.c.ticket, follower);
  assert.equal(restarted.chains().length, 0, 'gone once sent');
  assert.equal(await restarted.check(), 0);
});

test('a deploy wakes every waiter whose commit is live even when one send throws, and wakes none twice (#468 S04-5)', async () => {
  const head = live.git('rev-parse', 'HEAD');
  const got: number[] = [];
  const w = new LiveWaiters(store, live.dir, head, (id) => {
    if (id === a) throw new Error('send failed');
    got.push(id);
  });
  const a = minion().id;
  const b = minion().id;
  await w.add(a, null, 'first');
  await w.add(b, null, 'second');
  live.commit();
  await assert.doesNotReject(w.check(live.git('rev-parse', 'HEAD')));
  assert.deepEqual(got, [b]);
  assert.deepEqual(
    w.list().filter((x) => x.ticket === a || x.ticket === b),
    [],
    'dropped before sending: none woken twice',
  );
});

test('a leader already live when the chain is set starts it at once', async () => {
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  live.work(leader.branch);
  live.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  w.head = w.proven = live.git('rev-parse', 'HEAD');
  store.updateTicket(leader.id, { status: 'closed' });
  assert.equal((await w.follow(leader.id, 'live')).state, 'go');
});

test('in a scheme whose code the server does not run, live means merged', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion(delve.id, other);
  await chain(w, leader.id, 'live', delve.id, other);
  other.work(leader.branch);
  other.git('merge', '-q', '--no-ff', '-m', 'merge', leader.branch);
  assert.equal(await w.check(), 1);
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
  test(`a ${when} chain starts once all of the leader's commits are on main by their changes, landed from another branch`, async () => {
    reset();
    const w = waiters(live.git('rev-parse', 'HEAD'));
    const leader = minion();
    await chain(w, leader.id, when);
    const first = own(live, leader.branch, `${when}-a`);
    const second = own(live, leader.branch, `${when}-b`);
    landElsewhere(live, [first]);
    assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 0, 'only one of its two commits is in');
    landElsewhere(live, [second]);
    assert.throws(() => live.git('merge-base', '--is-ancestor', leader.branch, 'main'), 'its tip is not on main');
    store.updateTicket(leader.id, { status: 'closed' });
    if (when === 'live') {
      assert.equal(await w.check(), 0, 'on main, but the server still runs the old commit');
      assert.equal(held.length, 0, 'not dismissed unshipped: its work has shipped');
    }
    assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 1);
    assert.equal(held.length, 0);
    assert.match(started[0].why, new RegExp(`work ${chainIs(when)}$`));
  });
}

test('a running leader whose branch has no commits of its own never counts, even on a stale base main has moved past', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  live.commit(); // main moves on after the leader's branch was cut, as origin/main lags local main
  const follower = await chain(w, leader.id, 'merged');
  live.commit();
  assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 0);
  live.git('update-ref', '-m', 'merge main: Fast-forward', `refs/heads/${leader.branch}`, 'main');
  assert.equal(await w.check(live.git('rev-parse', 'HEAD')), 0, 'caught up to main: still nothing of its own');
  assert.equal(w.chains().length, 1);
  store.updateTicket(follower, { status: 'closed' });
  await w.check();
});

test('a dismissed follower is dropped; release hands back the held brief once', async () => {
  reset();
  const w = waiters(live.git('rev-parse', 'HEAD'));
  const leader = minion();
  const dropped = await chain(w, leader.id, 'live');
  store.updateTicket(dropped, { status: 'closed' });
  await w.check();
  assert.equal(w.chains().length, 0);

  const follower = await chain(w, leader.id, 'live');
  assert.equal(w.release(follower)?.message, 'build part two');
  assert.equal(w.release(follower), null);
  assert.equal(w.chains().length, 0);
  assert.equal(started.length, 0);
});

test('a turn answering a parked minion ends with it parked as before, whatever state the turn set', async () => {
  const fake = join(root, 'claude-slow');
  writeFileSync(
    fake,
    `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'answered' }));
  process.exit(0);
}, 300));
`,
  );
  chmodSync(fake, 0o755);
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  runner.heldFor = (id) => (id === t.id ? "#1 Leader's work has shipped" : null);
  const t = store.createTicket({ project_id: citadel.id, title: 'Parked', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', state: 'parked', note: 'starts when #1 has shipped' });
  runner.send(t.id, 'Cara', 'what is this?');
  for (let i = 0; store.getTicket(t.id)!.status !== 'running'; i++) {
    assert.ok(i < 250, 'the turn starts');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(store.getTicket(t.id)!.state, 'parked', 'kept through the turn');
  store.updateTicket(t.id, { state: 'ready', note: 'answered' }); // as the minion's set_thread_status would
  for (let i = 0; store.getTicket(t.id)!.status === 'running'; i++) {
    assert.ok(i < 500, 'the turn ends');
    await new Promise((r) => setTimeout(r, 20));
  }
  const after = store.getTicket(t.id)!;
  assert.equal(after.status, 'idle');
  assert.deepEqual([after.state, after.note], ['parked', 'starts when #1 has shipped']);
});

test("a chained minion's branch is caught up after the turn running in its worktree ends, never under it, and before its brief's turn (#468 S07-2)", async () => {
  const release = join(root, 'release-s07-2');
  const fake = join(root, 'claude-held');
  writeFileSync(
    fake,
    `#!${process.execPath}
const { existsSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  const t = setInterval(() => {
    if (!existsSync(${JSON.stringify(release)})) return;
    clearInterval(t);
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'answered' }));
    process.exit(0);
  }, 20);
});
`,
  );
  chmodSync(fake, 0o755);
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  const { id, branch } = minion();
  const cwd = join(root, `wt-${id}`);
  live.git('worktree', 'add', '-q', cwd, branch);
  store.setTicketDir(id, cwd, branch);
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const said = () =>
    store
      .listEvents(id)
      .filter((e) => e.kind === 'user_message')
      .map((e) => JSON.parse(e.data).text);
  const wait = async (what: string, ok: () => boolean) => {
    for (let i = 0; !ok(); i++) {
      assert.ok(i < 500, what);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // A parked minion answers a message; meanwhile its leader's work lands on main and Start now is pressed.
  runner.send(id, 'Cara', 'what is this?');
  await wait('the turn starts', () => runner.isRunning(id));
  const before = head();
  const landed = live.commit();
  const w = new LiveWaiters(store, live.dir, landed, () => {});
  w.chain({ ticket: id, after: 0, when: 'merged', message: 'build part two', from: 'Taskmaster', base: before, since: 0 });
  await startChained(w.claim(id)!, 'Cara started it', { store, runner, waiters: w });
  await holds('the worktree and the brief stay put while its turn runs', () => head() === before && said().length === 1, { ms: 300 });
  assert.equal(head(), before, 'the worktree stays put while its turn runs');
  assert.deepEqual(said(), ['what is this?'], 'the brief waits too');

  writeFileSync(release, '');
  await wait('the brief is sent', () => said().length === 2);
  assert.equal(head(), landed, 'caught up before the brief');
  assert.deepEqual(said(), ['what is this?', 'build part two']);
  await wait('its turn ends', () => !runner.isRunning(id));
  assert.equal(w.claim(id), null, 'the chain is gone once sent');
});

test("Start now hears when the brief couldn't be sent, and the brief stays held for the next try (#468 S07-2)", async () => {
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/false',
  );
  const { id } = minion();
  const w = new LiveWaiters(store, live.dir, live.commit(), () => {});
  w.chain({ ticket: id, after: 0, when: 'merged', message: 'build part two', from: 'Taskmaster', base: null, since: 0 });
  runner.send = () => {
    throw new Error('disk full');
  };
  await assert.rejects(startChained(w.claim(id)!, 'Cara started it', { store, runner, waiters: w }), /disk full/);
  assert.ok(w.claim(id), 'held again');
});

test("through the server: start_after parks the minion with its brief held; the leader's dismissal or Unpark starts it, a message is held for that start; a brief is marked as one", async () => {
  const { base, cookie, proc } = await bootServer({ root });
  procs.push(proc);
  // The parts of the API's answers these tests read.
  type Answer = {
    id: number;
    number: number;
    state: string;
    note: string;
    notes: string[];
    parked_for: string | null;
    wakes_on: string;
    held: string;
    held_brief: { text: string; leader: number; when: string; is: string } | null;
    error: string;
    ticket: { status: string; state: string; note: string; parked_for: string; wakes_on: string; held_brief: { text: string; leader: number; when: string; is: string } };
  };
  const call = async <T = Answer>(path: string, body?: unknown): Promise<Reply<T>> => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await json<T>(res) };
  };
  const messages = async (id: number) => (await call<{ kind: string; data: string }[]>(`/api/tickets/${id}/events?after=0`)).data.filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data) as { text: string; brief?: boolean; parked?: boolean });
  const said = async (id: number) => (await messages(id)).map((m) => m.text);
  // The brief that starts a minion is marked, so the chat shows it unfolded; later messages aren't.
  const briefs = async (id: number) => (await messages(id)).map((m) => !!m.brief);
  const idle = async (id: number) => {
    await until('the ticket to stop running', async () => (await call(`/api/tickets/${id}`)).data.ticket.status !== 'running');
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
  assert.equal(next.data.note, `starts when #${leader.number} has shipped`);
  assert.ok(next.data.notes.some((n: string) => n.startsWith('Sealed: it starts by itself')));
  assert.deepEqual(await said(next.data.id), [], 'its brief is held');

  // A note left for it is held (#718) and doesn't hold up the start: it goes in after the brief.
  assert.equal((await call(`/api/tickets/${next.data.id}/messages`, { text: 'note for later' })).data.held, 'parked');

  // No repo, so the leader's dismissal is what it waits for.
  await idle(leader.id);
  assert.equal((await call(`/api/tickets/${leader.id}/status`, { status: 'closed' })).status, 200);
  for (const end = Date.now() + 5000; (await said(next.data.id)).length < 2; await new Promise((r) => setTimeout(r, 20))) {
    // #963: this timed out once in CI (not reproduced, a CPU quota of 8% included), so it says how far the start got.
    if (Date.now() > end) {
      const row = async (id: number) => (({ status, state, note }) => ({ status, state, note }))((await call(`/api/tickets/${id}`)).data.ticket);
      throw new Error(`The chained minion never started: ${JSON.stringify({ leader: await row(leader.id), next: await row(next.data.id), said: await said(next.data.id) })}`);
    }
  }
  assert.deepEqual(await said(next.data.id), ['note for later', 'brief for Next']);
  assert.deepEqual(await briefs(next.data.id), [false, true]);

  // #718 (Cara, 2026-11-14: "Parked minions should not wake on being sent a message"): writing to a chained
  // minion before its leader is done is held, unread, and starts no turn (#261's answer-and-stay-parked is
  // gone); Unpark starts it, brief first and the held message after it.
  const later = (await create('Later', { start_after: next.data.number })).data;
  assert.equal(later.note, `starts when #${next.data.number} is live`);
  assert.equal(later.parked_for, `#${next.data.number} Next's work is live`);
  assert.equal((await call(`/api/tickets/${leader.id}/start`, {})).status, 409, 'only a parked chained minion starts early');
  assert.equal((await call(`/api/tickets/${leader.id}/unpark`, {})).status, 409, 'only a parked minion unparks');
  const sent = await call(`/api/tickets/${later.id}/messages`, { text: 'what is this?' });
  assert.equal(sent.status, 202);
  assert.equal(sent.data.held, 'parked');
  assert.deepEqual(await said(later.id), ['what is this?'], 'shown in the chat as held');
  assert.equal((await messages(later.id))[0].parked, true);
  const parked = (await call(`/api/tickets/${later.id}`)).data.ticket;
  assert.notEqual(parked.status, 'running', 'no turn for it');
  assert.equal(parked.state, 'parked');
  assert.equal(parked.parked_for, `#${next.data.number} Next's work is live`);
  assert.equal(parked.wakes_on, parked.parked_for, 'its leader going live wakes it: the list shows it under Waiting (#718)');
  // #728: its ticket view carries the brief it holds (read-only in the chat), and not once it is sent.
  assert.equal(parked.held_brief.text, 'brief for Later');
  assert.equal(parked.held_brief.leader, next.data.number);
  assert.equal(parked.held_brief.when, 'live');
  assert.equal(parked.held_brief.is, 'is live', "the chat says the wait in the server's words");
  const started = await call(`/api/tickets/${later.id}/unpark`, {});
  assert.equal(started.status, 200);
  assert.equal(started.data.held_brief, null, 'sent: no longer shown as held');
  assert.equal(started.data.parked_for, null);
  assert.notEqual(started.data.state, 'parked');
  assert.deepEqual(await said(later.id), ['what is this?', 'brief for Later']);
  assert.deepEqual(await briefs(later.id), [false, true]);
  assert.equal((await call(`/api/tickets/${later.id}/unpark`, {})).status, 409, 'unparked once');
  assert.equal((await call(`/api/tickets/${later.id}/start`, {})).status, 409, 'started once');
  await idle(later.id);
  await idle(next.data.id);
  await call(`/api/tickets/${next.data.id}/status`, { status: 'closed' });
  await holds('its leader shipping later sends nothing more', async () => (await said(later.id)).length === 2, { ms: 200 });
  assert.deepEqual(await said(later.id), ['what is this?', 'brief for Later'], 'its leader shipping later sends nothing more');
});

test('a "not merged" answer GitHub gave before forget() is not remembered: the next check asks again (#526)', async () => {
  const dir = join(root, 'forgetful');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/cara/forgetful.git'], { cwd: dir });
  // gh answers "no PR" slowly the first time, and a merged PR from then on.
  const bin = join(root, 'forgetful-bin');
  mkdirSync(bin);
  const asked = join(root, 'forgetful-asked');
  const mergedAnswer = JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: 'a'.repeat(40), mergeCommit: { oid: 'b'.repeat(40) } }]);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ -e '${asked}' ]; then echo '${mergedAnswer}'; else touch '${asked}'; sleep 0.5; echo '[]'; fi\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const lookup = githubPrs();
    const first = lookup.branch(dir, 'work', 'a'.repeat(40));
    await until('gh is answering', () => existsSync(asked)); // the PR merges and its minion is dismissed
    lookup.forget!();
    assert.equal(await first, null);
    assert.equal((await lookup.branch(dir, 'work', 'a'.repeat(40)))?.number, 7, 'asked again, not answered from the stale "not merged"');
  } finally {
    process.env.PATH = path;
  }
});

test('a commit GitHub says it has not got (422, a branch commit rebased away) is not asked about again, even by a new lookup after a restart (#1454)', async () => {
  const dir = join(root, 'rebased-away');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/cara/rebased.git'], { cwd: dir });
  const bin = join(root, 'rebased-bin');
  mkdirSync(bin);
  const asked = join(root, 'rebased-asked');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho x >> '${asked}'\necho 'gh: No commit found for SHA: ${'c'.repeat(40)} (HTTP 422)' >&2\nexit 1\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const db = join(root, 'rebased-away.db');
  let clock = Date.now();
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const ask = () =>
      githubPrs(
        () => undefined,
        missingCommits(new Store(db), () => clock),
      ).commit(dir, 'c'.repeat(40)); // a new store and lookup each time, as after a restart
    const asks = () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').length : 0);
    assert.equal(await ask(), null);
    assert.equal(await ask(), null);
    assert.equal(asks(), 1, 'GitHub asked once');
    clock += 86_400_001;
    await ask();
    assert.equal(asks(), 2, 'asked again a day on: it may have been pushed since');
  } finally {
    process.env.PATH = path;
  }
});
