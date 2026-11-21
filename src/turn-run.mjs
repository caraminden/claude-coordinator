// One turn's `claude -p`, as both the per-turn wrapper (src/turn-wrapper.mjs) and the shared supervisor
// (src/turn-supervisor.mjs, #1343) run it. Plain JS, like them: a .ts file makes node load its type stripper.
// The turn's folder holds:
//   spec.json     in: the command, args, cwd and env (claimed by renaming to spec.json.<pid>, deleted once the turn runs, as
//                 the env holds the turn's token)
//   handback      out: why the supervisor gave the turn back (its scope wouldn't start), spec.json put back: the runner
//                 starts its wrapper unit
//   prompt.jsonl  in: the turn's first message, written to claude's stdin
//   steer.jsonl   in: messages that steer the running turn, one stream-json line each, appended by the runner
//   steer.sent    out: bytes of steer.jsonl passed to claude; the runner queues the rest for the next turn
//   pid.json      out: { wrapper, claude, supervisor?, unit? } pids; the runner stops a turn by signalling claude's process group
//   stream.jsonl  out: claude's stdout, the stream-json the runner tails
//   stderr.log    out: claude's stderr
//   exit.json     out: { code, signal, error? } once claude has exited
//   beat          out: touched every 5 s while this runs
//   mcp-stdio.json in: the turn's own-helpers tool config, used instead of mcp.json when spec.pool won't start (#1259)
//                 or mcp.json names a variable the env lacks (#1272)
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepTurn } from './pool-client.mjs';

/** @typedef {{ command: string, args: string[], cwd: string, env: Record<string, string>, pool?: import('./pool-client.mjs').PoolSpec }} TurnSpec */
/** @typedef {{ spec: import('./pool-client.mjs').PoolSpec, token: string, reg: import('./pool-client.mjs').TurnReg }} PoolTurn */

/** Write a file the runner may read at any moment: renamed into place, so it never sees it half-written. @param {string} dir @param {string} name @param {string} data */
export function put(dir, name, data) {
  writeFileSync(join(dir, `${name}.tmp`), data);
  renameSync(join(dir, `${name}.tmp`), join(dir, name));
}

/**
 * Take the turn's spec.json, renamed to `file` (spec.json.<pid>), or null if another starter took it first: the rename
 * lets only one of the supervisor and a fallback wrapper start the turn (#1343). The supervisor keeps `file` until the
 * turn's shell runs, so a turn it loses before then (it died, or the scope wouldn't start) can be started again.
 * @param {string} dir @returns {{ spec: TurnSpec, file: string } | null}
 */
export function takeSpec(dir) {
  const file = join(dir, `spec.json.${process.pid}`);
  try {
    renameSync(join(dir, 'spec.json'), file);
  } catch {
    return null;
  }
  try {
    return { spec: JSON.parse(readFileSync(file, 'utf8')), file };
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
}

/** takeSpec, the file deleted at once (the env holds the turn's token): the wrapper's. @param {string} dir @returns {TurnSpec | null} */
export function claimSpec(dir) {
  const taken = takeSpec(dir);
  if (taken) rmSync(taken.file, { force: true });
  return taken && taken.spec;
}

/**
 * Get the turn's tools ready: its place's shared tool server (#1259, src/mcp-pool.ts) up with the turn registered, or
 * the turn's own helpers when it won't start or the tool config names a variable the env lacks (#1272). Changes
 * `spec` in place; returns what keeps the turn registered, or null.
 * @param {string} dir @param {TurnSpec} spec @returns {Promise<PoolTurn | null>}
 */
export async function prepare(dir, spec) {
  const stdio = () => (spec.args = spec.args.map((a) => (a === join(dir, 'mcp.json') ? join(dir, 'mcp-stdio.json') : a)));
  /** @type {PoolTurn | null} */
  let pooled = null;
  if (spec.pool) {
    const token = spec.env.COORDINATOR_TOKEN ?? '';
    const reg = { env: spec.env, cwd: spec.cwd };
    try {
      const p = await keepTurn(spec.pool, token, reg);
      spec.env = { ...spec.env, CITADEL_POOL_PORT: String(p.port) };
      pooled = { spec: spec.pool, token, reg };
    } catch (err) {
      appendFileSync(join(dir, 'stderr.log'), `The shared tool server didn't start (${/** @type {Error} */ (err).message}); this turn runs its own helpers.\n`);
      stdio();
    }
  }
  // Claude Code leaves an unset ${VAR} in an http server's url as written, refuses the server and runs the turn with no
  // Citadel tools (#1272). A config naming one this env lacks gives way to the turn's own helpers, when it has them.
  if (spec.args.includes(join(dir, 'mcp.json')) && existsSync(join(dir, 'mcp-stdio.json'))) {
    let why = '';
    try {
      const unset = new Set([...readFileSync(join(dir, 'mcp.json'), 'utf8').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g)].filter((m) => !m[2] && spec.env[m[1]] === undefined).map((m) => m[1]));
      if (unset.size) why = `names ${[...unset].join(', ')}, which its env lacks`;
    } catch (err) {
      why = `can't be read (${/** @type {Error} */ (err).message})`;
    }
    if (why) {
      appendFileSync(join(dir, 'stderr.log'), `This turn's tool config ${why}; it runs its own helpers.\n`);
      stdio();
    }
  }
  return pooled;
}

/** One beat of a pooled turn: re-registered, its pool started again if it died. Never throws. @param {PoolTurn} p */
export const keepPooled = (p) => keepTurn(p.spec, p.token, p.reg).then(() => {}, () => {});

/**
 * Feed claude's stdin: the prompt, then steers until the turn's reply (its result) is out. Claude reads stdin line by
 * line, mid-turn too, and waits for more until it closes; anything written before the close is still handled.
 * `tick()` is called every 250 ms by its owner; it returns false once stdin is closed.
 * @param {string} dir @param {import('node:stream').Writable} stdin @returns {() => boolean}
 */
export function feeder(dir, stdin) {
  stdin.on('error', () => {}); // claude exited without reading it all
  stdin.write(readFileSync(join(dir, 'prompt.jsonl')));
  let sent = 0;
  let scanned = 0;
  let open = true;
  /** Claude's stream has a result line past what was scanned before. */
  const replied = () => {
    const fd = openSync(join(dir, 'stream.jsonl'), 'r');
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
  };
  return () => {
    if (!open) return false;
    try {
      if (replied()) {
        open = false;
        stdin.end();
        return false;
      }
    } catch {
      return true; // the folder is going (the runner finished the turn); its owner stops on exit
    }
    let steers;
    try {
      steers = readFileSync(join(dir, 'steer.jsonl'));
    } catch {
      return true; // none yet
    }
    const end = steers.lastIndexOf(10) + 1; // whole lines only: the runner may be mid-append
    if (end > sent) {
      stdin.write(steers.subarray(sent, end));
      sent = end;
      put(dir, 'steer.sent', String(sent));
    }
    return true;
  };
}

/**
 * The shell a supervisor turn runs in (#1343): `sh -c SHIM <dir> <supervisor pid> <command> <args...>`. It is the turn's
 * process-group leader, so the runner's signals reach claude and its tools through it while it ignores them itself
 * (`systemctl stop` signals a whole scope at once), and it writes pid.json once it runs and exit.json once claude has
 * exited, so the turn's end is recorded even when the supervisor is down. Its cmdline holds the folder, so the runner's
 * liveness check (runner.ts wrapperAlive) reads it as it read the wrapper's. An exit status past 128 is a signal's.
 */
export const SHIM = [
  'umask 077',
  'trap : HUP INT TERM',
  `printf '{"wrapper":%s,"claude":%s,"supervisor":%s}' $$ $$ "$1" > "$0/pid.json.tmp" && mv -f "$0/pid.json.tmp" "$0/pid.json"`,
  'shift',
  '"$@"',
  'rc=$?',
  `if [ "$rc" -gt 128 ]; then c=null; s="\\"SIG$(kill -l "$((rc - 128))")\\""; else c=$rc; s=null; fi`,
  `printf '{"code":%s,"signal":%s}' "$c" "$s" > "$0/exit.json.tmp" && mv -f "$0/exit.json.tmp" "$0/exit.json"`,
].join('\n');
