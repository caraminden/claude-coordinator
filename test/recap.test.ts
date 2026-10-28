import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'recap-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('the scheme recap: your last action in the scheme, and turns finished since, per minion', async () => {
  const store = new Store(join(root, 'db.sqlite'));
  const minion = (projectId: number, title: string) =>
    store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const p1 = store.createProject('One', null).id;
  const p2 = store.createProject('Two', null).id;
  const a = minion(p1, 'a'), b = minion(p1, 'b'), elsewhere = minion(p2, 'elsewhere');
  const turn = (id: number) => store.addEvent(id, 'claude', { type: 'result', is_error: false });
  const tick = () => new Promise((r) => setTimeout(r, 2));

  assert.deepEqual(store.recap('Cara', p1), { since: null, turns: {} });
  turn(a);
  await tick();
  store.addEvent(a, 'user_message', { author: 'Cara', text: 'go' });
  store.addEvent(b, 'user_message', { author: 'Taskmaster', text: 'not you' });
  await tick();
  const clicked = store.addEvent(b, 'approval_result', { id: 'x', state: 'allowed', by: 'Cara' });
  store.addEvent(elsewhere, 'user_message', { author: 'Cara', text: 'other scheme' });
  await tick();
  turn(a); turn(a); turn(b); turn(elsewhere);
  store.addEvent(b, 'claude', { type: 'assistant', message: { content: [] } });

  assert.deepEqual(store.recap('Cara', p1), { since: clicked.created_at, turns: { [a]: 2, [b]: 1 } });
  assert.deepEqual(store.recap('Josh', p1), { since: null, turns: {} });
});
