// Splits the stall records' held time into named work and unnamed, by each record's own fields (#1502):
//   node tools/stall-split.ts [state.db path] [hours back, default 24]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
const db = new DatabaseSync(process.argv[2] ?? `${homedir()}/.local/share/claude-coordinator/coordinator.db`, { readOnly: true });
const since = Date.now() - Number(process.argv[3] ?? 24) * 3_600_000;
let named = 0, unnamed = 0;
for (const r of db.prepare("SELECT detail FROM health_events WHERE kind IN ('loop-lag','loop-lag-boot') AND at >= ?").all(since) as { detail: string }[]) {
  const s = Number(/held for ([\d.]+) s/.exec(r.detail)?.[1] ?? 0);
  if (/ (?:In|Running): \d+%/.test(r.detail)) named += s; else unnamed += s;
}
console.log(`named ${named.toFixed(1)} s, unnamed ${unnamed.toFixed(1)} s (${(100 * unnamed / ((named + unnamed) || 1)).toFixed(0)}% unnamed)`);
