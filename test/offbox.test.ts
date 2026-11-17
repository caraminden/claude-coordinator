// The off-box copy set (#252): deploy/offbox.sh, run by backup.sh, and deploy/offbox-serve.sh, the only
// command the desktop's backup key can run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'offbox-'));
after(() => rmSync(root, { recursive: true, force: true }));

const deploy = join(import.meta.dirname, '..', 'deploy');
const appsData = join(root, 'apps-data'); // stands in for ~/.local/share, where each contraption's DATA_DIR is
const keyDir = join(root, 'citadel-android'); // stands in for ~/.config/citadel-android, the Android apps' release keys
const env = { ...process.env, DATA_DIR: root, APPS_DATA: appsData, KEY_DIR: keyDir };
const run = (script: string) => execFileSync(join(deploy, script), { env, encoding: 'utf8' });
const serve = (command: string) => spawnSync(join(deploy, 'offbox-serve.sh'), { env: { ...env, SSH_ORIGINAL_COMMAND: command } });
const backups = join(root, 'backups');
const offbox = join(root, 'offbox');
const day = execFileSync('date', ['+%F'], { encoding: 'utf8' }).trim();
const GITHUB_SECRET = 'v1:github-token-that-must-not-leave-perigee';
const SAVED_SECRET = 'v1:a-saved-secret-that-must-not-leave-perigee';

const store = new Store(join(root, 'coordinator.db'));
const project = store.createProject('Demo', null);
store.createTicket({ project_id: project.id, title: 't', permission_mode: 'default', created_by: 't' });
const user = store.createUser({ name: 'Josh', login: 'josh' });
store.putCredential(user.id, 'github', GITHUB_SECRET, { login: 'josh-gh' });
store.putCredential(user.id, 'claude_runner', 'citadel-claude-2', { container: 'citadel-claude-2' });
// Saved secrets (#838), a person's and a scheme's: none leave perigee.
store.putSecret('person', user.id, 'SITE_PW', SAVED_SECRET, user.id);
store.putSecret('scheme', project.id, 'AZURE_KEY', SAVED_SECRET, user.id);
// A contraption turn's audit (#844): players' words, kept 14 days, so no backup copy holds them (#850). Long, so it spills into overflow pages.
const PLAYER_WORDS = `a-player-said-this-in-a-turn-${'x'.repeat(20_000)}`;
const app = store.createContraption({ name: 'voice', title: 'Voice', icon: null, port: 9, home_scheme: project.id, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
store.putTurnAudit(store.startContraptionTurn(app.id, user.id, 's1'), { model: null, blind: false, images: 0, system: 'sys', prompt: PLAYER_WORDS, output: 'reply' });
store.putClaudeState({ path: 'projects/x/1.jsonl', project_id: project.id, ticket_id: null, size: 3, mtime: 1, data: new Uint8Array(10) });
store.db.close();

const kinds = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT kind FROM credentials ORDER BY kind').all() as { kind: string }[]).map((r) => r.kind);
  } finally {
    db.close();
  }
};
const count = (file: string, table: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('the nightly backup also writes the off-box set, with linked-account secrets stripped', () => {
  assert.match(run('backup.sh'), /Off-box set: 3 files/);
  assert.deepEqual(readdirSync(offbox).sort(), [`coordinator-${day}.db`, readdirSync(backups).find((f) => f.startsWith('coordinator-weekly-'))!, 'SHA256SUMS', `state-${day}.db`].sort());
  const daily = join(offbox, `coordinator-${day}.db`);
  assert.deepEqual(kinds(daily), ['claude_runner'], 'only the claude_runner row, which holds no secret, stays');
  assert.ok(!readFileSync(daily).includes(GITHUB_SECRET), 'VACUUM leaves no trace of the stripped rows');
  assert.equal(count(daily, 'stored_secrets'), 0, 'no saved secret goes off-box');
  assert.ok(!readFileSync(daily).includes(SAVED_SECRET), 'nor any trace of one');
  assert.equal(count(join(backups, `coordinator-${day}.db`), 'stored_secrets'), 2);
  assert.deepEqual(kinds(join(backups, `coordinator-${day}.db`)), ['claude_runner', 'github'], 'the backup on perigee keeps its secrets');
  const marker = PLAYER_WORDS.slice(0, 40);
  assert.ok(readFileSync(join(root, 'coordinator.db')).includes(marker), 'the fixture holds the words to strip');
  for (const copy of [join(backups, `coordinator-${day}.db`), daily]) {
    assert.equal(count(copy, 'contraption_turn_audit'), 0, `no turn audit in ${copy}`);
    assert.ok(!readFileSync(copy).includes(marker), `nor any trace of one in ${copy}`);
  }
  assert.equal(count(join(backups, `coordinator-${day}.db`), 'contraption_turns'), 1, 'the turn itself stays');
  const weekly = readdirSync(offbox).find((f) => f.startsWith('coordinator-weekly-'))!;
  assert.equal(statSync(join(offbox, weekly)).ino, statSync(daily).ino, 'the weekly links to its stripped daily');
  assert.equal(statSync(join(offbox, `state-${day}.db`)).ino, statSync(join(backups, `state-${day}.db`)).ino);
  assert.equal((statSync(offbox).mode & 0o777).toString(8), '700');
  assert.equal((statSync(daily).mode & 0o777).toString(8), '600');
  const sums = readFileSync(join(offbox, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 3);
  for (const line of sums) {
    const [hash, name] = line.split(/\s+/);
    assert.equal(hash, sha(join(offbox, name)), name);
  }
});

test('only the newest state copy goes off-box, and files gone from the backups go from it too', () => {
  copyFileSync(join(backups, `state-${day}.db`), join(backups, 'state-2000-01-01.db'));
  copyFileSync(join(backups, `coordinator-${day}.db`), join(backups, 'coordinator-2000-01-01.db'));
  run('offbox.sh');
  assert.ok(existsSync(join(offbox, 'coordinator-2000-01-01.db')));
  assert.deepEqual(kinds(join(offbox, 'coordinator-2000-01-01.db')), ['claude_runner']);
  assert.ok(!existsSync(join(offbox, 'state-2000-01-01.db')));
  rmSync(join(backups, 'coordinator-2000-01-01.db'));
  run('offbox.sh');
  assert.ok(!existsSync(join(offbox, 'coordinator-2000-01-01.db')));
  assert.doesNotMatch(readFileSync(join(offbox, 'SHA256SUMS'), 'utf8'), /2000-01-01/);
});

test('a backup re-run the same day replaces its off-box copy, and the weekly follows it', () => {
  const src = join(backups, `coordinator-${day}.db`);
  const db = new DatabaseSync(src);
  db.exec("UPDATE projects SET name = 'Renamed'");
  db.close();
  utimesSync(src, new Date(), new Date(Date.now() + 60_000));
  run('offbox.sh');
  const daily = join(offbox, `coordinator-${day}.db`);
  assert.ok(readFileSync(daily).includes('Renamed'));
  const weekly = readdirSync(offbox).find((f) => f.startsWith('coordinator-weekly-'))!;
  assert.equal(statSync(join(offbox, weekly)).ino, statSync(daily).ino);
  assert.match(readFileSync(join(offbox, 'SHA256SUMS'), 'utf8'), new RegExp(`${sha(daily)}  coordinator-${day}`));
});

test('the backup key can list the set and fetch a file from it, and nothing else', () => {
  const list = serve('list');
  assert.equal(list.status, 0);
  assert.equal(list.stdout.toString(), readFileSync(join(offbox, 'SHA256SUMS'), 'utf8'));
  const got = serve(`get state-${day}.db`);
  assert.equal(got.status, 0);
  assert.ok(got.stdout.equals(readFileSync(join(offbox, `state-${day}.db`))));
  for (const bad of ['get ../coordinator.db', 'get coordinator.db', 'get SHA256SUMS', 'get coordinator-1999-01-01.db', `get state-${day}.db extra`, 'get', 'cat /etc/passwd', '']) {
    const r = serve(bad);
    assert.equal(r.status, 2, bad);
    assert.equal(r.stdout.length, 0, bad);
  }
});

// Contraptions' own nightly backups (#828): found through the registry and the backups/<day>/ convention.
const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() - i * 86_400_000)).map((d) => execFileSync('date', ['-d', d.toISOString(), '+%F'], { encoding: 'utf8' }).trim());
const register = (...names: string[]) => {
  const db = new DatabaseSync(join(root, 'coordinator.db'));
  const add = db.prepare("INSERT INTO contraptions (name, title, port, identity_public, identity_private, key_hash, keys_at, created_at) VALUES (?, ?, ?, '', '', ?, 0, 0)");
  names.forEach((n, i) => add.run(n, n, 7000 + i, `hash-${n}`));
  db.close();
};
const appDay = (app: string, d: string) => join(appsData, app, 'backups', d);

test("every registered app's newest nightly backups join the set as hard links, and nothing live or half-written does", () => {
  register('mandate', 'transdata', 'nobackups', 'late');
  const nine = days(9);
  for (const d of nine) {
    mkdirSync(appDay('mandate', d), { recursive: true });
    writeFileSync(join(appDay('mandate', d), '1.db'), `alice ${d}`);
    writeFileSync(join(appDay('mandate', d), '2.db'), `bob ${d}`);
  }
  const today = appDay('mandate', nine[0]);
  for (const junk of ['1.db-wal', '1.db-shm', '3.db.tmp', '.hidden', 'has space.db']) writeFileSync(join(today, junk), 'live');
  symlinkSync(join(root, 'coordinator.db'), join(today, 'sneaky.db'));
  mkdirSync(join(today, 'nested'));
  writeFileSync(join(appsData, 'mandate', 'users.db'), 'the live database, never copied');
  mkdirSync(join(appsData, 'transdata', 'backups'), { recursive: true }); // flat pre-change copies, no dated folders
  writeFileSync(join(appsData, 'transdata', 'backups', 'transdata-before-x.db'), 'x');
  mkdirSync(appDay('late', nine[1]), { recursive: true }); // its job runs after this one: newest is yesterday
  writeFileSync(join(appDay('late', nine[1]), 'late.db'), 'late');

  const out = run('offbox.sh');
  assert.match(out, /App backups: late \(1 files, 1 days\), mandate \(14 files, 7 days\)/);
  assert.match(out, new RegExp(`not from today.*late \\(newest ${nine[1]}\\)`));
  assert.match(out, /Apps with no nightly backups, skipped: nobackups, transdata, voice$/m); // voice: the audit fixture's app, at the top
  assert.deepEqual(readdirSync(join(offbox, 'apps')).sort(), ['late', 'mandate']);
  assert.deepEqual(readdirSync(join(offbox, 'apps', 'mandate')).sort(), nine.slice(0, 7).sort(), 'the newest 7 days');
  assert.deepEqual(readdirSync(join(offbox, 'apps', 'mandate', nine[0])).sort(), ['1.db', '2.db']);
  assert.equal(statSync(join(offbox, 'apps', 'mandate', nine[0], '1.db')).ino, statSync(join(today, '1.db')).ino, 'a hard link, no extra disk');
  const sums = readFileSync(join(offbox, 'SHA256SUMS'), 'utf8');
  for (const d of nine.slice(0, 7)) for (const f of ['1.db', '2.db']) {
    const rel = `apps/mandate/${d}/${f}`;
    assert.ok(sums.includes(`${sha(join(offbox, rel))}  ${rel}\n`), rel);
  }
  assert.doesNotMatch(sums, new RegExp(`${nine[7]}|wal|shm|tmp|hidden|sneaky|nested|transdata|users\\.db`));
});

test("an app's pruned day, or an app gone from the registry, leaves the set too", () => {
  const [newest, , , , , , seventh] = days(7);
  rmSync(appDay('mandate', newest), { recursive: true });
  const db = new DatabaseSync(join(root, 'coordinator.db'));
  db.exec("DELETE FROM contraptions WHERE name = 'late'");
  db.close();
  run('offbox.sh');
  assert.ok(!existsSync(join(offbox, 'apps', 'late')), 'its empty folders go too');
  assert.ok(!existsSync(join(offbox, 'apps', 'mandate', newest)));
  assert.ok(existsSync(join(offbox, 'apps', 'mandate', days(8)[7])), 'the next-newest day moves into the 7');
  assert.ok(existsSync(join(offbox, 'apps', 'mandate', seventh)));
  assert.doesNotMatch(readFileSync(join(offbox, 'SHA256SUMS'), 'utf8'), new RegExp(`apps/(late|mandate/${newest})/`));
  // Put today's back for the tests below.
  mkdirSync(appDay('mandate', newest));
  writeFileSync(join(appDay('mandate', newest), '1.db'), `alice ${newest}`);
  run('offbox.sh');
});

test("the backup key can fetch an app's backup, and only by a strict name", () => {
  const d = days(1)[0];
  const got = serve(`get apps/mandate/${d}/1.db`);
  assert.equal(got.status, 0);
  assert.equal(got.stdout.toString(), `alice ${d}`);
  symlinkSync(join(root, 'coordinator.db'), join(offbox, 'apps', 'mandate', d, 'planted.db'));
  for (const bad of [
    'get apps/../coordinator.db', `get apps/mandate/${d}/../../../coordinator.db`, `get apps/mandate/../mandate/${d}/1.db`, `get apps/mandate/${d}/..`,
    'get /etc/passwd', `get /apps/mandate/${d}/1.db`, `get apps/Mandate/${d}/1.db`, 'get apps/mandate/latest/1.db', `get apps/mandate/${d}/.hidden`,
    `get apps/mandate/${d}/1.db-wal`, `get apps/mandate/${d}`, `get apps/mandate/${d}/planted.db`, `get apps/mandate/${d}/sub/1.db`, `get apps/mandate/${d}/1.db x`,
  ]) {
    const r = serve(bad);
    assert.equal(r.status, 2, bad);
    assert.equal(r.stdout.length, 0, bad);
  }
  rmSync(join(offbox, 'apps', 'mandate', d, 'planted.db'));
});

test("every Android app's release key and its password go off-box under keys/ as mode-600 hard links, and nothing else in that folder does (#837)", () => {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  for (const [f, body] of [['twi-release.jks', 'twi keystore'], ['twi-release.pass', 'twi password'], ['voice-release.jks', 'voice keystore'], ['voice-release.pass', 'voice password'],
    ['mandate-google-services.json', 'not a key'], ['Bad_Name-release.jks', 'x'], ['twi-release.jks.bak', 'x'], ['.twi-tmp-release.pass', 'x']]) writeFileSync(join(keyDir, f), body, { mode: 0o600 });
  symlinkSync(join(root, 'coordinator.db'), join(keyDir, 'evil-release.jks'));
  mkdirSync(join(offbox, 'keys'), { recursive: true });
  writeFileSync(join(offbox, 'keys', 'stray-release.pass'), 'left from before');

  const out = run('offbox.sh');
  assert.match(out, /Release keys: 4 files/);
  const names = ['twi-release.jks', 'twi-release.pass', 'voice-release.jks', 'voice-release.pass'];
  assert.deepEqual(readdirSync(join(offbox, 'keys')).sort(), names);
  for (const f of names) {
    const st = statSync(join(offbox, 'keys', f));
    assert.equal(st.ino, statSync(join(keyDir, f)).ino, `${f}: a hard link`);
    assert.equal(st.mode & 0o777, 0o600, f);
  }
  const sums = readFileSync(join(offbox, 'SHA256SUMS'), 'utf8');
  for (const f of names) assert.ok(sums.includes(`${sha(join(keyDir, f))}  keys/${f}\n`), f);
  assert.doesNotMatch(sums, /google|Bad_Name|bak|tmp|evil|stray/);

  const got = serve('get keys/twi-release.pass');
  assert.equal(got.status, 0);
  assert.equal(got.stdout.toString(), 'twi password');
  for (const bad of ['get keys/../coordinator.db', 'get keys/mandate-google-services.json', 'get keys/Twi-release.jks', 'get keys/twi-release.jks x', 'get keys/twi-release.key',
    'get keys/sub/twi-release.jks', 'get /keys/twi-release.jks', 'get keys/evil-release.jks', 'get keys/stray-release.pass']) {
    const r = serve(bad);
    assert.equal(r.status, 2, bad);
    assert.equal(r.stdout.length, 0, bad);
  }

  // A key gone from perigee leaves the set; the key folder itself is never touched.
  const voice = readFileSync(join(keyDir, 'voice-release.jks'));
  rmSync(join(keyDir, 'voice-release.pass'));
  run('offbox.sh');
  assert.deepEqual(readdirSync(join(offbox, 'keys')).sort(), ['twi-release.jks', 'twi-release.pass', 'voice-release.jks']);
  assert.deepEqual(readFileSync(join(keyDir, 'voice-release.jks')), voice);
  assert.ok(existsSync(join(keyDir, 'mandate-google-services.json')));
  writeFileSync(join(keyDir, 'voice-release.pass'), 'voice password', { mode: 0o600 });
  run('offbox.sh');
});

// The desktop's pull script, run here in pwsh against the real serve script through a stand-in ssh.
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']);
test('the desktop pull fetches app backups into apps\\<app>\\<day>\\ and prunes each app to its days', { skip: pwsh.error ? 'no pwsh on PATH' : false, timeout: 120_000 }, () => {
  const ssh = join(root, 'fake-ssh');
  writeFileSync(ssh, `#!/usr/bin/env bash\nwhile [[ $1 != perigee ]]; do shift; done; shift\nSSH_ORIGINAL_COMMAND="$*" exec ${join(deploy, 'offbox-serve.sh')}\n`);
  chmodSync(ssh, 0o755);
  const dest = join(root, 'desktop');
  const old = join(dest, 'apps', 'mandate', '2000-01-01');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, '1.db'), 'old');
  const pull = () => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(deploy, 'desktop', 'citadel-pull.ps1'), '-Dest', dest, '-Remote', 'perigee', '-Ssh', ssh, '-Key', 'none', '-Dailies', '7'], { env, encoding: 'utf8' });
  const r = pull();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const line of readFileSync(join(offbox, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [hash, name] = line.split(/\s+/);
    assert.equal(sha(join(dest, name)), hash, name);
  }
  assert.ok(!existsSync(old), 'the app keeps only its newest 7 days');
  assert.match(r.stdout, /Pruned apps\/mandate\/2000-01-01/);
  assert.doesNotMatch(r.stdout, /Skipping unexpected/);
  const again = pull();
  assert.match(again.stdout, /Done: 0 new, 0 failed/, 'a second run fetches nothing');
  assert.equal(readFileSync(join(dest, 'keys', 'twi-release.pass'), 'utf8'), 'twi password', 'release keys come down to keys\\');

  // A release key perigee no longer matches is kept here and the run fails; one gone from perigee stays here.
  rmSync(join(keyDir, 'twi-release.pass'));
  writeFileSync(join(keyDir, 'twi-release.pass'), 'a different password', { mode: 0o600 });
  rmSync(join(keyDir, 'voice-release.jks'));
  run('offbox.sh');
  const changed = pull();
  assert.equal(changed.status, 1, changed.stdout);
  assert.match(changed.stdout, /FAILED keys\/twi-release\.pass: perigee's copy differs/);
  assert.equal(readFileSync(join(dest, 'keys', 'twi-release.pass'), 'utf8'), 'twi password');
  assert.equal(readFileSync(join(dest, 'keys', 'voice-release.jks'), 'utf8'), 'voice keystore', 'keys\\ is never pruned');
});
