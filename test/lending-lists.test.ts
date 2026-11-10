import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { lendsMachine, ownerAsked } from '../src/access.ts';
import { mayFetch } from '../src/ci-runner.ts';
import { Store } from '../src/db.ts';

// The move to one lending list per machine (#438): a database from before it, opened by this code, lends every
// machine to exactly the turns that got it under the old rules, which this file keeps as its oracle.
const dir = mkdtempSync(join(tmpdir(), 'lending-lists-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A database as schema 33 left it: the scheme switch, scoped and unscoped machines, old rows. */
function before33(name: string) {
  const path = join(dir, name);
  const store = new Store(path);
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const on = store.createProject('Admin on', null, cara.id);
  const off = store.createProject('Admin off', null, cara.id);
  const joshOn = store.createProject('Josh on', null, josh.id);
  const joshOff = store.createProject('Josh off', null, josh.id);
  const both = store.createProject('Member on', null, cara.id);
  store.addMember(both.id, josh.id);
  store.addMember(off.id, josh.id);
  for (const p of [off, joshOff]) store.db.prepare('UPDATE projects SET machine_tools = 0 WHERE id = ?').run(p.id);
  const machine = (n: string, owner: number | null, scoped: number, rows: number[], check: string | null = null) => {
    const m = store.createMachine(n, '', 'Cara', owner);
    store.db.prepare('UPDATE machines SET scoped = ?, last_check = ? WHERE id = ?').run(scoped, check, m.id);
    for (const id of rows) store.db.prepare('INSERT INTO machine_projects (machine_id, project_id) VALUES (?, ?)').run(m.id, id);
  };
  machine('everywhere', null, 0, []);
  machine('everywhere-stale-row', null, 0, [joshOn.id, off.id]); // #62's leftovers, unread while unscoped
  machine('chosen', null, 1, [on.id, off.id, joshOn.id, joshOff.id]);
  machine('chosen-none', null, 1, []);
  machine('ci-host', null, 0, [], JSON.stringify({ at: 1, results: [], runners: true }));
  machine('bad-check', null, 0, [], '{not json');
  machine('joshs', josh.id, 1, []);
  machine('caras', cara.id, 1, [joshOff.id]);
  store.setSetting('schema_version', 33);
  const old = {
    machines: store.listMachines(),
    schemes: store.db.prepare('SELECT * FROM projects').all() as any[],
    rows: store.db.prepare('SELECT * FROM machine_projects').all() as { machine_id: number; project_id: number }[],
  };
  store.db.close();
  return { path, old, cara, josh };
}

test('opening an older database gives every machine a list that lends it exactly as before (#438)', () => {
  const { path, old, cara, josh } = before33('a.db');
  const store = new Store(path);
  const admin = (p: any) => !!store.getUser(p.owner_id ?? -1)?.admin;
  const granted = (m: any, p: any) => old.rows.some((r) => r.machine_id === m.id && r.project_id === p.id);
  // The rules before #438: the scheme's switch, then a person's own / a scoped one's rows / every scheme an admin owns.
  const lentBefore = (m: any, p: any, askers: number[]) => !!p.machine_tools
    && (m.owner_id !== null ? ownerAsked(store, m.owner_id, askers, p.id) : m.scoped ? granted(m, p) : admin(p));
  const fetchedBefore = (m: any, p: any) => (m.owner_id !== null ? store.canSee({ uid: m.owner_id, admin: m.owner_id === cara.id }, p.id) : m.scoped ? granted(m, p) : admin(p));
  let lent = 0;
  for (const was of old.machines) {
    const m = store.getMachine(was.id)!;
    assert.equal(m.scoped, 1, `${m.name} reads the same to an older release`);
    for (const p of old.schemes) {
      const project = store.getProject(p.id)!;
      // A CI runner host is the one machine whose list is wider than its old lending: its agent offers turns no
      // server (MachineRelay.online leaves it out), so the list only says which schemes may have runners on it.
      const runnerHost = !!was.last_check?.includes('"runners":true');
      for (const askers of runnerHost ? [] : [[], [cara.id], [josh.id], [cara.id, josh.id]]) {
        const now = lendsMachine(store, m, project, askers);
        assert.equal(now, lentBefore(was, p, askers), `${m.name} in ${p.name} for askers ${askers}`);
        lent += Number(now);
      }
      // A CI runner host's token fetch never asked for the scheme's switch, and still reaches the same schemes.
      if (runnerHost || was.owner_id !== null) assert.equal(mayFetch(store, m, project), fetchedBefore(was, p), `${m.name} fetching for ${p.name}`);
    }
  }
  assert.ok(lent > 10, 'the table has lent cases, not only refusals');
  const list = (name: string) => store.machineProjects(store.listMachines().find((m) => m.name === name)!.id).map((id) => store.getProject(id)!.name);
  assert.deepEqual(list('everywhere'), ['Admin on', 'Member on']);
  assert.deepEqual(list('everywhere-stale-row'), ['Admin on', 'Member on'], 'old unread rows are replaced');
  assert.deepEqual(list('chosen'), ['Admin on', 'Josh on'], 'rows for schemes with the switch off got nothing, and go');
  assert.deepEqual(list('chosen-none'), []);
  assert.deepEqual(list('ci-host'), ['Admin on', 'Admin off', 'Member on']);
  assert.deepEqual(list('joshs'), ['Josh on', 'Member on'], 'the schemes he is in with the switch on');
  assert.deepEqual(list('caras'), ['Admin on', 'Josh on', 'Member on'], 'an admin is in every scheme');
  store.db.close();
});

test('the move runs once: a later change to a list stays, and a machine an older release unscoped is converted again', () => {
  const { path } = before33('b.db');
  let store = new Store(path);
  const id = (name: string) => store.listMachines().find((m) => m.name === name)!.id;
  store.setMachineProjects(id('everywhere'), []);
  store.setMachineProjects(id('joshs'), []);
  // A rollback: the older release's "Every scheme an admin owns" radio unscopes a machine.
  store.db.prepare('UPDATE machines SET scoped = 0 WHERE id = ?').run(id('chosen'));
  store.db.close();
  store = new Store(path);
  assert.deepEqual(store.machineProjects(id('everywhere')), [], 'a list emptied since stays empty');
  assert.deepEqual(store.machineProjects(id('joshs')), []);
  assert.deepEqual(store.machineProjects(id('chosen')).map((p) => store.getProject(p)!.name), ['Admin on', 'Member on'], 'as the older release lent it');
  assert.equal(store.getMachine(id('chosen'))!.scoped, 1);
  store.db.close();
});

test('a new database has nothing to move, and a new machine starts lent to no scheme', () => {
  const store = new Store(join(dir, 'c.db'));
  const m = store.createMachine('new', '', 'Cara');
  assert.deepEqual([m.scoped, store.machineProjects(m.id)], [1, []]);
  store.db.close();
});
