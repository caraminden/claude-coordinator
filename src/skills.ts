// The Skills page (#1062, H7 and X3 from #1047): what skills and Grunt types a scheme's turns have, when each one runs, and
// a per-scheme Off switch for kit skills. Josh, 2026-11-19: "give info on when/where/how these skills are being used, not
// just what they do"; "Make it clear that these are default and highly recommended, but schemes should have autonomy";
// on #1062's grilling: nothing locked on ("a scheme should be able to do whatever it wants"), an off skill left out of
// the turn's kit copy with a deny rule behind it, Grunt types listed without a switch.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { frontmatter } from './catalogue.ts';
import type { Project, SkillEvent, SkillTicket, SkillTimeline, Store } from './db.ts';

/** The kit's plugin name (kit/.claude-plugin/plugin.json): its skills and agents are `citadel:<name>` in a turn. */
export const KIT_PLUGIN = 'citadel';
/** The kit in this checkout (what turns pin a copy of). */
export const KIT_DIR = join(import.meta.dirname, '..', 'kit');
/** How far back the page counts. */
export const USAGE_DAYS = 14;
/** How long a scheme's counts are reused: the walk reads two weeks of events. */
const CACHE_MS = 10 * 60_000;
/** A full re-read this often, so an event rewritten or deleted since the incremental scan's last look can't stay counted for long. */
const FULL_SCAN_MS = 6 * 3_600_000;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface SkillItem {
  /** What a turn calls it: `citadel:<name>` for the kit's, the bare name for the scheme's own. */
  name: string;
  kind: 'skill' | 'agent';
  source: 'kit' | 'scheme';
  /** Its folder (a skill) or file stem (an agent): what skills_off holds. */
  slug: string;
  /** What it does, from its description, without the trigger sentences. */
  what: string;
  /** When it is meant to run: the description's "Use when…" sentences. */
  trigger: string;
}

/** The kit skills a scheme turned off, as stored (projects.skills_off). */
export function offSkills(project: Pick<Project, 'skills_off'>): string[] {
  return (project.skills_off ?? '').split(/\s+/).filter((s) => NAME.test(s));
}

/** The deny rules that keep a scheme's off kit skills from running if anything names one (Claude Code honours these for plugin skills, tried on 2.1.323). */
export function skillDenies(off: readonly string[]): string[] {
  return off.filter((s) => NAME.test(s)).map((s) => `Skill(${KIT_PLUGIN}:${s})`);
}

/** Leave a scheme's off skills out of a turn's own kit copy (its pin folder), so the turn never lists them. */
export function pruneKit(kitDir: string, off: readonly string[]): void {
  for (const s of off) if (NAME.test(s)) rmSync(join(kitDir, 'skills', s), { recursive: true, force: true });
}

/** Split a description into what it does and when to use it: sentences opening "Use", "Open", "Also for/when" or "Only when", and a leading "Before …:" clause, are the trigger. */
export function splitDescription(text: string): { what: string; trigger: string } {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
  const isTrigger = (s: string) => /^(Use\b|Open\b|Also (for|when|use)\b|Only when\b|TRIGGER\b)/.test(s);
  // "Before shipping your own branch: a Grunt reviews…" opens with its trigger as a clause.
  const lead = /^((?:Before|After) [^:]{3,80}):\s+(.+)$/.exec(sentences[0]);
  if (lead) sentences.splice(0, 1, `${lead[1]}.`, lead[2][0].toUpperCase() + lead[2].slice(1));
  const trigger = sentences.filter((s, i) => isTrigger(s) || (lead && i === 0));
  return { what: sentences.filter((s) => !trigger.includes(s)).join(' '), trigger: trigger.join(' ') };
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function itemsIn(root: string, source: SkillItem['source']): SkillItem[] {
  const out: SkillItem[] = [];
  const prefix = source === 'kit' ? `${KIT_PLUGIN}:` : '';
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  };
  for (const e of list(join(root, 'skills'))) {
    if (!e.isDirectory()) continue;
    const text = read(join(root, 'skills', e.name, 'SKILL.md'));
    if (text === null) continue;
    const fm = frontmatter(text);
    out.push({ name: `${prefix}${e.name}`, kind: 'skill', source, slug: e.name, ...splitDescription(String(fm.description ?? '')) });
  }
  for (const e of list(join(root, 'agents'))) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const text = read(join(root, 'agents', e.name));
    if (text === null) continue;
    const fm = frontmatter(text);
    const slug = typeof fm.name === 'string' && fm.name ? fm.name : e.name.replace(/\.md$/, '');
    out.push({ name: `${prefix}${slug}`, kind: 'agent', source, slug, ...splitDescription(String(fm.description ?? '')) });
  }
  return out;
}

/** The kit's skills and Grunt types, then the scheme repo's own (`.claude/skills`, `.claude/agents`). */
export function listSkills(kitDir: string, repoDir: string | null): SkillItem[] {
  return [...itemsIn(kitDir, 'kit'), ...(repoDir ? itemsIn(join(repoDir, '.claude'), 'scheme') : [])];
}

/** Where in its turn a skill ran (Josh's "when"). */
export const PHASES = ['before any edit', 'after edits', 'after an error', 'before a ship'] as const;
export type Phase = (typeof PHASES)[number];

export interface RecentRun { project_id: number; number: number | null; title: string; at: number }
export interface Usage {
  runs: number;
  /** Distinct minions it ran in. */
  minions: number;
  phases: Partial<Record<Phase, number>>;
  /** The minions' `type` property ("none" when unset; "taskmaster" for a Taskmaster). */
  types: Record<string, number>;
  /** For a skill: the Grunt types started later in the same turn. For a Grunt type: the skill that ran last before it in the turn ("none"). */
  with: Record<string, number>;
  /** Runs in a minion that later shipped. */
  shipped: number;
  /** The newest few, newest first. */
  last: RecentRun[];
}
export interface UsageReport { since: number; skills: Record<string, Usage>; agents: Record<string, Usage> }

const LAST = 5;
/** Called once per run as the walk settles it (a skill's phase is final only when its turn ends; a Grunt type has none). */
type PerRun = (kind: 'skill' | 'agent', name: string, ticket: number, at: number, phase: Phase | null) => void;

/**
 * Walk the timeline minion by minion, turn by turn (a turn ends at its result event). A skill run's phase: an error since
 * the last edit or skill run in the turn makes it "after an error"; else whether the turn had edited a file yet, and a run
 * after edits becomes "before a ship" when the same turn later hands off a ship. A Grunt's own events count as the minion's.
 */
export function usageFrom(t: SkillTimeline, since: number, per?: PerRun): UsageReport {
  const tickets = new Map(t.tickets.map((k) => [k.id, k]));
  const skills: Record<string, Usage> = {};
  const agents: Record<string, Usage> = {};
  const seen = new Map<Usage, Set<number>>();
  const blank = (): Usage => ({ runs: 0, minions: 0, phases: {}, types: {}, with: {}, shipped: 0, last: [] });
  const bump = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);
  const count = (u: Usage, ticket: number, at: number, eventId: number) => {
    const k = tickets.get(ticket);
    u.runs++;
    const ids = seen.get(u) ?? new Set<number>();
    seen.set(u, ids.add(ticket));
    u.minions = ids.size;
    bump(u.types, k?.kind === 'coordinator' ? 'taskmaster' : k?.type ?? 'none');
    if (k?.shipped != null && k.shipped > eventId) u.shipped++;
    if (k) u.last.push({ project_id: k.project_id, number: k.number, title: k.title, at });
  };
  type Open = { usage: Usage; phase: Phase; name: string; ticket: number; at: number };
  let ticket = -1;
  let edited = false;
  let errored = false;
  let open: Open[] = [];
  let lastSkill: string | null = null;
  const endTurn = () => {
    for (const o of open) {
      bump(o.usage.phases, o.phase);
      per?.('skill', o.name, o.ticket, o.at, o.phase);
    }
    open = [];
    edited = false;
    errored = false;
    lastSkill = null;
  };
  for (const e of t.events) {
    if (e.ticket_id !== ticket) {
      endTurn();
      ticket = e.ticket_id;
    }
    for (const name of e.skills?.split(' ').filter(Boolean) ?? []) {
      const u = (skills[name] ??= blank());
      count(u, e.ticket_id, e.at, e.id);
      open.push({ usage: u, phase: errored ? 'after an error' : edited ? 'after edits' : 'before any edit', name, ticket: e.ticket_id, at: e.at });
      lastSkill = name;
      errored = false;
    }
    for (const name of e.agents?.split(' ').filter(Boolean) ?? []) {
      const u = (agents[name] ??= blank());
      count(u, e.ticket_id, e.at, e.id);
      bump(u.with, lastSkill ?? 'none');
      per?.('agent', name, e.ticket_id, e.at, null);
      if (lastSkill) bump(skills[lastSkill].with, name);
    }
    if (e.edit) {
      edited = true;
      errored = false;
    }
    if (e.error && !e.grunt) errored = true;
    if (e.ship && !e.grunt) for (const o of open) if (o.phase === 'after edits') o.phase = 'before a ship';
    if (e.result && !e.grunt) endTurn();
  }
  endTurn();
  for (const u of [...Object.values(skills), ...Object.values(agents)]) u.last = u.last.sort((a, b) => b.at - a.at).slice(0, LAST);
  return { since, skills, agents };
}

/**
 * The events the Skills page (#1062, src/skills.ts) walks, in order: one scheme's (or every scheme's, `projectId` null) Claude
 * events since `since` that call a skill or a Grunt, edit a file, fail a tool, hand off a ship or end a turn; everything else
 * is left out in SQL. Its minions (number, title, type) and each one's newest "Shipped" note come with it. `range` reads only
 * the ids after `range.after` up to `range.upTo`, for the incremental scan below.
 */
export function skillTimeline(db: DatabaseSync, projectId: number | null, since: number, range?: { after: number; upTo: number }): SkillTimeline {
  const from = windowStart(db, since);
  const events = skillEvents(db, projectId, since, Math.max(from, range?.after ?? 0), range?.upTo ?? Number.MAX_SAFE_INTEGER);
  return { events, tickets: skillTickets(db, events, from) };
}

/** Event ids grow with time: start after the last turn that ended by `since`, so the rowid range skips everything older. */
function windowStart(db: DatabaseSync, since: number): number {
  const before = db.prepare('SELECT event_id FROM turns WHERE ended_at <= ? AND event_id IS NOT NULL ORDER BY ended_at DESC LIMIT 1').get(since) as { event_id: number } | undefined;
  return before?.event_id ?? 0;
}

function skillEvents(db: DatabaseSync, projectId: number | null, since: number, after: number, upTo: number): SkillEvent[] {
  const tools = (name: string, field: string, fallback: string) => `CASE WHEN e.data LIKE '%"name":"${name}"%' THEN (SELECT group_concat(coalesce(json_extract(c.value, '$.input.${field}'), '${fallback}'), ' ')
      FROM json_each(e.data, '$.message.content') c WHERE json_extract(c.value, '$.type') = 'tool_use' AND json_extract(c.value, '$.name') = '${name}') END`;
  return db.prepare(`
    SELECT * FROM (SELECT e.id, e.ticket_id, e.created_at AS at,
        ${tools('Skill', 'skill', '')} AS skills,
        ${tools('Agent', 'subagent_type', 'general-purpose')} AS agents,
        (e.data LIKE '%"name":"Edit"%' OR e.data LIKE '%"name":"Write"%' OR e.data LIKE '%"name":"NotebookEdit"%') AS edit,
        (e.data LIKE '{"type":"user"%' AND e.data LIKE '%"is_error":true%') AS error,
        (e.data LIKE '%"name":"mcp__thread__hand_off_land"%' OR e.data LIKE '%"name":"mcp__thread__land"%') AS ship,
        (e.data LIKE '{"type":"result"%') AS result,
        (e.data LIKE '%"parent_tool_use_id":"%') AS grunt
      FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.id > ?1 AND e.id <= ?4 AND e.kind = 'claude' AND e.created_at > ?2 AND (?3 IS NULL OR t.project_id = ?3))
    WHERE skills IS NOT NULL OR agents IS NOT NULL OR edit OR error OR ship OR result
    ORDER BY ticket_id, id`).all(after, since, projectId, upTo) as unknown as SkillEvent[];
}

/** A message to a minion (its brief, a person's, the Taskmaster's) that names a kit skill or Grunt type, with the sentence it's in. */
export interface SkillMention { id: number; ticket_id: number; at: number; name: string; quote: string }
// shortcut: only the `citadel:<name>` form counts as naming one; bare names ("run a grilling round") and a scheme's own skills
// aren't caught. Upgrade if Josh wants those on the page.
const NAMED = /citadel:([a-z0-9]+(?:-[a-z0-9]+)*)/g;
const QUOTE = 240;

/** The sentence around `text[at]`, cut to QUOTE characters, on one line. */
export function sentenceAround(text: string, at: number): string {
  const stops = ['. ', '! ', '? ', '\n'];
  const start = Math.max(0, ...stops.map((s) => text.lastIndexOf(s, at) + 1));
  const ends = stops.map((s) => text.indexOf(s, at)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  if (end - start <= QUOTE) return text.slice(start, end).replace(/\s+/g, ' ').trim();
  // A long sentence: QUOTE characters with the name in the middle.
  const from = Math.max(start, Math.min(at - QUOTE / 2, end - QUOTE));
  const q = text.slice(from, from + QUOTE).replace(/\s+/g, ' ').trim();
  return `${from > start ? '…' : ''}${q}${from + QUOTE < end ? '…' : ''}`;
}

function skillMentions(db: DatabaseSync, since: number, after: number, upTo: number): SkillMention[] {
  const rows = db.prepare(`SELECT id, ticket_id, created_at AS at, json_extract(data, '$.text') AS text FROM events
    WHERE id > ?1 AND id <= ?3 AND kind = 'user_message' AND created_at > ?2 AND data LIKE '%citadel:%' ORDER BY ticket_id, id`).all(after, since, upTo) as { id: number; ticket_id: number; at: number; text: unknown }[];
  const out: SkillMention[] = [];
  for (const r of rows) {
    if (typeof r.text !== 'string') continue;
    const seen = new Set<string>();
    for (const m of r.text.matchAll(NAMED)) {
      const name = `${KIT_PLUGIN}:${m[1]}`;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ id: r.id, ticket_id: r.ticket_id, at: r.at, name, quote: sentenceAround(r.text, m.index) });
    }
  }
  return out;
}

function skillTickets(db: DatabaseSync, events: { ticket_id: number }[], from: number): SkillTicket[] {
  const ids = [...new Set(events.map((e) => e.ticket_id))];
  if (!ids.length) return [];
  return db.prepare(`
    SELECT k.id, k.project_id, k.number, k.title, k.kind,
      (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
        WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type,
      (SELECT max(n.id) FROM events n WHERE n.ticket_id = k.id AND n.kind = 'note' AND n.id > ?1 AND n.data LIKE '{"text":"Shipped %') AS shipped
    FROM tickets k WHERE k.id IN (SELECT value FROM json_each(?2))`).all(from, JSON.stringify(ids)) as unknown as SkillTicket[];
}

/** Every scheme's walked events (the rows `skillEvents` keeps) up to event id `hi`, kept between refreshes. */
export interface SkillScan { hi: number; events: SkillEvent[]; mentions: SkillMention[]; fullAt: number }

/**
 * Bring `prev` up to date: read only the Claude events after its `hi` (all of them, with no `prev` or when `prev` is older than
 * FULL_SCAN_MS, which catches events a maintenance pass rewrote or a deleted minion took with it), drop the kept ones that
 * fell out of the window, and keep the rest. The counts are then `usageFrom` over the whole list, never a running total, so
 * they equal a fresh full scan (a later ship still turns an earlier run's phase into "before a ship").
 */
export function scanSkills(db: DatabaseSync, since: number, prev: SkillScan | null, now = Date.now()): { scan: SkillScan; tickets: SkillTicket[] } {
  const full = !prev || now - prev.fullAt >= FULL_SCAN_MS;
  db.exec('BEGIN');
  try {
    const hi = (db.prepare("SELECT max(id) AS hi FROM events").get() as { hi: number | null }).hi ?? 0;
    const from = windowStart(db, since);
    const fresh = skillEvents(db, null, since, full ? from : Math.max(from, prev!.hi), hi);
    const events = full ? fresh : [...prev!.events.filter((e) => e.at > since), ...fresh].sort((a, b) => a.ticket_id - b.ticket_id || a.id - b.id);
    const named = skillMentions(db, since, full ? from : Math.max(from, prev!.hi), hi);
    const mentions = full ? named : [...prev!.mentions.filter((m) => m.at > since), ...named];
    return { scan: { hi, events, mentions, fullAt: full ? now : prev!.fullAt }, tickets: skillTickets(db, [...events, ...mentions], from) };
  } finally {
    db.exec('COMMIT');
  }
}

/** One scheme's report from every scheme's walk (`projectId` null: all of it). */
export function reportFor(scan: SkillScan, tickets: SkillTicket[], projectId: number | null, since: number): UsageReport {
  if (projectId == null) return usageFrom({ events: scan.events, tickets }, since);
  const mine = tickets.filter((k) => k.project_id === projectId);
  const ids = new Set(mine.map((k) => k.id));
  return usageFrom({ events: scan.events.filter((e) => ids.has(e.ticket_id)), tickets: mine }, since);
}

/** A minion on an opened row: its number, title, type and when it last did the thing the row lists. */
export interface DetailMinion { project_id: number; number: number | null; title: string; type: string; at: number }
/** What an opened row on the Skills page shows for one skill or Grunt type (#1082). */
export interface SkillDetail {
  /** The minions it ran in, newest first: how often and at which step of the turn. */
  used: (DetailMinion & { runs: number; phases: Partial<Record<Phase, number>> })[];
  /** Each minion type the scheme had at work in the window: how many minions, and how many of them opened it. */
  types: { type: string; active: number; opened: number }[];
  /** The type it opened in most, and that type's minions that never did, newest first, each with what it opened instead. */
  misses: { type: string; total: number; rows: (DetailMinion & { opened: string[] })[] } | null;
  /** Minions sent a message naming it (`citadel:<name>`) that never opened it in the window, with the sentence that named it. */
  named: { total: number; rows: (DetailMinion & { quote: string })[] };
}
const USED_ROWS = 40;
const DETAIL_ROWS = 12;

/**
 * One skill's (or Grunt type's) opened row from a walk. Josh's picks on #1082's grilling (2026-11-19): the type rate with the
 * misses, and named but never opened; the page says only what happened, never that a minion should have called it. A
 * Taskmaster counts in "used" but not in the types or the misses (it hands work out; it isn't a minion of a type).
 */
export function skillDetail(scan: SkillScan, tickets: SkillTicket[], projectId: number | null, since: number, name: string, kind: 'skill' | 'agent'): SkillDetail {
  const mine = projectId == null ? tickets : tickets.filter((k) => k.project_id === projectId);
  const byId = new Map(mine.map((k) => [k.id, k]));
  const events = scan.events.filter((e) => byId.has(e.ticket_id) && e.at > since);
  const minion = (k: SkillTicket, at: number): DetailMinion => ({ project_id: k.project_id, number: k.number, title: k.title, type: k.kind === 'coordinator' ? 'taskmaster' : k.type ?? 'none', at });
  const used = new Map<number, SkillDetail['used'][number]>();
  const opened = new Map<number, Set<string>>();
  usageFrom({ events, tickets: mine }, since, (k, n, ticket, at, phase) => {
    if (k !== kind) return;
    opened.set(ticket, (opened.get(ticket) ?? new Set()).add(n));
    if (n !== name) return;
    const row = used.get(ticket) ?? { ...minion(byId.get(ticket)!, at), runs: 0, phases: {} };
    row.runs++;
    row.at = Math.max(row.at, at);
    if (phase) row.phases[phase] = (row.phases[phase] ?? 0) + 1;
    used.set(ticket, row);
  });
  const last = new Map<number, number>();
  for (const e of events) last.set(e.ticket_id, Math.max(last.get(e.ticket_id) ?? 0, e.at));
  const workers = mine.filter((k) => k.kind !== 'coordinator' && last.has(k.id));
  const types = new Map<string, { type: string; active: number; opened: number }>();
  for (const k of workers) {
    const t = k.type ?? 'none';
    const row = types.get(t) ?? { type: t, active: 0, opened: 0 };
    row.active++;
    if (used.has(k.id)) row.opened++;
    types.set(t, row);
  }
  const typeRows = [...types.values()].sort((a, b) => b.opened - a.opened || b.active - a.active);
  const top = typeRows.find((t) => t.opened > 0);
  const missed = top ? workers.filter((k) => (k.type ?? 'none') === top.type && !used.has(k.id)).sort((a, b) => last.get(b.id)! - last.get(a.id)!) : [];
  const named = new Map<number, SkillDetail['named']['rows'][number]>();
  for (const m of scan.mentions) {
    const k = byId.get(m.ticket_id);
    if (m.name !== name || m.at <= since || !k || k.kind === 'coordinator' || used.has(k.id)) continue;
    const row = named.get(k.id);
    if (!row) named.set(k.id, { ...minion(k, m.at), quote: m.quote });
    else row.at = Math.max(row.at, m.at);
  }
  const newest = <T extends { at: number }>(rows: T[]) => rows.sort((a, b) => b.at - a.at);
  return {
    used: newest([...used.values()]).slice(0, USED_ROWS),
    types: typeRows,
    misses: top ? { type: top.type, total: missed.length, rows: missed.slice(0, DETAIL_ROWS).map((k) => ({ ...minion(k, last.get(k.id)!), opened: [...(opened.get(k.id) ?? [])] })) } : null,
    named: { total: named.size, rows: newest([...named.values()]).slice(0, DETAIL_ROWS) },
  };
}

/** A scan's result: the scan to keep, its minions, and a report per key asked for ("all" or a scheme's id). */
interface Refreshed { scan: SkillScan; tickets: SkillTicket[]; reports: Record<string, UsageReport> }
const keyOf = (projectId: number | null) => String(projectId ?? 'all');
function refresh(db: DatabaseSync, since: number, prev: SkillScan | null, keys: string[], now: number): Refreshed {
  const { scan, tickets } = scanSkills(db, since, prev, now);
  return { scan, tickets, reports: Object.fromEntries(keys.map((k) => [k, reportFor(scan, tickets, k === 'all' ? null : Number(k), since)])) };
}

const reports = new Map<string, { at: number; report: UsageReport }>();
const wanted = new Set<string>();
let kept: { scan: SkillScan; tickets: SkillTicket[]; since: number } | null = null;
let running: Promise<void> | null = null;

/**
 * A scheme's usage over the last USAGE_DAYS (`projectId` null: every scheme's), straight from the last report and however old
 * it is, or null before the first scan has finished. A report older than CACHE_MS (or none for this scheme) starts a refresh in
 * the background: nobody waits on the scan.
 */
export function cachedUsage(store: Store, projectId: number | null, now = Date.now()): UsageReport | null {
  const hit = reports.get(keyOf(projectId));
  if (!hit || now - hit.at >= CACHE_MS) void refreshUsage(store, projectId, now).catch((err) => console.error('skill usage refresh:', err.message));
  return hit?.report ?? null;
}

/**
 * Refresh the reports (all that were asked for so far, plus this one) and resolve with this scheme's. Sessions asking at once
 * share one scan. The scan reads only the events since the last one, on a worker thread with its own read-only connection, as
 * the session worker does (#612); an in-memory store (tests) runs it here. The live volume is 562k events, 850 MB of JSON: a
 * full scan is about 2 s, an incremental one a few ms.
 */
export function refreshUsage(store: Store, projectId: number | null, now = Date.now()): Promise<UsageReport> {
  const key = keyOf(projectId);
  wanted.add(key);
  const answer = () => reports.get(key)!.report;
  const go = (): Promise<void> => {
    const keys = [...wanted];
    const since = now - USAGE_DAYS * 86_400_000;
    const job: Promise<Refreshed> = store.path === ':memory:'
      ? Promise.resolve(refresh(store.db, since, kept?.scan ?? null, keys, now))
      : new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { skillUsage: { path: store.path, since, prev: kept?.scan ?? null, keys, now } } });
          worker.once('message', resolve);
          worker.once('error', reject);
          worker.once('exit', (code) => reject(new Error(`the skill usage worker stopped (exit code ${code}) before it finished`)));
        });
    return job.then((r) => {
      kept = { scan: r.scan, tickets: r.tickets, since };
      for (const [k, report] of Object.entries(r.reports)) reports.set(k, { at: now, report });
    });
  };
  const fresh = reports.get(key);
  if (fresh && now - fresh.at < CACHE_MS) return Promise.resolve(fresh.report);
  // A refresh already running started before this key was asked for: when it ends, a missing key gets its own.
  const done = (running ??= go().finally(() => (running = null))).then(() => (reports.has(key) ? answer() : refreshUsage(store, projectId, now)));
  return done;
}

/** One skill's or Grunt type's opened row, from the newest scan (waiting for the first; an old one starts a refresh behind it). */
export async function usageDetail(store: Store, projectId: number | null, name: string, kind: 'skill' | 'agent', now = Date.now()): Promise<SkillDetail & { since: number }> {
  if (kept) cachedUsage(store, projectId, now);
  else await refreshUsage(store, projectId, now);
  return { since: kept!.since, ...skillDetail(kept!.scan, kept!.tickets, projectId, kept!.since, name, kind) };
}

/** Forget every report and the kept scan (tests; the reports are keyed by scheme id, which every test database reuses). */
export function forgetUsage(): void {
  reports.clear();
  wanted.clear();
  kept = null;
}

/** Warm the reports at boot, then keep them fresh, so the page never meets a cold cache. */
export function warmUsage(store: Store): void {
  if (store.path === ':memory:') return;
  const warm = () => {
    for (const p of store.listProjects()) wanted.add(keyOf(p.id));
    refreshUsage(store, null).catch((err) => console.error('skill usage warm-up:', err.message));
  };
  setTimeout(warm, 5_000).unref();
  setInterval(warm, CACHE_MS / 2).unref();
}

if (!isMainThread && workerData?.skillUsage) {
  const { path, since, prev, keys, now } = workerData.skillUsage as { path: string; since: number; prev: SkillScan | null; keys: string[]; now: number };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    parentPort!.postMessage(refresh(db, since, prev, keys, now));
  } finally {
    db.close();
  }
}

/**
 * What a scheme gives up when it turns a kit skill off, for the confirm box. Josh (2026-11-19): nothing is locked, "maybe add
 * a warning". Self-review's line is Cara's rule for the pre-ship review (Build 4's Q10, 2026-11-19): with it off, every ship
 * waits for a person's go.
 */
export const OFF_WARNINGS: Record<string, string> = {
  'self-review': 'No pre-ship review: minions can\'t label a change\'s risk themselves, so every ship in this scheme waits for a person\'s go.',
  subagents: 'Minions lose the rules for which model and effort each Grunt gets, so Grunts may run on pricier models or brief each other badly.',
  'scheme-setup': 'A setup or tune-up minion can\'t apply an approved setup plan to this scheme\'s repo.',
  'bug-fixing': 'Bug minions lose the proof-before-fix order, so a quick change can hide a bug instead of fixing it.',
  critique: 'Critic rounds stop: the rubric critics on the Reviewers and critics page don\'t run.',
  'docs-and-mocks': 'Choices pages and mocks lose the kit\'s format, so picking on a page may stop working.',
  'writing-for-agents': 'Changes to instructions, rules and skills lose their checks.',
  grilling: 'Design-shaped features start without a grilling round of questions.',
};
