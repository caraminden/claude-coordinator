// Runs one turn's `claude -p` for the runner (src/runner.ts) in a process of its own, normally a
// transient systemd user unit, so the turn outlives a restart of the server. Everything it reads and
// writes is in the turn's folder, given as its one argument:
//   spec.json     in: the command, args, cwd and env (deleted once read, as the env holds the turn's token)
//   prompt.jsonl  in: the turn's first message, written to claude's stdin
//   steer.jsonl   in: messages that steer the running turn, one stream-json line each, appended by the runner
//   steer.sent    out: bytes of steer.jsonl passed to claude; the runner queues the rest for the next turn
//   pid.json      out: { wrapper, claude } pids; the runner stops a turn by signalling claude's process group
//   stream.jsonl  out: claude's stdout, the stream-json the runner tails
//   stderr.log    out: claude's stderr
//   exit.json     out: { code, signal, error? } once claude has exited
//   beat          out: touched every 5 s while this runs
//   mcp-stdio.json in: the turn's own-helpers tool config, used instead of mcp.json when spec.pool won't start (#1259)
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepTurn, type PoolSpec } from './pool-client.ts';

const dir = process.argv[2];
const file = (name: string) => join(dir, name);
/** Write a file the runner may read at any moment: renamed into place, so it never sees it half-written. */
function put(name: string, data: string) {
  writeFileSync(file(`${name}.tmp`), data);
  renameSync(file(`${name}.tmp`), file(name));
}
const spec = JSON.parse(readFileSync(file('spec.json'), 'utf8'));
rmSync(file('spec.json'));

function done(exit: { code: number | null; signal: string | null; error?: string }) {
  put('exit.json', JSON.stringify(exit));
  process.exit(0);
}

function failed(err: Error) {
  appendFileSync(file('stderr.log'), `Could not start ${spec.command}: ${err.message}\n`);
  done({ code: null, signal: null, error: err.message });
}

// The shared tool server (#1259, src/mcp-pool.ts): the turn's tools come from its place's pool, which this keeps up
// and keeps the turn registered with. If it won't start, the turn runs its own helpers, as before the pool.
if (spec.pool) {
  const pool: PoolSpec = spec.pool;
  const token: string = spec.env.COORDINATOR_TOKEN ?? '';
  const reg = { env: spec.env, cwd: spec.cwd };
  try {
    const p = await keepTurn(pool, token, reg);
    spec.env = { ...spec.env, CITADEL_POOL_PORT: String(p.port) };
    let busy = false;
    setInterval(() => {
      if (busy) return;
      busy = true;
      keepTurn(pool, token, reg).catch(() => {}).finally(() => (busy = false));
    }, 2_000).unref();
  } catch (err: any) {
    appendFileSync(file('stderr.log'), `The shared tool server didn't start (${err.message}); this turn runs its own helpers.\n`);
    spec.args = spec.args.map((a: string) => (a === file('mcp.json') ? file('mcp-stdio.json') : a));
  }
}

// The env is exactly the runner's allowlist (turnEnv), not this unit's: the user manager adds its own.
let child: ReturnType<typeof spawn>;
try {
  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    // Its own process group, as before units: stopping the turn signals the group, tool subprocesses too.
    detached: true,
    stdio: ['pipe', openSync(file('stream.jsonl'), 'a'), openSync(file('stderr.log'), 'a')],
  });
} catch (err: any) {
  // Some failures (E2BIG: arguments too long) throw here rather than emit 'error'; without exit.json
  // the runner would wait out its start-up grace and report the turn as killed.
  failed(err);
}
child!.on('error', failed);
if (child!.pid) put('pid.json', JSON.stringify({ wrapper: process.pid, claude: child.pid }));
child!.on('exit', (code, signal) => done({ code, signal }));
// In a container the runner can't see these pids, so it goes by this heartbeat (runner.ts wrapperAlive).
setInterval(() => writeFileSync(file('beat'), ''), 5_000).unref();

// Claude reads stdin line by line, mid-turn too, and waits for more until it closes. So steers go in
// until the turn's reply (its result) is out; anything written before the close is still handled.
child.stdin!.on('error', () => {}); // claude exited without reading it all
child.stdin!.write(readFileSync(file('prompt.jsonl')));
let sent = 0;
let scanned = 0;
const tick = setInterval(() => {
  if (replied()) {
    clearInterval(tick);
    child.stdin!.end();
    return;
  }
  let steers: Buffer;
  try {
    steers = readFileSync(file('steer.jsonl'));
  } catch {
    return; // none yet
  }
  const end = steers.lastIndexOf(10) + 1; // whole lines only: the runner may be mid-append
  if (end <= sent) return;
  child.stdin!.write(steers.subarray(sent, end));
  sent = end;
  put('steer.sent', String(sent));
}, 250);

/** Claude's stream has a result line past what was scanned before. */
function replied(): boolean {
  const fd = openSync(file('stream.jsonl'), 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= scanned) return false;
    const buf = Buffer.alloc(size - scanned);
    readSync(fd, buf, 0, buf.length, scanned);
    const end = buf.lastIndexOf(10) + 1;
    scanned += end;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.includes('"result"')) continue;
      try {
        if (JSON.parse(line).type === 'result') return true;
      } catch {
        // Not JSON: claude printed something else.
      }
    }
    return false;
  } finally {
    closeSync(fd);
  }
}
// `systemctl stop` signals the whole unit at once; outlive claude so its exit is still recorded.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
