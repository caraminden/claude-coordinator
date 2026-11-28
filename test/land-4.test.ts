// Part 4 of 4 of the land tests (#2208); the shared setup is in land-setup.ts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, ci } from './land-fixture.ts';
import { until } from './wait.ts';
import { landText } from './land-files.ts';
import { repo, timings, waits, procAt, once, retries, flaky, landLog, guardSetup, smokeSetup, startsLater, ciDown } from './land-setup.ts';

test('a perigee red with a real failure beside a flake refuses at once, with no retry (#1360)', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'test/flaky.test.mjs', flaky);
  const shared = join(r.dir, 'shared');
  const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', FAIL_TESTS: '1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /flaky\.test\.mjs: failed in the full run, passed alone/);
  assert.match(res.stderr, /tests failed on the rebased branch/);
  assert.doesNotMatch(res.stderr, /refused by the pipeline|retry in place/);
  assert.equal(retries(shared).length, 0);
});

test("a busy perigee doesn't take the recent no-answer note's shortcut: it asks CI again and waits for it", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'one\n');
  let res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0', ...procAt(r) });
  assert.equal(res.status, 0, res.stderr);
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ ...procAt(r, { load: 999 }) });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /so this one doesn't wait for it/);
  assert.match(res.stderr, /CI passed/);
  assert.equal(c.localRuns(), 1, 'only the first, quiet, landing ran the suite here');
});

// #900: a skewed runner clock lasts hours, and each landing spent a CI run on learning it again.
test("a red in the runner's clock step leaves the note, so the next landing doesn't spend a CI run on it", () => {
  const r = setup();
  const c = ci(r);
  const down = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'ci-down');
  r.commit(r.wt, 'b.txt', 'one\n');
  let res = c.run({ FAKE_CI: 'red', FAKE_STEP: "the runner's clock" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(down), 'the landing leaves a note');
  const asked = c.calls();
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ FAKE_CI: 'red', FAKE_STEP: "the runner's clock" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI gave no answer to a landing \d+ s ago \(runner clock: /);
  assert.equal(c.calls(), asked, 'GitHub is not asked');
  assert.equal(c.localRuns(), 2);
});

test('a red run here after a fallback still refuses', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = c.run({ FAKE_RUNNERS: '0', FAIL_TESTS: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CI FALLBACK.*tests failed on the rebased branch \(full log/s);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

// The tests run from the worktree's top, wherever in it land.sh was started (#468 S10-7).
test('run from a subfolder of the worktree, it tests and lands the same', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  // By a relative path, as a person in the subfolder would type it: its helpers are found all the same.
  const res = spawnSync('bash', [relative(join(r.wt, 'test'), land)], { cwd: join(r.wt, 'test'), encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes');
});

test('a stale squash, which reverts what landed since the branch started, is refused until it names each undo (#677)', () => {
  const r = setup();
  const lines = (who: string) => [1, 2, 3, 4, 5].map((k) => `${who} landed this, line ${k}\n`).join('');
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.source, 'c.txt', lines('someone else'));
  const theirs = git(r.source, 'rev-parse', 'main');
  // The branch's own ticket's earlier landing doesn't count.
  writeFileSync(join(r.source, 'd.txt'), lines('an earlier #1'));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', '#1: the first part');
  git(r.wt, 'reset', '--soft', 'main');
  git(r.wt, 'commit', '-qm', 'squashed');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`removes what these landed, without naming them:\\nland:   ${theirs.slice(0, 12)} c\\.txt: someone else .*\\(5 of the 5 lines`));
  assert.doesNotMatch(res.stderr, /^land: +[0-9a-f]{12} #1: the first part/m);
  assert.match(res.stderr, /git reset --soft \$\(git merge-base HEAD main\).*"Undoes: <sha>"/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.source, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), null, 'no deploy');
  git(r.wt, 'commit', '-q', '--amend', '-m', `squashed\n\nUndoes: ${theirs.slice(0, 9)}`);
  const again = r.run();
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!existsSync(join(r.source, 'c.txt')), 'the named undo landed');
});

test("a plain git revert of another minion's landing names it, so the undo guard lets it land (#677)", () => {
  const r = setup();
  r.commit(r.source, 'c.txt', [1, 2, 3, 4, 5].map((k) => `someone else landed this, line ${k}\n`).join(''));
  git(r.wt, 'rebase', '-q', 'main');
  git(r.wt, 'revert', '--no-edit', 'HEAD');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(join(r.source, 'c.txt')));
});

test("the undo guard is the kit template's, line for line, so a fix to one reaches the other (#677)", () => {
  const guard = (text: string) => text.match(/^# The undo guard \(#677[^]*?\n\}\n/m)?.[0];
  assert.ok(guard(landText()));
  assert.equal(guard(landText()), guard(readFileSync(join(import.meta.dirname, '..', 'kit/skills/scheme-setup/templates/land.sh'), 'utf8')));
});

test('a conflict aborts the rebase and lands nothing', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ LAND_SMOKE: '0' }); // the rebase under the lock, which smoke's check before the line would beat
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed/);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip, 'the branch is as it was');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('a conflict is logged to the retro-log with its files, and the refusal names them', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared, LAND_SMOKE: '0' }); // the rebase under the lock, as above
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed.*conflicted files: a\.txt\./);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  const log = landLog(shared);
  assert.match(log, new RegExp(`^- \\d\\d:\\d\\d:\\d\\dZ · land conflict · ticket/1-x onto ${main.slice(0, 7)}: a\\.txt$`, 'm'));
  assert.deepEqual(
    timings(shared).map((l) => l.replace(/^- \S+ · /, '').replace(/\d+/g, 'N')),
    ['timing · ticket/N-x · line N · rebase N · ci-queue - · ci-run - · fallback - · deploy - · live - · refused at rebase'],
  );
});

test('a rebase that cannot start logs no conflicted files', () => {
  const r = setup();
  r.commit(r.wt, 'x.txt', 'mine\n');
  writeFileSync(join(r.source, 'c.txt'), 'x\n');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'c');
  // main adds c.txt; an untracked c.txt in the worktree is in the way of the rebase.
  writeFileSync(join(r.wt, 'c.txt'), 'untracked\n');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  const log = landLog(shared);
  assert.match(log, /land conflict · ticket\/1-x: no conflicted files found/m);
});

test('a conflict still refuses the same when there is no shared dir or it cannot be written', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const main = git(r.source, 'rev-parse', 'main');
  const blocker = join(r.dir, 'blocker');
  writeFileSync(blocker, 'a file, not a folder\n');
  for (const shared of ['', blocker]) {
    const res = r.run({ COORDINATOR_SHARED_DIR: shared, LAND_SMOKE: '0' }); // the rebase under the lock, as above
    assert.equal(res.status, 1);
    assert.match(res.stderr, /rebase onto main failed/);
    assert.equal(git(r.source, 'rev-parse', 'main'), main);
    assert.equal(git(r.wt, 'status', '--porcelain'), '');
  }
});

test('a guard test that fails on the rebased branch refuses before any push to land/*, with its own message, and no CI run is spent (#1240)', () => {
  const r = guardSetup();
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ GUARD_EXIT: '1' });
  assert.equal(res.status, 1);
  assert.equal(r.ran(), '/dev/null --timeout 120 test/schema-compat.test.ts test/ui-contract.test.ts', 'only the guards the repo has, without the always-tests');
  assert.match(res.stderr, /land: guard: ✖ test\/schema-compat\.test\.ts:40 › each schema number is used once\nland: guard:   SCHEMA_HISTORY 212 is taken twice\n/);
  assert.match(res.stderr, /guard tests failed on \w+, the branch rebased onto main \(output above\), so no CI run was spent and main is untouched/);
  assert.doesNotMatch(res.stderr, /full output|waiting for CI|CI FALLBACK/);
  assert.equal(r.c.calls(), '', 'GitHub never asked, nothing pushed');
  assert.equal(r.c.refs(), '');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.match(landLog(r.shared), /· guard · ticket\/1-x · test\/schema-compat\.test\.ts · \d+s$/m);
  assert.match(landLog(r.shared), /· timing · ticket\/1-x · .* · refused at guards$/m);
});

test('guard tests that pass, or cannot decide, let the land go on to CI (#1240)', () => {
  let r = guardSetup();
  let res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /guard tests passed on \w+ in \d+ s\n(.*\n)*.*waiting for CI/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  r = guardSetup();
  res = r.run({ GUARD_EXIT: '124' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the guard tests couldn't run or ran past 120 s \(exit 124\), so they don't decide: CI runs them/);
});

test('the smoke check refuses a conflict before the line: a smoke line in the retro log, no timing line, the lock never taken (#1012)', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /by git merge-tree before the line, so nothing landed; conflicted files: a\.txt\./);
  assert.match(res.stderr, /^land: smoke: it conflicts with main, before the line \(\d+ s\), so nothing landed and nobody waited on it\./m);
  assert.doesNotMatch(res.stderr, /^queue: /m, 'it never got in line');
  assert.equal(r.note(), null, 'no deploy ran');
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.deepEqual(timings(shared), []);
  assert.match(landLog(shared), /^- \S+ · smoke · ticket\/1-x · it conflicts with main · \d+s$/m);
  assert.match(landLog(shared), /· land conflict · ticket\/1-x onto \w+: a\.txt · before the line$/m, 'the conflict line the architecture check counts');
});

test("the smoke check runs the always-tests and the branch's changed test files, and refuses a red one before the line (#1012)", () => {
  const r = smokeSetup();
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.smoke({ SMOKE_EXIT: '1' });
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(r.ran(), ['--timeout 300 test/always.test.ts test/mine.test.ts', 'alone --timeout 300 test/always.test.ts'], 'not the deleted test, not the comment or blank line; then the failed file alone');
  assert.match(res.stderr, /^land: smoke: ✖ test\/always\.test\.ts:3 › a snapshot$/m);
  assert.doesNotMatch(res.stderr, /full output/, "citadel-test's log is the land's runner's, not the minion's");
  assert.match(res.stderr, /^land: smoke: tests failed \(exit 1\), before the line \(\d+ s\), so nothing landed/m);
  assert.doesNotMatch(res.stderr, /^queue: /m);
  assert.equal(r.note(), null);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.deepEqual(timings(r.shared), []);
  assert.match(landLog(r.shared), /· smoke · ticket\/1-x · tests failed \(exit 1\) · \d+s$/m);
});

test('the smoke check adds the @pinned tests (the route test, list-reads, the boot check) only when the affected map picks them for what the branch changed (#1544, #2037)', () => {
  const route = 'access-matrix';
  const run = (changed: string, edit = (m: string) => m) => {
    const r = smokeSetup();
    copyFileSync(join(repo, 'tools', 'affected.ts'), join(r.source, 'tools', 'affected.ts'));
    writeFileSync(join(r.source, 'tools', 'affected-map.txt'), edit(readFileSync(join(repo, 'tools', 'affected-map.txt'), 'utf8')));
    // built, not quoted: a quoted test name reads as an import to test/pipeline-files.test.ts
    for (const t of [route, 'list-reads', 'boot-check']) writeFileSync(join(r.source, 'test', `${t}.test.ts`), '');
    git(r.source, 'add', '-A');
    git(r.source, 'commit', '-qm', 'map');
    git(r.wt, 'rebase', '-q', 'main');
    mkdirSync(dirname(join(r.wt, changed)), { recursive: true });
    r.commit(r.wt, changed, 'x\n');
    assert.equal(r.smoke().status, 0);
    return r.ran()[0];
  };
  assert.match(run('src/http.ts'), new RegExp(`test/mine\\.test\\.ts test/${route}\\.test\\.ts$`));
  assert.doesNotMatch(run('notes/c.txt'), new RegExp(route));
  // #2037: the map's other @pinned tests (list-reads, the boot check) join the same way, for the paths that pick them.
  assert.match(run('src/runner.ts'), /test\/mine\.test\.ts test\/boot-check\.test\.ts test\/list-reads\.test\.ts$/);
  // A map from before @pinned: the route test alone, as before.
  assert.match(
    run('src/http.ts', (m) => m.replace(/^@pinned .*\n/m, '')),
    new RegExp(`test/${route}\\.test\\.ts$`),
  );
  assert.doesNotMatch(
    run('src/runner.ts', (m) => m.replace(/^@pinned .*\n/m, '')),
    /list-reads|boot-check/,
  );
  // A map that can't answer runs every @pinned test, never skips one.
  assert.match(
    run('notes/c.txt', (m) => `${m}a line that is no rule\n`),
    new RegExp(`test/${route}\\.test\\.ts test/list-reads\\.test\\.ts test/boot-check\\.test\\.ts$`),
  );
});

test("a clean smoke check lands as before, its time outside the timing line; tests past the limit don't decide; LAND_SMOKE=0 skips it (#1012)", () => {
  const r = smokeSetup();
  const res = r.smoke({ SMOKE_SLEEP: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /^land: smoke: passed in \d+ s$/m);
  assert.deepEqual(r.ran(), ['--timeout 300 test/always.test.ts test/mine.test.ts']);
  assert.equal(timings(r.shared).length, 1, landLog(r.shared));
  // The same line as before the smoke check, and its 2 s are not in the line's time.
  assert.match(timings(r.shared)[0], /· timing · ticket\/1-x · line [01] · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/);
  assert.doesNotMatch(landLog(r.shared), / · smoke · /, 'a pass logs nothing');

  const slow = smokeSetup();
  const late = slow.smoke({ SMOKE_EXIT: '124', LAND_SMOKE_TIMEOUT: '7' });
  assert.equal(late.status, 0, late.stderr);
  assert.deepEqual(slow.ran(), ['--timeout 7 test/always.test.ts test/mine.test.ts'], 'a hang is never rerun');
  assert.match(late.stderr, /smoke: the tests ran past 7 s, so they don't decide: getting in line, and CI runs them all/);

  const broken = smokeSetup();
  const setupError = broken.smoke({ SMOKE_EXIT: '2' });
  assert.equal(setupError.status, 0, setupError.stderr);
  assert.match(setupError.stderr, /smoke: citadel-test couldn't run the tests \(exit 2\), so they don't decide: getting in line/);

  // A file that fails in the run and passes alone is a likely flake: it gets a flake line and doesn't decide.
  const flaky = smokeSetup();
  const flake = flaky.smoke({ SMOKE_EXIT: '1', SMOKE_ALONE_EXIT: '0' });
  assert.equal(flake.status, 0, flake.stderr);
  assert.match(flake.stderr, /smoke: test\/always\.test\.ts failed, then passed alone: likely load, not your change/);
  assert.match(landLog(flaky.shared), /· flake · test\/always\.test\.ts · smoke · ticket\/1-x$/m);
  assert.match(flake.stderr, /^land: flake: test\/always\.test\.ts · smoke$/m);
  assert.doesNotMatch(landLog(flaky.shared), /^- \S+ · smoke · /m, 'no smoke refusal');

  const off = smokeSetup();
  assert.equal(off.smoke({ SMOKE_EXIT: '1', LAND_SMOKE: '0' }).status, 0);
  assert.deepEqual(off.ran(), []);
});

test('the smoke check runs changed .js and .mjs tests too, and reruns a failed one alone: one passing .ts file never makes it a flake (#2167)', () => {
  const r = smokeSetup();
  // citadel-test, red on a .ts, a .js and a .mjs file; alone, the .js and .mjs ones still fail.
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
echo "\${CITADEL_TEST_ALWAYS:+alone }$*" >>"$SMOKE_ARGS"
[ -z "\${CITADEL_TEST_ALWAYS:-}" ] || { [[ "\${@: -1}" == *.test.ts ]]; exit; }
echo "✖ test/always.test.ts:3 › a snapshot"; echo "✖ test/guard.test.js › (the file itself)"; echo "✖ test/other.test.mjs:2 › a guard"; exit 1
`,
  );
  git(r.source, 'commit', '-qam', 'a red .js guard');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'test/guard.test.js', '');
  r.commit(r.wt, 'test/other.test.mjs', '');
  const res = r.smoke();
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(r.ran(), ['--timeout 300 test/always.test.ts test/guard.test.js test/mine.test.ts test/other.test.mjs', 'alone --timeout 300 test/always.test.ts', 'alone --timeout 300 test/guard.test.js', 'alone --timeout 300 test/other.test.mjs']);
  assert.match(res.stderr, /^land: smoke: tests failed \(exit 1\)/m);
  assert.doesNotMatch(res.stderr, /passed alone/);
  assert.doesNotMatch(landLog(r.shared), /· flake · /);
});

// #1983: eight ships on 2026-11-25 waited up to 70 minutes in line to hear they were over the size list. The real repo-wide
// list and the real size test (its list of allowed giants emptied: the fixture has none of them), run by the real citadel-test.
test('a branch over the file size limit is refused by the smoke check, before the line (#1983)', () => {
  const r = setup();
  const size = `test/${'size-budget'}.test.ts`; // built, not quoted: test/pipeline-files.test.ts reads quoted test names
  for (const f of ['tools/citadel-test', 'tools/citadel-test-reporter.ts', 'tools/citadel-node', 'tools/citadel-node.cjs', 'tools/mem-room', 'test/leak-guard.ts', 'test/leak-file.ts', 'package.json', size]) cpSync(join(repo, f), join(r.source, f));
  const real = readFileSync(join(repo, size), 'utf8');
  const bare = real.replace(/(export const ALLOWED[^\n]* = \{)\n[^]*?\n\};/, '$1};');
  assert.notEqual(bare, real);
  writeFileSync(join(r.source, size), bare);
  const listed = readFileSync(join(repo, 'tools/always-tests.txt'), 'utf8').split('\n');
  writeFileSync(join(r.source, 'tools/always-tests.txt'), `${listed.filter((l) => l === size).join('\n')}\n`);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'size check');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'tools/big.sh', ':\n'.repeat(1501));
  const main = git(r.source, 'rev-parse', 'main');
  const own = { CITADEL_TEST_EXTRA: '0', TMPDIR: r.dir };
  const res = r.run(own);
  assert.equal(res.status, 1, res.stderr);
  // The size room (#2139) refuses it first, ahead of the size test, with the same file and limit.
  assert.match(res.stderr, /^land: smoke: size room: tools\/big\.sh would be 1501 lines, 1 over its limit 1500 \(unlisted\)/m);
  assert.match(res.stderr, /^land: smoke: a file it grows would be over its size limit after the ships in line, before the line/m);
  assert.doesNotMatch(res.stderr, /^(queue|land: rebasing)/m, 'it never got in line');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  r.commit(r.wt, 'tools/big.sh', ':\n'.repeat(1500));
  const ok = r.run(own);
  assert.equal(ok.status, 0, ok.stderr);
});

test('a commit that lost its #N: title is refused by the smoke check, before the line; a branch with no #N titles is not (#1983)', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  git(r.wt, 'commit', '-q', '--amend', '-m', 'lost it');
  git(r.wt, 'commit', '-q', '--allow-empty', '-m', '#1: kept');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = r.run({ COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^land: smoke: commit [0-9a-f]+ \("lost it"\) lost its #N: title/m);
  assert.match(res.stderr, /^land: smoke: a commit title is wrong, before the line \(\d+ s\), so nothing landed and nobody waited on it\./m);
  assert.doesNotMatch(res.stderr, /^(queue|land: rebasing)/m, 'it never got in line');
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.match(landLog(shared), /· smoke · ticket\/1-x · a commit title is wrong · \d+s$/m);
  // The check at the front stays, for what the line or the rebase changed.
  const late = r.run({ LAND_SMOKE: '0' });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /^land: rebasing [^]*lost its #N: title/m);
  git(r.wt, 'reset', '-q', '--hard', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n'); // "b.txt: mine": no title of it starts "#N"
  assert.equal(r.run().status, 0);
});

test('the smoke check does not blame a title the rebase leaves out: one main has cherry-picked, or one that came off main (#1983)', () => {
  for (const kind of ['cherry-picked', 'taken back']) {
    const r = setup();
    r.commit(r.wt, 'x.txt', 'no number in this title');
    const x = git(r.wt, 'rev-parse', 'HEAD');
    if (kind === 'cherry-picked') {
      r.commit(r.source, 'm.txt', 'main moved');
      git(r.source, 'cherry-pick', x);
    } else {
      const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
      mkdirSync(state);
      writeFileSync(join(state, 'taken-back'), `${x} ticket/9-other\n`);
    }
    r.commit(r.wt, 'b.txt', 'mine\n');
    git(r.wt, 'commit', '-q', '--amend', '-m', '#1: mine');
    const res = r.run();
    assert.equal(res.status, 0, `${kind}: ${res.stderr}`);
    assert.equal(git(r.source, 'log', '-1', '--format=%s'), '#1: mine');
  }
});

test("the smoke check refuses a .ts file that doesn't parse, by the branch's tools/parse-check.ts (#1012)", () => {
  const r = setup();
  writeFileSync(join(r.wt, 'tools', 'parse-check.ts'), "console.log('src/x.ts does not parse (Expected a semicolon)'); process.exit(1);\n");
  git(r.wt, 'add', '-A');
  git(r.wt, 'commit', '-qm', 'a parse check that finds one');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /^land: smoke: src\/x\.ts does not parse \(Expected a semicolon\)$/m);
  assert.match(res.stderr, /^land: smoke: a \.ts file does not parse, before the line/m);
  assert.equal(r.note(), null);
});

test('--check (#770) says whether the rebase onto main would conflict, naming the files, and changes nothing', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.source, 'b.txt', 'clean\n');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  let res = r.run({}, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  r.commit(r.source, 'a.txt', 'theirs\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  res = r.run({ COORDINATOR_SHARED_DIR: shared }, ['--check']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, new RegExp(`^land: ticket/1-x won't rebase onto main \\(${main.slice(0, 7)} "a\\.txt: theirs"\\) cleanly, by git merge-tree at hand-off, so nothing landed; conflicted files: a\\.txt\\. On conflicts: run git rebase main, resolve them`));
  assert.match(landLog(shared), new RegExp(`^- \\d\\d:\\d\\d:\\d\\dZ · land conflict · ticket/1-x onto ${main.slice(0, 7)}: a\\.txt · at hand-off$`, 'm'));
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.ok(!existsSync(state), 'no lock, line or state');
  assert.equal(r.note(), null, 'no deploy');
});

test('--check leaves behind a commit that came off main, as the rebase does, and checks --into against the build', () => {
  const r = setup();
  const before = git(r.source, 'rev-parse', 'main');
  r.commit(r.source, 'a.txt', 'rolled back\n');
  const u = git(r.source, 'rev-parse', 'main');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  git(r.source, 'reset', '-q', '--keep', before);
  r.commit(r.source, 'a.txt', 'redone\n');
  assert.equal(r.run({}, ['--check']).status, 3, 'carried along, the commit that came off main would conflict');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  mkdirSync(state);
  writeFileSync(join(state, 'taken-back'), `${u} ticket/9-other\n`);
  let res = r.run({}, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  // --into: against the build, not main, and only when the branch isn't on the build's tip already.
  git(r.source, 'branch', 'build/1', before);
  res = r.run({}, ['--check', '--into', 'build/1', 'test/ok.test.mjs']);
  assert.equal(res.status, 0, res.stderr);
  git(r.source, 'checkout', '-q', 'build/1');
  r.commit(r.source, 'b.txt', "the build's\n");
  git(r.source, 'checkout', '-q', 'main');
  res = r.run({}, ['--check', '--into', 'build/1', 'test/ok.test.mjs']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /won't rebase onto build\/1 .*conflicted files: b\.txt\. On conflicts: run git rebase build\/1/);
});

test('a deploy that fails before going live puts main back', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ FAKE_DEPLOY_EXIT: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /main is back at/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.ok(!existsSync(join(r.source, 'b.txt')));
});

// Other schemes' builds can hold every heavy slot for an hour. A landing that waited for one while
// holding the deploy lock held up every other landing (#499): a landing CI answers never touches a slot. One CI can't
// answer waits for a quiet perigee (#1254), the free slot included, and is refused after LAND_QUIET_LIMIT, not an hour.
test('two landings both land on CI while other jobs hold every heavy slot', async () => {
  const r = setup();
  const c = ci(r);
  const wt2 = join(r.dir, 'wt2');
  git(r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-y', wt2);
  r.commit(r.wt, 'b.txt', 'one\n');
  r.commit(wt2, 'c.txt', 'two\n');
  const heavy = join(r.dir, 'heavy');
  mkdirSync(heavy);
  writeFileSync(join(heavy, 'slots'), '1\n');
  // A stand-in for someone's cargo build, holding the only slot until this test stops it.
  const build = spawn('flock', [join(heavy, 'slot-0'), 'sleep', '600'], { detached: true, stdio: 'ignore' });
  try {
    await until('the lock to be held', async () => spawnSync('flock', ['-n', join(heavy, 'slot-0'), 'true']).status !== 0);
    for (const wt of [r.wt, wt2]) {
      const res = c.run({ CITADEL_HEAVY_DIR: heavy }, [], wt);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /CI passed/);
      assert.doesNotMatch(res.stderr, /heavy slot|perigee is busy/, 'it never waited on the build');
    }
    assert.deepEqual(git(r.source, 'log', '--format=%s', 'main').split('\n').sort(), ['b.txt: one', 'base', 'c.txt: two']);
  } finally {
    try {
      process.kill(-build.pid!, 'SIGKILL');
    } catch {}
  }
});

test("refuses uncommitted work, main itself, arguments, running inside a citadel-heavy slot, and a person's container", () => {
  const r = setup();
  writeFileSync(join(r.wt, 'a.txt'), 'dirty\n');
  assert.match(r.run().stderr, /uncommitted changes/);
  git(r.wt, 'checkout', '--', 'a.txt');
  assert.match(spawnSync('bash', [land, '--now'], { cwd: r.wt, encoding: 'utf8', env }).stderr, /takes no arguments/);
  // Under citadel-heavy it would hold a slot other schemes need while it waits on the deploy lock.
  assert.match(r.run({ CITADEL_HEAVY_HELD: '1' }).stderr, /not under citadel-heavy/);
  // A person's Claude container has no deploy lock or GitHub login: the land tool runs it on the host.
  assert.match(r.run({ COORDINATOR_CONTAINER: '1' }).stderr, /runs in a container: call the land tool/);
  const onMain = spawnSync('bash', [land], { cwd: r.source, encoding: 'utf8', env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source } });
  assert.match(onMain.stderr, /not main/);
});

// merge-tree reads .gitattributes from the worktree it runs in, but the rebase sees main's: a union file main gained
// after the branch forked must not make --check refuse a branch that appends to it too.
test("--check reads main's .gitattributes, so both appending to a union file is no conflict", () => {
  const r = setup();
  r.commit(r.wt, 'log.md', 'base\nmine\n');
  for (const d of [r.wt, r.source]) mkdirSync(join(d, 'docs'));
  r.commit(r.wt, 'docs/notes.md', 'base\nmine\n');
  r.commit(r.source, '.gitattributes', 'log.md merge=union\n');
  r.commit(r.source, 'log.md', 'base\ntheirs\n');
  r.commit(r.source, 'docs/.gitattributes', 'notes.md merge=union\n'); // a folder's own, as git reads it
  r.commit(r.source, 'docs/notes.md', 'base\ntheirs\n');
  // Conflict prep off: its rebase in a scratch checkout reads main's .gitattributes either way, so it would hide a wrong
  // verdict from the merge-tree trial itself (git before 2.40 ignores attr.tree, #2071).
  for (const prep of ['1', '0']) {
    const res = r.run({ LAND_PREP: prep }, ['--check']);
    assert.equal(res.status, 0, `LAND_PREP=${prep}: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /conflicts with main/, `LAND_PREP=${prep}`);
  }
});

test('a runner online but busy past the short bound: the ship waits for it, lands on CI, runs no suite here and writes no ci-down', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(r.dir, 'ci-state');
  writeFileSync(state, 'queued');
  const shared = join(r.dir, 'shared');
  const res = await c.runAsync({ FAKE_CI_FILE: state, LAND_CI_START: '1', LAND_CI_START_ONLINE: '60', LAND_CI_ONLINE_POLL: '0', COORDINATOR_SHARED_DIR: shared, ...procAt(r) }, startsLater(state));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /a citadel-ci-linux runner is online but hasn't started the job \(busy with another run, most likely\), so this waits for it: up to 1 min/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|no runner started/);
  assert.equal(c.localRuns(), 0, 'no suite on perigee');
  assert.ok(!existsSync(ciDown(r)), 'no ci-down note');
  const queued = Number(landLog(shared).match(/· timing · ticket\/1-x · .* · ci-queue (\d+) · /)?.[1]);
  assert.ok(queued >= 2, `it waited past the 1 s bound in the queue (${queued} s)`);
});

test('a busy perigee: the busy limit counts no time while a runner is online and CI still waits on it', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(r.dir, 'ci-state');
  writeFileSync(state, 'queued');
  // A 1 s busy limit: before #1361 the wait past the short bound counted, and this ship was refused.
  const res = await c.runAsync({ FAKE_CI_FILE: state, LAND_CI_START: '1', LAND_CI_START_ONLINE: '60', LAND_QUIET_LIMIT: '1', LAND_QUIET_POLL: '0.2', ...procAt(r, { load: 999 }) }, startsLater(state));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /both busy|not your change|CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
});

test('a late start or a slow run falls back on a quiet perigee but leaves no ci-down, so the next ship asks CI; no runner online leaves one', () => {
  for (const [name, extra] of [
    ['late start', { FAKE_CI: 'queued', LAND_CI_START: '0', LAND_CI_START_ONLINE: '1' }],
    ['slow run', { FAKE_CI: 'running', LAND_CI_TIMEOUT: '1' }],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'one\n');
    let res = c.run({ ...extra, ...procAt(r) });
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stderr, /CI FALLBACK: (no runner started the job within 1s, though a citadel-ci-linux runner is online|CI didn't finish within 1s of starting)/, name);
    assert.ok(!existsSync(ciDown(r)), `${name}: no ci-down note`);
    r.commit(r.wt, 'b.txt', 'two\n');
    res = c.run({ ...procAt(r) });
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stderr, /CI passed/, `${name}: the next ship asked CI`);
    assert.equal(c.localRuns(), 1, name);
  }
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'one\n');
  const t0 = Date.now();
  const res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', LAND_CI_START_ONLINE: '60', FAKE_RUNNERS_WAIT: '0', ...procAt(r) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: no runner started the job within 1s, and no citadel-ci-linux runner is registered/);
  assert.ok(Date.now() - t0 < 30_000, 'it fell back at the short bound, not the long one');
  assert.ok(existsSync(ciDown(r)), 'no runner online: the note is written');
});
