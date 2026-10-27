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
  report({ args, results });
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

function startAgent(token: string) {
  const agent = spawn(process.execPath, [join(repo, 'public/machine-agent.mjs'), base, token, '--', process.execPath, mcpServer], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(agent);
  let output = '';
  agent.stdout!.on('data', (d) => (output += d));
  agent.stderr!.on('data', (d) => (output += d));
  return { agent, output: () => output };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: fakeClaude,
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
