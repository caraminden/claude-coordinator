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

/** Split a description into what it does and when to use it: sentences opening "Use", "Open", "Also for/when" or "Only when" are the trigger. */
export function splitDescription(text: string): { what: string; trigger: string } {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
  const isTrigger = (s: string) => /^(Use\b|Open\b|Also (for|when|use)\b|Only when\b|TRIGGER\b)/.test(s);
  return { what: sentences.filter((s) => !isTrigger(s)).join(' '), trigger: sentences.filter(isTrigger).join(' ') };
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
 * is left out in SQL. Its minions (number, title, type) and each one's newest "Shipped" note come with it.
 */
export function skillTimeline(db: DatabaseSync, projectId: number | null, since: number): SkillTimeline {
  // Event ids grow with time: start after the last turn that ended by `since`, so the rowid range skips everything older.
  const before = db.prepare('SELECT event_id FROM turns WHERE ended_at <= ? AND event_id IS NOT NULL ORDER BY ended_at DESC LIMIT 1').get(since) as { event_id: number } | undefined;
  const from = before?.event_id ?? 0;
  const tools = (name: string, field: string, fallback: string) => `CASE WHEN e.data LIKE '%"name":"${name}"%' THEN (SELECT group_concat(coalesce(json_extract(c.value, '$.input.${field}'), '${fallback}'), ' ')
      FROM json_each(e.data, '$.message.content') c WHERE json_extract(c.value, '$.type') = 'tool_use' AND json_extract(c.value, '$.name') = '${name}') END`;
  const events = db.prepare(`
    SELECT * FROM (SELECT e.id, e.ticket_id, e.created_at AS at,
        ${tools('Skill', 'skill', '')} AS skills,
        ${tools('Agent', 'subagent_type', 'general-purpose')} AS agents,
        (e.data LIKE '%"name":"Edit"%' OR e.data LIKE '%"name":"Write"%' OR e.data LIKE '%"name":"NotebookEdit"%') AS edit,
        (e.data LIKE '{"type":"user"%' AND e.data LIKE '%"is_error":true%') AS error,
        (e.data LIKE '%"name":"mcp__thread__hand_off_land"%' OR e.data LIKE '%"name":"mcp__thread__land"%') AS ship,
        (e.data LIKE '{"type":"result"%') AS result,
        (e.data LIKE '%"parent_tool_use_id":"%') AS grunt
      FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.id > ?1 AND e.kind = 'claude' AND e.created_at > ?2 AND (?3 IS NULL OR t.project_id = ?3))
    WHERE skills IS NOT NULL OR agents IS NOT NULL OR edit OR error OR ship OR result
    ORDER BY ticket_id, id`).all(from, since, projectId) as unknown as SkillEvent[];
  const ids = [...new Set(events.map((e) => e.ticket_id))];
  if (!ids.length) return { events, tickets: [] };
  const tickets = db.prepare(`
    SELECT k.id, k.project_id, k.number, k.title, k.kind,
      (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
        WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type,
      (SELECT max(n.id) FROM events n WHERE n.ticket_id = k.id AND n.kind = 'note' AND n.id > ?1 AND n.data LIKE '{"text":"Shipped %') AS shipped
    FROM tickets k WHERE k.id IN (SELECT value FROM json_each(?2))`).all(from, JSON.stringify(ids)) as unknown as SkillTicket[];
  return { events, tickets };
}

const cache = new Map<string, { at: number; report: UsageReport }>();
const running = new Map<string, Promise<UsageReport>>();

/**
 * A scheme's usage over the last USAGE_DAYS (`projectId` null: every scheme's), reused for CACHE_MS. The scan reads every
 * Claude event in the window (live: 555k rows, 800 MB of JSON, about a second), so it runs on a worker thread with its own
 * read-only connection, as the session worker does (#612); an in-memory store (tests) runs it here.
 */
export function skillUsage(store: Store, projectId: number | null, now = Date.now()): Promise<UsageReport> {
  const key = String(projectId ?? 'all');
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return Promise.resolve(hit.report);
  const pending = running.get(key);
  if (pending) return pending;
  const since = now - USAGE_DAYS * 86_400_000;
  const job: Promise<UsageReport> = store.path === ':memory:'
    ? Promise.resolve(usageFrom(skillTimeline(store.db, projectId, since), since))
    : new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { skillUsage: { path: store.path, projectId, since } } });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error(`the skill usage worker stopped (exit code ${code}) before it finished`)));
      });
  const done = job.then((report) => (cache.set(key, { at: now, report }), report)).finally(() => running.delete(key));
  running.set(key, done);
  return done;
}

if (!isMainThread && workerData?.skillUsage) {
  const { path, projectId, since } = workerData.skillUsage as { path: string; projectId: number | null; since: number };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    parentPort!.postMessage(usageFrom(skillTimeline(db, projectId, since), since));
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
