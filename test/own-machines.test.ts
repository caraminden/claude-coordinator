import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { lendsMachine, machinesFor, managesMachine } from '../src/access.ts';
import { Store } from '../src/db.ts';

// Who a person's own machine reaches (#306): only turns its owner asked for, in schemes they're in.
const dir = mkdtempSync(join(tmpdir(), 'own-machines-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const store = new Store(join(dir, 'c.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const dana = store.createUser({ name: 'Dana', login: 'dana' });
const caras = store.createProject('Caras', null, cara.id);
const shared = store.createProject('Shared', null, cara.id);
store.addMember(shared.id, josh.id);
store.addMember(shared.id, dana.id);

test('an owned machine goes to its owner\'s turns in schemes they are in, and nothing else', () => {
  const box = store.createMachine('josh-box', '', 'Josh', josh.id, true);
  assert.equal(lendsMachine(store, box, shared, [josh.id]), true);
  assert.equal(lendsMachine(store, box, shared, [dana.id, josh.id]), true, 'a turn answering both of them');
  assert.equal(lendsMachine(store, box, shared, [dana.id]), false, 'someone else\'s turn');
  assert.equal(lendsMachine(store, box, shared, []), false, 'a turn no one asked for (GitHub, a wake, a schedule)');
  assert.equal(lendsMachine(store, box, caras, [josh.id]), false, 'a scheme he isn\'t in');
  // Even an admin's grant doesn't lend it to a scheme: it follows its owner.
  store.setMachineProjects(box.id, [caras.id]);
  assert.equal(lendsMachine(store, store.getMachine(box.id)!, caras, [cara.id]), false);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  assert.equal(lendsMachine(store, box, shared, [josh.id]), false, 'a disabled owner');
  store.updateUser(josh.id, { disabled_at: null });
});

test('an admin\'s own machine follows them; a shared one keeps #303\'s rules', () => {
  const own = store.createMachine('cara-own', '', 'Cara', cara.id, true);
  assert.equal(lendsMachine(store, own, caras, [cara.id]), true);
  assert.equal(lendsMachine(store, own, caras, [josh.id]), false);
  const sharedBox = store.createMachine('shared-box', '', 'Cara');
  assert.equal(lendsMachine(store, sharedBox, caras, []), true, 'every admin-owned scheme, asked for or not');
  store.setMachineProjects(sharedBox.id, [shared.id]);
  const scoped = store.getMachine(sharedBox.id)!;
  assert.equal(lendsMachine(store, scoped, shared, []), true);
  assert.equal(lendsMachine(store, scoped, caras, [cara.id]), false);
});

test('a removed owner\'s machine reaches no one, and only owners and admins manage machines', () => {
  const gone = store.createUser({ name: 'Gone', login: 'gone' });
  const box = store.createMachine('gone-box', '', 'Gone', gone.id, true);
  store.deleteUser(gone.id, cara.id);
  const after = store.getMachine(box.id)!;
  assert.equal(after.owner_id, null);
  assert.equal(lendsMachine(store, after, caras, [cara.id]), false);
  assert.equal(lendsMachine(store, after, shared, []), false);

  const mine = { owner_id: josh.id }, ownerless = { owner_id: null };
  assert.equal(managesMachine({ uid: josh.id }, mine), true);
  assert.equal(managesMachine({ uid: dana.id }, mine), false);
  assert.equal(managesMachine({ uid: josh.id }, ownerless), false);
  assert.equal(managesMachine({ uid: cara.id, admin: true }, ownerless), true);
  assert.deepEqual(machinesFor({ uid: josh.id }, [mine, ownerless]), [mine]);
  assert.deepEqual(machinesFor({ uid: cara.id, admin: true }, [mine, ownerless]), [mine, ownerless]);
});
