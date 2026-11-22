import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store, TYPED_HANDLES_UP_TO } from '../src/db.ts';
import { directCards, inboxCount, inboxItems } from '../src/inbox.ts';
import { sleepKey } from '../src/needs.ts';
import { addMention } from '../src/mentions.ts';

const root = mkdtempSync(join(tmpdir(), 'inbox-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a scheme\'s inbox: open cards and ones offering replies, not ready or complete ones (#1121), approvals first, then newest first', () => {
  const store = new Store(join(root, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
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
    [['plan', b, 'p-open'], ['question', a, 'q-open'], ['replies', offering, null]].sort(), 'a ready or complete minion is for looking at, not an answer: not listed, its replies neither (#1121)');
  for (let i = 2; i < items.length; i++) assert.ok(items[i - 1].at >= items[i].at);
  assert.equal((items[0].card as any).tool, 'Bash');
});

test('a card stays in the inbox past typed messages (#812), relays and other cards\' clicks; only its own answer clears it', () => {
  const store = new Store(join(root, 'typed.sqlite'));
  store.typedHandlesUpTo = 0;
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

  assert.deepEqual(store.openCards(p).map((e) => JSON.parse(e.data).id), ['p-typed', 'q-typed', 'q-relayed', 'p-new']);
});

test('no message clears a card but its own answer: another scheme\'s Taskmaster (live or held mail), relays, Mandate, briefs and typing (#610, #812)', () => {
  const store = new Store(join(root, 'not-people.sqlite'));
  store.typedHandlesUpTo = 0;
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
  assert.deepEqual(store.openCards(p).map((e) => JSON.parse(e.data).id), ['q-held-mail', 'q-live-relay', 'p-brief'], 'a person typing in the chat answers no card (#812)');
});

test('openCardAt: when a minion\'s oldest open card was posted, for the list\'s "?" badge; answered, settled, superseded and dismissed cards don\'t count', () => {
  const store = new Store(join(root, 'card-at.sqlite'));
  store.typedHandlesUpTo = 0;
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
  store.typedHandlesUpTo = 0;
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

  // events.id can be reused once the newest rows are deleted: a deleted minion's done card mustn't hide the next card.
  const c = minion('c');
  const last = store.addEvent(c, 'question', { id: 'q3', questions: [] });
  store.addEvent(c, 'user_message', { author: 'Cara', text: 'answers', answer: { questionId: 'q3', answers: [] } });
  assert.deepEqual(ids(), ['p1', 'q2']);
  store.deleteTicket(c);
  const d = minion('d');
  store.addEvent(d, 'question', { id: 'q4', questions: [] });
  const q5 = store.addEvent(d, 'question', { id: 'q5', questions: [] });
  assert.ok(q5.id <= last.id + 1, 'the new cards took the deleted ids');
  assert.deepEqual(ids(), ['p1', 'q2', 'q4', 'q5']);
});

test('each item carries the chat event it jumps to: its card\'s for approvals, questions and plans; none for replies (#236)', () => {
  const store = new Store(join(root, 'events.sqlite'));
  store.typedHandlesUpTo = 0;
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
  assert.deepEqual(byKind, { approval: approvalEvent.id, question: question.id, plan: plan.id });
  // Each item's key names it while it waits, for the scheme pill's "something new" (#539).
  assert.deepEqual(inboxItems(store, approvals, p, 'Cara').map((i) => i.key).sort(), [`approval:${approvalId}`, `plan:${plan.id}`, `question:${question.id}`].sort(), 'the ready minion is not an answer owed (#1121)');
});

test('inboxCount: the Needs-you badge\'s number for one person; a replies minion they opened since it changed stops counting, cards never do, ready never counts (#1121)', () => {
  const store = new Store(join(root, 'count.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const ready = minion('ready'), offering = minion('offering'), asking = minion('asking');
  store.updateTicket(ready, { state: 'ready' });
  store.updateTicket(offering, { replies: JSON.stringify(['Do it']) });
  store.addEvent(asking, 'question', { id: 'q', questions: [] });
  const at = (id: number) => store.getTicket(id)!.updated_at;

  assert.equal(inboxCount(store, approvals, p, 'Cara', {}), 2, 'the ready minion is not counted');
  assert.equal(inboxCount(store, approvals, p, 'Cara', { [offering]: at(offering) - 1, [asking]: at(asking) + 1 }), 2, 'opened before it changed: still counts');
  assert.equal(inboxCount(store, approvals, p, 'Cara', { [ready]: at(ready), [offering]: at(offering), [asking]: at(asking) + 1 }), 1, 'only the opened replies minion fades');
});

test('each person\'s inbox holds only their own minions and unassigned ones, cards and approvals too (#197)', () => {
  const store = new Store(join(root, 'mine.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  // An assignee counts only while they're in the scheme (#1449).
  for (const name of ['Cara', 'Josh']) store.addMember(p, store.createUser({ name, login: name.toLowerCase() }).id);
  const minion = (title: string, assigned?: string) => {
    const id = store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
    if (assigned) store.props.set('minion', id, p, { assigned }, 'Cara');
    store.updateTicket(id, { replies: JSON.stringify(['Go']) });
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
  assert.equal(inboxCount(store, approvals, p, 'Josh', {}), 3, 'their minion (offering replies, with a question and an approval), the unassigned one and the Taskmaster: minions, not items (Cara, 2026-11-01)');
});

test('a minion assigned under a person\'s sign-in or GitHub login is in their inbox, its cards too (#582)', () => {
  const store = new Store(join(root, 'logins.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const josh = store.createUser({ name: 'Josh', login: 'jkatz' });
  // An assignee counts only while in the scheme (#1449).
  for (const u of [josh, store.createUser({ name: 'Cara', login: 'cara' })]) store.addMember(p, u.id);
  store.putCredential(josh.id, 'github', 'sealed', { login: 'KatzMeIfYouCan', id: 1, name: null });
  const minion = (title: string, assigned: string) => {
    const id = store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
    // Written straight to the table, as values stored before #582 were: the registry now resolves them on write.
    store.db.prepare("INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at) SELECT 'minion', ?, id, ?, 'Taskmaster', 0 FROM property_keys WHERE key = 'assigned' AND scope IS NULL").run(id, assigned);
    return id;
  };
  const byGithub = minion('github', 'KatzMeIfYouCan'), byLogin = minion('login', 'jkatz'), other = minion('other', 'Cara');
  store.addEvent(byGithub, 'question', { id: 'q-go', questions: [] });
  store.updateTicket(byLogin, { replies: JSON.stringify(['Go']) });
  store.updateTicket(other, { replies: JSON.stringify(['Go']) });
  const ids = [...new Set(inboxItems(store, approvals, p, 'Josh').map((i) => i.ticketId))].sort();
  assert.deepEqual(ids, [byGithub, byLogin].sort());
  assert.equal(inboxCount(store, approvals, p, 'Josh', {}), 2);
});

test('a parked minion waits on something else by design: out of the inbox and its badge, its open cards and replies too; an approval holding up a running turn still counts (#344)', () => {
  const store = new Store(join(root, 'parked.sqlite'));
  store.typedHandlesUpTo = 0;
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

test('an asleep minion (#1636) is out of Needs you and its badge, its cards and mentions to one person and its replies too; an approval still counts, and waking brings the rest back', () => {
  const store = new Store(join(root, 'asleep.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const asking = minion('asking'), offering = minion('offering'), blocked = minion('blocked'), live = minion('live');
  store.addEvent(asking, 'question', { id: 'q', questions: [] });
  store.addEvent(asking, 'plan', { id: 'p', summary: 's', plan: 'p', status: 'pending', to: 'Cara' });
  store.updateTicket(offering, { replies: JSON.stringify(['Go']) });
  store.updateTicket(live, { replies: JSON.stringify(['Go']) });
  approvals.request(blocked, 'Bash', { command: 'ls' });
  addMention(store, 'Cara', { ticketId: asking, projectId: p, eventId: 99, at: Date.now(), by: 'Josh', text: '@Cara look' });
  for (const id of [asking, offering, blocked]) store.setSetting(sleepKey(id), { at: 1, by: 'Cara' });

  const kinds = () => inboxItems(store, approvals, p, 'Cara').map((i) => [i.kind, i.ticketId]).sort();
  assert.deepEqual(kinds(), [['approval', blocked], ['replies', live]]);
  assert.equal(inboxCount(store, approvals, p, 'Cara', {}), 2);
  for (const id of [asking, offering]) store.deleteSetting(sleepKey(id));
  assert.deepEqual(kinds(), [['approval', blocked], ['mention', asking], ['plan', asking], ['question', asking], ['replies', live], ['replies', offering]].sort());
});

test('a card addressed to one person (#687) is in their list alone, waits past typed messages, and shows in their other schemes too', () => {
  const store = new Store(join(root, 'direct.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const citadel = store.createProject('Citadel', cara.id).id;
  const peek = store.createProject('Peek', josh.id).id;
  const away = store.createProject('Away', cara.id).id; // Josh isn't a member here
  store.addMember(citadel, josh.id);
  const tm = store.createTicket({ project_id: citadel, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' }).id;
  const parked = store.createTicket({ project_id: citadel, title: 'parked', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  store.updateTicket(parked, { state: 'parked' });
  const elsewhere = store.createTicket({ project_id: away, title: 'away', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;

  store.addEvent(tm, 'question', { id: 'q-josh', questions: [], to: 'Josh' });
  store.addEvent(parked, 'plan', { id: 'p-josh', summary: 's', plan: 'p', status: 'pending', to: 'Josh' });
  store.addEvent(tm, 'question', { id: 'q-all', questions: [] });
  store.addEvent(elsewhere, 'question', { id: 'q-away', questions: [], to: 'Josh' });
  // Cara types in the Taskmaster's chat: it answers none of them (#812).
  store.addEvent(tm, 'user_message', { author: 'Cara', text: 'carry on', typed: true });

  const ids = (items: { card?: unknown }[]) => items.map((i) => (i.card as any)?.id).sort();
  assert.deepEqual(ids(inboxItems(store, approvals, citadel, 'Cara')), ['q-all'], 'the card for everyone stays, Josh\'s are not in Cara\'s list');
  assert.deepEqual(ids(inboxItems(store, approvals, citadel, 'josh')), ['p-josh', 'q-all', 'q-josh'], 'the addressee\'s, even on a parked minion');
  assert.equal(inboxCount(store, approvals, citadel, 'Josh', {}), 2);

  const there = directCards(store, peek, 'Josh');
  assert.deepEqual(ids(there), ['p-josh', 'q-josh'], 'shown in his own scheme too, never from a scheme he isn\'t in');
  assert.deepEqual(there.find((i) => (i.card as any).id === 'q-josh')!.from, { projectId: citadel, scheme: 'Citadel', number: store.getTicket(tm)!.number, kind: 'coordinator', title: 'Taskmaster' });
  assert.deepEqual(directCards(store, citadel, 'Josh'), [], 'the scheme he is looking at lists them already');
  assert.equal(inboxCount(store, approvals, peek, 'Josh', {}), 0, 'only the asking scheme counts them');

  // His answer, held as mail for a cold Taskmaster, still answers it.
  store.addEvent(tm, 'user_message', { author: 'Josh', text: 'answers', mail: true, cold: true, answer: { questionId: 'q-josh', answers: [] } });
  assert.deepEqual(ids(inboxItems(store, approvals, citadel, 'Josh')), ['p-josh', 'q-all']);
  assert.match(store.recentCards(citadel, 10).find((r) => JSON.parse(r.data).id === 'q-josh')!.reply ?? '', /"author":"Josh"/);
  assert.equal(store.recentCards(citadel, 10).find((r) => JSON.parse(r.data).id === 'p-josh')!.reply, null);
});

test('warmCardRows reads a few card rows a step, and recentCards then finds them read (#796)', () => {
  const store = new Store(join(root, 'card-warm.sqlite'));
  store.typedHandlesUpTo = 0;
  const p = store.createProject('Citadel', null).id;
  const a = store.createTicket({ project_id: p, title: 'a', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const plan = store.addEvent(a, 'plan', { id: 'p-1', summary: 's', plan: 'p', status: 'pending' });
  for (let i = 0; i < 4; i++) store.addEvent(a, 'question', { id: `q-${i}`, questions: [] });
  assert.equal(store.warmCardRows(p, 500, 2), 3, 'two of five read, three left');
  assert.equal(store.warmCardRows(p, 500, 2), 1);
  assert.equal(store.warmCardRows(p, 500, 2), 0);
  assert.equal(store.warmCardRows(p, 500, 2), 0, 'nothing more to read');
  // Changed behind the store's back, it still shows what the warm-up read: the rows were not read again.
  (store as any).db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify({ id: 'p-1', summary: 'behind', plan: 'p', status: 'pending' }), plan.id);
  const cards = store.recentCards(p, 500);
  assert.equal(cards.length, 5);
  assert.equal(JSON.parse(cards[0].data).summary, 's');
});

test('recentCards reads each card row once, and a card changed or deleted after that shows as it is now (#759)', () => {
  const store = new Store(join(root, 'card-rows.sqlite'));
  store.typedHandlesUpTo = 0;
  const p = store.createProject('Citadel', null).id;
  const minion = (title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const a = minion('a'), b = minion('b');
  const plan = store.addEvent(a, 'plan', { id: 'p-1', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(b, 'question', { id: 'q-1', questions: [] });
  for (let i = 0; i < 50; i++) store.addEvent(a, 'claude', { type: 'assistant', message: { content: [] } });
  const ids = () => store.recentCards(p, 10).map((r) => JSON.parse(r.data).id);
  assert.deepEqual(ids(), ['p-1', 'q-1']);

  // The second read takes the rows it has: changed under it by a write that skips the store, it doesn't see it.
  const db = (store as any).db;
  db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify({ id: 'p-1', summary: 'changed behind its back', plan: 'p', status: 'pending' }), plan.id);
  assert.equal(JSON.parse(store.recentCards(p, 10)[0].data).summary, 's', 'the card row is read once, not on every call');

  store.setEventData(plan.id, { id: 'p-1', summary: 's', plan: 'p', status: 'approved' });
  assert.equal(JSON.parse(store.recentCards(p, 10)[0].data).status, 'approved', 'setEventData shows at once');

  store.addEvent(a, 'question', { id: 'q-2', questions: [] });
  store.updateTicket(a, { status: 'closed' });
  assert.deepEqual(ids(), ['p-1', 'q-1', 'q-2'], 'a new card shows');
  assert.equal(store.recentCards(p, 10)[0].tstatus, 'closed', 'its minion is read fresh');
  assert.deepEqual(ids().slice(-2), ['q-1', 'q-2']);
  assert.deepEqual(store.recentCards(p, 2).map((r) => JSON.parse(r.data).id), ['q-1', 'q-2'], 'the newest `limit`, oldest first');

  // events.id has no AUTOINCREMENT: once the newest event's minion is deleted, the next event takes its id.
  const d = minion('d');
  const gone = store.addEvent(d, 'question', { id: 'q-gone', questions: [] });
  assert.deepEqual(ids(), ['p-1', 'q-1', 'q-2', 'q-gone']);
  store.deleteTicket(d);
  store.deleteTicket(b);
  const reused = store.addEvent(minion('c'), 'approval', { id: 'a-1', tool: 'Bash' });
  assert.equal(reused.id, gone.id);
  assert.deepEqual(ids(), ['p-1', 'q-2', 'a-1'], "a deleted minion's cards go, and a new card on a deleted one's id is read fresh");
});

test('eventsOfKinds reads only those kinds, after an id, oldest first (#759)', () => {
  const store = new Store(join(root, 'kinds.sqlite'));
  store.typedHandlesUpTo = 0;
  const p = store.createProject('Citadel', null).id;
  const t = store.createTicket({ project_id: p, title: 't', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const q = store.addEvent(t, 'question', { id: 'q' });
  store.addEvent(t, 'claude', { type: 'assistant' });
  const m = store.addEvent(t, 'user_message', { text: 'hi' });
  store.addEvent(t, 'plan', { id: 'p' });
  assert.deepEqual(store.eventsOfKinds(t, ['user_message', 'question']).map((e) => e.id), [q.id, m.id]);
  assert.deepEqual(store.eventsOfKinds(t, ['user_message', 'question'], q.id).map((e) => e.id), [m.id]);
  assert.deepEqual(store.eventsOfKinds(t, ['note']), []);
});

test('recentCards keeps what it found across a restart, and never shows a card another fate (#762)', () => {
  const file = join(root, 'card-fates.sqlite');
  const first = new Store(file);
  const p = first.createProject('Citadel', null).id;
  const minion = (title: string) => first.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const a = minion('a'), b = minion('b');
  first.addEvent(a, 'question', { id: 'q-1', questions: [] });
  first.addEvent(a, 'approval', { id: 'ap-1', tool: 'Bash' });
  first.addEvent(a, 'user_message', { author: 'Cara', text: 'the reply', answer: { questionId: 'q-1', answers: [] } });
  first.addEvent(a, 'approval_result', { id: 'ap-1', approved: true });
  first.addEvent(b, 'question', { id: 'q-2', questions: [] });
  const view = (s: Store) => s.recentCards(p, 10).map((r) => [JSON.parse(r.data).id, r.reply && JSON.parse(r.reply).text, r.result && JSON.parse(r.result).approved]);
  const before = view(first);
  assert.deepEqual(before, [['q-1', 'the reply', null], ['ap-1', null, true], ['q-2', null, null]]);

  // A restart: the same file, nothing in memory. The fates come from the file, not from a scan of the chats.
  const second = new Store(file);
  assert.equal((second as any).cardFates.size, 0);
  assert.deepEqual(view(second), before);
  assert.equal((second as any).db.prepare('SELECT count(*) AS n FROM card_fates').get().n, 3);
  // …proved by planting a fate the chat doesn't hold: it is taken as saved, so the scan isn't what produced it.
  (second as any).db.prepare("UPDATE card_fates SET reply = '{\"text\":\"planted\"}' WHERE cid = 'q-2'").run();
  assert.equal(view(new Store(file))[2][1], 'planted');
  (second as any).db.prepare("UPDATE card_fates SET reply = NULL WHERE cid = 'q-2'").run();

  // A reply that comes after the restart still shows, and is kept for the next one.
  second.addEvent(b, 'user_message', { author: 'Cara', text: 'late', answer: { questionId: 'q-2', answers: [] } });
  assert.equal(view(second)[2][1], 'late');
  assert.equal(view(new Store(file))[2][1], 'late');

  // A saved fate of another card, or one that outruns the events, is not used.
  const third = new Store(file);
  const db = (third as any).db;
  db.prepare("UPDATE card_fates SET cid = 'someone-else' WHERE cid = 'q-1'").run();
  db.prepare("UPDATE card_fates SET up_to = 999999 WHERE cid = 'ap-1'").run();
  assert.deepEqual(view(new Store(file)), [['q-1', 'the reply', null], ['ap-1', null, true], ['q-2', 'late', null]], 'read again from the chats');

  // events.id has no AUTOINCREMENT: a deleted minion's newest id can come back as a new card. The saved fates go with the delete.
  const d = minion('d');
  const gone = first.addEvent(d, 'question', { id: 'q-gone', questions: [] });
  first.addEvent(d, 'user_message', { author: 'Cara', text: 'answered', answer: { questionId: 'q-gone', answers: [] } });
  assert.equal(view(first).at(-1)![1], 'answered');
  first.deleteTicket(d);
  const reused = first.addEvent(minion('e'), 'question', { id: 'q-gone', questions: [] });
  assert.equal(reused.id, gone.id);
  assert.equal(view(new Store(file)).at(-1)![1], null, 'a new card on a deleted one\'s id has no reply');

  // Whoever deletes events, an older release after a rollback included, drops the saved fates with a trigger.
  assert.ok(first.recentCards(p, 10).length && (first as any).db.prepare('SELECT count(*) AS n FROM card_fates').get().n > 0);
  (new Store(file) as any).db.prepare("DELETE FROM events WHERE kind = 'approval_result'").run();
  assert.equal((first as any).db.prepare('SELECT count(*) AS n FROM card_fates').get().n, 0);
});

test('a card posted before #812 that someone answered by typing stays handled, so deploying it reopens nothing', () => {
  const store = new Store(join(root, 'legacy-812.sqlite'));
  const p = store.createProject('One', null).id;
  const a = store.createTicket({ project_id: p, title: 'a', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const e = store.addEvent(a, 'question', { id: 'q-old', questions: [] });
  store.addEvent(a, 'user_message', { author: 'Cara', text: 'yes' });
  // The cut-off is the newest event at that land; events below it are old cards.
  assert.equal(e.id <= TYPED_HANDLES_UP_TO, true);
  assert.deepEqual(store.openCards(p), []);
});

test('a running turn gone quiet (#906) is in its requester\'s Needs you only, whoever it is assigned to, until it talks again', () => {
  const store = new Store(join(root, 'quiet.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const p = store.createProject('One', null).id;
  const asked = store.createTicket({ project_id: p, title: 'asked by Josh', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  store.props.set('minion', asked, p, { requestedBy: 'Josh', assigned: 'Cara' }, 'Cara');
  const made = store.createTicket({ project_id: p, title: 'made by Cara', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const talking = store.createTicket({ project_id: p, title: 'talking', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  for (const id of [asked, made, talking]) store.updateTicket(id, { status: 'running' });
  store.setSetting(`turn:${asked}`, { resumes: 0, quiet: 1000 });
  store.setSetting(`turn:${made}`, { resumes: 0, quiet: 2000 });
  store.setSetting(`turn:${talking}`, { resumes: 0 });

  const quiet = (person: string) => inboxItems(store, approvals, p, person).filter((i) => i.kind === 'quiet').map((i) => [i.ticketId, i.at, i.key]);
  assert.deepEqual(quiet('josh'), [[asked, 1000, `quiet:${asked}:1000`]], 'the requester, though it is assigned to Cara');
  assert.deepEqual(quiet('Cara'), [[made, 2000, `quiet:${made}:2000`]], 'no requestedBy: whoever created it');
  assert.equal(inboxCount(store, approvals, p, 'Josh', {}), 1);
  store.updateTicket(made, { status: 'idle', state: 'parked' });
  assert.deepEqual(quiet('Cara'), [], 'a turn that ended is not quiet');
});

test('a split scheme: each person\'s own Taskmaster\'s cards are in their Needs you only; the Overlord\'s and a card\'s `to` reach others (#919, #920)', () => {
  const store = new Store(join(root, 'split.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const Josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('Shared', null, Cara.id).id;
  store.addMember(p, Josh.id);
  const caraTm = store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' }).id;
  const joshTm = store.splitScheme(p, Josh.id).id;
  const ovl = store.getOverlord(p)!.id;
  store.addEvent(caraTm, 'question', { id: 'q-cara', questions: [] });
  store.addEvent(joshTm, 'question', { id: 'q-josh', questions: [] });
  store.addEvent(joshTm, 'question', { id: 'q-josh-to-cara', to: 'Cara', questions: [] });
  store.addEvent(ovl, 'question', { id: 'q-ovl', questions: [] });
  approvals.request(joshTm, 'Bash', { command: 'ls' });

  const cards = (person: string) => inboxItems(store, approvals, p, person).map((i) => (i.card as { id: string }).id).filter((id) => id.startsWith('q-')).sort();
  assert.deepEqual(cards('Cara'), ['q-cara', 'q-josh-to-cara', 'q-ovl']);
  assert.deepEqual(cards('Josh'), ['q-josh', 'q-ovl']);
  assert.ok(!inboxItems(store, approvals, p, 'Cara').some((i) => i.kind === 'approval'), 'Josh\'s Taskmaster\'s approval holds up his turn, not Cara\'s');
});
