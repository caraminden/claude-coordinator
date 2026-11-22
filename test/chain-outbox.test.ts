// Start-after chains on the one outbox (ADR 0021, step 3, #1389): a chain is a row the check meets once the leader's work
// is in, and the outbox starts the follower with its brief on its lane. A kill mid-send starts it once more, marked; a
// chain held for a leader dismissed unshipped stays held across a restart; the old `chained-minions` key moves into the
// table with every leader kept; Start now and Unpark take the row, so the brief goes once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Lanes } from '../src/lanes.ts';
import { HOLD_MS, Outbox, type OutboxRunner } from '../src/outbox.ts';
import { type Chain, chainedStep, LiveWaiters, startChained } from '../src/wake.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'chain-outbox-'));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
writeFileSync(join(repo, 'f'), '0');
git('add', '-A');
git('commit', '-q', '-m', 'c0');
/** A commit on `branch` only, made without checking it out; its reflog line is the one git commit writes. */
const work = (branch: string) => {
  const c = git('commit-tree', '-p', `refs/heads/${branch}`, '-m', 'work', `refs/heads/${branch}^{tree}`);
  git('update-ref', '-m', 'commit: work', `refs/heads/${branch}`, c);
  return c;
};
const merge = (branch: string) => git('merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);

let store: Store;
let project: { id: number };
let k = 0;
let branches = 0;
beforeEach(() => {
  store = new Store(join(root, `test${++k}.db`));
  project = store.createProject('P', null);
  store.setProjectRepoDir(project.id, repo);
});
/** A minion with a branch off main, in a worktree of its own (a chained start catches it up there). */
const minion = () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const branch = `ticket/${++branches}`;
  const dir = join(root, `wt${branches}`);
  git('worktree', 'add', '-q', '-b', branch, dir, 'main');
  store.setTicketDir(t.id, dir, branch);
  store.updateTicket(t.id, { status: 'idle' });
  return { id: t.id, branch, dir, number: store.getTicket(t.id)!.number };
};
const T0 = Date.UTC(2026, 10, 21, 20, 0);
let boxes: Outbox[] = [];
afterEach(() => {
  for (const b of boxes) b.stop();
  boxes = [];
});

/** A server on the shared store: a fake runner (real lanes, sends saved as events), its outbox and waiters, wired as server.ts does. */
function server() {
  const lanes = new Lanes();
  const r = { sent: [] as { id: number; text: string; brief: boolean; event: number }[], notes: [] as { id: number; text: string }[], held: [] as { c: Chain; why: string }[], fail: false };
  const runner = {
    send: (id: number, author: string, text: string, _i?: unknown, extra?: { brief?: boolean }) => {
      if (r.fail) throw new Error('send failed');
      const event = store.addEvent(id, 'user_message', { author, text }).id;
      r.sent.push({ id, text, brief: !!extra?.brief, event });
      return { event: { id: event } };
    },
    holds: () => false,
    onLane: (id: number, what: string, step: () => unknown) => lanes.run(id, what, step),
    leaveMail: () => {},
    emit: (id: number, _kind: string, data: { text: string }) => r.notes.push({ id, text: data.text }),
    isRunning: () => false,
  };
  const now = { t: T0 };
  const outbox = new Outbox(store, runner as unknown as OutboxRunner, { author: 'Citadel', now: () => now.t });
  boxes.push(outbox);
  const waiters = new LiveWaiters(store, repo, null, () => assert.fail('the legacy send'), outbox);
  waiters.prs = { branch: () => null, commit: () => null };
  waiters.hold = (c, why) => r.held.push({ c, why });
  waiters.sendBrief = (c, why, repeat) => chainedStep(c, why, { store, runner: runner as never }, repeat);
  const start = (c: Chain, why: string) => startChained(c, why, { store, runner: runner as never, waiters });
  return { r, now, outbox, waiters, start };
}

/** Chain a new minion after `leader`, as the create endpoint does. */
async function chain(w: LiveWaiters, leader: number, when: Chain['when'] = 'merged') {
  const f = await w.follow(leader, when);
  assert.equal(f.state, 'wait');
  const follower = minion();
  w.chain({ ticket: follower.id, after: leader, when, message: 'build part two', from: 'Taskmaster', base: f.base, since: f.since });
  return follower;
}
const rows = (id?: number) => store.listDeliveries({ kind: 'chain', ...(id != null ? { to: id } : {}) });

test('a chain is a row: met once the leader\'s work is in, and the outbox starts the follower with its brief, caught up', async () => {
  const s = server();
  await s.outbox.boot();
  const leader = minion();
  const follower = await chain(s.waiters, leader.id);
  const [row] = rows(follower.id);
  assert.equal(row.state, 'waiting');
  assert.equal(row.when_kind, 'merged');
  assert.equal(row.payload.message, 'build part two');
  assert.equal(store.getSetting('chained-minions'), null, 'nothing in the old key');
  assert.match(s.waiters.heldFor(follower.id)!, /^#\d+ T's work has shipped$/);
  assert.equal(await s.waiters.check(), 0, 'nothing of the leader\'s yet');

  work(leader.branch);
  merge(leader.branch);
  assert.equal(await s.waiters.check(), 1);
  await s.outbox.poke({ type: 'tick' });
  assert.deepEqual(s.r.sent.map((x) => [x.id, x.text, x.brief]), [[follower.id, 'build part two', true]], 'the brief, plain, once');
  assert.deepEqual(s.r.notes.map((x) => x.text), [`#${leader.number}'s work has shipped, so this minion started.`]);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: follower.dir, encoding: 'utf8' }).trim(), git('rev-parse', 'main'), 'caught up to main first');
  assert.equal(s.waiters.heldFor(follower.id), null, 'handed: no longer held');
  assert.equal(rows(follower.id)[0].state, 'sending', 'not sent until its turn starts');
  s.outbox.turnStarted(follower.id, [s.r.sent[0].event]);
  assert.equal(rows(follower.id)[0].state, 'sent');
  assert.equal(await s.waiters.check(), 0);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.sent.length, 1, 'once');
});

test('a kill after sending starts the follower once, with the possible-repeat line in its brief', async () => {
  const s1 = server();
  await s1.outbox.boot();
  const leader = minion();
  const follower = await chain(s1.waiters, leader.id);
  const [row] = rows(follower.id);
  // The outbox claimed it (met, sending) and the server died before the brief went out.
  store.updateDelivery(row.id, { state: 'sending', met_at: T0, due: T0, payload: { ...row.payload, why: `#${leader.number}'s work has shipped` } });
  s1.outbox.stop();

  const s2 = server();
  s2.now.t = T0 + 60_000;
  await s2.outbox.boot();
  assert.deepEqual(s2.r.sent.map((x) => [x.id, x.text, x.brief]), [[follower.id, `build part two\n\n(The server restarted while sending this, so it may repeat delivery #${row.id}.)`, true]]);
  assert.deepEqual(s2.r.notes.map((x) => x.text), [`#${leader.number}'s work has shipped, so this minion started.`]);
  s2.outbox.turnStarted(follower.id, [s2.r.sent[0].event]);
  assert.equal(await s2.waiters.check(), 0);
  await s2.outbox.poke({ type: 'tick' });
  assert.equal(s2.r.sent.length, 1, 'started once');
  assert.equal(rows(follower.id)[0].state, 'sent');
});

test('a kill after the brief\'s turn started sends nothing again', async () => {
  const s1 = server();
  await s1.outbox.boot();
  const leader = minion();
  const follower = await chain(s1.waiters, leader.id);
  const [row] = rows(follower.id);
  const event = store.addEvent(follower.id, 'user_message', { author: 'Taskmaster', text: 'build part two' }).id;
  store.updateDelivery(row.id, { state: 'sending', met_at: T0, due: T0 + 300_000, event_id: event });
  store.addEvent(follower.id, 'claude', { type: 'system', subtype: 'init' });
  s1.outbox.stop();

  const s2 = server();
  await s2.outbox.boot();
  assert.equal(s2.r.sent.length, 0);
  assert.equal(rows(follower.id)[0].state, 'sent');
});

test('a held chain stays held across a restart, told once, and starts if the work lands after all', async () => {
  const s1 = server();
  await s1.outbox.boot();
  const leader = minion();
  const follower = await chain(s1.waiters, leader.id);
  work(leader.branch);
  store.updateTicket(leader.id, { status: 'closed' });
  await s1.outbox.poke({ type: 'closed', ticket: leader.id });
  assert.equal(await s1.waiters.check(), 0);
  assert.equal(s1.r.held.length, 1);
  assert.match(s1.r.held[0].why, /^#\d+ was dismissed without its work shipping$/);
  assert.equal(rows(follower.id)[0].state, 'held');
  assert.match(s1.waiters.heldFor(follower.id)!, /so only Unseal starts you$/);
  assert.equal(s1.waiters.wakesOn(follower.id), null);
  assert.equal(await s1.waiters.check(), 0);
  assert.equal(s1.r.held.length, 1, 'told once');
  s1.outbox.stop();

  const s2 = server();
  s2.now.t = T0 + 4 * HOLD_MS; // past any 3-day hold: this one is held for its leader, not a dismissed target
  await s2.outbox.boot();
  await s2.outbox.poke({ type: 'reopened', ticket: follower.id });
  assert.equal(await s2.waiters.check(), 0);
  assert.equal(s2.r.held.length, 0, 'not told again');
  assert.equal(s2.r.sent.length, 0);
  assert.equal(rows(follower.id)[0].state, 'held');
  assert.match(s2.waiters.heldFor(follower.id)!, /so only Unseal starts you$/);

  merge(leader.branch);
  assert.equal(await s2.waiters.check(), 1);
  await s2.outbox.poke({ type: 'tick' });
  assert.deepEqual(s2.r.sent.map((x) => [x.id, x.text]), [[follower.id, 'build part two']]);
});

test('the old chained-minions key moves into the table in one go, held flags and every leader kept', async () => {
  const s = server();
  const leaders = [minion(), minion(), minion()];
  const followers = [minion(), minion(), minion()];
  store.updateTicket(followers[2].id, { status: 'closed' });
  const old: Chain[] = [
    { ticket: followers[0].id, after: leaders[0].id, when: 'live', message: 'one', from: 'Taskmaster', base: null, since: 100 },
    { ticket: followers[1].id, after: leaders[1].id, when: 'merged', message: 'two', from: 'Cara', base: null, held: true },
    { ticket: followers[2].id, after: leaders[2].id, when: 'merged', message: 'three', from: 'Taskmaster', base: 'abc', since: 200 },
    { ticket: 99_999, after: leaders[0].id, when: 'merged', message: 'gone', from: 'Taskmaster', base: null },
  ];
  store.setSetting('chained-minions', old);
  const open = followers.slice(0, 2).map((f) => f.id);
  // The dual read: before the move, the readers see the old key.
  const before = open.map((id) => [s.waiters.heldFor(id), s.waiters.heldBrief(id)?.text]);
  assert.match(String(before[1][0]), /so only Unseal starts you$/);
  assert.deepEqual(before.map((b) => b[1]), ['one', 'two']);

  await s.outbox.boot();
  assert.equal(store.getSetting('chained-minions'), null, 'emptied');
  assert.deepEqual(open.map((id) => [s.waiters.heldFor(id), s.waiters.heldBrief(id)?.text]), before, 'no parked minion loses its leader');
  const strip = (c: Chain) => ({ ticket: c.ticket, after: c.after, when: c.when, message: c.message, from: c.from, base: c.base, since: c.since, held: !!c.held });
  assert.deepEqual(s.waiters.chains().map(strip), old.slice(0, 3).map(strip), 'each chain kept, a missing follower\'s dropped as the old check did');
  const [a, b, c] = rows();
  assert.equal(a.state, 'waiting');
  assert.equal(b.state, 'held', 'held for its leader');
  assert.equal(c.state, 'held', 'a dismissed follower\'s: the 3-day rule');
  assert.equal(c.reason, 'target closed');
  assert.equal(s.r.held.length, 0, 'the held one was told before: not again');

  // A chain written to the old key again (a dev seed) for a follower already in the table moves without a duplicate.
  store.setSetting('chained-minions', [old[0]]);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(store.getSetting('chained-minions'), null);
  assert.equal(rows(followers[0].id).length, 1);
});

test('Start now takes the row: the brief goes once, a check meanwhile leaves it, and a failed send puts it back', async () => {
  const s = server();
  await s.outbox.boot();
  const leader = minion();
  const follower = await chain(s.waiters, leader.id);
  const c = s.waiters.claim(follower.id);
  assert.ok(c);
  assert.equal(s.waiters.claim(follower.id), null, 'one start at a time');
  assert.ok(s.waiters.heldFor(follower.id), 'still held until its brief is sent');
  work(leader.branch);
  merge(leader.branch);
  assert.equal(await s.waiters.check(), 0, 'a start runs: the check leaves it');

  s.r.fail = true;
  await assert.rejects(s.start(c!, 'Cara started it before its leader\'s work was in'), /send failed/);
  assert.equal(rows(follower.id)[0].state, 'waiting', 'put back');
  assert.ok(s.waiters.heldFor(follower.id));
  s.r.notes.length = 0; // the start note goes just before the send, as it did before the outbox: a send that throws leaves it

  s.r.fail = false;
  const again = s.waiters.claim(follower.id);
  assert.ok(again);
  await s.start(again!, 'Cara started it before its leader\'s work was in');
  assert.deepEqual(s.r.sent.map((x) => [x.id, x.text, x.brief]), [[follower.id, 'build part two', true]]);
  assert.deepEqual(s.r.notes.map((x) => x.text), ['Cara started it before its leader\'s work was in, so this minion started.']);
  assert.equal(s.waiters.heldFor(follower.id), null);
  assert.equal(s.waiters.heldBrief(follower.id), null);
  assert.equal(await s.waiters.check(), 0);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.sent.length, 1, 'once');
});

test('a dismissed follower\'s chain is held 3 days and goes on after a reopen, then dropped if none', async () => {
  const s = server();
  await s.outbox.boot();
  const leader = minion();
  const follower = await chain(s.waiters, leader.id);
  store.updateTicket(follower.id, { status: 'closed' });
  await s.outbox.poke({ type: 'closed', ticket: follower.id });
  assert.equal(rows(follower.id)[0].state, 'held');
  assert.equal(rows(follower.id)[0].reason, 'target closed');
  store.updateTicket(follower.id, { status: 'idle' });
  await s.outbox.poke({ type: 'reopened', ticket: follower.id });
  assert.equal(rows(follower.id)[0].state, 'waiting');
  work(leader.branch);
  merge(leader.branch);
  assert.equal(await s.waiters.check(), 1);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.sent.length, 1);

  const other = await chain(s.waiters, minion().id);
  store.updateTicket(other.id, { status: 'closed' });
  await s.outbox.poke({ type: 'closed', ticket: other.id });
  s.now.t += HOLD_MS + 1;
  await s.outbox.poke({ type: 'tick' });
  assert.equal(rows(other.id)[0].state, 'dropped');

  // A deleted follower's chain goes at the next check, as the old key's did (no row is left waiting for good).
  const gone = await chain(s.waiters, minion().id);
  store.deleteTicket(gone.id);
  await s.waiters.check();
  assert.deepEqual([rows(gone.id)[0].state, rows(gone.id)[0].reason], ['dropped', 'its minion was deleted']);
});
