// Ships per scheme, per Pacific week, by risk (#1196). Citadel keeps no risk column: the label lives only in the note
// LandHandoffs posts on a ship (src/land.ts), so this parses that fixed format. Only that format counts: ready notes and
// run-backs say "high" too.
import type { Store } from './db.ts';

export type Risk = 'low' | 'medium' | 'high';
export interface ShipNote { kind: 'shipped' | 'merged'; risk: Risk; go: boolean; pushFailed: boolean }

/**
 * "Shipped <what>: <summary>. Risk <r>: <reason>. [Go: …] <where>" or "Merged into <build>: …" (land.ts:548), and the push-failed
 * variant "Shipped <what>: <summary>. Risk <r>. Shipped locally, not pushed to origin: the push failed." (land.ts:525).
 */
export function parseShipNote(text: string): ShipNote | null {
  const m = /^(Shipped|Merged) [^]*?\. Risk (low|medium|high)(:|\.)/.exec(text);
  if (!m) return null;
  const pushFailed = m[3] === '.' && /^ Shipped locally, not pushed to origin: the push failed\./.test(text.slice(m[0].length));
  // "Risk high." that isn't the push-failed variant is not a ship note.
  if (m[3] === '.' && !pushFailed) return null;
  return { kind: m[1] === 'Merged' ? 'merged' : 'shipped', risk: m[2] as Risk, go: m[3] === ':' && / Go: [^]*?\.( |$)/.test(text), pushFailed };
}

const PT = 'America/Los_Angeles';
/** The Pacific Monday ('2026-11-16') of the week a moment falls in. */
export function pacificWeek(ms: number): string {
  const day = new Date(ms).toLocaleDateString('en-CA', { timeZone: PT });
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export interface Bucket { low: number; medium: number; high: number }
export interface ShipRow { scheme: number; name: string; week: string; kind: 'shipped' | 'merged'; counts: Bucket; pushFailed: number; withGo: number }
export interface ShipRisk { weeks: string[]; rows: ShipRow[]; schemes: { id: number; name: string; ships: number }[] }

const empty = (): Bucket => ({ low: 0, medium: 0, high: 0 });

/** Counts the notes (each with its scheme and time) into weeks; `weeks` is how many Pacific weeks back, the current one included. */
export function summarize(notes: { scheme: number; at: number; text: string }[], schemes: { id: number; name: string }[], weeks: number, now = Date.now()): ShipRisk {
  const names = new Map(schemes.map((s) => [s.id, s.name]));
  const week0 = pacificWeek(now);
  const wk: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) { const d = new Date(`${week0}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 7 * i); wk.push(d.toISOString().slice(0, 10)); }
  const rows = new Map<string, ShipRow>();
  const totals = new Map<number, number>();
  for (const n of notes) {
    const p = parseShipNote(n.text);
    const week = pacificWeek(n.at);
    if (!p || !wk.includes(week) || !names.has(n.scheme)) continue;
    const key = `${n.scheme}|${week}|${p.kind}`;
    const row = rows.get(key) ?? { scheme: n.scheme, name: names.get(n.scheme)!, week, kind: p.kind, counts: empty(), pushFailed: 0, withGo: 0 };
    row.counts[p.risk]++;
    if (p.pushFailed) row.pushFailed++;
    if (p.go) row.withGo++;
    rows.set(key, row);
    totals.set(n.scheme, (totals.get(n.scheme) ?? 0) + 1);
  }
  const sorted = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.week.localeCompare(b.week) || a.kind.localeCompare(b.kind));
  return { weeks: wk, rows: sorted, schemes: schemes.map((s) => ({ ...s, ships: totals.get(s.id) ?? 0 })) };
}

/** The answer as text: a line per scheme and week, and the schemes with no ship note at all named rather than shown as 0. */
export function shipRiskText(r: ShipRisk): string {
  const pct = (b: Bucket) => { const n = b.low + b.medium + b.high; return n ? `${Math.round((b.high / n) * 100)}%` : '-'; };
  const out = [`Ships by risk per Pacific week (Mon-Sun), weeks starting ${r.weeks.join(', ')}. Counted from each ship's "Shipped … Risk <r>" note; "Merged" is a feeder going into a build branch, not onto main, so it's shown apart.`];
  for (const s of r.schemes.filter((s) => s.ships)) {
    out.push(`\n${s.name}:`);
    for (const kind of ['shipped', 'merged'] as const) {
      const rows = r.rows.filter((x) => x.scheme === s.id && x.kind === kind);
      if (!rows.length) continue;
      out.push(`  ${kind === 'shipped' ? 'Shipped to main' : 'Merged into a build'}:`);
      for (const w of rows) {
        const extra = [w.withGo ? `${w.withGo} with a go` : '', w.pushFailed ? `${w.pushFailed} push failed` : ''].filter(Boolean).join(', ');
        out.push(`  - week of ${w.week}: low ${w.counts.low}, medium ${w.counts.medium}, high ${w.counts.high}; high share ${pct(w.counts)}${extra ? ` (${extra})` : ''}`);
      }
    }
  }
  const none = r.schemes.filter((s) => !s.ships).map((s) => s.name);
  if (none.length) out.push(`\nNo ship notes in these weeks (they may ship by pull request, which posts no note, so no share is known): ${none.join(', ')}.`);
  return out.join('\n');
}

/** The route's answer: every scheme for a minion or Taskmaster of the Citadel scheme (and an admin's person), else its own scheme only. */
export function shipRisk(store: Store, projectIds: number[] | null, weeks: number, now = Date.now()): ShipRisk {
  const schemes = store.listProjects().filter((p) => !projectIds || projectIds.includes(p.id)).map((p) => ({ id: p.id, name: p.name }));
  const since = new Date(`${pacificWeek(now)}T12:00:00Z`).getTime() - weeks * 7 * 86400000;
  return summarize(store.shipNotesSince(since).map((n) => ({ scheme: n.project_id, at: n.created_at, text: n.text })), schemes, weeks, now);
}
