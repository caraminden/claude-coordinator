import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { APP_NAME } from '../src/appname.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { LiveWaiters, type PrMerge } from '../src/wake.ts';
import { bootServer, REPO, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
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
  writeFileSync(
    fake,
    `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
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
  const id = minion();
  store.setTicketDir(id, root, null);
  const w = new LiveWaiters(store, repo, git('rev-parse', 'HEAD'), (t, text) => runner.send(t, APP_NAME, text));
  for (let i = 0; i < 10; i++) {
    await w.add(id, null, `wake ${i}`);
    await w.check(commit());
    await until('the turn to stop', async () => !runner.isRunning(id));
  }
  const said = store
    .listEvents(id)
    .filter((e) => e.kind === 'user_message')
    .map((e) => JSON.parse(e.data));
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
  const withBranch = (state: Parameters<Store['updateTicket']>[1]['state'], branch: string | null) => {
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
  // #590: its only commit dropped by a rebase, as main already had the same change: none of its work is live.
  git('checkout', '-q', '-b', 'ticket/vanished');
  writeFileSync(join(repo, 'same.txt'), 'same');
  git('add', '-A');
  git('commit', '-q', '-m', 'same, by the minion');
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'same.txt'), 'same');
  git('add', '-A');
  git('commit', '-q', '-m', 'same, by another minion');
  git('checkout', '-q', 'ticket/vanished');
  git('rebase', '-q', 'main');
  git('checkout', '-q', 'main');
  withBranch('pending-deploy', 'ticket/vanished');
  assert.deepEqual((await waiters(git('rev-parse', 'HEAD')).pendingLive()).sort(), [shipped, unmerged, picked].sort(), 'not the rebased-away branch');
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
  // gh as GitHub on a slow day: it answers only once the test's event loop has seen it running (a timer wrote `seen`),
  // or after 5 s if the loop never turns. Waiting on the loop itself, not on a clock: a wall-clock limit on the loop's
  // longest gap failed on a loaded runner, where the process just had no CPU for 237 ms (#1825).
  const bin = join(root, 'slow-bin');
  mkdirSync(bin);
  const asked = join(bin, 'asked');
  const seen = join(bin, 'seen');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n: > '${asked}'\ni=0\nwhile [ ! -e '${seen}' ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done\necho "[]"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const w = new LiveWaiters(store, dir, head, () => {});
  // The loop turning while gh runs: a timer that fires between gh's start and its answer.
  const beat = setInterval(() => {
    if (existsSync(asked) && !existsSync(seen)) writeFileSync(seen, '');
  }, 10);
  try {
    // A scheme of its own: other tests give the shared one a repo this server doesn't run.
    const scheme = store.createProject('Slow', null);
    store.setProjectRepoDir(scheme.id, dir);
    const t = store.createTicket({ project_id: scheme.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { status: 'idle' });
    store.setSetting('wake-when-live', [{ ticket: t.id, commit: work, reason: 'x', since: head }]);
    assert.equal(await w.check(), 0);
    assert.ok(existsSync(asked), 'the check did ask the slow gh');
    assert.ok(existsSync(seen), 'the event loop did not turn while gh ran: the check blocked it');
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
    // Wait for the ask itself: the check runs git first, which took more than a fixed 100 ms on a loaded runner (#1825).
    await until('the first check to wait on GitHub', () => asked === 2);
    await w.add(late, null, 'the next deploy');
    const second = w.check();
    assert.equal(w.check(), second, 'a third call shares the check that has not started');
    assert.equal(asked, 2, 'which waits for the first to end');
    answer();
    assert.equal(await first, 0);
    assert.deepEqual(
      w.list().map((o) => o.ticket),
      [slow, late],
      'the first check kept the waiter added while it ran',
    );
    assert.equal(await second, 0);
    assert.equal(await w.check(commit()), 1, 'and the next deploy wakes it');
    assert.deepEqual(
      sent.map((s) => s.id),
      [late],
    );
  } finally {
    store.setSetting('wake-when-live', []);
  }
});

test('a waiter set while a deploy goes live is checked against the new commit, not stored to wait for the one after (#526)', async () => {
  const old = commit();
  const work = commit();
  const w = waiters(old);
  // The live checkout doesn't run `work` yet, so add() asks GitHub; the deploy lands while it answers.
  w.prs = {
    branch: () => null,
    commit: async () => {
      if (w.head === old) await w.check(work);
      return null;
    },
  };
  assert.equal(await w.add(minion(), work, 'x'), false, 'live by the time it was set');
  assert.equal(w.list().length, 0);
});

// A deploy's restart is rolled back when it doesn't stay up: until deploy.sh tags it last-good, a minion closed or told "live" over it was misled.
test('nothing goes live on a restart that can still be rolled back; a settled one does all it held', async () => {
  store.setProjectRepoDir(project.id, repo);
  store.setSetting('wake-when-live', []);
  mkdirSync(join(repo, '.git', 'cc-deploy'), { recursive: true });
  const good = commit();
  git('tag', '-f', 'last-good', good);
  git('checkout', '-q', '-b', 'ticket/on-trial');
  const head = commit();
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'ticket/on-trial');
  const shipper = minion();
  store.setTicketDir(shipper, root, 'ticket/on-trial');
  store.updateTicket(shipper, { state: 'pending-deploy' });
  const [byCommit, nextDeploy, onGood, early] = [minion(), minion(), minion(), minion()];
  const boot = () => Object.assign(waiters(head), { proven: null });
  const relayed: string[] = [];
  const heard = (w: LiveWaiters) => ((w.deliver = (r) => relayed.push(r.text)), w);
  sent.length = 0;
  try {
    const bad = heard(boot());
    assert.equal(await bad.add(early, null, 'asked before the first look'), true);
    let verdict: boolean | null = null;
    const proving = bad.prove(5).then((v) => (verdict = v));
    await until('it knows the restart is on trial', () => bad.proven === good);
    assert.equal(await bad.add(byCommit, head, 'try it'), true, 'its commit is not live yet');
    assert.equal(await bad.add(nextDeploy, null, 'look again'), true);
    assert.equal(await bad.add(onGood, good, 'old news'), false, 'what last-good holds is live whatever happens');
    assert.equal((await bad.addRelay({ ticket: shipper, commit: head, text: 'shipped', to: { scheme: 'P', taskmaster: shipper } })).queued, true);
    assert.equal(await bad.check(), 0);
    assert.equal((await bad.pendingLive()).includes(shipper), false, 'a pending-deploy minion waits too');
    assert.equal(verdict, null);

    // Rolled back: the server boots on last-good, and nobody hears "live".
    const back = heard(Object.assign(waiters(good), { proven: null }));
    assert.equal(await back.prove(5), true);
    assert.equal(await back.check(), 0);
    assert.deepEqual([sent, relayed], [[], []]);
    assert.equal((await back.pendingLive()).includes(shipper), false);

    // Settled instead: deploy.sh tags it, and everything held happens.
    git('tag', '-f', 'last-good', head);
    await proving;
    assert.equal(verdict, true);
    assert.equal(await bad.check(), 3);
    assert.deepEqual(sent.map((s) => s.id).sort(), [byCommit, nextDeploy, early].sort());
    assert.deepEqual(relayed, ['shipped']);
    assert.equal((await bad.pendingLive()).includes(shipper), true);
  } finally {
    git('tag', '-d', 'last-good');
    store.updateTicket(shipper, { state: null });
    store.setSetting('wake-when-live', []);
    store.setSetting('relay-when-live', []);
  }
});

test('a look that git fails leaves a boot unproven, and the next one settles it', async () => {
  mkdirSync(join(repo, '.git', 'cc-deploy'), { recursive: true });
  const good = commit();
  git('tag', '-f', 'last-good', good);
  const PATH = process.env.PATH;
  try {
    const w = Object.assign(waiters(commit()), { proven: 'not looked yet' as string | null });
    process.env.PATH = '/nonexistent';
    const proving = w.prove(5);
    await until('a look to fail', () => w.proven !== 'not looked yet');
    assert.equal(w.proven, null);
    process.env.PATH = PATH;
    await until('on trial', () => w.proven === good);
    git('tag', '-f', 'last-good', w.head!);
    assert.equal(await proving, true);
  } finally {
    process.env.PATH = PATH;
    git('tag', '-d', 'last-good');
  }
});

test('a restart on last-good is proven at once, a roll back once it is tagged, one whose deploy died before its tag after a while, and a newer commit ends the wait', async () => {
  mkdirSync(join(repo, '.git', 'cc-deploy'), { recursive: true });
  const good = commit();
  git('tag', '-f', 'last-good', good);
  try {
    const again = Object.assign(waiters(good), { proven: null as string | null });
    assert.equal(await again.prove(60_000), true, 'a crash restart of code that settled long ago');
    assert.equal(again.proven, again.head);
    const back = git('rev-parse', 'HEAD~1'); // an explicit roll back's target, live before last-good was (#1271)
    const rolling = Object.assign(waiters(back), { proven: good as string | null });
    const tried = rolling.prove(5);
    await until('asked', () => rolling.proven !== good);
    assert.equal(rolling.proven, null, 'a roll back on trial can itself be undone: not live yet');
    git('tag', '-f', 'last-good', back);
    assert.equal(await tried, true);
    assert.equal(rolling.proven, back);
    git('tag', '-f', 'last-good', good);
    const orphan = Object.assign(waiters(commit()), { proven: null as string | null });
    assert.equal(await orphan.prove(5, 50), true);
    assert.equal(orphan.proven, orphan.head);
    const moved = Object.assign(waiters(commit()), { proven: null as string | null });
    const proving = moved.prove(5);
    await until('on trial', () => moved.proven === good);
    const next = commit();
    await moved.check(next); // a front-end deploy reloads the server onto a newer commit
    assert.equal(await proving, false);
    assert.equal(moved.proven, next);
  } finally {
    git('tag', '-d', 'last-good');
  }
});

test('through the server: a minion in pending-deploy stays open on a restart that can be rolled back, and is dismissed once it settles', async () => {
  // A live checkout of its own (a cc-deploy folder, a last-good tag behind its head), running the code under test.
  const live = join(root, 'live-server');
  execFileSync('git', ['clone', '-q', '--shared', REPO, live]);
  cpSync(join(REPO, 'src'), join(live, 'src'), { recursive: true });
  copyFileSync(join(REPO, 'server.ts'), join(live, 'server.ts'));
  const lg = (...args: string[]) => execFileSync('git', args, { cwd: live, encoding: 'utf8' }).trim();
  lg('config', 'user.email', 't@example.com');
  lg('config', 'user.name', 'T');
  lg('tag', '-f', 'last-good', 'HEAD');
  mkdirSync(join(live, '.git', 'cc-deploy'));
  lg('checkout', '-q', '-b', 'ticket/ships');
  lg('commit', '-q', '--allow-empty', '-m', 'the work');
  const boot = join(root, 'boot-trial');
  mkdirSync(join(boot, 'data'), { recursive: true });
  const seed = new Store(join(boot, 'data', 'coordinator.db'));
  const p = seed.createProject('Citadel', null);
  seed.setProjectRepoDir(p.id, live);
  const t = seed.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  seed.setTicketDir(t.id, root, 'ticket/ships');
  seed.updateTicket(t.id, { status: 'idle', state: 'pending-deploy' });
  const waits = seed.createTicket({ project_id: p.id, title: 'W', permission_mode: 'default', created_by: 'Cara' });
  const { call, stop } = await bootServer({ root: boot, script: join(live, 'server.ts') });
  try {
    const asked = await call(`/api/tickets/${waits.id}/wake`, { commit: lg('rev-parse', 'HEAD'), reason: 'try it' });
    assert.deepEqual([asked.status, asked.data.waiting], [201, true], 'the running commit is not live while it can be rolled back');
    assert.equal(seed.getTicket(t.id)!.status, 'idle');
    lg('tag', '-f', 'last-good', 'HEAD');
    await until('it is dismissed', () => seed.getTicket(t.id)!.status === 'closed');
  } finally {
    await stop();
  }
});
