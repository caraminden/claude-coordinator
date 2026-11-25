import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync, backup } from 'node:sqlite';
import { Store } from '../src/db.ts';

// Session state (claude_state) lives in state.db beside the database, so the main file stays small
// and the copies made of it (previews, boot-check, pre-deploy) leave sessions out.
const root = mkdtempSync(join(tmpdir(), 'state-db-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const dir = () => {
  const d = join(root, String(++n));
  mkdirSync(d);
  return d;
};
const row = (path: string, ticketId: number | null, bytes: number, mtime = 1) => ({ path, project_id: 1, ticket_id: ticketId, size: bytes, mtime, data: new Uint8Array(bytes).fill(7) });

// A database as releases before state.db left it: claude_state in the main file.
function oldLayout(file: string, rows: ReturnType<typeof row>[]) {
  const s = new Store(file);
  const p = s.createProject('Old', null);
  const t = s.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  s.db.exec(`CREATE TABLE main.claude_state (path TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
    ticket_id INTEGER REFERENCES tickets(id), size INTEGER NOT NULL, mtime INTEGER NOT NULL, data BLOB NOT NULL)`);
  const put = s.db.prepare('INSERT INTO main.claude_state VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) put.run(r.path, r.project_id, r.ticket_id ?? null, r.size, r.mtime, r.data);
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  s.db.close();
  return t.id;
}
const mainHasState = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const has = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'claude_state'").get();
  db.close();
  return has;
};

test('opening a database moves its session state into state.db, and the main file shrinks', () => {
  const d = dir();
  const file = join(d, 'coordinator.db');
  oldLayout(file, [row('projects/a/1.jsonl', 1, 2_000_000), row('projects/a/memory/MEMORY.md', null, 10)]);
  const before = statSync(file).size;
  const s = new Store(file);
  assert.equal(s.getClaudeState('projects/a/1.jsonl', true)!.data!.length, 2_000_000);
  assert.equal(s.listClaudeState(1, null).length, 1);
  assert.equal(s.listClaudeState(1, 1).length, 1);
  assert.equal((s.db.prepare('PRAGMA state.auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum, 2, 'incremental, for the prune');
  s.db.exec('PRAGMA state.wal_checkpoint(TRUNCATE)');
  s.putClaudeState(row('projects/a/big.jsonl', 1, 20_000_000));
  s.db.exec('PRAGMA state.wal_checkpoint(PASSIVE)');
  s.putClaudeState(row('projects/a/small.jsonl', 1, 10)); // restarts the log, cut down to the limit
  assert.ok(statSync(join(d, 'state.db-wal')).size <= 16_777_216, `the WAL is capped: ${statSync(join(d, 'state.db-wal')).size}`);
  s.deleteClaudeState('projects/a/big.jsonl');
  s.deleteClaudeState('projects/a/small.jsonl');
  s.db.close();
  assert.ok(!mainHasState(file));
  assert.ok(statSync(file).size < before - 1_500_000, `main shrank from ${before} to ${statSync(file).size}`);
  assert.ok(statSync(join(d, 'state.db')).size > 2_000_000);

  const again = new Store(file); // the next start: nothing to move
  assert.equal(again.listClaudeState(1, 1).length, 1);
  again.putClaudeState(row('projects/a/2.jsonl', 1, 5));
  assert.equal(again.listClaudeState(1, 1).length, 2);
  again.deleteTicket(1);
  assert.equal(again.listClaudeState(1, 1).length, 0, 'deleting a minion clears its rows in state.db');
  again.db.close();
});

test("a start cut off between the copy and the drop finishes on the next, the main file's rows winning", () => {
  const d = dir();
  const file = join(d, 'coordinator.db');
  oldLayout(file, [row('projects/a/1.jsonl', 1, 20, 2)]);
  // As if the copy committed with older rows and the drop never happened (or an older release, after
  // a rollback, wrote newer rows into a main-file table of its own).
  const st = new DatabaseSync(join(d, 'state.db'));
  st.prepare('INSERT INTO claude_state VALUES (?, 1, 1, 10, 1, ?)').run('projects/a/1.jsonl', new Uint8Array(10));
  st.prepare('INSERT INTO claude_state VALUES (?, 1, 1, 3, 1, ?)').run('projects/a/only-in-state.jsonl', new Uint8Array(3));
  st.close();
  const s = new Store(file);
  assert.equal(s.getClaudeState('projects/a/1.jsonl')!.mtime, 2);
  assert.equal(s.getClaudeState('projects/a/only-in-state.jsonl')!.size, 3);
  s.db.close();
  assert.ok(!mainHasState(file));
});

test('a copy of the main file (previews, boot-check) leaves session state out', async () => {
  const d = dir();
  const s = new Store(join(d, 'coordinator.db'));
  s.putClaudeState(row('projects/a/1.jsonl', null, 1000));
  const p = dir();
  await backup(s.db, join(p, 'coordinator.db'));
  const copy = new Store(join(p, 'coordinator.db'));
  assert.equal(copy.listClaudeState(1, null).length, 0);
  assert.equal(s.listClaudeState(1, null).length, 1);
  copy.db.close();
  s.db.close();
});

test("restoring an old backup brings back only what state.db lacks or holds an older copy of, and drops deleted minions' rows", () => {
  const d = dir();
  const file = join(d, 'coordinator.db');
  const ticket = oldLayout(file, [row('projects/a/1.jsonl', 1, 20, 1)]);
  const st = new DatabaseSync(join(d, 'state.db'));
  st.prepare('INSERT INTO claude_state VALUES (?, 1, ?, 30, 5, ?)').run('projects/a/1.jsonl', ticket, new Uint8Array(30));
  st.prepare('INSERT INTO claude_state VALUES (?, 1, 99, 5, 1, ?)').run('projects/a/gone.jsonl', new Uint8Array(5)); // deleted while a rollback ran
  st.close();
  const s = new Store(file);
  assert.equal(s.getClaudeState('projects/a/1.jsonl')!.size, 30, "state.db's newer copy stays");
  assert.equal(s.getClaudeState('projects/a/gone.jsonl'), undefined, 'minion 99 is not in the database');
  s.db.close();
});
