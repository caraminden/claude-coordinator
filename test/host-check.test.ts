// The host_check tool's checks (#621): the database with its secrets masked, and a user unit's journal and status.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { hostCheck } from '../src/host-check.ts';

const root = mkdtempSync(join(tmpdir(), 'host-check-'));
after(() => rmSync(root, { recursive: true, force: true }));

const db = join(root, 'c.db');
const store = new Store(db);
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
store.db.prepare("UPDATE users SET password_hash = 'scrypt$SALT$HASH', invite_hash = 'INVITE' WHERE id = ?").run(cara.id);
store.db.prepare("INSERT INTO credentials (user_id, kind, secret, meta, created_at, updated_at) VALUES (?, 'github', 'GHTOKEN', '{\"login\":\"x\"}', 1, 1)").run(cara.id);
store.setSetting('agent-nonce:7', { current: 'NONCE', previous: null });
store.setSetting('wake-when-live', [1]);
store.createMachine('box', 'MACHINEHASH', 'Cara', null);
store.db.close();

// Stand-ins that print what they were asked.
const echo = join(root, 'echo-args');
writeFileSync(echo, `#!/bin/sh\necho "$(basename "$0") $*"\n`);
chmodSync(echo, 0o755);
const opts = { db, systemctl: echo, journalctl: echo };
const sql = (q: string) => hostCheck(opts, { what: 'db', sql: q });

test('the database reads as sqlite3 prints it, with every secret [hidden]', async () => {
  assert.equal(await sql('SELECT id, name, password_hash, invite_hash, admin FROM users'), 'id|name|password_hash|invite_hash|admin\n1|Cara|[hidden]|[hidden]|1');
  assert.equal(await sql('SELECT kind, secret, meta FROM credentials'), 'kind|secret|meta\ngithub|[hidden]|[hidden]');
  assert.equal(await sql("SELECT key, value FROM settings WHERE key IN ('agent-nonce:7', 'wake-when-live') ORDER BY key"), 'key|value\nagent-nonce:7|[hidden]\nwake-when-live|[1]');
  assert.equal(await sql('SELECT name, token_hash FROM machines'), 'name|token_hash\nbox|[hidden]');
  assert.match(await sql('PRAGMA table_info(users)'), /password_hash/);
  assert.equal(await sql('SELECT 1 WHERE 0'), '(no rows)');
});

test('the real tables, writes, ATTACH and setting pragmas are refused', async () => {
  for (const q of ['SELECT password_hash FROM main.users', 'SELECT * FROM main.credentials', "SELECT value FROM main.settings WHERE key = 'agent-nonce:7'",
    'WITH x AS (SELECT * FROM main.users) SELECT * FROM x', 'SELECT (SELECT secret FROM main.credentials)']) assert.match(await sql(q), /prohibited|not authorized/, q);
  for (const q of ["ATTACH '/etc/hostname' AS x", 'DELETE FROM tickets', 'UPDATE main.users SET admin = 1', 'PRAGMA journal_mode = DELETE', 'CREATE TABLE x (a)']) {
    assert.match(await sql(q), /not authorized|readonly|view/, q);
  }
  // Nothing changed.
  assert.equal(await sql('SELECT admin FROM users'), 'admin\n1');
});

test('journal, status and units run the fixed commands; bad arguments say what to send', async () => {
  assert.equal(await hostCheck(opts, { what: 'journal', unit: 'claude-coordinator.service', lines: 5, since: '1 hour ago', grep: 'boot' }),
    'echo-args --user --no-pager -o short-iso -n 5 -u claude-coordinator.service --since 1 hour ago -g boot');
  assert.equal(await hostCheck(opts, { what: 'status', unit: 'claude-coordinator' }), 'echo-args --user status --no-pager --lines=20 -- claude-coordinator');
  assert.equal(await hostCheck(opts, { what: 'units', unit: 'citadel-*' }), 'echo-args --user list-units --no-pager --all --plain -- citadel-*');
  for (const body of [{ what: 'status' }, { what: 'status', unit: 'x; rm -rf /' }, { what: 'journal', lines: 0 }, { what: 'journal', since: '$(id)' }, { what: 'db', sql: '' }, { what: 'shell' }]) {
    assert.throws(() => hostCheck(opts, body), (err: any) => err.status === 400, JSON.stringify(body));
  }
});
