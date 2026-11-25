import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { projectSharedDir } from '../src/workspace.ts';
import { agentToken, bootServer, type Booted } from './helpers.ts';
import { until } from './wait.ts';

// #1488: a Taskmaster started two minions from one handoff (Nov 20, the flake fixes) because the twin check only ran
// on the memory index. Now the server refuses a second start from the same handoff file, index or not, while the first
// is open or closed less than 3 days ago; not_duplicate overrides, and a person's own start is never refused.
let srv: Booted;
let p: { id: number };
let shared = '';
before(async () => {
  srv = await bootServer();
  p = (await srv.call('/api/projects', { name: 'P' })).data;
  shared = projectSharedDir(srv.data, p.id);
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  for (const f of ['x', 'y', 'z']) writeFileSync(join(shared, 'handoffs', `${f}.md`), `# ${f}\n`);
});
after(() => srv?.stop());

const start = async (title: string, message: string, extra: object = {}) => {
  const tm = (await srv.call(`/api/projects/${p.id}`)).data.coordinator;
  return srv.as({ token: agentToken(srv.data, tm.id) })(`/api/projects/${p.id}/tickets`, { title, message, model: 'claude-sonnet-5-5', effort: 'medium', properties: { type: 'chore' }, ...extra });
};

test("a second start from the same handoff is refused naming the first; not_duplicate and a person's start go through", async () => {
  const a = await start('A', `Your brief is ${shared}/handoffs/x.md`);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await start('B', 'Start from the handoff handoffs/x.md, please.');
  assert.equal(b.status, 409);
  assert.match(b.data.error, new RegExp(`#${a.data.number} A \\(\\w+\\) already started from handoffs/x\\.md`));
  assert.match(b.data.error, /message it instead .*not_duplicate: true/);
  assert.equal((await start('Other', `Your brief is ${shared}/handoffs/y.md`)).status, 201, 'another handoff is fine');
  assert.equal((await start('No handoff', 'just a quick fix')).status, 201);
  assert.equal((await start('B', `Brief: ${shared}/handoffs/x.md`, { not_duplicate: true })).status, 201);
  assert.equal((await srv.call(`/api/projects/${p.id}/tickets`, { title: 'By hand', message: `Your brief is ${shared}/handoffs/x.md` })).status, 201);
});

test("a chained minion's held brief counts, and a minion closed over 3 days ago does not", async () => {
  const leader = (await start('Leader', 'no handoff here')).data;
  const held = await start('Held', `Your brief is ${shared}/handoffs/z.md`, { start_after: leader.number });
  assert.equal(held.status, 201, JSON.stringify(held.data));
  const twin = await start('Twin', `Your brief is ${shared}/handoffs/z.md`);
  assert.equal(twin.status, 409);
  assert.match(twin.data.error, new RegExp(`#${held.data.number} Held`));

  const db = new DatabaseSync(join(srv.data, 'coordinator.db'), { timeout: 30_000 });
  const close = (ago: number) => db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE project_id = ? AND kind = 'ticket' AND title != 'Leader'").run(Date.now() - ago, p.id);
  // A turn (/bin/false here) that ends after the raw close would set the status back and clear closed_at.
  const starts = db.prepare("SELECT status FROM tickets WHERE project_id = ? AND kind = 'ticket' AND id != ?");
  await until('every start to have ended its turn', () => starts.all(p.id, held.data.id).every((t) => t.status === 'error'));
  close(2 * 86_400_000);
  assert.equal((await start('Again', `Your brief is ${shared}/handoffs/y.md`)).status, 409, 'closed 2 days ago still counts');
  close(4 * 86_400_000);
  db.close();
  assert.equal((await start('Again', `Your brief is ${shared}/handoffs/y.md`)).status, 201, 'closed 4 days ago: a fresh start');
});
