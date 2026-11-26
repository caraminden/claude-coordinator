// Automatic use (Build 7 M5, specs/machine-connections.md section 5): a minion uses what its scheme is lent without
// naming a machine. The pooled Windows tools (`mcp__windows__*`, Josh's pick "Pooled, names kept") pick a machine with
// the Windows screen role and keep the minion on it, so its checkout stays warm; a GPU job with no machine named goes to
// an eligible GPU machine. Pure, but for the sticky choices: the server (routes/machines.ts, routes/jobs.ts) finds the
// eligible machines.

/** The pooled Windows tools' MCP server name: `mcp__windows__*`. No machine may be called this (RESERVED_NAMES). */
export const POOLED_WINDOWS = 'windows';

/** A machine the pooled Windows tools may use now: its Windows screen role lent to the scheme, online, its workspace tools up. */
export type ScreenMachine = { id: number; name: string /** Jobs holding or waiting in line for its screen. */; busy: number };

/**
 * Which machine a minion's pooled Windows tools use. The one it last used while that one is still eligible, even with
 * its screen busy (that may be the minion's own job); else the eligible one with the shortest screen line, then the
 * lowest id. shortcut: the sticky choice lives in the server's memory, so a restart forgets it; keep it in a setting if
 * a minion losing its warm checkout after a deploy matters.
 */
export class WindowsPool {
  private last = new Map<number, number>();

  pick(ticketId: number, eligible: readonly ScreenMachine[]): { machine: ScreenMachine; movedFrom: number | null } | null {
    const was = this.last.get(ticketId) ?? null;
    const stay = eligible.find((m) => m.id === was);
    const machine = stay ?? [...eligible].sort((a, b) => a.busy - b.busy || a.id - b.id)[0];
    if (!machine) return null;
    this.last.set(ticketId, machine.id);
    return { machine, movedFrom: stay || was === null ? null : was };
  }
}

/** A machine a GPU job may go to: its GPU jobs role lent to the scheme, with a jobs block. */
export type JobMachine = { id: number; name: string; online: boolean; paused: boolean /** Its owner always allows this exact recipe: no go card. */; allowed: boolean /** Its jobs not yet ended. */; ahead: number };

/** Where a GPU job with no machine named goes: online first, then one that runs this recipe with no card, not paused, the shortest queue, then the name. */
export function pickJobMachine(eligible: readonly JobMachine[]): JobMachine | null {
  const rank = (m: JobMachine) => [m.online ? 0 : 1, m.allowed ? 0 : 1, m.paused ? 1 : 0, m.ahead];
  return (
    [...eligible].sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x.reduce((d, v, i) => d || v - y[i]!, 0) || a.name.localeCompare(b.name);
    })[0] ?? null
  );
}
