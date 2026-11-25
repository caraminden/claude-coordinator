import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth, hashPassword } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, type Booted } from './helpers.ts';
import { json } from './typed.ts';

// Pinned minions (#179): each person's own, keyed by their login name like ticket_seen; agents get none.
const root = mkdtempSync(join(tmpdir(), 'ticket-pins-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

const store = new Store(join(data, 'coordinator.db'));
const P = store.createProject('A', null);
const TM = store.createTicket({ project_id: P.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
const M1 = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'One', permission_mode: 'default', created_by: 'Cara' });
const M2 = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Two', permission_mode: 'default', created_by: 'Cara' });
// Josh signs in with a password of their own (the shared one signs in only an admin) and is in the scheme.
const J = store.createUser({ name: 'Josh', login: 'josh' });
store.updateUser(J.id, { password_hash: await hashPassword('josh-password-1') });
store.addMember(P.id, J.id);
store.db.close();

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
let josh: string;
before(async () => {
  srv = await bootServer({ root });
  const login = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'josh', password: 'josh-password-1' }) });
  josh = login.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  rmSync(root, { recursive: true, force: true });
});

const pins = async (cookie?: string) => (await json<{ pins: number[] }>(await fetch(`${srv.base}/api/projects/${P.id}`, { headers: { Cookie: cookie ?? srv.cookie } }))).pins;

test('a pin is the pinner’s alone, listed oldest first, and unpinning drops it', async () => {
  assert.deepEqual(await pins(), []);
  assert.equal((await srv.call(`/api/tickets/${M2.id}/pin`, { pinned: true }, 'PUT')).status, 200);
  assert.equal((await srv.call(`/api/tickets/${M1.id}/pin`, { pinned: true }, 'PUT')).status, 200);
  assert.equal((await srv.call(`/api/tickets/${M1.id}/pin`, { pinned: true }, 'PUT')).status, 200, 'pinning twice is fine');
  assert.deepEqual(await pins(), [M2.id, M1.id]);
  assert.deepEqual(await pins(josh), [], "Josh doesn't see Cara's pins");
  await srv.call(`/api/tickets/${M2.id}/pin`, { pinned: false }, 'PUT');
  assert.deepEqual(await pins(), [M1.id]);
});

test('bad bodies, the Taskmaster and agents are refused', async () => {
  assert.equal((await srv.call(`/api/tickets/${M2.id}/pin`, { pinned: 'yes' }, 'PUT')).status, 400);
  assert.equal((await srv.call(`/api/tickets/${TM.id}/pin`, { pinned: true }, 'PUT')).status, 400);
  const asTM = await fetch(`${srv.base}/api/tickets/${M2.id}/pin`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tokens.agentToken(TM.id)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(asTM.status, 403);
  const page = await json<{ pins: number[] }>(await fetch(`${srv.base}/api/projects/${P.id}`, { headers: { Authorization: `Bearer ${tokens.agentToken(TM.id)}` } }));
  assert.deepEqual(page.pins, [], 'the Taskmaster sees no one’s pins');
  assert.deepEqual(await pins(), [M1.id]);
});

test('deleting a minion deletes its pins, and a stale pin never lands on a reused id', () => {
  const s = new Store(join(data, 'coordinator.db'));
  try {
    s.deleteTicket(M1.id);
    assert.deepEqual(s.pinnedTickets('Cara', P.id), []);
    // A rolled-back release's deleteTicket leaves the pin behind; the minion that reuses the id is newer.
    s.setTicketPinned('Cara', M2.id, true);
    s.db.prepare('UPDATE ticket_pins SET pinned_at = 1').run();
    assert.deepEqual(s.pinnedTickets('Cara', P.id), []);
  } finally {
    s.db.close();
  }
});
