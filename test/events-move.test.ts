// The chat log's move out of the main file into events.db at start (#1169), the old copy's drop after it (ship 3), and
// tools/events-unsplit.ts, which puts it back.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { CHAT, MOVED_KEY, dropEventsOld, eventsPath, moveEventsOffThread } from '../src/events-db.ts';
import { unsplitEvents } from '../tools/events-unsplit.ts';

const root = mkdtempSync(join(tmpdir(), 'events-move-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

const look = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const q = (sql: string) => db.prepare(sql).all() as { name: string; sql: string; id: number; ticket_id: number; kind: string; data: string }[];
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
  assert.equal((ev.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, first.rows);
  ev.close();

  // Card fates still go when an event goes: a TEMP trigger watches events.db.
  s.db.prepare('INSERT INTO card_fates (card_id, ticket_id, up_to) VALUES (1, ?, 1)').run(keep.id);
  s.db.prepare('DELETE FROM events WHERE id = ?').run(s.addEvent(keep.id, 'note', { text: 'brief' }).id);
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM card_fates').get() as { n: number }).n, 0);

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

test("the server's move runs on a worker thread, drops the old copy, and a second start has nothing to do", async () => {
  const dir = mkdtempSync(join(root, 'b-'));
  const path = join(dir, 'coordinator.db');
  let s = new Store(path);
  const t = s.createTicket({ project_id: s.createProject('p', null).id, title: 't', permission_mode: 'default', created_by: 'Cara' });
  s.addEvent(t.id, 'note', { text: 'hello' });
  const before = chat(s, t.id);
  s.db.close();
  const { rows } = unsplitEvents(path);
  assert.match((await moveEventsOffThread(path))!, new RegExp(`${rows} events in \\d+ ms\\. Dropped the main file's old copy of the chat log \\(events_old, ${rows} events\\)`));
  assert.equal(await moveEventsOffThread(path), null);
  assert.deepEqual([look(path).tables, look(path).moved], [[], true]);
  s = new Store(path);
  assert.deepEqual(chat(s, t.id), before);
  s.db.close();
});

test('events_old goes in batches only when events.db holds every one of its ids, and the vacuum shrinks the main file', () => {
  const dir = mkdtempSync(join(root, 'drop-'));
  const path = join(dir, 'coordinator.db');
  let s = new Store(path);
  const t = s.createTicket({ project_id: s.createProject('p', null).id, title: 't', permission_mode: 'default', created_by: 'Cara' });
  for (let i = 0; i < 300; i++) s.addEvent(t.id, 'note', { text: 'x'.repeat(4000) });
  s.db.close();
  unsplitEvents(path);
  s = new Store(path); // moves, keeping events_old
  const before = chat(s, t.id);
  const gone = s.addEvent(t.id, 'note', { text: 'new since the move' }).id;
  s.db.close();

  const open = () => {
    const db = new DatabaseSync(path);
    db.prepare(`ATTACH DATABASE ? AS ${CHAT}`).run(eventsPath(path));
    return db;
  };
  // An id events_old has that events.db lacks: it changes nothing and says how many.
  let db = open();
  const first = (db.prepare('SELECT min(id) AS id FROM main.events_old').get() as { id: number }).id;
  db.prepare(`DELETE FROM ${CHAT}.events WHERE id = ?`).run(first);
  assert.deepEqual(dropEventsOld(db, { batch: 7 }), { missing: 1 });
  assert.equal((db.prepare('SELECT count(*) AS n FROM main.events_old').get() as { n: number }).n, 300);
  db.prepare(`INSERT INTO ${CHAT}.events SELECT * FROM main.events_old WHERE id = ?`).run(first);
  const size = () => (db.prepare('PRAGMA main.page_count').get() as { page_count: number }).page_count;
  const pages = size();

  // Whole: it goes in batches of 7, each its own run (300 rows: 42 full, a short one, then one that finds none), and the file gives back the space.
  let runs = 0;
  const spy = new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key);
      return (sql: string) => {
        const st = target.prepare(sql);
        return /^DELETE FROM main\.events_old/.test(sql) ? { run: () => (runs++, st.run()) } : st;
      };
    },
  });
  const done = dropEventsOld(spy, { batch: 7 }) as { rows: number; beforeMb: number; afterMb: number };
  assert.deepEqual([done.rows, runs], [300, 44]);
  assert.ok(size() < pages - 290, `${size()} pages after, ${pages} before`); // 300 rows of 4 kB, a page each
  assert.equal(dropEventsOld(db, { minFreeMb: 0 }), null);
  db.close();
  assert.deepEqual(look(path).tables, []);
  s = new Store(path);
  assert.deepEqual(chat(s, t.id).slice(0, before.length), before);
  assert.equal(s.listEvents(t.id).at(-1)!.id, gone);
  s.db.close();
});

test('a copy left by a move that stopped halfway is made again, and a main file with events again after the move stops the start', () => {
  const dir = mkdtempSync(join(root, 'd-'));
  const path = join(dir, 'coordinator.db');
  let s = new Store(path);
  const t = s.createTicket({ project_id: s.createProject('p', null).id, title: 't', permission_mode: 'default', created_by: 'Cara' });
  s.addEvent(t.id, 'note', { text: 'kept' });
  s.db.close();
  unsplitEvents(path);
  // A move that stopped after its first commit, then an event deleted in the main file, which stayed in charge.
  const ev = new DatabaseSync(join(dir, 'events.db'));
  ev.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO events VALUES (999, ${t.id}, 'note', '{"text":"deleted since"}', 1)`);
  ev.close();
  s = new Store(path);
  assert.deepEqual(chat(s, t.id), [`${t.id}:note:${JSON.stringify(JSON.stringify({ text: 'kept' }))}`]);
  s.db.close();

  // A release older than events.db started after the move: it made an empty events table in the main file and wrote to it.
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO events VALUES (1, ${t.id}, 'note', '{"text":"older release"}', 2)`);
  raw.close();
  assert.throws(() => new Store(path), /main file has an events table again/);
  const ev2 = new DatabaseSync(join(dir, 'events.db'), { readOnly: true });
  assert.deepEqual(
    ev2
      .prepare('SELECT data FROM events')
      .all()
      .map((r) => r.data),
    [JSON.stringify({ text: 'kept' })],
  );
  ev2.close();
});

test('a start stopped after the drop but before the VACUUM leaves the space free, and the next one vacuums it', () => {
  const dir = mkdtempSync(join(root, 'vac-'));
  const path = join(dir, 'coordinator.db');
  let s = new Store(path);
  const t = s.createTicket({ project_id: s.createProject('p', null).id, title: 't', permission_mode: 'default', created_by: 'Cara' });
  for (let i = 0; i < 300; i++) s.addEvent(t.id, 'note', { text: 'x'.repeat(4000) });
  s.db.close();
  unsplitEvents(path);
  new Store(path).db.close(); // moves, keeping events_old
  const db = new DatabaseSync(path);
  db.prepare(`ATTACH DATABASE ? AS ${CHAT}`).run(eventsPath(path));
  db.exec('DROP TABLE main.events_old');
  const free = () => (db.prepare('PRAGMA main.freelist_count').get() as { freelist_count: number }).freelist_count;
  assert.ok(free() > 290);
  assert.equal(dropEventsOld(db), null, 'under 100 MB free: not worth a VACUUM at start');
  const done = dropEventsOld(db, { minFreeMb: 0 }) as { rows: number };
  assert.deepEqual([done.rows, free() === 0], [0, true]);
  assert.equal(dropEventsOld(db, { minFreeMb: 0 }), null);
  db.close();
});

test('the rollback tool refuses a database whose events are already in the main file', () => {
  const dir = mkdtempSync(join(root, 'c-'));
  const path = join(dir, 'coordinator.db');
  new Store(path).db.close();
  unsplitEvents(path);
  new DatabaseSync(join(dir, 'events.db')).exec('CREATE TABLE events (id INTEGER PRIMARY KEY)');
  assert.throws(() => unsplitEvents(path), /already has its events in the main file/);
});

test('two databases in one folder keep their own chat logs; coordinator.db alone takes the plain events.db name', () => {
  const dir = mkdtempSync(join(root, 'two-'));
  const a = new Store(join(dir, 'a.sqlite'));
  const b = new Store(join(dir, 'coordinator.db'));
  const pa = a.createProject('a', null);
  const ta = a.createTicket({ project_id: pa.id, title: 'a', permission_mode: 'default', created_by: 'Cara' });
  a.addEvent(ta.id, 'note', { text: 'only in a' });
  const pb = b.createProject('b', null);
  const tb = b.createTicket({ project_id: pb.id, title: 'b', permission_mode: 'default', created_by: 'Cara' });
  assert.equal(ta.id, tb.id);
  assert.deepEqual(b.listEvents(tb.id), []);
  assert.equal(b.eventsPath, join(dir, 'events.db'));
  assert.equal(a.eventsPath, join(dir, 'a.sqlite.events'));
  a.db.close();
  b.db.close();
});
