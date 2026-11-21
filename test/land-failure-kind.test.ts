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

test('CI or runner trouble with no failing test, but not once tests ran red after the fallback', () => {
  assert.equal(kind(`land: runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran (https://x/1)`), 'ci');
  assert.equal(kind(`land: CI FALLBACK: the CI run failed in its setup step "Set up job"\nland: tests failed on the rebased branch (full log: /x), so main is untouched`), null);
  assert.equal(kind(`land: the CI run failed in its setup step "Set up job", before any test ran (https://x/1): the runner needs fixing`), 'ci');
});

test('a flake: the second red whose files all passed alone', () => {
  const out = `run-tests: test/fresh-session.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 9.1)\nland: tests failed on the rebased branch in CI (https://x/2), so main is untouched`;
  assert.equal(kind(out), 'flake');
  // CI's failed log carries a job/step prefix on every line, and one real red among the flakes is not a flake
  const mixed = `build\ttests\t2026-11-18T10:00:00Z run-tests: test/a.test.ts: failed in the full run, passed alone: likely load\nbuild\ttests\t2026-11-18T10:00:01Z run-tests: test/b.test.ts: failed again alone: a real failure\nland: tests failed on the rebased branch in CI (https://x/3), so main is untouched`;
  assert.equal(kind(mixed), null);
});

test('after a retry in place (#1360), only the second attempt is read: its real red is not a flake', () => {
  const first = `run-tests: test/a.test.ts: failed in the full run, passed alone: likely load, not your change\nland: refused by the pipeline (only flakes failed on perigee: test/a.test.ts), not your change: keeping its place in line and riding the next train, once`;
  assert.notEqual(kind(`${first}\nland: back at the front\n✖ test/b.test.ts › x › y (3ms)\nland: tests failed on the rebased branch (full log: /x), so main is untouched`), 'flake');
  assert.equal(kind(`${first}\nland: back at the front\nrun-tests: test/a.test.ts: failed in the full run, passed alone: likely load\nland: refused by the pipeline again`), 'flake');
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
