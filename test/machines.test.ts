import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createInterface } from 'node:readline';
import { agentToken, bootServer, until, stopProcs, stopTurns } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { askerKey, Store } from '../src/db.ts';
import { hashToken, newToken } from '../src/machines.ts';

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

const { mcpServer, fakeClaude, turns, startMachineAgent } = machineFakes(root, procs);

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

/** Put these schemes on a machine's list (#438): a new machine is lent to none. */
const lend = (machineId: number, ...projects: { id: number }[]) => call(`/api/machines/${machineId}`, { method: 'PATCH', body: { projects: projects.map((p) => p.id) } });

const startAgent = (token: string, run?: string[], env?: NodeJS.ProcessEnv) => startMachineAgent({ base, token, run, env });

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
  assert.deepEqual(machine.projects, [], 'a new machine is lent to no scheme');
  await lend(machine.id, project);
  const ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'build it' } });
  const [turn] = await until('the first turn', () => turns().length >= 1 && turns());
  assert.equal(turn.error, undefined);
  assert.deepEqual(turn.results['test-box'].tools, ['whoami']);
  assert.ok(turn.allow.includes('mcp__test-box'), 'the machine\'s tools are allowed');
  assert.match(turn.message, /Connected machines: test-box/);

  // A second turn starts a fresh copy of the machine's server.
  await until('the turn to end', async () => (await call(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');
  await call(`/api/tickets/${ticket.id}/messages`, { method: 'POST', body: { text: 'again' } });
  const second = (await until('the second turn', () => turns().length >= 2 && turns()))[1];
  assert.notEqual(second.results['test-box'].text, turn.results['test-box'].text);
  // Each session's server is stopped once claude lets go of it.
  await until('sessions to close', async () => (await call('/api/machines')).find((m: any) => m.name === 'test-box').sessions === 0);
  assert.match(output(), /Connected to/);
});

test('an online machine reaches no scheme until it is on its list, and then its minions open it by id (#438)', async () => {
  const [box] = (await call('/api/machines')).filter((x: any) => x.name === 'test-box');
  const project = await call('/api/projects', { method: 'POST', body: { name: 'Q' } });
  const turnNow = async (message: string) => {
    const before = turns().length;
    await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message } });
    return (await until('a turn', () => turns().length > before && turns())).at(-1);
  };
  // An admin's new scheme gets nothing by itself, and its minion can't open the machine by id either.
  const without = await turnNow('peek');
  assert.equal(without.results['test-box'], undefined);
  assert.doesNotMatch(without.system + without.message, /test-box/);
  const refused = await fetch(`${base}/api/machines/${box.id}/session`, { headers: { Authorization: `Bearer ${without.token}` } });
  assert.equal(refused.status, 403);
  await refused.body!.cancel();
  const lent = await lend(box.id, ...box.projects.map((id: number) => ({ id })), project);
  assert.ok(lent.gets.includes(project.id));
  const turn = await turnNow('peek again');
  assert.deepEqual(turn.results['test-box'].tools, ['whoami']);
  assert.match(turn.message, /Connected machines: test-box/);
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
  // A rename runs on the DB write worker (#795): its UNIQUE failure still comes back as a 409, and changes nothing.
  const { machine: other } = await call('/api/machines', { method: 'POST', body: { name: 'wakeful' } });
  await assert.rejects(call(`/api/machines/${other.id}`, { method: 'PATCH', body: { name: 'sleepy' } }), /409 A machine with that name/);
  assert.equal((await call('/api/machines')).find((m: any) => m.id === other.id).name, 'wakeful');
  await call(`/api/machines/${other.id}`, { method: 'DELETE' });
});

test('adding a machine takes a name, always on and nothing about what it lends (#439)', async () => {
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'named-pc', always_on: 'yes' } }), /400 always_on must be true or false/);
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'named-pc', runners: 1 } }), /400 runners must be true or false/);
  assert.ok(!(await call('/api/machines')).some((m: any) => m.name === 'named-pc'), 'a refused add leaves no machine behind');
  // What an older page sent about an MCP server or a folder is not kept: the agent reports what is there.
  const { machine } = await call('/api/machines', { method: 'POST', body: { name: 'named-pc', kind: 'command', command: 'rm -rf /', workspace_tools: true } });
  assert.deepEqual([machine.mcp_kind, machine.mcp_command, machine.workspace_tools, machine.lend, machine.always_on, machine.runners], [null, '', false, null, true, false]);
  const { machine: laptop } = await call('/api/machines', { method: 'POST', body: { name: 'lap-pc', always_on: false } });
  assert.equal(laptop.always_on, false);
  // A CI runner host is one from the start, so its own install line shows before its agent ever connects.
  const { machine: host } = await call('/api/machines', { method: 'POST', body: { name: 'ci-pc', runners: true } });
  assert.deepEqual([host.runners, host.status, host.reason], [true, 'asleep', 'Not connected yet']);
  assert.equal((await call(`/api/machines/${host.id}/token`, { method: 'POST' })).machine.runners, true);
  for (const m of [machine, laptop, host]) await call(`/api/machines/${m.id}`, { method: 'DELETE' });
});

test('a machine lends what is ticked of what its agent found, and nothing else (#439)', async () => {
  const { mkdirSync } = await import('node:fs');
  const dir = join(root, 'ticks');
  const home = join(dir, 'home');
  mkdirSync(join(dir, 'w'), { recursive: true });
  mkdirSync(join(dir, 'x'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, 'w', 'report.zip'), Buffer.from([1, 2, 3]));
  // The entry's env holds a secret, as real ones do: only its name may leave that computer.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { command: process.execPath, args: [mcpServer], env: { API_KEY: 'sk-secret-123' } } } }));
  const config = join(dir, 'machine-agent.json');
  const task = { hi: { run: [process.execPath, '-e', 'console.log("task ran")'] } };
  writeFileSync(config, JSON.stringify({ servers: { own: { run: [process.execPath, mcpServer] } }, workspaces: { w: { path: join(dir, 'w'), tasks: task }, x: { path: join(dir, 'x') } } }));
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'ticks' } });
  const [project] = await call('/api/projects');
  await lend(machine.id, project);
  const find = async () => (await call('/api/machines')).find((m: any) => m.name === 'ticks');
  const { output } = startAgent(token, ['--config', config], { CLAUDE_CONFIG_DIR: home });
  const found = await until('ticks to report what it found', async () => { const m = await find(); return m.managed && m.found.length && m; });
  assert.deepEqual(found.found, [{ name: 'own', from: 'file' }, { name: 'godot-ai', from: 'claude' }]);
  assert.deepEqual(found.workspaces.map((w: any) => w.name), ['w', 'x']);
  assert.doesNotMatch(JSON.stringify(found), /sk-secret-123|API_KEY/);
  assert.deepEqual(found.lend, { server: null, workspaces: [] }, 'a new machine starts with nothing ticked');
  assert.deepEqual([found.status, found.reason, found.fix], ['fix', 'Lends nothing: nothing is ticked', 'tick']);
  const turnNow = async (message: string) => {
    const before = turns().length;
    await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message } });
    return (await until('a turn', () => turns().length > before && turns())).at(-1);
  };
  assert.deepEqual(Object.keys((await turnNow('nothing ticked')).results).filter((n) => n.startsWith('ticks')), []);

  for (const lend of [{ server: 'a b', workspaces: [] }, { server: null, workspaces: 'w' }, { server: null }, { server: null, workspaces: ['../x'] }, 'all']) {
    await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend } }), /400 lend must be/);
  }
  // A tick needs no new token: the same agent serves it at once.
  const ticked = await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend: { server: 'godot-ai', workspaces: ['w'] } } });
  assert.deepEqual(ticked.lend, { server: 'godot-ai', workspaces: ['w'] });
  const ready = await until('its check', async () => { const m = await find(); return m.status === 'ready' && !m.checking && m; });
  assert.deepEqual(ready.checked.results.map((r: any) => [r.server, r.ok]).sort(), [['mcp', true], ['ws', true]]);
  let turn = await turnNow('ticked');
  assert.equal(turn.error, undefined);
  assert.deepEqual(turn.results.ticks.tools, ['whoami']);
  assert.match(turn.results['ticks-ws'].text, /## w\n/);
  assert.doesNotMatch(turn.results['ticks-ws'].text, /## x\n/, 'a folder that isn\'t ticked is not there for minions');
  assert.match(turn.results['ticks-ws'].ran, /task ran/);
  assert.match(output(), /Lent from the Machines page: MCP server godot-ai and workspaces w/);

  // The other server ticked instead: the machine's own, from its file. Its tools keep the machine's name.
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend: { server: 'own', workspaces: [] } } });
  turn = await turnNow('the other one');
  assert.deepEqual(Object.keys(turn.results).filter((n) => n.startsWith('ticks')), ['ticks']);
  assert.match(output(), /started own/);

  // A name the agent didn't find lends nothing: Citadel can name a server, never a command.
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend: { server: 'not-there', workspaces: ['nor-this'] } } });
  assert.deepEqual((await find()).reason, 'Lends nothing: nothing is ticked');
  assert.deepEqual(Object.keys((await turnNow('made up')).results).filter((n) => n.startsWith('ticks')), []);
  const opened = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${(await turnNow('by hand')).token}` } });
  assert.equal(opened.status, 503);

  // The agent that starts these dies with the test and leaves them running. Their command line names root, so stopTurns ends them and leak-guard sees any that escape (#515).
  const stuckMarker = join(root, 'stuck-stand-in');
  // A server its owner adds to the file shows up to tick without restarting anything.
  writeFileSync(config, JSON.stringify({ servers: { own: { run: [process.execPath, mcpServer] }, second: { run: [process.execPath, mcpServer] } } }));
  writeFileSync(config, JSON.stringify({ servers: { own: { run: [process.execPath, mcpServer] }, stuck: { run: [process.execPath, '-e', 'setInterval(() => {}, 1000)', stuckMarker] } }, workspaces: { w: { path: join(dir, 'w'), tasks: { wait: { run: [process.execPath, '-e', 'setTimeout(() => {}, 60000)', stuckMarker] } } }, x: { path: join(dir, 'x') } } }));
  await until('the new server to show', async () => (await find()).found.some((f: any) => f.name === 'stuck'), 20_000);
  // Another server ticked while the first is still being checked: the check that counts is the new one's.
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend: { server: 'stuck', workspaces: [] } } });
  await until('the check of the stuck server to start', async () => (await find()).checking);
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend: { server: 'own', workspaces: [] } } });
  const swapped = await until('the check of the server ticked instead', async () => { const m = await find(); return !m.checking && m.checked?.results.some((r: any) => r.server === 'mcp') && m; });
  assert.deepEqual([swapped.status, swapped.checked.results.filter((r: any) => r.server === 'mcp').map((r: any) => r.ok)], ['ready', [true]]);
  await call(`/api/machines/${machine.id}`, { method: 'DELETE' });
});

test('a machine set up before ticks starts from what it lent when its agent first reports (#439)', async () => {
  const { mkdirSync } = await import('node:fs');
  const dir = join(root, 'carried');
  mkdirSync(join(dir, 'w'), { recursive: true });
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { command: process.execPath, args: [mcpServer] } } }));
  const config = join(dir, 'machine-agent.json');
  writeFileSync(config, JSON.stringify({ workspaces: { w: { path: join(dir, 'w') } } }));
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'carried' } });
  await lend(machine.id, (await call('/api/projects'))[0]);
  const find = async () => (await call('/api/machines')).find((m: any) => m.name === 'carried');
  // As caras-laptop is today: --claude-mcp godot-ai, its workspace tools switched on.
  const old = startAgent(token, ['--config', config, '--claude-mcp', 'godot-ai'], { CLAUDE_CONFIG_DIR: dir });
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { workspace_tools: true } });
  const before = await until('the old agent\'s check', async () => { const m = await find(); return m.status === 'ready' && m.checked.results.length === 2 && !m.checking && m; });
  assert.deepEqual([before.managed, before.lend, before.mcp_kind, before.mcp_command], [false, null, 'claude', 'godot-ai'], 'an agent set up the old way lends what its command line says');
  old.agent.kill();
  await until('it to go offline', async () => !(await find()).online);
  // Reinstalled with the new line: the same server and folders are ticked, so minions get what they got.
  startAgent(token, ['--config', config], { CLAUDE_CONFIG_DIR: dir });
  const after = await until('the new agent\'s report', async () => { const m = await find(); return m.managed && m.lend && m; });
  assert.deepEqual(after.lend, { server: 'godot-ai', workspaces: ['w'] });
  assert.equal((await until('it to be Ready', async () => { const m = await find(); return m.status === 'ready' && !m.checking && m; })).reason, before.reason);
  // A folder added later starts unticked.
  mkdirSync(join(dir, 'later'), { recursive: true });
  writeFileSync(config, JSON.stringify({ workspaces: { w: { path: join(dir, 'w') }, later: { path: join(dir, 'later') } } }));
  const more = await until('the new folder to show', async () => { const m = await find(); return m.workspaces.length === 2 && m; }, 20_000);
  assert.deepEqual(more.lend.workspaces, ['w']);
  await call(`/api/machines/${machine.id}`, { method: 'DELETE' });
});

test('an agent can run a server from Claude Code\'s config, and threads get the machine\'s notes', async () => {
  const home = join(root, 'pc-home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { type: 'stdio', command: process.execPath, args: [mcpServer] } } }));
  const [project] = await call('/api/projects');
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'desk' } });
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { notes: 'Never restart this PC.', projects: [project.id] } });
  startAgent(token, ['--claude-mcp', 'godot-ai'], { CLAUDE_CONFIG_DIR: home });
  const online = await until('desk to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'desk' && m.online));
  assert.match(online.command, /godot-ai/);
  // Added without a kind (as before #308), it learns what it runs from its agent, for its next setup lines.
  assert.deepEqual([online.mcp_kind, online.mcp_command], ['claude', 'godot-ai']);
  const before = turns().length;
  await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'play' } });
  const turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(turn.results.desk.tools, ['whoami']);
  assert.match(turn.message, /Notes on desk from its owner:\nNever restart this PC\./);
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
  await lend(machine.id, project);

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
  assert.match(turn.message, /wsbox \(mcp__wsbox, mcp__wsbox-ws\)[\s\S]*call its workspaces tool first/);
});

test('a machine reaches only the minions of the schemes on its list, and taking a scheme away ends its sessions (#303, #438)', async () => {
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'vault' } });
  assert.deepEqual(machine.projects, [], 'a new machine is lent to no scheme');
  startAgent(token);
  await until('vault to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'vault' && m.online));
  const a = await call('/api/projects', { method: 'POST', body: { name: 'Obsidian' } });
  const b = await call('/api/projects', { method: 'POST', body: { name: 'Elsewhere' } });
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [999999] } }), /400/);
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: 'all' } }), /400/);
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: null } }), /400/, '"every scheme an admin owns" is gone');
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
  assert.match(inA.message, /Notes on vault from its owner:\nJosh's vault\./);
  const inB = await turnIn(b, 'not lent');
  assert.equal(inB.results.vault, undefined);
  assert.ok(!inB.allow.includes('mcp__vault'));
  assert.doesNotMatch(inB.system + inB.message, /vault/);

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
  const nowB = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${inB.token}` } });
  assert.equal(nowB.status, 200);
  await nowB.body!.cancel();
  // The scheme's old machine tools switch is retired: off in the table, B's minions still get it.
  const store = new Store(join(root, 'data', 'coordinator.db'));
  store.db.prepare('UPDATE projects SET machine_tools = 0 WHERE id = ?').run(b.id);
  store.db.close();
  assert.deepEqual((await turnIn(b, 'switch off, still lent')).results.vault.tools, ['whoami']);
});

test('a person\'s own machine goes only to turns they ask for, in schemes they\'re in, and only they and admins manage it (#306)', async () => {
  // Two people who aren't admins, signed in with their own logins.
  const person = async (name: string) => {
    const made = await call('/api/people', { method: 'POST', body: { name } });
    const invite = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
    const theirs = invite.headers.get('set-cookie')!.split(';')[0];
    const as = async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(base + path, {
        method: opts.method ?? 'GET',
        headers: { Cookie: theirs, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      return { status: res.status, data: await res.json() };
    };
    // The next machines list the live stream sends them.
    const nextMachines = async () => {
      const res = await fetch(`${base}/api/stream`, { headers: { Cookie: theirs } });
      const reader = res.body!.getReader();
      return async () => {
        let text = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          text += new TextDecoder().decode(value);
          const msg = text.split('\n\n').map((l) => l.replace(/^data: /, '')).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((m) => m.type === 'machines');
          if (msg) {
            await reader.cancel();
            return msg.machines.map((m: any) => m.name);
          }
        }
      };
    };
    return { id: made.person.id as number, as, nextMachines };
  };
  const josh = await person('Josh');
  const dana = await person('Dana');
  // Their turns run on the server's login here, as the first admin's do: a stand-in for linking their own Claude.
  const store = new Store(join(root, 'data', 'coordinator.db'));
  for (const p of [josh, dana]) store.updateUser(p.id, { server_login: 1 });
  const shared = await call('/api/projects', { method: 'POST', body: { name: 'Shared' } });
  const notTheirs = await call('/api/projects', { method: 'POST', body: { name: 'Caras' } });
  for (const p of [josh, dana]) await call(`/api/projects/${shared.id}/members`, { method: 'POST', body: { person: p.id } });

  const added = await josh.as('/api/machines', { method: 'POST', body: { name: 'josh-box' } });
  assert.equal(added.status, 201);
  const { machine, token } = added.data;
  assert.equal(machine.owner_id, josh.id);
  startAgent(token);
  await until('josh-box to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'josh-box' && m.online));
  // It follows Josh, in the schemes he puts on its list (#438): his own to pick, but not one he can't see.
  assert.deepEqual(machine.projects, []);
  assert.equal((await josh.as(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [notTheirs.id] } })).status, 400);
  assert.equal((await josh.as(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [shared.id] } })).status, 200);
  assert.equal((await josh.as(`/api/machines/${machine.id}`, { method: 'PATCH', body: { notes: 'Josh\'s box.' } })).status, 200);

  // Another person can't see or change it; an admin can, and the live list is cut the same way.
  assert.deepEqual((await josh.as('/api/machines')).data.map((m: any) => m.name), ['josh-box']);
  assert.deepEqual((await dana.as('/api/machines')).data, []);
  for (const [method, path] of [['PATCH', `/api/machines/${machine.id}`], ['POST', `/api/machines/${machine.id}/token`], ['DELETE', `/api/machines/${machine.id}`]]) {
    assert.equal((await dana.as(path, { method, body: method === 'PATCH' ? { notes: 'mine now' } : undefined })).status, 404, `${method} ${path}`);
  }
  const [joshHears, danaHears] = [await josh.nextMachines(), await dana.nextMachines()];
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { notes: 'Josh\'s box, checked by an admin.' } });
  assert.deepEqual(await joshHears(), ['josh-box']);
  assert.deepEqual(await danaHears(), []);
  assert.ok((await call('/api/machines')).some((m: any) => m.name === 'josh-box'));

  // Josh's turn gets it; Dana's in the same scheme doesn't, nor a turn in a scheme Josh isn't in.
  const turnIn = async (as: typeof josh.as, project: any, message: string) => {
    const before = turns().length;
    const res = await as(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message } });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return (await until('a turn', () => turns().length > before && turns())).at(-1);
  };
  const asCara = async (path: string, opts: { method?: string; body?: unknown } = {}) => ({ status: 201, data: await call(path, opts) });
  const joshs = await turnIn(josh.as, shared, 'for josh');
  assert.deepEqual(joshs.results['josh-box'].tools, ['whoami']);
  assert.match(joshs.message, /Josh's box, checked by an admin/);
  const danas = await turnIn(dana.as, shared, 'for dana');
  assert.equal(danas.results['josh-box'], undefined);
  assert.ok(!danas.allow.includes('mcp__josh-box'));
  const caras = await turnIn(asCara, notTheirs, 'for cara');
  assert.equal(caras.results['josh-box'], undefined);
  // Nor can a turn that didn't get it open it by id.
  const refused = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${danas.token}` } });
  assert.equal(refused.status, 403);
  await refused.body!.cancel();

  // Off its list, Josh's own turn in the same scheme loses it.
  await josh.as(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [] } });
  assert.equal((await turnIn(josh.as, shared, 'josh, off the list')).results['josh-box'], undefined);

  // An admin's own: only Cara's turns, in the schemes on its list.
  const mineMade = await call('/api/machines', { method: 'POST', body: { name: 'cara-own', mine: true } });
  assert.equal(mineMade.machine.owner_id, (await call('/api/me')).id, "an admin's own machine is owned by Cara");
  await lend(mineMade.machine.id, notTheirs, shared);
  assert.equal((await call('/api/machines', { method: 'POST', body: { name: 'shared-box' } })).machine.owner_id, null);
  startAgent(mineMade.token);
  await until('cara-own to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'cara-own' && m.online));
  assert.deepEqual((await turnIn(asCara, notTheirs, 'cara again')).results['cara-own'].tools, ['whoami']);
  assert.equal((await turnIn(josh.as, shared, 'josh again')).results['cara-own'], undefined);

  assert.equal((await josh.as(`/api/machines/${machine.id}`, { method: 'DELETE' })).status, 200);
  await call(`/api/machines/${mineMade.machine.id}`, { method: 'DELETE' });
});

test('a contraption turn gets its person\'s own machines, and no one else\'s or a shared one (#306)', async () => {
  const made = await call('/api/contraptions', { method: 'POST', body: { name: 'tally', title: 'Tally', port: 9102 } });
  const key = readFileSync(join(made.keys_dir, 'contraption.key'), 'utf8');
  const me = await call('/api/me');
  const olive = await call('/api/people', { method: 'POST', body: { name: 'Olive' } });
  const store = new Store(join(root, 'data', 'coordinator.db'));
  store.updateUser(olive.person.id, { server_login: 1 });
  for (const id of [me.id, olive.person.id]) await call(`/api/contraptions/tally/people/${id}`, { method: 'PUT', body: { enabled: true } });

  const own = await call('/api/machines', { method: 'POST', body: { name: 'cara-app-box', mine: true } });
  await call(`/api/machines/${own.machine.id}`, { method: 'PATCH', body: { notes: 'The tally sheet lives here.' } });
  startAgent(own.token);
  const sharedBox = await call('/api/machines', { method: 'POST', body: { name: 'shared-app-box' } });
  startAgent(sharedBox.token);
  await until('both to come online', async () => (await call('/api/machines')).filter((m: any) => ['cara-app-box', 'shared-app-box'].includes(m.name) && m.online).length === 2);

  const turnFor = async (person: number) => {
    const before = turns().length;
    const res = await fetch(`${base}/api/contraptions/turns`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ person, session: 's', prompt: 'count' }),
    });
    const events = await res.text();
    assert.doesNotMatch(events, /event: error/, events);
    return (await until('a contraption turn', () => turns().length > before && turns())).at(-1);
  };
  const caras = await turnFor(me.id);
  assert.deepEqual(Object.keys(caras.results), ['cara-app-box'], 'her own machine, not the shared one');
  assert.deepEqual(caras.results['cara-app-box'].tools, ['whoami']);
  assert.match(caras.results['cara-app-box'].text, /^pid \d+$/, 'the call reached the machine');
  assert.ok(caras.allow.includes('mcp__cara-app-box'));
  assert.match(caras.system, /Connected machines: cara-app-box[\s\S]*The tally sheet lives here\./);
  const olives = await turnFor(olive.person.id);
  assert.deepEqual(olives.results, {});
  assert.equal(olives.system, '');

  // A minion's token doesn't open the contraption route, and a made-up turn token doesn't either.
  const forged = await fetch(`${base}/api/machines/${own.machine.id}/contraption-session`, { headers: { Authorization: 'Bearer cmt_forged' } });
  assert.equal(forged.status, 401);
  await forged.body!.cancel();
  for (const m of [own, sharedBox]) await call(`/api/machines/${m.machine.id}`, { method: 'DELETE' });
});

test('a Taskmaster lists the machines its scheme can see and checks one through a turn\'s path (#307)', async () => {
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const josh = store.findUser('name', 'Josh')!;
  const dana = store.findUser('name', 'Dana')!;
  const cara = store.findUser('name', 'Cara')!;
  const schemes = await call('/api/projects');
  const [shared, caras] = ['Shared', 'Caras'].map((n) => schemes.find((p: any) => p.name === n));
  const machine = (name: string, owner: number | null) => {
    const m = store.createMachine(name, '', 'Cara', owner);
    store.setMachineProjects(m.id, [shared.id]);
    const token = newToken(m.id);
    store.updateMachine(m.id, { token_hash: hashToken(token) });
    return token;
  };
  // sleepy (added above, never connected) is lent here too; unlent, a non-admin's ask wouldn't list it.
  store.setMachineProjects(store.listMachines().find((m) => m.name === 'sleepy')!.id, [shared.id]);
  startAgent(machine('tm-josh', josh.id));
  startAgent(machine('tm-box', null));
  // An agent whose MCP server dies at once: online, but the check fails.
  startAgent(machine('tm-broken', null), ['--', process.execPath, '-e', 'process.exit(1)']);
  await until('the machines to come online', async () => (await call('/api/machines')).filter((m: any) => m.name.startsWith('tm-') && m.online).length === 3);
  // Citadel checks each one as it connects, unasked (#437), and keeps the result.
  await until('their connect checks', async () => (await call('/api/machines')).filter((m: any) => m.name.startsWith('tm-') && m.checked && !m.checking).length === 3);

  // The Taskmaster's own MCP server, as its turn starts it, run for whoever asked for the turn.
  const tools = async (project: any, asker: number) => {
    const tm = (await call(`/api/projects/${project.id}`)).coordinator.id;
    store.setSetting(askerKey(tm), asker);
    const child = spawn(process.execPath, [join(repo, 'src', 'mcp.ts')], {
      env: { ...process.env, COORDINATOR_ROLE: 'coordinator', COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), tm), COORDINATOR_PROJECT: String(project.id) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    procs.push(child);
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    let n = 0;
    const use = async (name: string, args: object = {}) => {
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      const r = JSON.parse((await lines.next()).value).result;
      return (r.isError ? 'ERROR ' : '') + r.content[0].text as string;
    };
    return { use, tm, done: () => child.kill() };
  };

  // Josh's ask in a scheme he's in: his own machine and the shared ones, with their live state.
  const asJosh = await tools(shared, josh.id);
  let list = await asJosh.use('list_machines');
  assert.match(list, /^tm-josh: READY: Ready · 1 tool · checked [^\n]+\n  ONLINE, connected since \d{4}-\d\d-\d\d \d\d:\d\d UTC \((just now|1 min ago)\), host /m);
  assert.match(list, /Josh's own: goes to the turns they ask for, in Shared; this scheme's minions get it/);
  assert.match(list, /^tm-box: READY[^\n]*\n  ONLINE/m);
  assert.match(list, /lent to Shared; this scheme's minions get it/);
  assert.doesNotMatch(list, /Machine tools for this scheme/);
  assert.match(list, /^sleepy: ASLEEP: Not connected yet · added [^\n]+\n  OFFLINE, last seen never/m);
  assert.match(list, /^tm-broken: NEEDS A FIX: Its tools didn't start: the session ended[^\n]*\n  ONLINE[^]*?last check .*:\n  - MCP server: FAIL/m);

  const passed = await asJosh.use('check_machine', { name: 'tm-box' });
  assert.match(passed, /^tm-box: PASS\n- MCP server: PASS in \d+ ms, 1 tools: whoami$/);
  await until('the check\'s session to close', async () => (await call('/api/machines')).find((m: any) => m.name === 'tm-box').sessions === 0);
  list = await asJosh.use('list_machines');
  assert.match(list, /tm-box: READY[^]*?last check .*:\n  - MCP server: PASS in \d+ ms, 1 tools: whoami/);
  assert.match(await asJosh.use('check_machine', { name: 'tm-broken' }), /^tm-broken: FAIL\n- MCP server: FAIL after \d+ ms: the session ended/);
  assert.match(await asJosh.use('check_machine', { name: 'sleepy' }), /^sleepy: FAIL, offline/);
  assert.match(await asJosh.use('check_machine', { name: 'nope' }), /^ERROR .*No machine called nope/);
  asJosh.done();

  // Dana's ask in the same scheme doesn't see or reach Josh's machine.
  const asDana = await tools(shared, dana.id);
  list = await asDana.use('list_machines');
  assert.doesNotMatch(list, /tm-josh/);
  assert.match(list, /^tm-box: READY/m);
  assert.match(await asDana.use('check_machine', { name: 'tm-josh' }), /^ERROR .*No machine called tm-josh/);
  asDana.done();

  // An admin's ask sees every machine, even one whose owner isn't in this scheme.
  const asCara = await tools(caras, cara.id);
  assert.match(await asCara.use('list_machines'), /^tm-josh: READY[^]*?this scheme's minions don't get it/m);
  assert.match(await asCara.use('check_machine', { name: 'tm-josh' }), /^tm-josh: PASS\n[^]*Note: this scheme's minions don't get tm-josh/);
  asCara.done();

  // Only a Taskmaster: not a person, not a minion.
  await assert.rejects(call(`/api/projects/${shared.id}/machines`), /403/);
  const minion = await call(`/api/projects/${shared.id}/tickets`, { method: 'POST', body: { message: 'hi' } });
  const asMinion = await fetch(`${base}/api/projects/${shared.id}/machines`, { headers: { Authorization: `Bearer ${agentToken(join(root, 'data'), minion.id)}` } });
  assert.equal(asMinion.status, 403);
});

test('an older machine learns what it runs from its agent, and a known one keeps its own (#308)', async () => {
  const { mcpFromAgent } = await import('../src/machines.ts');
  assert.deepEqual(mcpFromAgent('workspace tools only'), { mcp_kind: 'none', mcp_command: '' });
  assert.deepEqual(mcpFromAgent('godot-ai (from Claude Code\'s config)'), { mcp_kind: 'claude', mcp_command: 'godot-ai' });
  assert.equal(mcpFromAgent('npx -y some-mcp'), null, 'a command comes joined with spaces, its quoting lost');
  assert.equal(mcpFromAgent(''), null);
  assert.equal(mcpFromAgent('x'.repeat(200)), null, 'cut at the route\'s 200 characters');
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'kept-box' } });
  new Store(join(root, 'data', 'coordinator.db')).updateMachine(machine.id, { mcp_kind: 'none' });
  startAgent(token, ['--', process.execPath, mcpServer]);
  const online = await until('kept-box to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'kept-box' && m.online));
  assert.deepEqual([online.mcp_kind, online.mcp_command], ['none', ''], 'what it was added with wins');
  await call(`/api/machines/${machine.id}`, { method: 'DELETE' });
});

test('Citadel checks a machine as it connects, keeps the result through a reconnect, and Check now runs one (#437)', async () => {
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'honest' } });
  const find = async () => (await call('/api/machines')).find((m: any) => m.name === 'honest');
  assert.equal((await find()).status, 'asleep', 'added a moment ago, not connected yet');
  const first = startAgent(token);
  // Its tools pass, but no scheme is on its list yet (#438): yellow, with the button that opens the list.
  const unlent = await until('its connect check', async () => { const m = await find(); return m.checked && !m.checking && m; });
  assert.deepEqual([unlent.status, unlent.reason, unlent.fix], ['fix', 'Lent to no scheme', 'lend']);
  await lend(machine.id, (await call('/api/projects'))[0]);
  const ready = await until('its connect check', async () => { const m = await find(); return m.checked && !m.checking && m.status === 'ready' && m; });
  assert.equal(ready.reason, 'Ready · 1 tool');
  assert.deepEqual(ready.checked.results.map((r: any) => [r.server, r.ok, r.tools]), [['mcp', true, ['whoami']]]);

  // Offline under five minutes, always on: no colour yet. Not always on: asleep.
  first.agent.kill();
  assert.equal((await until('it to go offline', async () => { const m = await find(); return !m.online && m; })).reason, 'Offline');
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { always_on: false } });
  assert.deepEqual([(await find()).always_on, (await find()).reason], [false, 'Asleep']);
  await assert.rejects(call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { always_on: 'yes' } }), /400 always_on must be true or false/);
  await assert.rejects(call(`/api/machines/${machine.id}/check`, { method: 'POST' }), /409 honest is offline/);

  // Back within the hour: the kept check stands, and isn't run again unasked.
  startAgent(token);
  await until('it to come back', async () => (await find()).online);
  await new Promise((r) => setTimeout(r, 1500));
  const back = await find();
  assert.equal(back.checked.at, ready.checked.at);
  assert.equal(back.status, 'ready');

  // Check now runs one anyway.
  const { machine: after, results } = await call(`/api/machines/${machine.id}/check`, { method: 'POST' });
  assert.deepEqual(results.map((r: any) => r.ok), [true]);
  assert.ok(after.checked.at > ready.checked.at);
});

test('a check that failed is run again when its agent reconnects, and a new server is checked on its own (#437)', async () => {
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'mended' } });
  await lend(machine.id, (await call('/api/projects'))[0]);
  const find = async () => (await call('/api/machines')).find((m: any) => m.name === 'mended');
  const broken = startAgent(token, ['--', process.execPath, '-e', 'process.exit(1)']);
  await until('its failed check', async () => { const m = await find(); return m.status === 'fix' && m.fix === 'check' && !m.checking; });
  // Its owner fixes the command and restarts the agent: Citadel checks again without being asked.
  broken.agent.kill();
  await until('it to go offline', async () => !(await find()).online);
  const config = join(root, 'mended-agent', 'machine-agent.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'mended-agent', 'w'), { recursive: true });
  writeFileSync(config, JSON.stringify({ workspaces: { w: { path: join(root, 'mended-agent', 'w') } } }));
  startAgent(token, ['--config', config, '--', process.execPath, mcpServer]);
  const ready = await until('it to be Ready', async () => { const m = await find(); return m.status === 'ready' && !m.checking && m; });
  assert.deepEqual(ready.checked.results.map((r: any) => r.server), ['mcp'], 'workspace tools are off, so only its MCP server');

  // Workspace tools switched on: only they are checked, and the MCP server's check keeps its time.
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { workspace_tools: true } });
  const both = await until('its workspace tools check', async () => { const m = await find(); return m.checked.results.length === 2 && !m.checking && m; });
  assert.deepEqual(both.checked.results.map((r: any) => [r.server, r.ok]), [['mcp', true], ['ws', true]]);
  assert.equal(both.checked.at, ready.checked.at);
  assert.equal(both.status, 'ready');
});

test('a person\'s own machine lists the schemes on its list as the ones their turns get it in (#437, #438)', async () => {
  const { machine } = await call('/api/machines', { method: 'POST', body: { name: 'caras-own', mine: true } });
  const [one] = await call('/api/projects');
  const mine = (await call('/api/machines')).find((m: any) => m.id === machine.id);
  assert.deepEqual([mine.projects, mine.gets], [[], []], 'Cara is in every scheme, but none is on its list yet');
  const lent = await lend(machine.id, one);
  assert.deepEqual([lent.projects, lent.gets], [[one.id], [one.id]]);
});
