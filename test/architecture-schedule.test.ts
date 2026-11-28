// The monthly architecture check (#1797, kit/schedules/architecture.md): every scheme gets one at boot, Citadel's hand-written row
// moves onto the template, and the activity gate skips a scheme with a quiet month and runs an active one.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ScheduledRuns, type ScheduledRunDeps } from '../src/schedules.ts';
import { addArchitectureChecks } from '../src/standard-audits.ts';
import type { Runner } from '../src/runner.ts';
import { fake } from './typed.ts';

const root = mkdtempSync(join(tmpdir(), 'architecture-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const rows = (store: Store, id: number) => store.schedules.list(id).filter((s) => s.template === 'architecture');

test("every scheme gets the check, and Citadel's hand-written row is adopted, not doubled", () => {
  const store = new Store(join(root, 'db1.sqlite'));
  const citadel = store.createProject('Citadel', null);
  const other = store.createProject('Theory of Crafting', null);
  const old = store.schedules.create({ project_id: citadel.id, name: 'Monthly architecture check', cron: '0 7 10 * *', brief: 'hand-written', type: 'research', min_minions: 300, created_by: 'Cara' });
  store.schedules.ran(old.id, { ticketId: null }, 1_000);
  const lines = addArchitectureChecks(store, '/data');
  assert.equal(lines.length, store.listProjects().length);
  assert.equal(rows(store, citadel.id).length, 1);
  assert.equal(store.schedules.list(citadel.id).length, 1, 'no second row');
  const c = rows(store, citadel.id)[0];
  assert.equal(c.id, old.id);
  assert.deepEqual([c.min_minions, c.effort, c.model, c.cron], [20, 'high', 'claude-opus-5-5', '0 7 10 * *']);
  assert.match(c.brief, /For Citadel:\n.*retro-log/);
  assert.equal(c.last_run_at, 1_000, 'its last run is kept');
  assert.equal(rows(store, other.id).length, 1);
});

test('an inactive scheme skips at no cost; an active one runs', async () => {
  const store = new Store(join(root, 'db2.sqlite'));
  const quiet = store.createProject('Quiet', null);
  const busy = store.createProject('Busy', null);
  const made: string[] = [];
  const runs = new ScheduledRuns({
    store,
    by: 'Citadel',
    dataDir: '/data',
    held: undefined,
    broadcast: () => {},
    newMinion: async (project, m, by) => {
      made.push(`${project.name}:${m.title}`);
      const t = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'bypassPermissions', created_by: by });
      return { id: t.id, number: t.number! };
    },
    runner: fake<ScheduledRunDeps['runner']>({ emit: fake<Runner['emit']>(() => {}), send: fake<Runner['send']>(() => {}), limitWait: () => null, netWait: () => null, killWait: () => null, failWait: () => null }),
  });
  addArchitectureChecks(store, '/data');
  // The window opens at the row's making: put that a day back so minions made in the same millisecond still count.
  store.db.prepare('UPDATE schedules SET created_at = created_at - 86400000').run();
  const mk = (id: number, n: number) => {
    for (let i = 0; i < n; i++) store.createTicket({ project_id: id, title: 'work', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  };
  mk(quiet.id, 19);
  mk(busy.id, 20);
  const later = Date.now() + 1000;
  const row = (id: number) => store.schedules.get(rows(store, id)[0].id)!;
  await runs.run(row(quiet.id), later);
  assert.deepEqual(made, []);
  assert.match(store.schedules.get(rows(store, quiet.id)[0].id)!.last_skip ?? '', /19 minions since .*\(needs 20\)/);
  await runs.run(row(busy.id), later);
  assert.equal(made.length, 1);
  assert.match(made[0], /^Busy:/);
});
