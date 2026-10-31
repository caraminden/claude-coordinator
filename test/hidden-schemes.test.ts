import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { listeningPort } from './helpers.ts';

// Hiding a scheme (#226): each person's own, out of their list's badges, never anyone else's.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'hidden-schemes-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

let base = '';
const cookies: Record<string, string> = {};

async function call(who: string, path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookies[who], ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

let joshId = 0;
before(async () => {
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: '0', DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(server);
  base = `http://127.0.0.1:${await listeningPort(server)}`;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
  });
  cookies.Cara = res.headers.get('set-cookie')!.split(';')[0];
  const { data: made } = await call('Cara', '/api/people', { method: 'POST', body: { name: 'Josh' } });
  joshId = made.person.id;
  const invite = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'josh-password-1' }) });
  cookies.Josh = invite.headers.get('set-cookie')!.split(';')[0];
});

const listed = async (who: string, id: number) => (await call(who, '/api/projects')).data.find((p: any) => p.id === id);

test('a hide is the hider\'s own: it flags the scheme and zeroes its badge for them only, and Unhide restores it', async () => {
  const { data: obsidian } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Obsidian' } });
  assert.equal((await call('Cara', `/api/projects/${obsidian.id}/members`, { method: 'POST', body: { person: joshId } })).status, 200);
  // A minion waiting on people gives the scheme a Needs-you count.
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const t = store.createTicket({ project_id: obsidian.id, kind: 'ticket', title: 'Ready one', permission_mode: 'default', created_by: 'Josh' });
  store.updateTicket(t.id, { state: 'ready', note: 'done' });
  store.db.close();
  assert.equal((await listed('Cara', obsidian.id)).inbox, 1);

  assert.deepEqual(await call('Cara', `/api/projects/${obsidian.id}/hidden`, { method: 'PUT', body: { hidden: true } }), { status: 200, data: { hidden: true } });
  const mine = await listed('Cara', obsidian.id);
  assert.equal(mine.hidden, true);
  assert.equal(mine.inbox, 0);
  // Josh still has it, badge and all.
  const his = await listed('Josh', obsidian.id);
  assert.equal(his.hidden, false);
  assert.equal(his.inbox, 1);
  // Hiding changes nothing about access: the scheme still opens.
  assert.equal((await call('Cara', `/api/projects/${obsidian.id}`)).status, 200);

  assert.equal((await call('Cara', `/api/projects/${obsidian.id}/hidden`, { method: 'PUT', body: { hidden: false } })).status, 200);
  const back = await listed('Cara', obsidian.id);
  assert.equal(back.hidden, false);
  assert.equal(back.inbox, 1);

  // There is no saying whose hide it is: Josh naming Cara hides it for Josh.
  assert.equal((await call('Josh', `/api/projects/${obsidian.id}/hidden`, { method: 'PUT', body: { hidden: true, person: 1, user_id: 1 } })).status, 200);
  assert.equal((await listed('Josh', obsidian.id)).hidden, true);
  assert.equal((await listed('Cara', obsidian.id)).hidden, false);
});

test('nobody hides a scheme they aren\'t in, and the body must say true or false', async () => {
  const { data: carasOwn } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Private' } });
  // Not in it: answers as if it didn't exist, and nothing is stored for anyone.
  assert.equal((await call('Josh', `/api/projects/${carasOwn.id}/hidden`, { method: 'PUT', body: { hidden: true } })).status, 404);
  assert.equal((await listed('Cara', carasOwn.id)).hidden, false);
  assert.equal((await call('Cara', `/api/projects/${carasOwn.id}/hidden`, { method: 'PUT', body: { hidden: 'yes' } })).status, 400);
});
