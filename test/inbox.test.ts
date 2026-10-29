import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { inboxItems } from '../src/inbox.ts';

const root = mkdtempSync(join(tmpdir(), 'inbox-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a scheme\'s inbox: open cards and ready/try minions, approvals first, then newest first', () => {
  const store = new Store(join(root, 'db.sqlite'));
  const approvals = new Approvals(() => {});
  const minion = (projectId: number, title: string) =>
    store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const p1 = store.createProject('One', null).id;
  const p2 = store.createProject('Two', null).id;
  const a = minion(p1, 'a'), b = minion(p1, 'b'), gone = minion(p1, 'gone'), elsewhere = minion(p2, 'elsewhere');
  const ready = minion(p1, 'ready'), parked = minion(p1, 'parked');
  store.updateTicket(ready, { state: 'ready' });
  store.updateTicket(parked, { state: 'parked' });
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

  const items = inboxItems(store, approvals, p1);
  assert.deepEqual([items[0].kind, items[0].ticketId, (items[0].card as any).id], ['approval', a, approvalId]);
  assert.deepEqual(items.slice(1).map((i) => [i.kind, i.ticketId, (i.card as any)?.id ?? null]).sort(),
    [['plan', b, 'p-open'], ['question', a, 'q-open'], ['state', ready, null]]);
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
