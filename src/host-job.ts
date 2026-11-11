// Jobs the server runs on the host that must outlive it (#508): landings (src/land.ts) and ultra reviews
// (src/ultrareview.ts). Each runs in a transient unit of its own under the turns' slice, as host turns do,
// so a restart of the server neither kills it nor waits for it. A job keeps everything in a folder of its
// own (its pid, output and exit code), so whichever server runs next reads how it went. Without units
// (tests, a dev copy) or when systemd-run fails, it runs as the server's child, which a restart would cut
// off: only those count as running(), which feeds the runner's interruptible().
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_SLICE } from './turn-launch.ts';

export interface JobState {
  /** The tail of what it printed so far. */
  output: string;
  /** Its exit code once it ended, null while it runs; -1 when it ended without one (stopped, or cut off). */
  code: number | null;
}

/** How long a job whose wrapper hasn't written its pid yet still counts as starting. */
const START_GRACE_MS = 60_000;

// The wrapper, from a file: systemd expands `$` in a unit's command line, so `$$` there would reach bash as
// a bare `$`. It notes its pid (by a rename, so a pid read is never half-written), takes the env the server
// gave it (a private file it deletes once read: it can hold a token), runs the command (a file too, so no
// `$` in it meets systemd) and writes the exit code last, by a rename, so a code on disk is whole.
// `env -i` before it, so the job sees only that env, as it did as the server's child.
const WRAPPER = `echo $$ >"$1/pid.tmp"; mv "$1/pid.tmp" "$1/pid"
. "$1/env"; rm -f "$1/env"; __job=$1
{ cd "$2" && . "$__job/cmd" && "$@"; } >"$__job/output.log" 2>&1
echo $? >"$__job/code.tmp"; mv "$__job/code.tmp" "$__job/code"
`;
// Names bash won't take as exported variables, or that would change how the wrapper's own bash runs.
const VALID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP = /^(BASH.*|SHELLOPTS|UID|EUID|PPID|ENV|_|__job)$/;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class HostJobs {
  /** Jobs running as the server's child (no units, or systemd-run failed): a restart would cut them off. */
  private children = new Set<ChildProcess>();
  /** Jobs whose systemd-run hasn't answered yet, by folder. */
  private starting = new Set<string>();
  private readonly units: () => boolean;

  /** `units`: whether to start each job in a unit of its own (the runner's `units`, read at each start). */
  constructor(units: () => boolean = () => false) {
    this.units = units;
  }

  /**
   * Run `argv` in `cwd` with exactly `env`, keeping its state in `dir` (made afresh, private). `unit` names
   * its unit; `onChildEnd` is called when a job that fell back to the server's child ends.
   */
  start(job: { dir: string; cwd: string; argv: string[]; env: Record<string, string>; unit: string; description: string; onChildEnd?: () => void }) {
    const { dir } = job;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lines = Object.entries(job.env).filter(([k, v]) => v !== undefined && VALID.test(k) && !SKIP.test(k)).map(([k, v]) => `export ${k}=${quote(String(v))}\n`);
    writeFileSync(join(dir, 'env'), lines.join(''), { mode: 0o600 });
    writeFileSync(join(dir, 'cmd'), `set -- ${job.argv.map(quote).join(' ')}\n`);
    writeFileSync(join(dir, 'wrapper.sh'), WRAPPER);
    writeFileSync(join(dir, 'started'), String(Date.now()));
    const wrapper = ['env', '-i', 'bash', '--noprofile', '--norc', join(dir, 'wrapper.sh'), dir, job.cwd];
    if (!this.units()) return this.child(wrapper, dir, job.onChildEnd);
    this.starting.add(dir);
    execFile('systemd-run', ['--user', '--collect', '--quiet', `--unit=${job.unit}`, `--slice=${TURN_SLICE}`, '-p', 'UMask=0077', `--description=${job.description}`, ...wrapper], (err, _out, stderr) => {
      this.starting.delete(dir);
      if (!err) return;
      console.error(`${job.description}: systemd-run failed (${String(stderr).trim() || err.message}), so it runs as a child of the server.`);
      this.child(wrapper, dir, job.onChildEnd);
    });
  }

  private child(wrapper: string[], dir: string, onEnd?: () => void) {
    const child = spawn(wrapper[0], wrapper.slice(1), { stdio: 'ignore' });
    this.children.add(child);
    const done = () => {
      this.children.delete(child);
      onEnd?.();
    };
    child.on('error', (err) => {
      writeFileSync(join(dir, 'output.log'), err.message);
      writeFileSync(join(dir, 'code'), '127');
      done();
    });
    child.on('exit', done);
  }

  /** Jobs running as the server's child: the ones a restart would cut off. */
  running(): number {
    return this.children.size;
  }

  /** How the job in `dir` stands, whichever server started it; null if there is none. */
  state(dir: string, maxOutput: number): JobState | null {
    let code = readCode(dir);
    // Liveness first: the wrapper writes its code, then exits.
    if (code === null && !this.alive(dir)) {
      code = readCode(dir);
      if (code === null) {
        try {
          readFileSync(join(dir, 'started'));
        } catch {
          return null;
        }
        code = -1;
      }
    }
    return { output: tail(join(dir, 'output.log'), maxOutput), code };
  }

  /** Whether a job's wrapper may still run: its pid is a live process on its folder, or it is still starting. */
  private alive(dir: string): boolean {
    if (this.starting.has(dir)) return true;
    let pid: number;
    try {
      pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      if (!(pid > 0)) throw new Error('no pid');
    } catch {
      try {
        return Date.now() - Number(readFileSync(join(dir, 'started'), 'utf8')) < START_GRACE_MS;
      } catch {
        return false;
      }
    }
    try {
      // Its command line names its folder, so a pid the system reused for something else doesn't count. Bash
      // may exec the wrapper's last command, the mv of its code, in its place: that names a file in the folder.
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a === dir || a.startsWith(`${dir}/`));
    } catch {
      return false;
    }
  }
}

function readCode(dir: string): number | null {
  try {
    const text = readFileSync(join(dir, 'code'), 'utf8').trim();
    return text === '' ? null : Number(text);
  } catch {
    return null;
  }
}

/** The last `max` bytes of a file, or '' with none yet. */
function tail(file: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
