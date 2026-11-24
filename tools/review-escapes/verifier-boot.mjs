// Boots one verifier case's Citadel, as it shipped, the way a preview runs (#1740): its own clone's server.ts, empty
// data in this case's folder, preview mode (no turns, no pushes, no new minions), a free port, signed in as the admin.
// run.ts copies it into each case's folder; the verifier runs it from there:
//   node boot.mjs start [--fresh]   start (again, replacing the last); --fresh empties the data first. Prints DEV_URL etc.
//   node boot.mjs stop              stop it (by its process group, never by name)
//   node boot.mjs status
// It writes dev.env (DEV_URL, DEV_COOKIE, DEV_LOGIN, DEV_PASSWORD, DEV_DATA, DEV_PID) for `set -a; . ./dev.env`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = import.meta.dirname;
const repo = join(ROOT, 'repo');
const data = join(ROOT, 'data');
const stateFile = join(ROOT, 'boot.json');
const envFile = join(ROOT, 'dev.env');
const shims = join(ROOT, 'shims');
const [cmd, ...rest] = process.argv.slice(2);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function stop() {
  if (!existsSync(stateFile)) return console.log('not running');
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  try { process.kill(-s.pgid, 'SIGTERM'); } catch { /* gone */ }
  rmSync(stateFile, { force: true });
  console.log(`stopped process group ${s.pgid}`);
}

const free = () => new Promise((done) => {
  const port = 20000 + Math.floor(Math.random() * 12000);
  const srv = createServer().once('error', () => done(free())).listen(port, '127.0.0.1', () => srv.close(() => done(port)));
});

async function start() {
  if (existsSync(stateFile)) stop();
  if (rest.includes('--fresh')) rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const port = await free();
  const password = randomBytes(16).toString('hex');
  const log = openSync(join(ROOT, 'server.log'), 'a');
  // As src/previews.ts's previewEnv, plus shims that refuse systemctl, gh, podman and the like, so old code can't reach the box.
  const env = {
    PATH: `${shims}:${process.env.PATH}`, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: join(ROOT, 'tmp'),
    HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, PREVIEW: '1', BOOT_CHECK: '1', CLAUDE_BIN: '/bin/false',
    CLAUDE_CONFIG_DIR: join(data, 'claude'), COORDINATOR_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex'),
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  // Preview mode exits when its parent goes, so a small sh holds it; detached makes it one process group to stop.
  const holder = spawn('sh', ['-c', '"$0" server.ts & wait $!', process.execPath], { cwd: repo, env, detached: true, stdio: ['ignore', log, log] });
  holder.unref();
  const url = `http://127.0.0.1:${port}/`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (!alive(holder.pid)) break;
  }
  writeFileSync(stateFile, JSON.stringify({ pgid: holder.pid, port }));
  if (!up) { console.log(`server did not come up on ${url}; tail of server.log:\n${readFileSync(join(ROOT, 'server.log'), 'utf8').slice(-1500)}`); process.exit(1); }
  let login = '';
  try {
    const db = new DatabaseSync(join(data, 'coordinator.db'), { readOnly: true });
    login = db.prepare('SELECT login FROM users WHERE admin = 1 ORDER BY id LIMIT 1').get()?.login ?? '';
    db.close();
  } catch { /* an old schema: sign in with the password alone */ }
  const res = await fetch(`${url}api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const vars = { DEV_URL: url, DEV_PORT: port, DEV_COOKIE: cookie, DEV_LOGIN: login, DEV_PASSWORD: password, DEV_DATA: data, DEV_PID: holder.pid };
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n');
  console.log(`Citadel as shipped, running on ${url} (preview mode: no turns), data in ${data}, log in ${join(ROOT, 'server.log')}`);
  console.log(`Signed in as ${login || '(no admin login found)'}: ${res.status} ${cookie ? 'cookie in dev.env' : 'NO COOKIE'}`);
  console.log(`For a script: set -a; . ${envFile}; set +a   (curl -H "Cookie: $DEV_COOKIE" "$DEV_URL"api/...)`);
}

if (cmd === 'start') await start();
else if (cmd === 'stop') stop();
else if (cmd === 'status') console.log(existsSync(stateFile) && alive(JSON.parse(readFileSync(stateFile, 'utf8')).pgid) ? readFileSync(envFile, 'utf8') : 'not running');
else console.log('usage: node boot.mjs start [--fresh] | stop | status');
