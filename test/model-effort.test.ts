import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { turnSettings } from '../src/runner.ts';
import { bootServer, stopProcs } from './helpers.ts';

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'model-effort-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  rmSync(root, { recursive: true, force: true });
});

test('a new scheme defaults to high effort', () => {
  const store = new Store(join(root, 'store.db'));
  const p = store.createProject('Alpha', null);
  assert.equal(store.getProject(p.id)!.default_effort, 'high');
  store.setProjectSettings(p.id, { default_effort: '' });
  assert.equal(store.getProject(p.id)!.default_effort, '');
});

test('turn settings: the ticket first, then the Taskmaster pin, then the scheme default', () => {
  const scheme = { default_effort: 'medium' };
  const minion = { kind: 'ticket' as const, model: null, effort: null };
  const taskmaster = { kind: 'coordinator' as const, model: null, effort: null };
  assert.deepEqual(turnSettings(minion, scheme), { model: null, effort: 'medium' });
  assert.deepEqual(turnSettings({ ...minion, model: 'claude-sonnet-5-5', effort: 'low' }, scheme), { model: 'claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(turnSettings(minion, { default_effort: '' }), { model: null, effort: null }, 'no default leaves it to Claude Code');
  assert.deepEqual(turnSettings(taskmaster, scheme), { model: 'opus', effort: 'high' }, 'the pin beats the scheme default');
  assert.deepEqual(turnSettings({ ...taskmaster, model: 'claude-sonnet-5-5', effort: 'max' }, scheme), { model: 'claude-sonnet-5-5', effort: 'max' });
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
  const srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

test('a new minion takes a model and effort; the scheme default shows when it has none', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  assert.equal(page.project.default_effort, 'high');
  assert.equal(page.coordinator.default_effort, 'high', 'the Taskmaster pin');

  const bad = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Bad', message: 'hi', effort: 'turbo' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Effort must be one of/);

  const set = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Set', message: 'hi', model: 'claude-sonnet-5-5', effort: 'low' } });
  assert.equal(set.status, 201);
  assert.equal(set.data.model, 'claude-sonnet-5-5');
  assert.equal(set.data.effort, 'low');

  const plain = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Plain', message: 'hi' } });
  assert.equal(plain.data.effort, null);
  assert.equal(plain.data.default_effort, 'high');
  assert.equal(plain.data.properties.assigned, 'Cara', 'a new minion is its starter\'s (#197)');
  const nobodys = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Nobody', message: 'hi', properties: { assigned: null } } });
  assert.equal(nobodys.data.properties.assigned, undefined, 'unless it says otherwise');

  const changed = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { default_effort: 'medium' } });
  assert.equal(changed.data.default_effort, 'medium');
  assert.equal((await call(`/api/tickets/${plain.data.id}`)).data.ticket.default_effort, 'medium');
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { default_effort: 'turbo' } })).status, 400);
  const cleared = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { default_effort: null } });
  assert.equal(cleared.data.default_effort, '');
  assert.equal((await call(`/api/tickets/${plain.data.id}`)).data.ticket.default_effort, null);

  const notes = (await call(`/api/tickets/${page.coordinator.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(notes.includes("Cara set the scheme's default effort to medium. It applies from each minion's next turn."));

  // #138: machine tools are on until someone turns them off, and only true or false is taken.
  assert.equal(changed.data.machine_tools, 1);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { machine_tools: 'no' } })).status, 400);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { machine_tools: false } })).data.machine_tools, 0);
  const later = (await call(`/api/tickets/${page.coordinator.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(later.includes("Cara took the connected machines' tools from this scheme's minions. It applies from each minion's next turn."));
});

test("the Taskmaster's create_ticket and update_ticket pass model and effort on", async () => {
  const bodies: { method: string; path: string; body: any }[] = [];
  const api = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      bodies.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : null });
      const t = { id: 40, number: 4, title: 'T', status: 'idle', created_by: 'Taskmaster', model: 'claude-haiku-5-5', effort: 'low' };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(req.method === 'GET' ? { tickets: [t] } : t));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const mcp = spawn(process.execPath, [join(repo, 'src/mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`,
      COORDINATOR_TOKEN: 'c.sig', COORDINATOR_PROJECT: '2', COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const replies = new Map<number, (r: any) => void>();
    createInterface({ input: mcp.stdout! }).on('line', (l) => {
      const r = JSON.parse(l);
      replies.get(r.id)?.(r);
    });
    let rid = 0;
    const tool = (name: string, args: object) => new Promise<any>((r) => {
      replies.set(++rid, (x) => r(x.result));
      mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    const created = await tool('create_ticket', { title: 'T', properties: { type: 'chore' }, message: 'go', model: 'claude-haiku-5-5', effort: 'low' });
    assert.ok(!created.isError, created.content[0].text);
    assert.match(created.content[0].text, /model: claude-haiku-5-5 \| effort: low/);
    const updated = await tool('update_ticket', { ticket_id: 4, effort: 'high' });
    assert.ok(!updated.isError, updated.content[0].text);
    assert.deepEqual(bodies.map((b) => `${b.method} ${b.path}`), ['POST /api/projects/2/tickets', 'GET /api/projects/2', 'PATCH /api/tickets/40']);
    assert.equal(bodies[0].body.model, 'claude-haiku-5-5');
    assert.equal(bodies[0].body.effort, 'low');
    assert.deepEqual(bodies[2].body, { effort: 'high' }, 'what is left out stays');
  } finally {
    mcp.kill();
    api.close();
  }
});
