import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { testPins } from './helpers.ts';
testPins();

// A scheme's minions list (GET /api/projects/:id) views every minion, the ~1,000 dismissed ones too: reading what
// they all share once per row held the server 0.4-1.0 s a page load (#1029).
const root = mkdtempSync(join(tmpdir(), 'view-list-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('views() gives each row what view() does, reading the scheme, the waits, the people and properties once', () => {
  const store = new Store(join(root, 'list.db'));
  const project = store.createProject('Citadel', null);
  const [cara, josh] = [store.createUser({ name: 'Cara', login: 'cara' }), store.createUser({ name: 'Josh', login: 'josh' })];
  const tickets = Array.from({ length: 60 }, (_, i) => {
    const t = store.createTicket({ project_id: project.id, title: `M${i}`, permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { status: i % 3 ? 'closed' : 'idle', person_id: i % 4 === 0 ? null : i % 2 ? cara.id : josh.id } as any);
    if (i % 5 === 0) store.props.set('minion', t.id, project.id, { type: 'bug' }, 'Cara');
    return store.getTicket(t.id)!;
  });
  store.setSetting('net-resumes', [{ ticket: tickets[3].id, queued: [{ id: 7, author: 'Cara', text: 'x', images: [] }] }]);
  store.setSetting('limit-resumes', [{ ticket: tickets[6].id, at: 123, accounts: null }]);
  const runner = new Runner(store, () => {}, () => ({}), 'true');

  const one = tickets.map((t) => runner.view(t));
  assert.ok(one.some((v) => (v.properties as any).type === 'bug') && one.some((v) => v.payer?.name === 'Josh'));
  assert.equal(one[3].queued, 1);
  assert.equal(one[6].limit_resume_at, 123);

  const calls: Record<string, number> = { getProject: 0, getUser: 0, forTarget: 0, waits: 0 };
  const count = (obj: any, name: string, key = name, when: (...a: any[]) => boolean = () => true) => {
    const f = obj[name].bind(obj);
    obj[name] = (...a: any[]) => (when(...a) && calls[key]++, f(...a));
  };
  count(store, 'getProject');
  count(store, 'getUser');
  count(store.props, 'forTarget');
  count(store, 'getSetting', 'waits', (k: string) => k === 'net-resumes' || k === 'limit-resumes');
  assert.deepEqual(runner.views(tickets), one);
  // Once for the list, not once (or twice) per row: 60 rows.
  assert.ok(calls.getProject <= 1 && calls.getUser <= 4 && calls.forTarget === 0 && calls.waits <= 2, JSON.stringify(calls));
});
