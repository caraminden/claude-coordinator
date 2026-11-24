import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RECAP_AWAY_MS, Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'recap-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('the scheme recap: your last action in the scheme, and turns finished since, per minion', async () => {
  const store = new Store(join(root, 'db.sqlite'));
  const minion = (projectId: number, title: string) => store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const p1 = store.createProject('One', null).id;
  const p2 = store.createProject('Two', null).id;
  const a = minion(p1, 'a'),
    b = minion(p1, 'b'),
    elsewhere = minion(p2, 'elsewhere');
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
  turn(a);
  turn(a);
  turn(b);
  turn(elsewhere);
  store.addEvent(b, 'claude', { type: 'assistant', message: { content: [] } });

  // Not away yet (#538): the turns aren't counted, as the page shows no recap until RECAP_AWAY_MS.
  assert.deepEqual(store.recap('Cara', p1), { since: clicked.created_at, turns: {} });
  const back = RECAP_AWAY_MS + 60_000;
  store.db.prepare('UPDATE events SET created_at = created_at - ?').run(back);
  store.db.prepare('UPDATE last_actions SET at = at - ?').run(back);
  const since = clicked.created_at - back;
  // The turn that ended before your action bounds the count's scan (turns_ended); it isn't counted itself.
  const first = store.db.prepare("SELECT id, created_at FROM events WHERE ticket_id = ? AND kind = 'claude' ORDER BY id LIMIT 1").get(a) as { id: number; created_at: number };
  store.db.prepare('INSERT INTO turns (ticket_id, event_id, ended_at, cost_usd, session_cost_usd) VALUES (?, ?, ?, 0, 0)').run(a, first.id, first.created_at);
  assert.deepEqual(store.recap('Cara', p1), { since, turns: { [a]: 2, [b]: 1 } });
  assert.deepEqual(store.recap('Josh', p1), { since: null, turns: {} });
  // A database from before last_actions: the first recap reads the time from the events, and keeps it.
  store.db.exec('DELETE FROM last_actions');
  assert.deepEqual(store.recap('Cara', p1), { since, turns: { [a]: 2, [b]: 1 } });
  assert.equal((store.db.prepare("SELECT at FROM last_actions WHERE name = 'Cara' AND project_id = ?").get(p1) as any).at, since);
  // Acting again brings you back: no recap, and the new time.
  const now = store.addEvent(b, 'user_message', { author: 'Cara', text: 'back' });
  assert.deepEqual(store.recap('Cara', p1), { since: now.created_at, turns: {} });
});
