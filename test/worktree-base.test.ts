import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildBranch, catchUpMain, catchUpTicketDir, createTicketDir, mainSync, syncMain } from '../src/workspace.ts';

const root = mkdtempSync(join(tmpdir(), 'wtbase-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, m: string) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', m], cwd);

// A bare "GitHub" remote and a scheme checkout cloned from it.
const remote = join(root, 'remote.git');
const seed = join(root, 'seed');
git(['init', '--quiet', '-b', 'main', seed], root);
commit(seed, 'init');
git(['clone', '--quiet', '--bare', seed, remote], root);
const repo = join(root, 'repo');
git(['clone', '--quiet', remote, repo], root);
const head = (cwd: string) => git(['rev-parse', 'HEAD'], cwd);
let n = 0;
const newMinion = async () => (await createTicketDir(root, 1, repo, ++n, n, 'x')).cwd;

test('branches from local main when minions merged into it without pushing', async () => {
  commit(repo, 'merged locally');
  assert.equal(head(await newMinion()), git(['rev-parse', 'main'], repo));
});

test('branches from origin/main when a push put it ahead of local main, and main catches up to it (#208)', async () => {
  git(['push', '--quiet', remote, 'HEAD:main'], repo);
  git(['pull', '--quiet', '--ff-only', remote, 'main'], seed);
  commit(seed, 'pushed elsewhere');
  git(['push', '--quiet', remote, 'main'], seed);
  assert.equal(head(await newMinion()), head(seed));
  assert.equal(git(['rev-parse', 'main'], repo), head(seed));
  assert.equal(head(repo), head(seed), 'the checkout itself moved, not just the ref');
});

test('local main wins when the two have diverged', async () => {
  git(['merge', '--quiet', '--ff-only', 'origin/main'], repo);
  commit(repo, 'local only');
  commit(seed, 'remote only');
  git(['push', '--quiet', remote, 'main'], seed);
  assert.equal(head(await newMinion()), git(['rev-parse', 'main'], repo));
});

test('a chained minion catches up to main when it starts, but never past commits of its own', async () => {
  const waiting = await newMinion();
  commit(repo, 'the change it waited for');
  assert.equal(await catchUpTicketDir(waiting, repo), true);
  assert.equal(head(waiting), git(['rev-parse', 'main'], repo));
  assert.equal(await catchUpTicketDir(waiting, repo), false, 'already there');

  commit(waiting, 'its own work');
  const own = head(waiting);
  commit(repo, 'more on main');
  assert.equal(await catchUpTicketDir(waiting, repo), false);
  assert.equal(head(waiting), own);
});

// Build branches (specs/build-branches.md): the branch existing is the switch.
test('a minion in a build branches from build/<n> once it exists, and from main before that or without a build', async () => {
  const inBuild = async (build: number | null) => (await createTicketDir(root, 1, repo, ++n, n, 'x', build)).cwd;
  assert.equal(head(await inBuild(7)), git(['rev-parse', 'main'], repo), 'no build/7 yet: main');
  git(['branch', 'build/7', 'main'], repo);
  const feeder = await inBuild(7);
  commit(feeder, 'a feeder folds in');
  git(['update-ref', 'refs/heads/build/7', head(feeder)], repo);
  commit(repo, 'main moves on');
  assert.equal(head(await inBuild(7)), git(['rev-parse', 'build/7'], repo), 'the build branch, not main');
  assert.equal(head(await inBuild(8)), git(['rev-parse', 'main'], repo), 'another build without a branch: main');
  assert.equal(head(await inBuild(null)), git(['rev-parse', 'main'], repo), 'no build: main');
  assert.equal(buildBranch(repo, 7), 'build/7');
  assert.equal(buildBranch(repo, 8), null);
  assert.equal(buildBranch(null, 7), null);
});

test("a build branch that only origin has is the base too", async () => {
  const pushed = join(root, 'pushed-build');
  git(['clone', '--quiet', remote, pushed], root);
  commit(pushed, 'on build 9');
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/build/9'], pushed);
  assert.equal(buildBranch(repo, 9), null, 'not fetched yet');
  const cwd = (await createTicketDir(root, 1, repo, ++n, n, 'x', 9)).cwd;
  assert.equal(buildBranch(repo, 9), 'origin/build/9');
  assert.equal(head(cwd), head(pushed));
});

test('a chained minion in a build catches up to its build branch, not main', async () => {
  git(['branch', 'build/10', 'main'], repo);
  const waiting = (await createTicketDir(root, 1, repo, ++n, n, 'x', 10)).cwd;
  const other = (await createTicketDir(root, 1, repo, ++n, n, 'x', 10)).cwd;
  commit(other, 'the feeder it waited for');
  git(['update-ref', 'refs/heads/build/10', head(other)], repo);
  commit(repo, 'main moves on');
  assert.equal(await catchUpTicketDir(waiting, repo, 10), true);
  assert.equal(head(waiting), git(['rev-parse', 'build/10'], repo));
});

// #208: the scheme checkout's main follows origin's when PRs merge on GitHub, and only then.
test("main catches up: only a fast-forward, only on a clean main, never when it's level, ahead or diverged", async () => {
  const r = join(root, 'ff');
  git(['clone', '--quiet', remote, r], root);
  git(['pull', '--quiet', '--ff-only', remote, 'main'], seed);
  const main = () => git(['rev-parse', 'main'], r);
  const pushFromSeed = (m: string) => { commit(seed, m); git(['push', '--quiet', remote, 'main'], seed); git(['fetch', '--quiet', 'origin'], r); };

  // Level, or main ahead (a scheme whose base is local main, as land.sh keeps Citadel's): untouched.
  assert.equal(await catchUpMain(r), null);
  commit(r, 'landed locally');
  const ahead = main();
  assert.equal(await catchUpMain(r), null);
  assert.equal(main(), ahead);
  git(['reset', '--quiet', '--hard', 'origin/main'], r);

  // Behind and clean: fast-forwards.
  pushFromSeed('merged on GitHub');
  assert.equal(await catchUpMain(r), null);
  assert.equal(main(), head(seed));

  // Behind but with uncommitted changes: skipped, changes kept. An untracked file alone doesn't stop it.
  pushFromSeed('merged again');
  writeFileSync(join(r, 'untracked.txt'), 'x');
  writeFileSync(join(r, 'tracked.txt'), 'x');
  git(['add', 'tracked.txt'], r);
  const before = main();
  assert.match(await catchUpMain(r) ?? '', /uncommitted changes/);
  assert.equal(main(), before);
  git(['reset', '--quiet'], r);
  rmSync(join(r, 'tracked.txt'));
  assert.equal(await catchUpMain(r), null);
  assert.equal(main(), head(seed));

  // Behind but on another branch: skipped, main not moved under it.
  pushFromSeed('merged while elsewhere');
  git(['switch', '--quiet', '-c', 'side'], r);
  const stale = main();
  assert.match(await catchUpMain(r) ?? '', /on side, not main/);
  assert.equal(main(), stale);
  git(['switch', '--quiet', 'main'], r);

  // Diverged: skipped, never forced.
  commit(r, 'local only');
  const local = main();
  assert.match(await catchUpMain(r) ?? '', /diverged/);
  assert.equal(main(), local);
});

test('a stuck main is reported once per reason, and once more when it is level again', async () => {
  const r = join(root, 'stuck');
  git(['clone', '--quiet', remote, r], root);
  git(['pull', '--quiet', '--ff-only', remote, 'main'], seed);
  const told: (string | null)[] = [];
  const was = mainSync.stuck;
  mainSync.stuck = (_dir, why) => { told.push(why); throw new Error('a broken reporter must not fail the sync'); };
  try {
    await syncMain(r);
    commit(seed, 'merged on GitHub');
    git(['push', '--quiet', remote, 'main'], seed);
    git(['switch', '--quiet', '-c', 'side'], r);
    await syncMain(r);
    await syncMain(r);
    git(['switch', '--quiet', 'main'], r);
    await syncMain(r);
    assert.deepEqual(told, ['the checkout is on side, not main', null]);
    assert.equal(git(['rev-parse', 'main'], r), head(seed));
  } finally {
    mainSync.stuck = was;
  }
});

// #321: a scheme's private repo answers only its owner's login, so main's catch-up fetches as them.
test("main catches up through a fetch that runs as the scheme owner's GitHub login", async () => {
  const r = join(root, 'owned');
  git(['clone', '--quiet', remote, r], root);
  // Its origin is on GitHub; only the owner's env knows the way there (a URL rewrite stands in for their token).
  git(['remote', 'set-url', 'origin', 'https://github.com/josh/private.git'], r);
  git(['pull', '--quiet', '--ff-only', remote, 'main'], seed);
  commit(seed, 'squash-merged on GitHub');
  git(['push', '--quiet', remote, 'main'], seed);
  const was = mainSync.as;
  mainSync.as = (dir) => (dir === r ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/josh/private.git' } : undefined);
  try {
    await syncMain(r);
    assert.equal(git(['rev-parse', 'main'], r), head(seed));
    assert.equal(head(r), head(seed), 'the checkout itself moved');
  } finally {
    mainSync.as = was;
  }
});

test('a fetch from a remote that stalls gives up after its own limit, and main is caught up from what is there (#468 S07-4)', async () => {
  const r = join(root, 'stalled');
  git(['clone', '--quiet', remote, r], root);
  // A remote that answers and then says nothing: the "ssh" notes its pid and sleeps far longer than the test (exec'd,
  // so nothing names this folder). Its stderr goes away so a sleep that outlives git can't hold the fetch open.
  const ssh = join(root, 'ssh-stall');
  const pidFile = join(root, 'ssh-stall.pid');
  const sshPid = () => { try { return Number(readFileSync(pidFile, 'utf8')) > 0 ? Number(readFileSync(pidFile, 'utf8')) : 0; } catch { return 0; } }; // never 0: kill(0) is our own group
  writeFileSync(ssh, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60 2>/dev/null\n`, { mode: 0o755 });
  git(['config', 'core.sshCommand', ssh], r);
  git(['remote', 'set-url', 'origin', 'ssh://stall.invalid/x.git'], r);
  const was = mainSync.fetchMs;
  mainSync.fetchMs = 300;
  try {
    await syncMain(r);
    // The remote never answers on its own, so getting back while it is still asleep means the fetch gave up at its limit.
    // (On a box so slow that the ssh never started inside fetchMs, there is no pid: git gave up before it, which is fine.)
    const pid = sshPid();
    if (pid) process.kill(pid, 0); // throws if the remote already ended
  } finally {
    mainSync.fetchMs = was;
    const pid = sshPid();
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});
