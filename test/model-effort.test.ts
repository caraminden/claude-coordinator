import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { turnSettings } from '../src/turn-launch.ts';
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

  // The scheme's machine tools switch is retired (#438): a machine's own list of schemes decides.
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { machine_tools: false } })).status, 400);
});

test("a minion's Workflow switch (#359): off by default, set at creation or later, never on a Taskmaster", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Workflows' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const plain = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Plain', message: 'hi' } });
  assert.equal(plain.data.workflow, 0);
  const on = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Fan-out', message: 'hi', workflow: true } });
  assert.equal(on.status, 201);
  assert.equal(on.data.workflow, 1);
  assert.equal((await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Bad', message: 'hi', workflow: 'yes' } })).status, 400);

  assert.equal((await call(`/api/tickets/${plain.data.id}`, { method: 'PATCH', body: { workflow: true } })).data.workflow, 1);
  assert.equal((await call(`/api/tickets/${plain.data.id}`, { method: 'PATCH', body: { workflow: false } })).data.workflow, 0);
  assert.equal((await call(`/api/tickets/${plain.data.id}`, { method: 'PATCH', body: { workflow: 1 } })).status, 400);
  const tm = await call(`/api/tickets/${page.coordinator.id}`, { method: 'PATCH', body: { workflow: true } });
  assert.equal(tm.status, 400);
  assert.match(tm.data.error, /Only minions/);
  const notes = (await call(`/api/tickets/${plain.data.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  // Its first turn may still be running, so the note says now or the next turn.
  assert.ok(notes.some((n: string) => /^Cara turned the Workflow tool on for this minion from (now on|the next turn)\.$/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n: string) => /^Cara turned the Workflow tool off for this minion/.test(n)));
});

test("a minion's plugin picks (#361): from the scheme's optional folders, at creation or later, never on a Taskmaster", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Plugin picks' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const offList = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Early', message: 'hi', plugin_dirs: ['tools/plugins/devtools'] } });
  assert.equal(offList.status, 400, 'nothing is optional yet');
  assert.match(offList.data.error, /no optional plugin folders/);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { optional_plugin_dirs: 'tools/plugins/devtools\ntools/plugins/lsp' } })).data.optional_plugin_dirs, 'tools/plugins/devtools\ntools/plugins/lsp');

  const plain = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Plain', message: 'hi' } });
  assert.equal(plain.data.plugin_dirs, '');
  const ui = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'UI', message: 'hi', plugin_dirs: ['tools/plugins/devtools'] } });
  assert.equal(ui.status, 201);
  assert.equal(ui.data.plugin_dirs, 'tools/plugins/devtools');

  assert.equal((await call(`/api/tickets/${plain.data.id}`, { method: 'PATCH', body: { plugin_dirs: ['tools/plugins/lsp', 'tools/plugins/devtools'] } })).data.plugin_dirs, 'tools/plugins/lsp\ntools/plugins/devtools');
  const bad = await call(`/api/tickets/${plain.data.id}`, { method: 'PATCH', body: { plugin_dirs: ['/home'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /not one of this scheme's optional plugin folders/);
  assert.equal((await call(`/api/tickets/${plain.data.id}`, { method: 'PATCH', body: { plugin_dirs: null } })).data.plugin_dirs, '');
  const tm = await call(`/api/tickets/${page.coordinator.id}`, { method: 'PATCH', body: { plugin_dirs: ['tools/plugins/devtools'] } });
  assert.equal(tm.status, 400);
  assert.match(tm.data.error, /Only minions/);
  const notes = (await call(`/api/tickets/${plain.data.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(notes.some((n: string) => /^Cara set this minion's extra plugin folders to tools\/plugins\/lsp, tools\/plugins\/devtools from (now on|the next turn)\.$/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n: string) => /^Cara took this minion's extra plugin folders off/.test(n)));
  const tmNotes = (await call(`/api/tickets/${page.coordinator.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(tmNotes.includes("Cara set the optional plugin folders to: tools/plugins/devtools, tools/plugins/lsp. Minions load them only when they pick them, from their next turn."), tmNotes.join('\n'));
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
      // No COORDINATOR_MEMORY from a turn running the tests: create_ticket's duplicate check would call first.
      ...process.env, MACHINES_URL: undefined, COORDINATOR_MEMORY: undefined, COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`,
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
    const created = await tool('create_ticket', { title: 'T', properties: { type: 'chore' }, message: 'go', model: 'claude-haiku-5-5', effort: 'low', workflow: true, plugin_folders: ['tools/plugins/devtools'] });
    assert.ok(!created.isError, created.content[0].text);
    assert.match(created.content[0].text, /model: claude-haiku-5-5 \| effort: low/);
    const updated = await tool('update_ticket', { ticket_id: 4, effort: 'high' });
    assert.ok(!updated.isError, updated.content[0].text);
    const switched = await tool('update_ticket', { ticket_id: 4, workflow: false, plugin_folders: [] });
    assert.ok(!switched.isError, switched.content[0].text);
    assert.deepEqual(bodies.map((b) => `${b.method} ${b.path}`), ['POST /api/projects/2/tickets', 'GET /api/projects/2?number=4', 'PATCH /api/tickets/40', 'GET /api/projects/2?number=4', 'PATCH /api/tickets/40']);
    assert.equal(bodies[0].body.model, 'claude-haiku-5-5');
    assert.equal(bodies[0].body.effort, 'low');
    assert.equal(bodies[0].body.workflow, true);
    assert.deepEqual(bodies[0].body.plugin_dirs, ['tools/plugins/devtools']);
    assert.deepEqual(bodies[2].body, { effort: 'high' }, 'what is left out stays');
    assert.deepEqual(bodies[4].body, { workflow: false, plugin_dirs: [] }, 'false and [] are sent, not dropped');
  } finally {
    mcp.kill();
    api.close();
  }
});

test('Fable 5.2 (#431) is a pickable model in the server list, the MCP enum and the composer, beside 5.1', async () => {
  const { MODELS } = await import('../src/db.ts');
  for (const id of ['claude-fable-5-1', 'claude-fable-5-2']) assert.ok((MODELS as readonly string[]).includes(id), `MODELS has ${id}`);

  // The MCP server's own list, as a client sees it: every tool that takes a model offers exactly MODELS and null.
  const mcp = spawn(process.execPath, [join(repo, 'src/mcp.ts')], {
    env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: 'http://127.0.0.1:1', COORDINATOR_TOKEN: 'c.sig', COORDINATOR_PROJECT: '2', COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const listed = new Promise<any>((resolve) => createInterface({ input: mcp.stdout! }).on('line', (l) => {
      const r = JSON.parse(l);
      if (r.id === 2) resolve(r.result);
    }));
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const withModel = (await listed).tools.filter((t: any) => t.inputSchema.properties?.model);
    assert.ok(withModel.some((t: any) => t.name === 'create_ticket') && withModel.some((t: any) => t.name === 'update_ticket'), 'create_ticket and update_ticket take a model');
    for (const t of withModel) assert.deepEqual(t.inputSchema.properties.model.enum, [...MODELS, null], `${t.name}'s model enum`);
  } finally {
    mcp.kill();
  }

  // The composer can't be imported without a browser (it needs the page's DOM), so read its two lists
  // out of the source as data: its Claude and Codex picks together are exactly MODELS, in order.
  const { readFileSync } = await import('node:fs');
  const composer = readFileSync(join(repo, 'public/composer.js'), 'utf8');
  const listIds = (name: string) => [...composer.match(new RegExp(`const ${name} = \\[([^;]*?)\\n\\];`))![1].matchAll(/\['([^']+)', '[^']+'\]/g)].map((m) => m[1]);
  assert.deepEqual([...listIds('MODELS'), ...listIds('CODEX_MODELS')], [...MODELS], 'the composer offers exactly the server list');
});
