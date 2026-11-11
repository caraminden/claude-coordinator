import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

// citadel-dev-copy (#482): a dev copy of this checkout, started, replaced and stopped by its own pid.
const repo = join(import.meta.dirname, '..');
const cmd = join(repo, 'tools', 'citadel-dev-copy');
const root = mkdtempSync(join(tmpdir(), 'dev-copy-'));
const live = join(root, 'live');
const tmp = join(root, 'tmp');
mkdirSync(tmp);
const env = { ...process.env, TMPDIR: tmp, CITADEL_LIVE_DATA_DIR: live };
const run = (args: string[], over: NodeJS.ProcessEnv = {}) => spawnSync(cmd, args, { cwd: repo, env: { ...env, ...over }, encoding: 'utf8', timeout: 60_000 });
const state = () => JSON.parse(readFileSync(join(tmp, 'dev-copy', 'state.json'), 'utf8'));
const alive = (pid: number) => existsSync(`/proc/${pid}`) && !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
const seen: number[] = [];
after(() => {
  run(['stop']);
  // Whatever a failed assertion left running; never a pid the test didn't start.
  for (const pid of seen) if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

// A "live" database with an admin, to copy.
mkdirSync(live);
const store = new Store(join(live, 'coordinator.db'));
store.createUser({ name: 'Robin', login: 'robin', admin: true, server_login: true });
store.db.close();

test('start, status, a second start that replaces the first, then stop leaves nothing running', async () => {
  const first = run(['start', '--data', 'empty']);
  assert.equal(first.status, 0, first.stderr);
  const a = state();
  seen.push(a.pid, a.holder);
  assert.match(first.stdout, new RegExp(`URL: +http://127\\.0\\.0\\.1:${a.port}/`));
  assert.match(first.stdout, /Sign in: login cara, password [0-9a-f]{32}/);
  assert.ok(a.port >= 1024 && a.port <= 32767 && (a.port < 8000 || a.port > 8999), `port ${a.port}`);
  assert.ok(alive(a.pid) && alive(a.holder));
  // Preview mode, signed in with the cookie it printed.
  assert.equal((await (await fetch(`${a.url}api/health`)).json()).preview, true);
  assert.equal((await fetch(`${a.url}api/me`, { headers: { cookie: a.cookie } })).status, 200);

  const status = run(['status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, new RegExp(`pid: +${a.pid}`));

  const second = run(['start']);
  assert.equal(second.status, 0, second.stderr);
  const b = state();
  seen.push(b.pid, b.holder);
  assert.ok(!alive(a.pid) && !alive(a.holder), 'the first copy stopped');
  assert.notEqual(b.pid, a.pid);
  // A copy of the live data, signed in as its admin.
  assert.match(second.stdout, /on a copy of the live data/);
  assert.match(second.stdout, /Sign in: login robin,/);
  assert.equal((await fetch(`${b.url}api/me`, { headers: { cookie: b.cookie } })).status, 200);

  const stop = run(['stop']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, new RegExp(`Stopped the dev copy \\(pid ${b.pid}\\)`));
  assert.ok(!alive(b.pid) && !alive(b.holder), 'nothing left running');
  assert.ok(!existsSync(join(tmp, 'dev-copy')), 'its folder is gone');
  assert.equal(run(['status']).status, 1);
  assert.match(run(['stop']).stdout, /No dev copy was running/);
});

test('it refuses a folder that would be or hold the live data folder, and a missing $TMPDIR', () => {
  for (const over of [{ CITADEL_LIVE_DATA_DIR: join(tmp, 'dev-copy', 'data') }, { CITADEL_LIVE_DATA_DIR: join(tmp, 'dev-copy') }, { TMPDIR: '' }]) {
    const r = run(['start', '--data', 'empty'], over);
    assert.equal(r.status, 2, JSON.stringify(over));
    assert.match(r.stderr, /live data folder|\$TMPDIR is not set/);
    assert.ok(!existsSync(join(tmp, 'dev-copy')), 'nothing was made');
  }
});

test('it refuses unknown arguments and a copy with no live database', () => {
  assert.equal(run(['start', '--data', 'some']).status, 2);
  assert.equal(run(['restart']).status, 2);
  const r = run(['start'], { CITADEL_LIVE_DATA_DIR: join(root, 'nowhere') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /use --data empty/);
});

test('a copy finishes while the live server keeps writing', async () => {
  // Bigger than one backup() step (100 pages), so a restart on every write would never end (#529).
  const db = new DatabaseSync(join(live, 'coordinator.db'));
  db.exec("INSERT INTO settings (key, value) VALUES ('turn:529', '{}')");
  db.exec('CREATE TABLE filler (b BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO filler SELECT randomblob(4000) FROM n');
  db.close();
  const writer = spawn(process.execPath, ['-e', `
    const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = OFF');
    const put = db.prepare('INSERT INTO filler VALUES (randomblob(100))');
    process.stdout.write('writing\\n');
    for (;;) put.run();`, join(live, 'coordinator.db')], { stdio: ['ignore', 'pipe', 'inherit'] });
  seen.push(writer.pid!);
  try {
    await new Promise((ok) => writer.stdout!.once('data', ok));
    const r = spawnSync(cmd, ['start'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `start did not finish: ${r.error ?? r.stderr}`);
    const s = state();
    seen.push(s.pid, s.holder);
    assert.match(r.stdout, /on a copy of the live data/);
    // The copy is whole: every filler row made before the writer started is in it.
    const copy = new DatabaseSync(join(tmp, 'dev-copy', 'data', 'coordinator.db'), { readOnly: true });
    assert.ok((copy.prepare('SELECT count(*) AS n FROM filler').get() as { n: number }).n >= 2000);
    assert.equal(copy.prepare("SELECT 1 FROM settings WHERE key = 'turn:529'").get(), undefined, 'scrubbed as a preview copy is');
    copy.close();
  } finally {
    writer.kill('SIGKILL');
    run(['stop']);
  }
});
