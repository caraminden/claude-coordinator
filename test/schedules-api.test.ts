import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'schedules-api-'));
const PASSWORD = 'test-password-123';
const SECRET = 'x'.repeat(40);
const agent = new Auth(PASSWORD, SECRET);
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

let base = '';
let cookie = '';

/** A request as Cara, or as the minion or Taskmaster `as` (a ticket id) with its token. */
async function call(path: string, opts: { method?: string; body?: unknown; as?: number } = {}) {
  const auth: Record<string, string> = opts.as === undefined ? { Cookie: cookie } : { Authorization: `Bearer ${agent.agentToken(opts.as)}` };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
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
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  }));
  for (const end = Date.now() + 10_000; ; ) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: PASSWORD }),
    }).catch(() => undefined);
    if (res) {
      cookie = res.headers.get('set-cookie')!.split(';')[0];
      break;
    }
    if (Date.now() > end) throw new Error('Timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('people and the Taskmaster manage schedules; minions and other schemes cannot', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: other } = await call('/api/projects', { method: 'POST', body: { name: 'Other' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: otherPage } = await call(`/api/projects/${other.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'hi', properties: { type: 'chore' } } });
  const url = `/api/projects/${p.id}/schedules`;
  const nightly = { name: 'Nightly', cron: '0 3 * * *', brief: 'Is main healthy?' };

  const mine = await call(url, { method: 'POST', body: nightly });
  assert.equal(mine.status, 201);
  assert.equal(mine.data.when, 'Every day at 03:00');
  assert.equal(mine.data.type, 'chore');
  const tm = await call(url, { method: 'POST', body: { ...nightly, name: 'Weekly', cron: '0 9 * * 1', type: 'research' }, as: page.coordinator.id });
  assert.equal(tm.status, 201, JSON.stringify(tm.data));
  assert.equal(tm.data.type, 'research');

  assert.equal((await call(url, { method: 'POST', body: nightly, as: minion.id })).status, 403);
  assert.equal((await call(url, { as: minion.id })).status, 403);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { paused: true }, as: minion.id })).status, 403);
  assert.equal((await call(url, { method: 'POST', body: nightly, as: otherPage.coordinator.id })).status, 403);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'DELETE', as: otherPage.coordinator.id })).status, 403);

  assert.equal((await call(url, { method: 'POST', body: { ...nightly, cron: 'nightly' } })).status, 400);
  assert.equal((await call(url, { method: 'POST', body: { ...nightly, brief: '' } })).status, 400);
  const paused = await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { paused: true } });
  assert.deepEqual([paused.status, paused.data.paused, paused.data.next_run_at], [200, 1, null]);
  assert.equal((await call(`/api/schedules/${tm.data.id}`, { method: 'DELETE', as: page.coordinator.id })).status, 200);
  const { data: list } = await call(url);
  assert.deepEqual(list.schedules.map((s: any) => s.name), ['Nightly']);
});

test("the Taskmaster's schedule tools", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tools' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const mcp = spawn(process.execPath, [join(repo, 'src/mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agent.agentToken(page.coordinator.id),
      COORDINATOR_PROJECT: String(p.id), COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: String(page.coordinator.id),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(mcp);
  const { createInterface } = await import('node:readline');
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (l) => {
    const r = JSON.parse(l);
    replies.get(r.id)?.(r);
  });
  let rid = 0;
  const tool = (name: string, args: object) => new Promise<string>((r) => {
    replies.set(++rid, (x) => r(x.result.content[0].text));
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  assert.equal(await tool('list_schedules', {}), 'Nothing scheduled.');
  assert.match(await tool('schedule_minion', { name: 'Nightly', cron: '@daily', brief: 'Check main' }), /^Scheduled\. \[\d+\] Nightly: Every day at 00:00 \(`@daily`\), type chore; next /);
  const id = Number((await tool('list_schedules', {})).match(/^\[(\d+)\]/)![1]);
  assert.match(await tool('update_schedule', { schedule_id: id, paused: true }), /; paused; no run yet$/);
  assert.equal(await tool('delete_schedule', { schedule_id: id }), 'Deleted.');
  mcp.kill();
});
