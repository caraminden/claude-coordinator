import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { branchStatus } from '../src/branch.ts';

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
