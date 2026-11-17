// Spend on outside APIs (#839): a contraption or a minion reports what a call cost, and a scheme's month shows it
// per service beside OpenRouter's own calls (openrouter_calls, #717). A scheme may set a cap; crossing it warns the
// scheme's members once a month. Nothing stops by itself.
import type { Store } from './db.ts';
import { HttpError } from './http.ts';
import { monthStart } from './openrouter.ts';

export interface SpendInput { service: string; usd: number; units: number | null; note: string | null }
export interface SchemeBill {
  project_id: number;
  name: string;
  month_usd: number;
  cap_usd: number | null;
  services: { service: string; usd: number }[];
}

const MAX_USD = 10_000;

/** A report's body, checked: refuses what would book nonsense (zero, negative, NaN, a novel for a note). */
export function parseSpend(body: unknown): SpendInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object {service, usd, units?, note?}');
  const b = body as Record<string, unknown>;
  const service = typeof b.service === 'string' ? b.service.trim() : '';
  if (!service || service.length > 64) throw new HttpError(400, 'service is 1 to 64 characters, like azure-speech');
  if (typeof b.usd !== 'number' || !Number.isFinite(b.usd) || b.usd <= 0 || b.usd > MAX_USD) throw new HttpError(400, `usd is a number above 0 and up to ${MAX_USD}`);
  if (b.units != null && (typeof b.units !== 'number' || !Number.isFinite(b.units) || b.units < 0)) throw new HttpError(400, 'units is a number of 0 or more');
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > 500)) throw new HttpError(400, 'note is text up to 500 characters');
  return { service, usd: b.usd, units: (b.units as number | undefined) ?? null, note: (b.note as string | undefined)?.trim() || null };
}

const capKey = (projectId: number) => `spend_cap:${projectId}`;
const warnedKey = (projectId: number) => `spend_cap_warned:${projectId}`;

export class OutsideSpend {
  /** Told when a month's total first reaches a scheme's cap (server.ts posts it to the scheme's members). */
  onCap: (projectId: number, total: number, cap: number) => void = () => {};
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  setCap(projectId: number, cap: number | null) {
    if (cap !== null && (!Number.isFinite(cap) || cap <= 0 || cap > 1_000_000)) throw new HttpError(400, 'cap_usd is a number above 0, or null for none');
    this.store.setSetting(capKey(projectId), cap);
  }

  /** One scheme's month: outside spend and OpenRouter's calls together, by service, most first. */
  month(projectId: number, now = Date.now()): Omit<SchemeBill, 'name'> {
    const since = monthStart(now);
    const rows = this.store.db.prepare(`
      SELECT service, SUM(usd) AS usd FROM (
        SELECT service, usd FROM outside_spend WHERE project_id = ? AND created_at >= ? AND created_at < ?
        UNION ALL
        SELECT 'openrouter', CASE status WHEN 'ok' THEN cost_usd WHEN 'failed' THEN 0 ELSE estimate_usd END
          FROM openrouter_calls WHERE project_id = ? AND created_at >= ? AND created_at < ?
      ) GROUP BY service HAVING usd > 0 ORDER BY usd DESC, service`).all(projectId, since, monthEnd(now), projectId, since, monthEnd(now)) as { service: string; usd: number }[];
    const services = rows.map((r) => ({ service: r.service, usd: round(r.usd) }));
    return { project_id: projectId, month_usd: round(services.reduce((s, r) => s + r.usd, 0)), cap_usd: this.store.getSetting<number | null>(capKey(projectId)) ?? null, services };
  }

  /** Every scheme with spend this month, biggest first. */
  bill(now = Date.now()): SchemeBill[] {
    return this.store.listProjects()
      .map((p) => ({ name: p.name, ...this.month(p.id, now) }))
      .filter((b) => b.month_usd > 0)
      .sort((a, b) => b.month_usd - a.month_usd);
  }

  /** Book it. `over` is whether the month is at or past the cap; the warning goes out only the first time that month. */
  record(projectId: number, s: SpendInput, source: string, now = Date.now()) {
    this.store.db.prepare('INSERT INTO outside_spend (project_id, service, usd, units, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, s.service, s.usd, s.units, s.note, source, now);
    const m = this.month(projectId, now);
    const over = m.cap_usd !== null && m.month_usd >= m.cap_usd;
    if (over && this.store.getSetting<number>(warnedKey(projectId)) !== monthStart(now)) {
      this.store.setSetting(warnedKey(projectId), monthStart(now));
      this.onCap(projectId, m.month_usd, m.cap_usd!);
    }
    return { month_usd: m.month_usd, cap_usd: m.cap_usd, over_cap: over, over };
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const monthEnd = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
