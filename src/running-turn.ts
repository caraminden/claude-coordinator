// A running turn, whatever kind of process it is (#1937, docs/adr/0024): the runner signals it, stops it, asks whether it
// is alive and takes it up again after a restart through RunningTurn, and only this file knows how each kind does that.
// Starting a turn and reading its stream are the runner's and the turn folder's, the same for every kind.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProcess, type ProcCheck } from './quiet.ts';
import { supervisorAlive } from './supervisor-client.ts';
import { alive } from './turn-launch.ts';

/** Where a turn runs, as its saved record says it: in a container, in a unit (or a scope of that name), or as the server's child. */
export interface TurnAt {
  dir: string;
  unit: string | null;
  container: string | null;
}

export interface RunningTurn {
  /** Signal its claude and, as it runs in its own process group, its tool subprocesses too. */
  signal(sig: NodeJS.Signals): void;
  /** After its SIGTERM, for a turn stopped before its claude started: end it, where nothing else will. */
  endStart(): void;
  /** Its wrapper (or the shell a supervisor runs in its place) runs; null: not started yet, or never will be. */
  alive(): boolean | null;
  /** Whether a server that didn't start it can follow it: false when its start died with the last server. */
  reattachable(): boolean;
  /** It runs on through a restart of this server. */
  readonly outlivesServer: boolean;
  /** What it runs in, for the log, when that has a name of its own. */
  readonly where: string | null;
  /** What it needs to go on running, looked at now and then while it's followed: `ensureSupervisor` when its supervisor is gone. */
  keepUp(ensureSupervisor: () => void): void;
  /** "Is this still going?" (#906): a look at its process. */
  look(): Promise<ProcCheck>;
}

/** The running turn at `at`. Holds nothing: made where it's asked, from where the turn runs now (a unit that won't start leaves a child). */
export function runningTurn(at: TurnAt): RunningTurn {
  if (at.container) return new ContainerTurn(at.dir, at.container);
  return at.unit ? new UnitTurn(at.dir, at.unit) : new ChildTurn(at.dir);
}

/** A turn whose wrapper hasn't said it runs (no pid.json or beat yet) counts as still starting for this long. */
export const START_GRACE_MS = 60_000;
/** A container turn's wrapper beat (src/turn-wrapper.mjs) longer ago than this is stale: checked against /proc then. */
const BEAT_STALE_MS = 30_000;

/** alive() for a turn's folder alone, as the sweeps and strays know it: a container turn's has the `container` file. */
export function wrapperAlive(dir: string): boolean | null {
  return (existsSync(join(dir, 'container')) ? containerAlive : hostAlive)(dir);
}

/** A turn's pids (pid.json), or {} before it has any. */
function pids(dir: string): { wrapper?: number; claude?: number; supervisor?: unknown } {
  try {
    return JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) ?? {};
  } catch {
    return {}; // not started yet, or just ended
  }
}

/** A turn run by this server as its own detached child: what any turn here is when units are off or one won't start. */
class ChildTurn implements RunningTurn {
  readonly outlivesServer: boolean = false;
  readonly where: string | null = null;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  signal(sig: NodeJS.Signals) {
    this.signalClaude(sig);
  }

  /** Signal claude's process group; false when it has no pid yet. */
  protected signalClaude(sig: NodeJS.Signals): boolean {
    const pid = pids(this.dir).claude;
    if (!pid) return false;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    }
    return true;
  }

  endStart() {}

  alive() {
    return hostAlive(this.dir);
  }

  reattachable() {
    return true;
  }

  keepUp(_ensureSupervisor: () => void) {}

  look() {
    const p = pids(this.dir);
    let pid = Number(p.claude) || null;
    try {
      // A supervisor turn's `claude` is its shell (#1343, turn-run.mjs SHIM), the process group to signal; claude is its one child.
      if (pid && p.supervisor) pid = Number(readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/)[0]) || pid;
    } catch {
      /* just ended */
    }
    return checkProcess(pid);
  }
}

/** A turn in a systemd user unit of its own: its wrapper's service, or its scope from the turn supervisor (#1343), by one name. */
class UnitTurn extends ChildTurn {
  override readonly outlivesServer = true;
  override readonly where: string;
  constructor(dir: string, unit: string) {
    super(dir);
    this.where = unit;
  }

  override signal(sig: NodeJS.Signals) {
    const signalled = this.signalClaude(sig);
    // Its other processes (claude not started yet, or something it left behind) go with the unit.
    // By pattern: the turn's wrapper unit (name.service) or its scope from the supervisor (name.scope, #1343); a pattern
    // that matches nothing is no error, where a missing unit named outright would stop the whole call.
    if (!signalled || sig === 'SIGKILL') execFile('systemctl', ['--user', 'stop', `${this.where}.*`], () => {});
  }

  /**
   * A turn whose supervisor is gone (stopped, or a crash its unit didn't restart) runs on in its scope, but its shared
   * tool server forgets it within 30 s unless a supervisor adopts it: start one, which adopts it at start.
   */
  override keepUp(ensureSupervisor: () => void) {
    const sup = pids(this.dir).supervisor;
    if (sup !== undefined && !supervisorAlive(sup)) ensureSupervisor();
  }
}

/** A turn in a person's container: its pids are the container's, so it is signalled from inside and lives by its heartbeat. */
class ContainerTurn implements RunningTurn {
  readonly outlivesServer = true;
  readonly where = null;
  readonly dir: string;
  readonly container: string;
  constructor(dir: string, container: string) {
    this.dir = dir;
    this.container = container;
  }

  signal(sig: NodeJS.Signals) {
    const pid = pids(this.dir).claude;
    if (!pid) return; // not started yet, and no unit to stop
    const s = sig.replace(/^SIG/, '');
    execFile('podman', ['exec', this.container, 'sh', '-c', `kill -${s} -${pid} 2>/dev/null || kill -${s} ${pid}`], () => {});
  }

  /**
   * With no claude yet it has no pid or unit to signal, and a start that hangs never gets one: this ends it at the next
   * poll. `stopped` tells the runner it is not the wrapper's, should claude start after all.
   */
  endStart() {
    writeFileSync(join(this.dir, 'exit.json'), JSON.stringify({ code: null, signal: null, stopped: true }));
  }

  alive() {
    return containerAlive(this.dir);
  }

  /**
   * One the last server was still starting (#468 S03-5): its start chain beat for it and died with that server, so a
   * fresh beat says nothing. With no wrapper run (no pid.json) and nothing left to start one, it was interrupted.
   * The process scan goes first: a wrapper that ends during it has written its files by the time they are checked.
   */
  reattachable() {
    return wrapperInProc(this.dir, true) || ['pid.json', 'exit.json'].some((f) => existsSync(join(this.dir, f)));
  }

  keepUp(_ensureSupervisor: () => void) {}

  async look(): Promise<ProcCheck> {
    return { verdict: 'unknown', text: "This turn runs in a container, so the server can't look at its process." };
  }
}

/** A turn's wrapper on this host still runs: its pid is alive and is that turn's wrapper, not a reused pid. */
function hostAlive(dir: string): boolean | null {
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')).wrapper;
  } catch {
    return null; // not started yet, or never will be
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir);
  } catch {
    return existsSync('/proc/self') ? false : alive(pid);
  }
}

/**
 * A container turn's heartbeat says whether it still runs, since its pids are the container's; a stale one is only gone
 * once no process here runs that turn's wrapper (wrapperInProc).
 */
function containerAlive(dir: string): boolean | null {
  let fresh: boolean;
  try {
    fresh = Date.now() - statSync(join(dir, 'beat')).mtimeMs < BEAT_STALE_MS;
  } catch {
    return null;
  }
  // A container at its MemoryHigh stalls every process in it, heartbeats too, for a minute or more: a stale beat
  // alone once deleted live turns' folders, pin/tripwire.ts with them, under claudes that ran on (#1255).
  return fresh || wrapperInProc(dir);
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
