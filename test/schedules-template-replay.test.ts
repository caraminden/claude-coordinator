import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { bootServer, tempRoot, type Booted } from './helpers.ts';

// #1083 (56cdddcf): a standard audit's page shows its kit template rendered fresh, plus the scheme's notes, not the
// copy stored when it was last saved or run.
const scratch = tempRoot('schedules-template-replay-');
const root = scratch.dir;
after(() => scratch.teardown());

let srv: Booted;
before(async () => {
  srv = await bootServer({ root, stdout: true });
  scratch.track(srv.proc);
});

test("a template schedule's page renders its kit template fresh with the notes, not the stored copy", async () => {
  const call = (path: string, body?: unknown, method = 'GET') => srv.call(path, body, method);
  const { data: p } = await call('/api/projects', { name: 'Audited' }, 'POST');
  const made = await call(`/api/projects/${p.id}/schedules`, { template: 'test-audit', notes: 'vitest only.' }, 'POST');
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = made.data.id;
  const fresh = made.data.brief;
  assert.match(fresh, /\n\nFor Audited:\nvitest only\.$/);
  // The stored copy goes stale, as when the kit's template text changes after the last save.
  const db = new DatabaseSync(join(root, 'data', 'coordinator.db'));
  db.prepare('UPDATE schedules SET brief = ? WHERE id = ?').run('STALE stored copy', id);
  db.close();
  const page = (await call(`/api/projects/${p.id}/schedules`)).data.schedules.find((s: any) => s.id === id);
  assert.notEqual(page.brief, 'STALE stored copy', 'the page shows the stored copy instead of the template');
  assert.equal(page.brief, fresh, 'the fresh template plus notes');
});
