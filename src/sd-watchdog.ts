// systemd's watchdog (#1135): with WatchdogSec= on the unit (deploy/claude-coordinator.service.d/watchdog.conf), systemd
// restarts the server once its pings stop. They come from a timer on the event loop, so a hung loop stops them, where a
// crash already restarted it (Restart=always) and a hang didn't. Node can't send to systemd's datagram socket itself,
// so each ping is a `systemd-notify WATCHDOG=1`, which the unit's NotifyAccess=all accepts from a child.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The mark ExecStopPost leaves in DATA_DIR when the watchdog stopped the server, read and removed at the next boot. */
export const MARK = 'watchdog-restart.json';

type Env = Record<string, string | undefined>;

/** How often to ping, in ms: a quarter of the limit, at most 15 s. Null when systemd isn't watching this process. */
export function pingEvery(env: Env, pid: number): number | null {
  const usec = Number(env.WATCHDOG_USEC);
  if (!env.NOTIFY_SOCKET || !(usec > 0) || (env.WATCHDOG_PID && Number(env.WATCHDOG_PID) !== pid)) return null;
  return Math.min(15_000, usec / 4000);
}

function systemdNotify(socket: string, done: (err: Error | null) => void) {
  execFile('systemd-notify', ['WATCHDOG=1'], { env: { ...process.env, NOTIFY_SOCKET: socket }, timeout: 10_000 }, (err) => done(err));
}

/**
 * Ping systemd from the event loop while it watches this process; null when it doesn't. Takes systemd's variables out
 * of `env` either way, so the server's children (git, gh, turn helpers) can't ping for it.
 */
export function startWatchdog(env: Env = process.env, { pid = process.pid, log = console.warn, notify = systemdNotify } = {}): { stop(): void } | null {
  const every = pingEvery(env, pid);
  const socket = env.NOTIFY_SOCKET!;
  const limit = Number(env.WATCHDOG_USEC) / 1e6;
  for (const k of ['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'WATCHDOG_PID']) delete env[k];
  if (!every) return null;
  let failed = 0;
  const ping = () => notify(socket, (err) => {
    if (err && failed++ % 20 === 0) log(`systemd watchdog ping failed (${failed} so far): ${err.message}`);
  });
  ping();
  const timer = setInterval(ping, every).unref();
  log(`systemd's watchdog is on: a ping every ${every / 1000} s, a restart after ${limit} s without one.`);
  return { stop: () => clearInterval(timer) };
}

/** ExecStopPost's step (tools/watchdog-exit.ts): a stop the watchdog caused leaves the mark. True if it did. */
export function markExit(env: Env, dataDir: string, now = Date.now()): boolean {
  if (env.SERVICE_RESULT !== 'watchdog') return false;
  writeFileSync(join(dataDir, MARK), JSON.stringify({ at: now }));
  return true;
}

/** At boot: when the watchdog stopped the last run, from its mark (removed, so it counts once), or null. */
export function takeMark(dataDir: string): number | null {
  const file = join(dataDir, MARK);
  try {
    return Number(JSON.parse(readFileSync(file, 'utf8')).at) || null;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The health event's text for a watchdog restart at `at`. The hang itself leaves no stall line (its stall never ended),
 * so this names the last one recorded before it.
 * shortcut: no stack of the hang itself; if restarts come with no telling last stall, a worker could pause the main
 * thread through node:inspector's connectToMainThread at half the limit and save its call frames.
 */
export function restartDetail(at: number, last: { at: number; detail: string } | null): string {
  const before = last ? `The last stall before it, ${Math.round((at - last.at) / 1000)} s earlier: ${last.detail}` : 'No stall was recorded before it.';
  return `systemd's watchdog restarted the server: its event loop stopped pinging. ${before}`;
}
