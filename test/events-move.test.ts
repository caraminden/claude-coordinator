// The chat log's move out of the main file into events.db at start (#1169), and tools/events-unsplit.ts, which puts it back.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MOVED_KEY, moveEventsOffThread } from '../src/events-db.ts';
import { unsplitEvents } from '../tools/events-unsplit.ts';

const root = mkdtempSync(join(tmpdir(), 'events-move-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

const look = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const q = (sql: string) => db.prepare(sql).all() as any[];
  const out = {
    tables: q("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'events%' ORDER BY name").map((r) => r.name),
    trigger: q("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'card_fates_events_deleted'").length === 1,
    linked: q("SELECT sql FROM sqlite_master WHERE name = 'events'").some((r) => r.sql.includes('REFERENCES tickets')),
    moved: q(`SELECT 1 FROM settings WHERE key = '${MOVED_KEY}'`).length === 1,
    old: q("SELECT 1 FROM sqlite_master WHERE name = 'events_old'").length ? q('SELECT id, ticket_id, kind, data FROM events_old ORDER BY id') : null,
  };
  db.close();
  return out;
};
const chat = (s: Store, ...ids: number[]) => ids.flatMap((id) => s.listEvents(id).map((e) => `${e.ticket_id}:${e.kind}:${JSON.stringify(e.data)}`));

test('an old-layout database moves its chat log to events.db at start, keeps events_old, and the rollback tool puts it back', () => {
  const dir = mkdtempSync(join(root, 'a-'));
  const path = join(dir, 'coordinator.db');
  let s = new Store(path);
  const p = s.createProject('p', null);
  const keep = s.createTicket({ project_id: p.id, title: 'keep', permission_mode: 'default', created_by: 'Cara' });
  const gone = s.createTicket({ project_id: p.id, title: 'gone', permission_mode: 'default', created_by: 'Cara' });
  s.addEvent(keep.id, 'note', { text: 'one' });
  const edited = s.addEvent(keep.id, 'note', { text: 'two' });
  s.addEvent(gone.id, 'note', { text: 'three' });
  const before = chat(s, keep.id, gone.id);
  s.db.close();

  // Back to the layout every database had before #1169: events in the main file, linked to tickets, with the main trigger.
  const first = unsplitEvents(path);
  assert.equal(first.rows, before.length);
  assert.ok(!existsSync(join(dir, 'events.db')) && existsSync(first.setAside));
  assert.deepEqual(look(path), { tables: ['events'], trigger: true, linked: true, moved: false, old: null });

  // The next start moves it.
  s = new Store(path);
  assert.deepEqual(chat(s, keep.id, gone.id), before);
  const moved = look(path);
  assert.deepEqual([moved.tables, moved.trigger, moved.moved, moved.old!.length], [['events_old'], false, true, first.rows]);
  const ev = new DatabaseSync(join(dir, 'events.db'), { readOnly: true });
  assert.equal((ev.prepare('SELECT count(*) AS n FROM events').get() as any).n, first.rows);
  ev.close();

  // Card fates still go when an event goes: a TEMP trigger watches events.db.
  s.db.prepare('INSERT INTO card_fates (card_id, ticket_id, up_to) VALUES (1, ?, 1)').run(keep.id);
  s.db.prepare('DELETE FROM events WHERE id = ?').run(s.addEvent(keep.id, 'note', { text: 'brief' }).id);
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM card_fates').get() as any).n, 0);

  // A minion with rows in events_old (linked to tickets) can still be deleted; new and edited rows land in events.db.
  s.deleteTicket(gone.id);
  s.addEvent(keep.id, 'note', { text: 'four' });
  s.setEventData(edited.id, { text: 'two, edited' });
  const now = chat(s, keep.id);
  s.db.close();

  // The rollback tool brings events_old up to date: the new row, the edit and the deleted minion's rows.
  const second = unsplitEvents(path);
  assert.deepEqual(look(path), { tables: ['events'], trigger: true, linked: true, moved: false, old: null });
  s = new Store(path); // and moves it again
  assert.deepEqual(chat(s, keep.id), now);
  assert.equal(second.rows, now.length);
  s.db.close();

  // With the database marked moved, a missing events.db stops the start instead of opening an empty chat log.
  for (const f of readdirSync(dir)) if (f.startsWith('events.db') && !f.includes('unsplit')) rmSync(join(dir, f));
  assert.throws(() => new Store(path), /events\.db/);
});

test("the server's move runs on a worker thread, and a second start has nothing to move", async () => {
  const dir = mkdtempSync(join(root, 'b-'));
  const path = join(dir, 'coordinator.db');
  const s = new Store(path);
  const t = s.createTicket({ project_id: s.createProject('p', null).id, title: 't', permission_mode: 'default', created_by: 'Cara' });
  s.addEvent(t.id, 'note', { text: 'hello' });
  s.db.close();
  const { rows } = unsplitEvents(path);
  assert.match((await moveEventsOffThread(path))!, new RegExp(`${rows} events in \\d+ ms`));
  assert.equal(await moveEventsOffThread(path), null);
  assert.equal(look(path).old!.length, rows);
});

test('the rollback tool refuses a database whose events are already in the main file', () => {
  const dir = mkdtempSync(join(root, 'c-'));
  const path = join(dir, 'coordinator.db');
  new Store(path).db.close();
  unsplitEvents(path);
  new DatabaseSync(join(dir, 'events.db')).exec('CREATE TABLE events (id INTEGER PRIMARY KEY)');
  assert.throws(() => unsplitEvents(path), /already has its events in the main file/);
});
