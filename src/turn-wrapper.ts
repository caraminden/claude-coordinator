// Runs one turn's `claude -p` for the runner (src/runner.ts) in a process of its own, normally a
// transient systemd user unit, so the turn outlives a restart of the server. Everything it reads and
// writes is in the turn's folder, given as its one argument:
//   spec.json     in: the command, args, cwd and env (deleted once read, as the env holds the turn's token)
//   prompt.jsonl  in: claude's stdin
//   pid.json      out: { wrapper, claude } pids; the runner stops a turn by signalling claude's process group
//   stream.jsonl  out: claude's stdout, the stream-json the runner tails
//   stderr.log    out: claude's stderr
//   exit.json     out: { code, signal, error? } once claude has exited
import { spawn } from 'node:child_process';
import { appendFileSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const file = (name: string) => join(dir, name);
const spec = JSON.parse(readFileSync(file('spec.json'), 'utf8'));
rmSync(file('spec.json'));

function done(exit: { code: number | null; signal: string | null; error?: string }) {
  writeFileSync(file('exit.json.tmp'), JSON.stringify(exit));
  renameSync(file('exit.json.tmp'), file('exit.json'));
  process.exit(0);
}

function failed(err: Error) {
  appendFileSync(file('stderr.log'), `Could not start ${spec.command}: ${err.message}\n`);
  done({ code: null, signal: null, error: err.message });
}

// The env is exactly the runner's allowlist (turnEnv), not this unit's: the user manager adds its own.
let child: ReturnType<typeof spawn>;
try {
  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    // Its own process group, as before units: stopping the turn signals the group, tool subprocesses too.
    detached: true,
    stdio: [openSync(file('prompt.jsonl'), 'r'), openSync(file('stream.jsonl'), 'a'), openSync(file('stderr.log'), 'a')],
  });
} catch (err: any) {
  // Some failures (E2BIG: arguments too long) throw here rather than emit 'error'; without exit.json
  // the runner would wait out its start-up grace and report the turn as killed.
  failed(err);
}
child!.on('error', failed);
if (child!.pid) writeFileSync(file('pid.json'), JSON.stringify({ wrapper: process.pid, claude: child.pid }));
child!.on('exit', (code, signal) => done({ code, signal }));
// `systemctl stop` signals the whole unit at once; outlive claude so its exit is still recorded.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
