import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { hostOps, moveToNoCow, RETRY_AFTER_MS, type NoCowOps } from '../src/db-nocow.ts';
import { once } from 'node:events';
import { Store } from '../src/db.ts';
import { tempRoot } from './helpers.ts';

// #761: the live database moves into a no-COW file at a start, once. Whatever goes wrong partway, the old file
// stays where it was and the server starts on it.
const tmp = tempRoot('db-nocow-');
const root = tmp.dir;
after(() => tmp.teardown());
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
  const r = moveToNoCow(db, ops, { now: new Date('2026-11-15T18:01:02Z') });
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
  [
    'chattr fails',
    () =>
      fakeOps({
        setNoCow: () => {
          throw new Error('chattr: Operation not supported');
        },
      }),
    true,
  ],
  // VACUUM INTO refuses a file that isn't empty, so the copy itself fails.
  [
    'the copy fails partway',
    () => {
      const o = fakeOps();
      const set = o.setNoCow;
      o.setNoCow = (f) => (set(f), appendFileSync(f, 'junk'));
      return o;
    },
    true,
  ],
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
    assert.deepEqual(
      files(db).filter((f) => f.includes('nocow-tmp') || f.includes('backup')),
      [],
    );
    assert.equal(existsSync(`${db}.nocow-failed`), marked);
    assert.match(moveToNoCow(db, fakeOps()).note, /an earlier try failed/);
    // A day on, it tries again.
    const later = new Date(Date.now() + RETRY_AFTER_MS + 1000);
    assert.equal(moveToNoCow(db, fakeOps(), { now: later }).moved, true);
    assert.ok(!existsSync(`${db}.nocow-failed`));
  });
}

test('waits, with no marker, for disk space and for other processes to let go', () => {
  const db = stopped();
  assert.match(moveToNoCow(db, fakeOps({ freeBytes: () => 1000 })).note, /MB free/);
  assert.match(moveToNoCow(db, fakeOps({ openBy: (f) => (f === db ? [4242] : []) })).note, /open in process 4242/);
  assert.ok(!existsSync(`${db}.nocow-failed`) && !existsSync(`${db}.nocow-tmp`));
  assert.equal(moveToNoCow(db, fakeOps()).moved, true);
});

test('kills a copy that runs past its budget, and leaves the old file in place', () => {
  const db = stopped(400);
  const ino = statSync(db).ino;
  const rows = settings(db);
  const r = moveToNoCow(db, fakeOps(), { budgetMs: 50 });
  assert.equal(r.moved, false);
  assert.match(r.note, /the copy took over 0.05 s/);
  assert.equal(statSync(db).ino, ino);
  assert.equal(settings(db), rows);
  assert.deepEqual(
    files(db).filter((f) => f.includes('nocow-tmp') || f.includes('backup')),
    [],
  );
  assert.ok(existsSync(`${db}.nocow-failed`));
});

test('waits, with no marker, while a reader holds a transaction open', () => {
  const db = stopped();
  const store = new Store(db);
  store.autoCheckpoint(false);
  store.setSetting('in-wal', 1);
  const reader = new DatabaseSync(db, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM settings').get();
  store.setSetting('after-reader', 1);
  store.db.close();
  const ino = statSync(db).ino;
  const r = moveToNoCow(db, fakeOps());
  reader.exec('COMMIT');
  reader.close();
  assert.equal(r.moved, false);
  assert.match(r.note, /a reader held the WAL checkpoint|WAL still holds pages/);
  assert.equal(statSync(db).ino, ino);
  assert.ok(!existsSync(`${db}.nocow-failed`));
  assert.equal(moveToNoCow(db, fakeOps()).moved, true);
  assert.equal(new Store(db).getSetting('after-reader'), 1);
});

test('finds another process that has the file open, and waits for it', async () => {
  const db = stopped();
  const child = tmp.spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]); d.prepare('SELECT 1').get(); console.log('open'); setInterval(() => {}, 1000);`, db], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await once(child.stdout!, 'data');
    assert.ok(hostOps.openBy(db).includes(child.pid!));
    assert.match(moveToNoCow(db, fakeOps({ openBy: hostOps.openBy })).note, new RegExp(`open in process ${child.pid}`));
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  assert.equal(moveToNoCow(db, fakeOps({ openBy: hostOps.openBy })).moved, true);
});

test('clears what a start killed partway left: the temp copy and a backup link to the file in use', () => {
  const db = stopped();
  writeFileSync(`${db}.nocow-tmp`, 'half a copy');
  writeFileSync(`${db}.nocow-tmp-journal`, 'its journal');
  linkSync(db, `${db}.backup-cow-20261114-000000`);
  const r = moveToNoCow(db, fakeOps(), { now: new Date('2026-11-15T18:01:02Z') });
  assert.equal(r.moved, true, r.note);
  assert.deepEqual(
    files(db).filter((f) => f.includes('nocow-tmp') || f.includes('backup')),
    ['coordinator.db.backup-cow-20261115-180102'],
  );
});

test('does nothing with no database, or on a filesystem without attributes', () => {
  assert.equal(moveToNoCow(join(root, 'none.db'), fakeOps()).note, 'no database yet');
  const db = stopped();
  assert.match(moveToNoCow(db, fakeOps({ noCow: () => null })).note, /no file attributes/);
});

// The real chattr and lsattr on the test's temp dir: on btrfs (perigee's /home) the file moves and has C; on a
// filesystem without the attribute (CI's runner) the real chattr fails and the old file stays, whole. CI allows
// no skipped tests, so this runs everywhere and checks whichever case the disk gives it.
const BTRFS = 0x9123683e;
test('with the real chattr: moved with C on btrfs, left whole where the attribute is missing', () => {
  const db = stopped();
  const ino = statSync(db).ino;
  const rows = settings(db);
  assert.notEqual(hostOps.noCow(db), true);
  assert.deepEqual(hostOps.openBy(db), []);
  const r = moveToNoCow(db);
  if (statfsSync(root).type === BTRFS) {
    assert.equal(r.moved, true, r.note);
    assert.equal(hostOps.noCow(db), true);
    assert.equal(hostOps.noCow(`${db}-wal`), true);
  } else {
    assert.equal(r.moved, false, r.note);
    assert.equal(statSync(db).ino, ino);
    assert.ok(!existsSync(`${db}.nocow-tmp`));
  }
  assert.equal(settings(db), rows);
});
