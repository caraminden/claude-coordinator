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
  const box = store.createMachine('josh-box', '', 'Josh', josh.id);
  assert.equal(lendsMachine(store, box, shared, [josh.id]), false, 'not on its list yet (#438)');
  store.setMachineProjects(box.id, [shared.id]);
  assert.equal(lendsMachine(store, box, shared, [josh.id]), true);
  assert.equal(lendsMachine(store, box, shared, [dana.id, josh.id]), true, 'a turn answering both of them');
  assert.equal(lendsMachine(store, box, shared, [dana.id]), false, 'someone else\'s turn');
  assert.equal(lendsMachine(store, box, shared, []), false, 'a turn no one asked for (GitHub, a wake, a schedule)');
  assert.equal(lendsMachine(store, box, caras, [josh.id]), false, 'a scheme he isn\'t in');
  // On its list or not, it follows its owner: a scheme he isn't in gets nothing, whoever asks.
  store.setMachineProjects(box.id, [shared.id, caras.id]);
  assert.equal(lendsMachine(store, box, caras, [cara.id]), false);
  assert.equal(lendsMachine(store, box, caras, [josh.id]), false);
  assert.equal(lendsMachine(store, box, shared, [josh.id]), true);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  assert.equal(lendsMachine(store, box, shared, [josh.id]), false, 'a disabled owner');
  store.updateUser(josh.id, { disabled_at: null });
});

test('an admin\'s own machine follows them, in the schemes on its list; a shared one goes to its list (#438)', () => {
  const own = store.createMachine('cara-own', '', 'Cara', cara.id);
  store.setMachineProjects(own.id, [caras.id]);
  assert.equal(lendsMachine(store, own, caras, [cara.id]), true);
  assert.equal(lendsMachine(store, own, shared, [cara.id]), false, 'she is in it, but it is not on the list');
  assert.equal(lendsMachine(store, own, caras, [josh.id]), false);
  const sharedBox = store.createMachine('shared-box', '', 'Cara');
  assert.equal(lendsMachine(store, sharedBox, caras, []), false, 'a new one is lent to no scheme');
  store.setMachineProjects(sharedBox.id, [shared.id]);
  assert.equal(lendsMachine(store, sharedBox, shared, []), true, 'asked for or not');
  assert.equal(lendsMachine(store, sharedBox, caras, [cara.id]), false);
});

test('a removed owner\'s machine reaches no one, and only owners and admins manage machines', () => {
  const gone = store.createUser({ name: 'Gone', login: 'gone' });
  const box = store.createMachine('gone-box', '', 'Gone', gone.id);
  store.addMember(shared.id, gone.id);
  store.setMachineProjects(box.id, [shared.id]);
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
