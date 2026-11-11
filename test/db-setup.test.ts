import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'db-setup-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Commits in a WAL file: frames that record the database's size, carrying the file's current salts. */
function walCommits(path: string): number {
  const b = readFileSync(path);
  const pageSize = b.readUInt32BE(8);
  let n = 0;
  for (let at = 32; at + 24 + pageSize <= b.length; at += 24 + pageSize) {
    if (b.readUInt32BE(at + 4) && b.readUInt32BE(at + 8) === b.readUInt32BE(16) && b.readUInt32BE(at + 12) === b.readUInt32BE(20)) n++;
  }
  return n;
}

// Each commit is an fsync, and a busy btrfs disk took a hundred of them past 15 s: a server whose
// port was taken spent that long setting up a new database before it could fail (#426).
test('a new database is set up in a few commits, not one per table and column', () => {
  const store = new Store(join(root, 'coordinator.db'));
  const commits = walCommits(join(root, 'coordinator.db-wal')) + walCommits(join(root, 'state.db-wal'));
  store.db.close();
  assert.ok(commits > 0, 'the WAL files hold the setup');
  assert.ok(commits <= 15, `${commits} commits`);
});

// In WAL mode NORMAL fsyncs at checkpoints, not on every commit: a busy disk made each commit cost
// 150-300 ms. A power cut can lose the last few seconds of writes; an app crash loses nothing (#470,
// Cara picked "Live and tests", 2026-11-10).
test('both database files commit without an fsync each (synchronous NORMAL)', () => {
  const store = new Store(join(root, 'sync.db'));
  const level = (schema: string) => (store.db.prepare(`PRAGMA ${schema}.synchronous`).get() as { synchronous: number }).synchronous;
  const levels = [level('main'), level('state')];
  store.db.close();
  assert.deepEqual(levels, [1, 1], 'NORMAL is 1, FULL 2');
});
