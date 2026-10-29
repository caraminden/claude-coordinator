import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, freePort, until } from './helpers.ts';

// With MACHINES_URL set, agents connect only there (the tailnet), and that listener serves nothing
// but agents.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'machines-tailnet-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

const mcpServer = join(root, 'fake-mcp.mjs');
writeFileSync(mcpServer, 'process.stdin.resume();\n');

let base = '';
let agentBase = '';
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

function startAgent(url: string, token: string) {
  const agent = spawn(process.execPath, [join(repo, 'public/machine-agent.mjs'), url, token, '--', process.execPath, mcpServer], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(agent);
  let output = '';
  agent.stdout!.on('data', (d) => (output += d));
  agent.stderr!.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((r) => agent.on('exit', r));
  return { output: () => output, exited };
}

before(async () => {
  agentBase = `http://127.0.0.1:${await freePort()}`;
  const srv = await bootServer({ root, env: { MACHINES_URL: agentBase }, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
  await until('the machines listener', () => fetch(`${agentBase}/machine-agent.mjs`).then((r) => r.ok).catch(() => false));
});

test('agents connect only at the machines URL, which the setup is given', async () => {
  const { token, agent_url } = await call('/api/machines', { method: 'POST', body: { name: 'laptop' } });
  assert.equal(agent_url, agentBase);

  // The app's own address refuses agents, even with a good token, and says where to go.
  const refused = startAgent(base, token);
  assert.equal(await refused.exited, 1);
  assert.match(refused.output(), new RegExp(`connect at ${agentBase}`));

  startAgent(agentBase, token);
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
