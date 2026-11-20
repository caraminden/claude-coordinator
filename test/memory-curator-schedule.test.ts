// The weekly memory curator (#1111, kit/schedules/memory-curator.md): every scheme gets it once, a run is skipped free
// when the scheme has no notes or last week's tidy still waits, and a run's brief names the folder propose_memory checks.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ScheduledRuns } from '../src/schedules.ts';
import { addMemoryCurator, addMemoryCurators } from '../src/standard-audits.ts';

const root = mkdtempSync(join(tmpdir(), 'memory-curator-schedule-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => new Store(join(root, `db-${++n}.sqlite`));
const curators = (store: Store, project: number) => store.schedules.list(project).filter((s) => s.template === 'memory-curator');

test('every scheme gets the curator once, at boot or when it is made, and a deleted one stays deleted', () => {
  const store = fresh();
  const a = store.createProject('Alpha', null);
  const b = store.createProject('Beta', null);
  const lines = addMemoryCurators(store, '/data');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^Beta: added "Memory curator" \(/);
  assert.equal(curators(store, a.id).length, 1);
  assert.match(curators(store, b.id)[0].brief, /Weekly memory tidy for Beta/);
  assert.notEqual(curators(store, a.id)[0].cron, curators(store, b.id)[0].cron, 'staggered');
  assert.deepEqual(addMemoryCurators(store, '/data'), [], 'the next boot adds nothing');
  store.schedules.remove(curators(store, a.id)[0].id);
  assert.equal(addMemoryCurator(store, '/data', a.id), null);
  assert.equal(curators(store, a.id).length, 0, 'someone deleted it: it stays deleted');
  const c = store.createProject('Gamma', null);
  assert.match(addMemoryCurator(store, '/data', c.id)!, /^Gamma: added/);
});

test('a run is skipped free with no notes or an open tidy, and otherwise its brief names the folder', async () => {
  const store = fresh();
  const p = store.createProject('Delta', null);
  const made: number[] = [];
  const sent: string[] = [];
  let target: { dir: string; notes: number } | null = null;
  const runs = new ScheduledRuns({
    store,
    newMinion: async (project, m, by) => {
      const t = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'bypassPermissions', created_by: by });
      made.push(t.id);
      return { id: t.id, number: t.number! };
    },
    runner: { emit: () => {}, send: (_id: number, _by: string, text: string) => sent.push(text), limitWait: () => null, netWait: () => null } as any,
    broadcast: () => {},
    by: 'Citadel',
    dataDir: '/data',
    memoryTarget: () => target,
  });
  const s = store.schedules.create({ project_id: p.id, name: 'Memory curator', cron: '* * * * *', brief: '', type: 'chore', template: 'memory-curator', created_by: 'Cara' });
  const due = () => store.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, s.id);

  due();
  await runs.runDue();
  assert.deepEqual(made, [], 'no folder: no minion');
  assert.match(store.schedules.get(s.id)!.last_skip!, /^Skipped .*: no memory notes to tidy$/);

  target = { dir: '/home/x/.claude/projects/-repo/memory', notes: 0 };
  due();
  await runs.runDue();
  assert.deepEqual(made, [], 'an empty folder: no minion');

  const old = store.createTicket({ project_id: p.id, title: 'Last week', permission_mode: 'bypassPermissions', created_by: 'Citadel' });
  store.memoryProposals.create({ project_id: p.id, ticket_id: old.id, folder: 'f', changes: [] });
  target = { dir: '/home/x/.claude/projects/-repo/memory', notes: 12 };
  due();
  await runs.runDue();
  assert.deepEqual(made, [], 'last week\'s tidy still waits: no second one');
  assert.match(store.schedules.get(s.id)!.last_skip!, new RegExp(`a tidy from #${old.number} still waits on the Memory page$`));

  store.memoryProposals.decide(store.memoryProposals.open(p.id)!.id, { status: 'dismissed', changes: [], backup: [], by: 'Josh' });
  due();
  await runs.runDue();
  assert.equal(made.length, 1, 'notes and nothing waiting: it runs');
  assert.match(sent[0], /The folder is \/home\/x\/\.claude\/projects\/-repo\/memory\./);
});
