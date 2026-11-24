import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { writeOffThread } from '../src/db-writer.ts';
import { Runner } from '../src/runner.ts';
import { testPins } from './helpers.ts';
testPins();

// A dismissed minion's queue and its never-deleted rows go (#1378), and what still waited is named in its chat.
const root = mkdtempSync(join(tmpdir(), 'closed-cleanup-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const KEYS = (id: number) => [`context:${id}`, `ctxwin:${id}`, `commands:${id}`, `plan:${id}`, `keepalive:${id}`, `asker:${id}`];
const notes = (store: Store, id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text as string);

test('dismissing a minion names its held mail in the chat and deletes its queue and per-minion rows', async () => {
  const store = new Store(join(root, 'a.db'));
  const project = store.createProject('Test', null);
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { status: 'idle' });
  for (const k of KEYS(t.id)) store.setSetting(k, 1);
  store.setSetting(`minion_budget:${t.id}`, { asked: 1, woke: 2 });
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/false',
  );
  runner.queue.hold(t.id, { author: 'Held mail from Taskmaster', text: 'build 3 merged', images: [] }, Date.now());
  await runner.close(t.id, 'Dismissed.');
  assert.equal(store.getSetting(`minion-queue:${t.id}`), null);
  for (const k of KEYS(t.id)) assert.equal(store.getSetting(k), null, k);
  // Its budget marks stay (2R1): each is once ever, so a reopen past them isn't asked again.
  assert.deepEqual(store.getSetting(`minion_budget:${t.id}`), { asked: 1, woke: 2 });
  assert.ok(
    notes(store, t.id).some((n) => n.startsWith('Dismissed before this message was read: Held mail from Taskmaster: build 3 merged')),
    notes(store, t.id).join('\n'),
  );
  store.db.close();
});

for (const slow of [false, true])
  test(`a boot finds a closed minion's old queue, migrates it and names it in the chat, and keeps its held mail for a reopen: never dropped silently${slow ? ' (a slow write worker, as on the server)' : ''}`, async () => {
    const store = new Store(join(root, `b${slow}.db`));
    const project = store.createProject('Test', null);
    const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { status: 'closed' });
    store.setSetting(`waiting:${t.id}`, [{ author: 'Cara', text: 'left behind', images: [] }]); // as before #1378
    store.setSetting(`mail:${t.id}`, [{ author: 'Held mail from Josh', text: 'for a reopen', images: [] }]);
    // The migration's writes are still queued when recover looks: it must see them anyway.
    const w = slow ? writeOffThread(store, { delayMs: 50 }) : null;
    const runner = new Runner(
      store,
      () => {},
      () => ({}),
      '/bin/false',
    );
    assert.equal(store.getSetting(`mail:${t.id}`), null, 'the old row moved');
    runner.recover();
    const kept = { held: [{ author: 'Held mail from Josh', text: 'for a reopen', images: [] }] };
    assert.deepEqual(store.getSetting(`minion-queue:${t.id}`), kept, 'mail to a dismissed minion waits for a reopen (#783)');
    runner.detachAll();
    assert.equal(w?.drain(10_000) ?? true, true);
    await w?.stop();
    assert.deepEqual(store.getSetting(`minion-queue:${t.id}`), kept, 'and that was written');
    assert.deepEqual(
      notes(store, t.id).filter((n) => n.startsWith('Dismissed before')),
      ['Dismissed before this message was read: Cara: left behind'],
    );
    store.db.close();
  });
