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

test('a machine keeps the MCP server it was added with, through a new token (#308)', async () => {
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'mcp-pc', kind: 'godot' } }), /400/);
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'mcp-pc', kind: 'command', command: ' ' } }), /400/);
  await assert.rejects(call('/api/machines', { method: 'POST', body: { name: 'mcp-pc', kind: 'command', command: 'a\nb' } }), /400/);
  assert.ok(!(await call('/api/machines')).some((m: any) => m.name === 'mcp-pc'), 'a refused add leaves no machine behind');
  const { machine } = await call('/api/machines', { method: 'POST', body: { name: 'mcp-pc', kind: 'none', command: 'godot-ai' } });
  assert.deepEqual([machine.mcp_kind, machine.mcp_command], ['none', '']);
  const renewed = await call(`/api/machines/${machine.id}/token`, { method: 'POST' });
  assert.deepEqual([renewed.machine.mcp_kind, renewed.machine.mcp_command], ['none', '']);
  const { machine: cmd } = await call('/api/machines', { method: 'POST', body: { name: 'cmd-pc', kind: 'command', command: ' npx -y x ' } });
  assert.deepEqual([cmd.mcp_kind, cmd.mcp_command], ['command', 'npx -y x']);
  const { machine: old } = await call('/api/machines', { method: 'POST', body: { name: 'old-pc' } });
  assert.equal(old.mcp_kind, null, 'an add without kind (an older page) leaves it unknown');
  for (const m of [machine, cmd, old]) await call(`/api/machines/${m.id}`, { method: 'DELETE' });
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
  // Added without a kind (as before #308), it learns what it runs from its agent, for its next setup lines.
  assert.deepEqual([online.mcp_kind, online.mcp_command], ['claude', 'godot-ai']);
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
  // Nothing to lend: it follows Josh.
  assert.equal((await josh.as(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [shared.id] } })).status, 400);
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
  assert.match(joshs.system, /Josh's box, checked by an admin/);
  const danas = await turnIn(dana.as, shared, 'for dana');
  assert.equal(danas.results['josh-box'], undefined);
  assert.ok(!danas.allow.includes('mcp__josh-box'));
  const caras = await turnIn(asCara, notTheirs, 'for cara');
  assert.equal(caras.results['josh-box'], undefined);
  // Nor can a turn that didn't get it open it by id.
  const refused = await fetch(`${base}/api/machines/${machine.id}/session`, { headers: { Authorization: `Bearer ${danas.token}` } });
  assert.equal(refused.status, 403);
  await refused.body!.cancel();

  // An admin's own: only Cara's turns. A shared machine (no owner) still goes everywhere an admin owns.
  const mineMade = await call('/api/machines', { method: 'POST', body: { name: 'cara-own', mine: true } });
  assert.equal(mineMade.machine.owner_id !== null, true);
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
    const m = store.createMachine(name, '', 'Cara', owner, owner !== null);
    const token = newToken(m.id);
    store.updateMachine(m.id, { token_hash: hashToken(token) });
    return token;
  };
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
  assert.match(list, /Josh's own: goes to the turns they ask for, in schemes they're in; this scheme's minions get it/);
  assert.match(list, /^tm-box: READY[^\n]*\n  ONLINE/m);
  assert.match(list, /lent to every scheme an admin owns/);
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
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'kept-box', kind: 'none' } });
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
