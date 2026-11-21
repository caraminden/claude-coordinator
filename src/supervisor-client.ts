// The runner's side of the shared turn supervisor (#1343, src/turn-supervisor.mjs): hand it a host turn, and start it
// when none runs. Nothing here waits for it: a turn it doesn't take at once starts in a wrapper unit of its own, as
// before, so a slow, starting or broken supervisor never delays a turn (Cara, 2026-11-20: nothing may count, cap or
// delay turn starts).
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { TASKMASTER_SLICE, TURN_NODE } from './turn-launch.ts';
import { THP_PROPS } from './unit-thp.ts';

/** Where one turns folder's supervisor of one version lives, and what starts it. */
export interface SupervisorSpec {
  /** <turns>/.supervisor/<version>: supervisor.json, and the copies of its code it runs from. */
  dir: string;
  version: string;
  /** The server's pinned copies (turn-launch's MCP_DIR), copied into `dir` so a restart of its unit finds them. */
  code: string;
  /** systemd-run's arguments for its unit, the command left out. */
  systemdRun: string[];
  /** Its own env: a plain one, as the pool's; each turn's comes with the turn. */
  env: Record<string, string>;
}

/** Its code, the files `src/turn-supervisor.mjs` runs from. */
export const SUPERVISOR_FILES = ['turn-supervisor.mjs', 'turn-run.mjs', 'pool-client.mjs'];

/** A turns folder's supervisor for the pinned code: its folder, and its unit in the Taskmasters' slice, apart from a minion storm. */
export function supervisorSpec(turnsDir: string, unitTag: string, pins: { MCP_DIR: string; SUPERVISOR_VERSION: string }, env: NodeJS.ProcessEnv = process.env): SupervisorSpec {
  const version = pins.SUPERVISOR_VERSION;
  return {
    dir: join(turnsDir, '.supervisor', version),
    version,
    code: pins.MCP_DIR,
    // Restart: a crash comes back within a second and adopts the turns it left. KillMode=process: a `systemd-run --scope`
    // it left starting a turn runs on through that restart and starts the turn; the runner, seeing it there, waits for it
    // (runner.ts rescue).
    systemdRun: ['--user', '--collect', '--quiet', `--unit=citadel-supervisor-${unitTag}-${version.slice(0, 8)}`, `--slice=${TASKMASTER_SLICE}`,
      '-p', 'ManagedOOMPreference=omit', '-p', 'UMask=0077', '-p', 'Restart=on-failure', '-p', 'KillMode=process', ...THP_PROPS],
    env: Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ'].filter((k) => env[k]).map((k) => [k, env[k]!])),
  };
}

interface Running { pid: number; port: number; key: string; version: string }

/** `pid` runs a turn supervisor; its pid reused by another process doesn't count. */
export function supervisorAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid)) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('turn-supervisor');
  } catch {
    return false;
  }
}

/** The supervisor running in `dir`, or null. */
export function readSupervisor(dir: string): Running | null {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'supervisor.json'), 'utf8'));
    return Number.isInteger(s.port) && typeof s.key === 'string' && supervisorAlive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

/** When each supervisor was last started from here: one start at a time, retried after this long. */
const starting = new Map<string, number>();
const startRetryMs = () => Number(process.env.CITADEL_SUPERVISOR_RETRY_MS) || 30_000;

/**
 * Start `spec`'s supervisor unless it runs or was just started; returns at once. It also names `spec`'s version the
 * current one (<turns>/.supervisor/current), so a supervisor of another version, the code before a deploy or after a
 * roll back, exits once its turns have ended (turn-supervisor.mjs superseded).
 */
export function ensureSupervisor(spec: SupervisorSpec, now = Date.now()): void {
  if (readSupervisor(spec.dir)) return;
  if (now - (starting.get(spec.dir) ?? 0) < startRetryMs()) return;
  starting.set(spec.dir, now);
  try {
    mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dirname(spec.dir), 'current'), spec.version);
    for (const f of SUPERVISOR_FILES) if (!existsSync(join(spec.dir, f))) copyFileSync(join(spec.code, f), join(spec.dir, f));
    // node under another name, as turns' (#506): ananicy's `node` rule would make it, and every claude it starts, idle-priority.
    // A link left pointing at a node that has since gone (an upgrade) is made again.
    if (!existsSync(join(spec.dir, TURN_NODE))) {
      rmSync(join(spec.dir, TURN_NODE), { force: true });
      symlinkSync(process.execPath, join(spec.dir, TURN_NODE));
    }
  } catch (err) {
    console.error(`The turn supervisor in ${spec.dir} can't be set up: ${(err as Error).message}`);
    return;
  }
  pruneOld(spec, now);
  const env = Object.entries(spec.env).flatMap(([k, v]) => ['-E', `${k}=${v}`]);
  execFile('systemd-run', [...spec.systemdRun, ...env, join(spec.dir, TURN_NODE), join(spec.dir, 'turn-supervisor.mjs'), spec.dir, spec.version], (err, _out, stderr) => {
    if (err) console.error(`The turn supervisor didn't start: ${String(stderr).trim() || err.message}`);
  });
}

/** Folders of other versions' supervisors that no longer run and haven't for a day (a crashed one restarts from its own). */
function pruneOld(spec: SupervisorSpec, now: number) {
  const root = dirname(spec.dir);
  try {
    for (const v of readdirSync(root)) {
      const dir = join(root, v);
      if (dir === spec.dir || v === 'current' || readSupervisor(dir)) continue;
      if (now - statSync(dir).mtimeMs > 86_400_000) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Nothing to prune; it is tried again at the next start.
  }
}

/**
 * Hand the turn in `dir` (its spec.json written) to the supervisor, to run in a scope from `scope`. True once it has
 * taken it; false, at once, when none runs (starting one for later turns), and within `timeoutMs` when it doesn't answer
 * or refuses: the runner then starts the turn's wrapper, and the spec.json claim lets only one of them run it. It answers
 * on loopback as soon as it has renamed spec.json, so a short wait is all a hung one costs a turn.
 */
export function handTurn(spec: SupervisorSpec, dir: string, scope: string[], timeoutMs = 500): Promise<boolean> {
  const s = readSupervisor(spec.dir);
  if (!s || s.version !== spec.version) {
    ensureSupervisor(spec);
    return Promise.resolve(false);
  }
  return new Promise((done) => {
    const body = JSON.stringify({ dir, scope });
    const req = request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/start', timeout: timeoutMs, headers: { 'X-Supervisor-Key': s.key, 'Content-Type': 'application/json' } }, (res) => {
      res.resume().on('end', () => done(res.statusCode === 200)).on('error', () => done(false));
    });
    req.on('timeout', () => req.destroy(new Error('timed out'))).on('error', () => done(false));
    req.end(body);
  });
}
