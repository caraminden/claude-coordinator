// The off-box copy set (#252): deploy/offbox.sh, run by backup.sh, and deploy/offbox-serve.sh, the only
// command the desktop's backup key can run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'offbox-'));
after(() => rmSync(root, { recursive: true, force: true }));

const deploy = join(import.meta.dirname, '..', 'deploy');
const env = { ...process.env, DATA_DIR: root };
const run = (script: string) => execFileSync(join(deploy, script), { env, encoding: 'utf8' });
const serve = (command: string) => spawnSync(join(deploy, 'offbox-serve.sh'), { env: { ...env, SSH_ORIGINAL_COMMAND: command } });
const backups = join(root, 'backups');
const offbox = join(root, 'offbox');
const day = execFileSync('date', ['+%F'], { encoding: 'utf8' }).trim();
const GITHUB_SECRET = 'v1:github-token-that-must-not-leave-perigee';

const store = new Store(join(root, 'coordinator.db'));
const project = store.createProject('Demo', null);
store.createTicket({ project_id: project.id, title: 't', permission_mode: 'default', created_by: 't' });
const user = store.createUser({ name: 'Josh', login: 'josh' });
store.putCredential(user.id, 'github', GITHUB_SECRET, { login: 'josh-gh' });
store.putCredential(user.id, 'claude_runner', 'citadel-claude-2', { container: 'citadel-claude-2' });
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
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('the nightly backup also writes the off-box set, with linked-account secrets stripped', () => {
  assert.match(run('backup.sh'), /Off-box set: 3 files/);
  assert.deepEqual(readdirSync(offbox).sort(), [`coordinator-${day}.db`, readdirSync(backups).find((f) => f.startsWith('coordinator-weekly-'))!, 'SHA256SUMS', `state-${day}.db`].sort());
  const daily = join(offbox, `coordinator-${day}.db`);
  assert.deepEqual(kinds(daily), ['claude_runner'], 'only the claude_runner row, which holds no secret, stays');
  assert.ok(!readFileSync(daily).includes(GITHUB_SECRET), 'VACUUM leaves no trace of the stripped rows');
  assert.deepEqual(kinds(join(backups, `coordinator-${day}.db`)), ['claude_runner', 'github'], 'the backup on perigee keeps everything');
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
