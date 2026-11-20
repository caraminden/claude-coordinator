// A usage ledger (#1306, A9 from the quality push, Josh 2026-11-20: "I dont want things to get out of hand"): what
// gets used, counted by day, kind and name, so an admin page can list what nobody touched in 30 days. Counts only:
// no message or file content, no request log. Nothing before the ledger shipped was saved, so it starts from empty.
// `used()` counts in memory and never throws: a flush that fails is logged and its counts stay for the next one, so
// counting can't fail a request. The flush timer lives in server.ts (ADR 0002).
import type { DatabaseSync } from 'node:sqlite';
import { pacificDay } from './pacific.ts';

export const KINDS = ['page', 'route', 'tool', 'schedule', 'setting', 'skill', 'grunt'] as const;
export type UsageKind = (typeof KINDS)[number];
/** An item with no use for this long is listed first on the admin page. */
export const UNUSED_MS = 30 * 24 * 60 * 60_000;
/** Names are cut here, and only these characters survive, so a name can't carry content. */
const MAX_NAME = 80;

/** A name as the ledger keeps it: only these characters, cut short, so a name can't carry content. */
export const usageName = (name: string) => name.replace(/[^\w:./@ -]/g, '').slice(0, MAX_NAME);

export interface UsageRow { kind: UsageKind; name: string; first: string; last: string; n: number; days: number }

interface Pending { day: string; kind: UsageKind; name: string; n: number; people: Set<string> }

export class UsageLedger {
  private pending = new Map<string, Pending>();
  /** People seen today per key, kept across flushes so `people` stays a distinct count. */
  private seen = new Map<string, Set<string>>();
  private seenDay = '';
  private db: DatabaseSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Count one use. Never throws. */
  used(kind: UsageKind, name: string, person?: string | number | null): void {
    try {
      if (!KINDS.includes(kind)) return;
      const clean = usageName(name);
      if (!clean) return;
      const day = pacificDay(this.now());
      if (day !== this.seenDay) { this.seen.clear(); this.seenDay = day; }
      const key = `${day}\0${kind}\0${clean}`;
      let p = this.pending.get(key);
      if (!p) this.pending.set(key, (p = { day, kind, name: clean, n: 0, people: new Set() }));
      p.n++;
      if (person != null) {
        const who = String(person);
        p.people.add(who);
        let s = this.seen.get(key);
        if (!s) this.seen.set(key, (s = new Set()));
        s.add(who);
      }
    } catch { /* counting never fails a caller */ }
  }

  /** Write the counts so far. Returns whether it wrote; on a failure the counts are kept for the next flush. */
  flush(): boolean {
    if (!this.pending.size) return true;
    try {
      const up = this.db.prepare(`INSERT INTO usage_counts (day, kind, name, people, n) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (day, kind, name) DO UPDATE SET n = n + excluded.n, people = MAX(people, excluded.people)`);
      this.db.exec('BEGIN');
      try {
        for (const [key, p] of this.pending) up.run(p.day, p.kind, p.name, this.seen.get(key)?.size ?? 0, p.n);
        this.db.exec('COMMIT');
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* already closed */ }
        throw err;
      }
      this.pending.clear();
      return true;
    } catch (err) {
      console.error(`[usage] flush failed, will retry: ${(err as Error).message}`);
      return false;
    }
  }

  /** Every name ever counted, per kind, with its first and last day and totals (flushed rows plus what is pending). */
  rows(): UsageRow[] {
    this.flush();
    return this.db.prepare(`SELECT kind, name, MIN(day) AS first, MAX(day) AS last, SUM(n) AS n, COUNT(*) AS days FROM usage_counts GROUP BY kind, name`).all() as unknown as UsageRow[];
  }

  /** The first day anything was counted: the ledger's own age, which an item never seen is measured against. */
  since(): string | null {
    return (this.db.prepare('SELECT MIN(day) AS d FROM usage_counts').get() as { d: string | null }).d;
  }

  /** Rows older than this many days are dropped, so the table stays small. */
  prune(days = 400): void {
    try { this.db.prepare('DELETE FROM usage_counts WHERE day < ?').run(pacificDay(this.now() - days * 86_400_000)); } catch { /* next time */ }
  }
}

/**
 * The admin page's list: every known item (a name the ledger saw, plus `known` for ones that may never have been used)
 * with its last use, items with nothing in 30 days first (never used, then oldest last use), the rest by last use.
 */
export function unusedList(rows: UsageRow[], known: { kind: UsageKind; name: string }[], since: string | null, today: string): (UsageRow & { idle: boolean; never: boolean })[] {
  const byKey = new Map(rows.map((r) => [`${r.kind}\0${r.name}`, r]));
  for (const k of known) if (!byKey.has(`${k.kind}\0${k.name}`)) byKey.set(`${k.kind}\0${k.name}`, { ...k, first: since ?? today, last: '', n: 0, days: 0 });
  const cutoff = pacificDay(Date.parse(`${today}T12:00:00Z`) - UNUSED_MS);
  return [...byKey.values()].map((r) => ({ ...r, never: !r.last, idle: !r.last || r.last < cutoff }))
    .sort((a, b) => Number(b.idle) - Number(a.idle) || (a.last || '').localeCompare(b.last || '') || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
