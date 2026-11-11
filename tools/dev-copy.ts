// A dev copy of this checkout's Citadel for a minion to try a change on (#482), run by the
// citadel-dev-copy command every turn has on its PATH:
//   citadel-dev-copy start [--data copy|empty] | status | stop
// start: a fresh folder under $TMPDIR, the live database copied in read-only the way a preview copies
// it (or none), a free port, server.ts in preview mode (no turns, no pushes, no new minions), and it
// prints the URL, a sign-in and the pid. A second start replaces the first. stop: ends that pid, only
// that one, and removes the folder. Never by name: every turn and Citadel itself run as one account.
//
// Preview mode exits once its parent goes, so the server runs under a small sh that waits on it and
// exits with it; the Bash call that ran start returns at once, since neither holds its output.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freePort } from '../src/ports.ts';
import { copyData, previewEnv } from '../src/previews.ts';

const BOOT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 8000;
const USAGE = 'usage: citadel-dev-copy start [--data copy|empty] | status | stop';

interface State { pid: number; started: string; holder: number; port: number; url: string; login: string; password: string; cookie: string; data: string; worktree: string }

const say = (s: string) => console.log(s);
function refuse(why: string): never {
  console.error(`citadel-dev-copy: ${why}`);
  process.exit(2);
}

const worktree = resolve(import.meta.dirname, '..');
// The live server's data folder (server.ts DEFAULT_DATA_DIR); a test points it elsewhere.
const live = process.env.CITADEL_LIVE_DATA_DIR || join(homedir(), '.local/share/claude-coordinator');
if (!process.env.TMPDIR) refuse('$TMPDIR is not set: the copy goes in your own temp folder, never the shared /tmp');
const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
const home = join(real(process.env.TMPDIR), 'dev-copy');
const data = join(home, 'data');
const stateFile = join(home, 'state.json');
const logFile = join(home, 'server.log');
// stop deletes home and the server writes into data: neither may be, or hold, the live folder.
const liveReal = real(live);
if (liveReal === home || liveReal.startsWith(home + sep)) refuse(`the copy's folder ${home} would be or hold the live data folder ${liveReal}; set $TMPDIR to your own temp folder`);

/** A process's start time (field 22 of /proc/<pid>/stat), or null if it is gone or a zombie. */
function started(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch {
    return null;
  }
}

function readState(): State | null {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/** The recorded server, if that very process (same pid, same start time) still runs. */
const running = (s: State | null) => !!s && started(s.pid) === s.started;

async function waitGone(pid: number, start: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (started(pid) !== start) return true;
  return started(pid) !== start;
}

async function stop(quiet = false): Promise<void> {
  const s = readState();
  if (s && running(s)) {
    process.kill(s.pid, 'SIGTERM');
    if (!(await waitGone(s.pid, s.started, STOP_TIMEOUT_MS))) {
      if (started(s.pid) === s.started) process.kill(s.pid, 'SIGKILL');
      if (!(await waitGone(s.pid, s.started, 2000))) refuse(`pid ${s.pid} did not exit; ${home} is left as it is`);
    }
    // The sh holding it exits with it; give it a moment so nothing writes into the folder as it goes.
    const holder = started(s.holder);
    if (holder) await waitGone(s.holder, holder, 2000);
    if (!quiet) say(`Stopped the dev copy (pid ${s.pid}) and removed ${home}`);
  } else if (!quiet) say(existsSync(home) ? `No dev copy was running; removed ${home}` : 'No dev copy was running');
  rmSync(home, { recursive: true, force: true });
}

async function start(args: string[]): Promise<void> {
  let from = 'copy';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data' && ['copy', 'empty'].includes(args[i + 1])) from = args[++i];
    else if (/^--data=(copy|empty)$/.test(args[i])) from = args[i].slice(7);
    else refuse(USAGE);
  }
  const server = join(worktree, 'server.ts');
  if (!existsSync(server)) refuse(`${worktree} has no server.ts`);
  const liveDb = join(live, 'coordinator.db');
  if (from === 'copy' && !existsSync(liveDb)) refuse(`there is no live database at ${liveDb} to copy (a turn in a container can't see it): use --data empty`);

  await stop(true);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  if (from === 'copy') {
    const src = new DatabaseSync(liveDb, { readOnly: true });
    try {
      await copyData(src, join(data, 'coordinator.db'));
    } finally {
      src.close();
    }
  }

  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const pidFile = join(home, 'server.pid');
  const log = openSync(logFile, 'a');
  const holder = spawn('sh', ['-c', '"$0" "$1" & echo $! > "$2"; wait $!', process.execPath, server, pidFile], {
    cwd: worktree, env: previewEnv(port, data, password, randomBytes(32).toString('hex')), detached: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  holder.unref();
  const holderStart = started(holder.pid!);

  const url = `http://127.0.0.1:${port}/`;
  const fail = async (why: string): Promise<never> => {
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0;
    const pidStart = pid ? started(pid) : null;
    if (pidStart) {
      process.kill(pid, 'SIGKILL');
      await waitGone(pid, pidStart, 2000);
    }
    if (holderStart) await waitGone(holder.pid!, holderStart, 2000);
    const out = readFileSync(logFile, 'utf8').slice(-3000);
    rmSync(home, { recursive: true, force: true });
    return refuse(`${why}${out ? `\n--- server output ---\n${out}` : ''}`);
  };
  for (const deadline = Date.now() + BOOT_TIMEOUT_MS; ; await new Promise((r) => setTimeout(r, 200))) {
    if (!started(holder.pid!)) await fail('the server exited during boot');
    if (Date.now() > deadline) await fail(`the server did not answer within ${BOOT_TIMEOUT_MS / 1000} s`);
    const health = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null), () => null);
    if (!health) continue;
    if (health.preview !== true) await fail('this branch\'s server has no preview mode; rebase it onto main first');
    break;
  }

  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  const db = new DatabaseSync(join(data, 'coordinator.db'), { readOnly: true });
  const admin = db.prepare('SELECT login FROM users WHERE admin = 1 AND disabled_at IS NULL ORDER BY id LIMIT 1').get() as { login: string } | undefined;
  db.close();
  const login = admin?.login ?? '';
  const res = await fetch(`${url}api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }), signal: AbortSignal.timeout(10_000) }).catch(() => fail('the copy did not answer the sign-in'));
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!res.ok || !cookie) await fail(`signing in as ${login || '(no admin)'} on the copy failed (${res.status})`);

  const s: State = { pid, started: started(pid)!, holder: holder.pid!, port, url, login, password, cookie, data, worktree };
  writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  say(`Dev copy running from ${worktree}, on ${from === 'copy' ? 'a copy of the live data' : 'empty data'}; turns are off.`);
  print(s);
}

function print(s: State) {
  say(`  URL:     ${s.url}`);
  say(`  Sign in: login ${s.login}, password ${s.password}`);
  say(`  Cookie:  ${s.cookie}   (already signed in: curl -b, or a headless browser's cookie for 127.0.0.1)`);
  say(`  Port:    ${s.port}`);
  say(`  pid:     ${s.pid}   (citadel-dev-copy stop ends it)`);
  say(`  Data:    ${s.data}`);
  say(`  Log:     ${logFile}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'start') await start(rest);
else if (cmd === 'stop' && !rest.length) await stop();
else if (cmd === 'status' && !rest.length) {
  const s = readState();
  if (running(s)) {
    say(`Dev copy running from ${s!.worktree}:`);
    print(s!);
  } else {
    say(s ? `The dev copy's server (pid ${s.pid}) has exited; citadel-dev-copy stop removes ${home}` : 'No dev copy is running');
    process.exitCode = 1;
  }
} else refuse(USAGE);
