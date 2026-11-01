import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { bootServer } from './helpers.ts';

// The minion tag is retired (#254); for one release an old session's tag still sets its type.
const root = mkdtempSync(join(tmpdir(), 'tag-shim-'));
const procs: ChildProcess[] = [];
after(async () => {
  await Promise.all(procs.map((p) => p.exitCode !== null || p.signalCode !== null ? undefined : new Promise((r) => { p.once('exit', r); p.kill(); })));
  rmSync(root, { recursive: true, force: true });
});

let base = '';
let cookie = '';
let dbFile = '';
async function call(path: string, method: string, body: unknown) {
  const res = await fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = await bootServer({ root });
  ({ base, cookie } = srv);
  dbFile = join(root, 'data', 'coordinator.db');
  procs.push(srv.proc);
});

test('an old-style tag sets type through its aliases and is never stored', async () => {
  const { data: p } = await call('/api/projects', 'POST', { name: 'Scheme' });
  const { status, data: t } = await call(`/api/projects/${p.id}/tickets`, 'POST', { title: 'T', tag: 'process', message: 'hi' });
  assert.equal(status, 201);
  assert.equal(t.properties.type, 'chore');

  const patched = await call(`/api/tickets/${t.id}`, 'PATCH', { tag: 'idea', note: 'thinking' });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.properties.type, 'ideation');
  assert.equal(patched.data.note, 'thinking');
  // An old "no kind" null changes nothing.
  assert.equal((await call(`/api/tickets/${t.id}`, 'PATCH', { tag: null })).data.properties.type, 'ideation');

  const db = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal((db.prepare('SELECT tag FROM tickets WHERE id = ?').get(t.id) as any).tag, null);
  db.close();
});
