// The box's own signals (#1485): CPU, memory and IO pressure, load, memory, CPU counters, cgroups, and the zone that
// decides which day and hour it is. The server reads them only through here (test/host-signals-guards.test.ts checks), so a
// server a test boots (CITADEL_HOST_SIGNALS=fixed, bootServer's default) never sees the real box: a busy box paused a
// test server's indexers (#1301) and a test went red after midnight (#1421). Pinned, it reads fixed text for the files
// below, finds no other /proc or /sys file (so no cgroup), and reads its day and hour in the zone the test hands it
// (CITADEL_ZONE, #1536), the same zone the test's own fixtures use (test/helpers.ts's TEST_ZONE). Live, every read is the real one.
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { cpus, loadavg as realLoadavg } from 'node:os';

export const FIXED = process.env.CITADEL_HOST_SIGNALS === 'fixed';

export const PSI_FILES = { cpu: '/proc/pressure/cpu', memory: '/proc/pressure/memory', io: '/proc/pressure/io' } as const;
export const MEMINFO = '/proc/meminfo';
export const PROC_STAT = '/proc/stat';
/** This process's cgroup line ("0::/user.slice/..."). */
export const SELF_CGROUP = '/proc/self/cgroup';
export const CGROUP_ROOT = '/sys/fs/cgroup';

const PSI = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
/** A quiet 4-core box with 16 GB, half of it free. */
const FIXED_FILES: Record<string, string> = {
  [PSI_FILES.cpu]: PSI, [PSI_FILES.memory]: PSI, [PSI_FILES.io]: PSI,
  [MEMINFO]: 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
  [PROC_STAT]: 'cpu  0 0 0 0 0 0 0 0 0 0\nprocesses 0\n',
};
const FIXED_CORES = 4;

const pinned = (path: string) => FIXED && /^\/(proc|sys)\//.test(path);
const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}' (host signals are fixed)`), { code: 'ENOENT' });
const fixedText = (path: string): string => {
  const text = FIXED_FILES[path];
  if (text === undefined) throw missing(path);
  return text;
};

/** A host file's text. Pinned, a /proc or /sys path gives the fixed text or ENOENT; any other path (a test's own file) is read as it is. */
export const hostText = async (path: string): Promise<string> => (pinned(path) ? fixedText(path) : readFile(path, 'utf8'));
export const hostTextSync = (path: string): string => (pinned(path) ? fixedText(path) : readFileSync(path, 'utf8'));
/** A host directory's entries (a cgroup's children); pinned, a /proc or /sys path has none (ENOENT). */
export const hostDir = async (path: string): Promise<string[]> => {
  if (pinned(path)) throw missing(path);
  return readdir(path);
};

/** The 1, 5 and 15 minute load averages. */
export const loadavg = (): number[] => (FIXED ? [0, 0, 0] : realLoadavg());
/** The box's cores, for load. Not `availableParallelism()`: inside the service's CPUQuota that reads the cgroup cap (8 of perigee's 16), while load counts the whole box (#1539). */
export const cores = (): number => (FIXED ? FIXED_CORES : Math.max(1, cpus().length));

/**
 * The whole-hour zone (Etc/GMT±N: no daylight saving) on Pacific's date at `ms` whose clock reads as near 12:00 as
 * Etc's range allows: 12:00 until Pacific's 4 or 5 PM, then up to 19:59. A test's fixtures dated in Pacific see the same
 * day, and no midnight or 2-9 AM falls in the hours a test runs.
 */
export function dayZone(ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(ms).map((x) => [x.type, x.value])); // pacific-ok: the date the fixed zone keeps
  const pacificOffset = Number(/GMT([+-]\d+)/.exec(p.timeZoneName)![1]); // -8 or -7
  const offset = Math.max(-12, pacificOffset + 12 - Number(p.hour)); // Etc reaches 12 hours behind UTC at most
  // Offset 0 is 'UTC': ICU resolves Etc/GMT to UTC, so TZ=Etc/GMT would read back under another name.
  return offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`; // Etc's sign is POSIX's, the reverse of ISO's
}

/** Whether Intl knows `zone`. */
export function knownZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pinned: the zone src/pacific.ts's ZONE and the local clock use in place of Pacific. It is the one the test hands over
 * (CITADEL_ZONE), so the server and the test's fixtures read the same day and hour; a spawn that forgot it (the guard
 * catches those in tests) picks its own afternoon zone. Null live.
 */
export const FIXED_ZONE = FIXED ? (knownZone(process.env.CITADEL_ZONE) ? process.env.CITADEL_ZONE : dayZone(Date.now())) : null;
if (FIXED_ZONE) {
  process.env.TZ = FIXED_ZONE; // Node re-reads TZ when it is set: getHours, setHours and formatters with no zone follow
  process.env.CITADEL_ZONE = FIXED_ZONE; // a preview this test server starts reads the same zone
}
