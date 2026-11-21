// deploy/offbox.sh (#828 review fix): one app backup file it can't read is left out and named on stderr; the
// run still exits 0 and ships Citadel's own set and the app's other files.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'offbox-unreadable-'));
// The app's data lives on another filesystem than DATA_DIR where there is one (/dev/shm): a hard link then
// fails and the copy is what reads the file, as it does on perigee when an app's folder is elsewhere.
const shm = existsSync('/dev/shm') && statSync('/dev/shm').dev !== statSync(root).dev ? mkdtempSync('/dev/shm/offbox-unreadable-') : null;
const appsData = shm ?? join(root, 'apps-data');
after(() => {
  rmSync(root, { recursive: true, force: true });
  if (shm) rmSync(shm, { recursive: true, force: true });
});

const day = spawnSync('date', ['+%F'], { encoding: 'utf8' }).stdout.trim();
const store = new Store(join(root, 'coordinator.db'));
store.createContraption({ name: 'mandate', title: 'Mandate', icon: null, port: 9, home_scheme: null, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
store.createContraption({ name: 'peek', title: 'Peek', icon: null, port: 10, home_scheme: null, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h2', keys_at: 0 });
store.db.close();
// Citadel's own nightly backup: any SQLite file will do.
mkdirSync(join(root, 'backups'));
const daily = new Store(join(root, 'backups', `coordinator-${day}.db`));
daily.db.close();

const dayDir = (app: string) => join(appsData, app, 'backups', day);
for (const app of ['mandate', 'peek']) mkdirSync(dayDir(app), { recursive: true });
writeFileSync(join(dayDir('mandate'), 'good.db'), 'readable');
writeFileSync(join(dayDir('mandate'), 'locked.db'), 'unreadable');
writeFileSync(join(dayDir('peek'), 'peek.db'), 'another app');
chmodSync(join(dayDir('mandate'), 'locked.db'), 0o000);

test('an app backup the script cannot read is left out and named, and everything else still ships (#828)', (t) => {
  if (!shm) return t.skip('no second filesystem to make the hard link fail');
  try {
    readFileSync(join(dayDir('mandate'), 'locked.db'));
    return t.skip('chmod 000 does not block reads for this user (root?)');
  } catch {}
  const r = spawnSync(join(import.meta.dirname, '..', 'deploy', 'offbox.sh'), { env: { ...process.env, DATA_DIR: root, APPS_DATA: appsData, KEY_DIR: join(root, 'keys') }, encoding: 'utf8' });
  assert.equal(r.status, 0, `exit status; stderr: ${r.stderr}`);
  assert.match(r.stderr, /couldn't link or copy apps\/mandate\/[0-9-]+\/locked\.db, left out/);
  const offbox = join(root, 'offbox');
  assert.ok(existsSync(join(offbox, `coordinator-${day}.db`)), "Citadel's own set shipped");
  assert.deepEqual(readdirSync(join(offbox, 'apps', 'mandate', day)), ['good.db'], 'the readable file shipped, the locked one did not');
  assert.deepEqual(readdirSync(join(offbox, 'apps', 'peek', day)), ['peek.db'], "another app's file shipped");
  const sums = readFileSync(join(offbox, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /apps\/peek\/.*peek\.db/);
  assert.doesNotMatch(sums, /locked\.db/);
});
