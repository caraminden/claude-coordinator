// Jobs the server runs on the host that must outlive it (#508): landings (src/land.ts), kit sync, fast-verify, rollbacks and ultra reviews
// (src/ultrareview.ts). Each runs in a transient unit of its own, in the builds' slice (ultra reviews: the turns' slice),
// so a restart of the server neither kills it nor waits for it. A job keeps everything in a folder of its
// own (its pid, output and exit code), so whichever server runs next reads how it went. Without units
// (tests, a dev copy) or when systemd-run fails, it runs as the server's child, which a restart would cut
// off: only those count as running(), which feeds the runner's interruptible().
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fallbacks } from './fallbacks.ts';
import { THP_PROPS } from './unit-thp.ts';

/** Ships, kit-sync ships and checks, fast-verify and rollbacks (#1280): beside the turns, not crowding their MemoryHigh. */
export const BUILD_SLICE = 'citadel-builds.slice';

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

/** Hears each job that ended with no exit code, once, with what happened in words; the server records it (#1325). */
export const jobLost = { hear: (_dir: string, _detail: string) => {} };

/** systemd's lines for a unit killed for memory: systemd-oomd's kill, the kernel's OOM killer, and the unit's result. */
const OOM_LINE = /Failed with result 'oom-kill'|systemd-oomd killed|OOM killer killed/;
const userJournal = (unit: string) => new Promise<string>((done) =>
  execFile('journalctl', ['--user', '-u', unit, '-n', '50', '-o', 'cat', '--no-pager', '-q'], { timeout: 10_000 }, (err, out) => done(err ? '' : String(out))));

/** Whether this account's own journal says `unit` was killed for memory (never another user's or the system journal). */
export async function oomKilled(unit: string, journal: (unit: string) => Promise<string> = userJournal): Promise<boolean> {
  return OOM_LINE.test(await journal(unit).catch(() => ''));
}

async function heardLost(dir: string) {
  let unit: string | null = null;
  try { unit = readFileSync(join(dir, 'unit'), 'utf8').trim() || null; } catch { /* ran as the server's child */ }
  const oom = unit ? await oomKilled(unit) : false;
  jobLost.hear(dir, `${dir}${unit ? ` (${unit})` : ''}: ${oom ? 'killed for memory (out of memory, says the journal)' : 'ended with no exit code (killed from outside, stopped, or cut off by a restart)'}`);
}

/** A TMPDIR the job's env names that isn't perigee's tmpfs (/tmp, /var/tmp, /dev/shm, /run). */
function onDisk(tmp: string | undefined): boolean {
  return !!tmp && !/^\/(tmp|var\/tmp|dev\/shm|run)(\/|$)/.test(tmp);
}

export class HostJobs {
  /** Jobs running as the server's child (no units, or systemd-run failed): a restart would cut them off. */
  private children = new Set<ChildProcess>();
  /** Jobs whose systemd-run hasn't answered yet, by folder. */
  private starting = new Set<string>();
  private readonly units: () => boolean;
  private readonly slice: string;
  private readonly props: string[];

  /** `units`: whether to start each job in a unit of its own (the runner's `units`, read at each start); `slice`: where;
   * `props`: more of systemd-run's `-p` arguments for each unit. */
  constructor(units: () => boolean = () => false, slice: string = BUILD_SLICE, props: string[] = []) {
    this.units = units;
    this.slice = slice;
    this.props = props;
  }

  /**
   * Run `argv` in `cwd` with exactly `env`, keeping its state in `dir` (made afresh, private). `unit` names
   * its unit; `onChildEnd` is called when a job that fell back to the server's child ends. `ticketId` is the
   * minion it runs for.
   */
  start(job: { dir: string; cwd: string; argv: string[]; env: Record<string, string>; unit: string; description: string; ticketId: number; onChildEnd?: () => void }) {
    const { dir } = job;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lines = Object.entries(job.env).filter(([k, v]) => v !== undefined && VALID.test(k) && !SKIP.test(k)).map(([k, v]) => `export ${k}=${quote(String(v))}\n`);
    // Scratch on disk, never in perigee's RAM-backed /tmp (#1339): boot-check's database copy and a test run's files
    // otherwise sit there until the job's end, and for good when it is killed. A TMPDIR already on disk stays.
    if (!onDisk(job.env.TMPDIR)) {
      const tmp = join(dir, 'tmp');
      mkdirSync(tmp, { mode: 0o700 });
      lines.push(...['TMPDIR', 'TMP', 'TEMP'].map((k) => `export ${k}=${quote(tmp)}\n`));
    }
    writeFileSync(join(dir, 'env'), lines.join(''), { mode: 0o600 });
    writeFileSync(join(dir, 'cmd'), `set -- ${job.argv.map(quote).join(' ')}\n`);
    writeFileSync(join(dir, 'wrapper.sh'), WRAPPER);
    writeFileSync(join(dir, 'started'), String(Date.now()));
    const wrapper = ['env', '-i', 'bash', '--noprofile', '--norc', join(dir, 'wrapper.sh'), dir, job.cwd];
    if (!this.units()) return this.child(wrapper, dir, job.onChildEnd);
    writeFileSync(join(dir, 'unit'), job.unit); // for jobLost's journal look (#1325)
    this.starting.add(dir);
    execFile('systemd-run', ['--user', '--collect', '--quiet', `--unit=${job.unit}`, `--slice=${this.slice}`, '-p', 'UMask=0077', ...this.props, ...THP_PROPS, `--description=${job.description}`, ...wrapper], (err, _out, stderr) => {
      this.starting.delete(dir);
      if (!err) return fallbacks.started();
      fallbacks.record(job.ticketId, job.description, String(stderr).trim() || err.message);
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
        code = lost(dir);
      }
    }
    return { output: tail(join(dir, 'output.log'), maxOutput), code };
  }

  /**
   * state(), read off the server's thread (#1463): the ship hand-off poll reads every handed-off job each few seconds,
   * and its blocking reads were in the stall stacks.
   */
  async look(dir: string, maxOutput: number): Promise<JobState | null> {
    let code = await readCodeAsync(dir);
    if (code === null && !(await this.aliveAsync(dir))) {
      code = await readCodeAsync(dir);
      if (code === null) {
        if (!(await readFile(join(dir, 'started')).then(() => true, () => false))) return null;
        code = lost(dir);
      }
    }
    return { output: await tailAsync(join(dir, 'output.log'), maxOutput), code };
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
      return onFolder(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), dir);
    } catch {
      return false;
    }
  }

  private async aliveAsync(dir: string): Promise<boolean> {
    if (this.starting.has(dir)) return true;
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => ''));
    if (!(pid > 0)) return Date.now() - Number(await readFile(join(dir, 'started'), 'utf8').catch(() => NaN)) < START_GRACE_MS;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
    return cmdline !== null && onFolder(cmdline, dir);
  }
}

/**
 * A process command line that names the job's folder, so a pid the system reused for something else doesn't count. Bash
 * may exec the wrapper's last command, the mv of its code, in its place: that names a file in the folder.
 */
function onFolder(cmdline: string, dir: string): boolean {
  return cmdline.split('\0').some((a) => a === dir || a.startsWith(`${dir}/`));
}

/** A job that ended with no exit code: noted once, as its code, so the hook hears it once (#1325: ships cut off by systemd-oomd were only in the journal). */
function lost(dir: string): number {
  try {
    writeFileSync(join(dir, 'code'), '-1', { flag: 'wx' });
    void heardLost(dir);
  } catch {
    // Noted already.
  }
  return -1;
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

async function readCodeAsync(dir: string): Promise<number | null> {
  const text = await readFile(join(dir, 'code'), 'utf8').then((t) => t.trim(), () => '');
  return text === '' ? null : Number(text);
}

async function tailAsync(file: string, max: number): Promise<string> {
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}
