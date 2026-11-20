import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadVapidKeys } from '../src/push.ts';
import { answer, check, recipients, step, targets, type Target, type WatchState } from '../src/watchdog.ts';

const root = mkdtempSync(join(tmpdir(), 'watchdog-'));
after(() => rmSync(root, { recursive: true, force: true }));
const MIN = 60_000;
const T = 10 * MIN;
const round = (state: WatchState, now: number, ...found: [string, string | null][]) => {
  const r = step(state, new Map(found.map(([k, f]) => [k, { title: k === 'citadel' ? 'Citadel' : k, finding: f }])), now, T);
  return { ...r, message: r.messageFor(null) };
};

test('alerts once past the threshold, then once more when it is back', () => {
  let s: WatchState = {};
  const t0 = 1_000_000_000;
  for (const t of [0, 5]) {
    const r = round(s, t0 + t * MIN, ['citadel', '/api/health not answering']);
    assert.equal(r.message, null, `nothing at ${t} min`);
    s = r.sent;
  }
  const r10 = round(s, t0 + 10 * MIN - 20_000, ['citadel', 'inactive']); // a timer firing a little early still counts
  assert.equal(r10.message?.title, 'Citadel down');
  assert.equal(r10.message?.body, 'Down: Citadel 10 min (inactive).');
  assert.equal(r10.message?.tag, 'citadel-watchdog');
  s = r10.sent;
  assert.equal(round(s, t0 + 15 * MIN, ['citadel', 'inactive']).message, null, 'no repeat while still down');
  s = round(s, t0 + 15 * MIN, ['citadel', 'inactive']).sent;
  const back = round(s, t0 + 30 * MIN, ['citadel', null]);
  assert.equal(back.message?.title, 'Citadel back up');
  assert.equal(back.message?.body, 'All back: Citadel (back up after 30 min).');
  assert.equal(back.message?.silent, true, 'the all-clear replaces the down push without ringing (#532)');
  assert.deepEqual(back.sent, {});
  assert.equal(round(back.sent, t0 + 35 * MIN, ['citadel', null]).message, null);
});

test('a blip shorter than the threshold says nothing', () => {
  const a = round({}, 0, ['mandate', 'inactive']);
  const b = round(a.sent, 5 * MIN, ['mandate', null]);
  assert.equal(b.message, null);
  assert.deepEqual(b.sent, {});
});

test('a push that did not go out is tried again next round', () => {
  const a = round({}, 0, ['citadel', 'inactive']);
  const b = round(a.sent, T, ['citadel', 'inactive']);
  assert.ok(b.message);
  const c = round(b.unsent, T + 5 * MIN, ['citadel', 'inactive']);
  assert.equal(c.message?.title, 'Citadel down', 'still unsaid, so it alerts');
  const back = round(c.sent, T + 10 * MIN, ['citadel', null]);
  const again = round(back.unsent, T + 15 * MIN, ['citadel', null]);
  assert.equal(again.message?.title, 'Citadel back up', 'an undelivered all-clear is tried again');
  assert.equal(again.message?.body, 'All back: Citadel (back up after 20 min).', 'timed from when it came back');
});

test('one push covers everything down; one going away unwatched gets an all-clear', () => {
  let s = round({}, 0, ['citadel', 'inactive'], ['mandate', 'port 3001 closed']).sent;
  const r = round(s, T, ['citadel', 'inactive'], ['mandate', 'port 3001 closed']);
  assert.equal(r.message?.title, 'Citadel, mandate down');
  const owner = new Set(['mandate']);
  assert.deepEqual(r.messageFor(owner), { title: 'mandate down', body: 'Down: mandate 10 min (port 3001 closed).', tag: 'citadel-watchdog', url: '/c/' }, "an owner hears only theirs");
  assert.equal(r.messageFor(new Set(['peek'])), null, 'nor about anyone else');
  s = r.sent;
  const gone = round(s, T + 5 * MIN, ['citadel', 'inactive']); // mandate's unit was disabled
  assert.equal(gone.message?.title, 'mandate back up');
  assert.equal(gone.message?.silent, true, 'nothing newly down: Citadel was already told, so it does not ring again');
  assert.equal(gone.message?.body, 'Down: Citadel 15 min (inactive). Back: mandate (no longer watched after 15 min).');
  assert.equal(gone.messageFor(owner)?.body, 'All back: mandate (no longer watched after 15 min).');
});

test('check skips contraptions whose unit is not enabled, and probes only active units', async () => {
  const list: Target[] = [
    { key: 'citadel', title: 'Citadel', unit: 'claude-coordinator.service', probe: { port: 1 }, always: true },
    { key: 'app:a', title: 'A', unit: 'citadel-app-a.service', probe: { port: 2 }, always: false },
    { key: 'app:b', title: 'B', unit: 'citadel-app-b.service', probe: { port: 3 }, always: false },
  ];
  const units: Record<string, { active: string; enabled: string }> = {
    'claude-coordinator.service': { active: 'failed', enabled: 'enabled' },
    'citadel-app-a.service': { active: 'active', enabled: 'enabled' },
    'citadel-app-b.service': { active: 'inactive', enabled: 'disabled' },
  };
  const probed: number[] = [];
  const found = await check(list, { unitState: async (u) => units[u], answer: async (p) => (probed.push((p as any).port), 'port 2 closed') });
  assert.deepEqual([...found], [['citadel', { title: 'Citadel', finding: 'failed' }], ['app:a', { title: 'A', finding: 'port 2 closed' }]]);
  assert.deepEqual(probed, [2]);
  const wedged = await check(list.slice(0, 2), { unitState: async (u) => (u === 'claude-coordinator.service' ? Promise.reject(new Error('bus timed out')) : units[u]), answer: async () => null });
  assert.deepEqual([...wedged.keys()].sort(), ['app:a', 'citadel'], 'one failing systemctl still lets every target through, probed');
});

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, '127.0.0.1', () => ok((s.address() as any).port)));

test('answer: a 2xx is up, anything else says why', async () => {
  const hang: any[] = [];
  const srv = createServer((req, res) => (req.url === '/hang' ? hang.push(res) : (res.statusCode = req.url === '/ok' ? 204 : 503, res.end())));
  const port = await listen(srv);
  after(() => (hang.forEach((r) => r.destroy()), srv.close()));
  assert.equal(await answer({ url: `http://127.0.0.1:${port}/ok` }), null);
  assert.equal(await answer({ url: `http://127.0.0.1:${port}/health` }), '/health answered 503');
  assert.equal(await answer({ url: `http://127.0.0.1:${port}/hang` }, 200), '/hang not answering');
  assert.equal(await answer({ port }), null);
  srv.close();
  srv.closeAllConnections();
  assert.equal(await answer({ port }), `port ${port} closed`);
});

test('targets and recipients come from the database', () => {
  const dir = mkdtempSync(join(root, 'db-'));
  const store = new Store(join(dir, 'coordinator.db'));
  store.createUser({ name: 'Cara', login: 'cara', admin: true });
  store.createUser({ name: 'Josh', login: 'josh', admin: true });
  store.createUser({ name: 'Pat', login: 'pat' });
  for (const n of ['Cara', 'Josh', 'Pat']) store.savePushSubscription(n, `https://push.example/${n}`, 'k', 'a');
  // A desktop app's device hears through Citadel, down with it: never a watchdog recipient (#1186).
  for (const n of ['Cara', 'Pat']) store.savePushSubscription(n, `desktop:00000000-0000-4000-8000-00000000000${n.length}`, '', '');
  const db = new DatabaseSync(join(dir, 'coordinator.db'));
  db.prepare(`INSERT INTO contraptions (name, title, port, identity_public, identity_private, key_hash, keys_at, created_at, folder)
    VALUES ('mandate', 'Mandate', 3001, 'p', 'q', 'h1', 0, 0, NULL), ('peek', 'Peek Auras', 3002, 'p', 'q', 'h2', 0, 0, ?)`).run(join(dir, 'peek'));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'apps/mandate'), { recursive: true });
  writeFileSync(join(home, 'apps/mandate/citadel-app.json'), JSON.stringify({ start: ['node', 'server.ts'], health: '/health' }));
  const t = targets(db, home);
  assert.deepEqual(t.map((x) => [x.key, x.unit, x.probe]), [
    ['citadel', 'claude-coordinator.service', { url: 'http://127.0.0.1:8573/api/health' }],
    ['app:mandate', 'citadel-app-mandate.service', { url: 'http://127.0.0.1:3001/health' }],
    ['app:peek', 'citadel-app-peek.service', { port: 3002 }],
  ]);
  db.prepare("UPDATE users SET disabled_at = 1 WHERE name = 'Josh'").run();
  store.createUser({ name: 'Sam', login: 'sam', admin: true });
  store.savePushSubscription('sam', 'https://push.example/sam', 'k', 'a');
  // Pat owns Peek's and Mandate's home schemes and has Mandate on; Lee owns a scheme too, without Mandate.
  const lee = store.createUser({ name: 'Lee', login: 'lee' });
  store.savePushSubscription('Lee', 'https://push.example/Lee', 'k', 'a');
  const pat = store.findUser('name', 'Pat')!;
  const patScheme = store.createProject('Pat things', null, pat.id);
  const leeScheme = store.createProject('Lee things', null, lee.id);
  const josh = store.findUser('name', 'Josh')!;
  const joshScheme = store.createProject('Josh things', null, josh.id);
  db.prepare("INSERT INTO contraptions (name, title, port, identity_public, identity_private, key_hash, keys_at, created_at, home_scheme) VALUES ('lees', 'Lees', 3003, 'p', 'q', 'h3', 0, 0, ?), ('joshs', 'Joshs', 3004, 'p', 'q', 'h4', 0, 0, ?)").run(leeScheme.id, joshScheme.id);
  db.prepare("UPDATE contraptions SET home_scheme = ? WHERE name IN ('peek', 'mandate')").run(patScheme.id);
  for (const u of [pat.id, josh.id]) db.prepare("INSERT INTO contraption_users (contraption_id, user_id, added_at) SELECT id, ?, 0 FROM contraptions WHERE name = 'mandate'").run(u);
  assert.deepEqual(recipients(db).map((s) => [s.name, s.only && [...s.only]]), [['Cara', null], ['sam', null], ['Pat', ['app:mandate', 'app:peek']]],
    'admins hear everything (not disabled ones, whatever the case of the name); an owner with Mandate on, their own; Lee has no Mandate, Josh is disabled');
  db.close();
});

test('tools/watchdog.ts pushes the admins a readable message and saves its state', async () => {
  const dir = mkdtempSync(join(root, 'run-'));
  const store = new Store(join(dir, 'coordinator.db'));
  store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const keys = loadVapidKeys(dir);
  const got: { headers: any; body: Buffer }[] = [];
  const push = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => (got.push({ headers: req.headers, body: Buffer.concat(chunks) }), res.writeHead(201).end()));
  });
  const port = await listen(push);
  after(() => push.close());
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  store.savePushSubscription('Cara', `http://127.0.0.1:${port}/sub`, ua.getPublicKey().toString('base64url'), randomBytes(16).toString('base64url'));
  // A stand-in systemctl: Citadel's unit is failed, so nothing probes the live port.
  const fake = join(dir, 'systemctl');
  writeFileSync(fake, '#!/bin/sh\necho ActiveState=failed\necho UnitFileState=enabled\n');
  chmodSync(fake, 0o755);
  mkdirSync(join(dir, 'backups'));
  writeFileSync(join(dir, 'backups', 'coordinator-2026-11-19.db'), 'x'); // a fresh night, so only Citadel is down
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ citadel: { title: 'Citadel', since: Date.now() - 11 * MIN, why: 'failed', alerted: false } }));
  const run = (env: object = {}) => new Promise<string>((ok, fail) => execFile(process.execPath, ['tools/watchdog.ts'], {
    env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, WATCHDOG_STATE: stateFile, CITADEL_SYSTEMCTL: fake, ...env },
  }, (err, out, errText) => (err ? fail(new Error(`${err.message}\n${errText}`)) : ok(String(out)))));
  const out = await run();
  assert.match(out, /2 watched, down: Citadel: failed/);
  assert.match(out, /Pushing to Cara: Citadel down: Down: Citadel 11 min \(failed\)\./);
  assert.equal(got.length, 1);
  assert.match(got[0].headers.authorization, new RegExp(`^vapid t=.+, k=${keys.publicKey}$`));
  assert.equal(got[0].headers.topic, 'citadel-watchdog');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).citadel.alerted, true);
  const sub = () => JSON.parse(Buffer.from(/t=[^.]+\.([^.]+)\./.exec(got.at(-1)!.headers.authorization)![1], 'base64url').toString()).sub;
  assert.equal(sub(), 'https://localhost', 'no subject set anywhere');
  await run();
  assert.equal(got.length, 1, 'no second push while it stays down');
  // Signed with the server's subject: the stored setting, or PUSH_SUBJECT over it.
  const again = (env: object = {}) => (writeFileSync(stateFile, JSON.stringify({ citadel: { title: 'Citadel', since: Date.now() - 11 * MIN, why: 'failed', alerted: false } })), run(env));
  store.setSetting('push_subject', 'https://citadel.example');
  await again();
  assert.equal(sub(), 'https://citadel.example');
  await again({ PUSH_SUBJECT: 'mailto:ops@example.com' });
  assert.equal(sub(), 'mailto:ops@example.com');
  assert.equal(got.length, 3);
});

test('tools/watchdog.ts pushes once when the newest backup is a day old, and names what is missing', async () => {
  const dir = mkdtempSync(join(root, 'backup-'));
  const store = new Store(join(dir, 'coordinator.db'));
  store.createUser({ name: 'Cara', login: 'cara', admin: true });
  loadVapidKeys(dir);
  const got: unknown[] = [];
  const push = createServer((req, res) => (req.resume(), got.push(req.url), res.writeHead(201).end()));
  const port = await listen(push);
  after(() => push.close());
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  store.savePushSubscription('Cara', `http://127.0.0.1:${port}/sub`, ua.getPublicKey().toString('base64url'), randomBytes(16).toString('base64url'));
  const fake = join(dir, 'systemctl');
  writeFileSync(fake, '#!/bin/sh\necho ActiveState=active\necho UnitFileState=enabled\n');
  chmodSync(fake, 0o755);
  mkdirSync(join(dir, 'backups'));
  const old = join(dir, 'backups', 'coordinator-2026-11-18.db');
  writeFileSync(old, 'x');
  const ago = new Date(Date.now() - 30 * 3_600_000);
  utimesSync(old, ago, ago);
  // A stand-in Citadel that answers /api/health, so "all up" doesn't hang on a live one at 8573 (CI has none).
  const health = createServer((req, res) => res.writeHead(200).end('ok'));
  const healthPort = await listen(health);
  after(() => health.close());
  const stateFile = join(dir, 'state.json');
  // It has been missing for 11 minutes already: the push is due now.
  writeFileSync(stateFile, JSON.stringify({ backup: { title: 'Nightly backup', since: Date.now() - 11 * MIN, why: 'x', alerted: false } }));
  const run = () => new Promise<string>((ok, fail) => execFile(process.execPath, ['tools/watchdog.ts'], {
    env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, WATCHDOG_STATE: stateFile, CITADEL_SYSTEMCTL: fake, WATCHDOG_CITADEL_PORT: String(healthPort) },
  }, (err, out, errText) => (err ? fail(new Error(`${err.message}\n${errText}`)) : ok(String(out)))));
  const out = await run();
  assert.match(out, /Nightly backup: the database backup is 30 h old/);
  assert.match(out, /Pushing to Cara: Nightly backup down/);
  assert.equal(got.length, 1);
  await run();
  assert.equal(got.length, 1, 'one push, not one a round');
  // A fresh backup clears it.
  writeFileSync(old, 'y');
  const back = await run();
  assert.match(back, /all up/);
});
