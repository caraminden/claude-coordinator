import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { runnerWaiters } from '../src/ci-health.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, type Booted, tempRoot } from './helpers.ts';

// #541 review fix: wake_when_runners_back from a scheme whose name makes no runner label ("!!!") can never
// be matched by a runner, so the route refuses it (409) instead of storing a wait that never ends.
const tmp = tempRoot('runners-back-label-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  if (srv) await srv.stop();
  await tmp.teardown();
});

const store = new Store(join(data, 'coordinator.db'));
const bad = store.createProject('!!!', 'https://github.com/caraminden/bang');
const good = store.createProject('Peek Auras', 'https://github.com/caraminden/peek');
const mk = (project_id: number) => store.createTicket({ project_id, kind: 'ticket', title: 'parked on CI', permission_mode: 'default', created_by: 'Cara' });
const badMinion = mk(bad.id);
const goodMinion = mk(good.id);
const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});

const post = (id: number) =>
  fetch(`${srv.base}/api/tickets/${id}/wake-runners`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'run tools/land.sh again.' }),
  });

test('a scheme whose name makes no runner label is refused 409 and stores no runner wait (#541)', async () => {
  const res = await post(badMinion.id);
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.match(JSON.stringify(body), /no letters a-z or digits to make a runner label/);
  assert.deepEqual(runnerWaiters(store).map((w) => w.ticket).filter((t) => t === badMinion.id), [], 'no waiter stored');
  assert.equal(store.listDeliveries({ kind: 'runners_back' }).filter((r) => r.to_id === badMinion.id).length, 0, 'no outbox row either');
});

test('a scheme with a runner label is accepted and gets its wait', async () => {
  const res = await post(goodMinion.id);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).label, 'peek-auras-ci');
  assert.equal(store.listDeliveries({ kind: 'runners_back' }).filter((r) => r.to_id === goodMinion.id).length, 1);
});
