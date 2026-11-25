// copy_app_data (#1884, src/app-copy.ts): a private, throwaway copy of an app's live data in the asking turn's own folder.
// Scratch DATA_DIRs only; a stand-in `claude -p` calls the route mid-turn with its own token, as the MCP tool does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { copyRefusal, runCopy, sweepAppCopies } from '../src/app-copy.ts';
import { askerKey, Store } from '../src/db.ts';
import { copyText, type CopyResult } from '../src/mcp-text.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';
import { bootServer, jsonLines, tempRoot, until, type Booted } from './helpers.ts';

const tmp = tempRoot('app-copy-');
const root = tmp.dir;
const home = join(root, 'home');
const data = join(home, '.local/share/trips');
mkdirSync(join(data, 'sub'), { recursive: true });

const live = new DatabaseSync(join(data, 'trips.db'));
live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE a (n INTEGER); CREATE TABLE b (n INTEGER); INSERT INTO a VALUES (1); INSERT INTO b VALUES (1);');
const rows = (file: string, table = 'a') => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const other = new DatabaseSync(join(data, 'sub', 'cache.sqlite'));
other.exec('CREATE TABLE a (n INTEGER); INSERT INTO a VALUES (1), (2);');
other.close();
writeFileSync(join(data, '.env'), 'KEY=SECRET');
writeFileSync(join(data, 'push.pem'), 'SECRET');
writeFileSync(join(data, 'sub', 'photo.txt'), 'hello');
mkdirSync(join(data, 'backups', '2026-11-23'), { recursive: true });
writeFileSync(join(data, 'backups', '2026-11-23', 'x.txt'), 'old');
writeFileSync(join(root, 'outside.txt'), 'outside');
symlinkSync(join(root, 'outside.txt'), join(data, 'link.txt'));

// Enough databases that a copy can be caught half way.
const big = join(home, '.local/share/big');
mkdirSync(big);
for (let i = 0; i < 1500; i++) copyFileSync(join(data, 'sub', 'cache.sqlite'), join(big, `${i}.db`));

let n = 0;
const scratch = () => join(root, `copy-${++n}`);
const copy = (over: { files?: boolean; cap?: number; spare?: number; signal?: AbortSignal; from?: string; to?: string } = {}) => runCopy({ from: data, to: scratch(), files: false, cap: 10 * 1024 ** 3, spare: 0, ...over });
const tree = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile()).sort();

test('the databases are copied whole, rows still in the WAL included, and nothing else unless asked', async () => {
  const to = scratch();
  const before = tree(data);
  const r = await copy({ to });
  assert.deepEqual(tree(to), ['sub/cache.sqlite', 'trips.db']);
  assert.deepEqual(r.databases.map((d) => d.name).sort(), ['sub/cache.sqlite', 'trips.db']);
  assert.equal(rows(join(to, 'trips.db')), 1);
  assert.equal(rows(join(to, 'sub', 'cache.sqlite')), 2);
  assert.equal(statSync(to).mode & 0o777, 0o700);
  assert.equal(statSync(join(to, 'trips.db')).mode & 0o777, 0o600);
  assert.equal(r.files, 0);
  assert.deepEqual(tree(data), before, 'nothing is left in the live folder');
});

test('with files, the rest comes too, never .env, key files, links or backups/', async () => {
  const to = scratch();
  const r = await copy({ to, files: true });
  assert.deepEqual(tree(to), ['sub/cache.sqlite', 'sub/photo.txt', 'trips.db']);
  assert.equal(r.files, 1);
  assert.deepEqual(r.left_out.sort(), ['.env', 'backups', 'link.txt', 'push.pem']);
  assert.match(copyText('trips', { ...r, dir: to }), /left out .*\.env/);
});

test('a copy taken while the app writes is consistent', async () => {
  // Each transaction adds one row to both tables, so any copy of a single moment has as many in each; the rows never
  // leave the WAL (autocheckpoint is off), so a copy of the file alone would be stale.
  const file = join(root, 'busy', 'busy.db');
  mkdirSync(join(root, 'busy'));
  const seed = new DatabaseSync(file);
  seed.exec(
    'PRAGMA journal_mode = WAL; CREATE TABLE a (n INTEGER, pad TEXT); CREATE TABLE b (n INTEGER, pad TEXT); BEGIN; WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 20000) INSERT INTO a SELECT i, hex(zeroblob(500)) FROM c; INSERT INTO b SELECT * FROM a; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);',
  );
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(file)}, { timeout: 10000 }); db.exec('PRAGMA wal_autocheckpoint = 0'); let i = 0; const go = () => { db.exec("BEGIN; INSERT INTO a VALUES (0, 'x'); INSERT INTO b VALUES (0, 'x'); COMMIT"); if (++i === 50) console.log('going'); setImmediate(go); }; go();`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  tmp.track(writer);
  try {
    await once(writer.stdout!, 'data');
    for (let i = 0; i < 3; i++) {
      const was = rows(file);
      const to = scratch();
      await copy({ from: join(root, 'busy'), to });
      const got = rows(join(to, 'busy.db'));
      assert.ok(got >= was, `${got} rows copied, ${was} were there before it started`);
      assert.equal(rows(join(to, 'busy.db'), 'b'), got);
      const db = new DatabaseSync(join(to, 'busy.db'));
      assert.deepEqual({ ...db.prepare('PRAGMA integrity_check').get() }, { integrity_check: 'ok' });
      db.close();
    }
    assert.ok(rows(file) > 20050, 'the writer kept writing');
  } finally {
    const gone = once(writer, 'exit');
    writer.kill('SIGKILL');
    await gone;
    seed.close();
  }
});

test('too much data, too little disk, no databases and a folder that is not there are refused in plain words, leaving nothing', async () => {
  for (const [over, why] of [
    [{ cap: 10 }, /over the .* a copy may take/],
    [{ spare: 2 ** 60 }, /disk/],
    [{ from: join(data, 'backups') }, /no SQLite database/],
    [{ from: join(root, 'nope') }, /no data folder/],
  ] as const) {
    const to = scratch();
    await assert.rejects(copy({ ...over, to }), why);
    assert.equal(existsSync(to), false);
  }
});

test('a database is copied whatever its name; secret files and folders, and a file that cannot be read, are left out and named', async () => {
  const from = join(root, 'named');
  mkdirSync(join(from, 'secret-santa'), { recursive: true });
  mkdirSync(join(from, 'secrets'));
  for (const f of ['token-ledger.db', 'secret-santa/draws.db', 'secrets/vault.db']) copyFileSync(join(data, 'sub', 'cache.sqlite'), join(from, f));
  for (const f of ['api-token.txt', 'plain.txt', 'secret-santa/list.txt', 'shut.txt']) writeFileSync(join(from, f), 'x');
  chmodSync(join(from, 'shut.txt'), 0);
  const to = scratch();
  const r = await copy({ from, to, files: true });
  assert.deepEqual(tree(to), ['plain.txt', 'secret-santa/draws.db', 'token-ledger.db']);
  assert.deepEqual(r.left_out.sort(), ['api-token.txt', 'secret-santa/list.txt', 'secrets', 'shut.txt']);
  assert.equal(r.files, 1);
});

test('a copy stopped half way leaves nothing', async () => {
  const to = scratch();
  const stop = new AbortController();
  const p = copy({ from: big, to, signal: stop.signal });
  const stopped = assert.rejects(p);
  await until('the copy to begin', () => existsSync(to) && readdirSync(to).length > 0);
  assert.ok(readdirSync(to).length < readdirSync(big).length, 'it is not done');
  stop.abort();
  await stopped;
  assert.equal(existsSync(to), false);
});

test('copies a crash left are swept at the next start, and one begun since is not', async () => {
  const dir = join(root, 'swept');
  const copies = join(dir, 'run', 'app-copies');
  mkdirSync(join(copies, '7-100'), { recursive: true });
  mkdirSync(join(copies, '7-200'));
  await sweepAppCopies(dir, 200);
  assert.deepEqual(readdirSync(copies), ['7-200']);
  await sweepAppCopies(join(root, 'none-yet'));
});

test("only a home scheme's minion, on a member's ask, gets a copy", () => {
  const store = new Store(join(root, 'who.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const dana = store.createUser({ name: 'Dana', login: 'dana' });
  store.createProject('First', null, josh.id);
  const citadel = store.createProject('Citadel', null, dana.id);
  assert.equal(citadel.id, GLOBAL_OWNER);
  const trips = store.createProject('Trips', null, josh.id);
  const delve = store.createProject('Delve', null, josh.id);
  for (const [name, scheme] of [
    ['trips', trips.id],
    ['stray', null],
  ] as const)
    store.db.prepare("INSERT INTO contraptions (name, title, port, identity_public, identity_private, key_hash, keys_at, created_at, home_scheme) VALUES (?, ?, 9100, 'P', 'K', ?, 1, 1, ?)").run(name, name === 'trips' ? 'Trips' : 'Stray', name, scheme);
  const minion = (project: number) => store.createTicket({ project_id: project, title: 'x', permission_mode: 'default', created_by: 'x' });
  const ask = (project: number, person: number | null, app = 'trips') => {
    const t = minion(project);
    if (person !== null) store.setSetting(askerKey(t.id), person);
    return copyRefusal(store, t, app);
  };
  assert.equal(ask(trips.id, josh.id), null);
  assert.match(ask(delve.id, josh.id)!, /trips isn't one of this scheme's contraptions/);
  assert.match(ask(trips.id, josh.id, 'stray')!, /stray isn't one of this scheme's contraptions/);
  assert.match(ask(trips.id, josh.id, 'nope')!, /nope isn't one of this scheme's contraptions/);
  assert.match(ask(citadel.id, dana.id)!, /trips isn't one of this scheme's contraptions/);
  assert.match(ask(trips.id, null)!, /no one's ask/);
  // Seeing the scheme isn't being in it (Josh, 2026-11-25: "Any home scheme member"): an admin, and a Citadel member.
  assert.match(ask(trips.id, cara.id)!, /Cara isn't a member of Trips/);
  assert.match(ask(trips.id, dana.id)!, /Dana isn't a member of Trips/);
  store.db.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(josh.id);
  assert.match(ask(trips.id, josh.id)!, /no one's ask/);
  store.db.close();
});

// ---------- a real turn ----------

// Each turn runs the calls in plan.json, works on the copy it got, logs, and then ends or holds until it's stopped.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
require('node:readline').createInterface({ input: process.stdin }).once('line', async () => {
  const plan = existsSync(${JSON.stringify(join(root, 'plan.json'))}) ? JSON.parse(readFileSync(${JSON.stringify(join(root, 'plan.json'))}, 'utf8')) : { apps: [] };
  const api = readFileSync(${JSON.stringify(join(root, 'api'))}, 'utf8');
  const out = [];
  for (const app of plan.apps) {
    const r = await fetch(api + '/api/app-copy/' + app, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN, 'Content-Type': 'application/json' } });
    const data = await r.json();
    let migrated;
    if (r.ok) {
      const db = new DatabaseSync(data.dir + '/trips.db');
      db.exec('ALTER TABLE a ADD COLUMN extra; INSERT INTO a (n, extra) VALUES (2, 3)');
      migrated = db.prepare('SELECT count(*) AS n FROM a').get().n;
      db.close();
    }
    out.push({ status: r.status, data, migrated });
  }
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ out, token: plan.hold && process.env.COORDINATOR_TOKEN }) + '\\n');
  if (plan.hold) return void setInterval(() => {}, 1000);
  if (plan.fail) process.exit(1);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

type Out = { status: number; data: CopyResult & { dir: string; error?: string }; migrated?: number };
let srv: Booted;
let mine: { id: number; project_id: number };
let theirs: { id: number; project_id: number };
const idle = (id: number) =>
  until('the turn to end', async () => {
    const { ticket } = (await srv.call(`/api/tickets/${id}`)).data;
    return ticket.status !== 'running' && ticket.queued === 0;
  });
async function turn(t: { id: number }, plan: { apps: string[]; hold?: boolean; fail?: boolean }): Promise<Out[]> {
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  const was = jsonLines(join(root, 'turns.jsonl')).length;
  await srv.call(`/api/tickets/${t.id}/messages`, { text: 'try the migration' });
  const out = await until('the turn', () => jsonLines(join(root, 'turns.jsonl')).length > was && jsonLines(join(root, 'turns.jsonl')).at(-1)!.out);
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ apps: [] }));
  return out;
}

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fake, HOME: home } });
  tmp.track(srv.proc);
  writeFileSync(join(root, 'api'), srv.base);
  const p = (await srv.call('/api/projects', { name: 'Trips' })).data;
  const q = (await srv.call('/api/projects', { name: 'Delve' })).data;
  const c = await srv.call('/api/contraptions', { name: 'trips', title: 'Trips', port: await tmp.down(), home_scheme: p.id });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal((await srv.call('/api/contraptions', { name: 'big', title: 'Big', port: await tmp.down(), home_scheme: p.id })).status, 201);
  mine = (await srv.call(`/api/projects/${p.id}/tickets`, { message: 'start' })).data;
  theirs = (await srv.call(`/api/projects/${q.id}/tickets`, { message: 'start' })).data;
  await idle(mine.id);
  await idle(theirs.id);
});
after(async () => {
  live.close();
  await tmp.teardown();
});

test('a turn migrates its copy, the live data is untouched, and the copy is gone once it ends', async () => {
  const [a, again] = await turn(mine, { apps: ['trips', 'trips'] });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.migrated, 2);
  assert.equal(again.migrated, 2, 'asking again starts over from the live data');
  assert.equal(again.data.dir, a.data.dir);
  await idle(mine.id);
  await until('the copy to go', () => !existsSync(a.data.dir));
  assert.equal(rows(join(data, 'trips.db')), 1);
  assert.deepEqual(readdirSync(join(srv.data, 'run', 'app-copies')), []);
  assert.match(JSON.stringify((await srv.call(`/api/tickets/${mine.id}/events`)).data), /Cara's turn took a private copy of the live data of Trips/);
});

test("the copy sits in the turn's own folder and goes when the turn fails or is stopped", async () => {
  const [failed] = await turn(mine, { apps: ['trips'], fail: true });
  assert.equal(failed.status, 200, JSON.stringify(failed.data));
  await idle(mine.id);
  await until('the failed turn’s copy to go', () => !existsSync(failed.data.dir));
  const [held] = await turn(mine, { apps: ['trips'], hold: true });
  assert.ok(held.data.dir.startsWith(join(srv.data, 'run', 'turns')), held.data.dir);
  assert.ok(existsSync(join(held.data.dir, 'trips.db')));
  await srv.call(`/api/tickets/${mine.id}/stop`, {});
  await until('the stopped turn’s copy to go', () => !existsSync(held.data.dir));
});

test('a turn stopped while its copy is under way leaves nothing', async () => {
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ apps: ['big'] }));
  await srv.call(`/api/tickets/${mine.id}/messages`, { text: 'try the migration' });
  const parts = join(srv.data, 'run', 'app-copies');
  await until('the copy to begin', () => existsSync(parts) && readdirSync(parts).length > 0);
  await srv.call(`/api/tickets/${mine.id}/stop`, {});
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ apps: [] }));
  await until('what it copied to go', () => readdirSync(parts).length === 0);
  await idle(mine.id);
  const turns = join(srv.data, 'run', 'turns');
  assert.ok(!readdirSync(turns).some((t) => existsSync(join(turns, t, 'app-copy'))), 'none was handed to the turn');
});

test('the tool itself answers with the folder and what it holds', async () => {
  await turn(mine, { apps: [], hold: true });
  const { token } = jsonLines(join(root, 'turns.jsonl')).at(-1)!;
  const r = await mcpOnce(agentEnv(srv.base, token, mine, 'thread', { COORDINATOR_HOME_CONTRAPTIONS: 'trips', TMPDIR: root }), 'tools/call', { name: 'copy_app_data', arguments: { app: 'trips' } }, tmp.track);
  assert.match(r.content[0].text, /^A private copy of trips's live data is in \S+\/app-copy\/trips: .*trips\.db \(/);
  assert.match(r.content[0].text, /It left out .*backups/);
  await srv.call(`/api/tickets/${mine.id}/stop`, {});
  await idle(mine.id);
});

test("another scheme's minion is refused", async () => {
  const [r] = await turn(theirs, { apps: ['trips'] });
  assert.equal(r.status, 403);
  assert.match(r.data.error!, /trips isn't one of this scheme's contraptions/);
});

test("a minion whose scheme has an app has the tool; one in a scheme without, or a Taskmaster, hasn't", async () => {
  const names = async (role: string, apps?: string) => (await mcpOnce(agentEnv(srv.base, 'x', mine, role, { COORDINATOR_HOME_CONTRAPTIONS: apps, TMPDIR: root }), 'tools/list', {}, tmp.track)).tools.map((t: { name: string }) => t.name);
  assert.ok((await names('thread', 'trips')).includes('copy_app_data'));
  assert.ok(!(await names('thread')).includes('copy_app_data'));
  assert.ok(!(await names('coordinator', 'trips')).includes('copy_app_data'));
});
