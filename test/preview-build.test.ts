import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Previews } from '../src/previews.ts';
import { listeningPort, PASSWORD, SECRET, stopProcs, stopTurns } from './helpers.ts';
import { git } from './git.ts';

// A build's preview (src/previews.ts, build branches): /preview/build/<n>/ serves the tip of build/<n>
// in the scheme whose code this server runs, from a worktree the live server keeps of its own.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'preview-build-test-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});


// The scheme's repo: it holds the commit this server runs (so it is this server's own scheme), and build/7 at it.
const scheme = join(root, 'scheme');
mkdirSync(scheme);
git(scheme, 'init', '-q', '-b', 'main');
git(scheme, 'fetch', '-q', repo, 'HEAD');
const live = git(scheme, 'rev-parse', 'FETCH_HEAD');
git(scheme, 'branch', 'main', live);
git(scheme, 'branch', 'build/7', live);

const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'coordinator.db'));
const project = store.createProject('Citadel', null);
store.setProjectRepoDir(project.id, scheme);
store.db.close();
const worktree = join(data, 'projects', String(project.id), 'build-previews', '7');

let base = '';
let cookie = '';
const page = (path: string) => fetch(`${base}${path}`, { headers: { Accept: 'text/html', Cookie: cookie }, redirect: 'manual' });
const health = async () => (await fetch(`${base}/preview/build/7/api/health`, { headers: { Cookie: cookie } })).json();

before(async () => {
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', DATA_DIR: data, CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(server);
  server.stdout!.pipe(process.stdout);
  base = `http://127.0.0.1:${await listeningPort(server)}`;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: PASSWORD }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

test('a build with no branch has no preview', async () => {
  const res = await page('/preview/build/8/');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no build\/8 branch/);
});

test('a page load starts the preview from build/<n>, in a worktree of its own that leaves the branch free', async () => {
  assert.equal((await page('/preview/build/7')).headers.get('location'), '/preview/build/7/');
  const res = await page('/preview/build/7/');
  assert.equal(res.status, 302, await res.text()); // the preview's own redirect to its c/
  assert.equal(res.headers.get('location'), 'c/');
  const h = await health();
  assert.equal(h.preview, true);
  assert.equal(h.commit, live);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), live);
  // Detached: a feeder's fold can still move build/7.
  assert.throws(() => git(worktree, 'symbolic-ref', '-q', 'HEAD'));
});

test('the first page load after the tip moved restarts it on the new commit', async () => {
  const moved = git(scheme, 'commit-tree', `${live}^{tree}`, '-p', live, '-m', 'A feeder folded in');
  git(scheme, 'update-ref', 'refs/heads/build/7', moved);
  // Anything but a page load keeps the running one.
  assert.equal((await health()).commit, live);
  assert.equal((await page('/preview/build/7/')).status, 302);
  assert.equal((await health()).commit, moved);
});

test('a branch deleted while its preview boots leaves nothing running and no worktree', async () => {
  git(scheme, 'branch', 'build/11', live);
  const booting = page('/preview/build/11/');
  // Past its tip check, well inside the boot (checkout, copy, spawn and health checks: hundreds of ms).
  await new Promise((r) => setTimeout(r, 50));
  git(scheme, 'branch', '-D', 'build/11');
  assert.equal((await page('/preview/build/11/')).status, 404);
  await booting;
  assert.equal(existsSync(join(data, 'projects', String(project.id), 'build-previews', '11')), false);
  assert.equal(existsSync(join(data, 'previews', 'build-11')), false);
  // No preview left: a request that isn't a page load finds none running.
  assert.equal((await fetch(`${base}/preview/build/11/api/health`, { headers: { Cookie: cookie } })).status, 404);
});

test('a minion preview route never reads "build" as a ticket id', async () => {
  assert.equal((await page('/preview/build/')).status, 404);
  assert.equal((await page('/preview/buildx/7/')).status, 404);
});

test('once build/<n> is deleted, the preview stops and its worktree and copy of the data go', async () => {
  git(scheme, 'branch', '-D', 'build/7');
  assert.equal((await page('/preview/build/7/')).status, 404);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(join(data, 'previews', 'build-7')), false);
  assert.doesNotMatch(git(scheme, 'worktree', 'list'), /build-previews/);
});

test("the sweep removes a build's worktree whose branch went, without a page load", async () => {
  const dir = join(root, 'sweep');
  mkdirSync(dir);
  const s = new Store(join(dir, 'coordinator.db'));
  const p = s.createProject('Citadel', null);
  s.setProjectRepoDir(p.id, scheme);
  const previews = new Previews(s, dir);
  previews.buildScheme = () => s.getProject(p.id)!;
  const gone = join(dir, 'projects', String(p.id), 'build-previews', '9');
  git(scheme, 'worktree', 'add', '-q', '--detach', gone, live);
  const kept = join(dir, 'projects', String(p.id), 'build-previews', '10');
  git(scheme, 'branch', 'build/10', live);
  git(scheme, 'worktree', 'add', '-q', '--detach', kept, live);
  await previews.sweep();
  assert.equal(existsSync(gone), false);
  assert.equal(existsSync(kept), true);
  assert.doesNotMatch(git(scheme, 'worktree', 'list'), /build-previews\/9/);
  s.db.close();
});
