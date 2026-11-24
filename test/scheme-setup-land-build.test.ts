// The scheme-setup template land.sh: build branches (--into build/<n> <files>, --into build/<n> --full, --build
// and the plain land's guard), each on a throwaway scheme repo. Citadel's own tools/land.sh: land-build.test.ts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, queueSetup, rebasedCalls, rebasedHook, until } from './scheme-setup-land-fixture.ts';

// Three worktrees off main: two feeders (f1.txt, f2.txt) and the build minion's (f3.txt), and build/1 made at main
// the way a build minion makes it. CHECK_FILE_CMD logs each test file a feeder's check ran to $RAN.
function buildSetup(config: Record<string, string> = {}, local?: string) {
  const q = queueSetup(3, 'test ! -e red', { CHECK_FILE_CMD: 'echo {file} >>"$RAN"; test ! -e red', ...config }, undefined, local);
  git(q.main, 'branch', 'build/1', 'main');
  const ran = join(q.dir, 'ran');
  writeFileSync(ran, '');
  const run = (i: number, ...args: string[]) => spawnSync('bash', [join(q.wts[i - 1], 'tools', 'land.sh'), ...args], { cwd: q.wts[i - 1], encoding: 'utf8', timeout: 90_000, env: { ...env, RAN: ran, LAND_CI_POLL: '0', LAND_CI_GRACE: '0' } });
  const at = (ref: string, where = q.main) => git(where, 'rev-parse', '-q', '--verify', ref);
  const has = (ref: string, where = q.main) => spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: where }).status === 0;
  const ranFiles = () => readFileSync(ran, 'utf8').split('\n').filter(Boolean);
  // Started and left running, for the runs that wait on each other.
  const start = (i: number, ...args: string[]) => {
    const child = spawn('bash', [join(q.wts[i - 1], 'tools', 'land.sh'), ...args], { cwd: q.wts[i - 1], stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, RAN: ran, LAND_QUEUE_POLL: '0.05' } });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    const exit = new Promise<number | null>((ok) => child.on('close', ok));
    return { exit, stderr: () => stderr };
  };
  return { ...q, run, at, has, ranFiles, start };
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

test("the guard: a plain land of a branch on the build's commits is refused; one off main still lands", () => {
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
  assert.equal(b.at('build/1'), head, "the build is at the build minion's merge, not rebased");
  assert.deepEqual(b.ranFiles(), ['f1.txt', 'full'], 'the full check ran, not the files');
});

// KT5 (#1519): a commit made in the worktree while the check runs was never checked, so the build moves to the commit
// that was (Citadel's own land.sh reads its tip before the check too).
test('--into and --full move the build to the commit the check ran on, not one made during it', () => {
  const during = 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m during';
  const b = buildSetup({ CHECK_FILE_CMD: `echo {file} >>"$RAN"; ${during}`, CHECK: `echo full >>"$RAN"; ${during}` });
  const res = b.run(1, '--into', 'build/1', 'f1.txt');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(b.wts[0], 'log', '-1', '--format=%s'), 'during', 'the check made a commit');
  assert.equal(b.at('build/1'), b.at('ticket/1-x^'), 'the build is at the checked commit, under the one made during the check');
  git(b.wts[2], 'merge', '-q', '--no-edit', 'build/1');
  const merged = git(b.wts[2], 'rev-parse', 'HEAD');
  const full = b.run(3, '--into', 'build/1', '--full');
  assert.equal(full.status, 0, full.stderr);
  assert.equal(b.at('build/1'), merged, "--full: the build is at the build minion's checked merge");
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
  assert.deepEqual(
    git(b.main, 'log', '--format=%s', 'main')
      .split('\n')
      .filter((s) => /^(f|c)\d?/.test(s))
      .sort(),
    ['c.txt: someone else', 'f1.txt: 1', 'f3.txt: 3'],
  );
  assert.equal(b.at('main', b.origin), tip, 'pushed');
  assert.equal(b.has('refs/heads/build/1'), false, 'deleted here');
  assert.equal(b.has('refs/heads/build/1', b.origin), false, 'and on origin');
});

// #1698: a build holds feeders' commits and the build minion's, some "#N: ..." and some not, and rewording them rewrites the
// feeders' hashes, so --build skips the lost-title check that a plain ship keeps.
test('--build ships a build whose commits mix "#N:" and plain titles; a plain ship with a lost title is still refused', () => {
  const b = buildSetup();
  writeFileSync(join(b.wts[0], 'f1.txt'), 'x\n');
  git(b.wts[0], 'add', '-A');
  git(b.wts[0], 'commit', '-qm', '#1: feeder');
  assert.equal(b.run(1, '--into', 'build/1', 'f1.txt').status, 0);
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[2], 'f3.txt', '3\n'); // "f3.txt: 3": no "#N" while a sibling has one
  assert.equal(b.run(3, '--into', 'build/1', '--full').status, 0);
  const res = b.run(3, '--build');
  assert.doesNotMatch(res.stderr, /lost its #N: title/);
  assert.equal(res.status, 0, res.stderr);
  const plain = buildSetup();
  writeFileSync(join(plain.wts[0], 'g.txt'), 'x\n');
  git(plain.wts[0], 'add', '-A');
  git(plain.wts[0], 'commit', '-qm', '#1: a');
  plain.commit(plain.wts[0], 'h.txt', 'y\n');
  assert.match(plain.run(1).stderr, /lost its #N: title/);
});

test("--build refuses a branch not at a build's tip, and one a merge of main ahead of it", () => {
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

test('--check --into --full exits 0 on a build that moved: the land itself says to merge, never to rebase', () => {
  const b = buildSetup();
  b.commit(b.wts[1], 'shared.txt', 'two\n');
  assert.equal(b.run(2, '--into', 'build/1', 'f2.txt').status, 0);
  b.commit(b.wts[2], 'shared.txt', 'three\n');
  const res = b.run(3, '--check', '--into', 'build/1', '--full');
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /git rebase/);
});

test('--build after a landing killed mid-way: the worktree goes back on its branch and the build ships', () => {
  const b = buildSetup();
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[2], 'f3.txt', '3\n');
  assert.equal(b.run(3, '--into', 'build/1', '--full').status, 0);
  b.commit(b.main, 'c.txt', 'someone else\n');
  // Where a --build killed after its merge leaves things: detached on the merge, the branch named in land-branch.
  const at = git(b.wts[2], 'rev-parse', 'HEAD');
  git(b.wts[2], 'checkout', '-q', '--detach');
  git(b.wts[2], 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(git(b.wts[2], 'rev-parse', '--absolute-git-dir'), 'land-branch'), `ticket/3-x\n${git(b.wts[2], 'rev-parse', 'HEAD')}\n`);
  const res = b.run(3, '--build');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /is back on ticket\/3-x as it was/);
  assert.equal(git(b.main, 'rev-parse', 'main^1'), at, 'main is the build with main merged in');
  assert.equal(b.has('refs/heads/build/1'), false);
});

test("claims (#1159): a feeder that writes another feeder's claimed file is refused, at --check too; --build refuses while the claims are on the build", () => {
  const b = buildSetup();
  // The build minion (#3) puts its plan on the build: #1 writes f1.txt, #2 writes f2.txt and f3.txt.
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt\n#2: f2.txt f3.txt\n');
  git(b.main, 'branch', '-f', 'build/1', 'ticket/3-x');
  assert.equal(b.run(2, '--into', 'build/1', 'f2.txt').status, 0);
  b.commit(b.wts[0], 'f2.txt', 'one wrote it\n');
  const build = b.at('build/1');
  const why = /ticket\/1-x writes outside its claim in build\/1's build-claims\.md, so nothing merged: f2\.txt is #2's in the claims\. A late need goes through the build minion: ask #3/;
  const early = b.run(1, '--check', '--into', 'build/1', 'f1.txt');
  assert.equal(early.status, 3, 'the exit that stops a hand-off');
  assert.match(early.stderr, why);
  const res = b.run(1, '--into', 'build/1', 'f1.txt');
  assert.equal(res.status, 1);
  assert.match(res.stderr, why);
  assert.equal(b.at('build/1'), build, 'the build did not move');
  // "Claimed: ask": #1 needs f3.txt instead, so the build minion moves that claim and merges the claims in (docs
  // only); then #1's merge passes.
  git(b.wts[0], 'reset', '-q', '--hard', 'HEAD~1');
  b.commit(b.wts[0], 'f3.txt', 'one needs it\n');
  assert.match(b.run(1, '--into', 'build/1', 'f1.txt').stderr, /f3\.txt is #2's in the claims/);
  git(b.wts[2], 'merge', '-q', '--ff-only', 'build/1');
  b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt f3.txt\n#2: f2.txt\n');
  assert.equal(b.run(3, '--into', 'build/1').status, 0);
  git(b.wts[0], 'rebase', '-q', 'build/1');
  const moved = b.run(1, '--into', 'build/1', 'f1.txt');
  assert.equal(moved.status, 0, moved.stderr);
  git(b.wts[2], 'merge', '-q', '--ff-only', 'build/1');
  assert.match(b.run(3, '--build').stderr, /build-claims\.md, the build's claims, is still on ticket\/3-x and would ship to main: git rm it/);
});

test("claims (#1159): the template and Citadel's land.sh carry the same claims_check, so the rules tested on Citadel's hold here", () => {
  const fn = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').match(/^claims_check\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  const kit = fn('kit/skills/scheme-setup/templates/land.sh');
  assert.ok(kit);
  assert.equal(kit, fn('tools/land.sh'));
});

test("land_rebased runs in a feeder's --into, and its commit goes into the build; --into --full and --build never call it", () => {
  const b = buildSetup({}, rebasedHook);
  const build = b.at('build/1');
  assert.equal(b.run(2, '--into', 'build/1', 'f2.txt').status, 0);
  assert.deepEqual(rebasedCalls(b.main), [`${build} ticket/2-x`]);
  assert.equal(git(b.main, 'log', '-1', '--format=%s', 'build/1'), `rebased on ${build}`, 'its commit is in the build');
  git(b.wts[2], 'merge', '-q', '--no-edit', 'build/1'); // the build minion takes the build in, as it does
  const full = b.run(3, '--into', 'build/1', '--full');
  assert.equal(full.status, 0, full.stderr);
  const shipped = b.run(3, '--build');
  assert.equal(shipped.status, 0, shipped.stderr);
  assert.deepEqual(rebasedCalls(b.main), [`${build} ticket/2-x`], 'only the feeder called it');
});

// #1684 (Peek's Build 4): the build minion changed build-claims.md 8 times, and each docs-only merge ran the whole
// light check (about 30 min) while late feeders waited on the build's lock.
test('--into: a merge of only build-claims.md, or of only light paths, runs no check; a code change still does', () => {
  const b = buildSetup({ CHECK: 'echo check >>"$RAN"', LANES: 'tools/lanes' });
  b.commit(b.main, 'tools/lanes', 'light docs/*\n');
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt docs/\n');
  const claims = b.run(3, '--into', 'build/1');
  assert.equal(claims.status, 0, claims.stderr);
  assert.match(claims.stderr, /changes only light paths \(build-claims\.md\), so no check ran/);
  assert.equal(b.at('build/1'), b.at('ticket/3-x'), 'the claims are on the build');
  assert.deepEqual(b.ranFiles(), [], 'no check ran');
  git(b.wts[0], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[0], 'docs/a.md', 'docs\n');
  const docs = b.run(1, '--into', 'build/1');
  assert.equal(docs.status, 0, docs.stderr);
  assert.match(docs.stderr, /changes only light paths \(docs\/a\.md\), so no check ran/);
  assert.deepEqual(b.ranFiles(), []);
  // The build minion's claims and a doc in one merge: still light.
  git(b.wts[2], 'merge', '-q', '--ff-only', 'build/1');
  b.commit(b.wts[2], 'docs/retro.md', 'retro\n');
  b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt docs/ f3.txt\n');
  const both = b.run(3, '--into', 'build/1');
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stderr, /changes only light paths \(docs\/retro\.md\), so no check ran/);
  assert.deepEqual(b.ranFiles(), []);
  // A test file named runs, light paths or not.
  git(b.wts[0], 'rebase', '-q', 'build/1');
  b.commit(b.wts[0], 'docs/b.md', 'docs\n');
  const named = b.run(1, '--into', 'build/1', 'docs/b.md');
  assert.equal(named.status, 0, named.stderr);
  assert.doesNotMatch(named.stderr, /no check ran/);
  assert.deepEqual(b.ranFiles(), ['docs/b.md'], 'a named test file still runs');
  b.commit(b.wts[0], 'f1.txt', 'code\n');
  const code = b.run(1, '--into', 'build/1', 'f1.txt');
  assert.equal(code.status, 0, code.stderr);
  assert.doesNotMatch(code.stderr, /no check ran/);
  assert.deepEqual(b.ranFiles(), ['docs/b.md', 'f1.txt'], "a feeder's code change still runs its check");
});

test('--into: with no lanes map, only a build-claims.md-only merge skips the check; docs still run it', () => {
  const b = buildSetup({ CHECK: 'echo check >>"$RAN"' });
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt docs/\n');
  const claims = b.run(3, '--into', 'build/1');
  assert.equal(claims.status, 0, claims.stderr);
  assert.deepEqual(b.ranFiles(), [], claims.stderr);
  b.commit(b.wts[2], 'docs/a.md', 'docs\n');
  const docs = b.run(3, '--into', 'build/1');
  assert.equal(docs.status, 0, docs.stderr);
  assert.deepEqual(b.ranFiles(), ['check'], 'docs are full without a map saying otherwise');
});

test("--into: a feeder that hands off while the build minion's claims merge is in flight waits for it, then goes ahead under the new claims", async () => {
  const b = buildSetup();
  git(b.wts[2], 'reset', '-q', '--hard', 'build/1');
  b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt\n#2: f2.txt f3.txt\n');
  git(b.main, 'branch', '-f', 'build/1', 'ticket/3-x');
  b.commit(b.wts[0], 'f3.txt', 'one needs it\n'); // #2's under the claims on the build
  // Something else holds the build's lock, so the claims merge (f3.txt moves to #1) waits on it, in flight.
  const lock = join(b.state, 'land-build-1.lock');
  const release = join(b.dir, 'release');
  const holder = spawn('bash', ['-c', `exec 6>"${lock}"; flock 6; touch "${lock}.held"; until [ -e "${release}" ]; do sleep 0.05; done`]);
  const held = new Promise((ok) => holder.on('close', ok));
  try {
    await until('the lock is held', () => readdirSync(b.state).includes('land-build-1.lock.held'));
    b.commit(b.wts[2], 'build-claims.md', 'build: #3\n#1: f1.txt f3.txt\n#2: f2.txt\n');
    const claims = b.start(3, '--into', 'build/1');
    await until('the claims merge is in flight', () => readdirSync(b.state).some((f) => f.startsWith('land-build-1.claims.')), 30_000, claims.stderr);
    const early = b.run(1, '--check', '--into', 'build/1', 'f1.txt');
    assert.equal(early.status, 0, `the hand-off goes ahead: ${early.stderr}`);
    assert.match(early.stderr, /claims merge in flight on build\/1/);
    const feeder = b.start(1, '--into', 'build/1', 'f1.txt');
    await until('the feeder waits', () => /claims merge in flight on build\/1 .*waiting/.test(feeder.stderr()), 30_000, feeder.stderr);
    writeFileSync(release, '');
    assert.equal(await claims.exit, 0, claims.stderr());
    assert.equal(await feeder.exit, 0, feeder.stderr());
    assert.equal(git(b.main, 'log', '--format=%s', 'build/1', '-3'), 'f3.txt: one needs it\nf1.txt: 1\nbuild-claims.md: build: #3 #1: f1.txt f3.txt #2: f2.txt', 'the feeder went on top of the new claims');
    assert.equal(readdirSync(b.state).filter((f) => f.startsWith('land-build-1.claims.')).length, 0, 'the claims merge cleared its mark');
  } finally {
    writeFileSync(release, '');
    await held;
  }
});

// BUILD_WORKFLOWS (#1683): a build's --full also waits for the scheme's build workflows (Peek's desktop.yml), read by the
// built-in reader even beside CI_STATUS. A gh first in PATH answers the runs list from runs.tsv and, on a dispatch,
// puts dispatched.tsv's line at its top, so the dispatched run is the newest. A `blip` file fails the next dispatch with a
// 502, and a later.tsv replaces runs.tsv on the fourth runs read.
function buildCi(config: Record<string, string>, dispatched = '') {
  const b = buildSetup({ CI_STATUS: 'true', ...config });
  const ci = join(b.dir, 'ci');
  const bin = join(b.dir, 'bin');
  mkdirSync(ci);
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/bash\necho "$*" >>"$CI_DIR/gh.log"\ncase "$*" in *dispatches*) [ ! -e "$CI_DIR/blip" ] || { rm "$CI_DIR/blip"; echo "HTTP 502: Bad Gateway" >&2; exit 1; }; [ ! -e "$CI_DIR/refuse" ] || { echo "HTTP 422: no workflow_dispatch trigger" >&2; exit 1; }; cat "$CI_DIR/dispatched.tsv" "$CI_DIR/runs.tsv" >"$CI_DIR/r" 2>/dev/null; mv "$CI_DIR/r" "$CI_DIR/runs.tsv" ;; *head_sha=*) echo >>"$CI_DIR/reads"; [ ! -e "$CI_DIR/later.tsv" ] || [ "$(wc -l <"$CI_DIR/reads")" -lt 4 ] || mv "$CI_DIR/later.tsv" "$CI_DIR/runs.tsv"; cat "$CI_DIR/runs.tsv" 2>/dev/null ;; *skipped*) echo 0 ;; */jobs*) echo "1 1" ;; esac\nexit 0\n',
    { mode: 0o755 },
  );
  writeFileSync(join(ci, 'dispatched.tsv'), dispatched ? `.github/workflows/${dispatched}\t7\tcompleted\t${dispatched.endsWith(' red') ? 'failure' : 'success'}\thttps://x/7\n`.replace(/ (red|green)\t/, '\t') : '');
  const full = (more: Record<string, string> = {}) =>
    spawnSync('bash', [join(b.wts[2], 'tools', 'land.sh'), '--into', 'build/1', '--full'], { cwd: b.wts[2], encoding: 'utf8', timeout: 90_000, env: { ...env, RAN: join(b.dir, 'ran'), CI_DIR: ci, PATH: `${bin}:${env.PATH}`, LAND_CI_POLL: '0', LAND_CI_GRACE: '0', ...more } });
  const ghLog = () => (existsSync(join(ci, 'gh.log')) ? readFileSync(join(ci, 'gh.log'), 'utf8') : '');
  return { ...b, full, ghLog };
}

test('BUILD_WORKFLOWS: --full dispatches a build workflow with no run on its commit and waits for it; a red one leaves the build untouched', () => {
  const red = buildCi({ BUILD_WORKFLOWS: 'desktop.yml' }, 'desktop.yml red');
  const res = red.full();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /desktop\.yml: completed failure/);
  assert.match(res.stderr, /the full check or CI is red on ticket\/3-x/);
  assert.match(red.ghLog(), /actions\/workflows\/desktop\.yml\/dispatches -f ref=land\/ticket\/3-x/);
  assert.equal(red.at('build/1'), red.at('main'));

  // One GitHub won't dispatch (no workflow_dispatch trigger) is red at once, with GitHub's reason, not a wait for a runner.
  const refused = buildCi({ BUILD_WORKFLOWS: 'desktop.yml' });
  writeFileSync(join(refused.dir, 'ci', 'refuse'), '');
  const no = refused.full();
  assert.equal(no.status, 1, no.stderr);
  assert.match(no.stderr, /desktop\.yml: couldn't dispatch it on land\/ticket\/3-x .*HTTP 422: no workflow_dispatch trigger/);
  assert.equal(refused.at('build/1'), refused.at('main'));

  const green = buildCi({ BUILD_WORKFLOWS: 'desktop.yml' }, 'desktop.yml green');
  const ok = green.full();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(green.at('build/1'), git(green.wts[2], 'rev-parse', 'HEAD'));
  assert.equal(green.ghLog().match(/dispatches/g)?.length, 1, 'dispatched once');

  // GitHub giving no answer (a 5xx, a timeout) is not a refusal: the dispatch is tried again on the next poll.
  const blip = buildCi({ BUILD_WORKFLOWS: 'desktop.yml' }, 'desktop.yml green');
  writeFileSync(join(blip.dir, 'ci', 'blip'), '');
  const retry = blip.full();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(blip.ghLog().match(/dispatches/g)?.length, 2, 'the 502, then the dispatch that ran');

  // With no gate of its own (CI_STATUS and CI_WORKFLOWS empty), the build's workflows still get CI's time limit.
  const only = buildCi({ CI_STATUS: '', BUILD_WORKFLOWS: 'desktop.yml' }, 'desktop.yml green');
  const solo = only.full();
  assert.equal(solo.status, 0, solo.stderr);
  assert.equal(only.at('build/1'), git(only.wts[2], 'rev-parse', 'HEAD'));
});

test('BUILD_WORKFLOWS: a run that started on the push is waited for, not dispatched again, a lost one runs once more; with nothing set, --full asks GitHub nothing new', () => {
  const b = buildCi({ CI_STATUS: '', CI_WORKFLOWS: 'ci.yml', BUILD_WORKFLOWS: 'desktop.yml' });
  writeFileSync(join(b.dir, 'ci', 'runs.tsv'), '.github/workflows/ci.yml\t1\tcompleted\tsuccess\tu\n.github/workflows/desktop.yml\t2\tcompleted\tfailure\tu\n');
  const res = b.full();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /desktop\.yml: completed failure/);
  assert.doesNotMatch(b.ghLog(), /dispatches/);

  // A run still queued (the runners busy) is waited for, never dispatched again.
  const queued = buildCi({ CI_STATUS: '', CI_WORKFLOWS: 'ci.yml', BUILD_WORKFLOWS: 'desktop.yml' });
  writeFileSync(join(queued.dir, 'ci', 'runs.tsv'), '.github/workflows/ci.yml\t1\tcompleted\tsuccess\tu\n.github/workflows/desktop.yml\t2\tqueued\t-\tu\n');
  writeFileSync(join(queued.dir, 'ci', 'later.tsv'), '.github/workflows/ci.yml\t1\tcompleted\tsuccess\tu\n.github/workflows/desktop.yml\t2\tcompleted\tsuccess\tu\n');
  const wait = queued.full();
  assert.equal(wait.status, 0, wait.stderr);
  assert.doesNotMatch(queued.ghLog(), /dispatches/);

  // One that ends without a verdict (cancelled: its runner went away) is dispatched once more, and that run decides.
  const lost = buildCi({ BUILD_WORKFLOWS: 'desktop.yml' }, 'desktop.yml green');
  writeFileSync(join(lost.dir, 'ci', 'runs.tsv'), '.github/workflows/desktop.yml\t2\tcompleted\tcancelled\tu\n');
  const again = lost.full();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(lost.ghLog().match(/dispatches/g)?.length, 1, 'dispatched once more, not on every poll');

  const none = buildCi({});
  assert.equal(none.full().status, 0);
  assert.equal(none.ghLog(), '', 'CI_STATUS alone: no gh call');

  // Nothing set, a red gate workflow beside one with no run: the commit is still pushed so the other can run, as before.
  const gate = buildCi({ CI_STATUS: '', CI_WORKFLOWS: 'ci.yml other.yml' });
  writeFileSync(join(gate.dir, 'ci', 'runs.tsv'), '.github/workflows/ci.yml\t1\tcompleted\tfailure\tu\n');
  const pushedRed = gate.full({ LAND_CI_START: '0' }); // other.yml never starts: the red decides at once
  assert.equal(pushedRed.status, 1, pushedRed.stderr);
  assert.match(pushedRed.stderr, /waiting for CI on/);
});

test("BUILD_WORKFLOWS: <file>:<paths file> runs the workflow only when the build changes a path main's file names", () => {
  const b = buildCi({ BUILD_WORKFLOWS: 'desktop.yml:tools/desktop-run/paths' }, 'desktop.yml green');
  // On main only, after the branch forked: the list is main's, not the branch's.
  b.commit(b.main, 'tools/desktop-run/paths', '# the desktop harness\n!ci-win/setup.ps1 # run by hand\nci-win/*\n.github/workflows/desktop.yml\n');
  git(b.wts[2], 'merge', '-q', '--no-edit', 'build/1');
  let res = b.full();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /desktop\.yml is not needed/);
  b.commit(b.wts[2], 'ci-win/setup.ps1', 'x\n');
  res = b.full();
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(b.ghLog(), /dispatches/, 'a path the list rules out runs nothing');
  b.commit(b.wts[2], 'ci-win/run.ps1', 'x\n');
  res = b.full();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /desktop\.yml: ci-win\/run\.ps1 is on tools\/desktop-run\/paths/);
  assert.match(b.ghLog(), /desktop\.yml\/dispatches/);
});
