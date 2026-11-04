import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, until, stopProcs, stopTurns } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';

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

const { mcpServer, fakeClaude, turns } = machineFakes(root);

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

test('a machine added with workspace_tools: true starts with the switch on', async () => {
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'vault-pc', workspace_tools: 'yes' } }), /400/);
  assert.ok(!(await call('/api/machines')).some((m: any) => m.name === 'vault-pc'), 'a refused add leaves no machine behind');
  const { machine } = await call('/api/machines', { method: 'POST', body: { name: 'vault-pc', workspace_tools: true } });
  assert.equal(machine.workspace_tools, true);
  const { machine: plain } = await call('/api/machines', { method: 'POST', body: { name: 'plain-pc', workspace_tools: false } });
  assert.equal(plain.workspace_tools, false);
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
  writeFileSync(config, JSON.stringify({ workspaces: { w: { path: folder, tasks: { hi: { run: [process.execPath, '-e', 'console.log("task ran")'] } } } } }));
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'box-ws' } }), /400/);
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'wsbox' } });
  assert.equal(machine.workspace_tools, false);
  startAgent(token, ['--config', config, '--', process.execPath, mcpServer]);
  const online = await until('wsbox to report its workspace', async () => (await call('/api/machines')).find((m: any) => m.name === 'wsbox' && m.workspaces.length));
  assert.deepEqual(online.servers, ['mcp', 'ws']);
  assert.equal(online.workspaces[0].tasks[0].name, 'hi');
  assert.equal(online.workspaces[0].git_sync, true, 'a workspace without the key keeps git_sync on');
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
  assert.match(ws.ran, /task ran/);
  assert.ok(turn.allow.includes('mcp__wsbox-ws'));
  assert.match(turn.system, /wsbox \(mcp__wsbox, mcp__wsbox-ws\)[\s\S]*call its workspaces tool first/);
});

test('a machine lent to chosen schemes reaches only their minions, and taking a scheme away ends its sessions (#303)', async () => {
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'vault' } });
  assert.equal(machine.projects, null, 'a new machine is lent to every scheme, as before');
  startAgent(token);
  await until('vault to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'vault' && m.online));
  const a = await call('/api/projects', { method: 'POST', body: { name: 'Obsidian' } });
  const b = await call('/api/projects', { method: 'POST', body: { name: 'Elsewhere' } });
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [999999] } }), /400/);
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: 'all' } }), /400/);
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { notes: 'Josh\'s vault.' } });
  const scoped = await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [a.id] } });
  assert.deepEqual(scoped.projects, [a.id]);

  const turnIn = async (project: any, message: string) => {
    const before = turns().length;
    await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message } });
    return (await until('a turn', () => turns().length > before && turns())).at(-1);
  };
  const inA = await turnIn(a, 'lent');
  assert.deepEqual(inA.results.vault.tools, ['whoami']);
  assert.match(inA.system, /Notes on vault from its owner:\nJosh's vault\./);
  const inB = await turnIn(b, 'not lent');
  assert.equal(inB.results.vault, undefined);
  assert.ok(!inB.allow.includes('mcp__vault'));
  assert.doesNotMatch(inB.system, /vault/);

  // B's minion can't open it by id; A's can, until A is taken off it.
  const refused = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${inB.token}` } });
  assert.equal(refused.status, 403);
  await refused.body!.cancel();
  const opened = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${inA.token}` } });
  assert.equal(opened.status, 200);
  const stream = opened.body!.getReader();
  await stream.read(); // the session id
  await until('the session to show', async () => (await call('/api/machines')).find((m: any) => m.name === 'vault').sessions >= 1);
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [b.id] } });
  for (let r = await stream.read(); !r.done; r = await stream.read());
  const reopened = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${inA.token}` } });
  assert.equal(reopened.status, 403);
  await reopened.body!.cancel();
  // Granted, but with the scheme's machine tools off it still doesn't open, as its turns wouldn't get it.
  await call(`/api/projects/${b.id}`, { method: 'PATCH', body: { machine_tools: false } });
  const off = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${inB.token}` } });
  assert.equal(off.status, 403);
  await off.body!.cancel();
  await call(`/api/projects/${b.id}`, { method: 'PATCH', body: { machine_tools: true } });
  const nowB = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${inB.token}` } });
  assert.equal(nowB.status, 200);
  await nowB.body!.cancel();

  // Back to every scheme: lent as before, and its grants kept but unread.
  const unscoped = await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: null } });
  assert.equal(unscoped.projects, null);
  const again = await turnIn(a, 'every scheme again');
  assert.deepEqual(again.results.vault.tools, ['whoami']);
});
