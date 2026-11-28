import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { makeMinion } from '../src/new-minion.ts';
import { ScheduledRuns } from '../src/schedules.ts';

const dir = async () => ({ cwd: '/w', branch: 'b' });
const count = (store: Store, p: number) => (store.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE project_id = ?').get(p) as { n: number }).n;

for (const [what, sql] of [
  ['the type value', "UPDATE property_values SET status = 'archived' WHERE value = 'chore' AND key_id IN (SELECT id FROM property_keys WHERE key = 'type')"],
  ['the whole type key', "UPDATE property_keys SET status = 'archived' WHERE key = 'type'"],
] as const) {
  test(`a schedule whose ${what} was archived makes no minion and says why in its last error (#1287 F1)`, async () => {
    const store = new Store(':memory:');
    const p = store.createProject('One', null);
    const s = store.schedules.create({ project_id: p.id, name: 'Nightly', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Cara' });
    store.db.exec(sql);
    const runs = new ScheduledRuns({
      store,
      newMinion: (project, m, by) => makeMinion(store, project, m, by, dir),
      runner: { emit: () => {}, send: () => {}, limitWait: () => null, netWait: () => null, killWait: () => null, failWait: () => null } as any,
      broadcast: () => {},
      by: 'Citadel',
      dataDir: '/data',
    });
    store.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, s.id);
    await runs.runDue();
    assert.equal(count(store, p.id), 0);
    assert.match(store.schedules.get(s.id)!.last_error ?? '', /chore|type/);
  });
}

test('a folder that cannot be made leaves no row either', async () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null);
  await assert.rejects(
    makeMinion(store, p, { title: 't', props: { type: 'chore' } }, 'x', async () => {
      throw new Error('disk');
    }),
    /Could not create working directory: .*disk/,
  );
  assert.equal(count(store, p.id), 0);
});

test('the folder it made comes back from the call, for callers that write in it before any turn (#1618)', async () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null);
  // setTicketDir is a queued write (src/db-writer.ts): a read that gives up on the queue is served the row before it,
  // whose cwd is ''. Here it never lands at all, which is that read's worst case.
  store.setTicketDir = () => {};
  const made = await makeMinion(store, p, { title: 't', props: { type: 'chore' } }, 'x', dir);
  assert.equal(made.cwd, '/w');
  assert.equal(store.getTicket(made.id)!.cwd, '', 'the row a caller must not read the folder from');
});
