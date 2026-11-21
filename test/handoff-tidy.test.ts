// Handoffs tidy themselves (#1371): a closed minion's handoff moves to handoffs/shipped/ unless pinned, named by an
// open minion or still has unstarted briefs; the sweep plans the same way and the search still finds moved files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { markedNotPicked, reconcileMoved, tidyForClosed } from '../src/handoff-tidy.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { planSweep } from '../tools/handoffs-sweep.ts';

const root = mkdtempSync(join(tmpdir(), 'handoff-tidy-'));
after(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const dir = mkdtempSync(join(root, 'd-'));
  const store = new Store(join(dir, 'c.db'));
  // A scheme other than the first one: nothing here is keyed to Citadel's.
  const project = store.createProject('Other2', null).id;
  const shared = projectSharedDir(dir, project);
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  const file = (n: string, body = '# Handoff\nDo it.') => writeFileSync(join(shared, 'handoffs', n), body);
  const minion = (title: string, text: string, status = 'running') => {
    const t = store.createTicket({ project_id: project, title, permission_mode: 'default', created_by: 'Cara' });
    store.addEvent(t.id, 'user_message', { author: 'Cara', text });
    if (status === 'closed') store.updateTicket(t.id, { status: 'closed' });
    return t;
  };
  return { dir, store, project, shared, file, minion };
}

test('a closed minion files its handoff as shipped, a not-picked one aside', () => {
  const { dir, store, project, shared, file } = setup();
  file('a.md'); file('b.md', '**Not picked (2026-11-12): do not start.**\nx');
  assert.equal(tidyForClosed(store, dir, project, `Your brief is ${shared}/handoffs/a.md`), 'handoffs/shipped/a.md');
  assert.equal(tidyForClosed(store, dir, project, 'see handoffs/b.md'), 'handoffs/not-picked/b.md');
  assert.ok(existsSync(join(shared, 'handoffs/shipped/a.md')) && !existsSync(join(shared, 'handoffs/a.md')));
  assert.equal(markedNotPicked('this was not picked by Josh'), false);
});

test('pinned, open-named and part-started files stay', () => {
  const { dir, store, project, shared, file, minion } = setup();
  file('pin.md'); file('open.md'); file('multi.md', '## Brief A: one\nx\n## Brief B: two\ny');
  store.setSharedPin(project, 'handoffs/pin.md', 'Cara');
  minion('open one', 'start from handoffs/open.md');
  assert.equal(tidyForClosed(store, dir, project, 'handoffs/pin.md'), null);
  assert.equal(tidyForClosed(store, dir, project, 'handoffs/open.md'), null);
  assert.equal(tidyForClosed(store, dir, project, 'handoffs/multi.md'), null);
  assert.ok(existsSync(join(shared, 'handoffs/pin.md')));
});

test('the sweep plans by closed and open minions and lists old unmatched files', () => {
  const { store, project, shared, file, minion } = setup();
  file('done.md'); file('live.md'); file('old.md'); file('new.md');
  minion('d', 'handoffs/done.md', 'closed'); minion('l', 'handoffs/live.md');
  const old = Date.now() / 1000 - 20 * 86400;
  utimes(join(shared, 'handoffs/old.md'), old);
  const plan = planSweep(store.db, project, shared, []);
  assert.deepEqual(plan.shipped, ['handoffs/done.md']);
  assert.deepEqual(plan.keep.map((k) => k.rel), ['handoffs/live.md']);
  assert.deepEqual(plan.listed, ['handoffs/old.md']);
  assert.equal(plan.total, 4);
});

import { utimesSync } from 'node:fs';
function utimes(p: string, secs: number) { utimesSync(p, secs, secs); }

test('the indexer files the handoff when its minion closes, and search still finds it as shipped', async () => {
  const { dir, store, project, shared, file, minion } = setup();
  const { MinionIndexer } = await import('../src/minion-index.ts');
  file('qp-thing.md', '# Handoff\nUnique zebrafish brief.');
  const idx = new MinionIndexer(store, dir);
  minion('thing', `Your brief is ${shared}/handoffs/qp-thing.md`, 'closed');
  await idx.run();
  assert.ok(existsSync(join(shared, 'handoffs/shipped/qp-thing.md')));
  const hit = (store.minionIndex.search(project, 'zebrafish') as any[]).find((h) => h.kind === 'handoff');
  assert.equal(hit.name, 'shipped/qp-thing.md');
});

test('a name clash in shipped/ never overwrites, and only a top line marks not picked', async () => {
  const { shared, file } = setup();
  const { moveFile } = await import('../src/handoff-tidy.ts');
  file('x.md', 'one');
  moveFile(shared, 'handoffs/x.md', 'handoffs/shipped');
  file('x.md', 'two');
  const a = moveFile(shared, 'handoffs/x.md', 'handoffs/shipped');
  file('x.md', 'three');
  const b = moveFile(shared, 'handoffs/x.md', 'handoffs/shipped');
  assert.notEqual(a, b);
  assert.equal(markedNotPicked('# H\nGoal\n\n1\n2\n3\n4\n- Not picked: option B'), false);
});

test('a start naming a moved handoff makes no second ideas row, and reconcile does not throw (#1432)', () => {
  const { dir, store, project, shared, file, minion } = setup();
  file('x.md', '# Handoff X\nDo it.');
  store.ideas.sync(project, shared);
  tidyForClosed(store, dir, project, 'handoffs/x.md');
  const t = minion('x', `Your brief is ${shared}/handoffs/x.md`);
  store.ideas.sync(project, shared);
  reconcileMoved(store, dir, project);
  store.ideas.sync(project, shared);
  const rows = store.db.prepare('SELECT card, handoff, ticket_id FROM ideas WHERE project_id = ?').all(project) as any[];
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].card, 'handoffs/shipped/x.md');
  assert.equal(rows[0].ticket_id, t.id);
});

test('relocate combines a loose row with its shipped twin, decided fields win, and one failure skips no other file (#1432)', () => {
  const { dir, store, project, shared, file } = setup();
  file('a.md'); file('b.md');
  for (const n of ['a', 'b']) {
    mkdirSync(join(shared, 'handoffs/shipped'), { recursive: true });
    writeFileSync(join(shared, `handoffs/shipped/${n}.md`), '# x');
    store.ideas.upsert(project, '', `handoffs/shipped/${n}.md`, { handoff: `handoffs/shipped/${n}.md` });
    store.ideas.upsert(project, '', `handoffs/${n}.md`, { handoff: `handoffs/${n}.md`, pick: 'go', decided_by: 'Cara' });
  }
  rmSync(join(shared, 'handoffs/a.md')); rmSync(join(shared, 'handoffs/b.md'));
  reconcileMoved(store, dir, project);
  const rows = store.db.prepare('SELECT card, pick FROM ideas WHERE project_id = ? ORDER BY card').all(project) as any[];
  assert.deepEqual(rows.map((r) => [r.card, r.pick]), [['handoffs/shipped/a.md', 'go'], ['handoffs/shipped/b.md', 'go']]);
});
