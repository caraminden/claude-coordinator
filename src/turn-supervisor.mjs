// The shared turn supervisor (#1343): one long-lived process per turns folder and code version that starts each host
// turn's `claude -p` in place of a node wrapper of its own per turn (src/turn-wrapper.mjs, about 21 MB each). The runner
// (src/supervisor-client.ts) starts it in a unit of its own and hands it turns over HTTP on 127.0.0.1; anything it can't
// reach or that doesn't answer in time gets the per-turn wrapper as before, so a turn never waits on it.
//
// Each turn still runs in a scope of its own (`systemd-run --scope`, in the turns or Taskmasters slice), so it keeps its
// own memory group: oomd, MemoryHigh and Stop act on it alone, as on a wrapper unit. Inside the scope a small shell
// (turn-run.mjs SHIM) runs claude and records its exit, so a supervisor that dies mid-turn loses nothing but the turn's
// stdin: claude finishes the turn it is on (it handles what was sent before stdin closed), its reply is recorded, and
// steers sent meanwhile stay past steer.sent, which the runner queues for the next turn. A restarted supervisor adopts
// the turns left running (their beat and their shared tool server registration) from pid.json and /proc.
//
// Arguments: the supervisor's folder (<turns>/.supervisor/<version>, holding these files' copies and supervisor.json)
// and its version. Plain JS, like the wrapper: a .ts file makes node load its type stripper.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { SHIM, claimSpec, feeder, keepPooled, prepare, put } from './turn-run.mjs';

const [home, version] = process.argv.slice(2);
const turnsDir = dirname(dirname(home));
const key = randomBytes(24).toString('hex');
/** Idle this long with no turns, it exits; much sooner once a newer version's supervisor runs. */
const IDLE_MS = Number(process.env.CITADEL_SUPERVISOR_IDLE_MS) || 30 * 60_000;
const SUPERSEDED_IDLE_MS = 60_000;
/** How often it looks for turns a supervisor that died left running. */
const ADOPT_EVERY_MS = Number(process.env.CITADEL_SUPERVISOR_ADOPT_MS) || 15_000;

/**
 * One turn it runs. `feed` steers claude's stdin until the reply is out; an adopted turn has none (its stdin went
 * with the supervisor that started it) and is watched by pid instead of by its child's exit.
 * @typedef {{ dir: string, pid: number | null, pooled: import('./turn-run.mjs').PoolTurn | null, feed: (() => boolean) | null, adopted: boolean, busy?: boolean }} Turn
 */
/** @type {Map<string, Turn>} */
const turns = new Map();
let idleSince = Date.now();
let closing = false;

/** @param {Turn} t */
function forget(t) {
  turns.delete(t.dir);
  if (!turns.size) idleSince = Date.now();
}

/** Write a turn's file unless its folder is gone (the runner finished the turn). @param {string} dir @param {string} name @param {string} data */
function putIfThere(dir, name, data) {
  try {
    if (existsSync(dir)) put(dir, name, data);
  } catch {}
}

/** @param {Turn} t @param {string} command @param {Error} err */
function failed(t, command, err) {
  try {
    appendFileSync(join(t.dir, 'stderr.log'), `Could not start ${command}: ${err.message}\n`);
  } catch {}
  putIfThere(t.dir, 'exit.json', JSON.stringify({ code: null, signal: null, error: err.message }));
  forget(t);
}

/**
 * Start the turn's shell, in its own scope when `scope` (systemd-run's arguments) is given. A scope that won't start
 * (the shell never ran: no pid.json) runs the turn without one, as the runner runs a turn whose unit won't start.
 * @param {Turn} t @param {import('./turn-run.mjs').TurnSpec} spec @param {string[]} scope
 */
function start(t, spec, scope) {
  const dir = t.dir;
  const shell = ['/bin/sh', '-c', SHIM, dir, String(process.pid), spec.command, ...spec.args];
  // Unexpanded: systemd-run reads `$$` and `${...}` in a command as its own (the shell's `$$` would arrive as `$`).
  const argv = scope.length ? ['systemd-run', ...scope, '--expand-environment=no', '--', ...shell] : shell;
  let out = -1;
  let err = -1;
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  try {
    out = openSync(join(dir, 'stream.jsonl'), 'a');
    err = openSync(join(dir, 'stderr.log'), 'a');
    // The env is exactly the runner's allowlist (turnEnv); systemd-run runs the shell in place, with it.
    child = /** @type {any} */ (spawn(argv[0], argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', out, err] }));
  } catch (e) {
    return failed(t, spec.command, /** @type {Error} */ (e));
  } finally {
    if (out >= 0) closeSync(out);
    if (err >= 0) closeSync(err);
  }
  let over = false;
  /** @param {string} why */
  const unscoped = (why) => {
    try {
      appendFileSync(join(dir, 'stderr.log'), `This turn's own memory group didn't start (${why}); it runs in the turn supervisor's.\n`);
    } catch {}
    start(t, spec, []);
  };
  child.on('error', (e) => {
    if (over) return;
    over = true;
    if (scope.length && existsSync(dir) && !existsSync(join(dir, 'pid.json'))) unscoped(e.message);
    else failed(t, spec.command, e);
  });
  child.on('exit', (code, signal) => {
    if (over) return;
    over = true;
    if (scope.length && signal === null && existsSync(dir) && !existsSync(join(dir, 'pid.json')) && !existsSync(join(dir, 'exit.json'))) return unscoped(`systemd-run exited ${code}`);
    // The shell records claude's exit itself; this covers a shell killed outright (SIGKILL), or one that never ran.
    if (!existsSync(join(dir, 'exit.json'))) putIfThere(dir, 'exit.json', JSON.stringify({ code, signal }));
    forget(t);
  });
  t.pid = child.pid ?? null;
  t.feed = feeder(dir, child.stdin);
}

/** @param {string} dir @param {string[]} scope @param {import('./turn-run.mjs').TurnSpec} spec */
async function run(dir, scope, spec) {
  /** @type {Turn} */
  const t = { dir, pid: null, pooled: null, feed: null, adopted: false };
  turns.set(dir, t);
  try {
    t.pooled = await prepare(dir, spec);
    // What a supervisor that adopts the turn needs to keep it registered; no secrets (the pool's env is PATH, HOME, LANG, TZ).
    if (t.pooled) putIfThere(dir, 'pool-spec.json', JSON.stringify(t.pooled.spec));
  } catch (e) {
    return failed(t, spec.command, /** @type {Error} */ (e));
  }
  start(t, spec, scope);
}

/** `pid` runs a turn supervisor. @param {number} pid */
function supervisorAlive(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('turn-supervisor');
  } catch {
    return false;
  }
}

/** `pid` still runs the turn in `dir` (its shell's cmdline names the folder). @param {number} pid @param {string} dir */
function runs(pid, dir) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir);
  } catch {
    return false;
  }
}

/**
 * Take over turns whose supervisor died: they run on in their scopes, with no stdin, and need their beat and their
 * shared tool server registration (a pool forgets a turn not registered for 30 s). The turn's env and cwd come from its
 * shell's /proc entry, so no file holds the turn's token.
 */
function adopt() {
  let names;
  try {
    names = readdirSync(turnsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = join(turnsDir, name);
    if (turns.has(dir) || existsSync(join(dir, 'exit.json'))) continue;
    let p;
    try {
      p = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isInteger(p.supervisor) || p.supervisor === process.pid || supervisorAlive(p.supervisor) || !runs(p.wrapper, dir)) continue;
    // One adopter per dead supervisor, should two versions' supervisors look at once.
    try {
      closeSync(openSync(join(dir, `adopted.${p.supervisor}`), 'wx'));
    } catch {
      continue;
    }
    /** @type {Turn} */
    const t = { dir, pid: p.wrapper, pooled: null, feed: null, adopted: true };
    try {
      const pool = existsSync(join(dir, 'pool-spec.json')) ? JSON.parse(readFileSync(join(dir, 'pool-spec.json'), 'utf8')) : null;
      if (pool) {
        /** @type {Record<string, string>} */
        const env = {};
        for (const kv of readFileSync(`/proc/${p.wrapper}/environ`, 'utf8').split('\0')) {
          const i = kv.indexOf('=');
          if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
        }
        delete env.CITADEL_POOL_PORT; // added at start, not part of what it registered with
        t.pooled = { spec: pool, token: env.COORDINATOR_TOKEN ?? '', reg: { env, cwd: readlinkSync(`/proc/${p.wrapper}/cwd`) } };
      }
    } catch {}
    putIfThere(dir, 'pid.json', JSON.stringify({ ...p, supervisor: process.pid }));
    turns.set(dir, t);
    if (t.pooled) void keepPooled(t.pooled);
  }
}

/** The runner now starts another version's supervisor (src/supervisor-client.ts ensureSupervisor): a deploy or a roll back. */
function superseded() {
  try {
    return readFileSync(join(dirname(home), 'current'), 'utf8').trim() !== version;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  const reply = (/** @type {number} */ status, /** @type {object} */ body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (req.method === 'GET' && req.url === '/health') return reply(200, { pid: process.pid, version, turns: turns.size });
  if (req.headers['x-supervisor-key'] !== key) return reply(403, { error: 'wrong key' });
  if (req.method !== 'POST' || req.url !== '/start') return reply(404, { error: 'not found' });
  let body = '';
  req.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => {
    if (closing) return reply(503, { error: 'closing' });
    let dir;
    let scope;
    try {
      ({ dir, scope } = JSON.parse(body));
    } catch {
      return reply(400, { error: 'bad JSON' });
    }
    if (typeof dir !== 'string' || dirname(dir) !== turnsDir || !Array.isArray(scope) || !scope.every((a) => typeof a === 'string')) return reply(400, { error: 'bad turn' });
    // Taken here, before the answer: the runner starts the wrapper when it gets none, and only one of them can claim it.
    const spec = claimSpec(dir);
    if (!spec) return reply(409, { error: 'no spec.json' });
    reply(200, { ok: true });
    void run(dir, scope, spec);
  });
});
server.listen(0, '127.0.0.1', () => {
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  put(home, 'supervisor.json', JSON.stringify({ pid: process.pid, port: addr.port, key, version }));
  adopt();
});

// claude's stdin: the prompt, then steers until the reply is out.
setInterval(() => {
  for (const t of turns.values()) if (t.feed && !t.feed()) t.feed = null;
}, 250).unref();
// Each pooled turn re-registered with its place's shared tool server, which is started again if it died.
setInterval(() => {
  for (const t of turns.values()) {
    if (!t.pooled || t.busy) continue;
    t.busy = true;
    keepPooled(t.pooled).finally(() => (t.busy = false));
  }
}, 2_000).unref();
// Beats, as the wrapper's; and adopted turns are watched by pid, having no child here.
setInterval(() => {
  for (const t of turns.values()) {
    if (t.adopted && t.pid && !runs(t.pid, t.dir)) {
      forget(t);
      continue;
    }
    try {
      writeFileSync(join(t.dir, 'beat'), '');
    } catch {}
  }
}, 5_000).unref();
// Orphans to adopt, and whether it is time to go: never with a turn running, nor mid-handoff.
setInterval(() => {
  adopt();
  if (turns.size || closing) return;
  const idle = Date.now() - idleSince;
  if (idle < SUPERSEDED_IDLE_MS || (idle < IDLE_MS && !superseded())) return;
  closing = true;
  server.close();
  try {
    if (JSON.parse(readFileSync(join(home, 'supervisor.json'), 'utf8')).pid === process.pid) rmSync(join(home, 'supervisor.json'), { force: true });
  } catch {}
  process.exit(0);
}, ADOPT_EVERY_MS);
