import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { adminOwned, lendsRole, ownerAsked } from '../src/access.ts';
import { mayFetch } from '../src/ci-runner.ts';
import { type Machine, type Project, Store } from '../src/db.ts';
import { legacyFromRoles, parseLegacyLend, rolesFromLegacy, sameLend } from '../src/machine-roles.ts';
import { patchRoles } from '../src/routes/machines.ts';

// A machine's roles (Build 7 M1, specs/machine-connections.md section 8): today's rows move over with nothing granted differently.
const dir = mkdtempSync(join(tmpdir(), 'machine-roles-'));
// timing-ok: own temp dir
after(() => rmSync(dir, { recursive: true, force: true }));

/** The rules before roles (build/7 at 659a81d4a), read from the old columns: what the migration must keep. */
const old = {
  list: (s: Store, id: number) => (s.db.prepare('SELECT project_id FROM machine_projects WHERE machine_id = ?').all(id) as { project_id: number }[]).map((r) => r.project_id),
  runners: (m: Machine) => /"runners":true/.test(m.last_check ?? ''),
  lendsMachine(s: Store, m: Machine, p: Project, askers: number[]) {
    if (old.runners(m) || !old.list(s, m.id).includes(p.id)) return false;
    return m.owner_id === null || ownerAsked(s, m.owner_id, askers, p.id);
  },
  mayFetch(s: Store, m: Machine, p: Project) {
    if (m.owner_id === null) return m.scoped ? old.list(s, m.id).includes(p.id) : adminOwned(s, p);
    const owner = s.getUser(m.owner_id);
    if (!owner || owner.disabled_at || !s.canSee({ uid: owner.id, admin: !!owner.admin }, p.id)) return false;
    return !old.runners(m) || old.list(s, m.id).includes(p.id);
  },
  /** A worker machine takes a scheme's turn (machine-pools.ts refuses): its switch, and lent there to its owner's turn. */
  worker: (s: Store, m: Machine, p: Project) => parseLegacyLend(m.lend)?.worker === true && m.owner_id !== null && old.lendsMachine(s, m, p, [m.owner_id]),
};

/** The live rows on 2026-11-25 (owners, scoped, lend, runner flag, list), plus two shapes no live row has: a worker, and GPU jobs off before ticks. */
const LIVE = [
  { name: 'perigee-godot', owner: null, scoped: 1, lend: null, runners: false, list: [1, 3] },
  { name: 'caras-laptop', owner: null, scoped: 1, lend: null, runners: false, list: [1, 3] },
  { name: 'josh-laptop2', owner: 'josh', scoped: 1, lend: null, runners: false, list: [1, 3, 4] },
  { name: 'cara-desktop-ci-runners', owner: null, scoped: 0, lend: null, runners: true, list: [] },
  { name: 'citadel-test-box', owner: null, scoped: 1, lend: { server: null, workspaces: ['peek-auras', 'claude-coordinator', 'cantrips'] }, runners: false, list: [2, 3, 15] },
  { name: 'josh-desktop', owner: 'josh', scoped: 1, lend: { server: null, workspaces: ['vexavault'] }, runners: false, list: [1, 3, 4] },
  { name: 'cara-desktop-linux', owner: null, scoped: 1, lend: null, runners: true, list: [2, 6, 10, 11] },
  { name: 'dragonbox', owner: 'mike', scoped: 1, lend: { server: 'godot', workspaces: ['spellautocombat'] }, runners: false, list: [13] },
  { name: 'josh-worker', owner: 'josh', scoped: 1, lend: { server: null, workspaces: [], worker: true }, runners: false, list: [1, 4, 13] },
  { name: 'gpu-off-box', owner: 'mike', scoped: 1, lend: { server: null, workspaces: [], before_ticks: true, gpu_off: true }, runners: false, list: [13] },
] as const;

/** A store with the live rows as an older release left them: no role rows, schema 120. */
function oldStore(file: string) {
  const s = new Store(join(dir, file));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const mike = s.createUser({ name: 'Mike', login: 'mike' });
  const gone = s.createUser({ name: 'Gone', login: 'gone' });
  const projects = Array.from({ length: 15 }, (_, i) => s.createProject(`scheme-${i + 1}`, null, i % 4 === 3 ? josh.id : cara.id));
  for (const n of [1, 3, 13]) s.addMember(projects[n - 1].id, josh.id);
  for (const n of [13, 6]) s.addMember(projects[n - 1].id, mike.id);
  s.updateUser(gone.id, { disabled_at: Date.now() });
  const who = { josh: josh.id, mike: mike.id } as const;
  for (const r of LIVE) {
    const m = s.createMachine(r.name, '', 'test', r.owner === null ? null : who[r.owner]);
    s.db.prepare('UPDATE machines SET scoped = ?, lend = ?, last_check = ? WHERE id = ?').run(r.scoped, r.lend ? JSON.stringify(r.lend) : null, r.runners ? JSON.stringify({ at: 1, results: [], runners: true }) : null, m.id);
    for (const n of r.list) s.db.prepare('INSERT INTO machine_projects (machine_id, project_id) VALUES (?, ?)').run(m.id, projects[n - 1].id);
  }
  s.db.exec('DELETE FROM machine_roles; DELETE FROM machine_role_projects');
  s.setSetting('schema_version', 120);
  return { s, people: [cara.id, josh.id, mike.id, gone.id], projects };
}

test('the migration grants every turn, tool and runner token exactly as before, on the live rows', () => {
  const { s: before, people, projects } = oldStore('grants.db');
  // Every grant the old rules give, for every machine, scheme and asker.
  const askers = [[], ...people.map((p) => [p])];
  const grants = (s: Store, rule: 'old' | 'new') =>
    s.listMachines().flatMap((m) =>
      projects.flatMap((p) => [
        ...askers.map((a) => `${m.name} ${p.name} tools ${a}: ${rule === 'old' ? old.lendsMachine(s, m, p, a) : lendsRole(s, m, 'tools', p, a)}`),
        `${m.name} ${p.name} runner token: ${rule === 'old' ? old.mayFetch(s, m, p) : mayFetch(s, m, p)}`,
        `${m.name} ${p.name} turns: ${rule === 'old' ? old.worker(s, m, p) : s.machineRoles(m.id).some((r) => r.role === 'turns' && r.on) && m.owner_id !== null && lendsRole(s, m, 'turns', p, [m.owner_id])}`,
        // Machine jobs go by the GPU jobs role (spec section 3), so GPU jobs off now also stops new machine jobs: no live row has it off.
        `${m.name} ${p.name} machine jobs: ${rule === 'old' ? old.list(s, m.id).includes(p.id) && !parseLegacyLend(m.lend)?.gpu_off : s.roleGrants(m.id, 'gpu', p.id)}`,
      ]),
    );
  const was = grants(before, 'old');
  const lends = before.listMachines().map((m) => parseLegacyLend(m.lend));
  before.db.close();
  const s = new Store(join(dir, 'grants.db'));
  assert.deepEqual(grants(s, 'new'), was);
  assert.ok(was.filter((g) => g.endsWith('true')).length > 40, 'the comparison covers real grants, not only refusals');
  for (const [i, m] of s.listMachines().entries()) assert.ok(sameLend(s.machineLend(m.id), lends[i]), `${m.name}: lends what it did`);
  // The roles as the spec maps them.
  const roles = (name: string) => Object.fromEntries(s.machineRoles(s.listMachines().find((m) => m.name === name)!.id).map((r) => [r.role, r.on]));
  assert.deepEqual(roles('cara-desktop-linux'), { tools: false, screen: false, ci: true, turns: false, gpu: true, builds: false });
  assert.deepEqual(roles('josh-worker'), { tools: true, screen: false, ci: false, turns: true, gpu: true, builds: false });
  assert.deepEqual(roles('gpu-off-box'), { tools: true, screen: false, ci: false, turns: false, gpu: false, builds: false });
  assert.ok(Number(s.getSetting('schema_version')) >= 121, 'the roles migration ran'); // later builds add their own numbers
  s.db.close();
});

test('every write keeps the old columns as a rollback reads them, and an older release’s change wins at the next boot', () => {
  const { s: first } = oldStore('rollback.db');
  first.db.close();
  const s = new Store(join(dir, 'rollback.db'));
  const box = s.listMachines().find((m) => m.name === 'josh-desktop')!;
  s.setMachineRole(box.id, 'turns', { on: true, everyScheme: [1, 3] });
  s.setMachineRole(box.id, 'ci', { on: true, projects: [4] });
  let row = s.getMachine(box.id)!;
  assert.deepEqual(parseLegacyLend(row.lend), { server: null, workspaces: ['vexavault'], worker: true });
  assert.deepEqual(old.list(s, box.id), [1, 3, 4], "the old list: every role that's on's schemes");
  // An older release (a rollback) switches GPU jobs off and takes scheme 4 off the one list.
  s.db.prepare('UPDATE machines SET lend = ? WHERE id = ?').run(JSON.stringify({ server: null, workspaces: ['vexavault'], gpu_off: true }), box.id);
  s.db.prepare('DELETE FROM machine_projects WHERE machine_id = ? AND project_id = 4').run(box.id);
  s.db.close();
  const again = new Store(join(dir, 'rollback.db'));
  row = again.getMachine(box.id)!;
  assert.deepEqual(Object.fromEntries(again.machineRoles(box.id).map((r) => [r.role, r.on ? r.projects : 'off'])), { tools: [1, 3], screen: 'off', ci: 'off', turns: 'off', gpu: 'off', builds: 'off' }, 'its roles are migrated again from what the older release left');
  // An older release makes it a CI runner host (a runner agent connecting during a rollback): the next boot gives it CI.
  again.db.prepare('UPDATE machines SET last_check = ? WHERE id = ?').run(JSON.stringify({ at: 2, results: [], runners: true }), box.id);
  again.db.close();
  const third = new Store(join(dir, 'rollback.db'));
  assert.deepEqual(Object.fromEntries(third.machineRoles(box.id).map((r) => [r.role, r.on ? r.projects : 'off'])), { tools: 'off', screen: 'off', ci: [1, 3], turns: 'off', gpu: 'off', builds: 'off' });
  assert.equal(mayFetch(third, third.getMachine(box.id)!, third.getProject(3)!), true, 'its tokens go where the older release sent them');
  third.db.close();
  const fourth = new Store(join(dir, 'rollback.db'));
  // A machine the older release added has roles before anything writes them.
  const added = fourth.createMachine('added-later', '', 'test');
  assert.equal(fourth.machineRoles(added.id).find((r) => r.role === 'tools')?.on, true);
  fourth.db.close();
});

test('the old write paths go into the roles: the one list, a lend, a runner agent connecting', () => {
  const s = new Store(join(dir, 'writes.db'));
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const a = s.createProject('a', null, josh.id);
  const b = s.createProject('b', null, josh.id);
  const m = s.createMachine('pc', '', 'Josh', josh.id);
  s.setMachineProjects(m.id, [a.id]);
  s.updateMachine(m.id, { lend: JSON.stringify({ server: null, workspaces: ['w'], worker: true }) });
  assert.deepEqual(
    s.machineRoles(m.id).find((r) => r.role === 'turns'),
    { role: 'turns', on: true, caps: {}, setup: null, projects: [a.id] },
    'switched on: the one list, as the old column lent it',
  );
  s.setMachineProjects(m.id, [a.id, b.id]);
  assert.deepEqual(
    s
      .machineRoles(m.id)
      .filter((r) => r.on)
      .map((r) => [r.role, r.projects]),
    [
      ['tools', [a.id, b.id]],
      ['turns', [a.id, b.id]],
      ['gpu', [a.id, b.id]],
    ],
  );
  // A runner agent connects with its key: the CI role goes on where the machine was lent, as its tokens were.
  s.updateMachine(m.id, { last_check: JSON.stringify({ at: 1, results: [], runners: true }) });
  assert.equal(mayFetch(s, s.getMachine(m.id)!, b), true);
  assert.deepEqual(s.machineRoles(m.id).find((r) => r.role === 'ci')?.projects, [a.id, b.id]);
  assert.equal(lendsRole(s, s.getMachine(m.id)!, 'tools', a, [josh.id]), false, 'a CI runner host lends turns nothing');
  s.db.close();
});

test('the one list saves only its change: one more scheme for Tools leaves CI and GPU jobs their own lists', () => {
  const s = new Store(join(dir, 'one-list-change.db'));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => s.createProject(n, null, cara.id));
  const m = s.createMachine('pc', '', 'Cara');
  s.setMachineRole(m.id, 'tools', { on: true, projects: [a.id] });
  s.setMachineRole(m.id, 'gpu', { on: true, projects: [a.id, b.id] });
  s.setMachineRole(m.id, 'ci', { on: true, projects: [a.id, b.id, c.id] });
  const lists = () =>
    Object.fromEntries(
      s
        .machineRoles(m.id)
        .filter((r) => r.on)
        .map((r) => [r.role, r.projects]),
    );
  // A lend card for d (or a page tab from before roles) saves the whole one list plus d.
  s.setMachineProjects(m.id, [...s.machineProjects(m.id), d.id]);
  assert.deepEqual(lists(), { tools: [a.id, d.id], gpu: [a.id, b.id, d.id], ci: [a.id, b.id, c.id, d.id] }, 'd added to each role, nothing else spread');
  // Taken from b: it comes off every role, and the rest stay as they were.
  s.setMachineProjects(m.id, [a.id, c.id, d.id]);
  assert.deepEqual(lists(), { tools: [a.id, d.id], gpu: [a.id, d.id], ci: [a.id, c.id, d.id] });
  s.db.close();
});

test('PATCH roles: owner and admins only; on with no list is every scheme its owner is in; caps checked', async () => {
  const s = new Store(join(dir, 'patch.db'));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const dana = s.createUser({ name: 'Dana', login: 'dana' });
  const mine = s.createProject('josh-scheme', null, josh.id);
  s.createProject('Citadel', null, cara.id); // id 2, Citadel's: its members see every scheme
  const shared = s.createProject('shared', null, cara.id);
  s.addMember(shared.id, josh.id);
  const other = s.createProject('other', null, cara.id);
  const m = s.createMachine('josh-pc', '', 'Josh', josh.id);
  const calls: string[] = [];
  const app = {
    store: s,
    machines: { rolesChanged: () => calls.push('told'), endSessionsWhere: () => {}, list: () => [], view: () => ({}) },
    runner: { turnLine: { pump: () => calls.push('pump') } },
    jobs: { drop: () => {} },
    broadcast: () => {},
  } as unknown as Parameters<typeof patchRoles>[0];
  const as = (u: { id: number; admin?: number | boolean }) => ({ uid: u.id, admin: !!u.admin }) as Parameters<typeof patchRoles>[1];
  await assert.rejects(patchRoles(app, as(dana), m, { role: 'turns', on: true }), /No such machine/);
  await assert.rejects(patchRoles(app, as(josh), m, { role: 'wifi', on: true }), /role must be one of/);
  await assert.rejects(patchRoles(app, as(cara), m, { role: 'turns', on: true }), /Only its owner can switch Minion turns on/);
  const removing = { removing: () => true };
  await assert.rejects(patchRoles({ ...app, machineCopies: removing } as unknown as typeof app, as(josh), m, { role: 'turns', on: true }), /being removed/);
  const on = await patchRoles(app, as(josh), m, { role: 'turns', on: true });
  assert.deepEqual(on.roles.find((r) => r.role === 'turns')?.projects, [mine.id, shared.id], "every scheme he's in, not one he isn't");
  assert.deepEqual(calls, ['told', 'pump']);
  await assert.rejects(patchRoles(app, as(josh), m, { role: 'ci', on: true, projects: [other.id] }), /projects must be a list/);
  await assert.rejects(patchRoles(app, as(josh), m, { role: 'ci', caps: { runners: -1 } }), /whole number/);
  await assert.rejects(patchRoles(app, as(josh), m, { role: 'tools', caps: { ticks: null } }), /caps can only set/);
  const ci = await patchRoles(app, as(josh), m, { role: 'ci', on: true, projects: [shared.id], caps: { runners: 2 } });
  assert.deepEqual(
    ci.roles.find((r) => r.role === 'ci'),
    { role: 'ci', on: true, caps: { runners: 2 }, setup: null, projects: [shared.id], name: 'CI runners' },
  );
  await assert.rejects(patchRoles(app, as(cara), m, { role: 'ci', caps: { runners: 4 } }), /Only its owner can set its caps/);
  // Off and on again: its list stays.
  await patchRoles(app, as(cara), m, { role: 'ci', on: false });
  const back = await patchRoles(app, as(josh), m, { role: 'ci', on: true });
  assert.deepEqual(back.roles.find((r) => r.role === 'ci')?.projects, [shared.id]);
  s.db.close();
});

test('each role decides alone: Tools for sessions, GPU jobs for machine jobs, CI for runner tokens', async () => {
  const s = new Store(join(dir, 'per-role.db'));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const a = s.createProject('a', null, cara.id);
  const b = s.createProject('b', null, cara.id);
  const box = s.createMachine('box', '', 'Cara');
  s.setMachineProjects(box.id, [a.id, b.id]);
  let ended: (id: number) => boolean = () => false;
  let dropped: (j: { state: string; project_id: number }) => boolean = () => false;
  const app = {
    store: s,
    machines: { rolesChanged: () => {}, endSessionsWhere: (_: number, gone: typeof ended) => (ended = gone), list: () => [], view: () => ({}) },
    runner: { turnLine: { pump: () => {} } },
    jobs: { drop: (_: number, __: string, gone: typeof dropped) => (dropped = gone) },
    broadcast: () => {},
  } as unknown as Parameters<typeof patchRoles>[0];
  // Tools taken off b: b's sessions end and it can't open one again, but GPU jobs still lend it machine jobs.
  await patchRoles(app, { uid: cara.id, admin: true } as Parameters<typeof patchRoles>[1], box, { role: 'tools', projects: [a.id] });
  assert.equal(ended(b.id), true);
  assert.equal(ended(a.id), false);
  assert.equal(dropped({ state: 'queued', project_id: b.id }), false);
  assert.equal(lendsRole(s, s.getMachine(box.id)!, 'tools', b), false);
  assert.equal(s.roleGrants(box.id, 'gpu', b.id), true);
  // GPU jobs taken off b: its queued machine jobs leave the line.
  await patchRoles(app, { uid: cara.id, admin: true } as Parameters<typeof patchRoles>[1], box, { role: 'gpu', projects: [a.id] });
  assert.equal(dropped({ state: 'queued', project_id: b.id }), true);
  // CI: an unscoped runner host from before #438 fetches for admin-owned schemes only while CI is on.
  const ci = s.createMachine('ci-box', '', 'Cara');
  s.updateMachine(ci.id, { last_check: JSON.stringify({ at: 1, results: [], runners: true }) });
  s.db.prepare('UPDATE machines SET scoped = 0 WHERE id = ?').run(ci.id);
  assert.equal(mayFetch(s, s.getMachine(ci.id)!, a), true);
  s.setMachineRole(ci.id, 'ci', { on: false });
  assert.equal(mayFetch(s, s.getMachine(ci.id)!, a), false, 'CI switched off');
  // A machine that isn't a runner host yet, with CI on: its CI list decides.
  s.setMachineRole(box.id, 'ci', { on: true, projects: [a.id] });
  assert.equal(mayFetch(s, s.getMachine(box.id)!, a), true);
  assert.equal(mayFetch(s, s.getMachine(box.id)!, b), false);
  s.db.close();
});

test('rolesFromLegacy and legacyFromRoles round-trip every lend shape', () => {
  for (const lend of [null, { server: null, workspaces: [] }, { server: 'godot', workspaces: ['a', 'b'] }, { server: null, workspaces: [], before_ticks: true, gpu_off: true }, { server: 'x', workspaces: ['a'], worker: true, gpu_off: true }]) {
    const back = legacyFromRoles(rolesFromLegacy({ lend: lend && JSON.stringify(lend), last_check: null }, [3, 1]));
    assert.ok(sameLend(back.lend, lend as never), JSON.stringify(lend));
    assert.deepEqual(back.projects, [1, 3]);
  }
});

test('the Builds role round-trips through machine_roles: on, its schemes and its threads cap; starts off for an old machine', async () => {
  const s = new Store(join(dir, 'builds.db'));
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const a = s.createProject('a', null, josh.id);
  const b = s.createProject('b', null, josh.id);
  const m = s.createMachine('josh-pc', '', 'Josh', josh.id);
  assert.deepEqual(
    s.machineRoles(m.id).find((r) => r.role === 'builds'),
    { role: 'builds', on: false, caps: {}, setup: null, projects: [] },
  );
  const app = {
    store: s,
    machines: { rolesChanged: () => {}, endSessionsWhere: () => {}, list: () => [], view: () => ({}) },
    runner: { turnLine: { pump: () => {} } },
    jobs: { drop: () => {} },
    broadcast: () => {},
  } as unknown as Parameters<typeof patchRoles>[0];
  const on = await patchRoles(app, { uid: josh.id, admin: false } as Parameters<typeof patchRoles>[1], m, { role: 'builds', on: true, caps: { threads: 6 } });
  assert.deepEqual(
    on.roles.find((r) => r.role === 'builds'),
    { role: 'builds', on: true, caps: { threads: 6 }, setup: null, projects: [a.id, b.id], name: 'Builds' },
  );
  s.db.close();
  const again = new Store(join(dir, 'builds.db'));
  assert.deepEqual(
    again.machineRoles(m.id).find((r) => r.role === 'builds'),
    { role: 'builds', on: true, caps: { threads: 6 }, setup: null, projects: [a.id, b.id] },
  );
  assert.deepEqual(
    again
      .machineRoles(m.id)
      .filter((r) => r.on)
      .map((r) => r.role),
    ['tools', 'gpu', 'builds'],
    'Tools and GPU jobs as before, and Builds',
  );
  again.db.close();
});
