import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { APP_NAME } from '../src/appname.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { LiveWaiters, type PrMerge } from '../src/wake.ts';
import { bootServer, REPO, stopTurns, testPins } from './helpers.ts';
testPins();

// wake_when_live: a waiter is messaged once the server runs a commit containing its commit (or, with
// none, once the server runs anything new), then dropped. A stand-in live checkout in a temp repo.
const root = mkdtempSync(join(tmpdir(), 'wake-when-live-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const repo = join(root, 'live');
mkdirSync(join(repo, 'public'), { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
let n = 0;
function commit(file = 'server.ts'): string {
  writeFileSync(join(repo, file), String(++n));
  git('add', '-A');
  git('commit', '-q', '-m', `c${n}`);
  return git('rev-parse', 'HEAD');
}

const store = new Store(join(root, 'test.db'));
const project = store.createProject('P', null);
function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { status: 'idle' });
  return t.id;
}
const sent: { id: number; text: string }[] = [];
const waiters = (head: string) => new LiveWaiters(store, repo, head, (id, text) => sent.push({ id, text }));

test('a waiter on a commit that is not live keeps waiting, and is woken at startup once it is', async () => {
  const running = commit();
  const pending = commit(); // merged and pulled, but the server hasn't restarted onto it yet
  const id = minion();
  sent.length = 0;
  const before = waiters(running);
  assert.equal(await before.add(id, pending, 'retry the tripwire test'), true);
  assert.equal(await before.check(), 0);
  assert.equal(before.list().length, 1);

  // The restart: a new server boots on a later commit, which contains `pending`.
  const after = waiters(commit());
  assert.equal(await after.check(), 1);
  assert.deepEqual(sent, [{ id, text: `\`${pending.slice(0, 7)}\` is live now (the server runs \`${after.head!.slice(0, 7)}\`): retry the tripwire test` }]);
  assert.equal(after.list().length, 0);
  assert.equal(await after.check(), 0, 'woken once');
  assert.equal(sent.length, 1);
});

test('a commit that is already live is not stored', async () => {
  const live = commit();
  const w = waiters(commit());
  assert.equal(await w.add(minion(), live, 'x'), false);
  assert.equal(w.list().length, 0);
});

test('a commit the live checkout has not fetched yet keeps waiting', async () => {
  const w = waiters(commit());
  sent.length = 0;
  await w.add(minion(), 'f'.repeat(40), 'x');
  assert.equal(await w.check(), 0);
  assert.equal(w.list().length, 1);
  store.setSetting('wake-when-live', []);
});

test('a waiter with no commit is woken by the next deploy, front-end only included, not by a no-op', async () => {
  const w = waiters(commit());
  const id = minion();
  sent.length = 0;
  assert.equal(await w.add(id, null, 'check the new sidebar'), true);
  assert.equal(await w.check(w.head), 0, 'the same commit is no deploy');
  const fe = commit('public/app.js'); // the SIGHUP reload after a front-end-only deploy
  assert.equal(await w.check(fe), 1);
  assert.deepEqual(sent, [{ id, text: `A deploy is live now (the server runs \`${fe.slice(0, 7)}\`): check the new sidebar` }]);
});

test('a dismissed waiter is dropped without a message', async () => {
  const pending = commit();
  const w = waiters(git('rev-parse', 'HEAD~1'));
  const id = minion();
  sent.length = 0;
  await w.add(id, pending, 'x');
  store.updateTicket(id, { status: 'closed' });
  assert.equal(await w.check(commit()), 0);
  assert.deepEqual(sent, []);
  assert.equal(w.list().length, 0);
});

test('resolve accepts hashes the live checkout or the scheme repo knows, and nothing else', async () => {
  const c = commit();
  const w = waiters(c);
  assert.equal(await w.resolve(c.slice(0, 7), null), c);
  assert.equal(await w.resolve('--all', null), null);
  assert.equal(await w.resolve('HEAD', null), null);
  assert.equal(await w.resolve('0000000', null), null);
});

test('wake messages go through the runner without counting toward or being held by the loop guard', async () => {
  const fake = join(root, 'claude-fake');
  writeFileSync(fake, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
  chmodSync(fake, 0o755);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const id = minion();
  store.setTicketDir(id, root, null);
  const w = new LiveWaiters(store, repo, git('rev-parse', 'HEAD'), (t, text) => runner.send(t, APP_NAME, text));
  for (let i = 0; i < 10; i++) {
    await w.add(id, null, `wake ${i}`);
    await w.check(commit());
    while (runner.isRunning(id)) await new Promise((r) => setTimeout(r, 10));
  }
  const said = store.listEvents(id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data));
  assert.equal(said.length, 10);
  assert.ok(said.every((m) => m.author === APP_NAME));
  assert.equal(store.getSetting(`loop:${id}`), null);
});

/** A scheme repo this server doesn't run (Delve's, say), with one commit on branch ticket/x not yet on main. */
function otherScheme(name: string) {
  const other = join(root, name);
  mkdirSync(other);
  const og = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8' }).trim();
  og('init', '-q', '-b', 'main');
  og('config', 'user.email', 't@example.com');
  og('config', 'user.name', 'T');
  og('commit', '-q', '--allow-empty', '-m', 'o1');
  og('checkout', '-q', '-b', 'ticket/x');
  og('commit', '-q', '--allow-empty', '-m', 'o2');
  const work = og('rev-parse', 'HEAD');
  og('checkout', '-q', 'main');
  return { other, og, work };
}

test('in a scheme whose code this server does not run, a commit waiter wakes once the commit is on its main', async () => {
  // #150: a Delve commit resolved in Delve's repo, but live() checked it against the live checkout, so it never fired.
  const { other, og, work } = otherScheme('other');
  const delve = store.createProject('D', null);
  store.setProjectRepoDir(delve.id, other);
  const t = store.createTicket({ project_id: delve.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { status: 'idle' });
  const w = waiters(commit());
  assert.equal(await w.elsewhere(t.id), other, 'so the route refuses a wait with no commit');
  sent.length = 0;
  assert.equal(await w.add(t.id, work, 'play the new level'), true);
  assert.equal(await w.check(), 0, 'not merged yet');
  og('merge', '-q', '--ff-only', 'ticket/x');
  assert.equal(await w.check(), 1);
  assert.deepEqual(sent, [{ id: t.id, text: `\`${work.slice(0, 7)}\` is on the scheme's main now: play the new level` }]);
  assert.equal(await w.add(t.id, work, 'x'), false, 'already merged');
  assert.equal(w.list().length, 0);
});

test('in a scheme whose code this server does not run, a commit waiter wakes once a PR containing it is merged, squashed or not', async () => {
  // #229: a squash merge puts none of the branch's commits on main.
  const { other, og, work } = otherScheme('other-squash');
  const delve = store.createProject('D squashed', null);
  store.setProjectRepoDir(delve.id, other);
  const t = store.createTicket({ project_id: delve.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { status: 'idle' });
  const w = waiters(commit());
  let merged: PrMerge | null = null;
  w.prs = { branch: () => null, commit: (_repo, c) => (c === work ? merged : null) };
  sent.length = 0;
  assert.equal(await w.add(t.id, work, 'play the new level'), true);
  assert.equal(await w.check(), 0, 'not merged yet');
  og('commit', '-q', '--allow-empty', '-m', 'squashed ticket/x');
  merged = { number: 1, head: work, commit: og('rev-parse', 'HEAD') };
  assert.equal(await w.check(), 1);
  assert.deepEqual(sent, [{ id: t.id, text: `\`${work.slice(0, 7)}\` is on the scheme's main now: play the new level` }]);
});

test('through the server, in a scheme it does not run: no commit is refused, a commit of its own is waited on until merged', async () => {
  const boot = join(root, 'boot');
  mkdirSync(join(boot, 'data'), { recursive: true });
  const { other, work } = otherScheme('other-boot');
  const seed = new Store(join(boot, 'data', 'coordinator.db'));
  const delve = seed.createProject('D', null);
  seed.setProjectRepoDir(delve.id, other);
  const t = seed.createTicket({ project_id: delve.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const { call, stop } = await bootServer({ root: boot });
  try {
    const none = await call(`/api/tickets/${t.id}/wake`, { reason: 'x' });
    assert.equal(none.status, 400);
    assert.equal(none.data.error, "This scheme has no deploys; give the commit you're waiting on");
    const ours = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); // the booted server's own commit
    assert.equal((await call(`/api/tickets/${t.id}/wake`, { commit: ours, reason: 'x' })).status, 400);
    const r = await call(`/api/tickets/${t.id}/wake`, { commit: work.slice(0, 7), reason: 'x' });
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.waiting, r.data.commit, r.data.merged], [true, work, true]);
  } finally {
    await stop();
  }
});

test('pending-deploy minions whose branch the live commit contains are found, whoever deployed it', async () => {
  // #81: a deploy reports only to the minions that ran it, so one waiting on a commit that went live
  // in someone else's restart stayed pending-deploy.
  store.setProjectRepoDir(project.id, repo);
  const withBranch = (state: any, branch: string | null) => {
    const id = minion();
    store.setTicketDir(id, root, branch);
    store.updateTicket(id, { state });
    return id;
  };
  // #261: a branch with no commits of its own is on main trivially, which says nothing about its deploy.
  git('branch', 'ticket/empty');
  withBranch('pending-deploy', 'ticket/empty');
  git('checkout', '-q', '-b', 'ticket/live');
  commit();
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'ticket/live');
  const shipped = withBranch('pending-deploy', 'ticket/live');
  const merged = commit(); // merged to main after the branch was cut: still contains it
  git('checkout', '-q', '-b', 'ticket/unmerged');
  commit();
  git('checkout', '-q', 'main');
  const unmerged = withBranch('pending-deploy', 'ticket/unmerged');
  // Its commit landed by another minion from a temporary branch: a new hash, the same change.
  git('checkout', '-q', '-b', 'ticket/picked', 'ticket/unmerged');
  const pick = commit('picked.txt');
  git('checkout', '-q', 'main');
  const picked = withBranch('pending-deploy', 'ticket/picked');
  withBranch(null, 'ticket/live'); // not waiting on a deploy
  withBranch('pending-deploy', 'ticket/gone'); // no such branch
  withBranch('pending-deploy', null);
  const closed = withBranch('pending-deploy', 'ticket/live');
  store.updateTicket(closed, { status: 'closed' });
  assert.deepEqual(await waiters(merged).pendingLive(), [shipped]);
  assert.deepEqual(await waiters('f'.repeat(40)).pendingLive(), [], 'a head the repo does not know');
  git('merge', '-q', '--no-edit', 'ticket/unmerged');
  assert.deepEqual((await waiters(git('rev-parse', 'HEAD')).pendingLive()).sort(), [shipped, unmerged].sort(), 'not the empty branch, nor one with a commit main lacks');
  git('cherry-pick', pick);
  assert.deepEqual((await waiters(git('rev-parse', 'HEAD')).pendingLive()).sort(), [shipped, unmerged, picked].sort());
});

test('a waiter on a scheme-repo commit that lands rebased wakes once the live checkout runs the landed copy (#468 S04-1)', async () => {
  // The live checkout pulls only main, so the branch's own hash never reaches it: check it in the scheme's repo.
  const scheme = join(root, 'scheme-rebased');
  execFileSync('git', ['clone', '-q', repo, scheme]);
  const sg = (...args: string[]) => execFileSync('git', args, { cwd: scheme, encoding: 'utf8' }).trim();
  sg('config', 'user.email', 't@example.com');
  sg('config', 'user.name', 'T');
  sg('checkout', '-q', '-b', 'ticket/r');
  writeFileSync(join(scheme, 'rebased.txt'), 'work');
  sg('add', '-A');
  sg('commit', '-q', '-m', 'the work');
  const work = sg('rev-parse', 'HEAD');
  sg('checkout', '-q', 'main');
  writeFileSync(join(scheme, 'other.txt'), 'meanwhile');
  sg('add', '-A');
  sg('commit', '-q', '-m', 'main moved on');
  const p = store.createProject('Rebased', null);
  store.setProjectRepoDir(p.id, scheme);
  const t = store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { status: 'idle' });
  const w = waiters(git('rev-parse', 'HEAD'));
  w.prs = { branch: () => null, commit: () => null };
  sent.length = 0;
  assert.equal(await w.add(t.id, work, 'try the rebased work'), true);
  assert.equal(await w.check(), 0, 'not landed yet');
  sg('cherry-pick', work); // landed rebased: a new hash, the same change
  git('pull', '-q', '--ff-only', scheme, 'main'); // the deploy pulls main only
  assert.equal(await w.check(git('rev-parse', 'HEAD')), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /is live now/);
  assert.equal(w.list().length, 0);
});

test('a check leaves the event loop free while git and gh run (#526)', async () => {
  // A repo of its own, with its origin on GitHub and a commit of a minion's that is not live: the check asks gh about it.
  const dir = join(root, 'slow');
  mkdirSync(dir);
  const sg = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  sg('init', '-q', '-b', 'main');
  sg('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
  const head = sg('rev-parse', 'HEAD');
  sg('switch', '-q', '-c', 'work');
  writeFileSync(join(dir, 'f'), 'x');
  sg('add', '-A');
  sg('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'work');
  const work = sg('rev-parse', 'HEAD');
  sg('remote', 'add', 'origin', 'https://github.com/cara/slow.git');
  // gh as GitHub on a slow day: its answer takes a second.
  const bin = join(root, 'slow-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nsleep 1\necho "[]"\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const w = new LiveWaiters(store, dir, head, () => {});
  let last = performance.now();
  let gap = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 10);
  try {
    // A scheme of its own: other tests give the shared one a repo this server doesn't run.
    const scheme = store.createProject('Slow', null);
    store.setProjectRepoDir(scheme.id, dir);
    const t = store.createTicket({ project_id: scheme.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { status: 'idle' });
    store.setSetting('wake-when-live', [{ ticket: t.id, commit: work, reason: 'x', since: head }]);
    last = performance.now();
    gap = 0;
    const began = performance.now();
    assert.equal(await w.check(), 0);
    assert.ok(performance.now() - began >= 1000, 'the check did ask the slow gh');
    await new Promise((r) => setTimeout(r, 30)); // a beat after it, so a stall that ended with the check is counted
    assert.ok(gap < 500, `the event loop stalled for ${Math.round(gap)} ms during the check`);
  } finally {
    clearInterval(beat);
    process.env.PATH = path;
    store.setSetting('wake-when-live', []);
  }
});

test('checks run one at a time, and a waiter added while one runs is kept (#526)', async () => {
  const w = waiters(commit());
  const slow = minion();
  const late = minion();
  sent.length = 0;
  // GitHub answers the first check only when the test lets it.
  let answer!: () => void;
  let asked = 0;
  w.prs = { branch: () => null, commit: () => (++asked === 2 ? new Promise<null>((r) => (answer = () => r(null))) : null) };
  try {
    await w.add(slow, 'f'.repeat(40), 'x'); // asks once
    const first = w.check(); // asks again, and waits on GitHub
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(asked, 2, 'the first check is waiting on GitHub');
    await w.add(late, null, 'the next deploy');
    const second = w.check();
    assert.equal(w.check(), second, 'a third call shares the check that has not started');
    assert.equal(asked, 2, 'which waits for the first to end');
    answer();
    assert.equal(await first, 0);
    assert.deepEqual(w.list().map((o) => o.ticket), [slow, late], 'the first check kept the waiter added while it ran');
    assert.equal(await second, 0);
    assert.equal(await w.check(commit()), 1, 'and the next deploy wakes it');
    assert.deepEqual(sent.map((s) => s.id), [late]);
  } finally {
    store.setSetting('wake-when-live', []);
  }
});
