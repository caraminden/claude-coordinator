// relay_when_live on the one outbox (ADR 0021, step 2, #1388): a relay is a `relay` row; the check finds its commit live,
// the outbox hands it to deliver (held mail), a dismissed sender's or target's relay still goes, a kill mid-deliver
// resends once marked, and the old key's relays move into the table at boot.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Outbox, type OutboxRunner } from '../src/outbox.ts';
import { LiveWaiters, type Relay } from '../src/wake.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'relay-outbox-'));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, 'live');
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
let n = 0;
const commit = () => {
  writeFileSync(join(repo, 'f'), String(++n));
  git('add', '-A');
  git('commit', '-q', '-m', `c${n}`);
  return git('rev-parse', 'HEAD');
};

let store: Store;
let project: { id: number };
let k = 0;
let boxes: Outbox[] = [];
beforeEach(() => {
  store = new Store(join(root, `test${++k}.db`));
  project = store.createProject('P', null);
});
afterEach(() => {
  for (const b of boxes) b.stop();
  boxes = [];
});
const minion = () => store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
const T0 = Date.UTC(2026, 10, 14, 20, 0);

function server(head: string) {
  const r = { delivered: [] as Relay[], notes: [] as Relay[][], failFirst: false };
  const runner = { send: () => ({ event: { id: 1 } }), holds: () => false, onLane: (_i: number, _w: string, step: () => unknown) => Promise.resolve().then(step), leaveMail: () => {} };
  const outbox = new Outbox(store, runner as unknown as OutboxRunner, { author: 'Citadel', now: () => T0 });
  boxes.push(outbox);
  const waiters = new LiveWaiters(store, repo, head, () => assert.fail('legacy send'), outbox);
  waiters.deliver = (x) => {
    if (r.failFirst) throw new Error('mail failed');
    r.delivered.push(x);
  };
  waiters.sent = (x) => r.notes.push(x);
  return { r, outbox, waiters };
}
const rows = () => store.listDeliveries({ kind: 'relay' });

test('a relay is a row; its commit going live delivers it once and the sender gets one grouped note', async () => {
  const before = commit();
  const pending = commit();
  const [from, a, b] = [minion(), minion(), minion()];
  const s = server(before);
  await s.outbox.boot();
  for (const m of [a, b]) assert.equal((await s.waiters.addRelay({ ticket: from.id, to: { minion: m.id, number: m.number }, text: 'hi', commit: pending })).queued, true);
  assert.equal(rows().length, 2);
  assert.equal(s.waiters.relays(from.id).length, 2);
  assert.equal(await s.waiters.check(before), 0);
  await s.waiters.check(pending);
  await s.outbox.poke({ type: 'tick' });
  assert.deepEqual(s.r.delivered.map((x) => x.to), [{ minion: a.id, number: a.number }, { minion: b.id, number: b.number }]);
  assert.equal(s.r.notes.length, 1, 'one note for the pair');
  assert.equal(s.r.notes[0].length, 2);
  assert.equal(s.waiters.relays().length, 0);
  await s.waiters.check(pending);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.delivered.length, 2, 'once');
});

test('a dismissed target and a dismissed sender: the relay still goes out', async () => {
  const before = commit();
  const pending = commit();
  const [from, to] = [minion(), minion()];
  const s = server(before);
  await s.outbox.boot();
  await s.waiters.addRelay({ ticket: from.id, to: { minion: to.id, number: to.number }, text: 'x', commit: pending });
  store.updateTicket(from.id, { status: 'closed' });
  store.updateTicket(to.id, { status: 'closed' });
  await s.waiters.check(pending);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.delivered.length, 1);
});

test('a send that throws is retried; a kill mid-deliver resends once, marked', async () => {
  const before = commit();
  const pending = commit();
  const [from, to] = [minion(), minion()];
  const s = server(before);
  await s.outbox.boot();
  await s.waiters.addRelay({ ticket: from.id, to: { minion: to.id, number: to.number }, text: 'x', commit: pending });
  s.r.failFirst = true;
  await s.waiters.check(pending);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(rows()[0].state, 'waiting');
  assert.equal(rows()[0].attempts, 1);
  // The server dies after the mail was left but before the row was marked sent: the row is still `sending`.
  store.updateDelivery(rows()[0].id, { state: 'sending' });
  s.outbox.stop();
  const s2 = server(pending);
  await s2.outbox.boot();
  await s2.outbox.poke({ type: 'tick' });
  assert.equal(s2.r.delivered.length, 1);
  assert.equal(s2.r.delivered[0].repeat, true);
  assert.equal(rows()[0].state, 'sent');
  await s2.outbox.poke({ type: 'tick' });
  assert.equal(s2.r.delivered.length, 1, 'once more only');
});

test('relays in the old key move into the table at boot, none dropped, and cancel finds them', async () => {
  const c = commit();
  const [from, to] = [minion(), minion()];
  store.setSetting('relay-when-live', [
    { id: 7, ticket: from.id, to: { minion: to.id, number: to.number }, text: 'one', commit: c },
    { id: 9, ticket: from.id, to: { scheme: 'P', taskmaster: from.id }, text: 'two', commit: c },
  ]);
  const s = server(c);
  assert.equal(s.waiters.relays().length, 2, 'the dual read sees them before the move');
  await s.outbox.boot();
  assert.equal(store.getSetting('relay-when-live') ?? null, null);
  assert.deepEqual(rows().map((r) => [r.id, r.to_kind, r.payload.text]), [[7, 'minion', 'one'], [9, 'taskmaster', 'two']]);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(rows().length, 2, 'a second pass adds none');
  await s.waiters.check(c); // its commit is live already: sent
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.delivered.length, 2);
  assert.equal(s.r.notes.length, 2, 'two texts, two notes');
});

test('cancelRelay drops a pending row, only for its sender', async () => {
  const before = commit();
  const pending = commit();
  const [from, other, to] = [minion(), minion(), minion()];
  const s = server(before);
  await s.outbox.boot();
  const { relay } = await s.waiters.addRelay({ ticket: from.id, to: { minion: to.id, number: to.number }, text: 'x', commit: pending });
  assert.equal(s.waiters.cancelRelay(other.id, relay.id), null);
  assert.ok(s.waiters.cancelRelay(from.id, relay.id));
  assert.equal(s.waiters.relays().length, 0);
});
