// A minion's wait for a worker (#1868, src/turn-line.ts) in the views' and agents' words. No imports: every turn's MCP server pins a copy.

/** Where a waiting minion stands: its place in the order turns would start in now, who paused them all, and why a worker of its own (Start now, #1957) wouldn't start it either. */
export interface WorkerWait {
  since: number;
  place: number;
  of: number;
  paused: string | null;
  held?: string | null;
  quick?: true; // the quick lane may start it ahead of its place (#1986)
}

const nth = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
export const workerWaitText = (w: WorkerWait) => (w.paused ? `waiting: ${w.paused} paused all minions` : `waiting for a worker, ${nth(w.place)} of ${w.of} in line${w.quick ? ', or a quick lane worker' : ''}`);
