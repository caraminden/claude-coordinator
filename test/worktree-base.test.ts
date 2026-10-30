import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { catchUpMain, catchUpTicketDir, createTicketDir, mainSync, syncMain } from '../src/workspace.ts';

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
