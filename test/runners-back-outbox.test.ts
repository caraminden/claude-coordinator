// wake_when_runners_back on the one outbox (ADR 0021, step 4, #1390): a wait is a row (kind runners_back), met by the
// ci-health poll, sent and retried by the outbox, held for a dismissed minion, and moved from the old key at boot.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { addRunnerWaiter, CiHealth, registerRunnersBack, RUNNER_WAITERS, runnerWaiters } from '../src/ci-health.ts';
import { Store } from '../src/db.ts';
import { Outbox, type OutboxRunner } from '../src/outbox.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'rb-outbox-'));
after(() => rmSync(root, { recursive: true, force: true }));
const T0 = Date.UTC(2026, 10, 14, 20, 0);
const now = { t: T0 };
let store: Store;
let project: { id: number; name: string };
let k = 0;
let boxes: Outbox[] = [];
beforeEach(() => {
  now.t = T0;
  store = new Store(join(root, `test${++k}.db`));
  project = store.getProject(store.createProject('Peek Auras', null).id)!;
});
afterEach(() => {
  for (const b of boxes) b.stop();
  boxes = [];
});
const minion = () => {
  const id = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
  store.updateTicket(id, { status: 'idle' });
  return id;
};
function world() {
  const sent: { id: number; text: string }[] = [];
  let events = 0;
  const runner = {
    send: (id: number, _a: string, text: string) => (sent.push({ id, text }), { event: { id: ++events } }),
    holds: () => false,
    onLane: (_id: number, _w: string, step: () => unknown) => Promise.resolve().then(step),
    leaveMail: () => {},
  };
  const outbox = new Outbox(store, runner as unknown as OutboxRunner, { author: 'Citadel', now: () => now.t });
  boxes.push(outbox);
  registerRunnersBack(store, outbox);
  const health = new CiHealth(store, { outbox } as any);
  return { sent, outbox, health };
}
const runner = (online: boolean) => [{ name: 'DESKTOP', status: online ? 'online' : 'offline', labels: [{ name: 'peek-auras-ci' }] }] as any;

test('a wait set while runners are down fires on the poll after they return', async () => {
  const w = world();
  await w.outbox.boot();
  const id = minion();
  addRunnerWaiter(store, id, 'run tools/land.sh again.', w.outbox);
  w.health.wakeParked(project as any, runner(false));
  await w.outbox.poke({ type: 'tick' });
  assert.equal(w.sent.length, 0);
  now.t += 5 * 60_000;
  w.health.wakeParked(project as any, runner(true));
  await w.outbox.poke({ type: 'tick' });
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].text, /^Peek Auras's CI runners are back \(DESKTOP online\): run tools\/land\.sh again\. If land parks/);
  w.health.wakeParked(project as any, runner(true));
  await w.outbox.poke({ type: 'tick' });
  assert.equal(w.sent.length, 1, 'once');
});

test('an unreadable runner list still tells the minion to ask a person', async () => {
  const w = world();
  await w.outbox.boot();
  const id = minion();
  addRunnerWaiter(store, id, 'run tools/land.sh again.', w.outbox);
  w.health.wakeParked(project as any, null);
  await w.outbox.poke({ type: 'tick' });
  assert.match(w.sent[0].text, /can't read Peek Auras's CI runners .* ask a person whether they are, then run tools\/land\.sh again\./);
});

test('a dismissed minion keeps its wait for 3 days, and hears it after a reopen', async () => {
  const w = world();
  await w.outbox.boot();
  const id = minion();
  addRunnerWaiter(store, id, 'go.', w.outbox);
  store.updateTicket(id, { status: 'closed' });
  w.health.wakeParked(project as any, runner(true));
  await w.outbox.poke({ type: 'tick' });
  assert.equal(w.sent.length, 0);
  assert.equal(store.listDeliveries({ kind: 'runners_back' })[0].state, 'held');
  store.updateTicket(id, { status: 'idle' });
  await w.outbox.poke({ type: 'reopened', ticket: id });
  w.health.wakeParked(project as any, runner(true));
  await w.outbox.poke({ type: 'tick' });
  assert.equal(w.sent.length, 1);
});

test('saved waits move into the table at boot in one go, none dropped, and the key is emptied', async () => {
  const a = minion();
  const b = minion();
  store.setSetting(RUNNER_WAITERS, [{ ticket: a, reason: 'one.' }, { ticket: b, reason: 'two.' }]);
  const w = world();
  await w.outbox.boot();
  assert.deepEqual(store.listDeliveries({ kind: 'runners_back' }).map((r) => [r.to_id, r.payload.reason, r.when_kind]), [[a, 'one.', 'runners'], [b, 'two.', 'runners']]);
  assert.deepEqual(runnerWaiters(store), []);
  await w.outbox.poke({ type: 'tick' }); // a second pass moves nothing twice
  assert.equal(store.listDeliveries({ kind: 'runners_back' }).length, 2);
  w.health.wakeParked(project as any, runner(true));
  await w.outbox.poke({ type: 'tick' });
  assert.deepEqual(w.sent.map((s) => s.id), [a, b]);
});
