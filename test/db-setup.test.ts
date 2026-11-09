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
