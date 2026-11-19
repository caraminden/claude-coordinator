import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { checkAudits } from '../src/standard-audits.ts';
import { loadTemplates, templateFields, templateVars } from '../src/schedules.ts';

const mk = (store: Store, p: number, name: string) => store.schedules.create({ project_id: p, name, cron: '0 3 * * *', brief: 'b', type: 'chore', created_by: 'Cara' }, 1000);

test('a started slot and a gate skip each leave a history row; an error does not; delete clears them (#1057)', () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null).id;
  const s = mk(store, p, 'Nightly');
  const day = 864e5;
  const now = Date.now();
  store.schedules.ran(s.id, { ticketId: 7 }, now - 20 * day);
  store.schedules.ran(s.id, { skip: 'quiet' }, now - 3 * day);
  store.schedules.ran(s.id, { error: 'busy' }, now - 2 * day);
  store.schedules.ran(s.id, { skip: 'quiet again' }, now - day);
  assert.deepEqual(store.schedules.runs(s.id).map((r) => [r.ticket_id, r.skip]), [[null, 'quiet again'], [null, 'quiet'], [7, null]]);
  assert.equal(store.schedules.runs(s.id, 1).length, 1);
  assert.equal(store.schedules.skipsSince(s.id, now - 14 * day), 2);
  store.schedules.remove(s.id);
  assert.equal(store.schedules.runs(s.id).length, 0);
});

test('the audits check flags a missing template, a duplicate, and a deliberate omission, in any scheme (#1057)', () => {
  const store = new Store(':memory:');
  const templates = loadTemplates();
  const states = (id: number) => Object.fromEntries(checkAudits(store, id, templates).map((a) => [a.slug, a.state]));
  // Threadspace opted out of code-health and test-audit in STANDARD_AUDITS; it has no rows.
  const ts = store.createProject('Threadspace', null);
  assert.equal(states(ts.id)['test-audit'], 'left-out');
  assert.equal(states(ts.id)['monthly-retro'], 'missing');
  // Genesis Tree: a template row beside a hand-made copy.
  const gt = store.createProject('Genesis Tree', null);
  const t = templates.get('code-health')!;
  store.schedules.create({ project_id: gt.id, ...templateFields(t, gt, '', templateVars(store, '/tmp', gt.id)), created_by: 'Cara' });
  mk(store, gt.id, 'Code health');
  const g = checkAudits(store, gt.id, templates).find((a) => a.slug === 'code-health')!;
  assert.equal(g.state, 'duplicate');
  assert.deepEqual(g.rows.map((r) => r.template).sort(), [false, true]);
  // A scheme the code doesn't list leaves nothing out.
  const other = store.createProject('Brand New', null);
  assert.ok(Object.values(states(other.id)).every((s) => s === 'missing'));
});
