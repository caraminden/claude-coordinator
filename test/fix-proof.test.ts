// #1398: the fix route's own checks (src/fix-proof.ts); the route's end-to-end cases are in land-handoff.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedLines, dataOrAuth, fixLine, parseFixProof } from '../src/fix-proof.ts';

test('parseFixProof wants every field, a sha, a path inside the worktree and a clean review', () => {
  const ok = { test: 'test/a.test.ts', red_on: 'abc1234', red_output: 'not ok 1', review: 'Clean, 0 findings' };
  assert.deepEqual(parseFixProof(ok), { test: 'test/a.test.ts', redOn: 'abc1234', redOutput: 'not ok 1', review: 'Clean, 0 findings' });
  assert.throws(() => parseFixProof('x'), /is an object/);
  assert.throws(() => parseFixProof({ ...ok, red_on: 'main' }), /as a sha/);
  assert.throws(() => parseFixProof({ ...ok, test: '../other/a.test.ts' }), /inside your worktree/);
  assert.throws(() => parseFixProof({ ...ok, test: '/etc/passwd' }), /inside your worktree/);
  assert.throws(() => parseFixProof({ ...ok, review: 'mostly clean' }), /starts with "clean"/);
  assert.throws(() => parseFixProof({ ...ok, red_output: '' }), /red_output is required/);
});

test('dataOrAuth catches auth files, migrations and data-rewriting SQL, and leaves tests and additive SQL alone', () => {
  const none = new Map<string, string[]>();
  assert.match(dataOrAuth(['src/auth.ts'], none)!, /auth file/);
  assert.match(dataOrAuth(['app/oauth.py'], none)!, /auth file/);
  assert.equal(dataOrAuth(['src/author.ts'], none), null, "an author isn't auth");
  assert.match(dataOrAuth(['db/migrations/004.sql'], none)!, /a migration/);
  assert.match(dataOrAuth(['src/session.go'], none, ['src/session.go'])!, /auth file/, "a scheme's own auth file");
  for (const sql of ['UPDATE tickets SET a = 1', 'delete from runs', 'DROP TABLE x', 'ALTER TABLE t DROP COLUMN c', 'ALTER TABLE t RENAME TO u']) {
    assert.match(dataOrAuth(['src/db.ts'], new Map([['src/db.ts', [sql]]]))!, /rewrites or deletes data/, sql);
  }
  assert.equal(dataOrAuth(['src/db.ts'], new Map([['src/db.ts', ['ALTER TABLE t ADD COLUMN c TEXT', 'SELECT * FROM t']]])), null, 'additive and read-only SQL');
  assert.equal(dataOrAuth(['test/db.test.ts'], new Map([['test/db.test.ts', ['DELETE FROM t']]])), null, "a test's fixture");
});

test('addedLines reads each file\'s added lines from a -U0 diff', () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/y.ts b/y.ts\n--- /dev/null\n+++ b/y.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n';
  assert.deepEqual([...addedLines(diff)], [['x.ts', ['new']], ['y.ts', ['one', 'two']]]);
  assert.equal(fixLine({ test: 'test/a.test.ts', redOn: 'abcdef123456' }), 'Shipped as a fix without a go: test/a.test.ts (red on abcdef1)');
});
