import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { inboxCount, inboxItems } from '../src/inbox.ts';

const root = mkdtempSync(join(tmpdir(), 'inbox-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a scheme\'s inbox: open cards, ready/try minions and ones offering replies, approvals first, then newest first', () => {
  const store = new Store(join(root, 'db.sqlite'));
  const approvals = new Approvals(() => {});
  const minion = (projectId: number, title: string) =>
    store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const p1 = store.createProject('One', null).id;
  const p2 = store.createProject('Two', null).id;
  const a = minion(p1, 'a'), b = minion(p1, 'b'), gone = minion(p1, 'gone'), elsewhere = minion(p2, 'elsewhere');
  const ready = minion(p1, 'ready'), parked = minion(p1, 'parked'), offering = minion(p1, 'offering');
  store.updateTicket(ready, { state: 'ready', replies: JSON.stringify(['Merge it']) });
  store.updateTicket(parked, { state: 'parked' });
  store.updateTicket(offering, { replies: JSON.stringify(['Do it']) });
  store.addEvent(elsewhere, 'question', { id: 'q-other-scheme', questions: [] });

  store.addEvent(a, 'question', { id: 'q-open', questions: [] });
  store.addEvent(a, 'question', { id: 'q-done', questions: [] });
  store.addEvent(a, 'user_message', { text: 'answers', answer: { questionId: 'q-done', answers: [] } });
  store.addEvent(b, 'plan', { id: 'p-open', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(b, 'plan', { id: 'p-old', summary: 's', plan: 'p', status: 'superseded' });
  store.addEvent(b, 'plan', { id: 'p-ok', summary: 's', plan: 'p', status: 'approved', by: 'Cara', at: 1 });
  store.addEvent(gone, 'question', { id: 'q-dismissed', questions: [] });
  store.updateTicket(gone, { status: 'closed' });
  const approvalId = approvals.request(a, 'Bash', { command: 'ls' });
  const settled = approvals.request(b, 'Bash', { command: 'pwd' });
  approvals.decide(b, settled, true, 'Cara');

  approvals.request(elsewhere, 'Bash', { command: 'id' });

  const items = inboxItems(store, approvals, p1, 'Cara');
  assert.deepEqual([items[0].kind, items[0].ticketId, (items[0].card as any).id], ['approval', a, approvalId]);
  assert.deepEqual(items.slice(1).map((i) => [i.kind, i.ticketId, (i.card as any)?.id ?? null]).sort(),
    [['plan', b, 'p-open'], ['question', a, 'q-open'], ['replies', offering, null], ['state', ready, null]], 'a ready minion with replies is listed once');
  for (let i = 2; i < items.length; i++) assert.ok(items[i - 1].at >= items[i].at);
  assert.equal((items[0].card as any).tool, 'Bash');
});

test('a card a person handled by typing in the chat leaves the inbox; the Taskmaster, minions and other cards\' clicks don\'t clear it', () => {
  const store = new Store(join(root, 'typed.sqlite'));
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const typed = minion('typed'), relayed = minion('relayed'), clicked = minion('clicked');

  store.addEvent(typed, 'plan', { id: 'p-typed', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(typed, 'question', { id: 'q-typed', questions: [] });
  store.addEvent(typed, 'user_message', { author: 'cara', text: '1. Approve 2. Yes' });

  store.addEvent(relayed, 'question', { id: 'q-relayed', questions: [] });
  for (const author of ['Taskmaster', 'Coordinator', 'GitHub', 'Citadel', '#12 Other minion']) store.addEvent(relayed, 'user_message', { author, text: 'fyi' });

  store.addEvent(clicked, 'question', { id: 'q-old', questions: [] });
  store.addEvent(clicked, 'plan', { id: 'p-new', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(clicked, 'user_message', { author: 'Cara', text: 'answers', answer: { questionId: 'q-old', answers: [] } });

  assert.deepEqual(store.openCards(p).map((e) => JSON.parse(e.data).id), ['q-relayed', 'p-new']);
});

test('openCardAt: when a minion\'s oldest open card was posted, for the list\'s "?" badge; answered, settled, superseded and dismissed cards don\'t count', () => {
  const store = new Store(join(root, 'card-at.sqlite'));
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const two = minion('two'), done = minion('done'), gone = minion('gone');

  store.addEvent(two, 'question', { id: 'q-answered', questions: [] });
  store.addEvent(two, 'user_message', { author: 'Cara', text: 'answers', answer: { questionId: 'q-answered', answers: [] } });
  const oldest = store.addEvent(two, 'plan', { id: 'p-open', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(two, 'question', { id: 'q-open', questions: [] });
  assert.equal(store.openCardAt(two), oldest.created_at);

  store.addEvent(done, 'question', { id: 'q-settled', questions: [], settled: { at: 1 } });
  store.addEvent(done, 'plan', { id: 'p-old', summary: 's', plan: 'p', status: 'superseded' });
  store.addEvent(done, 'plan', { id: 'p-ok', summary: 's', plan: 'p', status: 'approved', by: 'Cara', at: 1 });
  assert.equal(store.openCardAt(done), null);

  store.addEvent(gone, 'question', { id: 'q-gone', questions: [] });
  assert.ok(store.openCardAt(gone));
  store.updateTicket(gone, { status: 'closed' });
  assert.equal(store.openCardAt(gone), null);
});

test('inboxCount: the Needs-you badge\'s number for one person; a ready or replies minion they opened since it changed stops counting, cards never do', () => {
  const store = new Store(join(root, 'count.sqlite'));
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const ready = minion('ready'), offering = minion('offering'), asking = minion('asking');
  store.updateTicket(ready, { state: 'ready' });
  store.updateTicket(offering, { replies: JSON.stringify(['Do it']) });
  store.addEvent(asking, 'question', { id: 'q', questions: [] });
  const at = (id: number) => store.getTicket(id)!.updated_at;

  assert.equal(inboxCount(store, approvals, p, 'Cara', {}), 3);
  assert.equal(inboxCount(store, approvals, p, 'Cara', { [ready]: at(ready), [offering]: at(offering) - 1, [asking]: at(asking) + 1 }), 2, 'only the opened ready minion fades');
});

test('each person\'s inbox holds only their own minions and unassigned ones, cards and approvals too (#197)', () => {
  const store = new Store(join(root, 'mine.sqlite'));
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const minion = (title: string, assigned?: string) => {
    const id = store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
    if (assigned) store.props.set('minion', id, p, { assigned }, 'Cara');
    store.updateTicket(id, { state: 'ready' });
    return id;
  };
  const cara = minion('cara', 'Cara'), josh = minion('josh', 'Josh'), nobody = minion('nobody');
  const tm = store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' }).id;
  store.addEvent(josh, 'question', { id: 'q-josh', questions: [] });
  store.addEvent(tm, 'question', { id: 'q-tm', questions: [] });
  approvals.request(josh, 'Bash', { command: 'ls' });

  const ids = (person: string) => [...new Set(inboxItems(store, approvals, p, person).map((i) => i.ticketId))].sort();
  assert.deepEqual(ids('cara'), [cara, nobody, tm].sort(), 'names match in any case');
  assert.deepEqual(ids('Josh'), [josh, nobody, tm].sort());
  assert.equal(inboxCount(store, approvals, p, 'Josh', {}), 5, 'their ready minion, its question and approval, the unassigned one and the Taskmaster\'s question');
});
