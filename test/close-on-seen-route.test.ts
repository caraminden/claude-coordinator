import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { listeningPort, stopTurns, stopProcs } from './helpers.ts';

// POST /api/tickets/:id/seen with left:true closes a complete minion the person had open at its last update (#811).
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'close-on-seen-route-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

let base = '';
const cookies: Record<string, string> = {};

async function call(who: string, path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookies[who], ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: '0', DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(server);
  base = `http://127.0.0.1:${await listeningPort(server)}`;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
  });
  cookies.Cara = res.headers.get('set-cookie')!.split(';')[0];
});

test('{left:true} closes a complete minion seen at its last update; a plain mark only records the view', async () => {
  const { data: proj } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Seen' } });
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const made = (state: string | null) => {
    const t = store.createTicket({ project_id: proj.id, kind: 'ticket', title: 'T', permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { state });
    return t.id;
  };
  const wait = () => new Promise((r) => setTimeout(r, 5));
  const done = made('complete');
  await wait();
  assert.equal((await call('Cara', `/api/tickets/${done}/seen`, { method: 'POST', body: {} })).data.closed, undefined);
  assert.equal(store.getTicket(done)!.status, 'new');
  assert.equal((await call('Cara', `/api/tickets/${done}/seen`, { method: 'POST', body: { left: true } })).data.closed, true);
  assert.equal(store.getTicket(done)!.status, 'closed');
  const ready = made('ready');
  await wait();
  await call('Cara', `/api/tickets/${ready}/seen`, { method: 'POST', body: {} });
  assert.equal((await call('Cara', `/api/tickets/${ready}/seen`, { method: 'POST', body: { left: true } })).data.closed, false);
  assert.equal(store.getTicket(ready)!.status, 'new');
});
