// Huge pages only where a program asks for them, for every service unit Citadel starts (#1458). The box runs huge pages
// `always` with defrag `defer+madvise`: each huge page a fault can't get wakes the reclaimer, which then threw away
// 30 GB of file cache in 3 minutes with 5 GB free (reports/server-stalls-deep-dive-2026-11-21.md, class 1), the
// database's pages with it, so the server's reads went to disk. Most of those requests came from Citadel's own groups.
// A service unit starts from systemd, not from the server, so it doesn't inherit the server's setting (priority.conf);
// a scope (`--scope`) does inherit from the process that starts it, and refuses the property ("Unknown assignment").
// An app's unit files (src/app-services.ts unitFiles) carry the line and take it at the app's next deploy.
// The setting carries across fork and exec, so a container's processes and a turn's tools get it too.
// It needs systemd 260+: an older systemd-run refuses the whole unit ("Unknown assignment"; CI's runners have one), so
// the server asks systemd's version once at boot (probeThp) and thpProps() gives the property only where it's known.
// An unknown key in a unit file is only a warning, so THP_LINE always goes in.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const THP_LINE = 'MemoryTHP=madvise';
const FIRST = 260;

/** The version `systemd-run --version` prints first ("systemd 262 (262.2-1-arch)"), or 0. */
export function systemdVersion(out: string): number {
  return Number(/^systemd (\d+)/.exec(out.trim())?.[1] ?? 0);
}

let known = false;
/** At boot, before any unit starts: whether this systemd takes MemoryTHP=. */
export async function probeThp(): Promise<void> {
  try { known = systemdVersion((await promisify(execFile)('systemd-run', ['--version'], { timeout: 5000 })).stdout) >= FIRST; }
  catch { known = false; }
}
/** systemd-run's arguments for it, or none where systemd is too old. A unit file takes THP_LINE in [Service]. */
export function thpProps(): string[] {
  return known ? ['-p', THP_LINE] : [];
}
/** Tests pin it, so an argv snapshot doesn't depend on the host's systemd. */
export function setThpSupport(on: boolean): void { known = on; }
