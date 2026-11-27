import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { lendsRole, machinesFor, managesMachine } from '../src/access.ts';
import { Store } from '../src/db.ts';
import { makeJoin, redeemJoin } from '../src/machine-join.ts';

// Who a person's own machine reaches (#306): only turns its owner asked for, in schemes they're in.
const dir = mkdtempSync(join(tmpdir(), 'own-machines-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const store = new Store(join(dir, 'c.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const dana = store.createUser({ name: 'Dana', login: 'dana' });
const caras = store.createProject('Caras', null, cara.id);
store.createProject('Citadel', null, cara.id); // id 2, Citadel's (#621): its members are admins
const shared = store.createProject('Shared', null, cara.id);
store.addMember(shared.id, josh.id);
store.addMember(shared.id, dana.id);

test("an owned machine goes to its owner's turns in schemes they are in, and nothing else", () => {
  const box = store.createMachine('josh-box', '', 'Josh', josh.id);
  assert.equal(lendsRole(store, box, 'tools', shared, [josh.id]), false, 'not on its list yet (#438)');
  store.setMachineProjects(box.id, [shared.id]);
  assert.equal(lendsRole(store, box, 'tools', shared, [josh.id]), true);
  assert.equal(lendsRole(store, box, 'tools', shared, [dana.id, josh.id]), true, 'a turn answering both of them');
  assert.equal(lendsRole(store, box, 'tools', shared, [dana.id]), false, "someone else's turn");
  assert.equal(lendsRole(store, box, 'tools', shared, []), false, 'a turn no one asked for (GitHub, a wake, a schedule)');
  assert.equal(lendsRole(store, box, 'tools', caras, [josh.id]), false, "a scheme he isn't in");
  // On its list or not, it follows its owner: a scheme he isn't in gets nothing, whoever asks.
  store.setMachineProjects(box.id, [shared.id, caras.id]);
  assert.equal(lendsRole(store, box, 'tools', caras, [cara.id]), false);
  assert.equal(lendsRole(store, box, 'tools', caras, [josh.id]), false);
  assert.equal(lendsRole(store, box, 'tools', shared, [josh.id]), true);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  assert.equal(lendsRole(store, box, 'tools', shared, [josh.id]), false, 'a disabled owner');
  store.updateUser(josh.id, { disabled_at: null });
});

test("an admin's own machine follows them, in the schemes on its list; a role its owner lent to everyone goes to every turn on its list (#438, Build 10 H1)", () => {
  const own = store.createMachine('cara-own', '', 'Cara', cara.id);
  store.setMachineProjects(own.id, [caras.id]);
  assert.equal(lendsRole(store, own, 'tools', caras, [cara.id]), true);
  assert.equal(lendsRole(store, own, 'tools', shared, [cara.id]), false, 'she is in it, but it is not on the list');
  assert.equal(lendsRole(store, own, 'tools', caras, [josh.id]), false);
  const sharedBox = store.createMachine('shared-box', '', 'Cara', cara.id);
  assert.equal(lendsRole(store, sharedBox, 'tools', caras, []), false, 'a new one is lent to no scheme');
  store.setMachineProjects(sharedBox.id, [shared.id]);
  assert.equal(lendsRole(store, sharedBox, 'tools', shared, [josh.id]), false, 'until she lends it to everyone, only her turns get it');
  store.setMachineRole(sharedBox.id, 'tools', { caps: { everyone: true } });
  assert.equal(lendsRole(store, sharedBox, 'tools', shared, []), true, 'asked for or not');
  assert.equal(lendsRole(store, sharedBox, 'tools', shared, [josh.id]), true);
  assert.equal(lendsRole(store, sharedBox, 'tools', caras, [cara.id]), false, 'not on its list');
  assert.equal(lendsRole(store, sharedBox, 'gpu', shared, [josh.id]), false, 'each role is lent to everyone on its own');
  // Minion turns never: a turn runs only on its sender's own Claude login.
  store.setMachineRole(sharedBox.id, 'turns', { on: true, projects: [shared.id], caps: { everyone: true } });
  assert.equal(lendsRole(store, sharedBox, 'turns', shared, [josh.id]), false);
  assert.equal(lendsRole(store, sharedBox, 'turns', shared, [cara.id]), true);
  // Its owner takes it back.
  store.setMachineRole(sharedBox.id, 'tools', { caps: { everyone: null } });
  assert.equal(lendsRole(store, sharedBox, 'tools', shared, [josh.id]), false);
});

test("a removed owner's machine goes to the heir, lent to no scheme, and only owners and admins manage machines", () => {
  const gone = store.createUser({ name: 'Gone', login: 'gone' });
  const box = store.createMachine('gone-box', '', 'Gone', gone.id);
  store.addMember(shared.id, gone.id);
  store.setMachineProjects(box.id, [shared.id]);
  store.deleteUser(gone.id, cara.id);
  const after = store.getMachine(box.id)!;
  assert.equal(after.owner_id, cara.id, 'every machine has an owner: the heir, as with their schemes');
  assert.deepEqual(store.machineProjects(box.id), []);
  assert.equal(lendsRole(store, after, 'tools', caras, [cara.id]), false);
  assert.equal(lendsRole(store, after, 'tools', shared, []), false);

  const mine = { owner_id: josh.id },
    ownerless = { owner_id: null };
  assert.equal(managesMachine({ uid: josh.id }, mine), true);
  assert.equal(managesMachine({ uid: dana.id }, mine), false);
  assert.equal(managesMachine({ uid: josh.id }, ownerless), false);
  assert.equal(managesMachine({ uid: cara.id, admin: true }, ownerless), true);
  assert.deepEqual(machinesFor({ uid: josh.id }, [mine, ownerless]), [mine]);
  assert.deepEqual(machinesFor({ uid: cara.id, admin: true }, [mine, ownerless]), [mine, ownerless]);
});

test('a new machine always has an owner: createMachine, a join code with no one behind it (Build 10 H1)', () => {
  // The type asks for an owner; an older caller that passes none is refused at run time too.
  const untyped = store.createMachine.bind(store) as (...args: unknown[]) => unknown;
  assert.throws(() => untyped('nobodys', '', 'Cara'), /owner/);
  assert.throws(() => store.createMachine('nobodys', '', 'Cara', 999), /FOREIGN KEY/);
  assert.ok(!store.listMachines().some((m) => m.name === 'nobodys'));
  const report = { host: 'JOSH-PC', os: 'windows', agent: 9 };
  const { code } = makeJoin(store, { uid: josh.id, name: 'Josh' }, null, null);
  const joined = redeemJoin(store, () => 'tok', { code, report });
  assert.equal(store.getMachine(joined.id)?.owner_id, josh.id, "the code's maker owns what it connects");
  const { code: orphan } = makeJoin(store, { uid: null, name: 'boot-check' }, null, null);
  assert.throws(() => redeemJoin(store, () => 'tok', { code: orphan, report }), /no one to own the machine/);
});

test('the owner backfill: created_by, else its join code, else left for a person; shared roles stay lent to everyone (Build 10 H1)', () => {
  const file = join(dir, 'backfill.db');
  const s = new Store(file);
  const [c, j] = [s.createUser({ name: 'Cara', login: 'cara', admin: true }), s.createUser({ name: 'Josh', login: 'josh' })];
  const p = s.createProject('P', null, c.id);
  s.addMember(p.id, j.id);
  const row = (name: string, by: string) => {
    const m = s.createMachine(name, '', by, c.id);
    s.setMachineRole(m.id, 'tools', { on: true, projects: [p.id] });
    s.setMachineRole(m.id, 'turns', { on: true, projects: [p.id] });
    return m.id;
  };
  const [byName, byLogin, byJoin, nobody] = [row('laptop', 'Cara'), row('box', 'JOSH'), row('joined', 'Claude (#9)'), row('godot', 'Claude (#28)')];
  s.db.prepare("INSERT INTO machine_joins (code_hash, asker_id, created_by, owner_id, machine_id, created_at, expires_at, used_at, joined_id) VALUES ('h', ?, 'Josh', NULL, NULL, 1, 2, 1, ?)").run(j.id, byJoin);
  s.db.exec('UPDATE machines SET owner_id = NULL');
  s.db.close();

  const t = new Store(file);
  const owner = (id: number) => t.getMachine(id)!.owner_id;
  assert.deepEqual([owner(byName), owner(byLogin), owner(byJoin), owner(nobody)], [c.id, j.id, j.id, null]);
  const caps = (id: number, role: string) => t.machineRoles(id).find((r) => r.role === role)!.caps.everyone;
  assert.deepEqual([caps(byName, 'tools'), caps(byName, 'gpu'), caps(byName, 'turns')], [true, true, undefined], "Minion turns stay its owner's");
  // Nobody's reach changes: Josh's turn still gets Cara's formerly shared laptop's tools, and nothing gets the one with no owner.
  assert.equal(lendsRole(t, t.getMachine(byName)!, 'tools', p, [j.id]), true);
  assert.equal(lendsRole(t, t.getMachine(nobody)!, 'tools', p, [c.id]), false);
  assert.equal(caps(nobody, 'tools'), undefined);
  // Once: an owner's later change stays through the next boot.
  t.setMachineRole(byName, 'tools', { caps: { everyone: null } });
  t.db.close();
  const u = new Store(file);
  assert.equal(u.machineRoles(byName).find((r) => r.role === 'tools')!.caps.everyone, undefined);
  assert.equal(u.getMachine(nobody)!.owner_id, null);
  u.db.close();
});
