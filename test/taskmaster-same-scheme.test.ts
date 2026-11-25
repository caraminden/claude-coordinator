import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { agentToken, bootServer, stopProcs, stopTurns, testPins } from './helpers.ts';
testPins();

// message_taskmaster naming its own scheme plus a person reaches that member's Taskmaster there, as held mail.
const root = mkdtempSync(join(tmpdir(), 'tm-same-scheme-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: after stopTurns, as taskmaster-views does
});

test("a Taskmaster in a split scheme reaches another member's Taskmaster as held mail; unknown, itself and unsplit are refused", async () => {
  const dir = join(root, 'server');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const store = new Store(join(dir, 'data', 'coordinator.db'));
  const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const Josh = store.createUser({ name: 'Josh', login: 'josh' });
  const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
  const p = store.createProject('Shared', null, Cara.id);
  for (const u of [Josh, Rachel]) store.addMember(p.id, u.id);
  const first = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  store.setTicketDir(first.id, dir, null);
  const joshTm = store.splitScheme(p.id, Josh.id); // Cara's keeps the first one, a fresh Overlord appears
  const caraTm = first;
  const solo = store.createProject('Solo', null, Cara.id);
  const soloTm = store.createTicket({ project_id: solo.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  store.setTicketDir(soloTm.id, dir, null);
  store.db.close();
  const srv = await bootServer({ root: dir });
  try {
    const as = (id: number) => srv.as({ token: agentToken(join(dir, 'data'), id) });
    const send = (id: number, body: object) => as(id)('/api/taskmaster', { need: 'fyi', text: 'agree which minion carries on', ...body }, 'POST');
    const events = async (id: number) => (await srv.as({ cookie: srv.cookie })(`/api/tickets/${id}/events?after=0`)).data.filter((x: { kind: string; data: string }) => x.kind === 'user_message').map((x: { kind: string; data: string }) => JSON.parse(x.data));

    // Cara's Taskmaster to Josh's, naming its own scheme: held mail, never a turn.
    const r = await send(caraTm.id, { scheme: 'Shared', person: 'Josh', wake: true });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const got = await events(joshTm.id);
    assert.equal(got.length, 1);
    assert.equal(got[0].mail, true);
    assert.match(got[0].text, /agree which minion carries on/);

    // Josh's to Cara's: both owners get it.
    assert.equal((await send(joshTm.id, { scheme: 'Shared', person: 'Cara' })).status, 202);
    assert.equal((await events(caraTm.id)).length, 1);

    // Unknown person, a member with no Taskmaster, the sender itself, and no person at all.
    assert.equal((await send(caraTm.id, { scheme: 'Shared', person: 'Nobody' })).status, 400);
    const none = await send(caraTm.id, { scheme: 'Shared', person: 'Rachel' });
    assert.equal(none.status, 400);
    assert.match(JSON.stringify(none.data), /no Taskmaster of their own/);
    const self = await send(caraTm.id, { scheme: 'Shared', person: 'Cara' });
    assert.equal(self.status, 400);
    assert.match(JSON.stringify(self.data), /yourself/);
    const bare = await send(caraTm.id, { scheme: 'Shared' });
    assert.equal(bare.status, 400);
    assert.match(JSON.stringify(bare.data), /use message_ticket/);

    // An unsplit scheme: no one else has a Taskmaster there.
    const alone = await send(soloTm.id, { scheme: 'Solo', person: 'Josh' });
    assert.equal(alone.status, 400);
  } finally {
    await srv.stop();
  }
});
