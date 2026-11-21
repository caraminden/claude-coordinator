// wake_when_live on the one outbox (ADR 0021, step 1, #1386): a wait is a row, and the outbox sends it: retried when a
// send throws, held for a dismissed minion and sent after its reopen, and moved from the old settings key at boot.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Outbox, type OutboxRunner, RETRY_MINUTES } from '../src/outbox.ts';
import { LiveWaiters } from '../src/wake.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'wwl-outbox-'));
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
beforeEach(() => {
  store = new Store(join(root, `test${++k}.db`));
  project = store.createProject('P', null);
});
const minion = () => {
  const id = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
  store.updateTicket(id, { status: 'idle' });
  return id;
};
const T0 = Date.UTC(2026, 10, 14, 20, 0);
const MIN = 60_000;
let boxes: Outbox[] = [];
afterEach(() => {
  for (const b of boxes) b.stop();
  boxes = [];
});

function server(head: string) {
  const r = { sent: [] as { id: number; text: string; light: boolean }[], fail: false, events: 0 };
  const runner = {
    send: (id: number, _a: string, text: string, _i?: unknown, extra?: { light?: boolean }) => {
      if (r.fail) throw new Error('send failed');
      r.sent.push({ id, text, light: !!extra?.light });
      return { event: { id: ++r.events } };
    },
    holds: () => false,
    onLane: (_id: number, _w: string, step: () => unknown) => Promise.resolve().then(step),
    leaveMail: () => {},
  };
  const now = { t: T0 };
  const outbox = new Outbox(store, runner as unknown as OutboxRunner, { author: 'Citadel', now: () => now.t });
  boxes.push(outbox);
  const waiters = new LiveWaiters(store, repo, head, () => assert.fail('the legacy send'), outbox);
  return { r, now, outbox, waiters };
}
const rows = (id: number) => store.listDeliveries({ kind: 'wake_when_live', to: id });

test('a wait is a row, found live by the check and sent by the outbox, light kept', async () => {
  const before = commit();
  const pending = commit();
  const id = minion();
  const s = server(before);
  await s.outbox.boot();
  assert.equal(await s.waiters.add(id, pending, 'go on', true), true);
  assert.equal(rows(id).length, 1);
  assert.equal(rows(id)[0].when_kind, 'live');
  assert.equal(s.waiters.list().length, 1);
  assert.equal(await s.waiters.check(pending), 1);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(s.r.sent.length, 1);
  assert.match(s.r.sent[0].text, /is live now.*go on/);
  assert.equal(s.r.sent[0].light, true);
});

test('a send that throws is tried again, and a wait added twice is one row', async () => {
  const before = commit();
  const pending = commit();
  const id = minion();
  const s = server(before);
  await s.outbox.boot();
  await s.waiters.add(id, pending, 'first');
  await s.waiters.add(id, pending, 'second');
  assert.equal(rows(id).length, 1);
  s.outbox.stop();
  const s2 = server(pending);
  await s2.outbox.boot();
  s2.r.fail = true;
  assert.equal(await s2.waiters.check(), 1);
  await s2.outbox.poke({ type: 'tick' });
  assert.equal(s2.r.sent.length, 0);
  assert.equal(rows(id)[0].state, 'waiting');
  assert.equal(rows(id)[0].attempts, 1);
  s2.r.fail = false;
  s2.now.t += RETRY_MINUTES[0] * MIN;
  await s2.outbox.poke({ type: 'tick' });
  assert.equal(s2.r.sent.length, 1);
  assert.match(s2.r.sent[0].text, /is live now.*second/);
});

test('a dismissed minion keeps its wait, and it is delivered after the reopen', async () => {
  const before = commit();
  const pending = commit();
  const id = minion();
  const s = server(before);
  await s.outbox.boot();
  await s.waiters.add(id, pending, 'after reopen');
  store.updateTicket(id, { status: 'closed' });
  await s.outbox.poke({ type: 'closed', ticket: id });
  assert.equal(rows(id)[0].state, 'held');
  s.outbox.stop();
  const live = server(pending);
  await live.outbox.boot();
  assert.equal(await live.waiters.check(), 0, 'nothing is sent to a dismissed minion');
  assert.equal(live.r.sent.length, 0);
  store.updateTicket(id, { status: 'idle' });
  await live.outbox.poke({ type: 'reopened', ticket: id });
  assert.equal(rows(id)[0].state, 'waiting');
  assert.equal(await live.waiters.check(), 1);
  await live.outbox.poke({ type: 'tick' });
  assert.equal(live.r.sent.length, 1);
  assert.match(live.r.sent[0].text, /after reopen/);
});

test('waits saved in the old key move into the table at boot, none dropped', async () => {
  const c = commit();
  const [a, b] = [minion(), minion()];
  store.setSetting('wake-when-live', [
    { ticket: a, commit: c, reason: 'one', since: null },
    { ticket: b, commit: null, reason: 'two', since: c, light: true },
  ]);
  const s = server(c);
  assert.equal(s.waiters.list().length, 2, 'the dual read sees them before the move');
  await s.outbox.boot();
  assert.equal(store.getSetting('wake-when-live') ?? null, null);
  assert.deepEqual(rows(a).map((r) => [r.payload.reason, r.when_arg]), [['one', c]]);
  assert.deepEqual(rows(b).map((r) => [r.payload.reason, r.payload.light]), [['two', true]]);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(rows(a).length + rows(b).length, 2, 'a second pass adds none');
});
