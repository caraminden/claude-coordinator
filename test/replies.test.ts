import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';

// One-tap replies (#105): set with set_thread_status, gone once anyone writes or the next turn starts.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'replies-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

test('a new turn clears the replies, whoever started it', async () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-unit');
  const store = new Store(join(root, 'unit.db'));
  const project = store.createProject('Unit', null);
  const runner = new Runner(store, () => {}, () => ({}), '/bin/false');
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', replies: JSON.stringify(['Merge it']) });
  assert.deepEqual(runner.view(store.getTicket(t.id)!).replies, ['Merge it']);
  runner.send(t.id, 'GitHub', 'CI passed', [], {});
  for (const end = Date.now() + 5000; runner.isRunning(t.id) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getTicket(t.id)!.replies, null);
  assert.deepEqual(runner.view(store.getTicket(t.id)!).replies, []);
});

let base = '';
let cookie = '';

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  base = `http://127.0.0.1:${port}`;
  procs.push(spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  }));
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

test('replies are checked, shown as a list, and go once someone writes', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: t } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'T', message: 'hi' } });
  assert.deepEqual(t.replies, []);
  const patch = (replies: unknown) => call(`/api/tickets/${t.id}`, { method: 'PATCH', body: { replies } });

  assert.equal((await patch(['a', 'b', 'c', 'd'])).status, 400, 'at most 3');
  assert.equal((await patch(['x'.repeat(41)])).status, 400, 'at most 40 characters each');
  assert.equal((await patch([''])).status, 400, 'no blank reply');
  assert.equal((await patch('Merge it')).status, 400, 'a list, not a string');

  const set = await patch([' Merge it ', 'Make it live']);
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.replies, ['Merge it', 'Make it live']);
  assert.deepEqual((await call(`/api/projects/${p.id}`)).data.tickets.find((x: any) => x.id === t.id).replies, ['Merge it', 'Make it live']);
  assert.deepEqual((await patch([])).data.replies, [], '[] clears');

  await patch(['Merge it']);
  const sent = await call(`/api/tickets/${t.id}/messages`, { method: 'POST', body: { text: 'Merge it' } });
  assert.equal(sent.status, 202);
  assert.deepEqual((await call(`/api/tickets/${t.id}`)).data.ticket.replies, []);
});
