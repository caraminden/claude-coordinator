import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The whole path from a thread's turn to a machine and back: the real server, the real agent
// (public/machine-agent.mjs) running a stand-in MCP server, and a stand-in `claude -p` that acts
// as the MCP client, starting the machine's server from its --mcp-config just as claude would.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'machines-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

// A tiny MCP server with one tool that says which process answered.
const mcpServer = join(root, 'fake-mcp.mjs');
writeFileSync(mcpServer, `
import { createInterface } from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pid ' + process.pid }] } });
});
`);

// Stands in for claude: records its arguments, talks to each machine server it was given, writes
// what came back, then ends the turn.
const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
const report = (r) => appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify(r) + '\\n');
process.stdin.resume();
(async () => {
  const results = {};
  for (const [name, s] of Object.entries(config.mcpServers)) {
    if (name === 'thread') continue;
    const p = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    const call = async (id, method, params) => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
      return JSON.parse((await replies.next()).value);
    };
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
    const tools = await call(2, 'tools/list', {});
    const called = await call(3, 'tools/call', { name: 'whoami', arguments: {} });
    results[name] = { tools: tools.result.tools.map((t) => t.name), text: called.result.content[0].text };
    p.stdin.end();
  }
  report({ args, results, token: process.env.COORDINATOR_TOKEN });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
})().catch((err) => { report({ args, error: String(err) }); process.exit(1); });
`);
chmodSync(fakeClaude, 0o755);

let base = '';
let cookie = '';

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  return port;
}

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const turns = () => existsSync(join(root, 'turns.jsonl')) ? readFileSync(join(root, 'turns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

function startAgent(token: string, run = ['--', process.execPath, mcpServer], env: NodeJS.ProcessEnv = {}) {
  const agent = spawn(process.execPath, [join(repo, 'public/machine-agent.mjs'), base, token, ...run], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MACHINES_URL: undefined, ...env } });
  procs.push(agent);
  let output = '';
  agent.stdout!.on('data', (d) => (output += d));
  agent.stderr!.on('data', (d) => (output += d));
  return { agent, output: () => output };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // A thread's turn inherits the live service's MACHINES_URL; this server must take agents itself.
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: fakeClaude,
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  procs.push(server);
  const res = await until('the server', () => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
  }).catch(() => undefined));
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

test('a thread uses a connected machine\'s MCP server, one copy per turn', async () => {
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'test-box' } });
  assert.equal(machine.online, false);
  assert.match(token, /^ccm_\d+_/);
  const { output } = startAgent(token);
  await until('the machine to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'test-box' && m.online));

  const project = await call('/api/projects', { method: 'POST', body: { name: 'P' } });
  await call(`/api/machines/${machine.id}/projects/${project.id}`, { method: 'PUT' });
  const ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'build it' } });
  const [turn] = await until('the first turn', () => turns().length >= 1 && turns());
  assert.equal(turn.error, undefined);
  assert.deepEqual(turn.results['test-box'].tools, ['whoami']);
  assert.ok(turn.args.includes('mcp__test-box'), 'the machine\'s tools are allowed');
  assert.match(turn.args[turn.args.indexOf('--append-system-prompt') + 1], /Connected machines: test-box/);

  // A second turn starts a fresh copy of the machine's server.
  await until('the turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  await call(`/api/tickets/${ticket.id}/messages`, { method: 'POST', body: { text: 'again' } });
  const second = (await until('the second turn', () => turns().length >= 2 && turns()))[1];
  assert.notEqual(second.results['test-box'].text, turn.results['test-box'].text);
  // Each session's server is stopped once claude lets go of it.
  await until('sessions to close', async () => (await call('/api/machines')).find((m: any) => m.name === 'test-box').sessions === 0);
  assert.match(output(), /Connected to/);
});

test('only schemes granted a machine get it, and the toggle changes that', async () => {
  const [box] = (await call('/api/machines')).filter((x: any) => x.name === 'test-box');
  const project = await call('/api/projects', { method: 'POST', body: { name: 'Q' } });
  assert.equal(box.projects.includes(project.id), false);
  const openSession = (token: string) => fetch(`${base}/api/machines/${box.id}/session`, { headers: { Authorization: `Bearer ${token}` } });

  // Ungranted: the turn doesn't get the machine, and can't open it by id either.
  let before = turns().length;
  const ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'peek' } });
  let turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(Object.keys(turn.results), []);
  assert.ok(!turn.args.includes('mcp__test-box'));
  assert.doesNotMatch(turn.args[turn.args.indexOf('--append-system-prompt') + 1], /Connected machines/);
  const denied = await openSession(turn.token);
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /isn't granted to this scheme/);

  // Granted: the next turn gets it.
  assert.ok((await call(`/api/machines/${box.id}/projects/${project.id}`, { method: 'PUT' })).projects.includes(project.id));
  await until('the turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  before = turns().length;
  await call(`/api/tickets/${ticket.id}/messages`, { method: 'POST', body: { text: 'now?' } });
  turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(turn.results['test-box'].tools, ['whoami']);

  // Revoked: shut out again.
  assert.equal((await call(`/api/machines/${box.id}/projects/${project.id}`, { method: 'DELETE' })).projects.includes(project.id), false);
  assert.equal((await openSession(turn.token)).status, 403);
  await assert.rejects(call(`/api/machines/${box.id}/projects/999`, { method: 'PUT' }), /404/);
});

test('a removed machine is cut off, and its token no longer works', async () => {
  const [m] = (await call('/api/machines')).filter((x: any) => x.name === 'test-box');
  await call(`/api/machines/${m.id}`, { method: 'DELETE' });
  assert.equal((await call('/api/machines')).length, 0);
  const res = await fetch(`${base}/api/machines/connect`, { headers: { Authorization: 'Bearer ccm_1_' + 'a'.repeat(43) } });
  assert.equal(res.status, 401);
});

test('threads skip offline machines, and only people manage machines', async () => {
  await call('/api/machines', { method: 'POST', body: { name: 'sleepy' } });
  const before = turns().length;
  const [project] = await call('/api/projects');
  await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'hi' } });
  const turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(Object.keys(turn.results), []);
  assert.ok(!turn.args.includes('mcp__sleepy'));
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'thread' } }), /400/);
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'Bad Name!' } }), /400/);
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'sleepy' } }), /409/);
});

test('an agent can run a server from Claude Code\'s config, and threads get the machine\'s notes', async () => {
  const home = join(root, 'pc-home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { type: 'stdio', command: process.execPath, args: [mcpServer] } } }));
  const [project] = await call('/api/projects');
  // Added from a scheme's Machines page, it is granted to that scheme.
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'desk', project_id: project.id } });
  assert.deepEqual(machine.projects, [project.id]);
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { notes: 'Never restart this PC.' } });
  startAgent(token, ['--claude-mcp', 'godot-ai'], { CLAUDE_CONFIG_DIR: home });
  const online = await until('desk to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'desk' && m.online));
  assert.match(online.command, /godot-ai/);
  const before = turns().length;
  await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'play' } });
  const turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(turn.results.desk.tools, ['whoami']);
  assert.match(turn.args[turn.args.indexOf('--append-system-prompt') + 1], /Notes on desk from its owner:\nNever restart this PC\./);
});
