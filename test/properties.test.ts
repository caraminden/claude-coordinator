import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { nearDuplicate, PropertyError, type Actor } from '../src/properties.ts';

const root = mkdtempSync(join(tmpdir(), 'props-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A store whose schemes exist before the registry seeds, like the live one: Delve is 1, Citadel 2. */
function freshStore(withTickets?: (s: Store) => void): Store {
  const path = join(root, `${Math.random()}.db`);
  const s = new Store(path);
  s.createProject('Delve', null);
  s.createProject('Citadel', null);
  withTickets?.(s);
  // Pretend the registry never ran, then reopen: what the first start after deploying does.
  s.db.exec("DELETE FROM properties; DELETE FROM property_values; DELETE FROM property_keys; DELETE FROM settings WHERE key = 'properties_backfilled';");
  s.db.close();
  return new Store(path);
}

const cara: Actor = { kind: 'person', name: 'Cara' };
const tm = (projectId: number): Actor => ({ kind: 'coordinator', name: 'Taskmaster', projectId, ticketId: 999 });
const minion = (projectId: number): Actor => ({ kind: 'thread', name: '#5 Thing', projectId, ticketId: 5 });
const err = (status: number, re: RegExp) => (e: unknown) => e instanceof PropertyError && e.status === status && re.test(e.message);

function ticket(s: Store, projectId: number, tag: string | null = null, status = 'idle') {
  const t = s.createTicket({ project_id: projectId, title: 'T', permission_mode: 'default', created_by: 'Cara', tag: tag as any });
  s.updateTicket(t.id, { status: status as any });
  return t.id;
}

test('seeds global keys for every scheme and Delve keys only for Delve', () => {
  const s = freshStore();
  const delve = s.props.list(1).map((k) => k.key);
  const citadel = s.props.list(2).map((k) => k.key);
  assert.deepEqual(citadel, ['type', 'stage', 'requestedBy']);
  assert.deepEqual(delve, ['type', 'stage', 'requestedBy', 'playerClass', 'assetType', 'area', 'build']);
  const classes = s.props.list(1).find((k) => k.key === 'playerClass')!.values;
  assert.equal(classes.length, 23);
  assert.ok(!classes.some((v) => v.value === 'Untrained'));
});

test('backfills type from the old tag and stage from status, once', () => {
  let ids: number[] = [];
  const s = freshStore((st) => {
    ids = [ticket(st, 1, 'process'), ticket(st, 1, 'idea'), ticket(st, 2, 'bug', 'closed'), ticket(st, 2, null)];
  });
  assert.deepEqual(s.props.forTarget('minion', ids[0]), { type: 'chore', stage: 'in-progress' });
  assert.deepEqual(s.props.forTarget('minion', ids[1]), { type: 'ideation', stage: 'idea' });
  assert.deepEqual(s.props.forTarget('minion', ids[2]), { type: 'bug', stage: 'done' });
  assert.deepEqual(s.props.forTarget('minion', ids[3]), { stage: 'in-progress' });
});

test('aliases, case and spacing resolve to the canonical value; unknowns get a hint', () => {
  const s = freshStore();
  const id = ticket(s, 1);
  s.props.set('minion', id, 1, { Type: 'Artwork', stage: 'In Progress', area: ['Combat', 'ui', 'combat'], playerClass: 'sapper', build: '8' }, 'Cara');
  assert.deepEqual(s.props.forTarget('minion', id), { type: 'art', stage: 'in-progress', playerClass: ['Warrior'], area: ['dungeons', 'ui'], build: 8 });
  assert.throws(() => s.props.set('minion', id, 1, { type: 'featur' }, 'Cara'), err(400, /did you mean `feature`/));
  assert.throws(() => s.props.set('minion', id, 1, { areas: 'town' }, 'Cara'), err(400, /did you mean `area`/));
  assert.throws(() => s.props.set('minion', id, 1, { type: ['bug', 'feature'] }, 'Cara'), err(400, /takes one value/));
  // Nothing from a refused call is written.
  assert.throws(() => s.props.set('minion', id, 1, { stage: 'done', type: 'nope' }, 'Cara'));
  assert.equal(s.props.forTarget('minion', id).stage, 'in-progress');
  // null clears.
  s.props.set('minion', id, 1, { area: null }, 'Cara');
  assert.equal(s.props.forTarget('minion', id).area, undefined);
});

test("a scheme can't see or set another scheme's keys", () => {
  const s = freshStore();
  const id = ticket(s, 2);
  assert.throws(() => s.props.set('minion', id, 2, { area: 'town' }, 'Cara'), err(400, /no property `area`/));
});

test('type keeps the old tag in step, and other asks people', () => {
  const s = freshStore();
  const id = ticket(s, 2, 'feature');
  s.props.set('minion', id, 2, { type: 'process' }, 'x');
  assert.equal(s.getTicket(id)!.tag, 'process');
  const r = s.props.set('minion', id, 2, { type: 'other' }, 'x');
  assert.equal(s.getTicket(id)!.tag, null);
  assert.match(r.notes.join(), /ask people/);
  s.props.setTypeFromTag(id, 'idea', 'x');
  assert.equal(s.props.forTarget('minion', id).type, 'ideation');
});

test('stage starts, finishes on dismissal and comes back on reopening', () => {
  const s = freshStore();
  const a = ticket(s, 2, 'idea');
  s.props.setTypeFromTag(a, 'idea', 'x');
  s.props.startStage(a);
  assert.equal(s.props.forTarget('minion', a).stage, 'idea');
  s.updateTicket(a, { status: 'closed' });
  assert.equal(s.props.forTarget('minion', a).stage, 'done');
  s.updateTicket(a, { status: 'idle' });
  assert.equal(s.props.forTarget('minion', a).stage, 'in-progress');
});

test('who may register what', () => {
  const s = freshStore();
  // Delve's Taskmaster adds a Delve value at once, unreviewed.
  const r = s.props.registerValues(1, 'area', [{ value: 'weather' }], tm(1));
  assert.deepEqual(r.added, ['weather']);
  assert.equal(r.unreviewed, true);
  assert.equal(s.props.list(1).find((k) => k.key === 'area')!.values.find((v) => v.value === 'weather')!.reviewed, false);
  // ...but not to a global key, nor another scheme's.
  assert.throws(() => s.props.registerValues(1, 'type', [{ value: 'music' }], tm(1)), err(403, /Citadel/));
  // Citadel's Taskmaster may.
  assert.deepEqual(s.props.registerValues(2, 'type', [{ value: 'music' }], tm(2)).added, ['music']);
  // Minions only propose.
  assert.throws(() => s.props.registerValues(1, 'area', [{ value: 'sky' }], minion(1)), err(403, /propose/));
  // A Taskmaster's new key waits for a person; a person's is live.
  assert.equal(s.props.registerKey(1, { key: 'enemy', description: 'x' }, tm(1)).status, 'proposed');
  assert.throws(() => s.props.set('minion', ticket(s, 1), 1, { enemy: 'x' }, 'x'), err(400, /proposed/));
  assert.throws(() => s.props.review(1, { key: 'enemy', action: 'approve' }, tm(1)), err(403, /person/));
  s.props.review(1, { key: 'enemy', action: 'approve' }, cara);
  assert.equal(s.props.list(1).find((k) => k.key === 'enemy')!.status, 'active');
  // Global keys only from Citadel's Taskmaster or a person.
  assert.throws(() => s.props.registerKey(1, { key: 'milestone', global: true }, tm(1)), err(403, /global/));
});

test('key names are unique across global and a scheme, and near-duplicates warn', () => {
  const s = freshStore();
  assert.throws(() => s.props.registerKey(1, { key: 'type' }, cara), err(409, /global key/));
  assert.throws(() => s.props.registerKey(2, { key: 'area', global: true }, cara), err(409, /key in Delve/));
  // Citadel can have its own `area`: it's only Delve's.
  assert.equal(s.props.registerKey(2, { key: 'area' }, cara).registered, true);
  const warned = s.props.registerKey(1, { key: 'areas' }, cara);
  assert.equal(warned.registered, false);
  assert.match(warned.warnings.join(), /`area`/);
  assert.equal(s.props.registerKey(1, { key: 'areas', force: true }, cara).registered, true);
});

test('new values: near-duplicates warn, aliases may not collide, existing values gain aliases', () => {
  const s = freshStore();
  const w = s.props.registerValues(2, 'type', [{ value: 'artistry' }], cara);
  assert.deepEqual(w.added, []);
  assert.match(w.warnings.join(), /`type: art`/);
  assert.throws(() => s.props.registerValues(2, 'type', [{ value: 'fix' }], cara), err(409, /alias of `bug`/));
  assert.throws(() => s.props.registerValues(2, 'type', [{ value: 'music', aliases: ['defect'] }], cara), err(409, /means/));
  // `wip` is a stage alias, not a type one, so a type alias of it is fine.
  assert.deepEqual(s.props.registerValues(2, 'type', [{ value: 'music', aliases: ['audio'] }], cara).added, ['music']);
  assert.deepEqual(s.props.registerValues(2, 'type', [{ value: 'bug', aliases: ['crash'] }], cara).updated, ['bug']);
  const id = ticket(s, 2);
  s.props.set('minion', id, 2, { type: 'crash' }, 'x');
  assert.equal(s.props.forTarget('minion', id).type, 'bug');
});

test('proposals, review, archive and merge', () => {
  const s = freshStore();
  const p = s.props.propose(1, { key: 'area', value: 'weather', reason: 'storms' }, minion(1));
  assert.equal(p.proposed, true);
  const id = ticket(s, 1);
  assert.throws(() => s.props.set('minion', id, 1, { area: 'weather' }, 'x'), err(400, /proposed/));
  s.props.review(1, { key: 'area', value: 'weather', action: 'approve' }, tm(1));
  s.props.set('minion', id, 1, { area: ['weather', 'town'] }, 'x');
  // Merging moves what carried it over and keeps the old word as an alias.
  s.props.review(1, { key: 'area', value: 'weather', action: 'merge', into: 'dungeons' }, cara);
  assert.deepEqual(s.props.forTarget('minion', id).area, ['town', 'dungeons']);
  s.props.set('minion', id, 1, { area: 'weather' }, 'x');
  assert.deepEqual(s.props.forTarget('minion', id).area, ['dungeons']);
  // Archived values stay where they are but can't be set again.
  s.props.review(1, { key: 'area', value: 'dungeons', action: 'archive' }, cara);
  assert.deepEqual(s.props.forTarget('minion', id).area, ['dungeons']);
  assert.throws(() => s.props.set('minion', ticket(s, 1), 1, { area: 'dungeons' }, 'x'), err(400, /archived/));
  // A minion's key proposal waits too.
  assert.equal(s.props.propose(1, { key: 'enemy', reason: 'bosses' }, minion(1)).proposed, true);
  assert.equal(s.props.list(1).find((k) => k.key === 'enemy')!.status, 'proposed');
});

test('properties go when what carries them goes', () => {
  const s = freshStore();
  const id = ticket(s, 1);
  s.props.set('minion', id, 1, { type: 'bug' }, 'x');
  s.deleteTicket(id);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM properties WHERE target_type = 'minion' AND target_id = ?").get(id)!.n, 0);
});

test('the generated doc shows keys and values as key: value material', () => {
  const s = freshStore();
  s.props.registerValues(1, 'area', [{ value: 'weather' }], tm(1));
  const doc = s.props.doc(1, 'Delve');
  assert.match(doc, /^generated: true$/m);
  assert.match(doc, /### `type`: Type/);
  assert.match(doc, /\| `weather` \|  \| \*\*new, not reviewed yet\*\* \|/);
  assert.match(doc, /## Delve/);
  assert.doesNotMatch(s.props.doc(2, 'Citadel'), /playerClass/);
});

test('nearDuplicate', () => {
  for (const [a, b] of [['art', 'artwork'], ['area', 'areas'], ['story', 'stories'], ['feature', 'featur'], ['playerClass', 'player-class'], ['dungeon', 'dungeons']]) assert.ok(nearDuplicate(a, b), `${a} ~ ${b}`);
  for (const [a, b] of [['art', 'bug'], ['ui', 'vfx'], ['town', 'tome'], ['heroes', 'herbs']]) assert.ok(!nearDuplicate(a, b), `${a} !~ ${b}`);
});
