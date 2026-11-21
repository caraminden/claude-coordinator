import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, tempRoot, type Booted } from './helpers.ts';

const repo = join(import.meta.dirname, '..');
const scratch = tempRoot('schedules-api-');
const root = scratch.dir;
after(() => scratch.teardown()); // ends the server and its detached turns before the folder goes (#271)

let base = '';
let cookie = '';

/** A request as Cara, or as the minion or Taskmaster `as` (a ticket id) with its token. */
let srv: Booted;
const call = (path: string, opts: { method?: string; body?: unknown; as?: number } = {}) =>
  (opts.as === undefined ? srv.call : srv.as({ token: agentToken(join(root, 'data'), opts.as) }))(path, opts.body || undefined, opts.method ?? 'GET');

before(async () => {
  srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  scratch.track(srv.proc);
});

test('people and the Taskmaster manage schedules; minions and other schemes cannot', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: other } = await call('/api/projects', { method: 'POST', body: { name: 'Other' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: otherPage } = await call(`/api/projects/${other.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'hi', properties: { type: 'chore' } } });
  const url = `/api/projects/${p.id}/schedules`;
  // A new scheme comes with the weekly Memory curator (#1111); this test starts from none.
  const { data: starting } = await call(url);
  assert.deepEqual(starting.schedules.map((s: any) => s.name), ['Memory curator']);
  assert.equal((await call(`/api/schedules/${starting.schedules[0].id}`, { method: 'DELETE' })).status, 200);
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
  // Its group on the Schedules page (#1083): guessed from the name when left out, set or cleared by a PATCH, checked for length.
  assert.equal(mine.data.category, '');
  const named = await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { category: '  Health   checks ' } });
  assert.deepEqual([named.status, named.data.category], [200, 'Health checks']);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { category: 'x'.repeat(41) } })).status, 400);
  assert.equal((await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { category: 7 } })).status, 400);
  const paused = await call(`/api/schedules/${mine.data.id}`, { method: 'PATCH', body: { paused: true } });
  assert.deepEqual([paused.status, paused.data.paused, paused.data.next_run_at], [200, 1, null]);
  assert.equal((await call(`/api/schedules/${tm.data.id}`, { method: 'DELETE', as: page.coordinator.id })).status, 200);
  const { data: list } = await call(url);
  assert.deepEqual(list.schedules.map((s: any) => s.name), ['Nightly']);
});

test("the Taskmaster's schedule tools", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tools' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  for (const s of (await call(`/api/projects/${p.id}/schedules`)).data.schedules) await call(`/api/schedules/${s.id}`, { method: 'DELETE' });
  const mcp = scratch.spawn(process.execPath, [join(repo, 'src/mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), page.coordinator.id),
      COORDINATOR_PROJECT: String(p.id), COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: String(page.coordinator.id),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
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

  // The standard audits (#799): the template brings everything, notes re-render, a second copy is refused, a whole brief detaches.
  const audit = await tool('schedule_audit', { template: 'test-audit', notes: 'vitest only.' });
  assert.match(audit, /^Scheduled\. \[\d+\] Test audit \(Tests\): .*\(`0 7 \d+ \* \*`\), type research, model claude-opus-5-5, effort high; skips under 250 minions; standard audit test-audit with notes; next /);
  const aid = Number(audit.match(/\[(\d+)\]/)![1]);
  const brief = async () => (await call(`/api/projects/${p.id}/schedules`)).data.schedules.find((x: any) => x.id === aid).brief;
  assert.match(await brief(), /^Test audit for Tools[\s\S]*\n\nFor Tools:\nvitest only\.$/);
  assert.match(await tool('schedule_audit', { template: 'test-audit' }), /Tools already has the standard Test audit \(kit\/schedules\/test-audit.md\): schedule \d+/);
  assert.match(await tool('schedule_audit', { template: 'lint' }), /must be one of|no standard audit "lint"/);
  assert.match(await tool('update_schedule', { schedule_id: aid, notes: 'vitest and pytest.' }), /standard audit test-audit with notes/);
  assert.match(await brief(), /For Tools:\nvitest and pytest\.$/);
  assert.match(await tool('update_schedule', { schedule_id: aid, notes: 'x', brief: 'y' }), /send notes, or a brief alone/);
  assert.doesNotMatch(await tool('update_schedule', { schedule_id: aid, brief: 'My own audit.' }), /standard audit/);
  assert.equal(await brief(), 'My own audit.');
  assert.match(await tool('update_schedule', { schedule_id: aid, notes: 'again' }), /notes go with a standard audit: pass template too/);
  // Swapping a hand-written copy back keeps its pause.
  await tool('update_schedule', { schedule_id: aid, paused: true });
  assert.match(await tool('update_schedule', { schedule_id: aid, template: 'test-audit', notes: 'vitest.' }), /Test audit \(Tests\): .*standard audit test-audit with notes; paused;/);
  mcp.kill();
});
