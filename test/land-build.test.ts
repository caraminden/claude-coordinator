// tools/land.sh with build branches (specs/build-branches.md, #593): a feeder merges into build/<n> with --into, the
// build minion takes main in with --into build/<n> --full and lands the build with --build, and a plain land refuses
// a branch that carries a build's commits.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { git, setup, ci, env, landAsync } from './land-fixture.ts';
import { until } from './wait.ts';

type R = ReturnType<typeof setup>;
const has = (r: R, ref: string) => git(r.source, 'for-each-ref', '--format=%(refname)', ref) !== '';
const tipOf = (r: R, ref: string) => git(r.source, 'rev-parse', ref);
const runs = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0);
// A build made from main, and a worktree on a new branch from it (a feeder, or the build minion's).
function build(r: R) {
  git(r.source, 'branch', 'build/3', 'main');
}
function worktree(r: R, name: string, from = 'build/3') {
  const wt = join(r.dir, name.replace(/\W/g, '-'));
  git(r.source, 'worktree', 'add', '-q', '-b', name, wt, from);
  return wt;
}
const into = (r: R, files: string[], extra: Record<string, string> = {}, cwd = r.wt) => r.run({ TEST_RUNS: join(r.dir, 'test-runs'), ...extra }, ['--into', 'build/3', ...files], cwd);
const OK = 'test/ok.test.mjs';
const landLog = (shared: string) => readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');

test('a feeder merges into its build: the named tests run on the rebased commit, build/<n> moves, and nothing else does', () => {
  const r = setup();
  const c = ci(r);
  build(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const other = worktree(r, 'ticket/2-y');
  r.commit(other, 'c.txt', 'theirs\n');
  assert.equal(c.run({}, ['--into', 'build/3', OK], other).status, 0);
  const main = tipOf(r, 'main');
  const live = git(r.live, 'rev-parse', 'HEAD');
  const shared = join(r.dir, 'shared');
  const res = c.run({ COORDINATOR_SHARED_DIR: shared }, ['--into', 'build/3', OK]);
  assert.equal(res.status, 0, res.stderr);
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  assert.equal(tipOf(r, 'build/3'), tip, 'build/3 is the rebased branch');
  assert.equal(git(r.source, 'log', '--format=%s', 'build/3', '-3'), 'b.txt: mine\nc.txt: theirs\nbase', 'it rebased onto the first feeder');
  assert.equal(tipOf(r, 'main'), main, 'main is untouched');
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), live, 'the live checkout is untouched');
  assert.equal(r.note(), null, 'no deploy');
  assert.equal(c.calls(), '', 'no CI run');
  assert.equal(c.localRuns(), 2, 'the named test file ran, once per merge');
  assert.match(res.stderr, /build\/3 is now at/);
  assert.match(landLog(shared), /· timing · ticket\/1-x · into build\/3 · line \d+ · rebase \d+ · tests \d+ · merged$/m);
});

test('a red named test file refuses with the build untouched', () => {
  const r = setup();
  build(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const before = tipOf(r, 'build/3');
  const res = into(r, [OK], { FAIL_TESTS: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed.*build\/3 is untouched/s);
  assert.equal(tipOf(r, 'build/3'), before);
});

test('with no test files named it refuses, unless the change is docs only', () => {
  const r = setup();
  build(r);
  r.commit(r.wt, 'b.txt', 'code\n');
  const before = tipOf(r, 'build/3');
  let res = into(r, []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /name the test files/);
  assert.equal(tipOf(r, 'build/3'), before);
  const docs = worktree(r, 'ticket/2-docs');
  r.commit(docs, 'README.md', 'words\n');
  res = into(r, [], {}, docs);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(tipOf(r, 'build/3'), git(docs, 'rev-parse', 'HEAD'));
  assert.equal(runs(join(r.dir, 'test-runs')), 0, 'no test ran');
});

test('it refuses a build that does not exist, a bad build name, and test names that are not files', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  assert.match(into(r, [OK]).stderr, /build\/3 doesn't exist/);
  assert.match(r.run({}, ['--into', 'main', OK]).stderr, /build\/<n>/);
  assert.match(r.run({}, ['--into']).stderr, /build\/<n>/);
  build(r);
  assert.match(into(r, ['test/nope.test.mjs']).stderr, /test\/nope\.test\.mjs is not a file/);
  assert.match(into(r, ['--test-only']).stderr, /is not a file/);
  assert.equal(tipOf(r, 'build/3'), tipOf(r, 'main'));
});

test('a conflict refuses with the build and the branch untouched', () => {
  const r = setup();
  build(r);
  r.commit(r.wt, 'a.txt', 'mine\n');
  const other = worktree(r, 'ticket/2-y');
  r.commit(other, 'a.txt', 'theirs\n');
  assert.equal(into(r, [OK], {}, other).status, 0);
  const before = tipOf(r, 'build/3');
  const head = git(r.wt, 'rev-parse', 'HEAD');
  const res = into(r, [OK]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto build\/3 failed.*conflicted files: a\.txt/s);
  assert.equal(tipOf(r, 'build/3'), before);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
});

// The build minion's daily merge of main: its branch at the build's tip, main merged in, the full suite on CI.
function takeMain(r: R, bwt: string) {
  r.commit(r.source, 'm.txt', 'on main\n');
  git(bwt, 'merge', '--ff-only', 'build/3');
  git(bwt, 'merge', '-q', '--no-edit', 'main');
}

test('--full takes main in: it waits for the full suite on CI, keeps the merge commit, and moves only build/<n>', () => {
  const r = setup();
  const c = ci(r);
  build(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  assert.equal(into(r, [OK]).status, 0);
  const folded = tipOf(r, 'build/3');
  const bwt = worktree(r, 'ticket/9-build');
  takeMain(r, bwt);
  const head = git(bwt, 'rev-parse', 'HEAD');
  const main = tipOf(r, 'main');
  const ran = c.localRuns(); // the feeder's merge ran its test file
  const res = c.run({}, ['--into', 'build/3', '--full'], bwt);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /waiting for CI on .*CI passed on/s);
  assert.equal(git(bwt, 'rev-parse', 'HEAD'), head, 'no rebase: the merge of main stays as it was');
  assert.equal(tipOf(r, 'build/3'), head);
  assert.equal(git(r.source, 'rev-list', '--merges', '--count', 'main..build/3'), '1');
  assert.equal(git(r.source, 'merge-base', '--is-ancestor', folded, 'build/3') || 'yes', 'yes', "the feeder's commit keeps its hash");
  assert.match(c.calls(), new RegExp(`head_sha=${head}&`));
  assert.equal(c.localRuns(), ran, 'no test run here');
  assert.equal(tipOf(r, 'main'), main);
  assert.equal(r.note(), null, 'no deploy');
  assert.equal(c.refs(), '', 'the scratch branch goes');
});

test('--full refuses on red CI, and when build/<n> moved since the merge, with the build untouched', () => {
  const r = setup();
  const c = ci(r);
  build(r);
  const bwt = worktree(r, 'ticket/9-build');
  takeMain(r, bwt);
  let res = c.run({ FAKE_CI: 'red' }, ['--into', 'build/3', '--full'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed .* in CI.*build\/3 is untouched/s);
  assert.equal(tipOf(r, 'build/3'), tipOf(r, 'main~1'));
  // A feeder merged in after the build minion took main: a rebase would flatten the merge, so it refuses instead.
  r.commit(r.wt, 'b.txt', 'mine\n');
  assert.equal(into(r, [OK]).status, 0);
  const before = tipOf(r, 'build/3');
  res = c.run({}, ['--into', 'build/3', '--full'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /build\/3 has commits this branch doesn't: run git merge build\/3/);
  assert.equal(tipOf(r, 'build/3'), before);
  assert.match(c.run({}, ['--into', 'build/3', '--full', OK], bwt).stderr, /--full runs the whole suite/);
});

test('--build lands the build by merging main: merge commits intact, feeder hashes unchanged, one deploy, branch deleted', () => {
  const r = setup();
  const c = ci(r);
  build(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  assert.equal(into(r, [OK]).status, 0);
  const feeder = tipOf(r, 'build/3');
  const bwt = worktree(r, 'ticket/9-build');
  takeMain(r, bwt);
  assert.equal(c.run({}, ['--into', 'build/3', '--full'], bwt).status, 0);
  r.commit(r.source, 'n.txt', 'main moved again\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ COORDINATOR_SHARED_DIR: shared }, ['--build'], bwt);
  assert.equal(res.status, 0, res.stderr);
  const head = git(bwt, 'rev-parse', 'HEAD');
  assert.equal(tipOf(r, 'main'), head, 'main is fast-forwarded to the merged build');
  assert.equal(git(r.source, 'merge-base', '--is-ancestor', feeder, 'main') || 'yes', 'yes', "the feeder's commit is on main under its own hash");
  assert.equal(git(r.source, 'rev-list', '--merges', '--count', 'main'), '2', "the build's merge of main and the land's are both there");
  assert.equal(git(bwt, 'log', '-1', '--format=%s'), "Merge branch 'main' into ticket/9-build");
  assert.equal(r.note(), 'locked=1 held=yes', 'deployed under the lock');
  assert.equal(has(r, 'refs/heads/build/3'), false, 'build/3 is deleted');
  assert.match(landLog(shared), /· timing · ticket\/9-build · lands build\/3 · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy \d+ · live \d+ · landed$/m);
});

test('--build refuses a merge conflict, and a branch not at a build tip, with main and the build untouched', () => {
  const r = setup();
  build(r);
  r.commit(r.wt, 'a.txt', 'mine\n');
  assert.equal(into(r, [OK]).status, 0);
  const bwt = worktree(r, 'ticket/9-build');
  r.commit(r.source, 'a.txt', 'theirs on main\n');
  const main = tipOf(r, 'main');
  const before = tipOf(r, 'build/3');
  let res = r.run({ LAND_SMOKE: '0' }, ['--build'], bwt); // the merge under the lock, which the smoke check would beat
  assert.equal(res.status, 1);
  assert.match(res.stderr, /merging main into build\/3 failed.*conflicted files: a\.txt/s);
  const early = r.run({}, ['--build'], bwt);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /won't merge main in .*by git merge-tree before the line.*conflicted files: a\.txt[^]*^land: smoke: it conflicts with main, before the line/m);
  assert.equal(tipOf(r, 'main'), main);
  assert.equal(tipOf(r, 'build/3'), before);
  assert.equal(git(bwt, 'rev-parse', 'HEAD'), before, 'the branch is as it was');
  assert.equal(git(bwt, 'status', '--porcelain'), '');
  assert.equal(r.note(), null);
  // Not at the build's tip: a feeder's branch, or a build minion that is behind.
  r.commit(bwt, 'x.txt', 'not folded\n');
  res = r.run({}, ['--build'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not at the tip of a build/);
  assert.equal(tipOf(r, 'main'), main);
});

test("a plain land refuses a branch that carries a build's commits, and one with no build lands as before", () => {
  const r = setup();
  build(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  assert.equal(into(r, [OK]).status, 0);
  const next = worktree(r, 'ticket/2-y');
  r.commit(next, 'c.txt', 'more\n');
  const main = tipOf(r, 'main');
  let res = r.run({}, [], next);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /carries commits of build\/3 that main doesn't have.*--into build\/3/s);
  assert.equal(tipOf(r, 'main'), main);
  assert.equal(r.note(), null);
  // A branch off main, beside an open build, lands exactly as before.
  const plain = worktree(r, 'ticket/4-z', 'main');
  r.commit(plain, 'd.txt', 'unrelated\n');
  res = r.run({}, [], plain);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(tipOf(r, 'main'), git(plain, 'rev-parse', 'HEAD'));
  assert.equal(r.note(), 'locked=1 held=yes');
});

test('two feeders merging into one build at once both get in, one after the other', async () => {
  const r = setup();
  build(r);
  r.commit(r.wt, 'b.txt', 'one\n');
  const other = worktree(r, 'ticket/2-y');
  r.commit(other, 'c.txt', 'two\n');
  const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') };
  const args = ['--into', 'build/3', OK];
  const [a, b] = await Promise.all([landAsync(r.wt, extra, 60_000, undefined, args), landAsync(other, extra, 60_000, undefined, args)]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(git(r.source, 'log', '--format=%s', 'build/3').split('\n').sort(), ['b.txt: one', 'base', 'c.txt: two']);
  assert.equal(r.note(), null);
});

test('a merge of main that changes land.sh hands --build over to the merged copy, which lands the build (#500)', () => {
  const r = setup();
  // The worktree runs its own tools/land.sh, as a minion does; main's newer one says it is the one running.
  for (const f of ['land.sh', 'citadel-heavy', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real land.sh');
  build(r);
  const bwt = worktree(r, 'ticket/9-build');
  r.commit(bwt, 'b.txt', 'in the build\n');
  git(r.source, 'branch', '-f', 'build/3', 'ticket/9-build');
  const script = join(r.source, 'tools', 'land.sh');
  writeFileSync(script, readFileSync(script, 'utf8').replace('say "running the tests"', 'say "running the tests (the merged land.sh)"'));
  git(r.source, 'commit', '-qam', 'newer land.sh');
  const res = spawnSync('bash', [join(bwt, 'tools', 'land.sh'), '--build'], { cwd: bwt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running the tests \(the merged land\.sh\)/);
  assert.equal(res.stderr.match(/merging main/g)?.length, 1, res.stderr);
  assert.equal(tipOf(r, 'main'), git(bwt, 'rev-parse', 'HEAD'));
  assert.equal(git(r.source, 'rev-list', '--merges', '--count', 'main'), '1');
  assert.equal(has(r, 'refs/heads/build/3'), false, 'the merged copy knew which build to delete');
  assert.equal(r.note(), 'locked=1 held=yes');
});

// A commit X that came off main (its restart was rolled back, tools/deploy-queue.sh taken_back) after the build minion
// had merged main in with X on it.
// `onIt`: a worktree that rebased onto main while X was there.
function takenBack(r: R, bwt: string, onIt?: string) {
  const before = tipOf(r, 'main');
  r.commit(r.source, 'x.txt', 'rolled back\n');
  const x = tipOf(r, 'main');
  if (onIt) git(onIt, 'rebase', '-q', 'main');
  git(bwt, 'merge', '--ff-only', 'build/3');
  git(bwt, 'merge', '-q', '--no-edit', 'main');
  assert.equal(r.run({}, ['--into', 'build/3', '--full'], bwt).status, 0);
  git(r.source, 'reset', '-q', '--keep', before);
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  writeFileSync(join(state, 'taken-back'), `${x} ticket/7-x\n`);
  return x;
}

test('--build refuses a build that carries a commit that came off main, and lands once that commit is reverted in it', () => {
  const r = setup();
  build(r);
  const bwt = worktree(r, 'ticket/9-build');
  const x = takenBack(r, bwt);
  r.commit(r.source, 'n.txt', 'main moved on\n');
  let res = r.run({}, ['--build'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`build/3 carries ${x.slice(0, 7)} .*came off main.*git revert --no-edit main\\.\\.${x.slice(0, 7)}`, 's'));
  // A long message under the revert (#646): the search for the revert stopped reading at its match, git log died of
  // SIGPIPE on what was left to write, and pipefail turned the match into "not reverted". Seen in CI as a flake.
  writeFileSync(join(r.dir, 'long-message'), `long\n\n${'a line of a long message\n'.repeat(20_000)}`);
  git(bwt, 'commit', '-q', '--allow-empty', '-F', join(r.dir, 'long-message'));
  git(bwt, 'revert', '--no-edit', `main..${x}`);
  assert.equal(r.run({}, ['--into', 'build/3', '--full'], bwt).status, 0);
  res = r.run({}, ['--build'], bwt);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(join(r.source, 'x.txt')), "what came off main isn't back on it");
  assert.equal(has(r, 'refs/heads/build/3'), false);
});

test('the guard lets through a plain branch whose only shared commit with a build came off main, and the land leaves it behind', () => {
  const r = setup();
  build(r);
  const bwt = worktree(r, 'ticket/9-build');
  const x = takenBack(r, bwt, r.wt);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /came off main when its deploy was rolled back: leaving it behind/);
  assert.ok(!existsSync(join(r.source, 'x.txt')));
  assert.equal(git(r.source, 'log', '--format=%s', 'main', '-2'), 'b.txt: mine\nbase');
  assert.notEqual(tipOf(r, 'main'), x);
});

test('a --build that stopped after merging main says how to go on', () => {
  const r = setup();
  const c = ci(r);
  build(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  assert.equal(into(r, [OK]).status, 0);
  const bwt = worktree(r, 'ticket/9-build');
  r.commit(r.source, 'm.txt', 'on main\n');
  assert.equal(c.run({ FAKE_CI: 'red' }, ['--build'], bwt).status, 1);
  const res = c.run({}, ['--build'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /one merge ahead of build\/3 .*run tools\/land\.sh --into build\/3 --full first/s);
  assert.equal(c.run({}, ['--into', 'build/3', '--full'], bwt).status, 0);
  assert.equal(c.run({}, ['--build'], bwt).status, 0);
  assert.equal(tipOf(r, 'main'), git(bwt, 'rev-parse', 'HEAD'));
});

// Build claims (#1159): build-claims.md on the build, the build minion's (#9) plan. #1 claims b.txt, #2 claims c.txt,
// hub.txt is shared. #2 merges first: c.txt, a line in hub.txt and u.txt, which nobody claimed.
function claimed(r: R) {
  build(r);
  const boss = worktree(r, 'ticket/9-build');
  r.commit(boss, 'hub.txt', 'top\n');
  writeFileSync(join(boss, 'build-claims.md'), '# Build 3\nbuild: #9\n#1: b.txt\n- #2: `c.txt`, `x.txt`\nshared: hub.txt\n');
  git(boss, 'add', '-A');
  git(boss, 'commit', '-qm', 'claims');
  git(r.source, 'branch', '-f', 'build/3', 'ticket/9-build');
  const two = worktree(r, 'ticket/2-y');
  writeFileSync(join(two, 'hub.txt'), 'top\nfrom two\n');
  writeFileSync(join(two, 'u.txt'), 'two took it\n');
  r.commit(two, 'c.txt', 'theirs\n');
  const res = into(r, [OK], {}, two);
  assert.equal(res.status, 0, res.stderr);
  git(r.wt, 'rebase', '-q', 'build/3');
  return { boss, two, before: tipOf(r, 'build/3') };
}

test("claims: a feeder that writes a file another feeder claimed is refused with the reason, and the build doesn't move", () => {
  const r = setup();
  const { before } = claimed(r);
  r.commit(r.wt, 'c.txt', 'mine now\n');
  const res = into(r, [OK]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ticket\/1-x writes outside its claim in build\/3's build-claims\.md, so nothing merged: c\.txt is #2's in the claims\. A late need goes through the build minion: ask #9/);
  assert.equal(tipOf(r, 'build/3'), before);
  // --check, as hand_off_land runs it, refuses the same way before the land starts, with the exit that stops a hand-off.
  const early = r.run({}, ['--check', '--into', 'build/3', OK]);
  assert.equal(early.status, 3);
  assert.match(early.stderr, /c\.txt is #2's in the claims/);
  // A feeder can't skip the check with --full, which is the build minion's.
  assert.match(r.run({}, ['--into', 'build/3', '--full']).stderr, /--full is the build minion's \(#9\): a feeder merges in with tools\/land\.sh --into build\/3/);
  // The list mark, backticks and comma in "- #2: `c.txt`, `x.txt`" still claim x.txt for #2.
  r.commit(r.wt, 'x.txt', 'mine as well\n');
  assert.match(into(r, [OK]).stderr, /c\.txt is #2's in the claims; x\.txt is #2's in the claims\./);
});

test('claims: its own and unclaimed new files merge in; one another feeder already merged in, or the claims file, do not', () => {
  const r = setup();
  claimed(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.wt, 'new.txt', 'nobody had it\n');
  let res = into(r, [OK]);
  assert.equal(res.status, 0, res.stderr);
  r.commit(r.wt, 'u.txt', 'mine too\n');
  r.commit(r.wt, 'build-claims.md', '#1: b.txt c.txt\n');
  const before = tipOf(r, 'build/3');
  res = into(r, [OK]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /build-claims\.md is the build minion's plan, so only it changes a claim; u\.txt is unclaimed, but #2 merged it in first, so it is #2's\./);
  assert.equal(tipOf(r, 'build/3'), before);
});

test("claims: a shared file takes added lines, not changes to lines another feeder merged in; the build minion isn't checked", () => {
  const r = setup();
  const { boss } = claimed(r);
  writeFileSync(join(r.wt, 'hub.txt'), 'top\nfrom one\nfrom two\n');
  git(r.wt, 'commit', '-qam', 'hub: add');
  let res = into(r, [OK]);
  assert.equal(res.status, 0, res.stderr);
  writeFileSync(join(r.wt, 'hub.txt'), 'top\nfrom one\nfrom two, edited by one\n');
  git(r.wt, 'commit', '-qam', 'hub: edit');
  const before = tipOf(r, 'build/3');
  res = into(r, [OK]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /hub\.txt \(shared\) changes or removes lines #2 merged in \(line 3\): only add to a shared file/);
  assert.equal(tipOf(r, 'build/3'), before);
  // The build minion edits anything, the claims included.
  git(boss, 'merge', '-q', '--ff-only', 'build/3');
  r.commit(boss, 'c.txt', 'the build minion fixed it\n');
  res = into(r, [OK], {}, boss);
  assert.equal(res.status, 0, res.stderr);
});

test("claims: a feeder that hands off while the build minion's claims merge waits is checked against the new claims (#1864, as #1684)", async () => {
  const r = setup();
  const { boss } = claimed(r);
  git(boss, 'reset', '-q', '--hard', 'build/3');
  r.commit(r.wt, 'x.txt', 'one needs it\n'); // #2's under the claims on the build
  const e = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), TEST_RUNS: join(r.dir, 'test-runs') };
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  const marks = () => readdirSync(state).filter((f) => f.startsWith('build-3.claims.'));
  // Something else holds the build's lock, so the claims merge (x.txt moves to #1) waits on it, in flight.
  const held = join(r.dir, 'held');
  const release = join(r.dir, 'release');
  const holder = spawn('bash', ['-c', `exec 6>"${state}/build-3.lock"; flock 6; touch "${held}"; until [ -e "${release}" ]; do sleep 0.05; done`]);
  const gone = new Promise((ok) => holder.on('close', ok));
  try {
    await until('the lock is held', () => existsSync(held));
    r.commit(boss, 'build-claims.md', '# Build 3\nbuild: #9\n#1: b.txt x.txt\n#2: c.txt\nshared: hub.txt\n');
    let said = '';
    const claims = landAsync(boss, e, 60_000, (s) => (said = s), ['--into', 'build/3']);
    await until(
      'the claims merge is in flight',
      () => marks().length > 0,
      30_000,
      () => said,
    );
    const early = r.run({}, ['--check', '--into', 'build/3', OK]);
    assert.equal(early.status, 0, `the hand-off goes ahead: ${early.stderr}`);
    assert.match(early.stderr, /claims merge in flight on build\/3/);
    let feeder = '';
    const merge = landAsync(r.wt, e, 60_000, (s) => (feeder = s), ['--into', 'build/3', OK]);
    await until(
      'the feeder waits',
      () => /claims merge in flight on build\/3 .*waiting/.test(feeder),
      30_000,
      () => feeder,
    );
    writeFileSync(release, '');
    const [c, m] = await Promise.all([claims, merge]);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(m.status, 0, m.stderr);
    assert.equal(git(r.source, 'log', '--format=%s', 'build/3', '-1'), 'x.txt: one needs it', 'the feeder went on top of the new claims');
    assert.deepEqual(marks(), [], 'the claims merge cleared its mark');
  } finally {
    writeFileSync(release, '');
    await gone;
  }
});

test("claims: a claims merge's mark survives a feeder that clears dead marks while it is written", () => {
  const r = setup();
  const { boss } = claimed(r);
  git(boss, 'reset', '-q', '--hard', 'build/3');
  r.commit(boss, 'build-claims.md', '# Build 3\nbuild: #9\n#1: b.txt x.txt\n#2: c.txt\nshared: hub.txt\n');
  // A feeder's claims_inflight runs just before the mark moves into place: what its glob finds then goes.
  const bin = join(r.dir, 'race-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'mv'), '#!/bin/bash\nto=${!#}\ncase "$to" in *.claims.*) rm -f "${to%.*}".* ;; esac\nexec /usr/bin/mv "$@"\n', { mode: 0o755 });
  const res = into(r, [], { PATH: `${bin}:${process.env.PATH}` }, boss);
  assert.equal(res.status, 0, res.stderr);
});

test('claims: --build refuses while build-claims.md is on the build, so it never ships to main', () => {
  const r = setup();
  const { boss } = claimed(r);
  git(boss, 'merge', '-q', '--ff-only', 'build/3');
  const res = r.run({}, ['--build'], boss);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /build-claims\.md, the build's claims, is still on ticket\/9-build and would ship to main: git rm it/);
});
