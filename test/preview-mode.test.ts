import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { listeningPort, PASSWORD, stopProcs } from './helpers.ts';

// A preview (PREVIEW=1) serves the app on a copy of the database and must never act on it: no turns
// (from people's messages or auto-resume), no new minions or schemes, no pushes, no machines.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'preview-mode-test-'));
const procs: ChildProcess[] = [];
let pushHits = 0;
const pushServer = createHttpServer((req, res) => {
  pushHits++;
  res.writeHead(201).end();
});
after(async () => {
  await stopProcs(procs);
  pushServer.close();
  rmSync(root, { recursive: true, force: true });
});

// Any turn would run this instead of claude, and leave the marker behind.
const marker = join(root, 'claude-ran');
const fakeClaude = join(root, 'claude');
writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\n`);
chmodSync(fakeClaude, 0o755);

const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'coordinator.db'));
const project = store.createProject('Test', null);
const cwd = join(root, 'work');
mkdirSync(cwd);
const ticket = store.createTicket({ project_id: project.id, title: 'Mid-turn', permission_mode: 'default', created_by: 'Cara' });
store.setTicketDir(ticket.id, cwd, null);
// Copied mid-turn from the live database: live, this would be resumed at boot.
store.updateTicket(ticket.id, { status: 'running' });
store.setSetting(`turn:${ticket.id}`, { resumes: 0 });

let base = '';
let cookie = '';
const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', r));
  // Someone else's real subscription: a state change by Cara would push to it outside a preview.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  store.savePushSubscription('Josh', `http://127.0.0.1:${(pushServer.address() as any).port}/push`, ecdh.getPublicKey('base64url'), randomBytes(16).toString('base64url'));
  store.db.close();

  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', DATA_DIR: data, PREVIEW: '1', CLAUDE_BIN: fakeClaude,
      CLAUDE_CONFIG_DIR: join(root, 'claude-config'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: 'x'.repeat(40),
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

test('health says it is a preview, and the tab title says so too', async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).preview, true);
  assert.match(await (await fetch(`${base}/`)).text(), /<title>Citadel preview<\/title>/);
});

test('a message is kept but starts no turn; the chat says why', async () => {
  // Through the runner as live: stop isn't possible (nothing runs), so the message goes to a new turn.
  const res = await post(`/api/tickets/${ticket.id}/messages`, { text: 'hello' });
  assert.ok(res.status < 300, `messages answered ${res.status}`);
  const events = await (await fetch(`${base}/api/tickets/${ticket.id}/events?after=0`, { headers: { Cookie: cookie } })).json();
  assert.ok(events.some((e: any) => e.kind === 'user_message'));
  assert.ok(events.some((e: any) => e.kind === 'note' && /preview/.test(JSON.parse(e.data).text)));
});

test('no new minions, schemes or machine connections', async () => {
  assert.equal((await post(`/api/projects/${project.id}/tickets`, { message: 'start something' })).status, 403);
  assert.equal((await post('/api/projects', { name: 'Another' })).status, 403);
  assert.equal((await fetch(`${base}/api/machines/connect`)).status, 403);
});

test('a state change pushes to nobody', async () => {
  const res = await fetch(`${base}/api/tickets/${ticket.id}`, {
    method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'blocked', note: 'stuck' }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pushHits, 0);
});

test('nothing resumes the copied mid-turn minion, and no claude ever ran', async () => {
  // Live, recover() resumes interrupted turns resumeGapMs (3 s) apart.
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(marker), false);
});

test('a preview exits once the server that started it is gone', async () => {
  const dir = mkdtempSync(join(root, 'orphan-'));
  // A stand-in for the live server: it starts the preview, then dies without cleaning up.
  const parent = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(repo, 'server.ts'))}], { stdio: ['ignore', 'inherit', 'ignore'], env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', DATA_DIR: ${JSON.stringify(dir)}, PREVIEW: '1', CLAUDE_BIN: '/bin/false', CLAUDE_CONFIG_DIR: ${JSON.stringify(join(dir, 'claude'))}, COORDINATOR_PASSWORD: '${PASSWORD}', SESSION_SECRET: '${'x'.repeat(40)}' } }); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(parent);
  // The preview's stdout is the stand-in's, so its listening line says where it is.
  const port = await listeningPort(parent);
  const up = () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
  assert.equal(await up(), true);
  parent.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await up(), false);
});
