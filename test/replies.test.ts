import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { bootServer, until, stopTurns, testPins } from './helpers.ts';
testPins();

// One-tap replies (#105): set with set_thread_status, gone once anyone writes or the next turn starts.
const root = mkdtempSync(join(tmpdir(), 'replies-'));
const procs: ChildProcess[] = [];
// The server writes into root until it exits, and its exit handler deletes its run/mcp-<pid> folder, so wait for that.
after(async () => {
  await Promise.all(procs.map((p) => p.exitCode !== null || p.signalCode !== null ? undefined : new Promise((r) => { p.once('exit', r); p.kill(); })));
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

test('a new turn clears the replies, whoever started it', async () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-unit');
  const store = new Store(join(root, 'unit.db'));
  const project = store.createProject('Unit', null);
  const runner = new Runner(store, () => {}, () => ({}), '/bin/false');
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', replies: JSON.stringify(['Merge it']) });
  assert.deepEqual(runner.view(store.getTicket(t.id)!).replies, ['Merge it']);
  runner.send(t.id, 'GitHub', 'CI passed', [], {});
  await until('the turn to stop', async () => !runner.isRunning(t.id), 5000);
  assert.equal(store.getTicket(t.id)!.replies, null);
  assert.deepEqual(runner.view(store.getTicket(t.id)!).replies, []);

  store.updateTicket(t.id, { replies: JSON.stringify(['Make it live']) });
  runner.close(t.id, 'Dismissed.');
  assert.equal(store.getTicket(t.id)!.replies, null, 'a reopened minion offers nothing stale');
});

let base = '';
let cookie = '';

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

test('replies are checked, shown as a list, and go once someone writes', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: t } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'T', message: 'hi' } });
  assert.deepEqual(t.replies, []);
  // The message starts a turn that fails (CLAUDE_BIN is /bin/false); its end writes the ticket, so let it land first.
  await until('the first turn to end', async () => (await call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  const patch = (replies: unknown) => call(`/api/tickets/${t.id}`, { method: 'PATCH', body: { replies } });

  assert.equal((await patch(['a', 'b', 'c', 'd'])).status, 400, 'at most 3');
  assert.equal((await patch(['x'.repeat(41)])).status, 400, 'at most 40 characters each');
  assert.equal((await patch([''])).status, 400, 'no blank reply');
  assert.equal((await patch('Merge it')).status, 400, 'a list, not a string');

  const set = await patch([' Merge it ', 'Make it live']);
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.replies, ['Merge it', 'Make it live']);
  assert.deepEqual((await call(`/api/projects/${p.id}`)).data.tickets.find((x: any) => x.id === t.id).replies, ['Merge it', 'Make it live']);
  const at = (await patch(['Merge it', 'Make it live'])).data.updated_at;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await patch(['Merge it', 'Make it live'])).data.updated_at, at, 'the same replies again change nothing');
  assert.deepEqual((await patch([])).data.replies, [], '[] clears');

  await patch(['Merge it']);
  const sent = await call(`/api/tickets/${t.id}/messages`, { method: 'POST', body: { text: 'Merge it' } });
  assert.equal(sent.status, 202);
  assert.deepEqual((await call(`/api/tickets/${t.id}`)).data.ticket.replies, []);
  // That message started a turn; let it end before after() deletes the folder it runs in.
  await until('the message\'s turn to end', async () => (await call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
});

test('a goal is set at create, changed and checked by PATCH, and null clears it back to the title (#1130)', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Goals' } });
  const made = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'Card buttons', message: 'hi', goal: 'Left-align the\n card buttons' } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const t = made.data;
  assert.equal(t.goal, 'Left-align the card buttons', 'one line, its whitespace folded');
  const patch = (goal: unknown) => call(`/api/tickets/${t.id}`, { method: 'PATCH', body: { goal } });
  assert.equal((await patch('x'.repeat(141))).status, 400, 'at most 140 characters');
  assert.equal((await patch('Left-align them; centred looks off')).data.goal, 'Left-align them; centred looks off');
  assert.equal((await patch(null)).data.goal, null);
  await until('the first turn to end', async () => (await call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
});
