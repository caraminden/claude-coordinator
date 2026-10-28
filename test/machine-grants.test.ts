import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'machine-grants-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('machines already there keep the schemes they served, except perigee-godot, which is Delve\'s alone', () => {
  const path = join(root, 'old.db');
  let store = new Store(path);
  const delve = store.createProject('Delve', null);
  const citadel = store.createProject('Citadel', null);
  const godot = store.createMachine('perigee-godot', '', 'Cara');
  const laptop = store.createMachine('laptop', '', 'Cara');
  // As a database from before grants: no table.
  store.db.exec('DROP TABLE machine_projects');
  store.db.close();

  store = new Store(path);
  assert.deepEqual(store.machineProjects(godot.id), [delve.id]);
  assert.deepEqual(store.machineProjects(laptop.id), [delve.id, citadel.id]);

  // Runs once: a revoked grant stays revoked on the next start, and a new machine starts with none.
  store.setMachineGrant(laptop.id, citadel.id, false);
  const fresh = store.createMachine('fresh', '', 'Cara');
  store.db.close();
  store = new Store(path);
  assert.deepEqual(store.machineProjects(laptop.id), [delve.id]);
  assert.deepEqual(store.machineProjects(fresh.id), []);

  // Removing a machine or a scheme takes its grants with it.
  store.deleteMachine(laptop.id);
  store.deleteProject(citadel.id);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM machine_projects').get()!.n, 1);
});
