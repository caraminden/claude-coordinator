import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { listeningPort, tempRoot } from './helpers.ts';

// Hiding a scheme (#226): each person's own, out of their list's badges, never anyone else's.
const repo = join(import.meta.dirname, '..');
const tmp = tempRoot('hidden-schemes-');
const root = tmp.dir;
after(() => tmp.teardown()); // its children exit and turns (detached, #271) end before the folder goes

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
  const server = tmp.spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, CITADEL_HOST_SIGNALS: 'fixed', PORT: '0', DATA_DIR: join(root, 'data'), CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
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
  // A minion waiting on people's answer (one-tap replies; ready and try don't count since #1121) gives the scheme a Needs-you count.
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const t = store.createTicket({ project_id: obsidian.id, kind: 'ticket', title: 'Asking one', permission_mode: 'default', created_by: 'Josh' });
  store.updateTicket(t.id, { replies: JSON.stringify(['Ship it']) });
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

test('running: a scheme with a turn running, its Taskmaster\'s included, says so for the spinner; a hidden one stays quiet (#248)', async () => {
  const { data: busy } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Busy' } });
  assert.equal((await listed('Cara', busy.id)).running, false, 'nothing running yet');
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const t = store.createTicket({ project_id: busy.id, kind: 'ticket', title: 'Working one', permission_mode: 'default', created_by: 'Cara' });
  const tm = store.createTicket({ project_id: busy.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  const t2 = store.createTicket({ project_id: busy.id, kind: 'ticket', title: 'Another', permission_mode: 'default', created_by: 'Cara' });
  assert.equal((await listed('Cara', busy.id)).working, 0, 'nothing working yet');
  store.updateTicket(t.id, { status: 'running' });
  assert.equal((await listed('Cara', busy.id)).running, true, 'a minion mid-turn');
  assert.equal((await listed('Cara', busy.id)).working, 1, 'one minion working (#278)');
  store.updateTicket(t2.id, { status: 'running' });
  assert.equal((await listed('Cara', busy.id)).working, 2, 'two minions working (#278)');
  store.updateTicket(t.id, { status: 'idle', state: 'parked' });
  store.updateTicket(t2.id, { status: 'idle' });
  assert.equal((await listed('Cara', busy.id)).running, false, 'parked and idle: not working');
  store.updateTicket(tm.id, { status: 'running' });
  assert.equal((await listed('Cara', busy.id)).running, true, 'the Taskmaster mid-turn');
  assert.equal((await listed('Cara', busy.id)).working, 0, 'the Taskmaster spins the spinner but is not a minion to count (#278)');
  store.updateTicket(t.id, { status: 'running' });
  await call('Cara', `/api/projects/${busy.id}/hidden`, { method: 'PUT', body: { hidden: true } });
  assert.equal((await listed('Cara', busy.id)).running, false, 'hidden: no spinner');
  assert.equal((await listed('Cara', busy.id)).working, 0, 'hidden: no count');
  store.db.close();
});

test('fresh: something waits that wasn\'t waiting when you last opened the scheme, compared item by item, kept per person; a stranger stores nothing (#498, #539)', async () => {
  const { data: quartz } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Quartz' } });
  assert.equal((await call('Cara', `/api/projects/${quartz.id}/members`, { method: 'POST', body: { person: joshId } })).status, 200);
  const store = new Store(join(root, 'data', 'coordinator.db'));
  // Each waits on an answer through one-tap replies (ready and try don't count since #1121); clearing them is it going away.
  const minion = (title: string) => {
    const t = store.createTicket({ project_id: quartz.id, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { replies: JSON.stringify(['Go']) });
    return t.id;
  };
  const pill = (who: string) => listed(who, quartz.id).then((p) => [p.inbox, p.fresh]);
  // What the scheme page sends: the keys of the items it shows waiting.
  const open = async (who: string) => {
    const { data } = await call(who, `/api/projects/${quartz.id}/inbox`);
    assert.equal((await call(who, `/api/projects/${quartz.id}/seen-items`, { method: 'PUT', body: { keys: data.items.map((i: any) => i.key) } })).status, 200);
  };
  const a = minion('A');
  const b = minion('B');
  // First sight: today's items count as seen, so nothing is marked on day one.
  assert.deepEqual(await pill('Cara'), [2, false]);
  const c = minion('C');
  assert.deepEqual(await pill('Cara'), [3, true], 'up: new');
  await open('Cara');
  assert.deepEqual(await pill('Cara'), [3, false], 'opening the scheme saw it');
  store.updateTicket(a, { replies: null });
  assert.deepEqual(await pill('Cara'), [2, false], 'only gone away: plain');
  const d = minion('D');
  store.updateTicket(b, { replies: null });
  assert.deepEqual(await pill('Cara'), [2, true], 'one came, one went: same count, still new (Josh, 2026-11-11)');
  store.updateTicket(c, { replies: null });
  assert.deepEqual(await pill('Cara'), [1, true], 'one came, two went: down, still new');
  store.updateTicket(d, { replies: null });
  assert.deepEqual(await pill('Cara'), [0, false], 'the new one went too: nothing at zero');
  // Josh's first look takes today's items, and Cara's marks never were his.
  minion('E');
  assert.deepEqual(await pill('Josh'), [1, false]);
  assert.deepEqual(await pill('Cara'), [1, true], 'Josh\'s look is his own');
  await open('Josh');
  assert.deepEqual(await pill('Cara'), [1, true]);
  for (const keys of [null, 'state:1', [1], ['x'.repeat(201)]]) assert.equal((await call('Cara', `/api/projects/${quartz.id}/seen-items`, { method: 'PUT', body: { keys } })).status, 400, JSON.stringify(keys));
  store.db.close();
  const { data: carasOwn } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Private two' } });
  assert.equal((await call('Josh', `/api/projects/${carasOwn.id}/seen-items`, { method: 'PUT', body: { keys: [] } })).status, 404);
});

test("a card another scheme addressed to you isn't in this scheme's Needs you list (Josh, 2026-11-19: keep schemes isolated)", async () => {
  const { data: here } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Here' } });
  const { data: there } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'There' } });
  for (const p of [here, there]) assert.equal((await call('Cara', `/api/projects/${p.id}/members`, { method: 'POST', body: { person: joshId } })).status, 200);
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const tm = store.createTicket({ project_id: there.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  store.addEvent(tm.id, 'question', { id: 'q-cross', questions: [], to: 'Josh' });
  const ids = async (id: number) => (await call('Josh', `/api/projects/${id}/inbox`)).data.items.map((i: any) => i.card?.id);
  assert.deepEqual(await ids(there.id), ['q-cross'], 'its own scheme still lists it');
  assert.deepEqual(await ids(here.id), [], 'another scheme does not');
  store.db.close();
});
