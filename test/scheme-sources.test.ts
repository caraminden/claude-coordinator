import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { repoSlug } from '../src/prlinks.ts';
import { repoName } from '../src/scheme-repo.ts';
import { bootServer, REPO, type Booted } from './helpers.ts';

// A new scheme's code sources (#173). The server runs with HOME set to the scratch folder (so its
// data dir is under HOME) and a stub `gh` first on PATH: no test makes a real GitHub repo.
const root = mkdtempSync(join(tmpdir(), 'scheme-sources-'));
const stub = join(root, 'gh-stub');
const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: root } }).trim();
const commit = (cwd: string, m: string) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', m], cwd);
const ghCalls = () => (existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf8').trim().split('\n') : []);

// `gh repo view` finds a repo when stub/taken/<owner>_<name> exists; `gh repo create` fails with
// stub/fail's text when that exists, and otherwise makes a bare repo standing in for GitHub's (and
// sets origin to it, failing the push when stub/fail-push exists).
mkdirSync(join(stub, 'bin'), { recursive: true });
mkdirSync(join(stub, 'taken'));
writeFileSync(join(stub, 'bin', 'gh'), `#!/bin/sh
S=${JSON.stringify(stub)}
echo "$*" >> "$S/calls"
[ "$1 $2" = "repo view" ] && { [ -e "$S/taken/$(echo "$3" | tr / _)" ] && { echo '{"name":"x"}'; exit 0; }; echo "GraphQL: Could not resolve to a Repository with the name '$3'. (repository)" >&2; exit 1; }
if [ "$1 $2" = "repo create" ]; then
  [ -e "$S/fail" ] && { cat "$S/fail" >&2; exit 1; }
  shift 2; slug=$1; src=
  while [ $# -gt 0 ]; do [ "$1" = --source ] && src=$2; shift; done
  bare="$S/remotes/$(echo "$slug" | tr / _).git"
  git init --quiet --bare "$bare" && git -C "$src" remote add origin "$bare" || exit 1
  [ -e "$S/fail-push" ] && { echo 'error: failed to push some refs' >&2; exit 1; }
  git -C "$src" push --quiet -u origin HEAD
fi
exit 0
`);
chmodSync(join(stub, 'bin', 'gh'), 0o755);

// A "remote" that https://example.test/remote.git clones from, through git's insteadOf.
const seed = join(root, 'seed');
git(['init', '--quiet', '-b', 'main', seed]);
commit(seed, 'seed');
git(['clone', '--quiet', '--bare', seed, join(root, 'remote.git')]);
// An empty GitHub repo, as a scheme cloned before anyone pushed to it (#181).
git(['init', '--quiet', '--bare', '-b', 'main', join(root, 'empty.git')]);
// The folder test's GitHub origin goes there too, so ticketBase's fetch stays offline.
writeFileSync(join(root, '.gitconfig'), `[url "${join(root, 'remote.git')}"]\n\tinsteadOf = https://example.test/remote.git\n\tinsteadOf = git@github.com:someone/hub.git\n[url "${join(root, 'empty.git')}"]\n\tinsteadOf = https://example.test/empty.git\n[url "${join(root, 'nowhere.git')}"]\n\tinsteadOf = https://example.test/missing.git\n`);

let s: Booted;
before(async () => {
  s = await bootServer({ root, env: { HOME: root, PATH: `${join(stub, 'bin')}:${process.env.PATH}` } });
});
after(() => {
  s?.stop();
  rmSync(root, { recursive: true, force: true });
});

const create = (body: object) => s.call('/api/projects', body);
const repoOf = (id: number) => join(s.data, 'projects', String(id), 'repo');

/** A minion in the scheme: its worktree starts from the scheme repo's main (ticketBase), or is a plain folder without a repo. */
async function minionStartsOnMain(projectId: number) {
  const r = await s.call(`/api/projects/${projectId}/tickets`, { message: 'try the repo' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = r.data.ticket ?? r.data;
  const project = (await s.call(`/api/projects/${projectId}`)).data.project;
  if (!project.repo_dir) {
    assert.equal(t.branch, null);
    assert.ok(existsSync(t.cwd));
    return;
  }
  assert.match(t.branch, /^ticket\//);
  assert.equal(git(['rev-parse', 'HEAD'], t.cwd), git(['rev-parse', 'main'], project.repo_dir));
}

test('the GitHub owner defaults to the owner of Citadel\'s origin and can be set', async () => {
  const origin = (() => { try { return git(['remote', 'get-url', 'origin'], REPO); } catch { return null; } })();
  const r = await s.call('/api/app/settings');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { github_owner: null, github_owner_default: repoSlug(origin)?.split('/')[0] ?? null });
  assert.equal((await s.call('/api/app/settings', { github_owner: 'not a name' }, 'PUT')).status, 400);
  assert.equal((await s.call('/api/app/settings', { github_owner: 'test-owner' }, 'PUT')).data.github_owner, 'test-owner');
});

test('none, and no source with no URL: no repo, plain folders for minions', async () => {
  for (const [name, body] of [['No code', { source: 'none' }], ['Old form', { repoUrl: '' }]] as const) {
    const r = await create({ name, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.repo_dir, null);
    await minionStartsOnMain(r.data.id);
  }
});

test('url clones as before, with or without source', async () => {
  for (const [name, body] of [['From URL', { source: 'url', repoUrl: 'https://example.test/remote.git' }], ['From URL old', { repoUrl: 'https://example.test/remote.git' }]] as const) {
    const r = await create({ name, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.repo_url, 'https://example.test/remote.git');
    assert.equal(git(['rev-parse', 'main'], r.data.repo_dir), git(['rev-parse', 'main'], seed));
    await minionStartsOnMain(r.data.id);
  }
  assert.match((await create({ name: 'Bad URL', source: 'url', repoUrl: 'file:///tmp/x' })).data.error, /https:\/\/ or git@/);
  assert.match((await create({ name: 'No URL', source: 'url' })).data.error, /Repo URL is required/);
  assert.match((await create({ name: 'Odd', source: 'zip' })).data.error, /Source must be one of/);
});

test('a scheme cloned from an empty repo starts minions from a local first commit, never pushed', async () => {
  const r = await create({ name: 'Empty', source: 'url', repoUrl: 'https://example.test/empty.git' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // The state such a scheme is left in: main has no commits.
  assert.throws(() => git(['rev-parse', '--verify', 'HEAD'], r.data.repo_dir));
  await minionStartsOnMain(r.data.id);
  assert.equal(git(['log', '--format=%s', 'main'], r.data.repo_dir), 'Start');
  assert.equal(git(['ls-tree', 'main'], r.data.repo_dir), '');
  assert.equal(git(['for-each-ref'], join(root, 'empty.git')), '', 'the first commit stays local');
  await minionStartsOnMain(r.data.id);
});

test('a scheme cloned empty whose GitHub repo got commits since starts minions from those', async () => {
  const pushed = join(root, 'pushed.git');
  git(['init', '--quiet', '--bare', '-b', 'main', pushed]);
  const r = await create({ name: 'Empty then pushed', source: 'url', repoUrl: 'https://example.test/empty.git' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  git(['remote', 'set-url', 'origin', pushed], r.data.repo_dir);
  git(['push', '--quiet', pushed, 'main'], seed);
  const t = (await s.call(`/api/projects/${r.data.id}/tickets`, { message: 'try the repo' })).data;
  assert.equal(git(['rev-parse', 'HEAD'], t.ticket?.cwd ?? t.cwd), git(['rev-parse', 'main'], seed));
});

test('a minion whose worktree can\'t be made says what git said', async () => {
  const r = await create({ name: 'No git', source: 'url', repoUrl: 'https://example.test/remote.git' });
  rmSync(join(r.data.repo_dir, '.git'), { recursive: true, force: true });
  const t = await s.call(`/api/projects/${r.data.id}/tickets`, { message: 'try the repo' });
  assert.equal(t.status, 500);
  assert.match(t.data.error, /^Could not create working directory: .*not a git repository/);
});

test('a locked repo config says so, not just git\'s hint', async () => {
  const r = await create({ name: 'Locked config', source: 'url', repoUrl: 'https://example.test/remote.git' });
  const lock = join(r.data.repo_dir, '.git', 'config.lock');
  writeFileSync(lock, '');
  chmodSync(lock, 0o444);
  const t = await s.call(`/api/projects/${r.data.id}/tickets`, { message: 'try the repo' });
  assert.equal(t.status, 500);
  assert.match(t.data.error, /could not lock config file/);
  assert.doesNotMatch(t.data.error, /hint:/);
  rmSync(lock);
  await minionStartsOnMain(r.data.id);
});

test('a failed clone leaves no scheme and no folder behind', async () => {
  const before = (await s.call('/api/projects')).data.length;
  const r = await create({ name: 'Broken', source: 'url', repoUrl: 'https://example.test/missing.git' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Could not clone repo/);
  const after = (await s.call('/api/projects')).data;
  assert.equal(after.length, before);
  assert.ok(!after.some((p: any) => p.name === 'Broken'));
  // The id it had is free again (SQLite reuses the top one), and its folder is gone.
  const next = await create({ name: 'After broken', source: 'none' });
  assert.ok(!existsSync(repoOf(next.data.id)));
});

test('folder clones a repo under HOME and leaves the folder alone; a GitHub origin carries over', async () => {
  const plain = join(root, 'code', 'plain');
  git(['init', '--quiet', '-b', 'main', plain]);
  writeFileSync(join(plain, 'a.txt'), 'hi');
  git(['add', 'a.txt'], plain);
  commit(plain, 'one');
  const r = await create({ name: 'From folder', source: 'folder', folder: plain });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(git(['remote', 'get-url', 'origin'], r.data.repo_dir), plain);
  assert.equal(r.data.repo_url, plain);
  assert.ok(existsSync(join(r.data.repo_dir, 'a.txt')));
  assert.equal(git(['status', '--porcelain'], plain), '', 'the original is untouched');
  await minionStartsOnMain(r.data.id);
  const tilde = await create({ name: 'From ~ folder', source: 'folder', folder: '~/code/plain' });
  assert.equal(tilde.data.repo_url, plain, 'a leading ~/ is the home folder');

  const hub = join(root, 'code', 'hub');
  git(['clone', '--quiet', seed, hub]);
  git(['remote', 'set-url', 'origin', 'git@github.com:someone/hub.git'], hub);
  const g = await create({ name: 'From GitHub folder', source: 'folder', folder: hub });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal(git(['config', '--get', 'remote.origin.url'], g.data.repo_dir), 'git@github.com:someone/hub.git');
  assert.equal(g.data.repo_url, 'git@github.com:someone/hub.git');
  assert.equal(git(['config', '--get', 'remote.origin.url'], hub), 'git@github.com:someone/hub.git');
  await minionStartsOnMain(g.data.id);
});

test('folder refuses relative, missing, outside-HOME, data-dir, non-repo, sub-folder and empty-repo paths', async () => {
  mkdirSync(join(root, 'code', 'loose'), { recursive: true });
  mkdirSync(join(root, 'code', 'plain', 'sub'), { recursive: true });
  git(['init', '--quiet', join(root, 'code', 'empty')]);
  const cases: [string, RegExp][] = [
    ['code/plain', /absolute path/],
    [join(root, 'code', 'nope'), /There is no folder/],
    [tmpdir(), /under your home folder/],
    [join(s.data, 'projects', '1'), /data folder/],
    [s.data, /data folder/],
    [join(root, 'code', 'loose'), /isn't a git repo/],
    [join(root, 'code', 'plain', 'sub'), /inside the git repo at/],
    [join(root, 'code', 'empty'), /no commits/],
  ];
  const count = (await s.call('/api/projects')).data.length;
  for (const [folder, why] of cases) {
    const r = await create({ name: `Refused ${folder}`, source: 'folder', folder });
    assert.equal(r.status, 400, folder);
    assert.match(r.data.error, why, folder);
  }
  assert.equal((await create({ name: 'No folder', source: 'folder' })).status, 400);
  assert.equal((await s.call('/api/projects')).data.length, count, 'no scheme made');
});

test('new makes a local repo with one commit and a private GitHub repo under the owner', async () => {
  rmSync(join(stub, 'calls'), { force: true });
  const r = await create({ name: 'Lantern Fall', source: 'new', about: 'A small game about lanterns.' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(repoName('Lantern Fall'), 'lantern-fall');
  assert.equal(r.data.repo_url, 'https://github.com/test-owner/lantern-fall');
  assert.equal(r.data.github_error, null);
  const dir = r.data.repo_dir;
  assert.equal(git(['rev-list', '--count', 'main'], dir), '1');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# Lantern Fall\n\nA small game about lanterns.\n');
  assert.ok(existsSync(join(dir, '.gitignore')));
  const calls = ghCalls();
  assert.equal(calls[0], 'repo view test-owner/lantern-fall --json name');
  assert.equal(calls[1], `repo create test-owner/lantern-fall --private --source ${dir} --remote origin --push`);
  assert.equal(git(['rev-parse', 'main'], join(stub, 'remotes', 'test-owner_lantern-fall.git')), git(['rev-parse', 'main'], dir), 'pushed');
  assert.equal(git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir), 'origin/main');
  await minionStartsOnMain(r.data.id);
});

test('new refuses a taken GitHub name before making anything', async () => {
  writeFileSync(join(stub, 'taken', 'test-owner_taken-name'), '');
  const count = (await s.call('/api/projects')).data.length;
  const r = await create({ name: 'Taken Name', source: 'new' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /test-owner\/taken-name already exists/);
  assert.equal((await s.call('/api/projects')).data.length, count);
  assert.ok(!ghCalls().some((c) => c.startsWith('repo create test-owner/taken-name')));
  assert.match((await create({ name: '!!!', source: 'new' })).data.error, /letter or digit/);
});

test('when gh fails the scheme stays with the error, and Retry puts it on GitHub', async () => {
  writeFileSync(join(stub, 'fail'), 'HTTP 401: Bad credentials (https://api.github.com/graphql)');
  const r = await create({ name: 'Offline', source: 'new' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.github_error, /Bad credentials/);
  assert.equal(r.data.repo_url, null);
  assert.equal(git(['rev-list', '--count', 'main'], r.data.repo_dir), '1', 'the local repo is kept');
  assert.equal((await s.call(`/api/projects/${r.data.id}`)).data.project.github_error, r.data.github_error);
  await minionStartsOnMain(r.data.id);

  writeFileSync(join(stub, 'fail'), 'error connecting to api.github.com');
  const again = await s.call(`/api/projects/${r.data.id}/github`, {});
  assert.equal(again.status, 502);
  assert.match(again.data.error, /error connecting/);
  assert.match((await s.call(`/api/projects/${r.data.id}`)).data.project.github_error, /error connecting/);

  rmSync(join(stub, 'fail'));
  const ok = await s.call(`/api/projects/${r.data.id}/github`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.github_error, null);
  assert.equal(ok.data.repo_url, 'https://github.com/test-owner/offline');
  assert.equal((await s.call(`/api/projects/${r.data.id}/github`, {})).status, 409, 'nothing left to retry');
  assert.equal((await s.call(`/api/projects/${(await create({ name: 'Plain', source: 'none' })).data.id}/github`, {})).status, 409);
});

test('when the repo was made but the push failed, Retry only pushes', async () => {
  writeFileSync(join(stub, 'fail-push'), '');
  const r = await create({ name: 'Half made', source: 'new' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.github_error, /failed to push/);
  rmSync(join(stub, 'fail-push'));
  rmSync(join(stub, 'calls'), { force: true });
  const ok = await s.call(`/api/projects/${r.data.id}/github`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.repo_url, 'https://github.com/test-owner/half-made');
  assert.deepEqual(ghCalls(), [], 'no second gh repo create');
  assert.equal(git(['rev-parse', 'main'], join(stub, 'remotes', 'test-owner_half-made.git')), git(['rev-parse', 'main'], r.data.repo_dir));
});
