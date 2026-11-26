// The host_check tool's checks (#621): the database with its secrets masked, and a user unit's journal and status.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { SECRET } from '../src/db-view.ts';
import { hostCheck } from '../src/host-check.ts';
import { slowJson } from '../src/http.ts';
import { runShipTool } from '../src/mcp-ship.ts';
import { turnStore } from '../src/pool-context.ts';
import { judge } from '../src/judges.ts';
import { judgeHash } from '../tools/judge-replays/pins.ts';

const root = mkdtempSync(join(tmpdir(), 'host-check-'));
after(() => rmSync(root, { recursive: true, force: true }));

const db = join(root, 'c.db');
const store = new Store(db);
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
store.db.prepare("UPDATE users SET password_hash = 'scrypt$SALT$HASH', invite_hash = 'INVITE' WHERE id = ?").run(cara.id);
store.db.prepare("INSERT INTO credentials (user_id, kind, secret, meta, created_at, updated_at) VALUES (?, 'github', 'GHTOKEN', '{\"login\":\"x\"}', 1, 1)").run(cara.id);
store.putSecret('person', cara.id, 'SITE_PW', 'SEALED', cara.id);
store.setSetting('agent-nonce:7', { current: 'NONCE', previous: null });
store.setSetting('wake-when-live', [1]);
store.createMachine('box', 'MACHINEHASH', 'Cara', null);
store.db.prepare("INSERT INTO contraptions (name, title, port, identity_public, identity_private, key_hash, keys_at, created_at) VALUES ('mandate', 'Mandate', 9100, 'PUB', 'PRIVKEY', 'KEYHASH', 1, 1)").run();
// Every column whose name says secret, in the schema the code makes today.
const secretish = (store.db.prepare("SELECT m.name AS t, p.name AS c FROM sqlite_schema m, pragma_table_info(m.name) p WHERE m.type = 'table'").all() as { t: string; c: string }[]).filter(({ c }) => /hash|secret|private|password|nonce|p256dh|^auth$|^endpoint$|^meta$|^token$/.test(c)).map(({ t, c }) => `${t}.${c}`);
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
  assert.equal(await sql('SELECT name, value FROM stored_secrets'), 'name|value\nSITE_PW|[hidden]');
  assert.equal(await sql('SELECT name, token_hash FROM machines'), 'name|token_hash\nbox|[hidden]');
  assert.equal(await sql('SELECT name, identity_public, identity_private, key_hash FROM contraptions'), 'name|identity_public|identity_private|key_hash\nmandate|PUB|[hidden]|[hidden]');
  assert.match(await sql('PRAGMA table_info(users)'), /password_hash/);
  assert.equal(await sql('SELECT 1 WHERE 0'), '(no rows)');
});

test('the real tables, writes, ATTACH and setting pragmas are refused', async () => {
  for (const q of [
    'SELECT password_hash FROM main.users',
    'SELECT * FROM main.credentials',
    "SELECT value FROM main.settings WHERE key = 'agent-nonce:7'",
    'WITH x AS (SELECT * FROM main.users) SELECT * FROM x',
    'SELECT (SELECT secret FROM main.credentials)',
    'SELECT identity_private FROM main.contraptions',
    // A CTE named like a masking view must not pass for it (#621 review).
    'WITH settings AS (SELECT key, value FROM main.settings) SELECT * FROM settings',
    'WITH users AS (SELECT key, value FROM main.settings) SELECT * FROM users',
  ])
    assert.match(await sql(q), /prohibited|not authorized/, q);
  assert.doesNotMatch(await sql("SELECT group_concat(value) FROM settings, (SELECT 1) WHERE key LIKE 'agent-nonce:%'"), /NONCE/);
  for (const q of ["ATTACH '/etc/hostname' AS x", 'DELETE FROM tickets', 'UPDATE main.users SET admin = 1', 'PRAGMA journal_mode = DELETE', 'CREATE TABLE x (a)']) {
    assert.match(await sql(q), /not authorized|readonly|view/, q);
  }
  // Nothing changed.
  assert.equal(await sql('SELECT admin FROM users'), 'admin\n1');
});

test('every column named like a secret is masked, so a new one fails here until it is listed', () => {
  assert.ok(secretish.length >= 10, secretish.join(' '));
  assert.deepEqual(
    secretish.filter((tc) => !SECRET[tc.split('.')[0]]?.includes(tc.split('.')[1])),
    [],
  );
});

test('journal, status and units run the fixed commands; bad arguments say what to send', async () => {
  assert.equal(await hostCheck(opts, { what: 'journal', unit: 'claude-coordinator.service', lines: 5, since: '1 hour ago', grep: 'boot' }), 'echo-args --user --no-pager -o short-iso -n 5 -u claude-coordinator.service --since 1 hour ago -g boot');
  assert.equal(await hostCheck(opts, { what: 'status', unit: 'claude-coordinator' }), 'echo-args --user status --no-pager --lines=20 -- claude-coordinator');
  assert.equal(await hostCheck(opts, { what: 'units', unit: 'citadel-*' }), 'echo-args --user list-units --no-pager --all --plain -- citadel-*');
  for (const body of [{ what: 'status' }, { what: 'status', unit: 'x; rm -rf /' }, { what: 'journal', lines: 0 }, { what: 'journal', since: '$(id)' }, { what: 'db', sql: '' }, { what: 'shell' }]) {
    assert.throws(
      () => hostCheck(opts, body),
      (err: Error & { status: number }) => err.status === 400,
      JSON.stringify(body),
    );
  }
});

// A minion's worktree as judge-replay sees it: its own copy of the tool and record, the repo's src and replays.
const REPO = join(import.meta.dirname, '..');
const wt = join(root, 'wt');
mkdirSync(join(wt, 'tools'), { recursive: true });
mkdirSync(join(wt, 'test'));
copyFileSync(join(REPO, 'tools/judge-replay.ts'), join(wt, 'tools/judge-replay.ts'));
mkdirSync(join(wt, 'tools/judge-replays'));
for (const f of readdirSync(join(REPO, 'tools/judge-replays'))) symlinkSync(join(REPO, 'tools/judge-replays', f), join(wt, 'tools/judge-replays', f));
// A replay file for a judge src/judges.ts doesn't register: judge-replay itself refuses it.
writeFileSync(join(wt, 'tools/judge-replays/unregistered.ts'), 'export {};\n');
symlinkSync(join(REPO, 'src'), join(wt, 'src'));
writeFileSync(join(wt, 'test/judge-replays.json'), '{"other": {"hash": "kept"}}\n');
const worktree = { cwd: wt, env: { PATH: process.env.PATH ?? '', HOME: root } };

test("judge_replay runs the worktree's judge-replay --record over the database, and the record lands where judges.test.ts reads it", async () => {
  const out = await hostCheck({ ...opts, worktree }, { what: 'judge_replay', judge: 'container-relief', days: 2 });
  assert.match(out, /the last 2 days: read 0 container memory storms/);
  assert.match(out, /Recorded in test\/judge-replays\.json/);
  const recs = JSON.parse(readFileSync(join(wt, 'test/judge-replays.json'), 'utf8'));
  assert.deepEqual(recs.other, { hash: 'kept' }, "another judge's record is left alone");
  assert.equal(recs['container-relief'].hash, judgeHash(judge('container-relief')!, REPO));
  assert.equal(recs['container-relief'].days, 2);
  const refused = await hostCheck({ ...opts, worktree }, { what: 'judge_replay', judge: 'unregistered' });
  assert.match(refused, /No judge unregistered/);
  assert.equal(JSON.parse(readFileSync(join(wt, 'test/judge-replays.json'), 'utf8')).unregistered, undefined, 'an unregistered judge records nothing');
});

test('judge_replay refuses a bad judge, days or scheme, a judge with no replay, and a caller with no worktree', async () => {
  for (const [body, why] of [
    [{ what: 'judge_replay' }, /judge must be/],
    [{ what: 'judge_replay', judge: '../src/x' }, /judge must be/],
    [{ what: 'judge_replay', judge: 'container-relief', days: 0 }, /days must be/],
    [{ what: 'judge_replay', judge: 'container-relief', scheme: 'all' }, /scheme must be/],
    [{ what: 'judge_replay', judge: 'no-such-judge' }, /No replay for a judge no-such-judge/],
  ] as const) {
    await assert.rejects(hostCheck({ ...opts, worktree }, body), (err: Error & { status: number }) => err.status === 400 && why.test(err.message), JSON.stringify(body));
  }
  await assert.rejects(hostCheck(opts, { what: 'judge_replay', judge: 'container-relief' }), (err: Error & { status: number }) => err.status === 400 && /worktree has none/.test(err.message));
});

test('judge_replay waits for a slow judge: the flake counter’s 3 days take about 600 s (#2100)', async () => {
  // A stand-in replay that prints its parent, coreutils `timeout`, whose third argument is the limit it runs under.
  const slow = join(root, 'slow');
  mkdirSync(join(slow, 'tools/judge-replays'), { recursive: true });
  writeFileSync(join(slow, 'tools/judge-replay.ts'), "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\\0')[3]);\n");
  writeFileSync(join(slow, 'tools/judge-replays/flake-counter.ts'), '');
  const out = await hostCheck({ ...opts, worktree: { cwd: slow, env: worktree.env } }, { what: 'judge_replay', judge: 'flake-counter' });
  assert.ok(Number(out) >= 2 * 3 * 201 * 0.7, `stopped after ${out} s`);
});

test('a slow answer sends its headers before the work ends, so the caller’s fetch does not give up (#2100)', async (t) => {
  let finish!: (v: object) => void;
  const server = createServer((_req, res) => void slowJson(res, new Promise<object>((ok) => (finish = ok)), 10));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  finish({ output: 'done' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: 'done' });
});

test('host_check says so when its answer is cut off, as by a restart mid-replay (#2100)', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(' ', () => res.destroy());
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const env = { COORDINATOR_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  await assert.rejects(
    turnStore.run({ env, cwd: root }, () => runShipTool('host_check', { what: 'judge_replay', judge: 'flake-counter' })),
    /cut off/,
  );
});
