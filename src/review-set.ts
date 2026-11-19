// A scheme's review set (Build 4, docs/adr/0014-review-set.md): every critic, reviewer and audit that judges its work,
// stored here rather than as repo files (Cara, 2026-11-19, Q2: "Citadel stores them"). Each entry is the rubric format
// (kit/skills/critique/references/rubric-format.md): the keys the page switches on are columns, the rest of the
// rubric (its other frontmatter keys and its sections) is the body. Every save is a version; History restores one.
// Turns read the enabled entries as rendered rubric files (renderSet), so critics read them the way they read repo files.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  -- Where it came from: "docs/rubrics/ui.md" for an imported file, NULL for one made on the page.
  source TEXT,
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
  version: number;
  updated_by: string;
  updated_at: number;
}

/** The fields a save may set: everything but the row's identity and bookkeeping. */
export type EntryFields = Pick<ReviewEntry, 'slug' | 'name' | 'kind' | 'extends' | 'body' | 'triggers' | 'context' | 'enabled' | 'trial' | 'model' | 'effort' | 'stage' | 'position' | 'gate' | 'source'>;
const FIELDS = ['slug', 'name', 'kind', 'extends', 'body', 'triggers', 'context', 'enabled', 'trial', 'model', 'effort', 'stage', 'position', 'gate', 'source'] as const;

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
export function renderEntry(e: Pick<ReviewEntry, 'slug' | 'extends' | 'triggers' | 'model' | 'effort' | 'body' | 'context' | 'trial'>): string {
  const own = e.body.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = [
    `name: ${e.slug}`,
    e.extends ? `extends: citadel:critique/rubrics/${e.extends}` : '',
    `when: ${quote(whenText(e.triggers) || 'ask')}`,
    e.model ? `model: ${e.model}` : '',
    e.effort ? `effort: ${e.effort}` : '',
    // On trial (Q12) it only advises, whatever its own gate says.
    e.trial ? 'trial: true' : '',
    own ? own[1].trim() : '',
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

/** The kit's starters, for New and for the page's "on top of the kit starter" link: slug, what it judges, and its text. */
export function loadStarters(dir = STARTER_DIR): { slug: string; judges: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'example.md').sort().map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    return { slug: f.slice(0, -3), judges: unquote(text.match(/^judges:\s*(.*)$/m)?.[1] ?? ''), text };
  });
}

type Row = Record<string, any>;
const fromRow = (r: Row): ReviewEntry => ({ ...r, triggers: JSON.parse(r.triggers), context: JSON.parse(r.context), enabled: !!r.enabled, trial: !!r.trial }) as ReviewEntry;
const snapshotOf = (e: EntryFields): EntryFields => Object.fromEntries(FIELDS.map((k) => [k, e[k]])) as EntryFields;

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
  for (const g of f.context?.guides ?? []) if (typeof g?.label !== 'string' || typeof g?.href !== 'string') throw new ReviewError('Each guide has a label and an href');
}

export class ReviewSet {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(REVIEW_SCHEMA);
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
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO review_entries (project_id, slug, name, kind, extends, body, triggers, context, enabled, trial, model, effort, stage, position, gate, source, version, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        projectId, row.slug, row.name, row.kind, row.extends, row.body, JSON.stringify(row.triggers), JSON.stringify(row.context),
        row.enabled ? 1 : 0, row.trial ? 1 : 0, row.model, row.effort, row.stage, row.position, row.gate, row.source, by, at);
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
    const version = was.version + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE review_entries SET slug = ?, name = ?, kind = ?, extends = ?, body = ?, triggers = ?, context = ?, enabled = ?, trial = ?, model = ?, effort = ?,
        stage = ?, position = ?, gate = ?, source = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(
        next.slug, next.name, next.kind, next.extends, next.body, JSON.stringify(next.triggers), JSON.stringify(next.context), next.enabled ? 1 : 0, next.trial ? 1 : 0,
        next.model, next.effort, next.stage, next.position, next.gate, next.source, version, by, at, was.id);
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
  const on = entries.filter((e) => e.enabled);
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
    if (!abs.startsWith(repoDir) || !existsSync(abs)) continue;
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
export function importRubrics(set: ReviewSet, projectId: number, files: [string, string][], by: string): { added: string[]; skipped: string[] } {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const [path, text] of files) {
    const { fields, body } = splitRubric(text);
    const slug = fields.slug ?? path.split('/').pop()!.replace(/\.md$/, '');
    if (set.get(projectId, slug)) {
      skipped.push(`${path} (already in the set as ${slug})`);
      continue;
    }
    try {
      set.create(projectId, { ...fields, slug, name: nameFor(slug), body, source: path }, by, `Imported from ${path}`);
      added.push(path);
    } catch (err: any) {
      skipped.push(`${path} (${err.message})`);
    }
  }
  return { added, skipped };
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
  for (const p of store.listProjects()) {
    if (!p.repo_dir) continue;
    const { added, skipped } = importRubrics(store.reviews, p.id, repoRubrics(p.repo_dir), 'Citadel');
    if (added.length || skipped.length) done.push(`${p.name}: ${added.length ? `imported ${added.join(', ')}` : 'nothing new'}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);
  }
  store.setSetting(IMPORT_KEY, now);
  return done;
}
