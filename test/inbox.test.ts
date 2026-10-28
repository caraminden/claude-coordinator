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

test('the inbox lists open cards from every scheme: approvals first, then newest first', () => {
  const store = new Store(join(root, 'db.sqlite'));
  const approvals = new Approvals(() => {});
  const minion = (projectId: number, title: string) =>
    store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const p1 = store.createProject('One', null).id;
  const p2 = store.createProject('Two', null).id;
  const a = minion(p1, 'a'), b = minion(p2, 'b'), gone = minion(p1, 'gone');

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

  const items = inboxItems(store, approvals);
  assert.deepEqual([items[0].kind, items[0].ticketId, (items[0].card as any).id], ['approval', a, approvalId]);
  assert.deepEqual(items.slice(1).map((i) => [i.kind, i.ticketId, (i.card as any).id]).sort(), [['plan', b, 'p-open'], ['question', a, 'q-open']]);
  assert.ok(items[1].at >= items[2].at);
  assert.equal((items[0].card as any).tool, 'Bash');
});
