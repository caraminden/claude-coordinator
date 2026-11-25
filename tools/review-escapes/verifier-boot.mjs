// Boots one verifier case's Citadel, as it shipped (#1740): its own clone's server.ts, data in this case's folder, a free
// port, signed in as the admin. run.ts copies it into each case's folder; the verifier runs it from there:
//   node boot.mjs start [--fresh] [--turns] [--clock <iso>]
//        start (again, replacing the last); --fresh empties the data first. Without --turns it runs as a preview does (no
//        turns, no new schemes or minions). --turns runs it as a real server whose turns run fake-claude.mjs (scripted
//        through fake/turns.jsonl), with HOME in this folder and the box's services stubbed. --clock starts its clock there.
//   node boot.mjs restart           stop and start again on the same data, logins, mode and clock (turns keep running,
//                                   as they do across a real restart)
//   node boot.mjs person <login>    add a person and sign them in: DEV_COOKIE_<LOGIN> in dev.env
//   node boot.mjs stop              stop it (by its process group, never by name)
//   node boot.mjs status
// It writes dev.env (DEV_URL, DEV_COOKIE, DEV_LOGIN, DEV_PASSWORD, DEV_DATA, DEV_PID) for `set -a; . ./dev.env`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = import.meta.dirname;
const repo = join(ROOT, 'repo');
const data = join(ROOT, 'data');
const stateFile = join(ROOT, 'boot.json');
const envFile = join(ROOT, 'dev.env');
const shims = join(ROOT, 'shims');
// The admin's password and the cookie secret, kept so a restart signs the same people in.
const keysFile = join(ROOT, 'boot-keys.json');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function stop() {
  if (!existsSync(stateFile)) return console.log('not running');
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  try {
    process.kill(-s.pgid, 'SIGTERM');
  } catch {
    /* gone */
  }
  // Gone before a restart opens the same database and port.
  for (let i = 0; i < 40 && alive(s.pgid); i++) await sleep(250);
  if (alive(s.pgid))
    try {
      process.kill(-s.pgid, 'SIGKILL');
    } catch {
      /* gone */
    }
  rmSync(stateFile, { force: true });
  console.log(`stopped process group ${s.pgid}`);
  return s;
}

const free = () =>
  new Promise((done) => {
    const port = 20000 + Math.floor(Math.random() * 12000);
    const srv = createServer()
      .once('error', () => done(free()))
      .listen(port, '127.0.0.1', () => srv.close(() => done(port)));
  });

/** The offset --clock asks for, in ms from now. */
const clockOffset = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    console.log(`--clock ${iso}: not a date (try 2026-11-24T23:59:30-08:00)`);
    process.exit(1);
  }
  return t - Date.now();
};

async function start(mode = { turns: rest.includes('--turns'), clock: opt('--clock'), offset: opt('--clock') ? clockOffset(opt('--clock')) : 0 }) {
  if (existsSync(stateFile)) await stop();
  if (rest.includes('--fresh')) rmSync(data, { recursive: true, force: true });
  if (rest.includes('--fresh') || !existsSync(keysFile)) writeFileSync(keysFile, JSON.stringify({ password: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex') }));
  const { password, secret } = JSON.parse(readFileSync(keysFile, 'utf8'));
  mkdirSync(data, { recursive: true });
  const port = await free();
  const log = openSync(join(ROOT, 'server.log'), 'a');
  // As src/previews.ts's previewEnv, plus shims that refuse systemctl, gh, podman and the like, so old code can't reach the box.
  const env = {
    PATH: `${shims}:${process.env.PATH}`,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TMPDIR: join(ROOT, 'tmp'),
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: data,
    PREVIEW: '1',
    BOOT_CHECK: '1',
    CLAUDE_BIN: '/bin/false',
    CLAUDE_CONFIG_DIR: join(data, 'claude'),
    COORDINATOR_PASSWORD: password,
    SESSION_SECRET: secret,
  };
  if (mode.turns) {
    // As test/helpers.ts's bootServer: a real server, kept off the box's services, the embedding service and the live
    // Citadel; its home in this folder, so nothing it writes under ~ lands in the real one.
    const home = join(ROOT, 'home');
    mkdirSync(home, { recursive: true });
    if (!existsSync(join(home, '.gitconfig'))) writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Verifier\n\temail = verifier@example.invalid\n[init]\n\tdefaultBranch = main\n');
    delete env.PREVIEW;
    delete env.BOOT_CHECK;
    Object.assign(env, {
      HOME: home,
      CLAUDE_BIN: join(ROOT, 'fake-claude.mjs'),
      FAKE_CLAUDE_DIR: join(ROOT, 'fake'),
      MACHINES_URL: '',
      CITADEL_MEMORY_SCHEMES: '0',
      TURN_POOL: '0',
      CITADEL_HOST_SIGNALS: 'fixed',
      GH_HELPER: '0',
      CITADEL_ZONE: 'America/Los_Angeles',
    });
    mkdirSync(env.FAKE_CLAUDE_DIR, { recursive: true });
    // Turns don't inherit NODE_OPTIONS, so the fake reads the clock's offset from here.
    writeFileSync(join(env.FAKE_CLAUDE_DIR, 'clock-offset'), String(mode.offset ?? 0));
  }
  // Its turns and tool servers inherit NODE_OPTIONS, so they keep the same time.
  if (mode.offset) Object.assign(env, { VERIFIER_CLOCK_OFFSET_MS: String(mode.offset), NODE_OPTIONS: `--import=${join(ROOT, 'clock.mjs')}` });
  mkdirSync(env.TMPDIR, { recursive: true });
  // Preview mode exits when its parent goes, so a small sh holds it; detached makes it one process group to stop.
  const holder = spawn('sh', ['-c', '"$0" server.ts & wait $!', process.execPath], { cwd: repo, env, detached: true, stdio: ['ignore', log, log] });
  holder.unref();
  const url = `http://127.0.0.1:${port}/`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    );
    if (!alive(holder.pid)) break;
  }
  writeFileSync(stateFile, JSON.stringify({ pgid: holder.pid, port, mode }));
  if (!up) {
    console.log(`server did not come up on ${url}; tail of server.log:\n${readFileSync(join(ROOT, 'server.log'), 'utf8').slice(-1500)}`);
    process.exit(1);
  }
  const login = dbGet('SELECT login FROM users WHERE admin = 1 ORDER BY id LIMIT 1')?.login ?? '';
  const cookie = await signIn(url, login, password);
  // A restart keeps the other people's cookies (same secret), so their lines stay.
  const kept = existsSync(envFile)
    ? readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('DEV_COOKIE_'))
    : [];
  const vars = { DEV_URL: url, DEV_PORT: port, DEV_COOKIE: cookie, DEV_LOGIN: login, DEV_PASSWORD: password, DEV_DATA: data, DEV_PID: holder.pid };
  writeFileSync(envFile, [...Object.entries(vars).map(([k, v]) => `${k}='${v}'`), ...kept].join('\n') + '\n');
  console.log(
    `Citadel as shipped, running on ${url} (${mode.turns ? `real turns on the fake claude: script them in ${join(ROOT, 'fake/turns.jsonl')}, see what they got in fake/calls.jsonl` : 'preview mode: no turns'}${mode.clock ? `, clock starting at ${mode.clock}` : ''}), data in ${data}, log in ${join(ROOT, 'server.log')}`,
  );
  console.log(`Signed in as ${login || '(no admin login found)'}: ${cookie ? 'cookie in dev.env' : 'NO COOKIE'}`);
  console.log(`For a script: set -a; . ${envFile}; set +a   (curl -H "Cookie: $DEV_COOKIE" "$DEV_URL"api/...)`);
}

function dbGet(sql, ...params) {
  try {
    const db = new DatabaseSync(join(data, 'coordinator.db'), { readOnly: true });
    try {
      return db.prepare(sql).get(...params);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  } // an old schema
}

async function signIn(url, login, password) {
  const res = await fetch(`${url}api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Adds a person through the admin's API and signs them in, the way their invite link would. */
async function person(login) {
  if (!login) {
    console.log('usage: node boot.mjs person <login>');
    process.exit(1);
  }
  const v = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 2, -1)]),
  );
  const h = { 'content-type': 'application/json', cookie: v.DEV_COOKIE };
  const made = await fetch(`${v.DEV_URL}api/people`, { method: 'POST', headers: h, body: JSON.stringify({ name: login, login }) });
  const body = await made.json().catch(() => ({}));
  if (!made.ok) {
    console.log(`POST /api/people: ${made.status} ${JSON.stringify(body)} (read this clone's src/routes for how people were added then)`);
    process.exit(1);
  }
  const password = randomBytes(12).toString('hex');
  // The invite page's own call: its token sets the password.
  const set = await fetch(`${v.DEV_URL}api/invite/${body.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!set.ok) {
    console.log(`setting ${login}'s password: ${set.status} ${await set.text()} (token ${body.token}; read this clone's invite route)`);
    process.exit(1);
  }
  const cookie = await signIn(v.DEV_URL, login, password);
  const key = `DEV_COOKIE_${login.toUpperCase().replace(/\W/g, '_')}`;
  writeFileSync(
    envFile,
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith(key + '='))
      .concat(`${key}='${cookie}'`, `${key.replace('COOKIE', 'PASSWORD')}='${password}'`)
      .join('\n') + '\n',
  );
  console.log(`${login} added (id ${body.person?.id}) and signed in: ${cookie ? `${key} in dev.env` : 'NO COOKIE'}`);
}

if (cmd === 'start') await start();
else if (cmd === 'restart') {
  const s = await stop();
  await start(s?.mode);
} else if (cmd === 'person') await person(rest[0]);
else if (cmd === 'stop') await stop();
else if (cmd === 'status') console.log(existsSync(stateFile) && alive(JSON.parse(readFileSync(stateFile, 'utf8')).pgid) ? readFileSync(envFile, 'utf8') : 'not running');
else console.log('usage: node boot.mjs start [--fresh] [--turns] [--clock <iso>] | restart | person <login> | stop | status');
