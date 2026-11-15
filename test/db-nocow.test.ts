import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { hostOps, moveToNoCow, type NoCowOps } from '../src/db-nocow.ts';
import { Store } from '../src/db.ts';

// #761: the live database moves into a no-COW file at a start, once. Whatever goes wrong partway, the old file
// stays where it was and the server starts on it.
const root = mkdtempSync(join(tmpdir(), 'db-nocow-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A data dir with a database the way a stopped server leaves it. */
function stopped(rows = 50): string {
  const dir = join(root, String(++n));
  freshDir(dir);
  const db = join(dir, 'coordinator.db');
  const store = new Store(db);
  for (let i = 0; i < rows; i++) store.setSetting(`k${i}`, 'x'.repeat(5000) + i);
  store.db.close();
  return db;
}
function freshDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
}

/** No-COW as a set of inodes, so it follows a file through a rename as the real attribute does. */
function fakeOps(over: Partial<NoCowOps> = {}): NoCowOps & { set: Set<number> } {
  const set = new Set<number>();
  return {
    set,
    noCow: (f) => set.has(statSync(f).ino),
    setNoCow: (f) => void set.add(statSync(f).ino),
    openBy: () => [],
    freeBytes: () => 1e12,
    ...over,
  };
}
const settings = (db: string) => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return (d.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n;
  } finally {
    d.close();
  }
};
const files = (db: string) => readdirSync(join(db, '..')).sort();

test('moves the database into a no-COW file, keeps the old one as a backup, and opens as before', () => {
  const db = stopped();
  const rows = settings(db);
  const oldIno = statSync(db).ino;
  const ops = fakeOps();
  const r = moveToNoCow(db, ops, new Date('2026-11-15T18:01:02Z'));
  assert.equal(r.moved, true, r.note);
  assert.equal(ops.noCow(db), true);
  assert.notEqual(statSync(db).ino, oldIno);
  const backup = `${db}.backup-cow-20261115-180102`;
  assert.equal(statSync(backup).ino, oldIno, 'the backup is the old file itself');
  assert.equal(settings(backup), rows);
  assert.ok(!existsSync(`${db}.nocow-tmp`) && !existsSync(`${db}.nocow-failed`));
  // The WAL waits empty and no-COW, for SQLite to take up.
  assert.equal(statSync(`${db}-wal`).size, 0);
  assert.equal(ops.noCow(`${db}-wal`), true);
  const store = new Store(db);
  assert.equal(store.getSetting('k7'), 'x'.repeat(5000) + 7);
  store.setSetting('after', 1);
  store.db.close();
  assert.equal(settings(db), rows + 1);
  assert.equal(moveToNoCow(db, ops).note, 'already no-COW');
});

test('keeps what was only in the WAL when the server stopped without closing', () => {
  const live = stopped(0);
  const store = new Store(live);
  store.autoCheckpoint(false);
  for (let i = 0; i < 40; i++) store.setSetting(`wal${i}`, 'y'.repeat(5000));
  assert.ok(statSync(`${live}-wal`).size > 0);
  const rows = (store.db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n;
  // The files as a kill leaves them: pages in the WAL, never checkpointed.
  const dir = join(root, String(++n));
  freshDir(dir);
  const db = join(dir, 'coordinator.db');
  copyFileSync(live, db);
  copyFileSync(`${live}-wal`, `${db}-wal`);
  store.db.close();
  const r = moveToNoCow(db, fakeOps());
  assert.equal(r.moved, true, r.note);
  assert.equal(settings(db), rows);
  assert.ok(rows >= 40);
});

for (const [name, ops, marked] of [
  ['chattr +C does not take', () => fakeOps({ setNoCow: () => {} }), true],
  ['chattr fails', () => fakeOps({ setNoCow: () => { throw new Error('chattr: Operation not supported'); } }), true],
  // VACUUM INTO refuses a file that isn't empty, so the copy itself fails.
  ['the copy fails partway', () => { const o = fakeOps(); const set = o.setNoCow; o.setNoCow = (f) => (set(f), appendFileSync(f, 'junk')); return o; }, true],
] as const) {
  test(`leaves the old file in place when ${name}, and stops trying`, () => {
    const db = stopped();
    const ino = statSync(db).ino;
    const rows = settings(db);
    const o = ops();
    const r = moveToNoCow(db, o);
    assert.equal(r.moved, false);
    assert.match(r.note, /^left as it was/);
    assert.equal(statSync(db).ino, ino);
    assert.equal(settings(db), rows);
    assert.deepEqual(files(db).filter((f) => f.includes('nocow-tmp') || f.includes('backup')), []);
    assert.equal(existsSync(`${db}.nocow-failed`), marked);
    assert.match(moveToNoCow(db, fakeOps()).note, /an earlier try failed/);
  });
}

test('waits, with no marker, for disk space and for other processes to let go', () => {
  const db = stopped();
  assert.match(moveToNoCow(db, fakeOps({ freeBytes: () => 1000 })).note, /MB free/);
  assert.match(moveToNoCow(db, fakeOps({ openBy: (f) => (f === db ? [4242] : []) })).note, /open in process 4242/);
  assert.ok(!existsSync(`${db}.nocow-failed`) && !existsSync(`${db}.nocow-tmp`));
  assert.equal(moveToNoCow(db, fakeOps()).moved, true);
});

test('clears what a start killed partway left: the temp copy and a backup link to the file in use', () => {
  const db = stopped();
  writeFileSync(`${db}.nocow-tmp`, 'half a copy');
  writeFileSync(`${db}.nocow-tmp-journal`, 'its journal');
  linkSync(db, `${db}.backup-cow-20261114-000000`);
  const r = moveToNoCow(db, fakeOps(), new Date('2026-11-15T18:01:02Z'));
  assert.equal(r.moved, true, r.note);
  assert.deepEqual(files(db).filter((f) => f.includes('nocow-tmp') || f.includes('backup')), ['coordinator.db.backup-cow-20261115-180102']);
});

test('does nothing with no database, or on a filesystem without attributes', () => {
  assert.equal(moveToNoCow(join(root, 'none.db'), fakeOps()).note, 'no database yet');
  const db = stopped();
  assert.match(moveToNoCow(db, fakeOps({ noCow: () => null })).note, /no file attributes/);
});

// The real chattr and lsattr, where the test's temp dir is on btrfs (perigee's /home).
const BTRFS = 0x9123683e;
test('on btrfs, the moved file really has the C attribute', { skip: statfsSync(root).type !== BTRFS && 'not btrfs' }, () => {
  const db = stopped();
  assert.equal(hostOps.noCow(db), false);
  assert.deepEqual(hostOps.openBy(db), []);
  const r = moveToNoCow(db);
  assert.equal(r.moved, true, r.note);
  assert.equal(hostOps.noCow(db), true);
  assert.equal(hostOps.noCow(`${db}-wal`), true);
});
