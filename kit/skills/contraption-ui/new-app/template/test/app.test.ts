// {{title}}'s own tests: node --test test/. A fake Citadel (test/fake-citadel.ts, from the kit) signs the
// identity header, so these run with no Citadel and no Claude login.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { start, type Running } from '../server.ts';
import { backup, KEEP_DAYS } from '../src/backup.ts';
import { DB_FILE, migrate, MIGRATIONS } from '../src/db.ts';
import { startFakeCitadel, type FakeCitadel } from './fake-citadel.ts';

const BASE = '/apps/{{name}}';
let fake: FakeCitadel;
let app: Running;
let dataDir: string;

before(async () => {
  fake = await startFakeCitadel({ app: '{{name}}', people: [{ id: 1, login: 'tester', name: 'Tess Ter' }] });
  dataDir = mkdtempSync(join(tmpdir(), '{{name}}-test-'));
  app = await start({ port: 0, base: BASE, dataDir, keysDir: fake.keysDir });
});
after(async () => {
  await app.close();
  await fake.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (path: string, identity?: string) => fetch(`${app.url}${path}`, { headers: identity ? { 'x-citadel-identity': identity } : {}, redirect: 'manual' });

test('health answers with no identity once the database is open', async () => {
  assert.equal((await get('/healthz')).status, 204);
});

test('every page needs a signed-in person', async () => {
  for (const path of ['/', '/index.html', '/app.js', '/api/me']) assert.equal((await get(path)).status, 401, path);
});

test("a forged, expired, relayed or other app's identity is refused", async () => {
  const good = fake.identity(1);
  const [v, claims] = good.split('.');
  const forged = `${v}.${claims}.${Buffer.alloc(64).toString('base64url')}`;
  for (const id of [forged, fake.identity(1, { ttlSec: -60 }), fake.identity(1, { from: 'other' }), fake.identity(1, { app: 'other' }), 'nonsense']) {
    assert.equal((await get('/api/me', id)).status, 401, id);
  }
});

test('the signed-in person sees their name, and is remembered', async () => {
  const res = await get('/api/me', fake.identity(1));
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.login, 'tester');
  assert.equal(me.name, 'Tess Ter');
  const again = await (await get('/api/me', fake.identity(1))).json();
  assert.equal(again.firstSeen, me.firstSeen);
});

test('the first page and its install files are served', async () => {
  const page = await get('/', fake.identity(1));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /class="cui-topbar"/);
  for (const open of ['/manifest.webmanifest', '/icon.svg', '/icon-192.png']) assert.equal((await get(open)).status, 200, open);
  const manifest = await (await get('/manifest.webmanifest')).json();
  assert.equal(manifest.scope, `${BASE}/`);
});

test('the bare base redirects, and paths outside the public folder are not served', async () => {
  const bare = await fetch(app.url, { redirect: 'manual' });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get('location'), `${BASE}/`);
  assert.equal((await get('/%2e%2e/server.ts', fake.identity(1))).status, 404);
  assert.equal((await get('/nope.html', fake.identity(1))).status, 404);
});

test('migrations run once, in order, and record the version', () => {
  const db = new DatabaseSync(':memory:');
  const v = migrate(db);
  assert.ok(v >= 1);
  assert.equal(migrate(db), v);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'people'").get());
  const dir = mkdtempSync(join(tmpdir(), '{{name}}-mig-'));
  try {
    writeFileSync(join(dir, '0001-a.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(dir, '0002-bad.sql'), 'CREATE TABLE b (x); NOT SQL;');
    const fresh = new DatabaseSync(':memory:');
    assert.throws(() => migrate(fresh, dir), /0002-bad\.sql/);
    assert.equal(fresh.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(fresh.prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'").get(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(existsSync(MIGRATIONS));
});

test('the nightly backup writes a readable copy and keeps the newest days', () => {
  const out = backup(dataDir, '2026-01-01');
  const copy = new DatabaseSync(join(out, DB_FILE), { readOnly: true });
  assert.ok(copy.prepare("SELECT login FROM people WHERE login = 'tester'").get());
  copy.close();
  for (let d = 2; d <= KEEP_DAYS + 3; d++) backup(dataDir, `2026-01-${String(d).padStart(2, '0')}`);
  assert.equal(existsSync(join(dataDir, 'backups', '2026-01-01')), false);
  assert.ok(existsSync(join(dataDir, 'backups', `2026-01-${KEEP_DAYS + 3}`, DB_FILE)));
});
