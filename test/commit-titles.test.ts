import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keepTitles } from '../src/workspace.ts';

// #1489: a "#N: title" survives a conflicted rebase continued with GIT_EDITOR=true, and the ship check names a commit that lost it.
// The runner's own git config (a comment char, a template, a default branch) must not decide these.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// A runner has no identity of its own, and the rebase's own commit (not only ours) needs one.
for (const who of ['AUTHOR', 'COMMITTER']) {
  process.env[`GIT_${who}_NAME`] = 't';
  process.env[`GIT_${who}_EMAIL`] = 't@t';
}
const root = mkdtempSync(join(tmpdir(), 'titles-'));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const put = (cwd: string, text: string, msg: string) => {
  writeFileSync(join(cwd, 'f'), text);
  git(cwd, 'add', 'f');
  git(cwd, 'commit', '-q', '-m', msg);
};

/** A repo whose branch conflicts with main, rebased, resolved and continued the way minions do. Returns the branch's subjects. */
async function conflicted(name: string, fix: boolean): Promise<{ cwd: string; subjects: string }> {
  const cwd = join(root, name);
  git(root, 'init', '-q', '-b', 'main', cwd);
  put(cwd, 'a\n', 'base');
  git(cwd, 'checkout', '-q', '-b', 'ticket/1-x');
  put(cwd, 'b\n', '#12: the title');
  git(cwd, 'checkout', '-q', 'main');
  put(cwd, 'c\n', 'main moved');
  git(cwd, 'checkout', '-q', 'ticket/1-x');
  if (fix) await keepTitles(cwd);
  spawnSync('git', ['rebase', 'main'], { cwd, env: { ...process.env, GIT_EDITOR: 'true' } });
  writeFileSync(join(cwd, 'f'), 'z\n');
  git(cwd, 'add', 'f');
  spawnSync('git', ['rebase', '--continue'], { cwd, env: { ...process.env, GIT_EDITOR: 'true' } });
  return { cwd, subjects: git(cwd, 'log', '--format=%s', 'main..HEAD') };
}

test('keepTitles: the same rebase keeps the title', async () => {
  assert.equal((await conflicted('kept', true)).subjects, '#12: the title');
});

test('keepTitles leaves a checkout that sets its own comment char alone', async () => {
  const cwd = join(root, 'own');
  git(root, 'init', '-q', '-b', 'main', cwd);
  git(cwd, 'config', 'core.commentChar', '|');
  await keepTitles(cwd);
  assert.equal(git(cwd, 'config', 'core.commentChar'), '|');
});

const check = (cwd: string) => spawnSync('bash', [join(import.meta.dirname, '../tools/commit-titles.sh'), 'main'], { cwd, encoding: 'utf8' });

test('ship check: names a commit that lost its #N: while a sibling has one', async () => {
  const { cwd } = await conflicted('check', true);
  assert.equal(check(cwd).status, 0);
  put(cwd, 'q\n', 'second commit with no number');
  const r = check(cwd);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /commit [0-9a-f]+ \("second commit with no number"\) lost its #N: title/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('ship check: a branch with no #N titles at all is fine', () => {
  const cwd = join(root, 'plain-scheme');
  git(root, 'init', '-q', '-b', 'main', cwd);
  put(cwd, 'a\n', 'base');
  git(cwd, 'checkout', '-q', '-b', 'topic');
  put(cwd, 'b\n', 'just a title');
  assert.equal(check(cwd).status, 0);
});

test('ship check: with no #N titles, the empty subject is named, not the newest commit (#1626)', () => {
  const cwd = join(root, 'plain-empty');
  git(root, 'init', '-q', '-b', 'main', cwd);
  put(cwd, 'a\n', 'base');
  git(cwd, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(cwd, 'e.txt'), 'e\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--allow-empty-message', '-m', '');
  const empty = git(cwd, 'rev-parse', '--short', 'HEAD');
  put(cwd, 'c\n', 'Fix y');
  const r = check(cwd);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`commit ${empty} has an empty subject`));
  assert.doesNotMatch(r.stdout, /Fix y/);
});
