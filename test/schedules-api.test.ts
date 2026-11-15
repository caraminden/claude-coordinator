import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, stopProcs, stopTurns } from './helpers.ts';

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'schedules-api-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

let base = '';
let cookie = '';

/** A request as Cara, or as the minion or Taskmaster `as` (a ticket id) with its token. */
async function call(path: string, opts: { method?: string; body?: unknown; as?: number } = {}) {
  const auth: Record<string, string> = opts.as === undefined ? { Cookie: cookie } : { Authorization: `Bearer ${agentToken(join(root, 'data'), opts.as)}` };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
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

test('people and the Taskmaster manage schedules; minions and other schemes cannot', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: other } = await call('/api/projects', { method: 'POST', body: { name: 'Other' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: otherPage } = await call(`/api/projects/${other.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'hi', properties: { type: 'chore' } } });
  const url = `/api/projects/${p.id}/schedules`;
  const nightly = { name: 'Nightly', cron: '0 3 * * *', brief: 'Is main healthy?' };

  const mine = await call(url, { method: 'POST', body: nightly });
  assert.equal(mine.status, 201);
  assert.equal(mine.data.when, 'Every day at 03:00');
  assert.equal(mine.data.type, 'chore');
  // A person's schedule that names neither gets the model table's pick for its type (#698).
  assert.deepEqual([mine.data.model, mine.data.effort], ['claude-sonnet-5-5', 'medium']);
  // The Taskmaster's names both on purpose: leaving one out is refused.
  const weekly = { ...nightly, name: 'Weekly', cron: '0 9 * * 1', type: 'research' };
  const unpicked = await call(url, { method: 'POST', body: { ...weekly, model: 'claude-opus-5-5' }, as: page.coordinator.id });
  assert.equal(unpicked.status, 400);
  assert.match(unpicked.data.error, /schedule_minion needs a model and an effort/);
  const tm = await call(url, { method: 'POST', body: { ...weekly, model: 'claude-opus-5-5', effort: 'high' }, as: page.coordinator.id });
  assert.equal(tm.status, 201, JSON.stringify(tm.data));
  assert.equal(tm.data.type, 'research');
  // And no edit puts one back on a default.
  const nulled = await call(`/api/schedules/${tm.data.id}`, { method: 'PATCH', body: { model: null }, as: page.coordinator.id });
  assert.equal(nulled.status, 400);

  assert.equal((await call(url, { method: 'POST', body: nightly, as: minion.id })).status, 403);
  assert.equal((await call(url, { as: minion.id })).status, 403);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { paused: true }, as: minion.id })).status, 403);
  assert.equal((await call(url, { method: 'POST', body: nightly, as: otherPage.coordinator.id })).status, 403);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'DELETE', as: otherPage.coordinator.id })).status, 403);

  assert.equal((await call(url, { method: 'POST', body: { ...nightly, cron: 'nightly' } })).status, 400);
  assert.equal((await call(url, { method: 'POST', body: { ...nightly, brief: '' } })).status, 400);
  // Model and effort (#387): checked like a new minion's.
  assert.equal((await call(url, { method: 'POST', body: { ...nightly, model: 'gpt-4' } })).status, 400);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { effort: 'huge' } })).status, 400);
  const cheap = await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { model: 'claude-sonnet-5-5', effort: 'medium' } });
  assert.deepEqual([cheap.status, cheap.data.model, cheap.data.effort], [200, 'claude-sonnet-5-5', 'medium']);
  const back = await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { model: null } });
  assert.deepEqual([back.status, back.data.error], [400, 'A schedule always names its model and effort: pass one from the model table instead of null'], 'no default to go back to (#698)');
  const paused = await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { paused: true } });
  assert.deepEqual([paused.status, paused.data.paused, paused.data.next_run_at], [200, 1, null]);
  assert.equal((await call(`/api/schedules/${tm.data.id}`, { method: 'DELETE', as: page.coordinator.id })).status, 200);
  const { data: list } = await call(url);
  assert.deepEqual(list.schedules.map((s: any) => s.name), ['Nightly']);
});

test("the Taskmaster's schedule tools", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tools' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const mcp = spawn(process.execPath, [join(repo, 'src/mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), page.coordinator.id),
      COORDINATOR_PROJECT: String(p.id), COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: String(page.coordinator.id),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(mcp);
  const { createInterface } = await import('node:readline');
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (l) => {
    const r = JSON.parse(l);
    replies.get(r.id)?.(r);
  });
  let rid = 0;
  const tool = (name: string, args: object) => new Promise<string>((r) => {
    replies.set(++rid, (x) => r(x.result.content[0].text));
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  assert.equal(await tool('list_schedules', {}), 'Nothing scheduled.');
  assert.match(await tool('schedule_minion', { name: 'Nightly', cron: '@daily', brief: 'Check main', model: 'claude-sonnet-5-5' }), /schedule_minion needs a model and an effort/);
  assert.match(await tool('schedule_minion', { name: 'Nightly', cron: '@daily', brief: 'Check main', model: 'claude-sonnet-5-5', effort: 'low' }), /^Scheduled\. \[\d+\] Nightly: Every day at 00:00 \(`@daily`\), type chore, model claude-sonnet-5-5, effort low; next /);
  const id = Number((await tool('list_schedules', {})).match(/^\[(\d+)\]/)![1]);
  assert.match(await tool('update_schedule', { schedule_id: id, paused: true }), /; paused; no run yet$/);
  assert.match(await tool('update_schedule', { schedule_id: id, model: 'claude-opus-5-5', effort: 'medium' }), /, model claude-opus-5-5, effort medium; paused;/);
  // The activity gate and one-offs (#745).
  assert.match(await tool('update_schedule', { schedule_id: id, min_minions: 40, gate_scope: 'all', once: true }), /effort medium; skips under 40 minions across all schemes; runs once; paused;/);
  assert.match(await tool('update_schedule', { schedule_id: id, min_minions: 0 }), /min_minions must be a whole number/);
  assert.match(await tool('update_schedule', { schedule_id: id, gate_scope: 'everywhere' }), /gate_scope must be one of: scheme, all/);
  assert.match(await tool('update_schedule', { schedule_id: id, once: 'yes' }), /once must be true or false/);
  assert.doesNotMatch(await tool('update_schedule', { schedule_id: id, min_minions: null, once: false }), /skips under|runs once/);
  assert.equal(await tool('delete_schedule', { schedule_id: id }), 'Deleted.');
  mcp.kill();
});
