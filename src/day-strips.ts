// Minion day strips (#1996, Josh's pick of "Day C" on 2026-11-25): every minion of a scheme that went live on a Pacific
// day, each cut from its real start to live into working, waiting on a person, ship line, CI, deploying, other waits and
// nothing recorded. The cut is #1991's time log (src/time-log.ts), the one reader; this only sorts its stretches into
// the strip's parts and lays the ship's own stages (releases.changes) over the time the log calls waiting.
import type { Store } from './db.ts';
import type { Ticket } from './db-rows.ts';
import { pacificDay } from './pacific.ts';
import { timeLog, type TimeSeg } from './time-log.ts';

/** A strip's parts, in the order they are drawn and summed. */
export const PARTS = ['work', 'person', 'line', 'ci', 'deploy', 'other', 'none'] as const;
export type Part = (typeof PARTS)[number];
export interface StripPart {
  start: number;
  end: number;
  part: Part;
}
export interface Strip {
  id: number;
  number: number | null;
  title: string;
  type: string | null;
  start: number;
  live: number;
  parts: StripPart[];
  totals: Record<Part, number>;
}
export interface DayStrips {
  day: string;
  from: number;
  to: number;
  strips: Strip[];
}

/** The notes that dismiss a minion because its ship went through (src/land.ts, src/closing.ts, src/live-probe.ts). */
const SHIPPED = /^(Shipped and live|Shipped), so the server dismissed|^The deploy is live\b/;
/** A ship's stages (src/waits.ts TRACK) as the strip's parts. */
const STAGE_PART: Record<string, Part> = { line: 'line', rebase: 'line', test: 'ci', build: 'ci', deploy: 'deploy', restart: 'deploy' };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The first ms of Pacific day `day` ("2026-11-25"); null for a string that isn't a day. */
export function dayStartMs(day: string): number | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  // Pacific midnight is 07:00 or 08:00 UTC; a zone a test fixes may be anything, so look across the whole UTC day.
  for (let h = -14; h <= 14; h++) {
    const t = Date.UTC(y, m - 1, d, h);
    if (pacificDay(t) === day && pacificDay(t - 1) !== day) return t;
  }
  // A zone whose midnight isn't on the hour: step back from noon a minute at a time.
  let t = Date.UTC(y, m - 1, d, 12);
  if (pacificDay(t) !== day) return null;
  while (pacificDay(t - 60_000) === day) t -= 60_000;
  return t;
}

/** The day after `day`, as a day. */
const nextDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** What a stretch of the time log is, as a strip's part. */
function partOf(s: TimeSeg): Part {
  if (s.kind === 'work' || s.kind === 'lost') return 'work'; // lost time is a turn that ran and was cut off
  if (s.guess || s.sub === 'unknown') return 'none';
  if (s.sub === 'person') return 'person';
  if (s.sub === 'ship') return 'line';
  if (s.sub === 'deploy') return 'deploy';
  return 'other';
}

/** The parts over [start, live]: the log's stretches, with the ship's stages laid over whatever wasn't work. */
export function cutStrip(segs: TimeSeg[], start: number, live: number, stages: Record<string, number> | null): { parts: StripPart[]; totals: Record<Part, number> } {
  let parts: StripPart[] = [];
  let at = start;
  for (const s of segs) {
    const a = Math.max(s.start, at);
    const b = Math.min(s.end, live);
    if (b <= a) continue;
    if (a > at) parts.push({ start: at, end: a, part: 'none' });
    parts.push({ start: a, end: b, part: partOf(s) });
    at = b;
  }
  if (live > at) parts.push({ start: at, end: live, part: 'none' });
  const marks = Object.entries(stages ?? {})
    .filter(([k, v]) => STAGE_PART[k] && Number.isFinite(v))
    .sort((x, y) => x[1] - y[1]);
  marks.forEach(([k, from], i) => {
    const to = i + 1 < marks.length ? marks[i + 1][1] : live;
    if (to > from) parts = overlay(parts, from, to, STAGE_PART[k]);
  });
  const merged: StripPart[] = [];
  for (const p of parts) {
    const last = merged.at(-1);
    if (last && last.part === p.part && last.end === p.start) last.end = p.end;
    else merged.push({ ...p });
  }
  const totals = Object.fromEntries(PARTS.map((k) => [k, 0])) as Record<Part, number>;
  for (const p of merged) totals[p.part] += p.end - p.start;
  return { parts: merged, totals };
}

/** `parts` with every piece that isn't work between `from` and `to` made `part`. */
function overlay(parts: StripPart[], from: number, to: number, part: Part): StripPart[] {
  return parts.flatMap((p) => {
    if (p.part === 'work' || p.end <= from || p.start >= to) return [p];
    const out: StripPart[] = [];
    if (p.start < from) out.push({ ...p, end: from });
    out.push({ start: Math.max(p.start, from), end: Math.min(p.end, to), part });
    if (p.end > to) out.push({ ...p, start: to });
    return out;
  });
}

const parseStages = (raw: unknown): Record<string, number> => (raw && typeof raw === 'object' ? (Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number')) as Record<string, number>) : {});

/** Which of a scheme's minions went live in [from, to), when, and with what ship stages. */
function wentLive(store: Store, projectId: number, from: number, to: number): Map<number, { ticket: Ticket; live: number; stages: Record<string, number> | null }> {
  const out = new Map<number, { ticket: Ticket; live: number; stages: Record<string, number> | null }>();
  // A release row names the minions it carried (Citadel's own server); the newest live of the day wins.
  for (const r of store.liveReleasesIn(projectId, from, to)) {
    let changes: unknown;
    try {
      changes = JSON.parse(r.changes);
    } catch {
      continue;
    }
    if (!Array.isArray(changes)) continue;
    for (const c of changes as { ticketId?: unknown; stages?: unknown }[]) {
      if (typeof c?.ticketId !== 'number') continue;
      const ticket = store.getTicket(c.ticketId);
      if (!ticket || ticket.project_id !== projectId || ticket.kind !== 'ticket') continue;
      out.set(ticket.id, { ticket, live: r.live_at!, stages: parseStages(c.stages) });
    }
  }
  // Every scheme: a minion the server dismissed because its ship went through, live at its dismissal.
  // shortcut: a minion that shipped and stayed open (stay_open) in a scheme with no release rows is missed; read its "Shipped" note if that matters.
  for (const t of store.dismissedIn(projectId, from, to)) if (!out.has(t.id) && t.last_note && SHIPPED.test(t.last_note) && t.closed_at != null) out.set(t.id, { ticket: t, live: t.closed_at, stages: null });
  return out;
}

/** Every minion of scheme `projectId` that went live on Pacific day `day`, as strips, oldest start first. */
export async function dayStrips(store: Store, projectId: number, day: string, now = Date.now()): Promise<DayStrips> {
  const from = dayStartMs(day);
  const to = from == null ? null : dayStartMs(nextDay(day));
  if (from == null || to == null) throw new Error(`Not a day: ${day}`);
  const live = wentLive(store, projectId, from, Math.min(to, now + 1));
  const types = store.props.forTargets('minion', [...live.keys()]);
  const strips: Strip[] = [];
  for (const { ticket, live: at, stages } of live.values()) {
    if (at <= ticket.created_at) continue;
    const log = await timeLog(store, ticket, now);
    const { parts, totals } = cutStrip(log.segs, ticket.created_at, at, stages);
    const type = types.get(ticket.id)?.type;
    strips.push({ id: ticket.id, number: ticket.number, title: ticket.title, type: typeof type === 'string' ? type : null, start: ticket.created_at, live: at, parts, totals });
  }
  strips.sort((a, b) => a.start - b.start);
  return { day, from, to, strips };
}

/** Answers kept per scheme and day: a past day for a while, today for a short one, so a page left open costs little. */
const keptBy = new WeakMap<Store, Map<string, { at: number; busy: Promise<DayStrips> }>>();
const KEEP_PAST_MS = 30 * 60_000;
const KEEP_TODAY_MS = 2 * 60_000;
const KEPT = 16;

/** dayStrips, shared by reads that ask at once and kept a while (KEEP_*). */
export function dayStripsKept(store: Store, projectId: number, day: string, now = Date.now()): Promise<DayStrips> {
  let kept = keptBy.get(store);
  if (!kept) keptBy.set(store, (kept = new Map()));
  const key = `${projectId}:${day}`;
  const had = kept.get(key);
  const keep = day < pacificDay(now) ? KEEP_PAST_MS : KEEP_TODAY_MS;
  if (had && now - had.at < keep) return had.busy;
  const busy = dayStrips(store, projectId, day, now);
  kept.delete(key);
  kept.set(key, { at: now, busy });
  busy.catch(() => kept.get(key)?.busy === busy && kept.delete(key));
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  return busy;
}
