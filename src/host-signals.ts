// The box's own signals (#1485): CPU, memory and IO pressure, load, memory, CPU counters and cgroups. The server reads
// them only through here (test/host-signals.test.ts checks), so a server a test boots (CITADEL_HOST_SIGNALS=fixed,
// bootServer's default) never sees the real box: a busy box paused a test server's indexers (#1301). Pinned, it reads
// fixed text for the files below and finds no other /proc or /sys file (so no cgroup). Live, every read is the real one.
// The clock is not here: a test seeds its fixtures from the same real clock, so shifting only the server's broke them (handoffs/test-clock-shared.md).
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism, loadavg as realLoadavg } from 'node:os';

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
/** The cores this process may use. */
export const cores = (): number => (FIXED ? FIXED_CORES : availableParallelism());
