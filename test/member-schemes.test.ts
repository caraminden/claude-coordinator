import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { listeningPort, tempRoot, TEST_ZONE } from './helpers.ts';
import { json, type Reply } from './typed.ts';

// #674 (Cara, 2026-11-14: "I added Alex to the Citadel scheme and now it shows him as if he is in every scheme"):
// admin reach (the flag, or Citadel membership since #621) still opens every scheme, but GET /api/projects marks
// which ones the person really owns or was added to, so their lists show those as theirs and the rest apart.
const repo = join(import.meta.dirname, '..');
const tmp = tempRoot('member-schemes-');
const root = tmp.dir;
after(() => tmp.teardown());

let base = '';
const cookies: Record<string, string> = {};

async function call<T = unknown>(who: string, path: string, opts: { method?: string; body?: unknown } = {}): Promise<Reply<T>> {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookies[who], ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await json<T>(res) };
}

async function person(name: string, password: string): Promise<number> {
  const { data: made } = await call<{ token: string; person: { id: number } }>('Cara', '/api/people', { method: 'POST', body: { name } });
  const invite = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  cookies[name] = invite.headers.get('set-cookie')!.split(';')[0];
  return made.person.id;
}

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
});

const mine = async (who: string) => Object.fromEntries((await call<{ name: string; member: boolean }[]>(who, '/api/projects')).data.map((p) => [p.name, p.member]));

test('a Citadel member in one other scheme has those two as theirs; the rest are listed apart, still open to them', async () => {
  const schemes: Record<string, number> = {};
  for (const name of ['Delve', 'Citadel', 'Genesis']) schemes[name] = (await call<{ id: number }>('Cara', '/api/projects', { method: 'POST', body: { name } })).data.id;
  assert.equal(schemes.Citadel, GLOBAL_OWNER, "the fixture's second scheme is the Citadel scheme");
  const alex = await person('Alex', 'alex-password-1');
  const josh = await person('Josh', 'josh-password-1');
  for (const name of ['Citadel', 'Genesis']) assert.equal((await call('Cara', `/api/projects/${schemes[name]}/members`, { method: 'POST', body: { person: alex } })).status, 200);
  assert.equal((await call('Cara', `/api/projects/${schemes.Delve}/members`, { method: 'POST', body: { person: josh } })).status, 200);
  // Josh's own scheme, which Cara (an admin) was never added to.
  assert.equal((await call('Josh', '/api/projects', { method: 'POST', body: { name: 'Threadspace', source: 'none' } })).status, 201);

  assert.deepEqual(await mine('Alex'), { Delve: false, Citadel: true, Genesis: true, Threadspace: false });
  // Admin reach is unchanged: Alex still opens a scheme he isn't in.
  assert.equal((await call('Alex', `/api/projects/${schemes.Delve}`)).status, 200);
  // The admin flag gets the same treatment: Cara's list marks Josh's scheme as not hers.
  assert.deepEqual(await mine('Cara'), { Delve: true, Citadel: true, Genesis: true, Threadspace: false });
  // A plain member sees only theirs, all marked so.
  assert.deepEqual(await mine('Josh'), { Delve: true, Threadspace: true });
});
