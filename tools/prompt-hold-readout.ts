#!/usr/bin/env node
// The readout for holding a warm session's prompt (#1276): per Pacific day, warm turns (the session's last turn ended
// under an hour before this one started), how many of them ran on a changed system prompt (`sys-changed`: each one
// re-wrote the whole cached conversation), how many ran on a held prompt, and the cache writes the changed ones paid.
// Before #1276 ships, sys-changed is the cost; after it, it should fall to the cold starts and caps.
// Usage: node tools/prompt-hold-readout.ts [days=14] [db=~/.local/share/claude-coordinator/coordinator.db]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TurnRow { ticket_id: number; session_id: string | null; ended_at: number; duration_ms: number | null; prompt_digest: string | null; cache_write_tokens: number | null; keepalive?: number | null }
export interface Day { day: string; warm: number; sysChanged: number; held: number; changedWrites: number }

const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });

/** Rows in turn order per minion (ticket_id, then id), keepalives included. */
export function readout(rows: TurnRow[]): Day[] {
  const days = new Map<string, Day>();
  // Per minion: its session, when its last turn of any kind ended (a keepalive keeps the cache warm too), and the last real turn's system parts.
  const last = new Map<number, { session: string | null; ended: number; system: Record<string, string> | null }>();
  for (const r of rows) {
    const p = last.get(r.ticket_id);
    const same = !!p && p.session === r.session_id;
    if (r.keepalive || !r.prompt_digest) {
      last.set(r.ticket_id, { session: r.session_id, ended: r.ended_at, system: same ? p!.system : null });
      continue;
    }
    const h = JSON.parse(r.prompt_digest);
    const system: Record<string, string> = h.system ?? {};
    last.set(r.ticket_id, { session: r.session_id, ended: r.ended_at, system });
    // A new session is cold whatever the clock says: it writes its whole prompt anyway.
    if (!same || !p!.system || r.ended_at - (r.duration_ms ?? 0) - p!.ended >= 60 * 60_000) continue;
    const day = pacificDay.format(r.ended_at);
    const d = days.get(day) ?? { day, warm: 0, sysChanged: 0, held: 0, changedWrites: 0 };
    days.set(day, d);
    d.warm++;
    if (h.held) d.held++;
    const was = p!.system;
    if ([...new Set([...Object.keys(system), ...Object.keys(was)])].some((n) => system[n] !== was[n])) {
      d.sysChanged++;
      d.changedWrites += r.cache_write_tokens ?? 0;
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

if (import.meta.main) {
  const days = Number(process.argv[2] ?? 14);
  const db = new DatabaseSync(process.argv[3] ?? join(homedir(), '.local/share/claude-coordinator/coordinator.db'), { readOnly: true });
  const rows = db.prepare(`SELECT ticket_id, session_id, ended_at, duration_ms, prompt_digest, cache_write_tokens, keepalive FROM turns
      WHERE side IS NULL AND ended_at > ? ORDER BY ticket_id, id`).all(Date.now() - (days + 1) * 864e5) as unknown as TurnRow[];
  console.log('day (Pacific)  warm  sys-changed   held  writes on changed (M tokens)');
  for (const d of readout(rows).slice(-days)) {
    console.log(`${d.day}  ${String(d.warm).padStart(4)}  ${String(d.sysChanged).padStart(5)} ${`(${Math.round((100 * d.sysChanged) / d.warm)}%)`.padStart(6)}  ${String(d.held).padStart(5)}  ${(d.changedWrites / 1e6).toFixed(1).padStart(6)}`);
  }
}
