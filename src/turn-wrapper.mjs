// Runs one turn's `claude -p` for the runner (src/runner.ts) in a process of its own, normally a
// transient systemd user unit, so the turn outlives a restart of the server. Since #1343 a host turn normally starts
// in the shared supervisor (src/turn-supervisor.mjs) instead; this runs container turns, test and dev turns, and any
// turn the supervisor couldn't take. Plain JS, not TypeScript: a .ts file makes node load its type stripper, about
// 18 MB more in every turn's wrapper (#1343). The turn's folder, its one argument, is described in src/turn-run.mjs.
import { spawn } from 'node:child_process';
import { appendFileSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimSpec, feeder, keepPooled, prepare, put } from './turn-run.mjs';

const dir = process.argv[2];
/** @param {string} name */
const file = (name) => join(dir, name);
const spec = claimSpec(dir);
// The supervisor took it first (the runner starts this when the supervisor is slow to answer): it runs the turn.
if (!spec) process.exit(0);

/** @param {{ code: number | null, signal: string | null, error?: string }} exit */
function done(exit) {
  put(dir, 'exit.json', JSON.stringify(exit));
  process.exit(0);
}

/** @param {Error} err */
function failed(err) {
  appendFileSync(file('stderr.log'), `Could not start ${spec.command}: ${err.message}\n`);
  done({ code: null, signal: null, error: err.message });
}

const pooled = await prepare(dir, spec);
if (pooled) {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    keepPooled(pooled).finally(() => (busy = false));
  }, 2_000).unref();
}

// The env is exactly the runner's allowlist (turnEnv), not this unit's: the user manager adds its own.
/** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
let child;
try {
  child = /** @type {any} */ (
    spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      // Its own process group, as before units: stopping the turn signals the group, tool subprocesses too.
      detached: true,
      stdio: ['pipe', openSync(file('stream.jsonl'), 'a'), openSync(file('stderr.log'), 'a')],
    })
  );
} catch (err) {
  // Some failures (E2BIG: arguments too long) throw here rather than emit 'error'; without exit.json
  // the runner would wait out its start-up grace and report the turn as killed.
  failed(/** @type {Error} */ (err));
}
child.on('error', failed);
if (child.pid) put(dir, 'pid.json', JSON.stringify({ wrapper: process.pid, claude: child.pid }));
child.on('exit', (code, signal) => done({ code, signal }));
// In a container the runner can't see these pids, so it goes by this heartbeat (runner.ts wrapperAlive).
setInterval(() => writeFileSync(file('beat'), ''), 5_000).unref();

const tick = feeder(dir, child.stdin);
const feeding = setInterval(() => tick() || clearInterval(feeding), 250);
// `systemctl stop` signals the whole unit at once; outlive claude so its exit is still recorded.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
