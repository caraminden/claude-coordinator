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

test("a build's merge that won't go in cleanly is a conflict too (SE6)", () => {
  assert.equal(kind(`land: build/3 won't merge main in (1a2b3c4 "x") cleanly, by git merge-tree abc, so nothing landed; conflicted files: src/land.ts`), 'conflict');
});

test('a parse error names itself, so it is never read as infra', () => {
  const out = `land: smoke: src/mcp.ts:812: SyntaxError: Unexpected token '}'\nland: smoke: a .ts file does not parse, before the line (2 s), so nothing landed and nobody waited on it.`;
  const c = classifyLandFailure(out);
  assert.equal(c?.kind, 'parse');
  assert.match(c!.line, /Yours, not infra/);
});

test('a failing test whose own output says SyntaxError is not a parse error (#1961)', () => {
  const out = [
    "land: smoke:   Reloading on SIGHUP failed (re-pinning turn files or public/); still serving the old commit, so deploy.sh restarts: SyntaxError: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
    // a land test quoting other refusals in its own output
    'land: smoke:   a .ts file does not parse',
    'land: guard:   land: x failed its burn-in in CI',
    ...['deploy', 'a', 'b'].map((f) => `land: smoke: ✖ test/${f}.test.ts:3 › it`),
    'land: tests failed (exit 1)',
    'land: smoke:   not your change: keeping its place in line', // quoted, so it must not cut the failures off
  ].join('\n');
  assert.equal(kind(out), 'own-test');
  // a real parse refusal from either script still reads as parse
  assert.equal(kind('land: smoke: src/mcp.ts:812: SyntaxError: x\nland: smoke: a .ts file does not parse, before the line'), 'parse');
  assert.equal(kind('src/mcp.ts:812: SyntaxError: x\na .ts file does not parse'), 'parse'); // unprefixed, as a smoke hook may print it
});

test('a skipped test beside files that passed alone is the ship to fix, not one to hand off again (#1914)', () => {
  const flake = 'run-tests: test/a.test.ts: failed in the full run, passed alone: likely load';
  const end = 'land: tests failed on the rebased branch in CI (https://x/2), so main is untouched';
  assert.equal(kind(`${flake}\nland: a test was skipped in CI (https://x/2): the format check. CI refuses\n${end}`), 'skipped-test');
  assert.equal(kind(`${flake}\nland: 2 tests were skipped in CI (https://x/2): a; b. CI refuses\n${end}`), 'skipped-test');
  assert.equal(kind(`${flake}\n${end}`), 'passed-alone');
});

test('boot-check copy: a SQLite lock is not the change', () => {
  assert.equal(kind(`deploy: boot check: the new code on a spare port with a copy of the database\nError: database is locked (SQLITE_BUSY)\ndeploy: boot check failed; nothing deployed`), 'boot-copy');
  // a boot check that failed for another reason says nothing about SQLite: unknown, today's text
  assert.equal(kind(`deploy: boot check: the new code\nReferenceError: foo is not defined\ndeploy: boot check failed; nothing deployed`), null);
});

test("a boot check that fails on the change's own SQL says nothing about the copy (SE3)", () => {
  const boot = (err: string) => kind(`boot-check: the copy: 4.1 s\nError: the server exited\n--- server output ---\n${err}\ndeploy: boot check failed; nothing deployed`);
  assert.equal(boot("Error: no such table: sqlite_master2\n  code: 'ERR_SQLITE_ERROR',\n  errcode: 1"), null);
  assert.equal(boot("Error: UNIQUE constraint failed: tickets.id\n  code: 'ERR_SQLITE_ERROR'\n    at SQLITE_CONSTRAINT"), null);
  // what a copy or a busy box does to it, in node's words
  for (const err of ['Error: database is locked', 'Error: database table is locked', 'Error: database or disk is full', 'Error: disk I/O error', 'Error: database disk image is malformed']) assert.equal(boot(`${err}\n  code: 'ERR_SQLITE_ERROR'`), 'boot-copy', err);
  // the boot check passed: a later test's lock is the test's
  const passed = `land: deploy has been refusing since 10:02 (the boot check failed on abc1234): running its boot check on def5678 before a CI run is spent on it\nland: the boot check passes on def5678, so this landing goes on\n`;
  assert.notEqual(kind(`${passed}Error: database is locked\nland: tests failed on the rebased branch in CI (https://x/1), so main is untouched`), 'boot-copy');
  // the check land.sh runs itself, red on the branch alone
  const own = (err: string) =>
    kind(
      `${err}\nland: def5678 fails the same check here (its output is above): running it on main, to tell a broken main from a broken change\nland: deploy has been refusing since 10:02: the boot check failed on abc1234, and def5678 fails the same check here (its output is above) while main passes it, so the cause is in your change: no CI run was spent and main is untouched`,
    );
  assert.equal(own('Error: database is locked'), 'boot-copy');
  assert.equal(own("Error: no such column: x\n  code: 'ERR_SQLITE_ERROR'"), null);
});

test("a red in CI's own log names the files that failed alone too (SE6)", () => {
  const own = (file: string, label: string) => `test\tthe full suite\t2026-11-18T10:00:00Z run-tests: ${file}: ${label}`;
  const end = 'land: tests failed on the rebased branch in CI (https://x/4), so main is untouched';
  const c = classifyLandFailure(`${own('test/b.test.ts', 'failed again alone: a real failure')}\n${own('test/a.test.ts', 'failed in the full run, passed alone: likely load')}\n${end}`);
  assert.equal(c?.kind, 'own-test');
  assert.match(c!.line, /\(test\/b\.test\.ts\)/);
  assert.equal(kind(`${own('test/prompt-budget.test.ts', 'hung when rerun alone')}\n${end}`), 'always-test');
  // an earlier run's log, of a rider that left the train, is not this ship's
  const rider = `${own('test/rider.test.ts', 'failed again alone: a real failure')}\nland: CI is red on the ship train (https://x/3): finding the ship\n`;
  assert.doesNotMatch(classifyLandFailure(`${rider}${own('test/b.test.ts', 'failed again alone: a real failure')}\n${end}`)!.line, /rider/);
  // nor does a red on main, or one that ended some other way, name them
  assert.equal(kind(`${rider}deploy: boot check failed; nothing deployed`), null);
  assert.equal(kind(`${own('test/b.test.ts', 'failed again alone: a real failure')}\nland: tests failed in CI (https://x/4) in test/b.test.ts, which fails on main's own tip too (run alone here): main is red, not this change, so main is untouched`), null);
});

test('CI or runner trouble with no failing test, but not once tests ran red after the fallback', () => {
  assert.equal(kind(`land: runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran (https://x/1)`), 'ci');
  assert.equal(kind(`land: CI FALLBACK: the CI run failed in its setup step "Set up job"\nland: tests failed on the rebased branch (full log: /x), so main is untouched`), null);
  assert.equal(kind(`land: the CI run failed in its setup step "Set up job", before any test ran (https://x/1): the runner needs fixing`), 'ci');
});

test('a flake: the second red whose files all passed alone', () => {
  const out = `run-tests: test/fresh-session.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 9.1)\nland: tests failed on the rebased branch in CI (https://x/2), so main is untouched`;
  assert.equal(kind(out), 'passed-alone');
  // CI's failed log carries a job/step prefix on every line, and one real red among the flakes is not a flake
  const mixed = `build\ttests\t2026-11-18T10:00:00Z run-tests: test/a.test.ts: failed in the full run, passed alone: likely load\nbuild\ttests\t2026-11-18T10:00:01Z run-tests: test/b.test.ts: failed again alone: a real failure\nland: tests failed on the rebased branch in CI (https://x/3), so main is untouched`;
  assert.equal(kind(mixed), 'own-test'); // b's, SE6
  // #1393: a rerun alone killed from outside has no label, so the red is not all flakes either
  const killed = `run-tests: test/a.test.ts: failed in the full run, passed alone: likely load\nrun-tests: test/b.test.ts: killed (exit 137) when rerun alone after 2s, before its 120s limit: stopped from outside, so it has no label (an unlabelled file keeps the run red)\nland: tests failed on the rebased branch in CI (https://x/4), so main is untouched`;
  assert.equal(kind(killed), null);
});

test('a burn-in red that failed alone too is no race: the wake says a plain red or a CI-only fault (#2141)', () => {
  const out = `burn-in: test/real.test.ts: failed in 10 of 10 copies at once (copies 1 2 3 4 5 6 7 8 9 10), in 9 s\nburn-in: test/real.test.ts: alone: failed too\nland: a new or changed test failed its burn-in in CI (https://x/4): test/real.test.ts: failed in 10 of 10 copies at once, so it never reached the full suite and main is untouched. test/real.test.ts failed in every copy, and run once by itself on CI it fails alone too: a plain red or a CI-only environment fault (a temp path, git identity, a missing tool), not a race. Read its output above and fix that, then run this again`;
  const c = classifyLandFailure(out);
  assert.equal(c?.kind, 'burn-in');
  assert.match(c?.line ?? '', /alone too, so it is not a race: a plain red, or a fault only CI's environment has/);
  assert.doesNotMatch(c?.line ?? '', /fix the race/);
});

test("a burn-in red (#1443) is the ship's own, even when the failing copy quotes a passed-alone line", () => {
  const out = `burn-in: test/real.test.ts, copy 3 of 10 (its output from the failing tests on):\n✖ test/real.test.ts › races › on a shared path (12ms)\nrun-tests: test/old.test.ts: failed in the full run, passed alone: likely load\nburn-in: test/real.test.ts: failed in 3 of 10 copies at once (copies 2 3 7), in 19 s\nland: refused: a new or changed test failed its burn-in in CI (https://x/4): test/real.test.ts failed in 3 of 10 copies at once, so it never reached the full suite`;
  const c = classifyLandFailure(out);
  assert.equal(c?.kind, 'burn-in');
  assert.match(c!.line, /Yours: fix the race/);
});

test('after a retry in place (#1360), only the second attempt is read: its real red is not a flake', () => {
  const first = `run-tests: test/a.test.ts: failed in the full run, passed alone: likely load, not your change\nland: refused by the pipeline (failed in the full run but passed alone on perigee: test/a.test.ts), not your change: keeping its place in line and riding the next train, once`;
  assert.notEqual(kind(`${first}\nland: back at the front\n✖ test/b.test.ts › x › y (3ms)\nland: tests failed on the rebased branch (full log: /x), so main is untouched`), 'passed-alone');
  assert.equal(kind(`${first}\nland: back at the front\nrun-tests: test/a.test.ts: failed in the full run, passed alone: likely load\nland: refused by the pipeline again`), 'passed-alone');
});

test("a repo-wide snapshot or budget test, and the change's own test", () => {
  const head = (f: string) => `✖ test/${f} › something › case (12ms)\nland: tests failed on the rebased branch (full log: /x), so main is untouched`;
  for (const f of ['prompt-budget.test.ts', 'access-matrix.test.ts', 'schema-compat.test.ts']) assert.equal(kind(head(f)), 'always-test');
  const own = classifyLandFailure(`land: smoke: ✖ test/land-units.test.ts › a › b (4ms)\nland: smoke: tests failed (exit 1), before the line (30 s), so nothing landed`);
  assert.equal(own?.kind, 'own-test');
  assert.match(own!.line, /land-units\.test\.ts/);
});

test("anything else is unknown (null), so the wake keeps today's text", () => {
  assert.equal(kind('land: tools/land.sh exited 1\nsomething odd'), null);
  assert.equal(kind(''), null);
});

test('a file land.sh would not call passed alone makes the red real, whatever else passed alone (G1)', () => {
  const ok = 'run-tests: test/a.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 9.1)';
  const end = 'land: tests failed on the rebased branch in CI (https://x/4), so main is untouched';
  for (const bad of [
    "run-tests: test/b.test.ts: rerun alone stopped after 40s, when CI's answer was due: counts as a real failure",
    "run-tests: test/b.test.ts: not rerun: the reruns' 300s ran out",
    "run-tests: test/b.test.ts: not rerun: CI's answer is due (land.sh stops waiting then), so the run counts as a real red",
    'run-tests: test/b.test.ts: not rerun: a real failure already makes this run red',
  ])
    assert.notEqual(kind(`${ok}\n${bad}\n${end}`), 'passed-alone', bad);
});

test('the line for a red whose files all passed alone does not call it a flake (Cara, 2026-11-21)', () => {
  const c = classifyLandFailure('run-tests: test/a.test.ts: failed in the full run, passed alone: likely load\nland: tests failed on the rebased branch in CI (https://x/2), so main is untouched');
  assert.doesNotMatch(c!.line, /flake/i);
  assert.match(c!.line, /passed alone/);
});

test("the fallback's no-answers on perigee are not the change, whatever ✖ their log shows (#1863)", () => {
  const log = '✖ a flaky thing (12.4ms)\n✖ test/flaky.test.ts:3 › a flaky thing\nrun-tests: the tests ran past 1200s\n';
  assert.equal(kind(`${log}land: the suite on perigee ran out of its time limit and no test is known to be ticket/9's own failure (full log: /x): that is no answer, so main is untouched. Run this again`), 'no-answer');
  assert.equal(kind('land: no test ran: the packages the tests import could not be installed here (the run-tests line above says why), so main is untouched. Run this again'), 'no-answer');
  // The limit hit and a file named as the ship's own: still its own red.
  assert.equal(kind(`${log}land: tests failed on the rebased branch: the suite ran out of time, and test/flaky.test.ts fails alone here and passes on main (full log: /x), so main is untouched`), 'own-test');
});
