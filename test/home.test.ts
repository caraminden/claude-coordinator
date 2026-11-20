import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { HOME_FIRST_LOOK, HOME_VISIT_GAP, homeSince, homeView } from '../src/inbox.ts';

const root = mkdtempSync(join(tmpdir(), 'home-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Schemes other than Citadel (every-scheme rule): ids 1 and 2 go to placeholders, so none of these is Citadel's id.
function setup(file: string) {
  const store = new Store(join(root, file));
  store.typedHandlesUpTo = 0;
  store.createProject('Placeholder one', null);
  store.createProject('Placeholder two', null);
  const josh = store.createUser({ name: 'josh', login: 'josh' });
  const scheme = (name: string, member = true) => {
    const p = store.createProject(name, null);
    if (member) store.addMember(p.id, josh.id);
    return p.id;
  };
  const minion = (projectId: number, title: string) =>
    store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'cara' });
  return { store, josh, scheme, minion, approvals: new Approvals(() => {}) };
}

test('Home lists what waits on a person across their schemes: Taskmasters first, then oldest first; not schemes they hid or aren\'t in', () => {
  const { store, josh, scheme, minion, approvals } = setup('items.sqlite');
  const peek = scheme('Peek Auras'), voice = scheme('VoiceAnalyzer'), hid = scheme('Hidden one'), outside = scheme('Not theirs', false);
  assert.ok(![peek, voice, hid, outside].includes(2), 'none of them is the Citadel scheme');
  store.setProjectHidden(josh.id, hid, true);
  const old = minion(voice, 'old ask'), newer = minion(peek, 'newer ask');
  store.addEvent(old.id, 'question', { id: 'q-old', questions: [] });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // a later millisecond for the newer card
  store.addEvent(newer.id, 'question', { id: 'q-new', questions: [] });
  const tm = store.createTicket({ project_id: peek, title: 'Taskmaster', kind: 'coordinator', permission_mode: 'bypassPermissions', created_by: 'cara' } as never);
  store.addEvent(tm.id, 'plan', { id: 'p-tm', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(minion(hid, 'hidden ask').id, 'question', { id: 'q-hidden', questions: [] });
  store.addEvent(minion(outside, 'outside ask').id, 'question', { id: 'q-outside', questions: [] });

  const home = homeView(store, approvals, { name: 'josh', uid: josh.id }, () => false, 0);
  assert.deepEqual(home.items.map((i) => (i.card as { id: string }).id), ['p-tm', 'q-old', 'q-new'],
    'the Taskmaster\'s card leads though it is newest; then oldest first; hidden and non-member schemes stay out');
  assert.deepEqual(home.items[1].from, { projectId: voice, scheme: 'VoiceAnalyzer', number: old.number, kind: 'ticket', title: 'old ask' });
  assert.deepEqual(home.schemes.map((s) => s.name), ['Peek Auras', 'VoiceAnalyzer']);
});

test('Home\'s working minions and what shipped since, only in the person\'s schemes; build merges aren\'t ships', () => {
  const { store, josh, scheme, minion, approvals } = setup('shipped.sqlite');
  const peek = scheme('Peek Auras'), outside = scheme('Not theirs', false);
  const busy = minion(peek, 'busy one'), idle = minion(peek, 'idle one'), there = minion(outside, 'theirs');
  const start = Date.now();
  store.addEvent(idle.id, 'note', { text: 'Shipped abc1234: the fix. Risk low: tests. Live now.' });
  store.addEvent(idle.id, 'note', { text: 'Merged abc1235 into build/5: a feeder. Risk low: x.' });
  store.addEvent(there.id, 'note', { text: 'Shipped abc1236: elsewhere. Risk low: x.' });

  const home = homeView(store, approvals, { name: 'josh', uid: josh.id }, (t) => t.id === busy.id || t.id === there.id, start - 1000);
  assert.deepEqual(home.schemes, [{ id: peek, name: 'Peek Auras', working: [{ id: busy.id, number: busy.number, kind: 'ticket', title: 'busy one' }] }]);
  assert.equal(home.shipped.total, 1);
  assert.deepEqual(home.shipped.items.map((s) => [s.projectId, s.ticketId, s.title, s.text.slice(0, 15)]), [[peek, idle.id, 'idle one', 'Shipped abc1234']]);
  assert.equal(homeView(store, approvals, { name: 'josh', uid: josh.id }, () => false, Date.now() + 60_000).shipped.total, 0, 'nothing shipped after `since`');
});

test('a visit to Home counts what shipped since the last one ended, and keeps that start through its own refreshes', () => {
  const { store } = setup('visits.sqlite');
  const t0 = 1_800_000_000_000;
  assert.equal(homeSince(store, 'Josh', t0), t0 - HOME_FIRST_LOOK, 'a first visit looks back a day');
  assert.equal(homeSince(store, 'josh', t0 + 60_000), t0 - HOME_FIRST_LOOK, 'a refresh in the same visit keeps its start');
  const back = t0 + 60_000 + HOME_VISIT_GAP + 1;
  assert.equal(homeSince(store, 'josh', back), t0 + 60_000, 'a new visit starts where the last one ended');
  assert.equal(homeSince(store, 'cara', back), back - HOME_FIRST_LOOK, 'kept per person');
});
