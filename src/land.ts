// The land tool (#213): a minion whose turn runs in its person's container can't run tools/land.sh
// there (no deploy lock, user bus or GitHub login), so the server runs it on the host, in the minion's
// worktree, as a host turn would. Its tests and boot check run as the server's user: landing is as
// trusted as it was before containers.
//
// It runs in a transient unit of its own under the turns' slice, as host turns do (#508): a restart of
// the server neither kills it nor waits for it, and its output and exit code go to files under
// run/landings/<minion>/, so the next server reports them to the tool still polling. Without units
// (tests, a dev copy) or when systemd-run fails, it runs as the server's child, which a restart would
// cut off: only those count toward the runner's interruptible().
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TURN_SLICE } from './turn-launch.ts';

export interface Landing {
  /** The tail of what land.sh printed so far. */
  output: string;
  /** Its exit code once it ended, null while it runs. */
  code: number | null;
}

const MAX_OUTPUT = 64 * 1024;
/** How long a landing whose wrapper hasn't written its pid yet still counts as starting. */
const START_GRACE_MS = 60_000;
/** Finished landings' folders older than this go when a server starts. */
const KEEP_MS = 14 * 24 * 3600_000;
/** Said when the wrapper ended without writing a code: its unit was stopped, or a restart cut off a child. */
export const NO_CODE = '\n[land.sh ended without an exit code: it was stopped, or a restart cut it off. Check `git log main`.]';

// The wrapper: notes its pid (by a rename, so a pid read is never a half-written one), takes the env the server gave it (a private file it deletes once read, as it
// holds the minion's token), runs land.sh and writes the exit code last, by a rename, so a code on disk is whole.
// `env -i` before it, so land.sh sees only that env, as it did as the server's child. It goes in a file, not on
// the command line: systemd expands `$` in a unit's command line, so `$$` there would reach bash as a bare `$`.
const WRAPPER = 'echo $$ >"$1/pid.tmp"; mv "$1/pid.tmp" "$1/pid"; . "$1/env"; rm -f "$1/env"; { cd "$2" && bash tools/land.sh; } >"$1/output.log" 2>&1; echo $? >"$1/code.tmp"; mv "$1/code.tmp" "$1/code"';
// Names bash won't take as exported variables, or that would change how the wrapper's own bash runs.
const VALID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP = /^(BASH.*|SHELLOPTS|UID|EUID|PPID|ENV|_)$/;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class Landings {
  private readonly root: string;
  private readonly unitTag: string;
  /** Landings running as the server's child (no units, or systemd-run failed): a restart would cut them off. */
  private children = new Set<ChildProcess>();
  /** Landings whose systemd-run hasn't answered yet. */
  private starting = new Set<number>();
  private readonly units: () => boolean;

  /** `units`: whether to start each landing in a unit of its own (the runner's `units`, read at each start). */
  constructor(dataDir: string, units: () => boolean = () => false) {
    this.units = units;
    this.root = join(resolve(dataDir), 'run', 'landings');
    // As the runner tags turn units: two servers on one box (a dev copy) never share a unit name.
    this.unitTag = createHash('sha256').update(this.root).digest('hex').slice(0, 8);
    this.prune();
  }

  private dir(ticketId: number): string {
    return join(this.root, String(ticketId));
  }

  /** Start land.sh for a minion, unless one runs already; the tool polls get() until it ends. */
  start(ticketId: number, cwd: string, env: Record<string, string>): Landing {
    const now = this.get(ticketId);
    if (now && now.code === null) return now;
    const dir = this.dir(ticketId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lines = Object.entries(env).filter(([k, v]) => v !== undefined && VALID.test(k) && !SKIP.test(k)).map(([k, v]) => `export ${k}=${quote(String(v))}\n`);
    writeFileSync(join(dir, 'env'), lines.join(''), { mode: 0o600 });
    writeFileSync(join(dir, 'started'), String(Date.now()));
    writeFileSync(join(dir, 'wrapper.sh'), WRAPPER);
    const wrapper = ['env', '-i', 'bash', '--noprofile', '--norc', join(dir, 'wrapper.sh'), dir, cwd];
    if (!this.units()) {
      this.child(wrapper, dir);
      return { output: '', code: null };
    }
    this.starting.add(ticketId);
    const unit = `citadel-land-${this.unitTag}-${ticketId}-${Date.now()}`;
    execFile('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit}`, `--slice=${TURN_SLICE}`, '-p', 'UMask=0077', `--description=tools/land.sh for minion ${ticketId}`, ...wrapper], (err, _out, stderr) => {
      this.starting.delete(ticketId);
      if (!err) return;
      console.error(`Minion ${ticketId}: systemd-run failed (${String(stderr).trim() || err.message}), so its landing runs as a child of the server.`);
      this.child(wrapper, dir);
    });
    return { output: '', code: null };
  }

  private child(wrapper: string[], dir: string) {
    const child = spawn(wrapper[0], wrapper.slice(1), { stdio: 'ignore' });
    this.children.add(child);
    const done = () => this.children.delete(child);
    child.on('error', (err) => {
      done();
      writeFileSync(join(dir, 'output.log'), err.message);
      writeFileSync(join(dir, 'code'), '127');
    });
    child.on('exit', done);
  }

  /** Landings running as the server's child: the ones a restart would cut off. */
  running(): number {
    return this.children.size;
  }

  /** The landing a minion started last, from its folder, whichever server started it. */
  get(ticketId: number): Landing | null {
    const dir = this.dir(ticketId);
    if (!existsSync(dir)) return null;
    let code = readCode(dir);
    // Liveness first: the wrapper writes its code, then exits.
    if (code === null && !this.alive(ticketId, dir)) {
      code = readCode(dir);
      if (code === null) return { output: tail(join(dir, 'output.log')) + NO_CODE, code: 1 };
    }
    return { output: tail(join(dir, 'output.log')), code };
  }

  /** Whether a landing's wrapper may still run: its pid is a live process on its folder, or it is still starting. */
  private alive(ticketId: number, dir: string): boolean {
    if (this.starting.has(ticketId)) return true;
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

  /** Drop finished landings' folders from long ago. */
  private prune() {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (Date.now() - statSync(join(this.root, name, 'code')).mtimeMs > KEEP_MS) rmSync(join(this.root, name), { recursive: true, force: true });
      } catch {
        // Still running, or never started: left alone.
      }
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

/** The last MAX_OUTPUT bytes of a file, or '' with none yet. */
function tail(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, MAX_OUTPUT);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
