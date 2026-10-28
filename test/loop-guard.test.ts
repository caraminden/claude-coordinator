import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { LOOP_LIMIT, LOOP_WINDOW_MS, Runner } from '../src/runner.ts';

// The loop guard: Taskmaster↔minion messages past LOOP_LIMIT an hour wait for a person. A stand-in
// `claude -p` ends every turn at once.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'loop-guard-'));
const procs: ChildProcess[] = [];
const SECRET = 'x'.repeat(40);
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fake, 0o755);

const said = (store: Store, id: number) => store.listEvents(id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data).text);
const kinds = (store: Store, id: number, kind: string) => store.listEvents(id).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data));

test('6 go through, the 7th is held, Continue releases it and starts the count again', () => {
  const store = new Store(join(root, 'runner.db'));
  const project = store.createProject('P', null);
  const coordinator = store.createTicket({ project_id: project.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  for (const t of [coordinator, minion]) store.setTicketDir(t.id, root, null);
  let runner = new Runner(store, () => {}, () => ({}), fake);
  let now = 1_000_000;
  runner.now = () => now;

  // Both directions count towards the same minion.
  for (let i = 0; i < LOOP_LIMIT; i++) {
    const toMinion = i % 2 === 0;
    assert.equal(runner.relay(minion.id, toMinion ? minion.id : coordinator.id, toMinion ? 'Taskmaster' : '#1 M', `m${i}`), false);
  }
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'seventh'), true);
  assert.ok(!said(store, minion.id).includes('seventh'));
  for (const id of [minion.id, coordinator.id]) {
    const [paused] = kinds(store, id, 'loop_paused');
    assert.match(paused.text, /^Paused: #1 and the Taskmaster have exchanged 6 messages in the last hour, so the Taskmaster's message to #1 \("seventh"\) is held/);
    assert.equal(paused.minion, minion.id);
  }
  // Once paused, the next waits too, even the other way.
  assert.equal(runner.relay(minion.id, coordinator.id, '#1 M', 'eighth'), true);
  assert.match(kinds(store, coordinator.id, 'loop_paused')[1].text, /^Also held: #1's message to the Taskmaster/);

  // Held messages outlive a restart: a new Runner on the same database still has them.
  runner = new Runner(store, () => {}, () => ({}), fake);
  runner.now = () => now;
  assert.equal(runner.continueLoop(minion.id, 'Cara'), 2);
  assert.ok(said(store, minion.id).includes('seventh'));
  assert.ok(said(store, coordinator.id).includes('eighth'));
  assert.equal(kinds(store, minion.id, 'loop_continued')[0].text, 'Cara continued, so the 2 held messages went through.');
  assert.equal(runner.continueLoop(minion.id, 'Cara'), 0);

  // The count starts again from Continue.
  for (let i = 0; i < LOOP_LIMIT; i++) assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', `again ${i}`), false);
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'too many'), true);
});

test('the window rolls: messages older than an hour stop counting', () => {
  const store = new Store(join(root, 'window.db'));
  const project = store.createProject('P', null);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(minion.id, root, null);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  let now = 1_000_000;
  runner.now = () => now;
  const relay = (text: string) => runner.relay(minion.id, minion.id, 'Taskmaster', text);

  // Five at the start, one ten minutes in.
  for (let i = 0; i < LOOP_LIMIT - 1; i++) assert.equal(relay(`early ${i}`), false);
  now += 10 * 60_000;
  assert.equal(relay('later'), false);
  // An hour after the first five, they have rolled out and 'later' is still in: five more fit, not six.
  now += LOOP_WINDOW_MS - 10 * 60_000;
  for (let i = 0; i < LOOP_LIMIT - 1; i++) assert.equal(relay(`next ${i}`), false);
  assert.equal(relay('one too many'), true);
});

// Through the real server: who counts, who is held, and what continues.
let base = '';
const cookies: Record<string, string> = {};

async function call(who: string, path: string, opts: { method?: string; body?: unknown } = {}) {
  const auth = who.startsWith('agent:') ? { Authorization: `Bearer ${who.slice(6)}.${createHmac('sha256', SECRET).update(`agent:${who.slice(6)}`).digest('base64url')}` } : { Cookie: cookies[who] };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: join(root, 'data'), CLAUDE_BIN: fake,
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: 'test-password-123', SESSION_SECRET: SECRET, NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(server);
  const res = await until('the server', () => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: 'test-password-123' }),
  }).catch(() => undefined));
  cookies.Cara = res.headers.get('set-cookie')!.split(';')[0];
});

test('the routes: agents are held, people never are, and a person writing continues', async () => {
  const project = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'P' } });
  const { coordinator } = await call('Cara', `/api/projects/${project.id}`);
  const t = await call('Cara', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'build it', title: 'Build it' } });
  const tm = `agent:${coordinator.id}`;
  const minion = `agent:${t.id}`;
  const toMinion = (text: string) => call(tm, `/api/tickets/${t.id}/messages`, { method: 'POST', body: { text } });
  const toTaskmaster = (text: string) => call(minion, `/api/tickets/${t.id}/coordinator`, { method: 'POST', body: { text } });
  const events = async (id: number, kind: string) => (await call('Cara', `/api/tickets/${id}/events`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
  const texts = async (id: number) => (await events(id, 'user_message')).map((d: any) => d.text);

  for (let i = 0; i < 3; i++) {
    assert.equal((await toMinion(`tm ${i}`)).held, false);
    assert.deepEqual(await toTaskmaster(`m ${i}`), { sent: true });
  }
  assert.equal((await toMinion('held for the minion')).held, true);
  assert.deepEqual(await toTaskmaster('held for the Taskmaster'), { sent: false, held: true });
  assert.ok(!(await texts(t.id)).includes('held for the minion'));
  assert.equal((await events(coordinator.id, 'loop_paused')).length, 2);

  // Only people continue; Cara's own message to the minion is never held, and counts as continuing.
  await assert.rejects(call(minion, `/api/tickets/${t.id}/continue`, { method: 'POST' }), /403/);
  await assert.rejects(call(tm, `/api/tickets/${t.id}/continue`, { method: 'POST' }), /403/);
  await call('Cara', `/api/tickets/${t.id}/messages`, { method: 'POST', body: { text: 'carry on' } });
  assert.ok((await texts(t.id)).includes('carry on'));
  await until('the held messages', async () => (await texts(t.id)).includes('held for the minion') && (await texts(coordinator.id)).includes('held for the Taskmaster'));

  // The count started again; Continue releases the next pause.
  for (let i = 0; i < 6; i++) assert.equal((await toMinion(`round 2 ${i}`)).held, false);
  assert.equal((await toMinion('round 2 held')).held, true);
  assert.deepEqual(await call('Cara', `/api/tickets/${t.id}/continue`, { method: 'POST' }), { released: 1 });
  assert.ok((await texts(t.id)).includes('round 2 held'));

  // Writing into the Taskmaster's chat continues its minions too.
  for (let i = 0; i < 6; i++) await toTaskmaster(`round 3 ${i}`);
  assert.equal((await toTaskmaster('round 3 held')).held, true);
  await call('Cara', `/api/tickets/${coordinator.id}/messages`, { method: 'POST', body: { text: 'go ahead' } });
  await until('the held message', async () => (await texts(coordinator.id)).includes('round 3 held'));
  assert.deepEqual((await events(t.id, 'loop_continued')).map((d: any) => d.by), ['Cara', 'Cara', 'Cara']);
});
