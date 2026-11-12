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
  const ready = minion(p1, 'ready'), parked = minion(p1, 'parked'), offering = minion(p1, 'offering'), complete = minion(p1, 'complete');
  store.updateTicket(complete, { state: 'complete', note: 'read: the report', replies: JSON.stringify(['Close it']) });
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
    [['plan', b, 'p-open'], ['question', a, 'q-open'], ['replies', offering, null], ['state', complete, null], ['state', ready, null]].sort(), 'a ready or complete minion with replies is listed once');
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

test('only a person\'s own message clears a card: another scheme\'s Taskmaster (live or held mail), relays, Mandate and briefs don\'t (#610)', () => {
  const store = new Store(join(root, 'not-people.sqlite'));
  const p = store.createProject('Peek', null).id;
  const tm = store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' }).id;
  const minion = store.createTicket({ project_id: p, title: 'm', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;

  store.addEvent(tm, 'question', { id: 'q-held-mail', questions: [] });
  store.addEvent(tm, 'user_message', { author: 'Taskmaster of Citadel', text: 'fyi', mail: true, cold: true, from: 99 });
  store.addEvent(tm, 'question', { id: 'q-live-relay', questions: [] });
  store.addEvent(tm, 'user_message', { author: 'Taskmaster of Citadel', text: 'fyi', from: 99 });
  store.addEvent(tm, 'user_message', { author: 'Mandate', text: 'Josh ticked an item (key k)' });
  store.addEvent(minion, 'plan', { id: 'p-brief', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(minion, 'user_message', { author: 'Josh', text: 'Scheduled run: do the thing', brief: true });

  assert.deepEqual(store.openCards(p).map((e) => JSON.parse(e.data).id), ['q-held-mail', 'q-live-relay', 'p-brief']);
  assert.deepEqual(store.recentCards(p, 10).map((r) => r.reply), [null, null, null]);

  store.addEvent(tm, 'user_message', { author: 'Josh', text: 'Centred, go', typed: true });
  assert.deepEqual(store.openCards(p).map((e) => JSON.parse(e.data).id), ['p-brief'], 'a person typing in the chat still handles its cards');
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

test('open cards read again on the same server: an answered card stays gone, new ones show, and a reopened minion\'s cards come back (#614)', () => {
  const store = new Store(join(root, 'cards-again.sqlite'));
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const a = minion('a'), b = minion('b');
  const ids = () => store.openCards(p).map((e) => JSON.parse(e.data).id);

  store.addEvent(a, 'question', { id: 'q1', questions: [] });
  store.addEvent(b, 'plan', { id: 'p1', summary: 's', plan: 'p', status: 'pending' });
  assert.deepEqual(ids(), ['q1', 'p1']);
  store.updateTicket(b, { status: 'closed' });
  store.addEvent(a, 'user_message', { author: 'Cara', text: 'answers', answer: { questionId: 'q1', answers: [] } });
  assert.deepEqual(ids(), []);
  assert.equal(store.openCardAt(a), null);

  store.addEvent(a, 'question', { id: 'q2', questions: [] });
  assert.deepEqual(ids(), ['q2'], 'a card posted after the done ones were remembered');
  store.updateTicket(b, { status: 'idle' });
  assert.deepEqual(ids(), ['p1', 'q2'], "a dismissed minion's card wasn't taken as done");
  assert.ok(store.openCardAt(b));
});

test('each item carries the chat event it jumps to: its card\'s for approvals, questions and plans; none for ready and replies (#236)', () => {
  const store = new Store(join(root, 'events.sqlite'));
  const approvals = new Approvals((ticketId, kind, data) => store.addEvent(ticketId, kind, data));
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const asking = minion('asking'), ready = minion('ready');
  store.updateTicket(ready, { state: 'ready' });
  const question = store.addEvent(asking, 'question', { id: 'q', questions: [] });
  const plan = store.addEvent(asking, 'plan', { id: 'p', summary: 's', plan: 'p', status: 'pending' });
  const approvalId = approvals.request(asking, 'Bash', { command: 'ls' });
  const approvalEvent = store.listEvents(asking).find((e) => e.kind === 'approval' && JSON.parse(e.data).id === approvalId)!;

  const byKind = Object.fromEntries(inboxItems(store, approvals, p, 'Cara').map((i) => [i.kind, i.eventId]));
  assert.deepEqual(byKind, { approval: approvalEvent.id, question: question.id, plan: plan.id, state: undefined });
  // Each item's key names it while it waits, for the scheme pill's "something new" (#539).
  assert.deepEqual(inboxItems(store, approvals, p, 'Cara').map((i) => i.key).sort(), [`approval:${approvalId}`, `plan:${plan.id}`, `question:${question.id}`, `state:${ready}`].sort());
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
  assert.equal(inboxCount(store, approvals, p, 'Josh', {}), 3, 'their minion (ready, with a question and an approval), the unassigned one and the Taskmaster: minions, not items (Cara, 2026-11-01)');
});

test('a minion assigned under a person\'s sign-in or GitHub login is in their inbox, its cards too (#582)', () => {
  const store = new Store(join(root, 'logins.sqlite'));
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const josh = store.createUser({ name: 'Josh', login: 'jkatz' });
  store.putCredential(josh.id, 'github', 'sealed', { login: 'KatzMeIfYouCan', id: 1, name: null });
  const minion = (title: string, assigned: string) => {
    const id = store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
    // Written straight to the table, as values stored before #582 were: the registry now resolves them on write.
    store.db.prepare("INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at) SELECT 'minion', ?, id, ?, 'Taskmaster', 0 FROM property_keys WHERE key = 'assigned' AND scope IS NULL").run(id, assigned);
    return id;
  };
  const byGithub = minion('github', 'KatzMeIfYouCan'), byLogin = minion('login', 'jkatz'), other = minion('other', 'Cara');
  store.addEvent(byGithub, 'question', { id: 'q-go', questions: [] });
  store.updateTicket(byLogin, { state: 'ready' });
  store.updateTicket(other, { state: 'ready' });
  const ids = [...new Set(inboxItems(store, approvals, p, 'Josh').map((i) => i.ticketId))].sort();
  assert.deepEqual(ids, [byGithub, byLogin].sort());
  assert.equal(inboxCount(store, approvals, p, 'Josh', {}), 2);
});

test('a parked minion waits on something else by design: out of the inbox and its badge, its open cards and replies too; an approval holding up a running turn still counts (#344)', () => {
  const store = new Store(join(root, 'parked.sqlite'));
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const asking = minion('asking'), offering = minion('offering'), blocked = minion('blocked'), live = minion('live');
  store.addEvent(asking, 'question', { id: 'q', questions: [] });
  store.addEvent(asking, 'plan', { id: 'p', summary: 's', plan: 'p', status: 'pending' });
  store.updateTicket(offering, { replies: JSON.stringify(['Go']) });
  store.updateTicket(live, { replies: JSON.stringify(['Go']) });
  approvals.request(blocked, 'Bash', { command: 'ls' });
  for (const id of [asking, offering, blocked]) store.updateTicket(id, { state: 'parked' });

  assert.deepEqual(inboxItems(store, approvals, p, 'Cara').map((i) => [i.kind, i.ticketId]).sort(), [['approval', blocked], ['replies', live]]);
  assert.equal(inboxCount(store, approvals, p, 'Cara', {}), 2);
});
