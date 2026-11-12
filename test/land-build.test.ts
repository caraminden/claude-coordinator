// tools/land.sh with build branches (specs/build-branches.md, #593): a feeder merges into build/<n> with --into, the
// build minion takes main in with --into build/<n> --full and lands the build with --build, and a plain land refuses
// a branch that carries a build's commits.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { git, setup, ci, env, landAsync } from './land-fixture.ts';

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
  let res = r.run({}, ['--build'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /merging main into build\/3 failed.*conflicted files: a\.txt/s);
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
  for (const f of ['land.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
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
  git(bwt, 'revert', '--no-edit', `main..${x}`);
  assert.equal(r.run({}, ['--into', 'build/3', '--full'], bwt).status, 0);
  res = r.run({}, ['--build'], bwt);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(join(r.source, 'x.txt')), "what came off main isn't back on it");
  assert.equal(has(r, 'refs/heads/build/3'), false);
});

test("the guard lets through a plain branch whose only shared commit with a build came off main, and the land leaves it behind", () => {
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
