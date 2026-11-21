// #850 (fcc15008): the backup's audit probe fails closed. A sqlite3 that errors on the sqlite_master probe used to read as
// "no audit table" and skip the strip, so the copy kept players' words. Now an erroring probe falls through to the DELETE.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'offbox-probe-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a sqlite3 that errors on the audit probe still gets the audit stripped from the backup', () => {
  const data = join(root, 'data');
  mkdirSync(data);
  const store = new Store(join(data, 'coordinator.db'));
  const project = store.createProject('Demo', null);
  store.createTicket({ project_id: project.id, title: 't', permission_mode: 'default', created_by: 't' });
  const user = store.createUser({ name: 'Josh', login: 'josh' });
  const app = store.createContraption({ name: 'voice', title: 'Voice', icon: null, port: 9, home_scheme: project.id, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
  const WORDS = 'a-player-said-this-in-a-turn';
  store.putTurnAudit(store.startContraptionTurn(app.id, user.id, 's1'), { model: null, blind: false, images: 0, system: 'sys', prompt: WORDS, output: 'reply' });
  store.db.close();

  // A sqlite3 in front of the real one that fails any statement reading sqlite_master.
  const real = execFileSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sqlite3'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *sqlite_master*) echo "Error: database disk image is malformed" >&2; exit 1;; esac; done\nexec ${real} "$@"\n`);
  chmodSync(join(bin, 'sqlite3'), 0o755);

  const r = spawnSync(join(import.meta.dirname, '..', 'deploy', 'backup.sh'), { env: { ...process.env, DATA_DIR: data, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  const copy = readdirSync(join(data, 'backups')).find((f) => /^coordinator-\d{4}-\d\d-\d\d\.db$/.test(f));
  assert.ok(copy, `the daily copy was made: ${r.stderr}`);
  const file = join(data, 'backups', copy);
  assert.ok(!readFileSync(file).includes(WORDS), 'no trace of the players\' words in the copy');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM contraption_turn_audit').get() as { n: number }).n, 0, 'the copy holds no turn audit');
  } finally {
    db.close();
  }
});
