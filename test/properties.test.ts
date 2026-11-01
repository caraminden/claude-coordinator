import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store, titleWithoutBuild } from '../src/db.ts';
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
  assert.deepEqual(citadel, ['type', 'stage', 'requestedBy', 'assigned']);
  assert.deepEqual(delve, ['type', 'stage', 'requestedBy', 'assigned', 'playerClass', 'assetType', 'area', 'build']);
  const classes = s.props.list(1).find((k) => k.key === 'playerClass')!.values;
  assert.equal(classes.length, 23);
  assert.ok(!classes.some((v) => v.value === 'Untrained'));
});

test('a global key added to the seed later joins an existing registry once, and stays archived if archived', () => {
  const s = freshStore();
  const path = s.db.location()!;
  s.db.exec("DELETE FROM property_keys WHERE scope IS NULL AND key = 'assigned'");
  s.db.close();
  const again = new Store(path);
  assert.ok(again.props.list(2).some((k) => k.key === 'assigned'));
  again.db.exec("UPDATE property_keys SET status = 'archived' WHERE key = 'assigned'");
  again.db.close();
  const third = new Store(path);
  assert.equal(third.db.prepare("SELECT count(*) AS n FROM property_keys WHERE key = 'assigned'").get()!.n, 1);
  assert.equal(third.props.list(2).find((k) => k.key === 'assigned')!.status, 'archived');
});

test("a person's name matches the spelling already in use, whatever its case", () => {
  const s = freshStore();
  const a = ticket(s, 2);
  const b = ticket(s, 2);
  s.props.set('minion', a, 2, { assigned: 'Josh' }, 'Cara');
  s.props.set('minion', b, 2, { assigned: 'josh ', requestedBy: 'CARA' }, 'Cara');
  assert.deepEqual(s.props.forTarget('minion', b), { requestedBy: 'CARA', assigned: 'Josh' });
  // Across person keys too: Cara asked for b as CARA, so assigning "cara" uses that spelling.
  s.props.set('minion', a, 2, { assigned: 'cara' }, 'Cara');
  assert.equal(s.props.forTarget('minion', a).assigned, 'CARA');
  s.props.set('minion', b, 2, { assigned: null }, 'Cara');
  assert.equal(s.props.forTarget('minion', b).assigned, undefined);
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

test("build: the property and the column stay in step, in schemes that have the key", () => {
  const s = freshStore();
  const id = ticket(s, 1);
  s.props.set('minion', id, 1, { build: 8 }, 'x');
  assert.equal(s.getTicket(id)!.build, 8);
  s.props.set('minion', id, 1, { build: null }, 'x');
  assert.equal(s.getTicket(id)!.build, null);
  s.props.setBuild(id, 9, 'x');
  assert.equal(s.props.forTarget('minion', id).build, 9);
  s.props.setBuild(id, null, 'x');
  assert.equal(s.props.forTarget('minion', id).build, undefined);
  const citadel = ticket(s, 2);
  s.props.setBuild(citadel, 9, 'x'); // Citadel has no build key: nothing to mirror
  assert.equal(s.props.forTarget('minion', citadel).build, undefined);
});

test('settling builds once: property and column agree, and titles drop a matching build', () => {
  const path = join(root, `${Math.random()}.db`);
  let s = new Store(path);
  s.createProject('Delve', null);
  s.db.close();
  s = new Store(path); // seeds Delve's keys
  const make = (title: string, build: number | null) => {
    const t = s.createTicket({ project_id: 1, title, permission_mode: 'default', created_by: 'Cara' });
    s.db.prepare('UPDATE tickets SET build = ? WHERE id = ?').run(build, t.id);
    return t.id;
  };
  const lairs = make('Lairs · Build #8', 8);
  const major = make('Major Build #7', 7);
  const wrong = make('Workshop · Build #7', 9);
  const fromProp = make('Tomes (Build 9)', null);
  s.db.prepare("INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at) SELECT 'minion', ?, id, '9', 'x', 0 FROM property_keys WHERE scope = 1 AND key = 'build'").run(fromProp);
  s.db.prepare("DELETE FROM settings WHERE key = 'builds_settled'").run();
  s.db.close();
  s = new Store(path);
  assert.equal(s.getTicket(lairs)!.title, 'Lairs');
  assert.equal(s.props.forTarget('minion', lairs).build, 8);
  assert.equal(s.getTicket(major)!.title, 'Major Build #7');
  assert.equal(s.getTicket(wrong)!.title, 'Workshop · Build #7');
  assert.equal(s.props.forTarget('minion', wrong).build, 9, 'the column wins');
  assert.deepEqual([s.getTicket(fromProp)!.title, s.getTicket(fromProp)!.build], ['Tomes', 9]);
  assert.ok(s.listEvents(lairs).some((e) => JSON.parse(e.data).text?.startsWith('Citadel renamed this minion from "Lairs · Build #8" to "Lairs"')));
  s.db.prepare("UPDATE tickets SET title = 'Again · Build #8' WHERE id = ?").run(lairs);
  s.db.close();
  s = new Store(path);
  assert.equal(s.getTicket(lairs)!.title, 'Again · Build #8', 'only once');
});

test('titleWithoutBuild', () => {
  assert.equal(titleWithoutBuild('Lairs · Build #8', 8), 'Lairs');
  assert.equal(titleWithoutBuild('Lairs - build 8', 8), 'Lairs');
  assert.equal(titleWithoutBuild('Lairs (Build #8)', 8), 'Lairs');
  assert.equal(titleWithoutBuild('Lairs · Build #8', 7), 'Lairs · Build #8');
  for (const t of ['Major Build #7', 'Build 7 Features', 'Move Build 7 Along', 'Rebuild 7']) assert.equal(titleWithoutBuild(t, 7), t);
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
  assert.deepEqual(r.unreviewed, ['weather']);
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

test('approving a proposed key approves every value under it, and a setup plan counts as review (#180)', () => {
  const s = freshStore();
  const values = (key: string) => s.props.list(1).find((k) => k.key === key)!.values.map((v) => [v.value, v.status, v.reviewed]);
  // A Taskmaster's key with values (live, unreviewed), plus a minion's proposed value and an archived one.
  s.props.registerKey(1, { key: 'game', description: 'x', values: [{ value: 'wow' }, { value: 'poe' }] }, tm(1));
  s.db.prepare("INSERT INTO property_values (key_id, value, status, reviewed, created_by, created_at) SELECT id, 'lol', 'proposed', 0, 'x', 0 FROM property_keys WHERE key = 'game'").run();
  s.db.prepare("INSERT INTO property_values (key_id, value, status, reviewed, created_by, created_at) SELECT id, 'old', 'archived', 0, 'x', 0 FROM property_keys WHERE key = 'game'").run();
  s.props.review(1, { key: 'game', action: 'approve' }, cara);
  assert.deepEqual(values('game'), [['wow', 'active', true], ['poe', 'active', true], ['lol', 'active', true], ['old', 'archived', false]]);
  // Single values can still be archived after.
  s.props.review(1, { key: 'game', value: 'lol', action: 'archive' }, cara);

  // Under an approved setup plan, what it names (whole words, any case) goes in approved.
  const planned: Actor = { ...tm(1), setupPlan: '## Properties\n- `Zone`: north, south-east' } as Actor;
  assert.equal(s.props.registerKey(1, { key: 'zone', description: 'x', values: [{ value: 'north' }, { value: 'south' }] }, planned).status, 'active');
  assert.deepEqual(values('zone'), [['north', 'active', true], ['south', 'active', false]], '"south" is only part of "south-east"');
  assert.deepEqual(s.props.registerValues(1, 'zone', [{ value: 'south-east' }, { value: 'west' }], planned, true).unreviewed, ['west']);
  assert.equal(s.props.registerKey(1, { key: 'region', description: 'x' }, planned).status, 'proposed');
  // A minion's proposal never counts, plan or not.
  assert.equal(s.props.propose(1, { key: 'north', reason: 'x' }, { ...minion(1), setupPlan: 'north' } as Actor).proposed, true);
  assert.equal(s.props.list(1).find((k) => k.key === 'north')!.status, 'proposed');
});

test('list groups (#253): moving to schema 21 types every minion and promotes Delve\'s balance work, once', () => {
  const path = join(root, `${Math.random()}.db`);
  let s = new Store(path);
  const delve = s.createProject('Delve', null).id;
  const citadel = s.createProject('Citadel', null).id;
  const [untyped, typed] = [ticket(s, citadel, null, 'closed'), ticket(s, citadel)];
  s.props.set('minion', typed, citadel, { type: 'bug' }, 'Cara');
  s.setSetting('schema_version', 20);
  s.db.close();
  s = new Store(path);
  assert.equal(s.props.forTarget('minion', untyped).type, 'other');
  assert.equal((s.db.prepare('SELECT set_by FROM properties WHERE target_id = ? AND value = ?').get(untyped, 'other') as { set_by: string }).set_by, 'migration');
  assert.equal(s.props.forTarget('minion', typed).type, 'bug');
  assert.equal(s.getProject(delve)!.list_groups, '["area: balance"]');
  assert.equal(s.getProject(citadel)!.list_groups, '[]');
  // Once: Delve clearing its groups stays cleared after a restart.
  s.setProjectSettings(delve, { list_groups: '[]' });
  s.db.close();
  s = new Store(path);
  assert.equal(s.getProject(delve)!.list_groups, '[]');
});

test("list groups take the scheme's own keys and values, written as stored", () => {
  const s = freshStore();
  assert.deepEqual(s.props.listGroups(1, ['Area: Balance', 'area:ui', 'area: balance']), ['area: balance', 'area: ui']);
  assert.deepEqual(s.props.listGroups(1, []), []);
  assert.throws(() => s.props.listGroups(1, ['type: bug']), err(400, /global key/));
  assert.throws(() => s.props.listGroups(1, ['area: nowhere']), err(400, /isn't one of the `area` values/));
  assert.throws(() => s.props.listGroups(2, ['area: balance']), err(400, /no property `area`/));
  assert.throws(() => s.props.listGroups(1, ['balance']), err(400, /key: value/));
  assert.throws(() => s.props.listGroups(1, 'area: balance'), err(400, /must be a list/));
});
