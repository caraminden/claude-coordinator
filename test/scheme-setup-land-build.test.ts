// The scheme-setup template land.sh: build branches (--into build/<n> <files>, --into build/<n> --full, --build
// and the plain land's guard), each on a throwaway scheme repo. Citadel's own tools/land.sh: land-build.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, queueSetup } from './scheme-setup-land-fixture.ts';

// Three worktrees off main: two feeders (f1.txt, f2.txt) and the build minion's (f3.txt), and build/1 made at main
// the way a build minion makes it. CHECK_FILE_CMD logs each test file a feeder's check ran to $RAN.
function buildSetup(config: Record<string, string> = {}) {
  const q = queueSetup(3, 'test ! -e red', { CHECK_FILE_CMD: 'echo {file} >>"$RAN"; test ! -e red', ...config });
  git(q.main, 'branch', 'build/1', 'main');
  const ran = join(q.dir, 'ran');
  writeFileSync(ran, '');
  const run = (i: number, ...args: string[]) =>
    spawnSync('bash', [join(q.wts[i - 1], 'tools', 'land.sh'), ...args], { cwd: q.wts[i - 1], encoding: 'utf8', timeout: 90_000, env: { ...env, RAN: ran, LAND_CI_POLL: '0', LAND_CI_GRACE: '0' } });
  const at = (ref: string, where = q.main) => git(where, 'rev-parse', '-q', '--verify', ref);
  const has = (ref: string, where = q.main) => spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: where }).status === 0;
  const ranFiles = () => readFileSync(ran, 'utf8').split('\n').filter(Boolean);
  return { ...q, run, at, has, ranFiles };
}

test('--into: a feeder rebases onto the build, runs only its test files, and moves the build; main is untouched', () => {
  const b = buildSetup();
  const main = b.at('main');
  const one = b.run(2, '--into', 'build/1', 'f2.txt');
  assert.equal(one.status, 0, one.stderr);
  assert.equal(b.at('build/1'), b.at('ticket/2-x'), 'the build is at the feeder');
  const two = b.run(1, '--into', 'build/1', 'f1.txt');
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stderr, /rebasing ticket\/1-x onto build\/1/);
  assert.match(two.stderr, /build\/1 is now at/);
  assert.equal(git(b.main, 'log', '--format=%s', 'build/1'), 'f1.txt: 1\nf2.txt: 2\nbase', 'feeder 1 went on top of feeder 2');
  assert.deepEqual(b.ranFiles(), ['f2.txt', 'f1.txt'], 'each feeder ran only the test file it named');
  assert.equal(b.at('main'), main, 'main never moved');
  assert.equal(b.at('main', b.origin), main, 'nor origin');
  assert.equal(b.has('refs/heads/build/1', b.origin), false, 'the build stays off origin');
});

test('--into: a red check leaves the build untouched and the feeder keeps its rebased work', () => {
  const b = buildSetup();
  assert.equal(b.run(2, '--into', 'build/1', 'f2.txt').status, 0);
  const build = b.at('build/1');
  b.commit(b.wts[0], 'red', 'x\n');
  const res = b.run(1, '--into', 'build/1', 'f1.txt');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the check failed on the rebased branch .* so build\/1 is untouched/);
  assert.equal(b.at('build/1'), build);
  assert.equal(git(b.wts[0], 'rev-parse', 'HEAD^^'), build, 'ticket/1-x sits on the build now');
});

test('--into refuses a build that does not exist, a file that is not there, and a run from a build branch', () => {
  const b = buildSetup();
  assert.match(b.run(1, '--into', 'build/2', 'f1.txt').stderr, /build\/2 doesn't exist: its build minion makes it/);
  assert.match(b.run(1, '--into', 'build/1', 'nope.ts').stderr, /nope\.ts is not a file/);
  assert.match(b.run(1, '--into', 'main', 'f1.txt').stderr, /--into takes a build branch, build\/<n>/);
  assert.match(b.run(1, '--into', 'build/1', '--full', 'f1.txt').stderr, /name no test files with it/);
  assert.match(b.run(1, '--build', 'x').stderr, /--build takes nothing more/);
  assert.equal(b.at('build/1'), b.at('main'), 'nothing moved');
});

test('--check --into: a conflict with the build exits 3, and one with main alone does not count', () => {
  const b = buildSetup();
  b.commit(b.wts[1], 'shared.txt', 'two\n');
  assert.equal(b.run(2, '--into', 'build/1', 'f2.txt').status, 0);
  b.commit(b.wts[0], 'shared.txt', 'one\n');
  const res = b.run(1, '--check', '--into', 'build/1', 'f1.txt');
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /won't rebase onto build\/1 .*conflicted files: shared\.txt.*git rebase build\/1/);
  b.commit(b.main, 'f3.txt', 'main\n'); // feeder 3 clashes with main, not the build
  assert.equal(b.run(3, '--check', '--into', 'build/1', 'f3.txt').status, 0);
});

test('the guard: a plain land of a branch on the build\'s commits is refused; one off main still lands', () => {
  const b = buildSetup();
  assert.equal(b.run(1, '--into', 'build/1', 'f1.txt').status, 0);
  const main = b.at('main');
  const res = b.run(1);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /carries commits of build\/1 that main doesn't have.*tools\/land\.sh --into build\/1/);
  assert.equal(b.at('main'), main);
  const plain = b.run(2);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(git(b.main, 'log', '-1', '--format=%s', 'main'), 'f2.txt: 2');
});

test('--into --full: refuses a build the branch lacks (merge, not rebase), then the full check moves it', () => {
  const b = buildSetup({ CHECK: 'echo full >>"$RAN"; test ! -e red' });
  assert.equal(b.run(1, '--into', 'build/1', 'f1.txt').status, 0);
  const behind = b.run(3, '--into', 'build/1', '--full');
  assert.equal(behind.status, 1);
  assert.match(behind.stderr, /build\/1 has commits ticket\/3-x doesn't: run git merge build\/1 \(not a rebase\)/);
  git(b.wts[2], 'merge', '-q', '--no-edit', 'build/1');
  const head = git(b.wts[2], 'rev-parse', 'HEAD');
  const res = b.run(3, '--into', 'build/1', '--full');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(b.at('build/1'), head, 'the build is at the build minion\'s merge, not rebased');
  assert.deepEqual(b.ranFiles(), ['f1.txt', 'full'], 'the full check ran, not the files');
});

test('--into --full: a red full check, or red CI, leaves the build untouched', () => {
  const red = buildSetup();
  git(red.wts[2], 'merge', '-q', '--no-edit', 'build/1');
  red.commit(red.wts[2], 'red', 'x\n');
  const res = red.run(3, '--into', 'build/1', '--full');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the full check or CI is red on ticket\/3-x/);
  assert.equal(red.at('build/1'), red.at('main'));

  const ci = buildSetup({ CI_STATUS: 'false' });
  const ciRes = ci.run(3, '--into', 'build/1', '--full');
  assert.equal(ciRes.status, 1);
  assert.match(ciRes.stderr, /the full check or CI is red/);
  assert.equal(ci.at('build/1'), ci.at('main'));
  const green = buildSetup({ CI_STATUS: 'true' });
  assert.equal(green.run(3, '--into', 'build/1', '--full').status, 0);
  assert.equal(green.at('build/1'), git(green.wts[2], 'rev-parse', 'HEAD'));
});

test('--build: main comes in by merge, the build ships through the gate, and build/<n> goes here and on origin', () => {
  const b = buildSetup();
  assert.equal(b.run(1, '--into', 'build/1', 'f1.txt').status, 0);
  git(b.wts[2], 'merge', '-q', '--no-edit', 'build/1'); // the build minion's own work, then the build merged in
  assert.equal(b.run(3, '--into', 'build/1', '--full').status, 0);
  git(b.main, 'push', '-q', '--no-verify', 'origin', 'build/1');
  b.commit(b.main, 'c.txt', 'someone else\n'); // main moved on while the build was open
  const res = b.run(3, '--build');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /merging main \(\w+ "c\.txt: someone else"\) into build\/1/);
  assert.equal(git(b.main, 'log', '-1', '--format=%s', 'main'), 'Merge main into build/1');
  assert.match(res.stderr, /deleted build\/1, which is on main now/);
  const tip = b.at('main');
  assert.equal(git(b.main, 'rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3, 'main got a merge, not a rebase');
  assert.deepEqual(git(b.main, 'log', '--format=%s', 'main').split('\n').filter((s) => /^(f|c)\d?/.test(s)).sort(), ['c.txt: someone else', 'f1.txt: 1', 'f3.txt: 3']);
  assert.equal(b.at('main', b.origin), tip, 'pushed');
  assert.equal(b.has('refs/heads/build/1'), false, 'deleted here');
  assert.equal(b.has('refs/heads/build/1', b.origin), false, 'and on origin');
});

test('--build refuses a branch not at a build\'s tip, and one a merge of main ahead of it', () => {
  const b = buildSetup();
  const main = b.at('main');
  assert.match(b.run(3, '--build').stderr, /ticket\/3-x is not at the tip of a build branch/);
  assert.equal(b.run(3, '--check', '--build').status, 0, '--check leaves that refusal to the land');
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.main, 'c.txt', 'someone else\n');
  git(b.wts[2], 'merge', '-q', '--no-ff', '--no-edit', 'main');
  assert.match(b.run(3, '--build').stderr, /ticket\/3-x is one merge ahead of build\/1 .*--into build\/1 --full first/);
  assert.notEqual(b.at('main'), main, 'main has only its own commit');
  assert.equal(git(b.main, 'log', '-1', '--format=%s', 'main'), 'c.txt: someone else');
  assert.equal(b.has('refs/heads/build/1'), true);
});
