// Checks in src/access.ts that no other test pinned (mutation run R11, #1284: a01 a02 a03 a05 a09 a18 a35).
// Each assertion fails if its one line in access.ts is dropped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayReceive, messagePerson, messageScope, turnPayer, turnPlace } from '../src/access.ts';
import { Store } from '../src/db.ts';

function world() {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  store.createProject('Delve', null, cara.id);
  store.createProject('Citadel', null, cara.id);
  const games = store.createProject('Games', null, josh.id);
  const session = (u: { id: number; name: string; admin?: unknown }) => ({ name: u.name, uid: u.id, admin: !!u.admin, exp: 0 });
  return { store, cara, josh, olive, games, session };
}

test('a01: Citadel-wide instructions stream to admins only', () => {
  const { store, cara, josh, session } = world();
  const msg = { type: 'app-instructions' };
  assert.equal(messageScope(store, msg), 'admin');
  assert.equal(mayReceive(store, session(josh), messageScope(store, msg)), false);
  assert.equal(mayReceive(store, session(cara), messageScope(store, msg)), true);
});

test('a02: a message whose minion is gone (projectId undefined) is for admins only', () => {
  const { store } = world();
  assert.equal(messageScope(store, { type: 'x', projectId: undefined }), 'admin');
  assert.equal(messageScope(store, { type: 'x' }), null);
});

test('a03: an event of a minion that no longer exists is for admins only', () => {
  const { store } = world();
  assert.equal(messageScope(store, { type: 'event', event: { ticket_id: 99999 } }), 'admin');
  assert.equal(messageScope(store, { type: 'branch', ticketId: 99999 }), 'admin');
});

test("a05: an admin gets news of schemes they aren't in, and admin-only news", () => {
  const { store, cara, games, session } = world();
  const admin = session(cara);
  assert.equal(mayReceive(store, admin, games.id), true);
  assert.equal(mayReceive(store, admin, 'admin'), true);
});

test("a09: a resumed turn runs for the interrupted turn's person, not the batch's", () => {
  const { store, josh, olive, games } = world();
  store.addMember(games.id, olive.id);
  const t = store.createTicket({ project_id: games.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  store.updateTicket(t.id, { person_id: olive.id });
  const ticket = store.getTicket(t.id)!;
  const project = store.getProject(games.id)!;
  const batch = [{ author: 'Josh' }];
  const personOf = messagePerson(store);
  assert.equal(turnPayer(store, ticket, project, batch, personOf, false), josh.id);
  assert.equal(turnPayer(store, ticket, project, batch, personOf, true), olive.id);
});

test('a18: a turn with no person (a scheme with no owner) runs on the host', () => {
  const { store } = world();
  const link = { place: () => null, linked: () => null };
  assert.deepEqual(turnPlace(store, link, null), { host: true });
  assert.deepEqual(turnPlace(store, link, 99999), { host: true });
});

test("a35: a disabled person's message is no one's ask", () => {
  const { store, josh } = world();
  assert.equal(messagePerson(store)('Josh'), josh.id);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  assert.equal(messagePerson(store)('Josh'), null);
});
