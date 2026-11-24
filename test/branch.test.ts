import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { branchStatus, forgetSettled, shipLine, type BranchStatus } from '../src/branch.ts';

// Where a minion's branch stands: merged into main, then pulled into the live checkout, then run by
// the server. A scheme repo, a live checkout cloned from it, and another scheme's repo, in temp dirs.
const root = mkdtempSync(join(tmpdir(), 'branch-status-'));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, 'repo');
const live = join(root, 'live');
const other = join(root, 'other');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function init(dir: string) {
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
}
let n = 0;
function commit(dir: string): string {
  writeFileSync(join(dir, 'f'), String(++n));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `c${n}`);
  return git(dir, 'rev-parse', 'HEAD');
}
init(repo);
init(other);
commit(other);
const running = commit(repo);
git(root, 'clone', '-q', repo, live);
const started = Date.now() - 60_000;

/** A branch with one commit of its own, cut from main. */
function branch(name: string): string {
  git(repo, 'checkout', '-q', '-b', name, 'main');
  const tip = commit(repo);
  git(repo, 'checkout', '-q', 'main');
  return tip;
}
const merge = (name: string) => git(repo, 'merge', '-q', '--ff-only', name);
const pull = () => git(live, 'pull', '-q', '--ff-only', repo, 'main');
const status = (name: string, head: string | null = running) => branchStatus(repo, name, started, false, { head, checkoutDir: live });

test('unmerged work has no deploy stage', async () => {
  branch('t/1');
  const s = await status('t/1');
  assert.equal(s?.merged, false);
  assert.equal(s?.ahead, 1);
  assert.equal(s?.deploy, null);
});

test('merged work moves from on main, to pulled into the checkout, to live', async () => {
  branch('t/2');
  merge('t/2');
  assert.deepEqual((await status('t/2'))?.deploy, { pulled: false, live: false });
  pull();
  assert.deepEqual((await status('t/2'))?.deploy, { pulled: true, live: false }, 'deploy.sh pulled it; the restart is pending');
  const head = git(live, 'rev-parse', 'HEAD');
  assert.deepEqual((await status('t/2', head))?.deploy, { pulled: true, live: true });
});

test('work is live once the running commit contains it, even if a later deploy carried it', async () => {
  branch('t/3');
  merge('t/3');
  branch('t/4');
  merge('t/4');
  pull();
  const head = git(live, 'rev-parse', 'HEAD');
  assert.deepEqual((await status('t/3', head))?.deploy, { pulled: true, live: true });
});

test("another scheme's work, or an unknown running commit, has no deploy stage", async () => {
  git(other, 'checkout', '-q', '-b', 't/5');
  commit(other);
  git(other, 'checkout', '-q', 'main');
  git(other, 'merge', '-q', '--ff-only', 't/5');
  const s = await branchStatus(other, 't/5', started, false, { head: running, checkoutDir: live });
  assert.equal(s?.merged, true);
  assert.equal(s?.deploy, null);
  branch('t/6');
  merge('t/6');
  assert.equal((await status('t/6', null))?.deploy, null);
});

test('a branch only fast-forwarded to a newer main has nothing of its own, so it is not "merged" (#468 S07-1)', async () => {
  git(repo, 'branch', 't/8', 'main');
  commit(repo);
  git(repo, 'checkout', '-q', 't/8');
  git(repo, 'merge', '-q', '--ff-only', 'main');
  git(repo, 'checkout', '-q', 'main');
  const s = await status('t/8');
  assert.equal(s?.empty, true);
  assert.equal(s?.merged, false);
  assert.equal(shipLine(s, 0, null), null);
});

/** A commit that writes `text` to g, the same change whichever branch makes it. */
function same(text: string, by: string): string {
  writeFileSync(join(repo, 'g'), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `${text}, by ${by}`); // its own message, so not the very same commit
  return git(repo, 'rev-parse', 'HEAD');
}

test('a branch whose commits all vanished in a rebase, as main already had the same change, has nothing of its own, so no live chip (#590)', async () => {
  git(repo, 'checkout', '-q', '-b', 't/10', 'main');
  same('ten', 't/10');
  git(repo, 'checkout', '-q', 'main');
  same('ten', 'main'); // another minion landed the same change first
  git(repo, 'checkout', '-q', 't/10');
  git(repo, 'rebase', '-q', 'main');
  git(repo, 'checkout', '-q', 'main');
  assert.equal(git(repo, 'rev-parse', 't/10'), git(repo, 'rev-parse', 'main'), 'the rebase dropped its only commit');
  pull();
  const s = await status('t/10', git(live, 'rev-parse', 'HEAD'));
  assert.equal(s?.empty, true);
  assert.equal(shipLine(s, 0, null), null);
  // Committing again after that is work of its own.
  git(repo, 'checkout', '-q', 't/10');
  commit(repo);
  git(repo, 'checkout', '-q', 'main');
  assert.equal((await status('t/10'))?.empty, false);
});

test('work a rebase kept, as land.sh does before it fast-forwards main, is still its own and goes live', async () => {
  git(repo, 'checkout', '-q', '-b', 't/11', 'main');
  same('eleven', 't/11');
  git(repo, 'checkout', '-q', 'main');
  commit(repo); // main moved on meanwhile
  git(repo, 'checkout', '-q', 't/11');
  git(repo, 'rebase', '-q', 'main');
  git(repo, 'checkout', '-q', 'main');
  merge('t/11');
  pull();
  const s = await status('t/11', git(live, 'rev-parse', 'HEAD'));
  assert.equal(s?.empty, false);
  assert.equal(shipLine(s, 0, null)?.stage, 'live');
  // Catching up to a newer main afterwards is a fast-forward rebase: its work is still in there.
  commit(repo);
  git(repo, 'checkout', '-q', 't/11');
  git(repo, 'rebase', '-q', 'main');
  git(repo, 'checkout', '-q', 'main');
  assert.equal((await status('t/11'))?.empty, false, 'caught up after landing');
});

test('the ship line says where the change is, and why it is not moving', () => {
  const base: BranchStatus = { branch: 't/7', tip: 'abcdef0123', base: 'main', ahead: 0, merged: true, empty: false, pr: null, deploy: { pulled: false, live: false } };
  const line = (s: Partial<BranchStatus>, turns = 0, failure: string | null = null) => shipLine({ ...base, ...s }, turns, failure);
  assert.equal(line({ empty: true }), null, 'nothing committed yet');
  assert.deepEqual(line({ merged: false, ahead: 2, deploy: null }), { stage: 'branch', text: 'On its branch: 2 commits not on main', commit: 'abcdef0' });
  assert.deepEqual(line({ deploy: null }), { stage: 'main', text: 'Shipped to main', commit: 'abcdef0' }, "another scheme's work");
  assert.equal(line({})?.text, 'On main, not deployed');
  assert.deepEqual(line({ deploy: { pulled: true, live: false } }, 2), { stage: 'deploying', text: 'Deploying: waiting on the idle restart, 2 turns running', commit: 'abcdef0' });
  assert.equal(line({ deploy: { pulled: true, live: false } })?.text, 'Deploying');
  assert.equal(line({ deploy: { pulled: true, live: true } }, 3, 'Deploy failed.')?.stage, 'live', 'live wins over an older failure');
  const report = 'Deploy of abc1234 "x" failed: the server did not answer healthy on it within 30 s. Rolled back to last-good.';
  assert.deepEqual(line({}, 0, report), {
    stage: 'failed',
    commit: 'abcdef0',
    detail: report,
    text: 'Not live, the last deploy failed: the server did not answer healthy on it within 30 s',
  });
  assert.equal(line({ deploy: { pulled: true, live: false } }, 0, 'Gave up after 120 min waiting for turns, so nothing restarted. Run it again.')?.text, 'Not live, the last deploy failed: Gave up after 120 min waiting for turns, so nothing restarted');
});

// Build branches (#592, specs/build-branches.md): a feeder merged into build/<n> reads as in its build, and once
// the build lands (main takes it by merge, then fast-forwards) its own commit, hash unchanged, goes live.
test('a feeder merged into its build reads as in its build, then live once the build lands, its commit unchanged', async () => {
  git(repo, 'branch', 'build/7', 'main');
  git(repo, 'checkout', '-q', '-b', 'feeder', 'build/7');
  const mine = commit(repo);
  git(repo, 'checkout', '-q', 'main');
  const inBuild = (head: string | null = running) => branchStatus(repo, 'feeder', started, false, { head, checkoutDir: live }, 7);
  assert.deepEqual(shipLine(await inBuild(), 0, null), { stage: 'branch', text: 'On its branch: 1 commit not in build/7', commit: mine.slice(0, 7) }, 'not merged in yet');
  git(repo, 'update-ref', 'refs/heads/build/7', mine); // tools/land.sh --into build/7
  const folded = shipLine(await inBuild(), 0, null);
  assert.deepEqual([folded?.stage, folded?.text], ['build', 'Merged into Build 7, not live until the build ships']);
  assert.equal(shipLine(await status('feeder'), 0, null)?.stage, 'branch', 'without its build, just a branch');

  // main moves on; the build minion merges it in, and the build lands by merge and fast-forward.
  writeFileSync(join(repo, 'g'), 'elsewhere');
  git(repo, 'add', 'g');
  git(repo, 'commit', '-q', '-m', 'main moves on');
  git(repo, 'checkout', '-q', '-b', 'build-minion', 'build/7');
  git(repo, 'merge', '-q', '--no-edit', 'main');
  git(repo, 'update-ref', 'refs/heads/build/7', git(repo, 'rev-parse', 'HEAD'));
  git(repo, 'checkout', '-q', 'main');
  merge('build/7');
  const after = await inBuild(git(repo, 'rev-parse', 'main'));
  assert.equal(after?.tip, mine, 'the feeder commit keeps its hash');
  assert.equal(shipLine(after, 0, null)?.stage, 'live');
});

// #632, Cara: "It should refresh if there is new work it is doing that isnt live". Edits in a minion's worktree
// that aren't committed are new work; a new top-level file or folder is its scratch (screenshots, notes), not work.
test("uncommitted edits in the minion's worktree count as new work, its top-level scratch does not", async () => {
  git(repo, 'branch', 't/12', 'main');
  const wt = join(root, 'wt12');
  git(repo, 'worktree', 'add', '-q', wt, 't/12');
  mkdirSync(join(wt, 'src'));
  writeFileSync(join(wt, 'src', 'a.ts'), '1');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'src');
  merge('t/12');
  pull();
  const head = git(live, 'rev-parse', 'HEAD');
  const ws = (dir: string | null = wt) => branchStatus(repo, 't/12', started, false, { head, checkoutDir: live }, null, dir);
  assert.equal((await ws())?.uncommitted, 0);
  assert.equal(shipLine(await ws(), 0, null)?.stage, 'live');

  mkdirSync(join(wt, 'shots'));
  writeFileSync(join(wt, 'shots', 'row.png'), 'x');
  writeFileSync(join(wt, 'notes.md'), 'x');
  assert.equal((await ws())?.uncommitted, 0, 'top-level scratch is not work');
  assert.equal(shipLine(await ws(), 0, null)?.stage, 'live');

  writeFileSync(join(wt, 'src', 'b.ts'), 'new');
  assert.equal((await ws())?.uncommitted, 1, 'a new file in a folder the repo tracks');
  assert.deepEqual(shipLine(await ws(), 0, null), { stage: 'branch', text: 'On its branch: changes not committed yet', commit: head.slice(0, 7) });
  writeFileSync(join(wt, 'src', 'a.ts'), '2');
  assert.equal((await ws())?.uncommitted, 2, 'an edited tracked file');
  git(wt, 'add', 'src');
  assert.equal((await ws())?.uncommitted, 2, 'staged still counts');

  git(wt, 'commit', '-q', '-m', 'more');
  assert.equal((await ws())?.uncommitted, 0);
  assert.equal(shipLine(await ws(), 0, null)?.text, 'On its branch: 1 commit not on main');
  assert.equal((await ws(null))?.uncommitted, 0, 'no worktree to look at');
  assert.equal((await ws(join(root, 'gone')))?.uncommitted, 0, 'a worktree that is gone');
});

test('uncommitted work takes a finished line back to its branch, rides along with unlanded commits, and leaves a land in flight alone', () => {
  const base: BranchStatus = { branch: 't/7', tip: 'abcdef0123', base: 'main', ahead: 0, merged: true, empty: false, pr: null, deploy: { pulled: true, live: true }, uncommitted: 1 };
  const line = (s: Partial<BranchStatus>) => shipLine({ ...base, ...s }, 0, null);
  const edits = { stage: 'branch', text: 'On its branch: changes not committed yet', commit: 'abcdef0' };
  assert.deepEqual(line({}), edits, 'live, then edits');
  assert.deepEqual(line({ deploy: null }), edits, "another scheme's merged work, then edits");
  assert.deepEqual(line({ merged: false, deploy: null, build: { n: 7, merged: true, ahead: 0 } }), edits, 'merged into its build, then edits');
  assert.deepEqual(line({ empty: true, merged: false, deploy: null }), edits, 'edits before the first commit');
  assert.equal(line({ empty: true, merged: false, deploy: null, uncommitted: 0 }), null);
  assert.equal(line({ merged: false, ahead: 2, deploy: null })?.text, 'On its branch: 2 commits not on main, and changes not committed yet');
  assert.equal(line({ merged: false, deploy: null, build: { n: 7, merged: false, ahead: 1 } })?.text, 'On its branch: 1 commit not in build/7, and changes not committed yet');
  // Landed and on its way: those stages already say it isn't live, and the release track follows them.
  assert.equal(line({ deploy: { pulled: true, live: false } })?.stage, 'deploying');
  assert.equal(line({ deploy: { pulled: false, live: false } })?.stage, 'main');
  assert.equal(shipLine({ ...base, deploy: { pulled: true, live: false } }, 0, 'Deploy failed.')?.stage, 'failed');
});

// #1463: each git start holds the server's thread for its fork, and branchStatus started 8 to 15 per call. A call
// where nothing moved now reads its refs in one git and asks hash-only questions once; the live checkout's HEAD
// comes from its files.
test('a second look at a branch where nothing moved starts one git, even while it deploys (#1463)', async () => {
  branch('t/20');
  merge('t/20');
  pull(); // pulled, not live yet: the deploy path, the most git there is
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'git-starts');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$1" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0); // raw-read-ok: only line counts
  try {
    forgetSettled();
    const first = await status('t/20');
    const cold = starts();
    rmSync(log, { force: true });
    const again = await status('t/20');
    assert.deepEqual(again, first, 'the same answer');
    assert.equal(starts(), 1, `only the ref read; the first look started ${cold}`);
    assert.ok(cold > 1);
    // The branch moves: it is asked again, and the answer follows.
    git(repo, 'checkout', '-q', 't/20');
    commit(repo);
    git(repo, 'checkout', '-q', 'main');
    const moved = await status('t/20');
    assert.equal(moved?.merged, false);
    assert.equal(moved?.ahead, 1);
  } finally {
    process.env.PATH = path;
  }
});

test('a git that fails once is asked again: a failed look never pins a branch as empty (#1463 review)', async () => {
  branch('t/21');
  merge('t/21');
  const bin = join(root, 'bin-fail');
  mkdirSync(bin, { recursive: true });
  const fail = join(root, 'git-fails');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // While the flag file is there, the reflog and log reads fail, as a timeout would.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
if [ -e '${fail}' ] && { [ "$1" = reflog ] || [ "$1" = log ]; }; then exit 1; fi
exec '${real}' "$@"
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    forgetSettled();
    writeFileSync(fail, '');
    assert.equal((await status('t/21'))?.merged, false, 'git failed: it reads as empty, so not shipped');
    rmSync(fail);
    assert.equal((await status('t/21'))?.merged, true, 'git works again: the next look sees it shipped');
  } finally {
    process.env.PATH = path;
  }
});
