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

/**
 * Walk the timeline minion by minion, turn by turn (a turn ends at its result event). A skill run's phase: an error since
 * the last edit or skill run in the turn makes it "after an error"; else whether the turn had edited a file yet, and a run
 * after edits becomes "before a ship" when the same turn later hands off a ship. A Grunt's own events count as the minion's.
 */
export function usageFrom(t: SkillTimeline, since: number): UsageReport {
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
  type Open = { usage: Usage; phase: Phase };
  let ticket = -1;
  let edited = false;
  let errored = false;
  let open: Open[] = [];
  let lastSkill: string | null = null;
  const endTurn = () => {
    for (const o of open) bump(o.usage.phases, o.phase);
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
      open.push({ usage: u, phase: errored ? 'after an error' : edited ? 'after edits' : 'before any edit' });
      lastSkill = name;
      errored = false;
    }
    for (const name of e.agents?.split(' ').filter(Boolean) ?? []) {
      const u = (agents[name] ??= blank());
      count(u, e.ticket_id, e.at, e.id);
      bump(u.with, lastSkill ?? 'none');
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

function skillTickets(db: DatabaseSync, events: SkillEvent[], from: number): SkillTicket[] {
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
export interface SkillScan { hi: number; events: SkillEvent[]; fullAt: number }

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
    return { scan: { hi, events, fullAt: full ? now : prev!.fullAt }, tickets: skillTickets(db, events, from) };
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

/** A scan's result: the scan to keep and a report per key asked for ("all" or a scheme's id). */
interface Refreshed { scan: SkillScan; reports: Record<string, UsageReport> }
const keyOf = (projectId: number | null) => String(projectId ?? 'all');
function refresh(db: DatabaseSync, since: number, prev: SkillScan | null, keys: string[], now: number): Refreshed {
  const { scan, tickets } = scanSkills(db, since, prev, now);
  return { scan, reports: Object.fromEntries(keys.map((k) => [k, reportFor(scan, tickets, k === 'all' ? null : Number(k), since)])) };
}

const reports = new Map<string, { at: number; report: UsageReport }>();
const wanted = new Set<string>();
let kept: SkillScan | null = null;
let running: Promise<void> | null = null;

/**
 * A scheme's usage over the last USAGE_DAYS (`projectId` null: every scheme's), straight from the last report and however old
 * it is, or null before the first scan has finished. A report older than CACHE_MS (or none for this scheme) starts a refresh in
 * the background: nobody waits on the scan.
 */
export function cachedUsage(store: Store, projectId: number | null, now = Date.now()): UsageReport | null {
  const hit = reports.get(keyOf(projectId));
  if (!hit || now - hit.at >= CACHE_MS) void refreshUsage(store, projectId, now).catch(() => {});
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
      ? Promise.resolve(refresh(store.db, since, kept, keys, now))
      : new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { skillUsage: { path: store.path, since, prev: kept, keys, now } } });
          worker.once('message', resolve);
          worker.once('error', reject);
          worker.once('exit', (code) => reject(new Error(`the skill usage worker stopped (exit code ${code}) before it finished`)));
        });
    return job.then((r) => {
      kept = r.scan;
      for (const [k, report] of Object.entries(r.reports)) reports.set(k, { at: now, report });
    });
  };
  const fresh = reports.get(key);
  if (fresh && now - fresh.at < CACHE_MS) return Promise.resolve(fresh.report);
  // A refresh already running started before this key was asked for: when it ends, a missing key gets its own.
  const done = (running ??= go().finally(() => (running = null))).then(() => (reports.has(key) ? answer() : refreshUsage(store, projectId, now)));
  return done;
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
