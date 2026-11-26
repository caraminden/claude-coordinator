// Automatic use (Build 7 M5, specs/machine-connections.md section 5): a minion uses what its scheme is lent without
// naming a machine. The pooled Windows tools (`mcp__windows__*`, Josh's pick "Pooled, names kept") pick a machine with
// the Windows screen role and keep the minion on it, so its checkout stays warm; a GPU job with no machine named goes to
// an eligible GPU machine. Pure, but for the sticky choices: the server (routes/machines.ts, routes/jobs.ts) finds the
// eligible machines.

/** The pooled Windows tools' MCP server name: `mcp__windows__*`. No machine may be called this (RESERVED_NAMES). */
export const POOLED_WINDOWS = 'windows';

/** A machine the pooled Windows tools may use now: its Windows screen role lent to the scheme, online, its workspace tools up. */
export type ScreenMachine = {
  id: number;
  name: string;
  /** Jobs holding or waiting in line for its screen. */ busy: number;
  /** Its owner's order (machines.priority, M6): 1 first, null after every one with an order. */ priority: number | null;
};

/** The owner's order (M6, Josh: "put work on machine 1 before using machine 2"): a machine with none stands after every one with one. */
const order = (m: { priority: number | null }) => m.priority ?? Infinity;

/**
 * Which machine a minion's pooled Windows tools use. The one it last used while that one is still eligible, even with
 * its screen busy (that may be the minion's own job), so its checkout stays warm; else, as M6 ranks machines, the
 * owner's first in order with its screen free, then the shortest screen line, then the lowest id. shortcut: the sticky
 * choice lives in the server's memory, so a restart forgets it; keep it in a setting if a minion losing its warm checkout
 * after a deploy matters.
 */
export class WindowsPool {
  private last = new Map<number, number>();

  pick(ticketId: number, eligible: readonly ScreenMachine[]): { machine: ScreenMachine; movedFrom: number | null } | null {
    const was = this.last.get(ticketId) ?? null;
    const stay = eligible.find((m) => m.id === was);
    const machine = stay ?? [...eligible].sort((a, b) => Number(a.busy > 0) - Number(b.busy > 0) || order(a) - order(b) || a.busy - b.busy || a.id - b.id)[0];
    if (!machine) return null;
    this.last.set(ticketId, machine.id);
    return { machine, movedFrom: stay || was === null ? null : was };
  }
}

/** A machine a GPU job may go to: its GPU jobs role lent to the scheme, with a jobs block, online and not paused. */
export type JobMachine = {
  id: number;
  name: string;
  /** Its owner's order (machines.priority, M6). */ priority: number | null;
  /** Its owner always allows this exact recipe: no go card. */ allowed: boolean;
  /** Its jobs not yet ended: a machine runs one at a time. */ ahead: number;
};

/**
 * Where a GPU job with no machine named goes, as M6 ranks machines: the owner's first in order with room (nothing queued),
 * filled before the next; then one that runs this recipe with no go card, the shortest queue, then the name.
 */
export function pickJobMachine(eligible: readonly JobMachine[]): JobMachine | null {
  const rank = (m: JobMachine) => [m.ahead > 0 ? 1 : 0, order(m), m.allowed ? 0 : 1, m.ahead];
  return (
    [...eligible].sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x.reduce((d, v, i) => d || v - y[i]!, 0) || a.name.localeCompare(b.name);
    })[0] ?? null
  );
}
