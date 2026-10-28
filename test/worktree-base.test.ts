import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { catchUpTicketDir, createTicketDir } from '../src/workspace.ts';

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

test('branches from origin/main when a push put it ahead of local main', async () => {
  git(['push', '--quiet', remote, 'HEAD:main'], repo);
  git(['pull', '--quiet', '--ff-only', remote, 'main'], seed);
  commit(seed, 'pushed elsewhere');
  git(['push', '--quiet', remote, 'main'], seed);
  assert.equal(head(await newMinion()), head(seed));
  assert.notEqual(head(seed), git(['rev-parse', 'main'], repo));
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
