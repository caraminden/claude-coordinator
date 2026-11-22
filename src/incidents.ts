// Incident timelines, written by themselves (#1145; handoff shared/project/handoffs/platform-incident-timeline.md, Josh
// picked "Build it" on 2026-11-19). When something goes wrong with Citadel itself (the server was down, the ship line
// stood still, a burst of red CI runs, server stops or stalls in a row: #1325), this gathers what was already recorded for that window into one timeline in the
// scheme's shared reports/ folder and wakes the Taskmaster to start a research minion on it.
//
// Read-only (why: an incident on 2026-11-18 was blamed on the wrong thing because the data was read after the
// diagnosis). It changes nothing and adds no recorder: health_events (5xx, stalls, fallbacks, front-end errors, #1135's
// watchdog restarts), runner_load (the CI desktop's samples), the CI runs and failed steps GitHub keeps, the live
// checkout's reflog (each deploy), and the server's journal. Its only writes are its own state and a heartbeat.
//
// One incident per window: a trigger while one is open widens it, and it is written only once QUIET_MS pass with no
// trigger, so a two-hour storm makes one timeline, not thirty.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from './db.ts';
import type { GhGet } from './gh-api.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { ZONE, clockTime, pacific, pacificDay } from './pacific.ts';
import { HEALTH_KIND, keptChecks } from './standing-checks.ts';
import { PLANNED } from './sd-watchdog.ts';

const run = promisify(execFile);
const MIN = 60_000;
/** A gap this long between the last heartbeat and a boot means the server was down, not a deploy's restart. */
export const DOWN_MS = 5 * MIN;
/** The ship line (tools/deploy-queue.sh) with nothing moving this long: the queue's own "stuck" rule. */
export const STILL_MS = 15 * MIN;
/** This many failed CI runs within RED_WINDOW_MS is a burst. */
export const RED_COUNT = 5;
export const RED_WINDOW_MS = 30 * MIN;
/** This many unplanned server stops (src/sd-watchdog.ts's 'stop' rows: out of memory, watchdog, crash, unknown) within STOPS_WINDOW_MS (#1325). */
export const STOPS_COUNT = 3;
export const STOPS_WINDOW_MS = 10 * MIN;
/**
 * Stalls adding up to more than this share of any STALL_WINDOW_MS are an incident (#1325). Picked from Nov 17 to 20's
 * rows: every window on Nov 17 to 19 stayed at or under 1.7% (5 s of 5 min); on Nov 20, 11:22 to 11:27 held 38% (113 s,
 * from the journal) and 01:30 14.3%. Not 5%: the first boot with #1295's boot stalls (15:43 PST Nov 20) held 6.6% in its
 * quiet minutes, which would make most deploys an incident; the 13:06 memory storm (5.0%) has its own memory-high row.
 */
export const STALL_SHARE = 0.1;
export const STALL_WINDOW_MS = 5 * MIN;
/** The stall kinds counted: loop-lag, and #1295's loop-lag-boot (stalls in the 10 quiet minutes after a boot). */
export const STALL_KINDS = ['loop-lag', 'loop-lag-boot'];
/** How far back the stall trigger looks each tick: stalls are recorded as they happen, so an earlier tick saw older ones. */
const LOOK_BACK_MS = 60 * MIN;
/** Stops are recorded at the next boot with the stop's own time, which can be long ago after an outage: they look back further. */
const STOPS_LOOK_BACK_MS = 24 * 60 * MIN;
/** An open incident is written once this long passes with no trigger. */
export const QUIET_MS = 30 * MIN;
/** The timeline reads this long before the first trigger, and this long after the last. */
export const LEAD_MS = 30 * MIN;
export const TAIL_MS = 15 * MIN;
/** At most this many lines in the timeline: past it the rest are counted, not listed. */
export const MAX_LINES = 300;
export const STATE_KEY = 'incidents';
export const ALIVE_KEY = 'incidents:alive';

export interface Trigger {
  /** When the trouble began, and the newest sign of it (ms). */
  from: number;
  last: number;
  why: string;
}
export interface Open {
  from: number;
  last: number;
  why: string[];
}
export interface IncidentState {
  open: Open | null;
  /** Signs at or before this are an earlier incident's: they never open a new one. */
  after: number;
  /** The timelines written, newest last (kept 20). */
  done: { from: number; to: number; file: string | null; at: number }[];
}

/** Fold one tick's triggers into the state; `close` is the incident to write now, if one went quiet. Pure. */
export function step(state: IncidentState, triggers: Trigger[], now: number): { state: IncidentState; close: Open | null } {
  let open = state.open ? { ...state.open, why: [...state.open.why] } : null;
  for (const t of triggers) {
    if (t.last <= state.after) continue;
    if (!open) open = { from: t.from, last: t.last, why: [] };
    open.from = Math.min(open.from, Math.max(t.from, state.after));
    open.last = Math.max(open.last, t.last);
    if (!open.why.includes(t.why) && open.why.length < 12) open.why.push(t.why);
  }
  if (open && now - open.last >= QUIET_MS) return { state: { ...state, open: null, after: open.last }, close: open };
  return { state: { ...state, open }, close: null };
}

/** A failed CI job as ci-health keeps it. */
export interface RedJob {
  run_id: number;
  conclusion: string | null;
  completed_at?: string | null;
}
/** A burst of red runs: RED_COUNT or more runs with a failed job finished in the last RED_WINDOW_MS, after `after`. */
export function redTrigger(jobs: RedJob[], after: number, now: number): Trigger | null {
  const since = Math.max(after, now - RED_WINDOW_MS);
  const runs = new Map<number, number>();
  for (const j of jobs) {
    const at = j.completed_at ? Date.parse(j.completed_at) : NaN;
    if (j.conclusion !== 'failure' || !(at > since) || at > now) continue;
    runs.set(j.run_id, Math.max(runs.get(j.run_id) ?? 0, at));
  }
  if (runs.size < RED_COUNT) return null;
  const times = [...runs.values()];
  return { from: Math.min(...times), last: Math.max(...times), why: `a burst of red CI runs (${RED_COUNT} or more failed within ${RED_WINDOW_MS / MIN} min)` };
}

/** A health row as the stop and stall triggers read it. */
export interface Row { at: number; detail: string }

/** From the first row to the last of every `window`-long stretch (ending at a row) that `enough` passes; null with none. */
function clusters(rows: Row[], window: number, enough: (inWindow: Row[]) => boolean): { from: number; last: number } | null {
  let from = Infinity, last = -Infinity;
  for (let i = 0, j = 0; i < rows.length; i++) {
    while (rows[i].at - rows[j].at >= window) j++;
    const w = rows.slice(j, i + 1);
    if (enough(w)) (from = Math.min(from, w[0].at)), (last = rows[i].at);
  }
  return last > -Infinity ? { from, last } : null;
}

/** STOPS_COUNT or more unplanned server stops within STOPS_WINDOW_MS, of 'stop' rows oldest first. */
export function stopsTrigger(rows: Row[]): Trigger | null {
  const unplanned = rows.filter((r) => !(PLANNED as readonly string[]).includes(r.detail.split(':')[0]));
  const c = clusters(unplanned, STOPS_WINDOW_MS, (w) => w.length >= STOPS_COUNT);
  return c && { ...c, why: `the server stopped unplanned ${STOPS_COUNT} or more times within ${STOPS_WINDOW_MS / MIN} min (out of memory, watchdog, crash or unknown)` };
}

/** How long a stall row held the event loop, in ms, from its "held for 1.2 s" (0 when it doesn't say). */
const heldMs = (detail: string) => Number(/held for ([\d.]+) s/.exec(detail)?.[1] ?? 0) * 1000;

/** Stalls adding up to more than STALL_SHARE of some STALL_WINDOW_MS, of stall rows oldest first. */
export function stallTrigger(rows: Row[]): Trigger | null {
  const c = clusters(rows, STALL_WINDOW_MS, (w) => w.reduce((n, r) => n + heldMs(r.detail), 0) > STALL_SHARE * STALL_WINDOW_MS);
  return c && { ...c, why: `repeated stalls: the event loop was held more than ${STALL_SHARE * 100}% of ${STALL_WINDOW_MS / MIN} min` };
}

/** One landing in the ship line, as src/waits.ts reads it. */
export interface InLine {
  seq: number;
  got: number;
  label: string;
  phase: string;
}

// ---- What a timeline is made of ----

export type Source = 'trigger' | 'deploy' | 'ci' | 'health' | 'load' | 'journal';
const SOURCE_NAME: Record<Source, string> = { trigger: 'Trigger', deploy: 'Deploy', ci: 'CI', health: 'Health', load: 'Load', journal: 'Journal' };
export interface Entry {
  at: number;
  source: Source;
  text: string;
  /** Entries with the same source and key are one line, with a count and the last time. Defaults to the text. */
  key?: string;
  url?: string;
  /** The CI run's branch, so a merged line can list every branch it hit. */
  branch?: string;
  /** The CI run's runner, so a merged line can list every runner it ran on. */
  runner?: string;
}
export interface CiRun {
  id: number;
  workflow: string;
  branch: string;
  conclusion: string | null;
  created: number;
  updated: number;
  url: string;
  /** The failed job's step, as "job › step", and the runner it ran on, for a failed run. */
  failed?: string | null;
  runner?: string | null;
}
export interface Deploy {
  at: number;
  sha: string;
  subject: string;
  how: string;
}
export interface Sources {
  deploys(from: number, to: number): Promise<Deploy[]>;
  ci(from: number, to: number): Promise<CiRun[]>;
  journal(from: number, to: number): Promise<Entry[]>;
  /** Where the research minion can read more of the database (its path), for the timeline's last section. */
  dbPath: string;
}
export type IncidentStore = Pick<Store, 'getSetting' | 'setSetting' | 'healthBetween' | 'runnerLoadSince'>;

const STALL_LINE = /^The event loop was held for /;

/** Digits and hashes out, so the same message with another number is one line. */
const shape = (s: string) => s.replace(/\b[0-9a-f]{7,40}\b/g, '#').replace(/\d+(\.\d+)?/g, '#');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function ciEntries(runs: CiRun[]): Entry[] {
  return runs.map((r) => {
    if (r.conclusion === 'failure') {
      const where = r.failed ? ` at ${r.failed}` : '';
      return { at: r.updated, source: 'ci' as const, key: `${r.workflow} failed${where}`, url: r.url, branch: r.branch, runner: r.runner ?? undefined, text: `${r.workflow} failed${where}${r.runner ? ` on ${r.runner}` : ''} (${r.branch})` };
    }
    const said = r.conclusion ?? 'still running';
    return { at: r.updated, source: 'ci' as const, key: `${r.workflow} ${said}`, url: r.url, branch: r.branch, text: `${r.workflow} ${said === 'success' ? 'passed' : said} (${r.branch})` };
  });
}

export const deployEntries = (deploys: Deploy[]): Entry[] =>
  deploys.map((d) => ({ at: d.at, source: 'deploy' as const, text: `the live checkout moved to ${d.sha.slice(0, 8)} "${clip(d.subject, 120)}" (${d.how})`, key: `deploy ${d.sha}` }));

export function healthEntries(rows: { at: number; kind: string; detail: string }[]): Entry[] {
  return rows.map((r) => {
    const detail = clip(oneLine(r.detail), STALL_KINDS.includes(r.kind) ? 700 : 220);
    return { at: r.at, source: 'health' as const, text: `${r.kind}: ${detail}`, key: `${r.kind}: ${shape(detail).slice(0, 80)}` };
  });
}

interface LoadSample {
  host?: string;
  cpu?: number;
  mem_total?: number;
  mem_free?: number;
  disk_total?: number | null;
  disk_free?: number | null;
  restarts?: number[];
}
/** The CI desktop's samples, only where they say something: an agent gone quiet, a box flat out, low memory or disk, an unclean restart. */
export function loadEntries(rows: { machine_id: number; at: number; data: string }[], from: number, to: number): Entry[] {
  const out: Entry[] = [];
  const byMachine = new Map<number, { at: number; s: LoadSample }[]>();
  for (const r of rows) {
    if (r.at < from || r.at > to) continue;
    let s: LoadSample;
    try {
      s = JSON.parse(r.data);
    } catch {
      continue;
    }
    byMachine.set(r.machine_id, [...(byMachine.get(r.machine_id) ?? []), { at: r.at, s }]);
  }
  for (const [id, samples] of byMachine) {
    const host = samples.find((x) => x.s.host)?.s.host ?? `machine ${id}`;
    let busySince: number | null = null;
    const seen = new Set<number>();
    samples.forEach(({ at, s }, i) => {
      const prev = samples[i - 1];
      if (prev && at - prev.at >= DOWN_MS) out.push({ at: prev.at, source: 'load', text: `${host}'s load agent sent nothing for ${Math.round((at - prev.at) / MIN)} min` });
      const busy = (s.cpu ?? 0) >= 90;
      if (busy && busySince === null) busySince = at;
      if (!busy && busySince !== null) {
        out.push({ at: busySince, source: 'load', text: `${host}'s CPU at 90% or more for ${Math.max(1, Math.round((at - busySince) / MIN))} min`, key: `${host} cpu` });
        busySince = null;
      }
      if (s.mem_total && s.mem_free != null && s.mem_free / s.mem_total < 0.05) out.push({ at, source: 'load', text: `${host} had under 5% memory free`, key: `${host} memory` });
      if (s.disk_total && s.disk_free != null && s.disk_free / s.disk_total < 0.03) out.push({ at, source: 'load', text: `${host} had under 3% disk free`, key: `${host} disk` });
      for (const r of s.restarts ?? []) {
        if (r < from || r > to || seen.has(r)) continue;
        seen.add(r);
        out.push({ at: r, source: 'load', text: `${host} came back from a restart with no clean shutdown` });
      }
    });
    if (busySince !== null) out.push({ at: busySince, source: 'load', text: `${host}'s CPU at 90% or more until the window's end`, key: `${host} cpu` });
  }
  return out;
}

/** `journalctl -o short-unix` lines ("1763372640.123456 perigee node[42]: text") as entries. */
export function journalEntries(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+(?:\.\d+)?) \S+ ([^:]+): (.*)$/.exec(line);
    if (!m) continue;
    const msg = clip(oneLine(m[3]), STALL_LINE.test(m[3]) ? 900 : 240);
    if (!msg) continue;
    out.push({ at: Math.round(Number(m[1]) * 1000), source: 'journal', text: msg, key: shape(msg).slice(0, 100) });
  }
  return out;
}

/** One line per (source, key): the first time, how many, and the last time. Sorted by when each began. */
export interface Group { first: Entry; n: number; last: number; branches: Map<string, number>; runners: Map<string, number>; /** The different numbers and hashes the merged lines carried (shape() blanks them), so "x ×81" can say they weren't one line repeated. */ variants: Set<string> }
/** The digits and hashes of a line, in order: what shape() takes out. */
const vars = (s: string) => (s.match(/\b[0-9a-f]{7,40}\b|\d+(?:\.\d+)?/g) ?? []).join(',');
/** What the numbers in a merged line count: the word before the first one ("Ticket 2869" is tickets), else "numbers". */
const nounOf = (text: string) => {
  const w = /([A-Za-z]{3,})\s+#?\d/.exec(text)?.[1];
  return w ? `${w.toLowerCase()}s`.replace(/ss$/, 's') : 'numbers';
};
export function group(entries: Entry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    const k = `${e.source}\u0000${e.key ?? e.text}`;
    const g = groups.get(k);
    if (g) {
      g.n++;
      g.last = Math.max(g.last, e.at);
      g.variants.add(vars(e.text));
      if (e.branch !== undefined) g.branches.set(e.branch, (g.branches.get(e.branch) ?? 0) + 1);
      if (e.runner !== undefined) g.runners.set(e.runner, (g.runners.get(e.runner) ?? 0) + 1);
    } else groups.set(k, { first: e, n: 1, last: e.at, branches: new Map(e.branch !== undefined ? [[e.branch, 1]] : []), runners: new Map(e.runner !== undefined ? [[e.runner, 1]] : []), variants: new Set([vars(e.text)]) });
  }
  return [...groups.values()].sort((a, b) => a.first.at - b.first.at);
}

export interface Gathered {
  entries: Entry[];
  /** Per source, what was read ("36 runs, 36 failed") or why it wasn't. */
  read: Record<string, string>;
}

/** Everything recorded from `from` to `to`, each source on its own: one that can't be read is said, not fatal. */
export async function gather(store: IncidentStore, src: Sources, from: number, to: number): Promise<Gathered> {
  const entries: Entry[] = [];
  const read: Record<string, string> = {};
  const take = async (name: string, get: () => Promise<{ list: Entry[]; said: string }>) => {
    try {
      const { list, said } = await get();
      entries.push(...list);
      read[name] = said;
    } catch (err: any) {
      read[name] = `not read: ${clip(oneLine(String(err?.message ?? err)), 200)}`;
    }
  };
  await take('health_events', async () => {
    const rows = store.healthBetween(from, to, 2000);
    return { list: healthEntries(rows), said: rows.length === 2000 ? `the first 2000 rows (the cap: later ones not read)` : `${rows.length} rows` };
  });
  // A standing check's broken promise first seen before the window is still broken now (#1415): its row is older, so it is named here.
  await take('standing checks', async () => {
    const older = (keptChecks(store)?.findings ?? []).filter((f) => f.since < from);
    return { list: older.map((f) => ({ at: from, source: 'health' as const, text: clip(oneLine(`${HEALTH_KIND} (broken since ${clockTime(f.since)}): ${f.check}: ${f.text}`), 220), key: `${HEALTH_KIND}: ${f.key}` })), said: `${older.length} still broken from before` };
  });
  await take('runner_load', async () => {
    const rows = store.runnerLoadSince(from).filter((r) => r.at <= to);
    const list = loadEntries(rows, from, to);
    return { list, said: `${rows.length} samples from ${new Set(rows.map((r) => r.machine_id)).size} machine(s), ${list.length} worth a line` };
  });
  await take('CI runs', async () => {
    const runs = await src.ci(from, to);
    return { list: ciEntries(runs), said: `${runs.length} runs, ${runs.filter((r) => r.conclusion === 'failure').length} failed` };
  });
  await take('deploys', async () => {
    const d = await src.deploys(from, to);
    return { list: deployEntries(d), said: `${d.length}` };
  });
  await take('journal', async () => {
    const list = await src.journal(from, to);
    return { list, said: `${list.length} lines` };
  });
  return { entries, read };
}

const MAX_BRANCHES = 4;
/** A merged CI line's branches: "a ×4, b ×1, +2 more", most hit first. Empty unless more than one branch hit it. */
export function branchList(branches: Map<string, number>): string {
  if (branches.size < 2) return '';
  const all = [...branches].sort((a, b) => b[1] - a[1]);
  const shown = all.slice(0, MAX_BRANCHES).map(([b, c]) => `${b} ×${c}`);
  return all.length > MAX_BRANCHES ? `${shown.join(', ')}, +${all.length - MAX_BRANCHES} more` : shown.join(', ');
}
/** "×81 lines like this, 70 different tickets" when the merged lines differ in their numbers; "×3" when they were the same line. */
export function countWords(g: Group): string {
  const merged = g.first.source === 'journal' || g.first.source === 'health';
  return merged && g.variants.size > 1 ? `×${g.n} lines like this, ${g.variants.size} different ${nounOf(g.first.text)}` : `×${g.n}`;
}
/** The group's text, its one branch swapped for the list when several branches hit it. */
const textWithBranches = (g: Group, text: string) => {
  if (g.runners.size > 1 && g.first.runner !== undefined) text = text.replace(` on ${g.first.runner}`, ` on ${[...g.runners].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ×${c}`).join(', ')}`);
  const list = branchList(g.branches);
  if (!list) return text;
  const own = g.first.branch !== undefined ? ` (${g.first.branch})` : '';
  return own && text.endsWith(own) ? `${text.slice(0, -own.length)} (${list})` : `${text} (${list})`;
};

export interface Stall { start: number; end: number; heldS: number; cause: string; wait: string; running: string }
/** A Pacific wall-clock time on `day` ("2026-11-21", "02:23:05") as epoch ms. */
function pacificMs(day: string, hms: string): number {
  const guess = Date.parse(`${day}T${hms}Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(guess).map((x) => [x.type, Number(x.value)]));
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const first = guess - (shown - guess);
  const again = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(first).map((x) => [x.type, Number(x.value)]));
  return first - (Date.UTC(again.year, again.month - 1, again.day, again.hour, again.minute, again.second) - guess);
}
/**
 * A loop-lag line's stall: how long, its own start and end (read from the line: `at` is when the line was written, which
 * can be seconds after the stall ended), its cause, the kernel wait and the top frames it ran. Null for another line.
 */
export function parseStall(text: string, at: number): Stall | null {
  const m = /held for (\d+(?:\.\d+)?) s(?: \((\d\d:\d\d:\d\d)(?: [A-Z]{3})? to (\d\d:\d\d:\d\d)(?: [A-Z]{3,4})?\))?/.exec(text);
  if (!m || !/event loop was held/.test(text)) return null;
  const heldS = Number(m[1]);
  let start = at - heldS * 1000, end = at;
  if (m[2]) {
    // The line's clock is the stall's: on the Pacific day it was written, or the day before when it crossed midnight.
    for (const day of [pacificDay(at), pacificDay(at - 86_400_000)]) {
      const e = pacificMs(day, m[3]);
      if (e <= at + 1000) { end = e; start = pacificMs(day, m[2]); if (start > end) start = pacificMs(pacificDay(at - 86_400_000), m[2]); break; }
    }
  }
  return {
    start, end, heldS,
    cause: /Cause: ([a-z ]+?) \(/.exec(text)?.[1] ?? 'unclear',
    wait: /Main thread waited on: ([^.]*?)\./.exec(text)?.[1] ?? '',
    running: (/Running: (.*?)(?: Disk:| Also open on|$)/.exec(text)?.[1] ?? '').split('; ').slice(0, 2).join('; ').replace(/\.$/, ''),
  };
}
/** The five longest stalls in the entries, each once (the health row and the journal line say the same stall), longest first. */
export function biggestStalls(entries: Entry[]): Stall[] {
  const seen = new Map<string, Stall>();
  for (const e of entries) {
    const st = e.source === 'health' || e.source === 'journal' ? parseStall(e.text.replace(/^loop-lag(?:-boot)?: /, ''), e.at) : null;
    if (!st) continue;
    const k = `${Math.round(st.start / 1000)}:${st.heldS}`;
    const had = seen.get(k);
    if (!had || st.running.length > had.running.length) seen.set(k, st);
  }
  return [...seen.values()].sort((a, b) => b.heldS - a.heldS).slice(0, 5);
}

/** The timeline file's markdown. */
export function render(incident: Open, from: number, to: number, g: Gathered, dbPath: string): string {
  const groups = group([...incident.why.map((why) => ({ at: incident.from, source: 'trigger' as const, text: why })), ...g.entries]);
  const shown = groups.slice(0, MAX_LINES);
  const line = (g: Group) => {
    const { first, n, last } = g;
    const more = n > 1 ? ` (${countWords(g)}, the last ${pacific(last)})` : '';
    const link = first.url ? ` [run](${first.url})` : '';
    return `- **${pacific(first.at)}** · ${SOURCE_NAME[first.source]} · ${textWithBranches(g, first.text).replace(/\n/g, ' ')}${more}${link}`;
  };
  const biggest = groups.filter((x) => x.n > 1 && x.first.source !== 'trigger').sort((a, b) => b.n - a.n).slice(0, 5);
  const firstBad = groups.find((x) => x.first.source === 'ci' && / failed/.test(x.first.text));
  const stalls = biggestStalls(g.entries);
  const stallSection = stalls.length
    ? ['## Biggest stalls', '', 'The five longest event-loop holds, each with its own start and end (not when its line was written), before any grouped count below.', '',
      ...stalls.map((x) => `- **${pacific(x.start)}** to ${pacific(x.end).replace(/^.*?, /, '')} · ${x.heldS.toFixed(1)} s · ${x.cause}${x.wait ? ` · waited on ${x.wait}` : ''}${x.running ? ` · ${x.running}` : ''}`), '']
    : [];
  const sec = (ms: number) => Math.floor(ms / 1000);
  return [
    `# Incident: ${pacific(incident.from)} to ${pacific(incident.last)}`,
    '',
    'Written by Citadel (src/incidents.ts) from what it already records. Nothing was changed. Read the data before naming a cause.',
    '',
    '## What set it off',
    '',
    ...incident.why.map((w) => `- ${w}`),
    '',
    `Window read: ${pacific(from)} to ${pacific(to)}.`,
    '',
    '## At a glance',
    '',
    ...(firstBad ? [`- First failed CI run: ${line(firstBad).slice(2)}`] : []),
    ...biggest.map((x) => `- Most repeated: ${/different/.test(countWords(x)) ? `${x.n} lines like` : `${x.n}×`} ${SOURCE_NAME[x.first.source]}: ${x.first.key && x.first.source === 'ci' ? `${x.first.key}${branchList(x.branches) ? ` (${branchList(x.branches)})` : ''}` : x.first.text}${/different/.test(countWords(x)) ? `, ${x.variants.size} different ${nounOf(x.first.text)}` : ''}, ${pacific(x.first.at)} to ${pacific(x.last)}`),
    ...(firstBad || biggest.length ? [] : ['- Nothing repeated.']),
    '',
    ...stallSection,
    '## Timeline (Pacific)',
    '',
    'Each line is its first time; a repeat of the same thing is counted on it, with the last time.',
    '',
    ...shown.map(line),
    ...(groups.length > shown.length ? [`- … and ${groups.length - shown.length} more lines past ${MAX_LINES}, in the sources below.`] : []),
    '',
    '## Sources',
    '',
    ...Object.entries(g.read).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Reading more',
    '',
    `- \`sqlite3 -readonly ${dbPath} "SELECT datetime(at/1000,'unixepoch'), kind, commit_sha, detail FROM health_events WHERE at BETWEEN ${from} AND ${to} ORDER BY at"\``,
    `- \`journalctl --user -u ${UNIT} --since @${sec(from)} --until @${sec(to)}\``,
    `- \`gh run list --created ${new Date(from).toISOString()}..${new Date(to).toISOString()} -L 200\``,
    '',
  ].join('\n');
}

/** The file's name: incident-<Pacific day and time it began>.md. */
export function fileName(from: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(from).map((x) => [x.type, x.value]));
  return `incident-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.md`;
}

// ---- The real sources ----

export const UNIT = 'claude-coordinator.service';
/** The server's journal for the window, through journalctl (the server runs as the same user). */
export async function readJournal(from: number, to: number, unit = UNIT): Promise<Entry[]> {
  const { stdout } = await run('journalctl', ['--user', '-u', unit, '--since', `@${Math.floor(from / 1000)}`, '--until', `@${Math.ceil(to / 1000)}`, '-o', 'short-unix', '--no-pager', '-q'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return journalEntries(stdout);
}
/** Each move of the live checkout's HEAD (a deploy, a roll back) from its reflog. */
export async function readDeploys(liveDir: string, from: number, to: number): Promise<Deploy[]> {
  const { stdout } = await run('git', ['-C', liveDir, 'log', '-g', '--date=unix', '--format=%gd%x09%H%x09%gs%x09%s', 'HEAD'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const out: Deploy[] = [];
  for (const l of stdout.split('\n')) {
    const [gd, sha, gs, subject] = l.split('\t');
    const at = Number(/@\{(\d+)\}/.exec(gd ?? '')?.[1]) * 1000;
    if (!sha || !(at >= from) || at > to) continue;
    out.push({ at, sha, subject: subject ?? '', how: (gs ?? '').replace(/ \/\S+/g, '').split(':')[0] });
  }
  return out.reverse();
}
/** The repo's workflow runs created in the window, and each failed one's failed job, step and runner. */
export async function readCiRuns(get: GhGet, slug: string, as: GithubEnv, from: number, to: number, maxFailed = 80): Promise<CiRun[]> {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const raw: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const a = await get(`repos/${slug}/actions/runs?created=${iso(from)}..${iso(to)}&per_page=100&page=${page}`, null, as);
    if (a.status !== 200) throw new Error(`GitHub answered ${a.status} for ${slug}'s runs`);
    const runs = Array.isArray(a.body?.workflow_runs) ? a.body.workflow_runs : [];
    raw.push(...runs);
    if (runs.length < 100) break;
  }
  const out: CiRun[] = raw.map((r) => ({ id: r.id, workflow: r.name ?? 'a workflow', branch: r.head_branch ?? '', conclusion: r.conclusion ?? null, created: Date.parse(r.created_at), updated: Date.parse(r.updated_at ?? r.created_at), url: r.html_url ?? `https://github.com/${slug}/actions/runs/${r.id}` }));
  for (const r of out.filter((x) => x.conclusion === 'failure').slice(0, maxFailed)) {
    const a = await get(`repos/${slug}/actions/runs/${r.id}/jobs?per_page=50`, null, as).catch(() => null);
    const job = (a?.body?.jobs ?? []).find((j: any) => j.conclusion === 'failure');
    if (!job) continue;
    const stepName = (job.steps ?? []).find((s: any) => s.conclusion === 'failure')?.name;
    r.failed = `${job.name}${stepName ? ` › ${stepName}` : ''}`;
    r.runner = job.runner_name ?? null;
  }
  return out.sort((a, b) => a.updated - b.updated);
}

// ---- The watcher the server runs ----

export interface IncidentDeps {
  store: IncidentStore;
  sources: Sources;
  /** The ship line now. */
  line(): InLine[];
  /** The CI jobs of Citadel's own scheme that ci-health last read (its `recent`). */
  jobs(): RedJob[];
  /** Write the timeline; the path written, or null with nowhere to put it. */
  write(name: string, text: string): string | null;
  /** Wake the Taskmaster with the ask; false when there is no Taskmaster to hear it. */
  tell(text: string): boolean;
  bootAt: number;
  now?: () => number;
}

export class Incidents {
  private d: IncidentDeps;
  private now: () => number;
  private pending: Trigger[] = [];
  private line: { sig: string; since: number } | null = null;
  private busy = false;

  constructor(d: IncidentDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  state(): IncidentState {
    const s = this.d.store.getSetting<IncidentState>(STATE_KEY);
    return s && typeof s.after === 'number' ? { open: s.open ?? null, after: s.after, done: Array.isArray(s.done) ? s.done : [] } : { open: null, after: this.d.bootAt, done: [] };
  }

  /** At boot: the last heartbeat this long before the boot means the server was down meanwhile. */
  boot() {
    const alive = this.d.store.getSetting<number>(ALIVE_KEY);
    if (typeof alive === 'number' && this.d.bootAt - alive >= DOWN_MS) {
      this.pending.push({ from: alive, last: this.d.bootAt, why: `the server was down from ${pacific(alive)} to ${pacific(this.d.bootAt)} (no heartbeat for ${Math.round((this.d.bootAt - alive) / MIN)} min)` });
    }
  }

  /** The signs of trouble now. */
  triggers(state: IncidentState, now: number): Trigger[] {
    const out = this.pending.splice(0);
    // Every restart since the last incident, not only the oldest, so a second one while this is open widens it (step dedupes).
    for (const dog of this.d.store.healthBetween(state.after + 1, now + 1, 50, ['watchdog'])) out.push({ from: dog.at, last: dog.at, why: `systemd's watchdog restarted the hung server (${pacific(dog.at)})` });
    const line = this.d.line();
    const sig = line.map((t) => `${t.seq}:${t.got}:${t.phase}`).join(',');
    if (!sig) this.line = null;
    else if (this.line?.sig !== sig) this.line = { sig, since: now };
    else if (now - this.line.since >= STILL_MS) {
      const head = line.find((t) => t.got > 0) ?? line[0];
      // The same words each minute it stays still, so one stall is one reason, not one per minute.
      out.push({ from: this.line.since, last: now, why: `the ship line stood still from ${pacific(this.line.since)} (${head.label || `#${head.seq}`}${head.phase ? `, ${head.phase}` : ''})` });
    }
    const since = Math.max(state.after + 1, now - LOOK_BACK_MS);
    const stops = stopsTrigger(this.d.store.healthBetween(Math.max(state.after + 1, now - STOPS_LOOK_BACK_MS), now + 1, 500, ['stop']));
    if (stops) out.push(stops);
    const stalls = stallTrigger(this.d.store.healthBetween(since, now + 1, 2000, STALL_KINDS));
    if (stalls) out.push(stalls);
    const red = redTrigger(this.d.jobs(), state.after, now);
    if (red) out.push(red);
    return out;
  }

  /** Once a minute: the heartbeat, then fold the triggers in, and write a timeline for an incident gone quiet. */
  async tick(): Promise<string | null> {
    const now = this.now();
    this.d.store.setSetting(ALIVE_KEY, now);
    if (this.busy) return null;
    this.busy = true;
    try {
      const before = this.state();
      const { state, close } = step(before, this.triggers(before, now), now);
      if (!close) {
        if (JSON.stringify(state) !== JSON.stringify(before) || !this.d.store.getSetting(STATE_KEY)) this.d.store.setSetting(STATE_KEY, state);
        return null;
      }
      // Write first, then save it closed: a restart mid-write leaves it open, and the next boot's tick writes it again.
      const file = await this.write(close, now);
      this.d.store.setSetting(STATE_KEY, { ...state, done: [...state.done, { from: close.from, to: close.last, file, at: now }].slice(-20) });
      return file;
    } finally {
      this.busy = false;
    }
  }

  /** Gather, write and tell, for one incident. */
  async write(incident: Open, now = this.now()): Promise<string | null> {
    const from = incident.from - LEAD_MS, to = Math.min(now, incident.last + TAIL_MS);
    const g = await gather(this.d.store, this.d.sources, from, to);
    const text = render(incident, from, to, g, this.d.sources.dbPath);
    const file = this.d.write(fileName(incident.from), text);
    if (!file) return null;
    this.d.tell(
      `Incident from ${pacific(incident.from)} to ${pacific(incident.last)}: ${incident.why.join('; ')}. ` +
        `Citadel wrote its timeline (health events, CI desktop load, CI runs, deploys, journal; read-only) to ${file}. ` +
        'Please start a research minion on it with that file as its brief, to find the cause from the data before naming one.',
    );
    return file;
  }
}
