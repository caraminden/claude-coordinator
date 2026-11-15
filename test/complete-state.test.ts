import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { bootServer, until, stopTurns, stopProcs } from './helpers.ts';

// State complete (#547; Josh, 2026-11-11: "always say something about there being no remaining work"):
// it can't be set, or kept, without a note saying what is left.
// Also here, one server for both: the minion tag is retired (#254); for one release an old session's tag still sets its type.
const root = mkdtempSync(join(tmpdir(), 'complete-state-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

let base = '';
let cookie = '';
let dbFile = '';
async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = await bootServer({ root });
  base = srv.base;
  cookie = srv.cookie;
  dbFile = join(root, 'data', 'coordinator.db');
  procs.push(srv.proc);
});

test('state complete needs a note in the same call, and keeps one while it holds', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Scheme' } });
  const { data: t } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'T', message: 'hi' } });
  await until('the first turn to end', async () => (await call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  const patch = (body: unknown) => call(`/api/tickets/${t.id}`, { method: 'PATCH', body });

  await patch({ note: 'tests green' });
  const bare = await patch({ state: 'complete' });
  assert.equal(bare.status, 400, 'an older note does not count: complete says what is left when it is set');
  assert.match(bare.data.error, /State complete needs a note/);
  assert.equal((await patch({ state: 'complete', note: '' })).status, 400, 'a blank note is no note');

  const set = await patch({ state: 'complete', note: 'nothing left' });
  assert.equal(set.status, 200);
  assert.deepEqual([set.data.state, set.data.note], ['complete', 'nothing left']);
  assert.equal((await patch({ note: null })).status, 400, 'the note cannot be cleared while complete');
  assert.equal((await patch({ note: 'read: the audit report' })).data.note, 'read: the audit report', 'but it can change');
  assert.equal((await patch({ title: 'Renamed' })).status, 200, 'other fields leave it alone');
  // Moving off complete frees the note again.
  assert.equal((await patch({ state: 'ready', note: null })).status, 200);
});

test('an old-style tag sets type through its aliases and is never stored', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tagged' } });
  const { status, data: t } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'T', tag: 'process', message: 'hi' } });
  assert.equal(status, 201);
  assert.equal(t.properties.type, 'chore');

  const patched = await call(`/api/tickets/${t.id}`, { method: 'PATCH', body: { tag: 'idea', note: 'thinking' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.properties.type, 'ideation');
  assert.equal(patched.data.note, 'thinking');
  // An old "no kind" null changes nothing.
  assert.equal((await call(`/api/tickets/${t.id}`, { method: 'PATCH', body: { tag: null } })).data.properties.type, 'ideation');

  const db = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal((db.prepare('SELECT tag FROM tickets WHERE id = ?').get(t.id) as any).tag, null);
  db.close();
});
