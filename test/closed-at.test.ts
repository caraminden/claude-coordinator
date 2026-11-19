import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'closed-at-'));
after(() => rmSync(root, { recursive: true, force: true }));

function setup(name: string) {
  const store = new Store(join(root, `${name}.db`));
  const project = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  return { store, mk };
}

// #1072: dismissing stamps the time, a second dismiss keeps it, reopening clears it.
test('closed_at is set on dismiss, kept on a repeat, cleared on reopen', () => {
  const { store, mk } = setup('paths');
  const t = mk();
  assert.equal(store.getTicket(t.id)!.closed_at, null);
  store.updateTicket(t.id, { status: 'closed' });
  const at = store.getTicket(t.id)!.closed_at;
  assert.ok(at && Math.abs(at - Date.now()) < 5000);
  store.updateTicket(t.id, { status: 'closed' });
  assert.equal(store.getTicket(t.id)!.closed_at, at);
  store.updateTicket(t.id, { status: 'idle' });
  assert.equal(store.getTicket(t.id)!.closed_at, null);
  store.updateTicket(t.id, { title: 'other' });
  assert.equal(store.getTicket(t.id)!.closed_at, null);
});

// A dismissal before the column existed: the time comes from its last close note, or stays empty.
test('the backfill reads the last close note and leaves a minion with none empty', () => {
  const { store, mk } = setup('backfill');
  const a = mk(), b = mk(), c = mk(), open = mk();
  for (const t of [a, b, c]) store.updateTicket(t.id, { status: 'closed' });
  store.db.prepare('UPDATE tickets SET closed_at = NULL').run();
  const note = (id: number, text: string, at: number) => store.db.prepare("INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, 'note', ?, ?)").run(id, JSON.stringify({ text }), at);
  note(a.id, 'Cara dismissed this minion.', 1000);
  note(a.id, 'Cara reopened this minion.', 2000);
  note(a.id, 'Claude dismissed this minion: done', 3000);
  note(a.id, "Removed this dismissed minion's worktree (1 MB).", 4000);
  note(b.id, 'Closed: Josh saw its result', 5000);
  note(c.id, 'something else', 6000);
  note(a.id, 'Strike: "Cara dismissed this minion." was wrong', 9000);
  note(c.id, 'Claude closed this ticket: done', 7000);
  // Reopened as a release at version 77 runs the backfill at startup.
  store.setSetting('schema_version', 78);
  store.db.close();
  const again = new Store(join(root, 'backfill.db'));
  const at = (id: number) => again.getTicket(id)!.closed_at;
  assert.equal(at(a.id), 3000);
  assert.equal(at(b.id), 5000);
  assert.equal(at(c.id), 7000);
  assert.equal(at(open.id), null);
});
