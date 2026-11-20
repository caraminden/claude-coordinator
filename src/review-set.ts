// A scheme's review set (Build 4, docs/adr/0013-review-set.md): every critic, reviewer and audit that judges its work,
// stored here rather than as repo files (Cara, 2026-11-19, Q2: "Citadel stores them"). Each entry is the rubric format
// (kit/skills/critique/references/rubric-format.md): the keys the page switches on are columns, the rest of the
// rubric (its other frontmatter keys and its sections) is the body. Every save is a version; History restores one.
// Turns read the enabled entries as rendered rubric files (renderSet), so critics read them the way they read repo files.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_entries (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The rubric's name: kebab-case, what result lines and the rendered file are called.
  slug TEXT NOT NULL,
  -- What the page calls it, "UI screenshots critic".
  name TEXT NOT NULL,
  -- critic, reviewer, checker, referee, teacher or audit (phase 2 adds the built-in reviewers as entries).
  kind TEXT NOT NULL DEFAULT 'critic',
  -- A kit starter's slug (kit/skills/critique/rubrics/<slug>.md) this entry adds to, or NULL; the body holds only its additions.
  extends TEXT,
  -- The rubric's frontmatter keys other than the columns', then its sections.
  body TEXT NOT NULL DEFAULT '',
  -- When it runs, as JSON: {diff: [globs], creative, schedule, in_app, types: [minion types], ask: true}.
  triggers TEXT NOT NULL DEFAULT '{}',
  -- What it may read, as JSON: {guides: [{label, href}], paths: [repo paths], verdicts: bool, requester: bool}.
  context TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- New entries advise only until calibrated or a person marks them good (Q12).
  trial INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  effort TEXT,
  -- The page's column (work, ship, ask, schedule) and the run order inside it (phase 3 wires the order).
  stage TEXT NOT NULL DEFAULT 'work',
  position INTEGER NOT NULL DEFAULT 0,
  -- block or advise: written into the rendered rubric's gate key (blocks-ready or advisory); NULL: the body's own gate key decides.
  gate TEXT,
  -- Where it came from: "docs/rubrics/ui.md" for an imported file, "kit:<agent or skill>" for a kit built-in (BUILT_INS), NULL for one made on the page.
  source TEXT,
  -- It gives the risk label that decides whether a ship waits for a go (Q10): the pre-ship review's stand-in when that is off.
  gives_label INTEGER NOT NULL DEFAULT 0,
  -- Its last calibration as JSON (Q12): {at, by, model, hits, notes, false_alarms, controls}, or {at, by, good: true} when a person marked it good.
  calibration TEXT,
  -- A panel's name (Q7, phase 3): entries of a column with the same panel judge the same work at once, and its referee entry merges their verdicts.
  panel TEXT,
  -- Hand off on a fail (Q7) as JSON: [{after: 2, to: "professor"}, {after: 3, to: "person"}]; "to" is professor, person or another entry's slug. NULL: the kind's default.
  on_fail TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, slug)
);
-- Every save of an entry, whole, so History can show and restore any of them.
CREATE TABLE IF NOT EXISTS review_versions (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES review_entries(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- What changed, in a few words: "Turned off", "Edited by hand", "Restored version 3".
  note TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL,
  UNIQUE (entry_id, version)
);
-- The run record (Q4, phase 3): one row per critic or reviewer run a minion records, for the page's dots and pass rate.
CREATE TABLE IF NOT EXISTS review_runs (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES review_entries(id) ON DELETE CASCADE,
  -- The minion that ran it (no foreign key: the record outlives a deleted minion), and its #N as people read it.
  ticket_id INTEGER,
  minion TEXT NOT NULL,
  round INTEGER NOT NULL,
  -- pass, fail or ask (the item went to a person).
  verdict TEXT NOT NULL,
  -- A person disagreed with this run's verdict (record_verdict): an amber dot.
  disagreed INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_runs_entry ON review_runs(entry_id, id);
-- People's disagreements with an entry's verdicts (Q13, Josh: "Only the minion records it"), read by its later runs when its
-- context has verdicts on. Only a minion adds one; a person removes one on the page.
CREATE TABLE IF NOT EXISTS review_verdicts (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES review_entries(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  -- The person's own words, quoted.
  words TEXT NOT NULL,
  ticket_id INTEGER,
  minion TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_verdicts_entry ON review_verdicts(entry_id, id);
`;

export const KINDS = ['critic', 'reviewer', 'checker', 'referee', 'teacher', 'audit'] as const;
export const STAGES = ['work', 'ship', 'ask', 'schedule'] as const;
const MODELS = ['opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high'];
/** The kit's rubric starters; example.md is the format's worked example, not a starter. */
export const STARTER_DIR = join(import.meta.dirname, '..', 'kit', 'skills', 'critique', 'rubrics');

export interface Triggers { diff?: string[]; creative?: string; schedule?: string; in_app?: string; types?: string[]; ask?: boolean }
export interface Context { guides?: { label: string; href: string }[]; paths?: string[]; verdicts?: boolean; requester?: boolean }
/** One hand-off step (Q7): after `after` failed rounds the item goes `to` the professor, a person, or another entry by slug. */
export interface OnFail { after: number; to: string }
/** A critic's hand-offs when its row sets none: today's loop (citadel:critique), the professor on the second fail and a person on the third. */
export const CRITIC_ON_FAIL: OnFail[] = [{ after: 2, to: 'professor' }, { after: 3, to: 'person' }];
export const VERDICTS = ['pass', 'fail', 'ask'] as const;
export interface Run { id: number; minion: string; round: number; verdict: string; disagreed: boolean; at: number }
export interface Verdict { id: number; person: string; words: string; minion: string; at: number }

export interface ReviewEntry {
  id: number;
  project_id: number;
  slug: string;
  name: string;
  kind: string;
  extends: string | null;
  body: string;
  triggers: Triggers;
  context: Context;
  enabled: boolean;
  trial: boolean;
  model: string | null;
  effort: string | null;
  stage: string;
  position: number;
  gate: string | null;
  source: string | null;
  gives_label: boolean;
  calibration: Calibration | null;
  panel: string | null;
  on_fail: OnFail[] | null;
  version: number;
  updated_by: string;
  updated_at: number;
}

/** The fields a save may set: everything but the row's identity and bookkeeping. */
export type EntryFields = Pick<ReviewEntry, 'slug' | 'name' | 'kind' | 'extends' | 'body' | 'triggers' | 'context' | 'enabled' | 'trial' | 'model' | 'effort' | 'stage' | 'position' | 'gate' | 'source' | 'gives_label' | 'calibration' | 'panel' | 'on_fail'>;
const FIELDS = ['slug', 'name', 'kind', 'extends', 'body', 'triggers', 'context', 'enabled', 'trial', 'model', 'effort', 'stage', 'position', 'gate', 'source', 'gives_label', 'calibration', 'panel', 'on_fail'] as const;

/** A calibration run's counts (citadel:critique, references/calibrate.md), or a person's "mark it good". */
export interface Calibration { at: number; by: string; model?: string; hits?: number; notes?: number; false_alarms?: number; controls?: number; good?: boolean }

/**
 * The kit's own reviewers (Q1, Q9): on every scheme's page as entries, each switchable per scheme. Their text stays in
 * the kit (`source` names where); an entry's body holds only the scheme's additions. The "Always" lenses are part of the
 * pre-ship review itself and go with it. The lenses' list must match references/lenses.md (test/review-set.test.ts).
 */
export const BUILT_INS: { slug: string; name: string; kind: string; source: string; when: string; what: string }[] = [
  { slug: 'pre-ship-review', name: 'Pre-ship review', kind: 'reviewer', source: 'kit:citadel:self-review', when: 'Every change, before it ships', what: "A reviewer Grunt reads the diff through the lenses below and gives the risk label that decides whether a ship waits for a person's go. Its \"Always\" lenses go with it." },
  ...([
    ['error-handling', 'Error handling', 'a try/catch, a default, an HTTP status or error message in the diff'],
    ['comments', 'Comments', 'a comment or doc that describes code, added or edited'],
    ['tests', 'Tests', 'logic changed, or tests added or changed'],
    ['new-types', 'New types', 'a new type, class, table or JSON format'],
    ['access-and-secrets', 'Access and secrets', 'auth or access-control files, or code that reads a secret'],
    ['smells', 'Smells', 'a new module, or over about 100 new lines of logic'],
    ['agent-instructions', 'Agent instructions', 'text an agent reads as instructions: the kit, CLAUDE.md, prompts, tool descriptions'],
    ['check-claims', 'Check claims', 'a check added or changed: a test, lint, audit or count'],
    ['ui-findings', 'UI findings', 'a front-end file'],
  ] as const).map(([slug, name, when]) => ({ slug: `lens-${slug}`, name: `Lens: ${name}`, kind: 'reviewer', source: 'kit:citadel:self-review/references/lenses.md', when, what: `One of the pre-ship review's lenses: the reviewer Grunt reads the diff for ${name.toLowerCase()} when it has ${when}.` })),
  { slug: 'finding-checker', name: 'Finding checker', kind: 'checker', source: 'kit:citadel:finding-checker', when: 'Deep pre-ship reviews, after the reviewer', what: "Tries to prove each of the reviewer's findings wrong before the author acts on it." },
  { slug: 'fresh-eyes', name: 'Fresh eyes', kind: 'reviewer', source: 'kit:citadel:fresh-eyes', when: 'Feature PRs, after the retro', what: "Reads the requester's own words against the PR and says what was built that they didn't ask for, and what they asked for that wasn't built." },
  // A teacher (#1089): it runs only when a critic hands it a stubborn fail, so the page hangs it under those critics.
  { slug: 'professor', name: 'Professor', kind: 'teacher', source: 'kit:citadel:professor', when: "When a critic hands it a stubborn fail: after 2 failed rounds, unless the critic's hand-offs say otherwise", what: "Takes the cause a critic keeps failing work on and returns ranked fixes concrete enough to type. Its record is whether the critic's next round passed after its fix." },
];
export const isKit = (e: Pick<ReviewEntry, 'source'>) => !!e.source?.startsWith('kit:');
/** A scheme's own agent file (#1089, Q1 "File"): `agent:.claude/agents/<name>.md` in its repo is its text, read live; its body holds the scheme's additions. */
export const isAgentFile = (e: Pick<ReviewEntry, 'source'>) => !!e.source?.startsWith('agent:');
/** Text that lives outside the set, the kit's or an agent file's: the set holds only the scheme's additions, and renders no rubric for it. */
export const fromFile = (e: Pick<ReviewEntry, 'source'>) => isKit(e) || isAgentFile(e);
/** What an agent file's text fixes: the rest (switch, column, run order, block or advise, hand-offs) is the scheme's to set. */
const AGENT_FIXED = ['slug', 'name', 'kind', 'extends', 'source'] as const;
/** A kit entry's fields that are the kit's, not the scheme's: a save may change only its switch and its additions (body). */
const KIT_FIXED = ['slug', 'name', 'kind', 'extends', 'triggers', 'context', 'model', 'effort', 'stage', 'source', 'trial', 'gate', 'gives_label', 'calibration', 'panel', 'on_fail'] as const;

export interface ReviewVersion { version: number; by: string; at: number; note: string; snapshot: EntryFields }

export class ReviewError extends Error {}

/** `when:` as the rubric format writes it ("diff: a/**, b/** | creative: new art") to triggers, and back. */
export function parseWhen(when: string): Triggers {
  const t: Triggers = {};
  for (const part of when.split('|').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(diff|creative|schedule|in-app|type)\s*:\s*(.*)$/s);
    if (part === 'ask') t.ask = true;
    else if (!m) throw new ReviewError(`"${part}" isn't a when: part (diff: <globs>, creative: <what>, schedule: <cadence>, in-app: <step>, type: <minion types>, or ask)`);
    else if (m[1] === 'diff' || m[1] === 'type') t[m[1] === 'diff' ? 'diff' : 'types'] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else t[m[1] === 'in-app' ? 'in_app' : (m[1] as 'creative' | 'schedule')] = m[2].trim();
  }
  return t;
}

export function whenText(t: Triggers): string {
  return [
    t.diff?.length ? `diff: ${t.diff.join(', ')}` : '',
    t.creative ? `creative: ${t.creative}` : '',
    t.schedule ? `schedule: ${t.schedule}` : '',
    t.in_app ? `in-app: ${t.in_app}` : '',
    t.types?.length ? `type: ${t.types.join(', ')}` : '',
    t.ask ? 'ask' : '',
  ].filter(Boolean).join(' | ');
}

/** The page's column for a set of triggers: anything that fires while working is "work"; only a schedule, "schedule"; only an ask, "ask". */
export function stageFor(t: Triggers): string {
  if (t.diff?.length || t.creative || t.in_app || t.types?.length) return 'work';
  if (t.schedule) return 'schedule';
  return 'ask';
}

/** "ui-screenshots" → "UI screenshots": a first name for an imported rubric; people rename it on the page. */
export function nameFor(slug: string): string {
  const words = slug.split('-').map((w) => (w.length <= 2 ? w.toUpperCase() : w));
  return words.join(' ').replace(/^./, (c) => c.toUpperCase());
}

/** A scheme's agent file that reviews, critiques or teaches (#1089), as readAgentFiles finds it. */
export type AgentFile = { path: string; slug: string; description: string; kind: string; text: string };
// The words that make an agent a judge (Q2 "Guess", Josh 2026-11-19), first match wins: its name, then its description.
const AGENT_GUESS: [RegExp, string][] = [[/\b(professor|teacher|tutor|coach)\b/, 'teacher'], [/\breferee\b/, 'referee'], [/\b(critic|critique|critiques|judge|judges)\b/, 'critic'], [/\b(checker|fact check)\b/, 'checker'], [/\b(audit|auditor)\b/, 'audit'], [/\b(review|reviews|reviewer)\b/, 'reviewer']];

/** Which kind of judge an agent is: its frontmatter `kind:` (any other word, like none, hides it), else a guess from its name, then its description; null for none. */
export function agentKind(name: string, description: string, kind = ''): string | null {
  if (kind) return (KINDS as readonly string[]).includes(kind) ? kind : null;
  for (const s of [name, description]) {
    const words = s.toLowerCase().replace(/[-_]/g, ' ');
    const hit = AGENT_GUESS.find(([re]) => re.test(words));
    if (hit) return hit[1];
  }
  return null;
}

/** A scheme repo's `.claude/agents/*.md` that agentKind counts as judges, read live (at most 100 files of 256 KB). */
export function readAgentFiles(repoDir: string | null | undefined): AgentFile[] {
  if (!repoDir) return [];
  let names: string[];
  try {
    names = readdirSync(join(repoDir, '.claude', 'agents')).filter((n) => n.endsWith('.md')).sort().slice(0, 100);
  } catch {
    return [];
  }
  const out: AgentFile[] = [];
  for (const n of names) {
    let raw: string;
    try {
      raw = readFileSync(join(repoDir, '.claude', 'agents', n), 'utf8');
    } catch {
      continue;
    }
    if (raw.length > 256_000) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const field = (k: string) => unquote(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(fm?.[1] ?? '')?.[1].trim() ?? '');
    const base = n.slice(0, -3);
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const kind = agentKind(field('name') || base, field('description'), field('kind'));
    if (slug && kind) out.push({ path: `.claude/agents/${n}`, slug, description: field('description'), kind, text: (fm ? raw.slice(fm[0].length) : raw).trim() });
  }
  return out;
}

/** A frontmatter value, unquoted the way the rubric files quote one (`when: "diff: public/**"`). */
const unquote = (v: string) => {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s.length >= 2 && s[0] === "'" && s.at(-1) === "'" ? s.slice(1, -1).replaceAll("''", "'") : s;
};
/** Quote a value that YAML would misread: one with ": ", a leading special character, or a trailing colon. */
const quote = (v: string) => (/: |^[\s"'[{>|*&!%@`#-]|:$|\s$/.test(v) ? JSON.stringify(v) : v);

/** The keys the columns own, as they appear in a rubric file's frontmatter. */
const LIFTED = ['name', 'kind', 'extends', 'when', 'model', 'effort'];
const OWNED = /^(name|kind|extends|when|model|effort|trial)\s*:/;

/**
 * A whole rubric file's text to the fields it sets and the body that stays: frontmatter keys the columns own move into
 * them, every other key and the sections stay in the body as they were written. Text with no frontmatter is all body.
 */
export function splitRubric(text: string): { fields: Partial<EntryFields>; body: string } {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: text.trim() };
  const fields: Partial<EntryFields> = {};
  const kept: string[] = [];
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv || !LIFTED.includes(kv[1])) {
      kept.push(line);
      continue;
    }
    const v = unquote(kv[2]);
    if (kv[1] === 'name') fields.slug = v;
    else if (kv[1] === 'kind') { if ((KINDS as readonly string[]).includes(v)) fields.kind = v; }
    else if (kv[1] === 'extends') fields.extends = v.replace(/^citadel:critique\/rubrics\//, '').replace(/\.md$/, '') || null;
    else if (kv[1] === 'when') fields.triggers = v === 'set by the extending rubric' ? {} : parseWhen(v);
    else fields[kv[1] as 'model' | 'effort'] = v || null;
  }
  const rest = kept.join('\n').trim();
  return { fields, body: (rest ? `---\n${rest}\n---\n\n` : '') + m[2].trim() };
}

/**
 * The entry as one rubric file: the columns' keys, then the body's own frontmatter, then its sections and a Context
 * section from its context. `extends:` keeps naming the kit starter, which the critic reads first from the kit as it is
 * that turn (citadel:critic, rubric-format.md "Extending a starter"), so a kit fix reaches every scheme's next run (Q9).
 */
export interface Extra { verdicts?: Verdict[]; requester?: { author: string; text: string } | null }
/** Past verdicts are in an entry's context unless a person switched them off: a disagreement only helps if the next run reads it. */
export const readsVerdicts = (c: Context) => c.verdicts !== false;
export function renderEntry(e: Pick<ReviewEntry, 'slug' | 'extends' | 'triggers' | 'model' | 'effort' | 'body' | 'context' | 'trial'> & Partial<Pick<ReviewEntry, 'gate' | 'calibration' | 'panel' | 'on_fail' | 'kind'>>, extra: Extra = {}): string {
  const cal = e.calibration ? calibratedText(e.calibration) : '';
  // The columns' keys win over the body's own: the gate when the page set one, the calibration once one is recorded.
  const owned = (l: string) => OWNED.test(l) || (!!e.panel && /^panel\s*:/.test(l)) || (!!e.on_fail?.length && /^on_fail\s*:/.test(l)) || (!!e.gate && /^gate\s*:/.test(l)) || (!!cal && /^calibrated\s*:/.test(l));
  const own = e.body.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = [
    `name: ${e.slug}`,
    // A teacher is read by citadel:critique's hand-off (step 5), not run on a `when:`: the file says so.
    e.kind === 'teacher' ? 'kind: teacher' : '',
    e.extends ? `extends: citadel:critique/rubrics/${e.extends}` : '',
    `when: ${quote(whenText(e.triggers) || (e.kind === 'teacher' ? 'set by the extending rubric' : 'ask'))}`,
    e.model ? `model: ${e.model}` : '',
    e.effort ? `effort: ${e.effort}` : '',
    // On trial (Q12) it only advises, whatever its own gate says.
    e.trial ? 'trial: true' : '',
    e.gate ? `gate: ${e.gate === 'block' ? 'blocks-ready' : 'advisory'}` : '',
    cal ? `calibrated: ${JSON.stringify(cal)}` : '',
    e.panel ? `panel: ${quote(e.panel)}` : '',
    e.on_fail?.length ? `on_fail: ${onFailText(e.on_fail)}` : '',
    // The columns own these keys: a body that writes them too (a minion's save may) can't override a person's switches.
    own ? own[1].split('\n').filter((l) => !owned(l)).join('\n').trim() : '',
  ].filter(Boolean);
  const c = e.context;
  const ctx = [
    ...(c.guides ?? []).map((g) => `- Guide: [${g.label}](${g.href})`),
    ...(c.paths ?? []).map((p) => `- Code and docs: \`${p}\``),
    c.requester ? "- The requester's words: the brief may quote them." : '',
  ].filter(Boolean);
  const sections = (own ? own[2] : e.body).trim();
  const tail: string[] = [];
  if (ctx.length) tail.push(`## Context\n\n${ctx.join('\n')}`);
  // Q13: people's disagreements with this entry's verdicts, newest first, for every later run and for calibration.
  if (readsVerdicts(c) && extra.verdicts?.length) tail.push(verdictsSection(extra.verdicts));
  if (c.requester && extra.requester?.text.trim()) {
    tail.push(`## The requester's words\n\nWhat ${extra.requester.author} asked this minion for, in their own words (the brief may quote them):\n\n${extra.requester.text.trim().slice(0, 4000).split('\n').map((l) => `> ${l}`).join('\n')}`);
  }
  return `---\n${head.join('\n')}\n---\n\n${[sections, ...tail].filter(Boolean).join('\n\n')}\n`;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
/** Hand-offs as one line: "professor after 2 fails, person after 3". */
export function onFailText(steps: OnFail[]): string {
  return steps.map((s) => `${s.to} after ${s.after} fail${s.after === 1 ? '' : 's'}`).join(', ');
}

/** A calibration as the rubric format's `calibrated:` key writes it: "2026-11-19, sonnet: 4/5 hits, 0/2 false alarms". */
export function calibratedText(c: Calibration): string {
  const day = new Date(c.at).toISOString().slice(0, 10);
  if (c.good) return `${day}, marked good by ${c.by}`;
  return `${day}, ${c.model ?? 'unknown model'}: ${c.hits}/${c.notes} hits, ${c.false_alarms}/${c.controls} false alarms`;
}

/** The kit's starters, for New and for the page's "on top of the kit starter" link: slug, what it judges, and its text. */
export function loadStarters(dir = STARTER_DIR): { slug: string; judges: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'example.md').sort().map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    return { slug: f.slice(0, -3), judges: unquote(text.match(/^judges:\s*(.*)$/m)?.[1] ?? ''), text };
  });
}

type Row = Record<string, any>;
const fromRow = (r: Row): ReviewEntry => ({ ...r, triggers: JSON.parse(r.triggers), context: JSON.parse(r.context), enabled: !!r.enabled, trial: !!r.trial, gives_label: !!r.gives_label, calibration: r.calibration ? JSON.parse(r.calibration) : null, on_fail: r.on_fail ? JSON.parse(r.on_fail) : null }) as ReviewEntry;
const snapshotOf = (e: EntryFields): EntryFields => Object.fromEntries(FIELDS.map((k) => [k, e[k]])) as EntryFields;

/** On trial an entry only advises (Q12): it can't block a ship or give the risk label until it is calibrated or marked good. */
function onlyCalibratedJudge(e: EntryFields): void {
  if (e.trial && e.gate === 'block') throw new ReviewError(`${e.name} is on trial, so it only advises: calibrate it or mark it good before it can block`);
  if (e.trial && e.gives_label) throw new ReviewError(`${e.name} is on trial, so it can't give the risk label: calibrate it or mark it good first`);
}

/** Refuse a field a save can't hold, so a bad request changes nothing. */
function check(f: Partial<EntryFields>): void {
  if (f.slug !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug)) throw new ReviewError('The name in files (slug) is kebab-case: lowercase letters, digits and dashes, like ui-screenshots');
  if (f.slug === 'audits') throw new ReviewError('audits is kept for the audits route: pick another name');
  if (f.slug !== undefined && f.slug.length > 60) throw new ReviewError('The slug is at most 60 characters');
  if (f.name !== undefined && (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 80)) throw new ReviewError('A name is 1 to 80 characters');
  if (f.kind !== undefined && !(KINDS as readonly string[]).includes(f.kind)) throw new ReviewError(`kind is one of ${KINDS.join(', ')}`);
  if (f.stage !== undefined && !(STAGES as readonly string[]).includes(f.stage)) throw new ReviewError(`stage is one of ${STAGES.join(', ')}`);
  if (f.model != null && !MODELS.includes(f.model)) throw new ReviewError(`model is one of ${MODELS.join(', ')}, or empty for the format's default`);
  if (f.effort != null && !EFFORTS.includes(f.effort)) throw new ReviewError(`effort is one of ${EFFORTS.join(', ')}, or empty for the format's default`);
  if (f.gate != null && !['block', 'advise'].includes(f.gate)) throw new ReviewError('gate is block or advise');
  if (f.extends != null && !/^[a-z0-9-]+$/.test(f.extends)) throw new ReviewError('extends names a kit starter by its slug, like ui-screenshots');
  if (f.body !== undefined && (typeof f.body !== 'string' || f.body.length > 200_000)) throw new ReviewError('The body is text, at most 200,000 characters');
  if (f.position !== undefined && !Number.isInteger(f.position)) throw new ReviewError('position is a whole number');
  if (f.triggers !== undefined && (typeof f.triggers !== 'object' || f.triggers === null || Array.isArray(f.triggers))) throw new ReviewError('triggers is an object');
  if (f.context !== undefined && (typeof f.context !== 'object' || f.context === null || Array.isArray(f.context))) throw new ReviewError('context is an object');
  const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
  const text = (v: unknown) => v === undefined || typeof v === 'string';
  const flag = (v: unknown) => v === undefined || typeof v === 'boolean';
  const c = f.context as Record<string, unknown> | undefined;
  if (c && (!(c.guides === undefined || Array.isArray(c.guides)) || !strings(c.paths) || !flag(c.verdicts) || !flag(c.requester))) throw new ReviewError('context is {guides: [{label, href}], paths: [text], verdicts: true or false, requester: true or false}');
  if (f.gives_label !== undefined && typeof f.gives_label !== 'boolean') throw new ReviewError('gives_label is true or false');
  for (const g of f.context?.guides ?? []) if (typeof g?.label !== 'string' || typeof g?.href !== 'string') throw new ReviewError('Each guide has a label and an href');
  if (f.panel != null && (typeof f.panel !== 'string' || f.panel.trim().length > 40)) throw new ReviewError('A panel is named in 1 to 40 characters, or empty for none');
  if (f.on_fail != null) {
    const ok = Array.isArray(f.on_fail) && f.on_fail.length <= 4 && f.on_fail.every((s, i, a) => s && Number.isInteger(s.after) && s.after >= 1 && s.after <= 10 && typeof s.to === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.to) && (i === 0 || s.after > a[i - 1].after));
    if (!ok) throw new ReviewError('on_fail is up to 4 steps [{after: failed rounds 1 to 10, rising, to: professor, person or an entry\'s slug}]');
  }
  const t = f.triggers as Record<string, unknown> | undefined;
  if (t && (!strings(t.diff) || !strings(t.types) || !text(t.creative) || !text(t.schedule) || !text(t.in_app) || !flag(t.ask))) throw new ReviewError('triggers is {diff: [globs], types: [minion types], creative, schedule, in_app: text, ask: true or false}');
}

export class ReviewSet {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // One transaction: every autocommitted statement is an fsync, and a new database's setup is held to a few commits (test/db-setup).
    db.exec('BEGIN');
    try {
      db.exec(REVIEW_SCHEMA);
      // A database phase 1 made (build/4 previews and dev copies) has the table without phase 2's columns.
      const has = new Set((db.prepare('PRAGMA table_info(review_entries)').all() as Row[]).map((c) => c.name));
      if (!has.has('gives_label')) db.exec('ALTER TABLE review_entries ADD COLUMN gives_label INTEGER NOT NULL DEFAULT 0');
      if (!has.has('calibration')) db.exec('ALTER TABLE review_entries ADD COLUMN calibration TEXT');
      if (!has.has('panel')) db.exec('ALTER TABLE review_entries ADD COLUMN panel TEXT');
      if (!has.has('on_fail')) db.exec('ALTER TABLE review_entries ADD COLUMN on_fail TEXT');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The scheme's entries in page order: by column, then run order, then name. */
  list(projectId: number): ReviewEntry[] {
    return (this.db.prepare('SELECT * FROM review_entries WHERE project_id = ? ORDER BY position, name').all(projectId) as Row[]).map(fromRow);
  }

  get(projectId: number, slug: string): ReviewEntry | null {
    const r = this.db.prepare('SELECT * FROM review_entries WHERE project_id = ? AND slug = ?').get(projectId, slug) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** A new entry, its first version. `fields.slug` must be free in the scheme. */
  create(projectId: number, fields: Partial<EntryFields> & { slug: string; name: string }, by: string, note = 'Made', at = Date.now()): ReviewEntry {
    check(fields);
    if (this.get(projectId, fields.slug)) throw new ReviewError(`This scheme already has an entry named ${fields.slug}`);
    const triggers = fields.triggers ?? {};
    const row: EntryFields = {
      slug: fields.slug, name: fields.name.trim(), kind: fields.kind ?? 'critic', extends: fields.extends ?? null, body: fields.body ?? '',
      triggers, context: fields.context ?? {}, enabled: fields.enabled ?? true, trial: fields.trial ?? false,
      model: fields.model ?? null, effort: fields.effort ?? null, stage: fields.stage ?? stageFor(triggers),
      position: fields.position ?? this.nextPosition(projectId), gate: fields.gate ?? null, source: fields.source ?? null,
      gives_label: fields.gives_label ?? false, calibration: fields.calibration ?? null,
      panel: fields.panel?.trim() || null, on_fail: fields.on_fail ?? null,
    };
    onlyCalibratedJudge(row);
    this.handOffsExist(projectId, row);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO review_entries (project_id, slug, name, kind, extends, body, triggers, context, enabled, trial, model, effort, stage, position, gate, source, gives_label, calibration, panel, on_fail, version, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        projectId, row.slug, row.name, row.kind, row.extends, row.body, JSON.stringify(row.triggers), JSON.stringify(row.context),
        row.enabled ? 1 : 0, row.trial ? 1 : 0, row.model, row.effort, row.stage, row.position, row.gate, row.source, row.gives_label ? 1 : 0, row.calibration ? JSON.stringify(row.calibration) : null,
        row.panel, row.on_fail ? JSON.stringify(row.on_fail) : null, by, at);
      this.db.prepare('INSERT INTO review_versions (entry_id, version, by, at, note, snapshot) VALUES (?, 1, ?, ?, ?, ?)').run(Number(lastInsertRowid), by, at, note, JSON.stringify(row));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get(projectId, row.slug)!;
  }

  /**
   * Save `patch` over the entry as a new version. `expect` is the version the editor started from: a save over a newer
   * one is refused (409 at the route), so two people editing at once can't silently drop each other's words.
   */
  save(projectId: number, slug: string, patch: Partial<EntryFields>, by: string, note: string, expect?: number, at = Date.now()): ReviewEntry {
    check(patch);
    const was = this.get(projectId, slug);
    if (!was) throw new ReviewError(`No entry named ${slug}`);
    if (expect !== undefined && expect !== was.version) throw new ReviewError(`stale: ${slug} is at version ${was.version} now (${was.updated_by} saved it); reload it and make your change again`);
    if (patch.slug !== undefined && patch.slug !== slug && this.get(projectId, patch.slug)) throw new ReviewError(`This scheme already has an entry named ${patch.slug}`);
    const next = snapshotOf({ ...was, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as EntryFields);
    next.panel = next.panel?.trim() || null;
    if (next.on_fail && !next.on_fail.length) next.on_fail = null;
    // Back on trial, it only advises (Q12): a person putting a blocker back on trial means that, not "switch it to Advise first".
    if (next.trial && !was.trial && !isKit(was)) Object.assign(next, { gate: next.gate === 'block' ? 'advise' : next.gate, gives_label: false });
    if (JSON.stringify(next) === JSON.stringify(snapshotOf(was))) return was;
    if (isKit(was)) {
      const changed = KIT_FIXED.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(was[k]));
      if (changed.length) throw new ReviewError(`${was.name} is the kit's: a scheme switches it on or off and adds to its text, but can't change its ${changed.join(', ')}`);
    }
    if (isAgentFile(was)) {
      const changed = AGENT_FIXED.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(was[k]));
      if (changed.length) throw new ReviewError(`${was.name} is this scheme's agent file ${was.source!.slice(6)}: change its ${changed.join(', ')} in the file (a kind: line sets the kind)`);
    }
    onlyCalibratedJudge(next);
    this.handOffsExist(projectId, next);
    const version = was.version + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE review_entries SET slug = ?, name = ?, kind = ?, extends = ?, body = ?, triggers = ?, context = ?, enabled = ?, trial = ?, model = ?, effort = ?,
        stage = ?, position = ?, gate = ?, source = ?, gives_label = ?, calibration = ?, panel = ?, on_fail = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(
        next.slug, next.name, next.kind, next.extends, next.body, JSON.stringify(next.triggers), JSON.stringify(next.context), next.enabled ? 1 : 0, next.trial ? 1 : 0,
        next.model, next.effort, next.stage, next.position, next.gate, next.source, next.gives_label ? 1 : 0, next.calibration ? JSON.stringify(next.calibration) : null,
        next.panel, next.on_fail ? JSON.stringify(next.on_fail) : null, version, by, at, was.id);
      this.db.prepare('INSERT INTO review_versions (entry_id, version, by, at, note, snapshot) VALUES (?, ?, ?, ?, ?, ?)').run(was.id, version, by, at, note, JSON.stringify(next));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get(projectId, next.slug)!;
  }

  /** Every saved version, newest first. */
  versions(projectId: number, slug: string): ReviewVersion[] {
    const e = this.get(projectId, slug);
    if (!e) throw new ReviewError(`No entry named ${slug}`);
    return (this.db.prepare('SELECT version, by, at, note, snapshot FROM review_versions WHERE entry_id = ? ORDER BY version DESC').all(e.id) as Row[])
      .map((r) => ({ version: r.version, by: r.by, at: r.at, note: r.note, snapshot: JSON.parse(r.snapshot) }));
  }

  /** Put version `n` back, as a new version on top: nothing in History is ever lost. The slug stays what it is now. */
  restore(projectId: number, slug: string, n: number, by: string): ReviewEntry {
    const v = this.versions(projectId, slug).find((x) => x.version === n);
    if (!v) throw new ReviewError(`${slug} has no version ${n}`);
    return this.save(projectId, slug, { ...v.snapshot, slug }, by, `Restored version ${n}`);
  }

  /**
   * Add the kit's built-ins (BUILT_INS) a scheme doesn't have yet, on, at the front of the ship column. Idempotent; a
   * scheme's own entry that already took a built-in's slug keeps it, and that built-in stays at its kit default (on).
   */
  ensureBuiltIns(projectId: number, at = Date.now()): void {
    const have = new Set((this.db.prepare('SELECT slug FROM review_entries WHERE project_id = ?').all(projectId) as Row[]).map((r) => r.slug));
    BUILT_INS.forEach((b, i) => {
      if (have.has(b.slug)) return;
      this.create(projectId, { slug: b.slug, name: b.name, kind: b.kind, source: b.source, stage: 'ship', position: i - BUILT_INS.length - 1000 }, 'Citadel', 'The kit\'s, added to the page', at);
    });
  }

  /**
   * An entry for each of the scheme's reviewing agent files (readAgentFiles) it has no entry for yet, on, its text left
   * in the file. An entry of the scheme's own with the same slug is that agent's row already (Q4 "One"), so it adds none.
   */
  ensureAgents(projectId: number, files: AgentFile[], at = Date.now()): void {
    for (const f of files) {
      const was = this.get(projectId, f.slug);
      // The file is the source of its kind (save refuses a kind change there): a `kind:` edit reaches its entry, with no version.
      if (was) {
        if (isAgentFile(was) && was.source === `agent:${f.path}` && was.kind !== f.kind) this.db.prepare('UPDATE review_entries SET kind = ? WHERE id = ?').run(f.kind, was.id);
        continue;
      }
      // A file named like a reserved or over-long slug stays off the page rather than break it.
      try {
        this.create(projectId, { slug: f.slug, name: nameFor(f.slug), kind: f.kind, source: `agent:${f.path}` }, 'Citadel', `Read from ${f.path}`, at);
      } catch (err) {
        if (!(err instanceof ReviewError)) throw err;
      }
    }
  }

  /** The scheme's kit built-in by slug, or null when it has none or its own entry took the slug. */
  kit(projectId: number, slug: string): ReviewEntry | null {
    const e = this.get(projectId, slug);
    return e && isKit(e) ? e : null;
  }

  /**
   * Whether this scheme's ships get a risk label (Q10): its pre-ship review is on (a scheme that never opened its page
   * has it on), or another entry that is on, off trial, gives one. False: every ship waits for a person's go.
   */
  labelGiver(projectId: number): string | null {
    const pre = this.kit(projectId, 'pre-ship-review');
    if (!pre || pre.enabled) return 'Pre-ship review';
    return this.list(projectId).find((e) => e.enabled && !e.trial && e.gives_label)?.name ?? null;
  }

  /**
   * Record a calibration run (citadel:critique, references/calibrate.md). The calibrate step's own bar takes an entry
   * off trial: most notes hit and no false alarms ("rely on it"). Anything less keeps it on trial; it never puts a
   * calibrated entry back on.
   */
  calibrate(projectId: number, slug: string, r: { hits: number; notes: number; false_alarms: number; controls: number; model?: string | null }, by: string, at = Date.now()): ReviewEntry {
    const n = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000;
    if (![r.hits, r.notes, r.false_alarms, r.controls].every(n) || r.hits > r.notes || r.false_alarms > r.controls || !r.notes) {
      throw new ReviewError('A calibration is whole numbers: hits out of notes (at least 1), and false_alarms out of controls');
    }
    if (r.model != null && (typeof r.model !== 'string' || r.model.length > 60)) throw new ReviewError('model names the model the critic ran on');
    const was = this.get(projectId, slug);
    if (!was) throw new ReviewError(`No entry named ${slug}`);
    // Controls catch a critic that fails everything (calibrate.md), so a run with none can't take it off trial.
    const passes = r.hits * 2 > r.notes && r.false_alarms === 0 && r.controls > 0;
    const calibration: Calibration = { at, by, model: r.model ?? undefined, hits: r.hits, notes: r.notes, false_alarms: r.false_alarms, controls: r.controls };
    const trial = was.trial && !passes;
    return this.save(projectId, slug, { calibration, trial }, by, `Calibrated: ${r.hits}/${r.notes} hits, ${r.false_alarms}/${r.controls} false alarms${was.trial ? (passes ? ', off trial' : ', stays on trial') : ''}`, undefined, at);
  }

  /** An on_fail step that names another entry needs one in this scheme, and not the entry itself. */
  private handOffsExist(projectId: number, e: EntryFields): void {
    for (const s of e.on_fail ?? []) {
      if (s.to === 'professor' || s.to === 'person') continue;
      if (s.to === e.slug) throw new ReviewError(`${e.name} can't hand its fails to itself`);
      if (!this.get(projectId, s.to)) throw new ReviewError(`on_fail names ${s.to}, which isn't in this scheme's review set`);
    }
  }

  /** Move an entry one place up or down among the entries of its column (Q7, Order): later ones see earlier verdicts. */
  move(projectId: number, slug: string, dir: 'up' | 'down', by: string): ReviewEntry {
    const e = this.get(projectId, slug);
    if (!e) throw new ReviewError(`No entry named ${slug}`);
    const col = this.list(projectId).filter((x) => x.stage === e.stage);
    const i = col.findIndex((x) => x.id === e.id);
    const other = col[dir === 'up' ? i - 1 : i + 1];
    if (!other) throw new ReviewError(`${e.name} is already ${dir === 'up' ? 'first' : 'last'} in its column`);
    // Equal positions (two entries made at once) would swap to the same order, so step past the neighbour.
    const [a, b] = e.position === other.position ? [other.position + (dir === 'up' ? -1 : 1), other.position] : [other.position, e.position];
    this.save(projectId, other.slug, { position: b }, by, `Run order: ${dir === 'up' ? 'after' : 'before'} ${e.name}`);
    return this.save(projectId, slug, { position: a }, by, `Run order: ${dir === 'up' ? 'before' : 'after'} ${other.name}`);
  }

  /** Record one run of an entry (Q4): which minion, which round, and its verdict. */
  recordRun(projectId: number, slug: string, r: { ticketId: number | null; minion: string; round: number; verdict: string }, at = Date.now()): Run {
    const e = this.get(projectId, slug);
    if (!e) throw new ReviewError(`No entry named ${slug} in this scheme's review set`);
    if (!(VERDICTS as readonly string[]).includes(r.verdict)) throw new ReviewError(`verdict is ${VERDICTS.join(', ')}`);
    if (!Number.isInteger(r.round) || r.round < 1 || r.round > 50) throw new ReviewError('round is a whole number from 1');
    const { lastInsertRowid } = this.db.prepare('INSERT INTO review_runs (entry_id, ticket_id, minion, round, verdict, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.id, r.ticketId, r.minion, r.round, r.verdict, at);
    return { id: Number(lastInsertRowid), minion: r.minion, round: r.round, verdict: r.verdict, disagreed: false, at };
  }

  /**
   * Record a person's disagreement with an entry's verdict (Q13: only the minion records it): their words quoted, who and
   * when. That minion's latest run of the entry turns amber on the page.
   */
  recordVerdict(projectId: number, slug: string, v: { person: string; words: string; ticketId: number | null; minion: string }, at = Date.now()): Verdict {
    const e = this.get(projectId, slug);
    if (!e) throw new ReviewError(`No entry named ${slug} in this scheme's review set`);
    if (typeof v.person !== 'string' || !v.person.trim() || v.person.length > 80) throw new ReviewError('person is who disagreed, 1 to 80 characters');
    if (typeof v.words !== 'string' || !v.words.trim() || v.words.length > 4000) throw new ReviewError("words are the person's own words, quoted, 1 to 4,000 characters");
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { lastInsertRowid } = this.db.prepare('INSERT INTO review_verdicts (entry_id, person, words, ticket_id, minion, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e.id, v.person.trim(), v.words.trim(), v.ticketId, v.minion, at);
      if (v.ticketId != null) {
        this.db.prepare('UPDATE review_runs SET disagreed = 1 WHERE id = (SELECT max(id) FROM review_runs WHERE entry_id = ? AND ticket_id = ?)').run(e.id, v.ticketId);
      }
      this.db.exec('COMMIT');
      return { id: Number(lastInsertRowid), person: v.person.trim(), words: v.words.trim(), minion: v.minion, at };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Remove a recorded verdict (a person's Edit on the page). */
  removeVerdict(projectId: number, slug: string, id: number): void {
    const e = this.get(projectId, slug);
    if (!e) throw new ReviewError(`No entry named ${slug}`);
    if (!this.db.prepare('DELETE FROM review_verdicts WHERE id = ? AND entry_id = ?').run(id, e.id).changes) throw new ReviewError(`No verdict ${id} on ${e.name}`);
  }

  /** Every entry's recorded verdicts in a scheme, newest first, by entry id. */
  verdicts(projectId: number): Map<number, Verdict[]> {
    const out = new Map<number, Verdict[]>();
    const rows = this.db.prepare(`SELECT v.* FROM review_verdicts v JOIN review_entries e ON e.id = v.entry_id WHERE e.project_id = ? ORDER BY v.id DESC`).all(projectId) as Row[];
    for (const r of rows) {
      const list = out.get(r.entry_id) ?? [];
      if (!out.has(r.entry_id)) out.set(r.entry_id, list);
      list.push({ id: r.id, person: r.person, words: r.words, minion: r.minion, at: r.at });
    }
    return out;
  }

  /**
   * The page's record by entry id (Q4): the last 10 runs oldest first, the first-round pass rate over the last 20 first
   * rounds, and whether it always passes or always fails (5 first rounds or more, all the same). A teacher's rate is over
   * its last 20 runs of any round, each a fix and whether it held (#1089), with `passes` the fixes that held.
   */
  record(projectId: number): Map<number, { runs: Run[]; rate: number | null; firsts: number; passes: number; stuck: 'pass' | 'fail' | null }> {
    const out = new Map<number, { runs: Run[]; rate: number | null; firsts: number; passes: number; stuck: 'pass' | 'fail' | null }>();
    const rows = this.db.prepare(`SELECT * FROM (SELECT r.*, row_number() OVER (PARTITION BY r.entry_id ORDER BY r.id DESC) AS n FROM review_runs r JOIN review_entries e ON e.id = r.entry_id WHERE e.project_id = ?) WHERE n <= 10 ORDER BY id`).all(projectId) as Row[];
    for (const r of rows) {
      if (!out.has(r.entry_id)) out.set(r.entry_id, { runs: [], rate: null, firsts: 0, passes: 0, stuck: null });
      out.get(r.entry_id)!.runs.push({ id: r.id, minion: r.minion, round: r.round, verdict: r.verdict, disagreed: !!r.disagreed, at: r.at });
    }
    // A teacher's every run is one fix and whether the critic's next round passed after it (#1089): its rate is how often a fix held.
    const firsts = this.db.prepare(`SELECT entry_id, teacher, count(*) AS n, sum(verdict = 'pass') AS pass FROM (SELECT r.entry_id, r.verdict, e.kind = 'teacher' AS teacher, row_number() OVER (PARTITION BY r.entry_id ORDER BY r.id DESC) AS k FROM review_runs r JOIN review_entries e ON e.id = r.entry_id WHERE e.project_id = ? AND (r.round = 1 OR e.kind = 'teacher')) WHERE k <= 20 GROUP BY entry_id`).all(projectId) as Row[];
    for (const f of firsts) {
      const rec = out.get(f.entry_id)!;
      rec.firsts = f.n;
      rec.passes = f.pass;
      rec.rate = Math.round((100 * f.pass) / f.n);
      rec.stuck = !f.teacher && f.n >= 5 && (f.pass === f.n || f.pass === 0) ? (f.pass ? 'pass' : 'fail') : null;
    }
    return out;
  }

  /**
   * The entries holding a minion's ship (Q7, Block or advise): on, off trial, set to block, with a last verdict on this
   * minion of fail or ask. A pass in a later round lifts it.
   */
  holds(projectId: number, ticketId: number): { slug: string; name: string; verdict: string }[] {
    const all = this.list(projectId);
    const last = (entryId: number) => this.db.prepare('SELECT id, verdict FROM review_runs WHERE entry_id = ? AND ticket_id = ? ORDER BY id DESC LIMIT 1').get(entryId, ticketId) as Row | undefined;
    const out: { slug: string; name: string; verdict: string }[] = [];
    for (const e of all) {
      if (!e.enabled || e.trial || e.gate !== 'block') continue;
      const r = last(e.id);
      if (!r || r.verdict === 'pass') continue;
      // Its panel's referee, or an entry its hand-offs name, judges in its place: a later pass there lifts it too. A teacher
      // doesn't: its run is one fixed item's next round (#1089), not a verdict on the work.
      const inPlace = all.filter((x) => x.id !== e.id && x.enabled && x.kind !== 'teacher' && ((e.panel && x.panel === e.panel && x.stage === e.stage && x.kind === 'referee') || e.on_fail?.some((s) => s.to === x.slug)));
      if (inPlace.some((x) => { const y = last(x.id); return y && y.id > r.id && y.verdict === 'pass'; })) continue;
      out.push({ slug: e.slug, name: e.name, verdict: r.verdict });
    }
    return out;
  }

  /** The minion's ask (Q8, the requester's words): its first chat message and who wrote it, or null. */
  requesterWords(ticketId: number): Extra['requester'] {
    const r = this.db.prepare("SELECT json_extract(data, '$.author') AS author, json_extract(data, '$.text') AS text FROM events WHERE ticket_id = ? AND kind = 'user_message' ORDER BY id LIMIT 1").get(ticketId) as Row | undefined;
    return r && typeof r.text === 'string' ? { author: String(r.author ?? 'the requester'), text: r.text } : null;
  }

  private nextPosition(projectId: number): number {
    return ((this.db.prepare('SELECT max(position) AS p FROM review_entries WHERE project_id = ?').get(projectId) as { p: number | null }).p ?? -1) + 1;
  }
}

/**
 * Write the scheme's enabled entries into `dir` as `<slug>.md` rubric files, replacing what was there, for a turn's
 * critics to read. Returns how many it wrote.
 */
const verdictsSection = (vs: Verdict[]) =>
  `## Verdicts\n\nPeople disagreed with this entry's verdicts. Judge the way they did:\n\n${vs.map((v) => `- ${v.person}, ${day(v.at)}, on ${v.minion}: "${v.words.replace(/\s+/g, ' ').trim()}"`).join('\n')}`;

export function renderSet(entries: ReviewEntry[], dir: string, verdicts: Map<number, Verdict[]> = new Map(), requester: Extra['requester'] = null): number {
  rmSync(dir, { recursive: true, force: true });
  // The kit's built-ins aren't rubrics: kitLine tells the turn which are off and where the scheme's additions are.
  const on = entries.filter((e) => e.enabled && !fromFile(e));
  if (!on.length) return 0;
  mkdirSync(dir, { recursive: true });
  // A hand-off to an entry since deleted or switched off would send the critic nowhere: those steps drop out.
  const live = (s: OnFail) => s.to === 'professor' || s.to === 'person' || on.some((x) => x.slug === s.to) || entries.some((x) => x.slug === s.to && x.enabled && isAgentFile(x));
  for (const e of on) {
    const steps = e.on_fail?.filter(live) ?? null;
    writeFileSync(join(dir, `${e.slug}.md`), renderEntry({ ...e, on_fail: steps?.length ? steps : null }, { verdicts: verdicts.get(e.id), requester }));
  }
  return on.length;
}

/** The paths a Project facts `Rubrics:` line names ("docs/rubrics/; docs/x.md"), or none for no line or `none`. */
export function rubricsLine(claudeMd: string): string[] {
  const line = claudeMd.match(/^\s*-\s*\*\*Rubrics:\*\*\s*(.*)$/m)?.[1]?.trim() ?? '';
  if (!line || /^none\b/i.test(line)) return [];
  return line.split(';').map((s) => s.trim().replace(/[.`]+$/, '').replace(/^`/, '')).filter(Boolean);
}

/** The rubric files a scheme's repo has under its Rubrics line: [path relative to the repo, text]. */
export function repoRubrics(repoDir: string): [string, string][] {
  const md = join(repoDir, 'CLAUDE.md');
  if (!existsSync(md)) return [];
  const out: [string, string][] = [];
  for (const p of rubricsLine(readFileSync(md, 'utf8'))) {
    const abs = join(repoDir, p);
    const rel = relative(repoDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs)) continue;
    const files = p.endsWith('.md') ? [p] : readdirSync(abs).filter((f) => f.endsWith('.md')).sort().map((f) => join(p, f).replace(/\/+/g, '/'));
    for (const f of files) {
      const text = readFileSync(join(repoDir, f), 'utf8');
      // A folder holds rubrics and maybe a README: only files with rubric frontmatter count (rubric-format.md, "Opting in").
      if (/^---\n[\s\S]*?^name:/m.test(text)) out.push([f, text]);
    }
  }
  return out;
}

/**
 * The one-off move of a scheme's repo rubric files into its set (Q2): each file's text, its extends, when, calibration
 * and people's notes kept as written. A file whose slug the set has already is skipped, so running it twice adds nothing.
 */
export function importRubrics(set: ReviewSet, projectId: number, files: [string, string][], by: string): { added: string[]; skipped: string[]; failed: string[] } {
  const added: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const [path, text] of files) {
    const fileSlug = path.split('/').pop()!.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rubric';
    let split: ReturnType<typeof splitRubric> | null = null;
    let why = '';
    try {
      split = splitRubric(text);
    } catch (err: any) {
      why = err.message;
    }
    const slug = split?.fields.slug ?? fileSlug;
    if (set.get(projectId, slug)) {
      skipped.push(`${path} (already in the set as ${slug})`);
      continue;
    }
    try {
      if (!split) throw new ReviewError(why);
      set.create(projectId, { ...split.fields, slug, name: nameFor(slug), body: split.body, source: path }, by, `Imported from ${path}`);
      added.push(path);
    } catch (err: any) {
      // A file the store refuses still comes in whole, switched off, so nothing is lost and a person fixes it on the page.
      try {
        set.create(projectId, { slug: set.get(projectId, fileSlug) ? `${fileSlug}-imported` : fileSlug, name: nameFor(fileSlug), body: text.replace(/\r\n/g, '\n').trim(), source: path, enabled: false }, by, `Imported from ${path}, off: ${err.message}`);
        added.push(`${path} (off: ${err.message})`);
      } catch (err2: any) {
        failed.push(`${path} (${err2.message})`);
      }
    }
  }
  return { added, skipped, failed };
}

/** The setting that says the one-off import ran (#1051), so an entry someone deletes or renames is never brought back. */
export const IMPORT_KEY = 'review_set_import';

/**
 * Once per database: every scheme's repo rubric files (its Project facts Rubrics line) move into its set. Each
 * scheme's minion then removes the files and the line (relays from Build 4). Returns a line per scheme it touched.
 */
export function importAllRubrics(store: { getSetting<T>(k: string): T | null; setSetting(k: string, v: unknown): void; listProjects(): { id: number; name: string; repo_dir: string | null }[]; reviews: ReviewSet }, now = Date.now()): string[] {
  if (store.getSetting(IMPORT_KEY)) return [];
  const done: string[] = [];
  let retry = false;
  for (const p of store.listProjects()) {
    if (!p.repo_dir) continue;
    const { added, skipped, failed } = importRubrics(store.reviews, p.id, repoRubrics(p.repo_dir), 'Citadel');
    if (failed.length) retry = true;
    if (added.length || skipped.length || failed.length) done.push(`${p.name}: ${added.length ? `imported ${added.join(', ')}` : 'nothing new'}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}${failed.length ? `; FAILED ${failed.join(', ')} (tries again next start)` : ''}`);
  }
  // A file that failed outright tries again on the next start; the ones already in are skipped by slug then.
  if (!retry) store.setSetting(IMPORT_KEY, now);
  return done;
}

/** The turn's line naming its review set (Build 4): the folder renderSet wrote, or that the scheme has none on. */
export function reviewSetLine(dir: string, on: number, entries: ReviewEntry[] = []): string {
  if (!on) return "Review set: this scheme has no reviewers or critics on (its Reviewers and critics page), so no rubric's `when:` matches; a person adds one there, or a Taskmaster with `review_set`.";
  const order = orderLine(entries);
  return `Review set: this scheme's reviewers and critics are on its Reviewers and critics page, and the ${on} that are on are rendered for this turn as rubric files in \`${dir}/\`: that folder is the scheme's rubric set wherever a skill says rubrics (citadel:critique). Read them there; change one only with the \`review_set\` tool, never by editing those files or adding rubric files to the repo.${order ? ` Run order, as the page sets it (citadel:critique, "Order, panels and hand-offs"): ${order}.` : ''}`;
}

/**
 * Each column's run order, with panels grouped: "work: a → [panel Taste: b, c; referee d] → e". Only columns with two
 * or more entries on, or a panel, need saying; one entry on its own runs as before.
 */
export function orderLine(entries: ReviewEntry[]): string {
  // A teacher runs only when a critic hands off to it: it has no place in a column's order.
  const on = entries.filter((e) => e.enabled && !fromFile(e) && e.kind !== 'teacher');
  const cols: string[] = [];
  for (const stage of STAGES) {
    const col = on.filter((e) => e.stage === stage);
    if (col.length < 2 && !col.some((e) => e.panel)) continue;
    const steps: string[] = [];
    const done = new Set<string>();
    for (const e of col) {
      if (!e.panel) { steps.push(`\`${e.slug}\``); continue; }
      if (done.has(e.panel)) continue;
      done.add(e.panel);
      const members = col.filter((x) => x.panel === e.panel);
      const ref = members.filter((x) => x.kind === 'referee');
      const judges = members.filter((x) => x.kind !== 'referee');
      steps.push(`[panel ${e.panel}: ${judges.map((x) => `\`${x.slug}\``).join(', ')} judge at once; ${ref.length ? `referee \`${ref[0].slug}\` merges` : 'no referee, so each verdict stands on its own'}]`);
    }
    cols.push(`${stage}: ${steps.join(' → ')}`);
  }
  return cols.join('; ');
}

/**
 * The turn's line on the kit's built-ins (Q10): which ones this scheme switched off, what that means for the ship, and
 * the scheme's additions to the ones still on, written into `dir` as `<slug>.md`. Empty when all are on as the kit has them.
 */
export function kitLine(entries: ReviewEntry[], dir: string, verdicts: Map<number, Verdict[]> = new Map()): string {
  rmSync(dir, { recursive: true, force: true });
  const kit = entries.filter(isKit);
  const off = kit.filter((e) => !e.enabled);
  // People's recorded verdicts reach a kit reviewer the way its additions do (Q13).
  const said = (e: ReviewEntry) => (readsVerdicts(e.context) && verdicts.get(e.id)) || [];
  const own = entries.filter(isAgentFile);
  const added = entries.filter((e) => fromFile(e) && e.enabled && (e.body.trim() || said(e).length));
  const out: string[] = [];
  if (off.some((e) => e.slug === 'pre-ship-review')) {
    const giver = entries.find((e) => e.enabled && !e.trial && e.gives_label);
    out.push(giver
      ? `This scheme's pre-ship review is off, and its ${giver.name} (\`${giver.slug}\` in the review set) gives the risk label instead: run it where citadel:self-review would run its reviewer, label the change from its verdict, and ship with that label as usual.`
      : "This scheme's pre-ship review is off: don't run citadel:self-review's reviewer and give no risk label. Every ship waits for a person's go, whatever the scheme's shipping instructions say: ask with a ship card, and ship only on that go, the way the scheme ships (with hand_off_land: no risk, and name the go).");
  }
  const rest = off.filter((e) => e.slug !== 'pre-ship-review');
  if (rest.length) out.push(`This scheme switched off: ${rest.map((e) => e.name).join(', ')}. Skip each where a skill would run it: an off lens stays out of the reviewer's brief, an off finding checker is skipped on deep reviews, an off fresh eyes means no citadel:fresh-eyes Grunt, and an off professor means no citadel:professor, so a stubborn fail's hand-off to it goes to the next step (a person, at the last round).`);
  const named = (list: ReviewEntry[]) => list.map((e) => `\`${e.slug}\` (${e.source!.slice(6)})`).join(', ');
  const ownOff = own.filter((e) => !e.enabled);
  if (ownOff.length) out.push(`This scheme switched off its own agents ${named(ownOff)}: don't run them where a skill or the scheme's instructions would, and a hand-off to one goes to its next step.`);
  const ownOn = own.filter((e) => e.enabled);
  if (ownOn.length) out.push(`This scheme's own reviewing agents, whose text is their file: ${named(ownOn)}. Where a hand-off or a skill names one of these slugs, run that agent (subagent_type its name) instead of a kit one.`);
  if (added.length) {
    mkdirSync(dir, { recursive: true });
    for (const e of added) writeFileSync(join(dir, `${e.slug}.md`), `# ${e.name}: this scheme's additions to ${isKit(e) ? "the kit's text" : `its agent file, ${e.source!.slice(6)}`}\n\n${[e.body.trim(), said(e).length ? verdictsSection(said(e)) : ''].filter(Boolean).join('\n\n')}\n`);
    out.push(`This scheme's additions to kit reviewers and its own agents, read with their own text and passed to their Grunts: ${added.map((e) => `\`${dir}/${e.slug}.md\` (${e.name})`).join(', ')}.`);
  }
  return out.length ? `Kit reviewers: ${out.join(' ')}` : '';
}
