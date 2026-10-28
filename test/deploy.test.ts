import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';

// Safe deploys (tools/deploy.sh): the server reloads public/ on SIGHUP, answers /api/health, and takes
// deploy reports; the script tells front-end-only changes from the rest.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'deploy-test-'));
const SECRET = 'x'.repeat(40);
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
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
const token = new Auth('test-password-123', SECRET).agentToken(ticket.id);

let base = '';
let cookie = '';
let server: ChildProcess;
const health = async () => (await fetch(`${base}/api/health`)).json() as Promise<{ ok: boolean; commit: string | null; version: string; reload: string }>;

before(async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(app, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: data, CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  procs.push(server);
  for (const end = Date.now() + 10_000; ; ) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
    }).catch(() => undefined);
    if (res) {
      cookie = res.headers.get('set-cookie')!.split(';')[0];
      break;
    }
    if (Date.now() > end) throw new Error('Timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('/api/health answers without a login and says the server reloads on SIGHUP', async () => {
  const h = await health();
  assert.equal(h.ok, true);
  assert.equal(h.reload, 'sighup');
  assert.match(h.version, /^[0-9a-f]{12}$/);
  assert.equal(h.commit, null, 'the copy is not a git checkout');
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
    execFileSync('bash', [join(repo, 'tools', 'deploy.sh'), 'change-kind', join(root, 'g'), from, to], { encoding: 'utf8' }).trim();
  assert.equal(kind(a, c), 'frontend');
  assert.equal(kind(b, c), 'frontend');
  assert.equal(kind(a, d), 'server', 'any change outside public/ restarts');
  assert.equal(kind(c, d), 'server');
  assert.equal(kind(c, c), 'none');
  assert.equal(kind('', c), 'server', 'an unknown running commit restarts');
});
