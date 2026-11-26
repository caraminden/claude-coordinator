// Whether a turn's wrapper still runs, from its folder (pid.json, or a container turn's heartbeat) and /proc. The files
// are read on the server's thread only at boot (wrapperAlive); a followed turn's poll and the stray wait ask them off
// it (wrapperAliveOff, #2134). The /proc reads stay on the thread: kernel memory, no disk (#1980).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { alive } from './turn-launch.ts';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A turn whose wrapper hasn't said it runs (no pid.json or beat yet) counts as still starting for this long. */
export const START_GRACE_MS = 60_000;

/** A container turn's wrapper beat (src/turn-wrapper.mjs) longer ago than this is stale: checked against /proc then. */
const BEAT_STALE_MS = 30_000;

/**
 * A turn's wrapper still runs: its pid is alive and is that turn's wrapper, not a reused pid. In a
 * container (the `container` file) its pids are the container's, so its heartbeat says instead; a stale
 * one is only gone once no process here runs that turn's wrapper (wrapperInProc).
 */
export function wrapperAlive(dir: string): boolean | null {
  if (existsSync(join(dir, 'container'))) {
    let at: number;
    try {
      at = statSync(join(dir, 'beat')).mtimeMs;
    } catch {
      return null;
    }
    return beatAlive(dir, at);
  }
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')).wrapper;
  } catch {
    return null; // not started yet, or never will be
  }
  return pidIsWrapper(dir, pid);
}

/** wrapperAlive with the folder's files read off the server's thread: what a followed turn's poll and the stray wait ask (#2134). */
export async function wrapperAliveOff(dir: string): Promise<boolean | null> {
  if (await exists(join(dir, 'container'))) {
    const at = await stat(join(dir, 'beat')).then(
      (st) => st.mtimeMs,
      () => null,
    );
    return at === null ? null : beatAlive(dir, at);
  }
  let pid: number;
  try {
    pid = JSON.parse(await readFile(join(dir, 'pid.json'), 'utf8')).wrapper;
  } catch {
    return null;
  }
  return pidIsWrapper(dir, pid);
}

// A container at its MemoryHigh stalls every process in it, heartbeats too, for a minute or more: a stale beat
// alone once deleted live turns' folders, pin/tripwire.ts with them, under claudes that ran on (#1255).
const beatAlive = (dir: string, beatAt: number) => Date.now() - beatAt < BEAT_STALE_MS || wrapperInProc(dir);

/** Whether `pid` is alive and is the wrapper of the turn in `dir`, not a reused pid. */
function pidIsWrapper(dir: string, pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir);
  } catch {
    return existsSync('/proc/self') ? false : alive(pid);
  }
}

/** The pid of the claude of the turn in `dir` (0: not started), read on the thread: for boot, and a turn's end, whose folder goes in the same step. */
export function claudePidNow(dir: string): number {
  try {
    return JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')).claude;
  } catch {
    return 0;
  }
}

/** Whether a process this server can see has `arg` as one of its arguments; reads every process's cmdline. */
export function argInProc(arg: string): boolean {
  try {
    return readdirSync('/proc').some((pid) => {
      try {
        return /^\d+$/.test(pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(arg);
      } catch {
        return false; // ended meanwhile
      }
    });
  } catch {
    return false;
  }
}

/**
 * Whether a process this server can see runs `dir`'s wrapper (turn-launch's `<node> <pin>/turn-wrapper.mjs <dir>`). A rootless
 * container's processes are in the host's /proc under host pids, so a container turn's wrapper shows here while it lives,
 * stalled or not; once its container or exec dies it doesn't. Only for a stale heartbeat, or a container turn with no pid.json
 * at a restart (reattach): it reads every process's cmdline.
 */
export function wrapperInProc(dir: string, orStarting = false): boolean {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    // /proc fails to list only where it isn't mounted, not for a moment: the heartbeat's word stands, as before #1255.
    // (Unknown would be no kinder: running() reads it as gone once the turn is past its start grace.)
    return false;
  }
  for (const pid of pids) {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch {
      continue; // ended meanwhile
    }
    if (argv.at(-1) === '') argv.pop();
    // `<node> <pin>/turn-wrapper.mjs <dir>` exactly (`.ts` before #1343, still running across that deploy): a podman exec or
    // conmon whose argv also ends in dir isn't the wrapper, unless `orStarting` asks for the podman exec too (one in its own
    // scope outlives the server that ran it).
    if (argv.at(-1) === dir && (/\/turn-wrapper\.(mjs|ts)$/.test(argv.at(-2) ?? '') || (orStarting && argv.includes('exec')))) return true;
  }
  return false;
}
