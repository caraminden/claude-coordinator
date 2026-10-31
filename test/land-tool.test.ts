import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
