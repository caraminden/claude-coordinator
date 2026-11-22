// A server a test started goes when the test's process does (#1546). CITADEL_EXIT_WITH_PARENT=1 (test/helpers.ts sets it,
// the live server, dev copies, previews and containers don't) makes it watch its parent: killed from outside, or ended
// by --test-force-exit, the test never reaches its teardown, and the server was left spinning with its turn supervisors.
// On finding itself reparented it kills what still names its data folder (the supervisors and turns it started: both
// outlive a server on purpose, in units of their own) and exits.
import { readFile, readdir, stat } from 'node:fs/promises';

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

/** SIGKILL what names `dir`: each one's process group first (claude leads one with its tools in it), then the pid. */
export async function killNaming(dir: string) {
  for (const pid of await procsNaming(dir)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

/** Does nothing unless CITADEL_EXIT_WITH_PARENT=1. `check(name, ms, fn)` is the server's `every`. */
export function exitWithParent(dataDir: string, check: (name: string, ms: number, fn: () => void) => unknown, parent = process.ppid, env = process.env, exit: (code: number) => void = process.exit) {
  if (env.CITADEL_EXIT_WITH_PARENT !== '1') return;
  let going = false;
  check('test parent check', 1000, () => {
    if (process.ppid === parent || going) return;
    going = true;
    killNaming(dataDir).finally(() => exit(0));
  });
}
