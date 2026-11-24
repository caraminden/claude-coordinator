// copyDb (the boot check's copy of the live database) finishes while another connection keeps
// writing: a stepped backup restarts on every outside write and never ends (#497).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { copyDb } from '../src/db-copy.ts';

const root = mkdtempSync(join(tmpdir(), 'db-copy-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a copy finishes, consistent, while another connection writes every millisecond', { timeout: 30_000 }, async () => {
  const src = join(root, 'live.db');
  const live = new DatabaseSync(src);
  live.exec('PRAGMA journal_mode = WAL; CREATE TABLE events (id INTEGER PRIMARY KEY, data TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO events (data) SELECT randomblob(1000) FROM n');
  const write = live.prepare('INSERT INTO events (data) VALUES (randomblob(100))');
  const writer = setInterval(() => write.run(), 1);
  try {
    let timer: NodeJS.Timeout | undefined;
    const stuck = new Promise((_, no) => {
      timer = setTimeout(() => no(new Error('the copy did not finish within 10 s of steady writes')), 10_000);
    });
    await Promise.race([copyDb(src, join(root, 'copy.db')), stuck]).finally(() => clearTimeout(timer));
  } finally {
    clearInterval(writer);
    live.close();
  }
  const copy = new DatabaseSync(join(root, 'copy.db'), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.ok((copy.prepare('SELECT count(*) n FROM events').get()!.n as number) >= 20000);
  copy.close();
});
