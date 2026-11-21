import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { repoSlug } from '../src/prlinks.ts';
import { repoName } from '../src/scheme-repo.ts';
import { bootServer, lines, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// A new scheme's code sources (#173). The server runs with HOME set to the scratch folder (so its
// data dir is under HOME) and a stub `gh` first on PATH: no test makes a real GitHub repo.
const root = mkdtempSync(join(tmpdir(), 'scheme-sources-'));
const stub = join(root, 'gh-stub');
const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: root } }).trim();
const commit = (cwd: string, m: string) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', m], cwd);
const ghCalls = () => lines(join(stub, 'calls'));

// `gh repo view` finds a repo when stub/taken/<owner>_<name> exists; `gh repo create` fails with
// stub/fail's text when that exists, and otherwise makes a bare repo standing in for GitHub's (and
// sets origin to it, failing the push when stub/fail-push exists). `calls` logs those; `gh pr list`
// and `gh api` aren't logged: they are the server's background looks (a minion's branch 2 s after
// its turn ends; CI health's first poll 45 s after boot, which a loaded run reaches mid-file, #1205),
// so they land in whichever test is running by then, and no test here is about them.
mkdirSync(join(stub, 'bin'), { recursive: true });
mkdirSync(join(stub, 'taken'));
writeFileSync(join(stub, 'bin', 'gh'), `#!/bin/sh
S=${JSON.stringify(stub)}
[ "$1 $2" = "pr list" ] && exit 0
[ "$1" = api ] && exit 0
echo "$*" >> "$S/calls"
echo "\${GH_TOKEN:-box} $*" >> "$S/as"
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
// A git that logs whose token each clone ran with ("box" for the server's own login), and when and where each `cat-file`
// asked for a commit (#1469), and runs the real one.
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
writeFileSync(join(stub, 'bin', 'git'), `#!/bin/sh
[ "$1" = cat-file ] && echo "$(date +%s) $(pwd)" >> ${JSON.stringify(join(stub, 'cat-file'))}
[ "$1" = clone ] && echo "\${GH_TOKEN:-box} \${GH_CONFIG_DIR:-box-config} $*" >> ${JSON.stringify(join(stub, 'clones'))}
exec ${JSON.stringify(realGit)} "$@"
`);
chmodSync(join(stub, 'bin', 'git'), 0o755);
const asCalls = () => lines(join(stub, 'as'));
const clones = () => lines(join(stub, 'clones'));

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
  // With an OAuth App set up, so people's own GitHub links count (#195); never a GH_TOKEN of the test's own.
  s = await bootServer({ root, env: { HOME: root, PATH: `${join(stub, 'bin')}:${process.env.PATH}`, GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: undefined } });
});
after(async () => {
  await s?.stop();
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
    // The server's HOME is root, so its parent is outside that HOME.
    [dirname(root), /under your home folder/],
    [join(s.data, 'projects', '1'), /data folder/],
    [s.data, /data folder/],
    [join(root, 'code', 'loose'), /isn't a git repo/],
    [join(root, 'code', 'plain', 'sub'), /inside the git repo at/],
    [join(root, 'code', 'empty'), /no commits/],
  ];
  const count = (await s.call('/api/projects')).data.length;
  for (const [i, [folder, why]] of cases.entries()) {
    // Not the folder in the name: a long TMPDIR pushes it past the 80-character cap.
    const r = await create({ name: `Refused ${i}`, source: 'folder', folder });
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

// #195: anyone who has linked GitHub makes a new repo on their own account with their own token;
// the box's login (Cara's) only ever works for admins.
test('non-admins: New repo goes on their own GitHub with their token, or is refused until they link', async () => {
  const store = new Store(join(s.data, 'coordinator.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  new Credentials(store, SECRET).put(josh.id, 'github', 'gho_josh', { login: 'joshgh', id: 7, name: 'Josh' });
  const auth = new Auth(PASSWORD, SECRET);
  const as = (u: { id: number; name: string }) => async (path: string, body?: unknown) => {
    const r = await fetch(s.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: auth.issueCookie(u, false).split(';')[0], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const asJosh = as(josh);
  const asOlive = as(olive);
  rmSync(join(stub, 'as'), { force: true });

  // Unlinked: refused before anything exists, and never on the box's login.
  const count = (await s.call('/api/projects')).data.length;
  const no = await asOlive('/api/projects', { name: 'Olive repo', source: 'new' });
  assert.equal(no.status, 403);
  assert.match(no.data.error, /Link GitHub in Settings → Your account/);
  assert.equal((await s.call('/api/projects')).data.length, count);
  assert.deepEqual(asCalls(), []);
  // A folder on the server stays admin-only, linked or not.
  assert.equal((await asJosh('/api/projects', { name: 'Josh folder', source: 'folder', folder: join(root, 'seed') })).status, 403);

  // Linked: under their own login, with their token, private.
  writeFileSync(join(stub, 'taken', 'joshgh_josh-taken'), '');
  const taken = await asJosh('/api/projects', { name: 'Josh taken', source: 'new' });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /joshgh\/josh-taken already exists/);
  const r = await asJosh('/api/projects', { name: 'Josh Game', source: 'new' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.repo_url, 'https://github.com/joshgh/josh-game');
  assert.equal(r.data.owner_id, josh.id);
  assert.deepEqual(asCalls().slice(-2), ['gho_josh repo view joshgh/josh-game --json name', `gho_josh repo create joshgh/josh-game --private --source ${r.data.repo_dir} --remote origin --push`]);
  assert.ok(asCalls().every((c) => c.startsWith('gho_josh ')), 'never the box login');

  // Retry: any member may (#621), and it goes on the owner's GitHub with the owner's token, as an admin's does too.
  writeFileSync(join(stub, 'fail'), 'HTTP 502');
  const failed = await asJosh('/api/projects', { name: 'Josh Retry', source: 'new' });
  assert.equal(failed.status, 201, JSON.stringify(failed.data));
  assert.match(failed.data.github_error, /HTTP 502/);
  rmSync(join(stub, 'fail'));
  store.addMember(failed.data.id, olive.id);
  const ok = await asOlive(`/api/projects/${failed.data.id}/github`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.repo_url, 'https://github.com/joshgh/josh-retry');
  assert.equal(asCalls().at(-1), `gho_josh repo create joshgh/josh-retry --private --source ${failed.data.repo_dir} --remote origin --push`);

  // An owner who unlinked since can't retry, even when an admin presses it: it would be the box's login.
  writeFileSync(join(stub, 'fail'), 'HTTP 502');
  const later = await asJosh('/api/projects', { name: 'Josh Later', source: 'new' });
  rmSync(join(stub, 'fail'));
  store.deleteCredential(josh.id, 'github');
  const before = asCalls().length;
  assert.equal((await asJosh(`/api/projects/${later.data.id}/github`, {})).status, 403);
  const byAdmin = await s.call(`/api/projects/${later.data.id}/github`, {});
  assert.equal(byAdmin.status, 403);
  assert.match(byAdmin.data.error, /Link GitHub/);
  assert.equal(asCalls().length, before, 'no gh call on anyone else\'s login');

});

test('cloning by URL: an admin uses the box login; anyone else their own token or none, and https only', async () => {
  const store = new Store(join(s.data, 'coordinator.db'));
  const linked = store.createUser({ name: 'Rae', login: 'rae' });
  const unlinked = store.createUser({ name: 'Uma', login: 'uma' });
  new Credentials(store, SECRET).put(linked.id, 'github', 'gho_rae', { login: 'raegh', id: 8, name: null });

  const auth = new Auth(PASSWORD, SECRET);
  const create = (u: { id: number; name: string } | null, body: object) => u
    ? fetch(s.base + '/api/projects', { method: 'POST', headers: { Cookie: auth.issueCookie(u, false).split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }))
    : s.call('/api/projects', body);
  const url = 'https://example.test/remote.git';
  for (const [who, name, token] of [[null, 'Admin clone', 'box'], [linked, 'Rae clone', 'gho_rae'], [unlinked, 'Uma clone', 'box']] as const) {
    rmSync(join(stub, 'clones'), { force: true });
    const r = await create(who, { name, source: 'url', repoUrl: url });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const [line] = clones();
    assert.ok(line.startsWith(`${token} `), line);
    // Not the admin's: an empty gh config, so the box's gh login can't answer git's credential ask either.
    if (who) assert.match(line, new RegExp(`^${token} ${join(s.data, 'people', String(who.id), 'gh')} `), line);
    else assert.match(line, /^box box-config /, line);
  }
  // A git@ URL would use the server's SSH key: admins only.
  const ssh = await create(linked, { name: 'Rae ssh', source: 'url', repoUrl: 'git@github.com:someone/hub.git' });
  assert.equal(ssh.status, 400);
  assert.match(ssh.data.error, /https:\/\/ URL/);
});

// #1469: no scheme here has the server's own commit, so the server's look for the scheme it runs finds none. Asking every
// repo again on every call made 1,159 git calls in one run of this file and held a loaded runner's loop until the folder
// test timed out; a repo that lacks the commit is asked again only after a minute.
test('the server asks each scheme\'s repo for its own commit a few times, not on every call', () => {
  const asks = lines(join(stub, 'cat-file')).map((l) => [Number(l.slice(0, l.indexOf(' '))), l.slice(l.indexOf(' ') + 1)] as const);
  assert.ok(asks.length > 0, 'the server looked for its scheme');
  const minutes = (asks.at(-1)![0] - asks[0][0]) / 60;
  for (const dir of new Set(asks.map(([, d]) => d))) {
    const n = asks.filter(([, d]) => d === dir).length;
    assert.ok(n <= 4 + 2 * minutes, `${dir} was asked ${n} times in ${minutes.toFixed(1)} min`);
  }
});
