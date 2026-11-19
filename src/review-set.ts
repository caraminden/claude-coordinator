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
  -- block or advise once phase 3 wires it; NULL: the rubric's own gate key decides, as today.
  gate TEXT,
  -- Where it came from: "docs/rubrics/ui.md" for an imported file, "kit:<agent or skill>" for a kit built-in (BUILT_INS), NULL for one made on the page.
  source TEXT,
  -- It gives the risk label that decides whether a ship waits for a go (Q10): the pre-ship review's stand-in when that is off.
  gives_label INTEGER NOT NULL DEFAULT 0,
  -- Its last calibration as JSON (Q12): {at, by, model, hits, notes, false_alarms, controls}, or {at, by, good: true} when a person marked it good.
  calibration TEXT,
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
`;

export const KINDS = ['critic', 'reviewer', 'checker', 'referee', 'teacher', 'audit'] as const;
export const STAGES = ['work', 'ship', 'ask', 'schedule'] as const;
const MODELS = ['opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high'];
/** The kit's rubric starters; example.md is the format's worked example, not a starter. */
export const STARTER_DIR = join(import.meta.dirname, '..', 'kit', 'skills', 'critique', 'rubrics');

export interface Triggers { diff?: string[]; creative?: string; schedule?: string; in_app?: string; types?: string[]; ask?: boolean }
export interface Context { guides?: { label: string; href: string }[]; paths?: string[]; verdicts?: boolean; requester?: boolean }

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
  version: number;
  updated_by: string;
  updated_at: number;
}

/** The fields a save may set: everything but the row's identity and bookkeeping. */
export type EntryFields = Pick<ReviewEntry, 'slug' | 'name' | 'kind' | 'extends' | 'body' | 'triggers' | 'context' | 'enabled' | 'trial' | 'model' | 'effort' | 'stage' | 'position' | 'gate' | 'source' | 'gives_label' | 'calibration'>;
const FIELDS = ['slug', 'name', 'kind', 'extends', 'body', 'triggers', 'context', 'enabled', 'trial', 'model', 'effort', 'stage', 'position', 'gate', 'source', 'gives_label', 'calibration'] as const;

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
];
export const isKit = (e: Pick<ReviewEntry, 'source'>) => !!e.source?.startsWith('kit:');
/** A kit entry's fields that are the kit's, not the scheme's: a save may change only its switch and its additions (body). */
const KIT_FIXED = ['slug', 'name', 'kind', 'extends', 'triggers', 'stage', 'source', 'trial', 'gate', 'gives_label', 'calibration'] as const;

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
const LIFTED = ['name', 'extends', 'when', 'model', 'effort'];
const OWNED = /^(name|extends|when|model|effort|trial)\s*:/;

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
export function renderEntry(e: Pick<ReviewEntry, 'slug' | 'extends' | 'triggers' | 'model' | 'effort' | 'body' | 'context' | 'trial'> & Partial<Pick<ReviewEntry, 'gate' | 'calibration'>>): string {
  const cal = e.calibration ? calibratedText(e.calibration) : '';
  // The columns' keys win over the body's own: the gate when the page set one, the calibration once one is recorded.
  const owned = (l: string) => OWNED.test(l) || (!!e.gate && /^gate\s*:/.test(l)) || (!!cal && /^calibrated\s*:/.test(l));
  const own = e.body.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = [
    `name: ${e.slug}`,
    e.extends ? `extends: citadel:critique/rubrics/${e.extends}` : '',
    `when: ${quote(whenText(e.triggers) || 'ask')}`,
    e.model ? `model: ${e.model}` : '',
    e.effort ? `effort: ${e.effort}` : '',
    // On trial (Q12) it only advises, whatever its own gate says.
    e.trial ? 'trial: true' : '',
    e.gate ? `gate: ${e.gate === 'block' ? 'blocks-ready' : 'advisory'}` : '',
    cal ? `calibrated: ${JSON.stringify(cal)}` : '',
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
  return `---\n${head.join('\n')}\n---\n\n${sections}${ctx.length ? `${sections ? '\n\n' : ''}## Context\n\n${ctx.join('\n')}` : ''}\n`;
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
const fromRow = (r: Row): ReviewEntry => ({ ...r, triggers: JSON.parse(r.triggers), context: JSON.parse(r.context), enabled: !!r.enabled, trial: !!r.trial, gives_label: !!r.gives_label, calibration: r.calibration ? JSON.parse(r.calibration) : null }) as ReviewEntry;
const snapshotOf = (e: EntryFields): EntryFields => Object.fromEntries(FIELDS.map((k) => [k, e[k]])) as EntryFields;

/** On trial an entry only advises (Q12): it can't block a ship or give the risk label until it is calibrated or marked good. */
function onlyCalibratedJudge(e: EntryFields): void {
  if (e.trial && e.gate === 'block') throw new ReviewError(`${e.name} is on trial, so it only advises: calibrate it or mark it good before it can block`);
  if (e.trial && e.gives_label) throw new ReviewError(`${e.name} is on trial, so it can't give the risk label: calibrate it or mark it good first`);
}

/** Refuse a field a save can't hold, so a bad request changes nothing. */
function check(f: Partial<EntryFields>): void {
  if (f.slug !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug)) throw new ReviewError('The name in files (slug) is kebab-case: lowercase letters, digits and dashes, like ui-screenshots');
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
  const t = f.triggers as Record<string, unknown> | undefined;
  if (t && (!strings(t.diff) || !strings(t.types) || !text(t.creative) || !text(t.schedule) || !text(t.in_app) || !flag(t.ask))) throw new ReviewError('triggers is {diff: [globs], types: [minion types], creative, schedule, in_app: text, ask: true or false}');
}

export class ReviewSet {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // One transaction: every autocommitted statement is an fsync, and a new database's setup is held to a few commits (test/db-setup).
    db.exec(`BEGIN;${REVIEW_SCHEMA}COMMIT;`);
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
    };
    onlyCalibratedJudge(row);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO review_entries (project_id, slug, name, kind, extends, body, triggers, context, enabled, trial, model, effort, stage, position, gate, source, gives_label, calibration, version, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        projectId, row.slug, row.name, row.kind, row.extends, row.body, JSON.stringify(row.triggers), JSON.stringify(row.context),
        row.enabled ? 1 : 0, row.trial ? 1 : 0, row.model, row.effort, row.stage, row.position, row.gate, row.source, row.gives_label ? 1 : 0, row.calibration ? JSON.stringify(row.calibration) : null, by, at);
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
    if (JSON.stringify(next) === JSON.stringify(snapshotOf(was))) return was;
    if (isKit(was)) {
      const changed = KIT_FIXED.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(was[k]));
      if (changed.length) throw new ReviewError(`${was.name} is the kit's: a scheme switches it on or off and adds to its text, but can't change its ${changed.join(', ')}`);
    }
    onlyCalibratedJudge(next);
    const version = was.version + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE review_entries SET slug = ?, name = ?, kind = ?, extends = ?, body = ?, triggers = ?, context = ?, enabled = ?, trial = ?, model = ?, effort = ?,
        stage = ?, position = ?, gate = ?, source = ?, gives_label = ?, calibration = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(
        next.slug, next.name, next.kind, next.extends, next.body, JSON.stringify(next.triggers), JSON.stringify(next.context), next.enabled ? 1 : 0, next.trial ? 1 : 0,
        next.model, next.effort, next.stage, next.position, next.gate, next.source, next.gives_label ? 1 : 0, next.calibration ? JSON.stringify(next.calibration) : null, version, by, at, was.id);
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
    const passes = r.hits * 2 > r.notes && r.false_alarms === 0;
    const calibration: Calibration = { at, by, model: r.model ?? undefined, hits: r.hits, notes: r.notes, false_alarms: r.false_alarms, controls: r.controls };
    const trial = was.trial && !passes;
    return this.save(projectId, slug, { calibration, trial }, by, `Calibrated: ${r.hits}/${r.notes} hits, ${r.false_alarms}/${r.controls} false alarms${was.trial ? (passes ? ', off trial' : ', stays on trial') : ''}`, undefined, at);
  }

  private nextPosition(projectId: number): number {
    return ((this.db.prepare('SELECT max(position) AS p FROM review_entries WHERE project_id = ?').get(projectId) as { p: number | null }).p ?? -1) + 1;
  }
}

/**
 * Write the scheme's enabled entries into `dir` as `<slug>.md` rubric files, replacing what was there, for a turn's
 * critics to read. Returns how many it wrote.
 */
export function renderSet(entries: ReviewEntry[], dir: string): number {
  rmSync(dir, { recursive: true, force: true });
  // The kit's built-ins aren't rubrics: kitLine tells the turn which are off and where the scheme's additions are.
  const on = entries.filter((e) => e.enabled && !isKit(e));
  if (!on.length) return 0;
  mkdirSync(dir, { recursive: true });
  for (const e of on) writeFileSync(join(dir, `${e.slug}.md`), renderEntry(e));
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
export function reviewSetLine(dir: string, on: number): string {
  return on
    ? `Review set: this scheme's reviewers and critics are on its Reviewers and critics page, and the ${on} that are on are rendered for this turn as rubric files in \`${dir}/\`: that folder is the scheme's rubric set wherever a skill says rubrics (citadel:critique). Read them there; change one only with the \`review_set\` tool, never by editing those files or adding rubric files to the repo.`
    : "Review set: this scheme has no reviewers or critics on (its Reviewers and critics page), so no rubric's `when:` matches; a person adds one there, or a Taskmaster with `review_set`.";
}

/**
 * The turn's line on the kit's built-ins (Q10): which ones this scheme switched off, what that means for the ship, and
 * the scheme's additions to the ones still on, written into `dir` as `<slug>.md`. Empty when all are on as the kit has them.
 */
export function kitLine(entries: ReviewEntry[], dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  const kit = entries.filter(isKit);
  const off = kit.filter((e) => !e.enabled);
  const added = kit.filter((e) => e.enabled && e.body.trim());
  const out: string[] = [];
  if (off.some((e) => e.slug === 'pre-ship-review')) {
    const giver = entries.find((e) => e.enabled && !e.trial && e.gives_label);
    out.push(giver
      ? `This scheme's pre-ship review is off, and its ${giver.name} (\`${giver.slug}\` in the review set) gives the risk label instead: run it where citadel:self-review would run its reviewer, and label the change from its verdict.`
      : "This scheme's pre-ship review is off: don't run citadel:self-review's reviewer and give no risk label. Every ship waits for a person's go, whatever the scheme's shipping instructions say: ask with a ship card, then call hand_off_land with no risk and the go.");
  }
  const rest = off.filter((e) => e.slug !== 'pre-ship-review');
  if (rest.length) out.push(`Kit reviewers this scheme switched off: ${rest.map((e) => e.name).join(', ')}. Skip each where a skill would run it: an off lens stays out of the reviewer's brief, an off finding checker is skipped on deep reviews, and an off fresh eyes means no citadel:fresh-eyes Grunt.`);
  if (added.length) {
    mkdirSync(dir, { recursive: true });
    for (const e of added) writeFileSync(join(dir, `${e.slug}.md`), `# ${e.name}: this scheme's additions to the kit's text\n\n${e.body.trim()}\n`);
    out.push(`This scheme's additions to kit reviewers, read with the kit's own text and passed to their Grunts: ${added.map((e) => `\`${dir}/${e.slug}.md\` (${e.name})`).join(', ')}.`);
  }
  return out.length ? `Kit reviewers: ${out.join(' ')}` : '';
}
