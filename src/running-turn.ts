// A running turn, whatever kind of process it is (#1937, docs/adr/0024): the runner signals it, stops it, asks whether it
// is alive and takes it up again after a restart through RunningTurn, and only this file knows how each kind does that.
// Starting a turn and reading its stream are the runner's and the turn folder's, the same for every kind.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineTurn, placedAt, placedNow } from './machine-turn.ts';
import { checkProcess, type ProcCheck } from './quiet.ts';
import { supervisorAlive } from './supervisor-client.ts';
import { START_GRACE_MS, wrapperAlive as hostOrContainerAlive, wrapperAliveOff as hostOrContainerAliveOff, wrapperInProc } from './wrapper-alive.ts';

export { START_GRACE_MS, wrapperInProc };

/** Where a turn runs, as its saved record says it: in a container, in a unit (or a scope of that name), or as the server's child. */
export interface TurnAt {
  dir: string;
  unit: string | null;
  container: string | null;
  /** The machine it runs on, null here, as a followed turn knows it; left out, the folder's `machine` file says. */
  machine?: { id: number; name: string } | null;
}

export interface RunningTurn {
  /**
   * Signal its claude and, as it runs in its own process group, its tool subprocesses too. Its pid is read off the
   * server's thread (#2134), unless `pid` hands it in (0: not started); resolves once the signal is sent.
   */
  signal(sig: NodeJS.Signals, pid?: number): Promise<void>;
  /** After its SIGTERM, for a turn stopped before its claude started: end it, where nothing else will. */
  endStart(): Promise<void>;
  /** Its wrapper (or the shell a supervisor runs in its place) runs; null: not started yet, or never will be. Reads on the thread: for boot. */
  alive(): boolean | null;
  /** alive(), its files read off the server's thread: what a followed turn's poll asks (#2134). */
  aliveOff(): Promise<boolean | null>;
  /** Whether a server that didn't start it can follow it: false when its start died with the last server. */
  reattachable(): boolean;
  /** It runs on through a restart of this server. */
  readonly outlivesServer: boolean;
  /** What it runs in, for the log, when that has a name of its own. */
  readonly where: string | null;
  /** What it needs to go on running, looked at now and then while it's followed: `ensureSupervisor` when its supervisor is gone. */
  keepUp(ensureSupervisor: () => void): Promise<void>;
  /** "Is this still going?" (#906): a look at its process. */
  look(): Promise<ProcCheck>;
}

/** The running turn at `at`. Holds nothing: made where it's asked, from where the turn runs now (a unit that won't start leaves a child). */
export function runningTurn(at: TurnAt): RunningTurn {
  // A turn on a connected machine has neither, and its folder's `machine` file (Build 7 T2): read only then, so a unit's or a container's turn costs no file read.
  return turnOf(at, at.container || at.unit ? null : at.machine !== undefined ? at.machine : placedAt(at.dir));
}

/** runningTurn, its `machine` file read off the server's thread: for a followed turn's poll and stop (#2134). */
export async function runningTurnOff(at: TurnAt): Promise<RunningTurn> {
  return turnOf(at, at.container || at.unit ? null : at.machine !== undefined ? at.machine : await placedNow(at.dir));
}

function turnOf(at: TurnAt, machine: { id: number; name: string } | null): RunningTurn {
  if (at.container) return new ContainerTurn(at.dir, at.container);
  if (machine) return new MachineTurn(at.dir, machine);
  return at.unit ? new UnitTurn(at.dir, at.unit) : new ChildTurn(at.dir);
}

/** alive() for a turn's folder alone, as the sweeps and strays know it: a container turn's has the `container` file, a machine's turn the `machine` file. */
export function wrapperAlive(dir: string): boolean | null {
  const machine = placedAt(dir);
  return machine ? new MachineTurn(dir, machine).alive() : hostOrContainerAlive(dir);
}

/** wrapperAlive off the server's thread, for the stray wait (#2134). */
export async function wrapperAliveOff(dir: string): Promise<boolean | null> {
  const machine = await placedNow(dir);
  return machine ? new MachineTurn(dir, machine).aliveOff() : hostOrContainerAliveOff(dir);
}

/** A turn's pids (pid.json), or {} before it has any: read on the thread, for a look a person asked for. */
function pids(dir: string): { wrapper?: number; claude?: number; supervisor?: unknown } {
  try {
    return JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) ?? {};
  } catch {
    return {}; // not started yet, or just ended
  }
}

/** pids, read off the server's thread (#2134). */
async function pidsOff(dir: string): Promise<{ wrapper?: number; claude?: number; supervisor?: unknown }> {
  try {
    return JSON.parse(await readFile(join(dir, 'pid.json'), 'utf8')) ?? {};
  } catch {
    return {};
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

  async signal(sig: NodeJS.Signals, pid?: number) {
    this.signalClaude(sig, pid ?? (await pidsOff(this.dir)).claude);
  }

  /** Signal claude's process group; false when it has no pid yet. */
  protected signalClaude(sig: NodeJS.Signals, pid: number | undefined): boolean {
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

  async endStart() {}

  alive() {
    return hostOrContainerAlive(this.dir);
  }

  aliveOff() {
    return hostOrContainerAliveOff(this.dir);
  }

  reattachable() {
    return true;
  }

  async keepUp(_ensureSupervisor: () => void) {}

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

  override async signal(sig: NodeJS.Signals, pid?: number) {
    const signalled = this.signalClaude(sig, pid ?? (await pidsOff(this.dir)).claude);
    // Its other processes (claude not started yet, or something it left behind) go with the unit.
    // By pattern: the turn's wrapper unit (name.service) or its scope from the supervisor (name.scope, #1343); a pattern
    // that matches nothing is no error, where a missing unit named outright would stop the whole call.
    if (!signalled || sig === 'SIGKILL') execFile('systemctl', ['--user', 'stop', `${this.where}.*`], () => {});
  }

  /**
   * A turn whose supervisor is gone (stopped, or a crash its unit didn't restart) runs on in its scope, but its shared
   * tool server forgets it within 30 s unless a supervisor adopts it: start one, which adopts it at start.
   */
  override async keepUp(ensureSupervisor: () => void) {
    const sup = (await pidsOff(this.dir)).supervisor;
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

  async signal(sig: NodeJS.Signals, given?: number) {
    const pid = given ?? (await pidsOff(this.dir)).claude;
    if (!pid) return; // not started yet, and no unit to stop
    const s = sig.replace(/^SIG/, '');
    execFile('podman', ['exec', this.container, 'sh', '-c', `kill -${s} -${pid} 2>/dev/null || kill -${s} ${pid}`], () => {});
  }

  /**
   * With no claude yet it has no pid or unit to signal, and a start that hangs never gets one: this ends it at the next
   * poll. `stopped` tells the runner it is not the wrapper's, should claude start after all.
   */
  async endStart() {
    await writeFile(join(this.dir, 'exit.json'), JSON.stringify({ code: null, signal: null, stopped: true }));
  }

  alive() {
    return hostOrContainerAlive(this.dir);
  }

  aliveOff() {
    return hostOrContainerAliveOff(this.dir);
  }

  /**
   * One the last server was still starting (#468 S03-5): its start chain beat for it and died with that server, so a
   * fresh beat says nothing. With no wrapper run (no pid.json) and nothing left to start one, it was interrupted.
   * The process scan goes first: a wrapper that ends during it has written its files by the time they are checked.
   */
  reattachable() {
    return wrapperInProc(this.dir, true) || ['pid.json', 'exit.json'].some((f) => existsSync(join(this.dir, f)));
  }

  async keepUp(_ensureSupervisor: () => void) {}

  async look(): Promise<ProcCheck> {
    return { verdict: 'unknown', text: "This turn runs in a container, so the server can't look at its process." };
  }
}
