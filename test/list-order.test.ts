import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { inOrder, moved } from '../public/reorder.js';
import { listeningPort, tempRoot, TEST_ZONE } from './helpers.ts';

// Dragging the schemes shelf or the app rail into your own order (#649): saved per person, followed by the lists.
const repo = join(import.meta.dirname, '..');
const tmp = tempRoot('list-order-');
const root = tmp.dir;
after(async () => {
  await tmp.teardown();
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
let caraId = 0;
before(async () => {
  const server = tmp.spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env,
      MACHINES_URL: undefined,
      CITADEL_HOST_SIGNALS: 'fixed',
      CITADEL_ZONE: TEST_ZONE,
      PORT: '0',
      DATA_DIR: join(root, 'data'),
      CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      COORDINATOR_PASSWORD: 'test-password-123',
      SESSION_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = `http://127.0.0.1:${await listeningPort(server)}`;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
  });
  cookies.Cara = res.headers.get('set-cookie')!.split(';')[0];
  caraId = (await call('Cara', '/api/me')).data.id;
  const { data: made } = await call('Cara', '/api/people', { method: 'POST', body: { name: 'Josh' } });
  joshId = made.person.id;
  const invite = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'josh-password-1' }) });
  cookies.Josh = invite.headers.get('set-cookie')!.split(';')[0];
});

test('inOrder puts what the order names first, in its order, and the rest after as they came', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(
    inOrder(items, (x: string) => x, ['d', 'b']),
    ['d', 'b', 'a', 'c', 'e'],
  );
  assert.deepEqual(
    inOrder(items, (x: string) => x, []),
    items,
    "no saved order: the list's usual one",
  );
  assert.deepEqual(
    inOrder(items, (x: string) => x, ['gone', 'c']),
    ['c', 'a', 'b', 'd', 'e'],
    'a key for something gone is skipped',
  );
  // Ids saved as numbers still match ids that come as numbers or strings.
  assert.deepEqual(
    inOrder([{ id: 1 }, { id: 2 }], (p: { id: number }) => p.id, [2, 1]).map((p) => p.id),
    [2, 1],
  );
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
});

const names = async (who: string) => (await call(who, '/api/projects')).data.map((p: { name: string }) => p.name);

test("a scheme order is the dragger's own, and a scheme they never placed goes at the end", async () => {
  const ids: Record<string, number> = {};
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    ids[name] = (await call('Cara', '/api/projects', { method: 'POST', body: { name } })).data.id;
    assert.equal((await call('Cara', `/api/projects/${ids[name]}/members`, { method: 'POST', body: { person: joshId } })).status, 200);
  }
  const usual = await names('Cara');
  assert.deepEqual(
    usual.filter((n: string) => n in ids),
    ['Alpha', 'Bravo', 'Charlie'],
  );

  assert.deepEqual(await call('Cara', '/api/me/order/schemes', { method: 'PUT', body: { keys: [ids.Charlie, ids.Alpha] } }), { status: 200, data: { keys: [ids.Charlie, ids.Alpha] } });
  const mine = await names('Cara');
  assert.deepEqual(mine.slice(0, 2), ['Charlie', 'Alpha']);
  assert.ok(mine.indexOf('Bravo') > 1, 'unplaced after the placed ones');
  assert.deepEqual(
    await names('Josh'),
    usual.filter((n: string) => n in ids),
    'Josh keeps the usual order',
  );

  // The shelf saves its whole list on a drop, so a scheme made after the drag goes at the end of it.
  const all = (await call('Cara', '/api/projects')).data.map((p: { id: number }) => p.id);
  await call('Cara', '/api/me/order/schemes', { method: 'PUT', body: { keys: all } });
  const { data: delta } = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Aardvark' } });
  assert.equal((await names('Cara')).at(-1), 'Aardvark');
  // Dragged again: the newer order wins whole.
  await call('Cara', '/api/me/order/schemes', { method: 'PUT', body: { keys: [delta.id, ids.Bravo, ids.Alpha, ids.Charlie] } });
  assert.deepEqual((await names('Cara')).slice(0, 4), ['Aardvark', 'Bravo', 'Alpha', 'Charlie']);
});

test("an app order is the dragger's own and the rail's list follows it", async () => {
  for (const [name, title, port] of [
    ['zed', 'Zed', 9111],
    ['amber', 'Amber', 9112],
    ['moss', 'Moss', 9113],
  ] as const) {
    assert.equal((await call('Cara', '/api/contraptions', { method: 'POST', body: { name, title, port } })).status, 201);
    for (const id of [caraId, joshId]) await call('Cara', `/api/contraptions/${name}/people/${id}`, { method: 'PUT', body: { enabled: true } });
  }
  const apps = async (who: string) => (await call(who, '/api/contraptions/mine')).data.map((c: { name: string }) => c.name);
  assert.deepEqual(await apps('Cara'), ['amber', 'moss', 'zed'], 'by title until dragged');
  assert.equal((await call('Cara', '/api/me/order/apps', { method: 'PUT', body: { keys: ['zed', 'amber'] } })).status, 200);
  assert.deepEqual(await apps('Cara'), ['zed', 'amber', 'moss']);
  assert.deepEqual(await apps('Josh'), ['amber', 'moss', 'zed']);
});

test('the order route takes only a list of keys of the right kind, each once', async () => {
  const put = (list: string, keys: unknown) => call('Cara', `/api/me/order/${list}`, { method: 'PUT', body: { keys } });
  assert.equal((await put('minions', [])).status, 404);
  for (const bad of [null, 'zed', [1, 1], ['1'], [0], [1.5]]) assert.equal((await put('schemes', bad)).status, 400, JSON.stringify(bad));
  for (const bad of [[1], ['Zed'], ['zed', 'zed'], ['../x']]) assert.equal((await put('apps', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await put('apps', [])).status, 200, 'an empty order is the usual one again');
});
