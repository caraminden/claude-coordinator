// A server a test started goes when the test's process does (#1546). CITADEL_EXIT_WITH_PARENT (test/helpers.ts sets it to
// the test's pid, the live server, dev copies, previews and containers don't) makes it watch its parent: killed from outside,
// or ended by --test-force-exit, the test never reaches its teardown, and the server was left spinning with its turn supervisors.
// On finding itself reparented it kills what still names its data folder (the supervisors and turns it started: both
// outlive a server on purpose, in units of their own) and exits.
import { readFile, readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { supervisorHome } from './reaper.ts';

/** This user's live processes, other than `self`, with an argument that is or is inside `dir`. */
export async function procsNaming(dir: string, self = process.pid): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === self) continue;
    try {
      if ((await stat(`/proc/${name}`)).uid !== process.getuid!()) continue;
      if ((await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').some((a) => a === dir || a.startsWith(`${dir}/`))) found.push(Number(name));
    } catch {} // gone meanwhile
  }
  return found;
}

/**
 * Kill what names `dir`: each one's process group first (claude leads one with its tools in it), then the pid. SIGKILL,
 * but a turn supervisor gets SIGTERM: killed, its unit's Restart=on-failure would start it again (#1758). Looks again
 * until it has found nothing five times running, as systemd may have taken a supervisor's launch and not started it yet
 * (#1900): counted in looks, not time, so a stalled process doesn't use its quiet up without looking.
 */
export async function killNaming(dir: string, waitMs = 5000) {
  let quiet = 0;
  for (const end = Date.now() + waitMs; ; await sleep(100)) {
    const pids = await procsNaming(dir);
    quiet = pids.length ? 0 : quiet + 1;
    for (const pid of pids) {
      const signal = await readFile(`/proc/${pid}/cmdline`, 'utf8').then(
        (c) => (supervisorHome(c.split('\0')) ? 'SIGTERM' : 'SIGKILL'),
        () => 'SIGKILL' as const,
      );
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {}
      }
    }
    if (quiet >= 5 || Date.now() >= end) return;
  }
}

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Does nothing unless CITADEL_EXIT_WITH_PARENT is set: the test's pid, or 1 for whatever the parent is. `check(name, ms, fn)`
 * is the server's `every`. Returns what to await before any other exit: a TERM to the test's whole group (a suite stopped at
 * its limit) is a restart to the server, which leaves its turns for a next server that never comes (#1900).
 */
export function exitWithParent(dataDir: string, check: (name: string, ms: number, fn: () => void) => unknown, parent = process.ppid, env = process.env, exit: (code: number) => void = process.exit): () => Promise<void> {
  const named = Number(env.CITADEL_EXIT_WITH_PARENT);
  if (!(named > 0)) return async () => {};
  let going: Promise<void> | null = null;
  // The pid too: a server still booting when its test was killed had init for a parent from the start (#1900).
  const orphaned = () => process.ppid !== parent || (named > 1 && dead(named));
  const leave = async () => {
    if (going || orphaned()) await (going ??= killNaming(dataDir));
  };
  check('test parent check', 1000, () => {
    if (!going && orphaned()) void leave().finally(() => exit(0));
  });
  return leave;
}
