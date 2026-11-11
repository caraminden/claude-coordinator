import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { agentToken, bootServer, REPO, until } from './helpers.ts';

// The land tool (src/land.ts) for a container turn: the server runs the minion's tools/land.sh on the
// host. A stand-in land.sh prints the token it was given.
const srv = await bootServer();
after(() => srv.stop());

test("landing keeps the calling turn's token: land.sh gets it, and the turn's tools stay logged in (#225)", async () => {
  const store = new Store(join(srv.data, 'coordinator.db'));
  const project = store.createProject('P', null);
  // The scheme this server runs, so the route lets it land.
  store.setProjectRepoDir(project.id, REPO);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.root, 'worktree');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  writeFileSync(join(cwd, 'tools', 'land.sh'), 'echo "token:$COORDINATOR_TOKEN"\n');
  store.setTicketDir(minion.id, cwd, null);
  const token = agentToken(srv.data, minion.id);
  const call = (method: string) => fetch(`${srv.base}/api/tickets/${minion.id}/land`, { method, headers: { Authorization: `Bearer ${token}` } });

  assert.equal((await call('POST')).status, 202);
  const run = await until('land.sh ends', async () => {
    const res = await call('GET');
    assert.equal(res.status, 200, 'the turn is still logged in');
    const body = await res.json();
    return body.code === null ? null : body;
  });
  assert.equal(run.code, 0);
  assert.equal(run.output.trim(), `token:${token}`);
});

test('the land tool says the server restarted when the landing it started is no longer known, rather than failing (#468 S06-6)', async () => {
  // A server that started the landing, then restarted (a deploy) and forgot it before the next poll.
  const api = createServer((req, res) => {
    const send = (status: number, data: object) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.method === 'POST') return send(202, { output: '', code: null });
    send(404, { error: 'No landing has started for this minion' });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`, COORDINATOR_TOKEN: '7.sig',
      COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '7', COORDINATOR_ROLE: 'thread', COORDINATOR_DEPLOYS: '1', COORDINATOR_CONTAINER: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'land', arguments: {} } }) + '\n');
    const { result } = await reply;
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(result.content[0].text, /restarted/);
    assert.match(result.content[0].text, /git log main/);
  } finally {
    child.kill();
    api.close();
  }
});
