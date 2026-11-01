import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, jsonLines, until, stopProcs, stopTurns } from './helpers.ts';

// The whole path from a thread's turn to a machine and back: the real server, the real agent
// (public/machine-agent.mjs) running a stand-in MCP server, and a stand-in `claude -p` that acts
// as the MCP client, starting the machine's server from its --mcp-config just as claude would.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'machines-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
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
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const system = readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const allow = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).permissions.allow;
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
    // A machine's workspace tools: list the workspaces, then copy a file over.
    const ws = name.endsWith('-ws');
    const called = await call(3, 'tools/call', { name: ws ? 'workspaces' : 'whoami', arguments: {} });
    results[name] = { tools: tools.result.tools.map((t) => t.name), text: called.result.content[0].text };
    if (ws) results[name].fetched = (await call(4, 'tools/call', { name: 'fetch_file', arguments: { workspace: 'w', path: 'report.zip' } })).result.content[0].text;
    p.stdin.end();
  }
  report({ args, system, allow, results, token: process.env.COORDINATOR_TOKEN });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
})().catch((err) => { report({ args, error: String(err) }); process.exit(1); });
`);
chmodSync(fakeClaude, 0o755);

let base = '';
let cookie = '';

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

const turns = () => jsonLines(join(root, 'turns.jsonl'));

function startAgent(token: string, run = ['--', process.execPath, mcpServer], env: NodeJS.ProcessEnv = {}) {
  const agent = spawn(process.execPath, [join(repo, 'public/machine-agent.mjs'), base, token, ...run], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MACHINES_URL: undefined, ...env } });
  procs.push(agent);
  let output = '';
  agent.stdout!.on('data', (d) => (output += d));
  agent.stderr!.on('data', (d) => (output += d));
  return { agent, output: () => output };
}

before(async () => {
  // bootServer clears MACHINES_URL: a thread's turn inherits the live service's, and this server must take agents itself.
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude }, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
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
  assert.ok(turn.allow.includes('mcp__test-box'), 'the machine\'s tools are allowed');
  assert.match(turn.system, /Connected machines: test-box/);

  // A second turn starts a fresh copy of the machine's server.
  await until('the turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  await call(`/api/tickets/${ticket.id}/messages`, { method: 'POST', body: { text: 'again' } });
  const second = (await until('the second turn', () => turns().length >= 2 && turns()))[1];
  assert.notEqual(second.results['test-box'].text, turn.results['test-box'].text);
  // Each session's server is stopped once claude lets go of it.
  await until('sessions to close', async () => (await call('/api/machines')).find((m: any) => m.name === 'test-box').sessions === 0);
  assert.match(output(), /Connected to/);
});

test('an online machine reaches every scheme, and a minion in any scheme can open it by id', async () => {
  const [box] = (await call('/api/machines')).filter((x: any) => x.name === 'test-box');
  const project = await call('/api/projects', { method: 'POST', body: { name: 'Q' } });
  const before = turns().length;
  await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'peek' } });
  const turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(turn.results['test-box'].tools, ['whoami']);
  assert.match(turn.system, /Connected machines: test-box/);
  const opened = await fetch(`${base}/api/machines/${box.id}/session`, { headers: { Authorization: `Bearer ${turn.token}` } });
  assert.equal(opened.status, 200);
  await opened.body!.cancel();
  // The per-scheme grant route from #62 is gone.
  await assert.rejects(call(`/api/machines/${box.id}/projects/${project.id}`, { method: 'PUT' }), /404/);
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
  assert.ok(!turn.allow.includes('mcp__sleepy'));
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
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'desk' } });
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { notes: 'Never restart this PC.' } });
  startAgent(token, ['--claude-mcp', 'godot-ai'], { CLAUDE_CONFIG_DIR: home });
  const online = await until('desk to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'desk' && m.online));
  assert.match(online.command, /godot-ai/);
  const before = turns().length;
  await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'play' } });
  const turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(turn.results.desk.tools, ['whoami']);
  assert.match(turn.system, /Notes on desk from its owner:\nNever restart this PC\./);
});

test('workspace tools reach minions only once a person switches them on, and fetch_file lands in the minion\'s files', async () => {
  const { mkdirSync } = await import('node:fs');
  const folder = join(root, 'ws-folder');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'report.zip'), Buffer.from([0x50, 0x4b, 0, 1, 2, 3]));
  const config = join(root, 'agent-dir', 'machine-agent.json');
  mkdirSync(join(root, 'agent-dir'), { recursive: true });
  writeFileSync(config, JSON.stringify({ workspaces: { w: { path: folder, tasks: { hi: { run: [process.execPath, '-e', '1'] } } } } }));
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'box-ws' } }), /400/);
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'wsbox' } });
  assert.equal(machine.workspace_tools, false);
  startAgent(token, ['--config', config, '--', process.execPath, mcpServer]);
  const online = await until('wsbox to report its workspace', async () => (await call('/api/machines')).find((m: any) => m.name === 'wsbox' && m.workspaces.length));
  assert.deepEqual(online.servers, ['mcp', 'ws']);
  assert.equal(online.workspaces[0].tasks[0].name, 'hi');
  const [project] = await call('/api/projects');

  // Off: the turn gets the machine's MCP server only, and can't open its workspace tools by hand.
  let before = turns().length;
  await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'off' } });
  let turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(Object.keys(turn.results).filter((n) => n.startsWith('wsbox')), ['wsbox']);
  const refused = await fetch(`${base}/api/machines/${machine.id}/session?server=ws`, { headers: { Authorization: `Bearer ${turn.token}` } });
  assert.equal(refused.status, 503);
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { workspace_tools: 'yes' } }), /400/);

  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { workspace_tools: true } });
  before = turns().length;
  const ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'on' } });
  turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.equal(turn.error, undefined);
  const ws = turn.results['wsbox-ws'];
  assert.ok(ws.tools.includes('git_sync') && ws.tools.includes('run_task'));
  assert.match(ws.text, /## w\nFolder: .*ws-folder[\s\S]*- hi: /);
  const copied = ws.fetched.match(/to (\S+) on the app/)[1];
  assert.match(copied, new RegExp(`shared/${ticket.ticket?.id ?? ticket.id}/machine-files/wsbox/report\\.zip$`));
  assert.deepEqual([...readFileSync(copied)], [0x50, 0x4b, 0, 1, 2, 3]);
  assert.ok(turn.allow.includes('mcp__wsbox-ws'));
  assert.match(turn.system, /wsbox \(mcp__wsbox, mcp__wsbox-ws\)[\s\S]*call its workspaces tool first/);
});
