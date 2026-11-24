// The usage ledger (#1306): counts by day, kind and name; distinct people; counting never fails a request or a turn.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SCHEMA_VERSION, Store } from '../src/db.ts';
import { router, routeGroup } from '../src/http.ts';
import { pacificDay } from '../src/pacific.ts';
import { unusedList, UsageLedger } from '../src/usage-ledger.ts';

const root = mkdtempSync(join(tmpdir(), 'usage-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const newStore = () => new Store(join(root, `db-${++n}.sqlite`));
const DAY = Date.parse('2026-11-20T20:00:00Z');

test('uses add up by day, kind and name, and people counts each person once, across flushes', () => {
  const s = newStore();
  const l = new UsageLedger((s as any).db, () => DAY);
  l.used('tool', 'list_tickets', 1);
  l.used('tool', 'list_tickets', 1);
  l.used('tool', 'list_tickets', 2);
  assert.ok(l.flush());
  l.used('tool', 'list_tickets', 2);
  l.used('tool', 'list_tickets', 3);
  assert.ok(l.flush());
  const row = (s as any).db.prepare('SELECT day, kind, name, people, n FROM usage_counts').all();
  assert.deepEqual(
    row.map((r: any) => ({ ...r })),
    [{ day: '2026-11-20', kind: 'tool', name: 'list_tickets', people: 3, n: 5 }],
  );
  assert.ok(SCHEMA_VERSION >= 99);
});

test('names keep only plain characters and a bad kind is ignored', () => {
  const s = newStore();
  const l = new UsageLedger((s as any).db, () => DAY);
  l.used('page', 'p/n/<script>"x"', 1);
  l.used('nope' as any, 'x');
  l.used('page', '');
  l.flush();
  assert.deepEqual(
    (s as any).db
      .prepare('SELECT name FROM usage_counts')
      .all()
      .map((r: any) => r.name),
    ['p/n/scriptx'],
  );
});

test('a failing write throws nothing and keeps the counts for the next flush', () => {
  const s = newStore();
  const db = (s as any).db;
  const l = new UsageLedger(db, () => DAY);
  l.used('skill', 'citadel:retro');
  db.exec('ALTER TABLE usage_counts RENAME TO usage_counts_gone');
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(l.flush(), false);
  } finally {
    console.error = log;
  }
  db.exec('ALTER TABLE usage_counts_gone RENAME TO usage_counts');
  assert.equal(l.flush(), true);
  assert.equal(db.prepare('SELECT n FROM usage_counts').get().n, 1);
});

test('a route still answers when the ledger throws', async () => {
  const handle = router([{ method: 'GET', path: '/api/things/:thing/parts', who: ['person'], handler: () => 'answered' as any }]);
  const store = {
    usage: {
      used: () => {
        throw new Error('disk full');
      },
    },
  };
  const out = await handle({ store } as any, { method: 'GET', headers: {} } as any, {} as any, new URL('http://x/api/things/3/parts'), { name: 'Cara', uid: 1, exp: 0 } as any);
  assert.equal(out, 'answered');
  assert.deepEqual(handle.groups(), ['/api/things/parts']);
});

test('a route group drops its parameters', () => {
  assert.equal(routeGroup('/api/projects/:project/tickets'), '/api/projects/tickets');
  assert.equal(routeGroup('/api/files/*rest'), '/api/files');
});

test('the list puts nothing-in-30-days first: never used, then oldest, then the rest', () => {
  const today = '2026-11-20';
  const rows = [
    { kind: 'tool' as const, name: 'busy', first: '2026-11-01', last: '2026-11-20', n: 9, days: 5 },
    { kind: 'tool' as const, name: 'old', first: '2026-09-01', last: '2026-10-01', n: 2, days: 2 },
  ];
  const list = unusedList(
    rows,
    [
      { kind: 'schedule', name: 'never-ran' },
      { kind: 'tool', name: 'busy' },
    ],
    '2026-11-01',
    today,
  );
  assert.deepEqual(
    list.map((i) => [i.name, i.idle]),
    [
      ['never-ran', true],
      ['old', true],
      ['busy', false],
    ],
  );
  assert.equal(list[0].never, true);
  assert.equal(pacificDay(DAY), '2026-11-20');
});

test('a flood of distinct names is capped between flushes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE usage_counts (day TEXT, kind TEXT, name TEXT, people INTEGER, n INTEGER, PRIMARY KEY (day, kind, name))');
  const l = new UsageLedger(db);
  for (let i = 0; i < 5000; i++) l.used('page', `x${i}`);
  l.flush();
  assert.ok((db.prepare('SELECT COUNT(*) AS c FROM usage_counts').get() as { c: number }).c <= 2000);
});
