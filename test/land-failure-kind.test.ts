import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyLandFailure } from '../src/land.ts';

// #1013: the wake after a refused land leads with the kind of red, read from land.sh's own output.
const kind = (out: string) => classifyLandFailure(out)?.kind ?? null;

test('a rebase conflict, before and after the line', () => {
  assert.equal(kind(`land: smoke: checking ticket/9 before it queues\nland: ticket/9 won't rebase onto main cleanly (at 1a2b3c4), by git merge-tree abc, so nothing landed; conflicted files: src/land.ts. On conflicts: run git rebase main`), 'conflict');
  assert.equal(kind(`land: smoke: it conflicts with main, before the line (1 s), so nothing landed`), 'conflict');
  assert.equal(kind(`CONFLICT (content): Merge conflict in src/db.ts\nland: the rebase onto main failed (see git's output above), so nothing landed`), 'conflict');
});

test('a parse error names itself, so it is never read as infra', () => {
  const out = `land: smoke: src/mcp.ts:812: SyntaxError: Unexpected token '}'\nland: smoke: a .ts file does not parse, before the line (2 s), so nothing landed and nobody waited on it.`;
  const c = classifyLandFailure(out);
  assert.equal(c?.kind, 'parse');
  assert.match(c!.line, /Yours, not infra/);
});

test('boot-check copy: a SQLite lock is not the change', () => {
  assert.equal(kind(`deploy: boot check: the new code on a spare port with a copy of the database\nError: database is locked (SQLITE_BUSY)\ndeploy: boot check failed; nothing deployed`), 'boot-copy');
  // a boot check that failed for another reason says nothing about SQLite: unknown, today's text
  assert.equal(kind(`deploy: boot check: the new code\nReferenceError: foo is not defined\ndeploy: boot check failed; nothing deployed`), null);
});

test('CI or runner trouble with no failing test', () => {
  assert.equal(kind(`land: the CI run failed in its setup step "Set up job", before any test ran (https://x/1): the runner needs fixing`), 'ci');
});

test('a flake: the second red whose files all passed alone', () => {
  const out = `run-tests: test/fresh-session.test.ts: failed in the full run, passed alone (load 9.1)\n✖ test/fresh-session.test.ts › starts › ok (30ms)\nland: tests failed on the rebased branch in CI again (https://x/2), on the one fresh run after a red of flakes only (test/fresh-session.test.ts), so main is untouched`;
  assert.equal(kind(out), 'flake');
});

test('a repo-wide snapshot or budget test, and the change\'s own test', () => {
  const head = (f: string) => `✖ test/${f} › something › case (12ms)\nland: tests failed on the rebased branch (full log: /x), so main is untouched`;
  for (const f of ['prompt-budget.test.ts', 'access-matrix.test.ts', 'schema-compat.test.ts']) assert.equal(kind(head(f)), 'always-test');
  const own = classifyLandFailure(`land: smoke: ✖ test/land-units.test.ts › a › b (4ms)\nland: smoke: tests failed (exit 1), before the line (30 s), so nothing landed`);
  assert.equal(own?.kind, 'own-test');
  assert.match(own!.line, /land-units\.test\.ts/);
});

test('anything else is unknown (null), so the wake keeps today\'s text', () => {
  assert.equal(kind('land: tools/land.sh exited 1\nsomething odd'), null);
  assert.equal(kind(''), null);
});
