import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, freePort, until, stopProcs, tempRoot, ok, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';

// With MACHINES_URL set, agents connect only there (the tailnet), and that listener serves nothing
// but agents.
const repo = join(import.meta.dirname, '..');
const tmp = tempRoot('machines-tailnet-');
const root = tmp.dir;
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await tmp.teardown();
});

const { fakeClaude, turns, startMachineAgent } = machineFakes(root, procs);

let base = '';
let agentBase = '';
let cookie = '';

let srv: Booted;
const call = async (path: string, opts: { method?: string; body?: unknown } = {}) => ok(await srv.call(path, opts.body || undefined, opts.method ?? 'GET'));

before(async () => {
  // The server listens on the MACHINES_URL it is given and can't report a port of its own, so this one is picked up front.
  agentBase = `http://127.0.0.1:${await freePort()}`;
  srv = await bootServer({ root, env: { MACHINES_URL: agentBase, CLAUDE_BIN: fakeClaude }, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
  await until('the machines listener', () => fetch(`${agentBase}/machine-agent.mjs`).then((r) => r.ok).catch(() => false));
});

test('agents connect only at the machines URL, which the setup is given', async () => {
  const { token, agent_url } = await call('/api/machines', { method: 'POST', body: { name: 'laptop' } });
  assert.equal(agent_url, agentBase);

  // The app's own address refuses agents, even with a good token, and says where to go.
  const refused = startMachineAgent({ base, token });
  assert.equal(await refused.exited, 1);
  assert.match(refused.output(), new RegExp(`connect at ${agentBase}`));

  startMachineAgent({ base: agentBase, token });
  await until('laptop to come online', async () => (await call('/api/machines')).find((m: any) => m.name === 'laptop' && m.online));
});

test('the machines listener serves nothing but agents', async () => {
  for (const path of ['/', '/index.html', '/api/me', '/api/machines', '/api/projects']) {
    assert.equal((await fetch(agentBase + path, { headers: { Cookie: cookie } })).status, 404, path);
  }
  assert.equal((await fetch(`${agentBase}/api/login`, { method: 'POST', body: '{}' })).status, 404);
  assert.match(await (await fetch(`${agentBase}/machine-agent.mjs`)).text(), /machine agent/);
  assert.equal((await fetch(`${agentBase}/api/machines/connect`)).status, 401);
});

test('every route the agent calls is served at the machines URL, and refused at the app address', async () => {
  const { token } = await call('/api/machines', { method: 'POST', body: { name: 'desk' } });
  const auth = { Authorization: `Bearer ${token}` };
  // Every path machine-agent.mjs calls; a 404 here means the listener drops it before its handler.
  for (const [method, path] of [['GET', '/api/machines/connect'], ['POST', '/api/machines/send'], ['POST', '/api/machines/info'], ['POST', '/api/machines/upload']]) {
    assert.equal((await fetch(agentBase + path, { method })).status, 401, `${path} at the machines URL`);
    const here = await fetch(base + path, { method, headers: auth });
    assert.equal(here.status, 403, `${path} at the app address`);
    assert.match((await here.json()).error, new RegExp(`connect at ${agentBase}`));
  }
  // Not connected yet: info says so, and an upload has no workspace session to go to.
  assert.equal((await fetch(`${agentBase}/api/machines/info`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
  assert.equal((await fetch(`${agentBase}/api/machines/send`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"beat":true}' })).status, 409);
  assert.equal((await fetch(`${agentBase}/api/machines/upload?session=nope&name=a.txt`, { method: 'POST', headers: auth, body: 'hi' })).status, 410);
});

test('a workspace turn works end to end with the agent on the machines URL: its tools, fetch_file and run_task', async () => {
  const folder = join(root, 'ws-folder');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'report.zip'), 'zip bytes');
  const configFile = join(root, 'studio.json');
  writeFileSync(configFile, JSON.stringify({ workspaces: { w: { path: folder, tasks: { hi: { run: [process.execPath, '-e', 'console.log("task ran")'] } } } } }));
  const { machine, token } = await call('/api/machines', { method: 'POST', body: { name: 'studio' } });
  startMachineAgent({ base: agentBase, token, run: ['--config', configFile] });
  // The workspaces arrive through /api/machines/info.
  const online = await until('studio to report its workspace', async () => (await call('/api/machines')).find((m: any) => m.name === 'studio' && m.workspaces.length));
  assert.deepEqual(online.servers, ['ws']);
  assert.equal(online.reason, 'Lends nothing: nothing is ticked', 'a folder is lent once it is ticked (#439)');
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { lend: { server: null, workspaces: ['w'] } } });

  const project = await call('/api/projects', { method: 'POST', body: { name: 'Vault' } });
  await call(`/api/machines/${machine.id}`, { method: 'PATCH', body: { projects: [project.id] } }); // a new machine is lent to no scheme (#438)
  const before = turns().length;
  const ticket = await call(`/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'vault' } });
  const turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.equal(turn.error, undefined);
  assert.ok(turn.allow.includes('mcp__studio-ws'));
  const ws = turn.results['studio-ws'];
  assert.ok(ws.tools.includes('run_task') && ws.tools.includes('fetch_file'));
  assert.match(ws.text, /## w\nFolder: .*ws-folder/);
  // fetch_file goes through /api/machines/upload.
  const copied = ws.fetched.match(/to (\S+) on the app/)?.[1];
  assert.ok(copied, ws.fetched);
  assert.match(copied, new RegExp(`shared/${ticket.ticket?.id ?? ticket.id}/machine-files/studio/report\\.zip$`));
  assert.equal(readFileSync(copied, 'utf8'), 'zip bytes');
  assert.match(ws.ran, /task ran/);
});
