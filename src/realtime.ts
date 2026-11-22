// The server's main thread goes first in line for a core (#1561). At a box load of 60 to 130 it spent 9% of its time
// runnable but waiting for one (reports/server-responsiveness-2026-11.md). Node can't set a scheduling policy, so
// `chrt -R -r -p 1 <pid>` sets SCHED_RR priority 1 on the main thread (its tid is the pid); -R makes children it forks
// start at SCHED_OTHER again; the kernel applies that flag to the threads it creates too (libuv's pool, Workers: the
// test checks them), so only the main thread is real-time. A spinning real-time thread holds a core until the systemd watchdog
// (src/sd-watchdog.ts) kills the server after 60 s, which bounds it; never raise the priority or add threads.
// Off again is `chrt -R -o -p 0`: the kernel won't let an unprivileged process clear reset-on-fork once set.
// Failing to set it (no permission, no chrt) logs one line and carries on at normal priority.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const SCHED_OTHER = 0;
export const SCHED_RR = 2;

/** A thread's scheduling policy and real-time priority from /proc (stat fields 41 and 40), or null if it is gone. */
export async function readSched(pid: number, tid: number, proc = '/proc'): Promise<{ policy: number; prio: number } | null> {
  try {
    const f = await readFile(`${proc}/${pid}/task/${tid}/stat`, 'utf8');
    const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return { prio: Number(rest[37]), policy: Number(rest[38]) };
  } catch {
    return null;
  }
}

function chrt(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile('chrt', args, { timeout: 10_000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve())));
}

export interface RealtimeOpts {
  /** Whether it should be on, asked at each tick so a setting takes effect without a restart. */
  enabled: () => boolean;
  pid?: number;
  log?: (line: string) => void;
  run?: (args: string[]) => Promise<void>;
  everyMs?: number;
  proc?: string;
}

/** Keep the main thread at SCHED_RR 1 (reset-on-fork) while `enabled()`; undo it when it isn't. */
export function startRealtime(o: RealtimeOpts): { tick(): Promise<void>; stop(): void } {
  const { pid = process.pid, log = console.warn, run = chrt, proc = '/proc' } = o;
  let on = false;
  let broken = false;
  let inflight: Promise<void> | null = null;
  const tick = (): Promise<void> => (inflight ??= step().finally(() => (inflight = null)));
  const step = async () => {
    if (broken) return;
    try {
      let want = false;
      try {
        want = o.enabled();
      } catch {} // a failed read of the setting is no reason to give up for good
      const main = await readSched(pid, pid, proc);
      const isRr = main?.policy === SCHED_RR;
      if (want && !isRr) {
        await run(['-R', '-r', '-p', '1', String(pid)]);
        on = true;
        log('Server main thread is now SCHED_RR priority 1 with reset-on-fork (src/realtime.ts); turn it off with the realtime_priority setting.');
      } else if (!want && isRr && on) {
        await run(['-R', '-o', '-p', '0', String(pid)]);
        on = false;
        log('Server main thread is back at normal priority.');
      }
    } catch (e) {
      broken = true; // one line, then normal priority for good: a retry every tick would just repeat it
      log(`Real-time priority for the server's main thread is not set, carrying on at normal priority: ${(e as Error).message}`);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), o.everyMs ?? 15_000).unref();
  return { tick, stop: () => clearInterval(timer) };
}
