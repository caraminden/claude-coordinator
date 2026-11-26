// Each test file counts what it leaves behind (#1763; Cara, 2026-11-24, "Test runs count what they leave behind: Go").
// test/leak-guard.ts's globalSetup puts this file in NODE_OPTIONS, so it loads first in every test file's own process
// (node --test runs each file in a child of the runner). There it gives the file a temp folder and a tag of its own:
//   - TMPDIR is a fresh folder for this file alone, so os.tmpdir() and every scratch folder under it are the file's;
//   - CITADEL_LEAK_FILE carries a fresh id that everything the file starts inherits.
// Once the file's teardown is over (every 'exit' listener has run, its after hooks long before), it counts what is still
// there and is this file's own: processes (still its children, or carrying its id, or naming its temp folder, as a test
// server's turn supervisor does in its own systemd unit), the user units they run in, the TCP ports they listen on, and
// the entries left in its temp folder. Before the file runs each count is zero by construction: the folder is new and the
// id is new, so nothing on the box can be the file's yet, and other files and other runs are never counted.
// Anything left fails the file, naming what it was, unless test/leak-baseline.json allows that many (a list that only
// shrinks, for files that leaked before the guard). Then it cleans up: stops the units, kills the processes, removes the
// folder, so a leak costs one red, never a pile on the box.
// A file killed by a signal (the run's time limit, a killed runner) never gets to 'exit' (#1999: a land.sh ran for 15
// hours after citadel-test's limit). So each file also starts a reaper, in a session of its own and in nobody's tree, that
// waits for the file's process to go (and kills it when the runner is gone first: nobody is left to hear it) and, if its
// folder is still there, does the same cleanup.
// Node builtins only: it loads in every test file, before the file's own imports.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isMainThread } from 'node:worker_threads';

/** The runner's pid, set by globalSetup: only its direct children (the test files) count. */
export const PARENT_ENV = 'CITADEL_LEAK_FILES';
/** The file's own id, inherited by everything it starts. */
export const FILE_ENV = 'CITADEL_LEAK_FILE';
/** What globalSetup adds to NODE_OPTIONS. The file takes it out again, so what a test starts doesn't load this. */
export const IMPORT_FLAG = `--import="${join(import.meta.dirname, 'leak-file.ts')}"`;
const BASELINE = join(import.meta.dirname, 'leak-baseline.json');

export interface Leftovers {
  /** [pid, command line] */
  procs: [number, string][];
  /** User units those processes run in, other than the file's own. */
  units: string[];
  /** [port, pid] of each listening TCP socket they hold. */
  ports: [number, number][];
  /** Entries left in the file's temp folder. */
  tmp: string[];
}
export type Kind = 'procs' | 'units' | 'ports' | 'tmp';
export const KINDS: Kind[] = ['procs', 'units', 'ports', 'tmp'];

export interface Proc {
  pid: number;
  ppid: number;
  args: string[];
}

export function readProcs(): Proc[] {
  const uid = process.getuid!();
  const out: Proc[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (statSync(`/proc/${name}`).uid !== uid) continue;
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (rest[0] === 'Z') continue; // exited, not yet reaped
      out.push({ pid: Number(name), ppid: Number(rest[1]), args: readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean) });
    } catch {} // gone meanwhile
  }
  return out;
}

const leaf = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').at(-1)!.split('/').at(-1)!;
  } catch {
    return '';
  }
};

/** inode -> port of every listening TCP socket in this network namespace. */
function listeners(): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[3] === '0A') out.set(c[9], parseInt(c[1].split(':').at(-1)!, 16));
    }
  }
  return out;
}

/**
 * What the file running as `self` has left: processes other than itself that are its descendants, carry `id` in their
 * environment, or name `dir` (or a path in it) on their command line; their units and listening ports; `dir`'s entries.
 */
export function leftovers(o: { self: number; id: string; dir: string }): Leftovers {
  const all = readProcs();
  const parent = new Map(all.map((p) => [p.pid, p.ppid]));
  const descends = (pid: number) => {
    for (let cur = parent.get(pid), i = 0; cur !== undefined && i < 64; cur = parent.get(cur), i++) if (cur === o.self) return true;
    return false;
  };
  const names = (args: string[]) => args.some((a) => a === o.dir || a.startsWith(`${o.dir}/`));
  const tagged = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`${FILE_ENV}=${o.id}`);
    } catch {
      return false;
    }
  };
  const procs = all.filter((p) => p.pid !== o.self && (descends(p.pid) || names(p.args) || tagged(p.pid)));
  const own = leaf(o.self);
  const units = [...new Set(procs.map((p) => leaf(p.pid)).filter((u) => u !== own && /\.(service|scope)$/.test(u)))];
  const socks = listeners();
  const ports: [number, number][] = [];
  if (socks.size) {
    for (const p of procs) {
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${p.pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        let to = '';
        try {
          to = readlinkSync(`/proc/${p.pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const port = to.startsWith('socket:[') ? socks.get(to.slice(8, -1)) : undefined;
        if (port !== undefined && !ports.some(([q]) => q === port)) ports.push([port, p.pid]);
      }
    }
  }
  let tmp: string[] = [];
  // tools/citadel-node's link to node and its compile cache: caches it makes in any TMPDIR, gone with the folder.
  try {
    tmp = readdirSync(o.dir)
      .filter((e) => !/^citadel-node-(\d+|cache)$/.test(e))
      .sort();
  } catch {}
  return { procs: procs.map((p) => [p.pid, p.args.join(' ')]), units, ports, tmp };
}

const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Leftovers, after giving what a teardown has just stopped up to `waitMs` to go. */
export function settledLeftovers(o: { self: number; id: string; dir: string }, waitMs = 2000): Leftovers {
  const end = Date.now() + waitMs;
  for (;;) {
    const left = leftovers(o);
    if (!left.procs.length || Date.now() >= end) return left;
    nap(50);
  }
}

/** Counts allowed per file and kind (test/leak-baseline.json): files that leaked before the guard, until fixed. */
export function readBaseline(file = BASELINE): Record<string, Partial<Record<Kind, number>>> {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** This user's live processes with an argument that is, or is inside, one of `dirs`: pid → command line. */
export function procsUnder(dirs: string[]): Map<number, string> {
  const found = new Map<number, string>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (statSync(`/proc/${name}`).uid !== process.getuid!()) continue;
      if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${name}/stat`, 'utf8'))) continue; // exited, not yet reaped
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args.some((a) => dirs.some((d) => a === d || a.startsWith(`${d}/`)))) found.set(Number(name), args.join(' '));
    } catch {} // gone meanwhile
  }
  return found;
}

/** The lines to print for `left`, judged against `allowed`: a failure for each kind over it, a note for one under it. */
export function judge(file: string, left: Leftovers, allowed: Partial<Record<Kind, number>> = {}): { fail: boolean; text: string } {
  const what: Record<Kind, (n: number) => string> = {
    procs: (n) => `${n} process(es) still running`,
    units: (n) => `${n} user unit(s) still running`,
    ports: (n) => `${n} TCP port(s) still listening`,
    tmp: (n) => `${n} entr(ies) left in its temp folder`,
  };
  const detail: Record<Kind, string[]> = {
    procs: left.procs.map(([pid, cmd]) => `${pid} ${cmd.slice(0, 400)}`),
    units: left.units,
    ports: left.ports.map(([port, pid]) => `${port} (pid ${pid})`),
    tmp: left.tmp.slice(0, 10).concat(left.tmp.length > 10 ? [`… and ${left.tmp.length - 10} more`] : []),
  };
  const over = KINDS.filter((k) => left[k].length > (allowed[k] ?? 0));
  const under = KINDS.filter((k) => allowed[k] !== undefined && left[k].length < allowed[k]!);
  const lines: string[] = [];
  if (over.length) {
    lines.push(`leak guard: ${file} left these behind after its teardown (now cleaned up):`);
    for (const k of over) lines.push(`  ${what[k](left[k].length)}${allowed[k] ? ` (its baseline allows ${allowed[k]})` : ''}:`, ...detail[k].map((d) => `    ${d}`));
    lines.push('  Stop and remove what a test starts in its own teardown: bootServer and stopProcs in test/helpers.ts, a temp folder in a finally or after (.claude/rules/tests.md).');
  }
  for (const k of under) lines.push(`leak guard: ${file} now leaves ${left[k].length} where test/leak-baseline.json allows ${allowed[k]} (${k}): lower it.`);
  return { fail: over.length > 0, text: lines.join('\n') };
}

/** The user unit a process runs in, if it is one of citadel's or systemd-run's own (never a CI runner's own service). */
function userUnit(pid: number): string {
  try {
    const path = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').at(-1)!;
    const unit = path.split('/').at(-1)!;
    return path.includes(`/user@${process.getuid!()}.service/`) && /^(citadel-|run-).*\.(service|scope)$/.test(unit) ? unit : '';
  } catch {
    return '';
  }
}

/**
 * Stop what `find` names, and what that starts meanwhile (a supervisor systemd had still to start, #1900), until it has found
 * nothing for `quietMs`: its user units by unit (a supervisor KILLed would restart), the rest by pid. Returns what is left
 * after `waitMs`. `group` also kills each one's process group, for a `find` that only names whole groups.
 */
export function stopAll(find: () => number[], { waitMs = 20_000, quietMs = 500, group = false } = {}): number[] {
  const end = Date.now() + waitMs;
  const own = userUnit(process.pid);
  const tried = new Set<string>();
  for (let seen = 0; ; nap(50)) {
    const found = find();
    if (!found.length) {
      if (Date.now() - seen >= quietMs) return [];
      continue;
    }
    if (Date.now() >= end) return found;
    const units = [...new Set(found.map(userUnit))].filter((u) => u && u !== own && !tried.has(u));
    if (units.length) {
      for (const u of units) tried.add(u);
      try {
        const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}` };
        execFileSync('systemctl', ['--user', 'stop', ...units], { stdio: 'ignore', timeout: 15_000, env });
      } catch {}
    }
    for (const pid of found) {
      if (units.includes(userUnit(pid))) continue; // its unit is still stopping: KILLed on the next look
      try {
        process.kill(group ? -pid : pid, 'SIGKILL'); // a process may lead a group with children of its own
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    seen = Date.now();
  }
}

/** Stop what the file left and remove its folder. */
export function cleanUp(o: { self: number; id: string; dir: string }) {
  const own = () => leftovers(o).procs.map(([pid]) => pid);
  if (own().length) stopAll(own, { group: true });
  rmSync(o.dir, { recursive: true, force: true, maxRetries: 3 }); // timing-ok: the guard's own last step, after the file's teardown
}

/** A root after() that throws also sets the exit code: node holds its failure event back behind an earlier file that is
 *  still running, so a run stopped at its limit would count this file green (tools/citadel-test, #1925). */
function afterFailsTheFile() {
  const nodeTest = createRequire(import.meta.url)('node:test');
  const after = nodeTest.after;
  const mark = (e: unknown): never => {
    process.exitCode ||= 1;
    throw e;
  };
  nodeTest.after = (fn: (...a: unknown[]) => unknown, options?: unknown) => {
    function withDone(this: unknown, t: unknown, done: (e?: unknown) => void) {
      return fn.call(this, t, (e?: unknown) => {
        if (e) process.exitCode ||= 1;
        done(e);
      });
    }
    function plain(this: unknown, t: unknown) {
      try {
        const r = fn.call(this, t);
        return r instanceof Promise ? r.catch(mark) : r;
      } catch (e) {
        return mark(e);
      }
    }
    return after(typeof fn !== 'function' ? fn : fn.length >= 2 ? withDone : plain, options);
  };
  syncBuiltinESMExports();
}

/** The reaper's own variables: the file it waits for. Not FILE_ENV or an argument, so nobody counts it as a leftover. */
const REAP_ID = 'CITADEL_LEAK_REAP_ID';
const REAP_DIR = 'CITADEL_LEAK_REAP_DIR';

/** Wait for `pid` or its `runner` to go, and take the file with the runner; if it left `dir` behind it never cleaned up, so run this module again to do that. */
function startReaper(pid: number, runner: number, id: string, dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, [REAP_ID]: id, [REAP_DIR]: dir };
  delete env[FILE_ENV]; // an outer file's, in a nested run
  const wait = 'while kill -0 "$1" && kill -0 "$2"; do sleep 0.5; done; kill -0 "$2" || kill -KILL "$1"; sleep 0.5; [ ! -d "$CITADEL_LEAK_REAP_DIR" ] || exec "$3" --no-warnings "$4"';
  // The outer sh returns at once, so the reaper is init's child, not the file's.
  spawnSync('sh', ['-c', 'setsid sh -c "$0" reap "$@" </dev/null >/dev/null 2>&1 &', wait, String(pid), String(runner), process.execPath, import.meta.filename], { env, stdio: 'ignore' });
}

function install() {
  afterFailsTheFile();
  const id = randomUUID();
  delete process.env[PARENT_ENV];
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '').replace(IMPORT_FLAG, '').replace(/\s+/g, ' ').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  process.env[FILE_ENV] = id;
  const dir = mkdtempSync(join(tmpdir(), 'f-'));
  process.env.TMPDIR = dir;
  const file = relative(import.meta.dirname, process.argv[1] ?? '?');
  startReaper(process.pid, process.ppid, id, dir);
  // After every 'exit' listener: some remove a test's scratch folder or stop its child there (test/helpers.ts testPins).
  const emit = process.emit;
  process.emit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]) {
    const r = (emit as (...a: unknown[]) => boolean).call(this, event, ...args);
    if (event === 'exit') {
      try {
        const own = { self: process.pid, id, dir };
        const left = settledLeftovers(own);
        const allowed = readBaseline()[file];
        if (allowed || KINDS.some((k) => left[k].length)) {
          // a baselined file that left nothing still hears to lower it
          const { fail, text } = judge(file, left, allowed);
          if (text) process.stderr.write(`\n${text}\n`);
          if (fail && !process.exitCode) process.exitCode = 1;
        }
        cleanUp(own);
      } catch (err) {
        process.stderr.write(`\nleak guard: counting what ${file} left failed: ${(err as Error).stack}\n`);
      }
    }
    return r;
  } as typeof process.emit;
}

const reap = process.env[REAP_DIR];
if (reap && process.argv[1] === import.meta.filename) cleanUp({ self: process.pid, id: process.env[REAP_ID]!, dir: reap });
else if (isMainThread && process.env[PARENT_ENV] && process.env[PARENT_ENV] === String(process.ppid)) install();
