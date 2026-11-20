import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fixShipped } from '../src/wake.ts';

// #1074: a red's fix minion's work counts as on main (so CI health re-runs the red workflow) only once commits it made
// are in main's tip on GitHub, by hash or as patch twins (a land rebases); a branch that only caught up to main doesn't.
const repo = mkdtempSync(join(tmpdir(), 'fix-shipped-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
let n = 0;
const commit = (file: string) => {
  writeFileSync(join(repo, file), String(++n));
  git('add', '-A');
  git('commit', '-q', '-m', `c${n}`);
  return git('rev-parse', 'HEAD');
};
const since = () => Math.floor(Date.now() / 1000) - 5;

test("a fix minion's tip counts once its own commits are on main, rebased or not, and never for a branch with none (#1074)", async () => {
  commit('base');
  const start = since();
  git('switch', '-q', '-c', 'ticket/1-fix');
  const tip = commit('fix');
  git('switch', '-q', 'main');
  const before = commit('other'); // main moves on without the fix
  assert.equal(await fixShipped(repo, 'ticket/1-fix', start, before), null, 'not on main yet');

  // The land rebases the fix onto main: a new hash, the same patch.
  git('cherry-pick', tip);
  const landed = git('rev-parse', 'HEAD');
  assert.equal(await fixShipped(repo, 'ticket/1-fix', start, landed), tip);
  // A later main, with someone else's land on top, still holds it.
  assert.equal(await fixShipped(repo, 'ticket/1-fix', start, commit('later')), tip);
  // Merged by hash too.
  git('merge', '-q', '--no-edit', 'ticket/1-fix');
  assert.equal(await fixShipped(repo, 'ticket/1-fix', start, git('rev-parse', 'HEAD')), tip);

  // A minion that made no commits: its branch only points at main.
  git('branch', 'ticket/2-none', 'main');
  assert.equal(await fixShipped(repo, 'ticket/2-none', since(), git('rev-parse', 'HEAD')), null);
  // Commits from before the minion started aren't its own.
  assert.equal(await fixShipped(repo, 'ticket/1-fix', Math.floor(Date.now() / 1000) + 60, git('rev-parse', 'HEAD')), null);
  // A branch that doesn't exist.
  assert.equal(await fixShipped(repo, 'ticket/3-gone', start, git('rev-parse', 'HEAD')), null);
});
