import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer } from './helpers.ts';

// Starting a minion from a brief in a file (#129): the brief remembers which minion it became, so a
// second start is refused and everyone sees "Started as #N" instead of the Start button.
const root = mkdtempSync(join(tmpdir(), 'brief-start-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a claim holds a brief until it is settled; a failed start frees it, a deleted minion too', () => {
  const store = new Store(join(root, 'claims.db'));
  const p = store.createProject('P', null);
  const path = 'scheme shared/retro.md';
  assert.ok(store.claimBrief(p.id, path, 'Brief 1: A', 'Cara'));
  assert.ok(!store.claimBrief(p.id, path, 'Brief 1: A', 'Josh'), 'being started');
  assert.deepEqual(store.briefStarts(p.id, path), [], 'not started until its minion exists');
  store.settleBrief(p.id, path, 'Brief 1: A', null);
  assert.ok(store.claimBrief(p.id, path, 'Brief 1: A', 'Josh'), 'a failed start frees it');

  const t = store.createTicket({ project_id: p.id, title: 'A', permission_mode: 'default', created_by: 'Josh' });
  store.settleBrief(p.id, path, 'Brief 1: A', t.id);
  assert.deepEqual(store.briefStarts(p.id, path).map((r) => ({ ...r })), [{ heading: 'Brief 1: A', number: t.number }]);
  assert.ok(!store.claimBrief(p.id, path, 'Brief 1: A', 'Cara'));
  assert.ok(store.claimBrief(p.id, path, '', 'Cara'), 'the whole file is a brief of its own');
  assert.ok(store.claimBrief(p.id, 'scheme shared/other.md', 'Brief 1: A', 'Cara'), 'and so is the same heading in another file');

  store.deleteTicket(t.id);
  assert.deepEqual(store.briefStarts(p.id, path), []);
  assert.ok(store.claimBrief(p.id, path, 'Brief 1: A', 'Cara'), 'a deleted minion frees its brief');
  store.db.close();
});

test('starting a brief creates the minion once, records it, and notes it to the Taskmaster', async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Scheme' });
    const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator; // opening the scheme makes its Taskmaster
    const path = '/data/projects/2/shared/project/citadel-retro-2026-10.md';
    const heading = 'Brief 6: Page the chat history (feature/perf, M)';
    const start = () => s.call(`/api/projects/${p.id}/tickets`, {
      title: 'Page the chat history', message: '### Brief 6…', properties: { type: 'feature' }, brief: { path, heading },
    });
    const first = await start();
    assert.equal(first.status, 201);
    assert.equal(first.data.title, 'Page the chat history');
    const started = await s.call(`/api/projects/${p.id}/briefs?path=${encodeURIComponent(path)}`);
    assert.deepEqual(started.data, [{ heading, number: first.data.number }]);

    const second = await start();
    assert.equal(second.status, 409);
    assert.match(second.data.error, /started already/);
    assert.equal((await s.call(`/api/projects/${p.id}`)).data.tickets.length, 1, 'no second minion');

    const notes = (await s.call(`/api/tickets/${tm.id}/events?after=0`)).data.filter((e: any) => e.kind === 'note').map((e: any) => JSON.parse(e.data).text);
    assert.ok(notes.includes(`Cara started #${first.data.number} from ${heading} in citadel-retro-2026-10.md`), notes.join('\n'));

    assert.equal((await s.call(`/api/projects/${p.id}/tickets`, { message: 'x', brief: { heading } })).status, 400, 'a brief needs its file');
    assert.deepEqual((await s.call(`/api/projects/${p.id}/briefs?path=elsewhere.md`)).data, []);
  } finally {
    await s.stop();
  }
});
