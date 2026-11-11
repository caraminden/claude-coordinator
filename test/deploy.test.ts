import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
const hostEnv = { ...scriptEnv(), COORDINATOR_CONTAINER: undefined };
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
  const copy = join(root, 'refuse-deploy.sh'); // the restart deletes its own script, as the unit's is a private copy
  cpSync(join(repo, 'tools', 'deploy.sh'), copy);
  const r = spawnSync('bash', [copy, 'restart'], {
    encoding: 'utf8',
    env: { ...hostEnv, DEPLOY_LIVE: live, DEPLOY_DB: join(dir, 'coordinator.db'), DEPLOY_NOW: '1', DEPLOY_URL: 'http://127.0.0.1:1', DEPLOY_SERVICE: 'no-such-citadel-unit', DEPLOY_REMOTE: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAILED: Could not copy the database to backups\/ .*so nothing restarted/);
  assert.doesNotMatch(r.stderr, /restarting no-such-citadel-unit/);
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
// 'hang' never answers, a number is the status to answer with, a string is a 200 JSON body.
async function standIn(answer: (req: import('node:http').IncomingMessage, body: string) => 'reset' | 'hang' | number | string | Promise<string>) {
  const seen: { url: string; body: string; at: number }[] = [];
  const srv = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', async () => {
      seen.push({ url: req.url ?? '', body, at: Date.now() });
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
  const post = (url: string, env: object = {}) => promisify(execFile)('bash', [join(repo, 'tools', 'deploy.sh'), 'post-report', url, 'tok', '7', 'ok', 'Deployed abc1234'], { encoding: 'utf8', env: { ...hostEnv, ...env } });
  // Dropped unanswered, then a 503: neither got the report in, so it goes again, with the same body.
  const flaky = await standIn((req) => (flaky.seen.length === 1 ? 'reset' : flaky.seen.length === 2 ? 503 : 201));
  try {
    const r = await post(flaky.url);
    assert.equal(flaky.seen.length, 3);
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
async function restartWith(name: string, health: (restarts: number, n: number, commits: { good: string; target: string }) => 'hang' | number | string | Promise<string>) {
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
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >>'${log}'\nexit 0\n`, { mode: 0o755 });
  const restarts = () => (existsSync(log) ? execFileSync('grep', ['-c', ' restart ', log], { encoding: 'utf8' }).trim() : '0');
  let n = 0;
  const srv = await standIn((req) => (req.url === '/api/health' ? health(Number(restarts()), ++n, { good, target }) : 201));
  const state = join(live, '.git', 'cc-deploy');
  mkdirSync(state);
  writeFileSync(join(state, 'reporters'), `${srv.url} tok 9\n`);
  const copy = join(root, `${name}-deploy.sh`);
  cpSync(join(repo, 'tools', 'deploy.sh'), copy);
  try {
    const r = await promisify(execFile)('bash', [copy, 'restart'], {
      encoding: 'utf8',
      env: { ...hostEnv, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: live, DEPLOY_DB: join(root, `${name}-no.db`), DEPLOY_NOW: '1', DEPLOY_URL: srv.url, DEPLOY_SERVICE: 'citadel-test', DEPLOY_REMOTE: '', DEPLOY_HEALTHY_WAIT: '3', DEPLOY_SETTLE: '2' },
    }).then((o) => ({ status: 0, stderr: o.stderr }), (e) => ({ status: e.code as number, stderr: e.stderr as string }));
    const reports = srv.seen.filter((s) => s.url === '/api/tickets/9/deploy').map((s) => ({ ...JSON.parse(s.body), at: s.at }));
    const healthAt = srv.seen.filter((s) => s.url === '/api/health').map((s) => s.at);
    return { ...r, good, target, reports, healthAt, head: git('rev-parse', 'HEAD'), lastGood: git('rev-parse', 'last-good'), restarts: Number(restarts()) };
  } finally {
    srv.close();
  }
}

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
  assert.match(r.reports[0].text, /stopped answering healthy .*Rolled back to last-good/);
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
});
