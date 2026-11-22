// A test run never holds the live shared folder (#1623): the retro log's real land.md got `shipped through main's red ·
// ticket/1-x · test/a.test.ts · …/runs/123` lines from a test whose script inherited the minion's COORDINATOR_SHARED_DIR.
// The leak guard's global setup points it at a scratch folder, so any script a test starts writes its retro lines there.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

test('a test process never sees the live shared folder: COORDINATOR_SHARED_DIR is unset or a scratch folder under the temp dir', () => {
  const dir = process.env.COORDINATOR_SHARED_DIR;
  if (!dir) return;
  assert.ok(dir.startsWith(`${tmpdir()}/`), `COORDINATOR_SHARED_DIR is ${dir}, outside ${tmpdir()}: a script a test starts would write its retro-log lines into the live log`);
  assert.ok(existsSync(dir), 'and the scratch folder exists');
});
