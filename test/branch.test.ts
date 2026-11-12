import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { branchStatus, shipLine, type BranchStatus } from '../src/branch.ts';

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

test("a branch whose commits all vanished in a rebase, as main already had the same change, has nothing of its own, so no live chip (#590)", async () => {
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
  assert.deepEqual(line({ deploy: null }), { stage: 'main', text: 'Merged into main', commit: 'abcdef0' }, "another scheme's work");
  assert.equal(line({})?.text, 'On main, not deployed');
  assert.deepEqual(line({ deploy: { pulled: true, live: false } }, 2), { stage: 'deploying', text: 'Deploying: waiting on the idle restart, 2 turns running', commit: 'abcdef0' });
  assert.equal(line({ deploy: { pulled: true, live: false } })?.text, 'Deploying');
  assert.equal(line({ deploy: { pulled: true, live: true } }, 3, 'Deploy failed.')?.stage, 'live', 'live wins over an older failure');
  const report = 'Deploy of abc1234 "x" failed: the server did not answer healthy on it within 30 s. Rolled back to last-good.';
  assert.deepEqual(line({}, 0, report), {
    stage: 'failed', commit: 'abcdef0', detail: report,
    text: 'Not live, the last deploy failed: the server did not answer healthy on it within 30 s',
  });
  assert.equal(line({ deploy: { pulled: true, live: false } }, 0, 'Gave up after 120 min waiting for turns, so nothing restarted. Run it again.')?.text,
    'Not live, the last deploy failed: Gave up after 120 min waiting for turns, so nothing restarted');
});

// Build branches (#592, specs/build-branches.md): a feeder folded into build/<n> reads as folded, and once
// the build lands (main takes it by merge, then fast-forwards) its own commit, hash unchanged, goes live.
test('a feeder folded into its build reads as folded, then live once the build lands, its commit unchanged', async () => {
  git(repo, 'branch', 'build/7', 'main');
  git(repo, 'checkout', '-q', '-b', 'feeder', 'build/7');
  const mine = commit(repo);
  git(repo, 'checkout', '-q', 'main');
  const inBuild = (head: string | null = running) => branchStatus(repo, 'feeder', started, false, { head, checkoutDir: live }, 7);
  assert.equal(shipLine(await inBuild(), 0, null)?.stage, 'branch', 'not merged in yet');
  git(repo, 'update-ref', 'refs/heads/build/7', mine); // tools/land.sh --into build/7
  const folded = shipLine(await inBuild(), 0, null);
  assert.deepEqual([folded?.stage, folded?.text], ['build', 'Folded into Build 7, not live until the build lands']);
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
