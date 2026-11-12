import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { agentToken, bootServer, stopProcs, stopTurns, testPins } from './helpers.ts';
import { scriptEnv } from './script-env.ts';
testPins();

// Safe deploys (tools/deploy.sh): the server reloads public/ on SIGHUP, answers /api/health, and takes
// deploy reports; the script tells front-end-only changes from the rest.
const repo = join(import.meta.dirname, '..');
// The scripts refuse to run in a person's Claude container (COORDINATOR_CONTAINER=1); these tests stand in for the host.
// DEPLOY_LOCKED and DEPLOY_TESTED leak in when this suite runs under a deploy (#514).
// COORDINATOR_SHARED_DIR: a minion's or a landing's real one would get the test restarts' timing lines (#565).
const hostEnv = { ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined };
const root = mkdtempSync(join(tmpdir(), 'deploy-test-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

// The server serves the public/ beside its own server.ts, so run a copy whose front end we can edit.
const app = join(root, 'app');
for (const d of ['server.ts', 'src', 'public']) cpSync(join(repo, d), join(app, d), { recursive: true });
const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'coordinator.db'));
const project = store.createProject('Test', null);
const ticket = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
const token = agentToken(data, ticket.id);

let base = '';
let cookie = '';
let server: ChildProcess;
const health = async () => (await fetch(`${base}/api/health`)).json() as Promise<{ ok: boolean; commit: string | null; version: string; reload: string; fallbacks: number }>;

before(async () => {
  const srv = await bootServer({ root, script: join(app, 'server.ts'), stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  server = srv.proc;
  procs.push(server);
});

test('/api/health answers without a login and says the server reloads on SIGHUP', async () => {
  const h = await health();
  assert.equal(h.ok, true);
  assert.equal(h.reload, 'sighup');
  assert.match(h.version, /^[0-9a-f]{12}$/);
  assert.equal(h.commit, null, 'the copy is not a git checkout');
  assert.equal(h.fallbacks, 0, 'no job has fallen back to running in the server since it started (#519)');
});

test('SIGHUP swaps the served front end and its fingerprint, and tells open tabs', async () => {
  const before = await health();
  // An open tab's stream: its first message is the hello with the version it loaded.
  const stream = await fetch(`${base}/api/stream`, { headers: { Cookie: cookie } });
  const reader = stream.body!.getReader();
  let seen = '';
  const hellos = async (n: number) => {
    for (const end = Date.now() + 5000; (seen.match(/"type":"hello"/g) ?? []).length < n; ) {
      if (Date.now() > end) throw new Error(`Timed out waiting for hello #${n}: ${seen}`);
      seen += new TextDecoder().decode((await reader.read()).value);
    }
  };
  await hellos(1);
  assert.ok(seen.includes(before.version));

  appendFileSync(join(app, 'public', 'index.html'), '\n<!-- deployed by SIGHUP -->\n');
  server.kill('SIGHUP');
  let after = before;
  for (const end = Date.now() + 5000; after.version === before.version; await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) throw new Error('The front end did not change after SIGHUP');
    after = await health();
  }
  assert.equal(server.exitCode, null, 'the server is still running');
  assert.match(await (await fetch(`${base}/`)).text(), /deployed by SIGHUP/);
  await hellos(2);
  assert.ok(seen.includes(`"version":"${after.version}"`), 'open tabs hear the new version');
  await reader.cancel();
});

test("after a SIGHUP reload /api/health reports the checkout's new commit, so a revert of it is not \"nothing to deploy\" (#468 S10-1)", async () => {
  const gitRoot = join(root, 'git-app');
  const gitApp = join(gitRoot, 'app');
  for (const d of ['server.ts', 'src', 'public']) cpSync(join(repo, d), join(gitApp, d), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: gitApp, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'boot');
  const booted = git('rev-parse', 'HEAD');
  const srv = await bootServer({ root: gitRoot, script: join(gitApp, 'server.ts') });
  procs.push(srv.proc);
  const h = async () => (await fetch(`${srv.base}/api/health`)).json() as Promise<{ commit: string | null; version: string }>;
  const first = await h();
  assert.equal(first.commit, booted);
  appendFileSync(join(gitApp, 'public', 'index.html'), '\n<!-- front end only -->\n');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'front end');
  const deployed = git('rev-parse', 'HEAD');
  srv.proc.kill('SIGHUP');
  let after = first;
  for (const end = Date.now() + 5000; after.version === first.version; await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) throw new Error('The front end did not change after SIGHUP');
    after = await h();
  }
  assert.equal(after.commit, deployed);
  await srv.stop();
});

test('a SIGHUP with a broken public/ keeps serving the old front end', async () => {
  const before = await health();
  writeFileSync(join(app, 'public', 'manifest.webmanifest'), '{ not json');
  server.kill('SIGHUP');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.exitCode, null);
  assert.equal((await health()).version, before.version);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('a minion reports its deploy: failures show as errors, only for its own chat', async () => {
  const post = (id: number, body: object) => fetch(`${base}/api/tickets/${id}/deploy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(ticket.id, { ok: true, text: 'Deployed abc1234' })).status, 201);
  assert.equal((await post(ticket.id, { ok: false, text: 'Deploy of def5678 failed; rolled back' })).status, 201);
  assert.equal((await post(ticket.id + 1, { ok: true, text: 'not mine' })).status, 403);
  const events = store.listEvents(ticket.id).map((e) => ({ kind: e.kind, text: JSON.parse(e.data).text }));
  assert.deepEqual(events.slice(-2), [
    { kind: 'note', text: 'Deployed abc1234' },
    { kind: 'error', text: 'Deploy of def5678 failed; rolled back' },
  ]);
});

test('an ok report dismisses a minion in pending-deploy; a failed one leaves it be', async () => {
  const post = (ok: boolean) => fetch(`${base}/api/tickets/${ticket.id}/deploy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok, text: 'x' }),
  }).then((r) => r.json());
  store.updateTicket(ticket.id, { status: 'idle', state: 'pending-deploy' });
  assert.deepEqual(await post(false), { dismissed: false });
  assert.equal(store.getTicket(ticket.id)!.state, 'pending-deploy');
  assert.deepEqual(await post(true), { dismissed: true });
  assert.equal(store.getTicket(ticket.id)!.status, 'closed');
});

test('a warning (live, but not pushed to GitHub) shows as an error and still dismisses', async () => {
  const t = store.createTicket({ project_id: project.id, title: 'W', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { status: 'idle', state: 'pending-deploy' });
  const text = 'Deployed abc1234. Not pushed to GitHub: rejected. The next deploy will retry.';
  const res = await fetch(`${base}/api/tickets/${t.id}/deploy`, {
    method: 'POST', headers: { Authorization: `Bearer ${agentToken(data, t.id)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, warn: true, text }),
  });
  assert.deepEqual(await res.json(), { dismissed: true });
  assert.equal(store.getTicket(t.id)!.status, 'closed');
  assert.ok(store.listEvents(t.id).some((e) => e.kind === 'error' && JSON.parse(e.data).text === text));
});

test("deploy.sh refuses to run in a person's container, before touching anything", () => {
  const r = spawnSync('bash', [join(repo, 'tools', 'deploy.sh')], { encoding: 'utf8', env: { ...hostEnv, COORDINATOR_CONTAINER: '1', DEPLOY_LIVE: join(root, 'no-live') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runs in a container: land with the land tool/);
});

test('deploy.sh tells front-end-only changes from the rest', () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', join(root, 'g'), ...args], { encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'g', 'public'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const commit = (file: string) => {
    writeFileSync(join(root, 'g', file), String(Math.random()));
    git('add', '-A');
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  const a = commit('server.ts');
  const b = commit('public/app.js');
  const c = commit('public/style.css');
  const d = commit('server.ts');
  const kind = (from: string, to: string) =>
    execFileSync('bash', [join(repo, 'tools', 'deploy.sh'), 'change-kind', join(root, 'g'), from, to], { encoding: 'utf8', env: hostEnv }).trim();
  assert.equal(kind(a, c), 'frontend');
  assert.equal(kind(b, c), 'frontend');
  assert.equal(kind(a, d), 'server', 'any change outside public/ restarts');
  assert.equal(kind(c, d), 'server');
  assert.equal(kind(c, c), 'none');
  assert.equal(kind('', c), 'server', 'an unknown running commit restarts');
});

test('deploy.sh waits only for turns a restart would cut off; a server from before units counts every running turn', async () => {
  // Async, so the stand-in server below (in this process) can answer.
  // DEPLOY_SERVICE names no unit, so the service reads as down; extra PATH entries stand in for systemctl.
  const count = async (url: string, path = '') =>
    (await promisify(execFile)('bash', [join(repo, 'tools', 'deploy.sh'), 'interruptible'], { encoding: 'utf8', env: { ...hostEnv, PATH: `${path}${process.env.PATH}`, DEPLOY_URL: url, DEPLOY_DB: join(data, 'coordinator.db'), DEPLOY_SERVICE: 'no-such-citadel-unit' } })).stdout.trim();
  assert.equal(await count(base), '0');
  assert.equal(await count('http://127.0.0.1:9'), '0', 'a server that is down has no turns to cut off');
  // One that doesn't answer while its unit is up is slow or stuck, not down: keep waiting (#468 S10-6).
  const active = join(root, 'active-bin');
  mkdirSync(active, { recursive: true });
  writeFileSync(join(active, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await count('http://127.0.0.1:9', `${active}:`), '?', 'refused while its unit is active');
  const silent = createHttpServer(() => {}); // takes the request, never answers
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(silent.address() as any).port}`;
    assert.equal(await count(url, `${active}:`), '?', 'a server too slow to answer is not counted as having no turns');
    assert.equal(await count(url), '0', 'nor is one whose unit is down kept waiting on');
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
  const old = createHttpServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"reload":"sighup"}'));
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
  const running = store.createTicket({ project_id: project.id, title: 'Busy', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(running.id, { status: 'running' });
  try {
    assert.equal(await count(`http://127.0.0.1:${(old.address() as any).port}`), '1');
  } finally {
    store.updateTicket(running.id, { status: 'idle' });
    old.close();
  }
});

test("deploy.sh names the same turn units as the runner, so a rollback stops only this server's", () => {
  const units = execFileSync('bash', [join(repo, 'tools', 'deploy.sh'), 'turn-units'], { encoding: 'utf8', env: { ...hostEnv, DEPLOY_DB: join(data, 'coordinator.db') } }).trim();
  const tag = (new Runner(store, () => {}, () => ({})) as any).unitTag;
  assert.equal(units, `citadel-turn-${tag}-*.service`);
});

test('deploy.sh pushes the live commit to main, never forced, and a failed push only reports', () => {
  const live = join(root, 'live');
  const remote = join(root, 'remote.git');
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', live]);
  git(live, 'config', 'user.email', 't@t');
  git(live, 'config', 'user.name', 't');
  // A Claude session started in the live clone turns the pre-push hook on (tools/guard.sh --install); this push is the one meant to reach main.
  cpSync(join(repo, '.githooks'), join(live, '.githooks'), { recursive: true });
  git(live, 'config', 'core.hooksPath', '.githooks');
  const commit = () => {
    git(live, 'commit', '-q', '--allow-empty', '-m', String(Math.random()));
    return git(live, 'rev-parse', 'HEAD');
  };
  // Failed pushes go to the journal; a test tag keeps them out of the real deploy unit's log.
  const env = { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_UNIT: 'deploy-test-push' };
  // Status 1 makes the deploy report a warning; the deploy itself carries on.
  const push = (sha: string, to = remote) => {
    const r = spawnSync('bash', [join(repo, 'tools', 'deploy.sh'), 'push-github', sha], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, DEPLOY_REMOTE: to },
    });
    return { status: r.status, out: r.stdout.trimEnd() };
  };
  const a = commit();
  assert.deepEqual(push(a), { status: 0, out: ' Pushed to GitHub.' });
  assert.equal(git(remote, 'rev-parse', 'main'), a);
  const b = commit();
  assert.deepEqual(push(b), { status: 0, out: ' Pushed to GitHub.' }, 'a fast-forward');
  assert.equal(git(remote, 'rev-parse', 'main'), b);

  git(live, 'reset', '-q', '--hard', a);
  const c = commit();
  assert.deepEqual(push(c), {
    status: 1,
    out: " Not pushed to GitHub: its main has commits that aren't live, so nothing was forced. The next deploy will retry. GitHub main has diverged: a person needs to look.",
  });
  assert.equal(git(remote, 'rev-parse', 'main'), b, 'a diverged main is left alone');

  const gone = push(c, join(root, 'nowhere.git'));
  assert.equal(gone.status, 1);
  assert.match(gone.out, /^ Not pushed to GitHub: fatal: .*nowhere\.git.* The next deploy will retry\.$/, 'the reason, and no fix to offer');

  // A login GitHub refuses gets the fix line (simulated by a remote hook that denies the push).
  const denied = join(root, 'denied.git');
  execFileSync('git', ['init', '-q', '--bare', denied]);
  writeFileSync(join(denied, 'hooks', 'pre-receive'), '#!/bin/sh\necho "Permission denied to someone." >&2\nexit 1\n', { mode: 0o755 });
  assert.match(push(c, denied).out, /The next deploy will retry\. GitHub refused the login: run gh auth status/);

  assert.deepEqual(spawnSync('bash', [join(repo, 'tools', 'deploy.sh'), 'push-github', c], {
    encoding: 'utf8', env: { ...env, DEPLOY_REMOTE: '' },
  }).stdout, '', 'an empty DEPLOY_REMOTE skips the push');
});

test('deploy.sh copies the database before a restart, keeps a copy already there, and rotates to 3', () => {
  const live = join(root, 'backup-live');
  const dir = join(root, 'backup-data');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', live]);
  const file = join(dir, 'coordinator.db');
  const db = new Store(file);
  db.createProject('Saved', null);
  const commits = [1, 2, 3, 4].map((n) => {
    execFileSync('git', ['-C', live, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', String(n)]);
    return execFileSync('git', ['-C', live, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  });
  const deploySh = (args: string[], db = file) =>
    execFileSync('bash', [join(repo, 'tools', 'deploy.sh'), ...args], { encoding: 'utf8', env: { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_DB: db } }).trim();
  for (const [i, c] of commits.entries()) {
    const out = deploySh(['backup-db', c]);
    assert.equal(out, join(dir, 'backups', `pre-deploy-${c}.db`));
    utimesSync(out, 1e9 + i, 1e9 + i); // in deploy order, without waiting out ls -t's resolution
  }
  assert.equal(readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('pre-deploy-')).length, 4, 'nothing rotates until a deploy is healthy');
  const first = join(dir, 'backups', `pre-deploy-${commits[0]}.db`);
  db.createProject('After the deploy', null);
  deploySh(['backup-db', commits[0]]);
  const kept = new Store(first);
  assert.deepEqual(kept.listProjects().map((p) => p.name), ['Saved'], 'a retry keeps the clean copy');
  kept.db.close();

  deploySh(['rotate-backups']);
  const saved = readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('pre-deploy-')).sort(); // opening a copy adds its state.db
  assert.deepEqual(saved, commits.slice(1).map((c) => `pre-deploy-${c}.db`).sort(), 'the oldest copy goes');
  assert.equal(statSync(join(dir, 'backups', saved[0])).mode & 0o777, 0o600);
  assert.equal(deploySh(['backup-db', commits[0]], join(dir, 'missing.db')), '', 'no database, nothing to copy');
  assert.ok(!existsSync(join(dir, 'missing.db')), 'and none is created');
  assert.equal(deploySh(['rotate-backups'], join(root, 'nowhere', 'coordinator.db')), '', 'no copies, nothing to rotate');
});

test('the restart refuses to restart when it cannot copy the database first', () => {
  const live = join(root, 'refuse-live');
  const dir = join(root, 'refuse-data');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', live]);
  execFileSync('git', ['-C', live, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  new Store(join(dir, 'coordinator.db')).db.close();
  writeFileSync(join(dir, 'backups'), 'not a folder');
  const copy = join(root, 'refuse-deploy.sh');
  cpSync(join(repo, 'tools', 'deploy.sh'), copy);
  const r = spawnSync('bash', [copy, 'restart'], {
    encoding: 'utf8',
    env: { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_DB: join(dir, 'coordinator.db'), DEPLOY_NOW: '1', DEPLOY_URL: 'http://127.0.0.1:1', DEPLOY_SERVICE: 'no-such-citadel-unit', DEPLOY_REMOTE: '' },
  });
  assert.equal(r.status, 1);
  // F12e: the report names the file and the cause, not only the journal.
  assert.match(r.stderr, /FAILED: Could not copy the database to \S+\/refuse-data\/backups\/pre-deploy-\w+\.db \(mkdir: [^)]*backups[^)]*\) before restarting on .*so nothing restarted/);
  assert.doesNotMatch(r.stderr, /restarting no-such-citadel-unit/);
  // Run by hand as tools/deploy.sh restart, it must not delete the tracked script: only the unit's private copy goes.
  assert.ok(existsSync(copy), 'a script that is not the private copy stays');
  const own = join(live, '.git', 'cc-deploy', 'restart-abc-1.sh');
  cpSync(copy, own);
  assert.equal(spawnSync('bash', [own, 'restart'], { encoding: 'utf8', env: { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_DB: join(dir, 'coordinator.db'), DEPLOY_NOW: '1', DEPLOY_URL: 'http://127.0.0.1:1', DEPLOY_SERVICE: 'no-such-citadel-unit', DEPLOY_REMOTE: '' } }).status, 1);
  assert.ok(!existsSync(own), 'the private copy is deleted');
  const usage = spawnSync('bash', [copy, 'no-such-command'], { encoding: 'utf8', env: hostEnv });
  assert.equal(usage.status, 2);
  assert.doesNotMatch(usage.stderr, /restart/, 'the usage line does not offer the restart');
});

// M11: two minions that ride one restart were both told about its tip commit, so the one whose own commit was older
// read only about the other's.
test("each minion's report of a restart names its own commit when the restart carried newer ones too", { timeout: 30_000 }, async () => {
  const live = join(root, 'ride-live');
  const dir = join(root, 'ride-data');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', live]);
  const commit = (m: string) => {
    execFileSync('git', ['-C', live, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m]);
    return execFileSync('git', ['-C', live, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };
  const mine = commit('mine');
  const theirs = commit('theirs');
  new Store(join(dir, 'coordinator.db')).db.close();
  writeFileSync(join(dir, 'backups'), 'not a folder'); // the restart fails at its first step, and reports
  const srv = await standIn(() => 201);
  try {
    mkdirSync(join(live, '.git', 'cc-deploy'), { mode: 0o700 });
    // Three fields in reporters, as a restart queued by an older deploy.sh reads them; the commits beside them.
    writeFileSync(join(live, '.git', 'cc-deploy', 'reporters'), `${srv.url} tok 7\n${srv.url} tok 8\n`);
    writeFileSync(join(live, '.git', 'cc-deploy', 'reporter-commits'), `7 ${mine}\n8 ${theirs}\n`);
    const copy = join(root, 'ride-deploy.sh');
    cpSync(join(repo, 'tools', 'deploy.sh'), copy);
    await promisify(execFile)('bash', [copy, 'restart'], { encoding: 'utf8', env: { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_DB: join(dir, 'coordinator.db'), DEPLOY_NOW: '1', DEPLOY_URL: 'http://127.0.0.1:1', DEPLOY_SERVICE: 'no-such-citadel-unit', DEPLOY_REMOTE: '' } }).catch((e) => e);
    const text = (t: string) => JSON.parse(srv.seen.find((s) => s.url === `/api/tickets/${t}/deploy`)!.body).text as string;
    const s7 = mine.slice(0, 7), s8 = theirs.slice(0, 7);
    assert.match(text('7'), new RegExp(`^Could not copy the database .* This restart was for your ${s7}\\w* "mine" and the newer commits up to ${s8}\\w* "theirs"\\.$`));
    assert.doesNotMatch(text('8'), /This restart was for your/, 'the tip is its own');
    assert.ok(!existsSync(join(live, '.git', 'cc-deploy', 'reporter-commits')), 'gone with reporters');
  } finally {
    srv.close();
  }
});

test('deploy.sh copies the database while the live server keeps writing it (#497)', { timeout: 60_000 }, async () => {
  const live = join(root, 'busy-live');
  const dir = join(root, 'busy-data');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', live]);
  execFileSync('git', ['-C', live, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', '1']);
  const commit = execFileSync('git', ['-C', live, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const file = join(dir, 'coordinator.db');
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE events (id INTEGER PRIMARY KEY, data TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO events (data) SELECT randomblob(1000) FROM n");
  const write = db.prepare('INSERT INTO events (data) VALUES (randomblob(100))');
  // A stepped copy (sqlite3's .backup) restarts on every write from another connection, so it never ends.
  const writer = setInterval(() => write.run(), 1);
  const out = await promisify(execFile)('bash', [join(repo, 'tools', 'deploy.sh'), 'backup-db', commit], { encoding: 'utf8', timeout: 20_000, env: { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_DB: file } })
    .finally(() => clearInterval(writer));
  db.close();
  const saved = out.stdout.trim();
  assert.equal(saved, join(dir, 'backups', `pre-deploy-${commit}.db`));
  const copy = new DatabaseSync(saved, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.ok((copy.prepare('SELECT count(*) n FROM events').get()!.n as number) >= 20000);
  copy.close();
});

// A stand-in server whose answer to each request the test picks: 'reset' drops the connection unanswered,
// 'hang' never answers, a number is the status to answer with, a string is a 200 JSON body. Each request's
// `at` is performance.now(), not Date.now(): tests time deploy.sh by the gaps between them, and a wall clock
// can step (CI's WSL runner steps back ~2.2 s every ~32 s, which made a 3 s gap read as 0.8 s, #528).
async function standIn(answer: (req: import('node:http').IncomingMessage, body: string) => 'reset' | 'hang' | number | string | Promise<string>) {
  const seen: { url: string; body: string; at: number }[] = [];
  const srv = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', async () => {
      seen.push({ url: req.url ?? '', body, at: performance.now() });
      const a = await answer(req, body);
      if (a === 'reset') return req.socket.destroy();
      if (a === 'hang') return;
      if (typeof a === 'number') return res.writeHead(a).end('{}');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(a);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('deploy.sh retries a report the server never got, but not one it may already have (#520)', { timeout: 60_000 }, async () => {
  // A curl that notes a turn token on its command line, where any process on the box could read it, then runs the real one.
  const bin = join(root, 'curl-bin');
  const leaked = join(root, 'curl-leaked');
  mkdirSync(bin);
  const curl = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();
  const tries = join(root, 'curl-tries');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho >>'${tries}'\ncase "$*" in *tok-secret*) echo "$*" >>'${leaked}' ;; esac\nexec '${curl}' "$@"\n`, { mode: 0o755 });
  const tried = () => (existsSync(tries) ? readFileSync(tries, 'utf8').length : 0);
  const post = (url: string, env: object = {}) => promisify(execFile)('bash', [join(repo, 'tools', 'deploy.sh'), 'post-report', url, 'tok-secret', '7', 'ok', 'Deployed abc1234'], { encoding: 'utf8', env: { ...hostEnv, PATH: `${bin}:${process.env.PATH}`, ...env } });
  // Dropped unanswered, then a 503: neither got the report in, so it goes again, with the same body.
  const auth: (string | undefined)[] = [];
  const flaky = await standIn((req) => (auth.push(req.headers.authorization), flaky.seen.length === 1 ? 'reset' : flaky.seen.length === 2 ? 503 : 201));
  try {
    const r = await post(flaky.url);
    assert.equal(flaky.seen.length, 3);
    assert.deepEqual(auth, Array(3).fill('Bearer tok-secret'), 'the token still reaches the server');
    assert.ok(!existsSync(leaked), 'and is not on curl\'s command line');
    assert.ok(flaky.seen.every((s) => s.url === '/api/tickets/7/deploy' && JSON.parse(s.body).text === 'Deployed abc1234'));
    assert.doesNotMatch(r.stderr, /could not post/);
  } finally {
    flaky.close();
  }
  // No answer in time: the server has the request (a slow restart handles it seconds later), so a retry would post it twice.
  const slow = await standIn(() => 'hang');
  try {
    const r = await post(slow.url, { DEPLOY_REPORT_WAIT: '1' });
    assert.equal(slow.seen.length, 1);
    assert.match(r.stderr, /no answer from the server within 1 s/);
  } finally {
    slow.close();
  }
  // A connection never made in time is a report the server never got: it goes again.
  const t0 = performance.now();
  const triedBefore = tried();
  const r = await post('http://10.255.255.1:9', { DEPLOY_REPORT_WAIT: '1', DEPLOY_REPORT_RETRY: '3' });
  assert.match(r.stderr, /could not post the report to minion 7's chat \(curl exit (28|7)\)/);
  assert.doesNotMatch(r.stderr, /no answer from the server/);
  // bash's SECONDS counts whole wall-clock seconds, so 3 s of retries end after 2 to 3 s (#564: 2.05 s when started just
  // before a second ticks over). One try with no retry takes about 0 s (refused) or 1 s (timed out).
  assert.ok(performance.now() - t0 >= 2000, 'retried until DEPLOY_REPORT_RETRY ran out');
  assert.ok(tried() - triedBefore >= 2, 'more than one try');
  // A refusal won't change on a retry.
  const refused = await standIn(() => 403);
  try {
    const r = await post(refused.url);
    assert.equal(refused.seen.length, 1);
    assert.match(r.stderr, /could not post the report to minion 7's chat \(HTTP 403\)/);
  } finally {
    refused.close();
  }
});

// The queued restart against a stand-in server and systemctl: commits good (last-good) and target (HEAD).
async function restartWith(name: string, health: (restarts: number, n: number, ctx: { good: string; target: string; pidFile: string }) => 'hang' | number | string | Promise<string>, extra: Record<string, string> = {}) {
  const live = join(root, `${name}-live`);
  const git = (...args: string[]) => execFileSync('git', ['-C', live, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', live]);
  git('commit', '-q', '--allow-empty', '-m', 'good');
  const good = git('rev-parse', 'HEAD');
  git('tag', 'last-good');
  git('commit', '-q', '--allow-empty', '-m', 'target');
  const target = git('rev-parse', 'HEAD');
  const bin = join(root, `${name}-bin`);
  const log = join(root, `${name}-systemctl.log`);
  mkdirSync(bin);
  const pidFile = join(root, `${name}-mainpid`);
  writeFileSync(pidFile, '100');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >>'${log}'\n[ "$2" = show ] && cat '${pidFile}'\nexit 0\n`, { mode: 0o755 });
  const restarts = () => (existsSync(log) ? String(readFileSync(log, 'utf8').split(' restart ').length - 1) : '0');
  let n = 0;
  const state = join(live, '.git', 'cc-deploy');
  // What a waiting landing would see: the restart's phase at each request. Each report's answer is held until all
  // three minions' reports are in (or 5 s: posted one after another, the first would wait on the others for ever),
  // and each notes whether the restart still held the lock: letting go there has the next deploy find the unit
  // "already" queued, with its restart behind it.
  const phases = new Set<string>();
  const lockHeldAtReport: boolean[] = [];
  const held: (() => void)[] = [];
  let together = true;
  const srv = await standIn((req) => {
    try { phases.add(readFileSync(join(state, 'restart'), 'utf8').split('\n')[1]); } catch {}
    if (req.url === '/api/health') return health(Number(restarts()), ++n, { good, target, pidFile });
    lockHeldAtReport.push(spawnSync('flock', ['-n', join(state, 'restart.lock'), 'true']).status !== 0);
    return new Promise<string>((ok) => {
      const late = setTimeout(() => { together = false; ok('{}'); }, 5000);
      held.push(() => { clearTimeout(late); ok('{}'); });
      if (held.length === 3) for (const go of held) go();
    });
  });
  mkdirSync(state);
  writeFileSync(join(state, 'reporters'), `${srv.url} tok 9\n${srv.url} tok 10\n${srv.url} tok 11\n`);
  const copy = join(root, `${name}-deploy.sh`);
  cpSync(join(repo, 'tools', 'deploy.sh'), copy);
  try {
    const r = await promisify(execFile)('bash', [copy, 'restart'], {
      encoding: 'utf8',
      env: { ...hostEnv, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: live, DEPLOY_DB: join(root, `${name}-no.db`), DEPLOY_NOW: '1', DEPLOY_URL: srv.url, DEPLOY_SERVICE: 'citadel-test', DEPLOY_REMOTE: '', DEPLOY_HEALTHY_WAIT: '3', DEPLOY_SETTLE: '2', ...extra },
    }).then((o) => ({ status: 0, stderr: o.stderr }), (e) => ({ status: e.code as number, stderr: e.stderr as string }));
    const reports = srv.seen.filter((s) => s.url === '/api/tickets/9/deploy').map((s) => ({ ...JSON.parse(s.body), at: s.at }));
    const healthAt = srv.seen.filter((s) => s.url === '/api/health').map((s) => s.at);
    return { ...r, good, target, reports, healthAt, phases: [...phases], lockHeldAtReport, together: () => together, noteLeft: existsSync(join(state, 'restart')), head: git('rev-parse', 'HEAD'), lastGood: git('rev-parse', 'last-good'), restarts: Number(restarts()) };
  } finally {
    srv.close();
  }
}

// F6: after a failed rollback the unit can read "active" while health is silent; the restart then waited its whole
// 2 h on a server that could not say whether a turn was running, with nothing logged.
test('a restart whose server stays up but silent stops waiting after a short while, says why, and restarts', { timeout: 60_000 }, async () => {
  const health = (commit: string) => JSON.stringify({ ok: true, commit });
  const r = await restartWith('silent', (restarts, _n, { target }) => (restarts >= 1 ? health(target) : 503), { DEPLOY_NOW: '', DEPLOY_IDLE_TRIES: '15', DEPLOY_IDLE_POLL: '0.2', DEPLOY_UNKNOWN_WAIT: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the server has not answered for 1 s while its unit is up, so it can't say which turns are running: restarting now/);
  assert.equal(r.restarts, 1);
  assert.equal(r.lastGood, r.target);
});

test('the restart checks health again a little after the first OK, and rolls back if it has gone (#520)', { timeout: 60_000 }, async () => {
  const health = (commit: string) => JSON.stringify({ ok: true, commit });
  // Healthy once, then gone (crashed in its first minute): the rollback path, as if the first check had failed.
  const r = await restartWith('gone', (restarts, n, { good, target }) => (restarts >= 2 ? health(good) : n === 1 ? health(target) : 503));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /rolling back to last-good/);
  assert.equal(r.restarts, 2);
  assert.equal(r.head, r.good);
  assert.equal(r.lastGood, r.good);
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].ok, false);
  assert.match(r.reports[0].text, /answered healthy on it, then stopped answering or was restarted within 2 s\. Rolled back to last-good/);
  // The drill's F4 (#553): waiting landings see the restart move, and its reports go out together, not one by one.
  assert.equal(r.phases.length, 3, r.phases.join(' | '));
  assert.match(r.phases[0], /^restarting citadel-test on [0-9a-f]{7} since \d\d:\d\d$/);
  assert.match(r.phases[1], /^rolling back to [0-9a-f]{7} since \d\d:\d\d$/);
  assert.match(r.phases[2], /^posting its reports since \d\d:\d\d$/);
  assert.deepEqual(r.lockHeldAtReport, [true, true, true], 'the restart still held the lock at each report');
  assert.ok(r.together(), 'all three reports were in before any was answered: posted at once');
  assert.equal(r.noteLeft, false);
  // Healthy at both checks, but systemd brought it back in between (Restart=always): it died, so it rolls back too.
  const back = await restartWith('respawned', (restarts, n, { good, target, pidFile }) => {
    if (restarts === 1 && n === 2) writeFileSync(pidFile, '200');
    return health(restarts >= 2 ? good : target);
  });
  assert.equal(back.status, 1, back.stderr);
  assert.equal(back.lastGood, back.good);
  assert.match(back.reports[0].text, /stopped answering or was restarted/);
});

test('a server that is only slow at the second check is not rolled back, and the report waits for that check (#520)', { timeout: 60_000 }, async () => {
  const health = (commit: string) => JSON.stringify({ ok: true, commit });
  // The second check's first ask goes unanswered past health's 3 s limit, as in a restart's busy first minute.
  const r = await restartWith('slow', (_restarts, n, { target }) => (n === 2 ? new Promise((res) => setTimeout(() => res(health(target)), 4000)) : health(target)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.restarts, 1);
  assert.equal(r.lastGood, r.target);
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].ok, true);
  assert.ok(r.healthAt.length >= 3 && r.healthAt[1] - r.healthAt[0] >= 2000, 'checked again DEPLOY_SETTLE s after the first OK');
  assert.ok(r.reports[0].at > r.healthAt.at(-1)!, 'reported only after the second check');
  assert.deepEqual(r.lockHeldAtReport, [true, true, true], 'the restart still held the lock at each report');
  assert.equal(r.noteLeft, false);
});
