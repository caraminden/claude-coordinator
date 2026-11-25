// The property registry: the keys and values minions and artifacts may carry. Global keys (every
// scheme) belong to the Citadel scheme's Taskmaster; each scheme's Taskmaster registers its own.
// Minions ask the Taskmaster. Writes are checked against the registry, aliases resolve to the canonical
// value, and new keys and values are checked for near-duplicates first.
import type { DatabaseSync } from 'node:sqlite';
import { DELVE_SEED, GLOBAL_SEED, type SeedKey } from './property-seed.ts';
import { HttpError } from './http.ts';
import { inScope, scoped, warm } from './read-scope.ts';

/** The scheme whose Taskmaster owns the global keys (Citadel itself). */
export const GLOBAL_OWNER = 2;

export const VALUE_KINDS = ['enum', 'integer', 'user', 'text'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];
export type TargetType = 'minion' | 'artifact';

export type Actor =
  | { kind: 'person'; name: string }
  | { kind: 'thread'; name: string; projectId: number; ticketId: number }
  /** setupPlan: the setup or tune-up plan a person approved, while that onboarding is open (#180). */
  | { kind: 'coordinator'; name: string; projectId: number; ticketId: number; setupPlan?: string };

/** Whether a Taskmaster registers a name its approved setup plan lists: that plan was the person's review (#180). */
const inSetupPlan = (actor: Actor, name: string) => actor.kind === 'coordinator' && !!actor.setupPlan && new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'i').test(actor.setupPlan);

export class PropertyError extends HttpError {
  constructor(message: string, status = 400) {
    super(status, message);
  }
}

interface KeyRow {
  id: number;
  scope: number | null;
  key: string;
  label: string;
  description: string;
  multi: number;
  value_kind: ValueKind;
  status: 'active' | 'proposed' | 'archived';
  created_by: string;
  created_at: number;
}

interface ValueRow {
  id: number;
  key_id: number;
  value: string;
  label: string;
  description: string;
  aliases: string;
  status: 'active' | 'proposed' | 'archived';
  reviewed: number;
  created_by: string;
  created_at: number;
}

export interface ValueInput {
  value: string;
  label?: string;
  description?: string;
  aliases?: string[];
}

export const PROPERTY_SCHEMA = `
CREATE TABLE IF NOT EXISTS property_keys (
  id INTEGER PRIMARY KEY,
  scope INTEGER REFERENCES projects(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  multi INTEGER NOT NULL DEFAULT 0,
  value_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS property_key_name ON property_keys(ifnull(scope, 0), key);
CREATE TABLE IF NOT EXISTS property_values (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES property_keys(id),
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  reviewed INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (key_id, value)
);
CREATE TABLE IF NOT EXISTS properties (
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL REFERENCES property_keys(id),
  value TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, key_id, value)
);
CREATE INDEX IF NOT EXISTS properties_key ON properties(key_id, value);
CREATE TRIGGER IF NOT EXISTS minion_properties_gone AFTER DELETE ON tickets BEGIN
  DELETE FROM properties WHERE target_type = 'minion' AND target_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS artifact_properties_gone AFTER DELETE ON artifacts BEGIN
  DELETE FROM properties WHERE target_type = 'artifact' AND target_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS scheme_properties_gone BEFORE DELETE ON projects BEGIN
  DELETE FROM properties WHERE key_id IN (SELECT id FROM property_keys WHERE scope = OLD.id);
  DELETE FROM property_values WHERE key_id IN (SELECT id FROM property_keys WHERE scope = OLD.id);
  DELETE FROM property_keys WHERE scope = OLD.id;
END;
`;

const KEY_NAME = /^[a-z][a-zA-Z0-9]{1,39}$/;
const VALUE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,59}$/;

/** How a written value is compared: case, spaces and underscores don't count ("In Progress" = in-progress). */
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
/** Looser still, for near-duplicate checks: letters and digits only. */
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Whether two names are close enough that one is probably meant to be the other. */
export function nearDuplicate(a: string, b: string): boolean {
  const x = loose(a);
  const y = loose(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // Plural and singular: art/arts, class/classes, story/stories.
  if (long === `${short}s` || long === `${short}es` || (short.endsWith('y') && long === `${short.slice(0, -1)}ies`)) return true;
  // One is the start of the other: art/artwork, anim/animation.
  if (short.length >= 3 && long.startsWith(short)) return true;
  if (short.length < 4) return false;
  return editDistance(x, y) <= (short.length >= 7 ? 2 : 1);
}

const aliasesOf = (v: ValueRow): string[] => JSON.parse(v.aliases);
const code = (s: string) => `\`${s}\``;

export class Registry {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`BEGIN IMMEDIATE; ${PROPERTY_SCHEMA} COMMIT;`);
  }

  // ── Seeding ────────────────────────────────────────────────────────────

  /** Fill an empty registry from the old docs, and give existing minions a stage once. */
  seed() {
    const has = (scope: number | null) => this.db.prepare('SELECT 1 FROM property_keys WHERE scope IS ?').get(scope) !== undefined;
    this.db.exec('BEGIN');
    try {
      // A global key added to the seed later (assigned, 2026-10-28) joins a registry that lacks it, once.
      const hasGlobal = (key: string) => this.db.prepare('SELECT 1 FROM property_keys WHERE scope IS NULL AND key = ?').get(key) !== undefined;
      for (const k of GLOBAL_SEED) if (!hasGlobal(k.key)) this.insertSeed(null, k);
      const delve = this.db.prepare("SELECT id FROM projects WHERE name = 'Delve'").get() as { id: number } | undefined;
      if (delve && !has(delve.id)) for (const k of DELVE_SEED) this.insertSeed(delve.id, k);
      if (!this.db.prepare("SELECT 1 FROM settings WHERE key = 'properties_backfilled'").get()) {
        this.backfill();
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('properties_backfilled', ?)").run(JSON.stringify(Date.now()));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insertSeed(scope: number | null, k: SeedKey) {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO property_keys (scope, key, label, description, multi, value_kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(scope, k.key, k.label, k.description, k.multi ? 1 : 0, k.value_kind, 'seed', now);
    const insert = this.db.prepare('INSERT INTO property_values (key_id, value, label, description, aliases, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const v of k.values ?? []) insert.run(r.lastInsertRowid, v.value, v.label ?? '', v.description ?? '', JSON.stringify(v.aliases ?? []), 'seed', now);
  }

  /** Every minion gets a stage: dismissed ones done. */
  private backfill() {
    const tickets = this.db.prepare("SELECT id, status FROM tickets WHERE kind = 'ticket'").all() as { id: number; status: string }[];
    const stage = this.globalKey('stage');
    if (!stage) return;
    const put = this.db.prepare("INSERT OR IGNORE INTO properties (target_type, target_id, key_id, value, set_by, set_at) VALUES ('minion', ?, ?, ?, 'migration', ?)");
    const now = Date.now();
    for (const t of tickets) {
      if (!this.valuesFor('minion', t.id, stage.id).length) put.run(t.id, stage.id, t.status === 'closed' ? 'done' : 'in-progress', now);
    }
  }

  /** Every minion with no type gets `other` (#253): the list groups by type, so none is left out. */
  backfillOther() {
    const type = this.globalKey('type');
    if (!type) return;
    this.db
      .prepare(
        `INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at)
         SELECT 'minion', t.id, ?, 'other', 'migration', ? FROM tickets t WHERE t.kind = 'ticket'
           AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.target_type = 'minion' AND p.target_id = t.id AND p.key_id = ?)`,
      )
      .run(type.id, Date.now(), type.id);
  }

  // ── Reading ────────────────────────────────────────────────────────────

  private globalKey(key: string): KeyRow | undefined {
    return this.db.prepare("SELECT * FROM property_keys WHERE scope IS NULL AND key = ? AND status = 'active'").get(key) as KeyRow | undefined;
  }

  /** The keys a scheme can see: the global ones and its own. */
  private keysFor(projectId: number): KeyRow[] {
    return this.db.prepare('SELECT * FROM property_keys WHERE scope IS NULL OR scope = ? ORDER BY scope IS NOT NULL, id').all(projectId) as unknown as KeyRow[];
  }

  private valuesOf(keyId: number): ValueRow[] {
    return this.db.prepare('SELECT * FROM property_values WHERE key_id = ? ORDER BY id').all(keyId) as unknown as ValueRow[];
  }

  private valuesFor(type: TargetType, id: number, keyId: number): string[] {
    return (this.db.prepare('SELECT value FROM properties WHERE target_type = ? AND target_id = ? AND key_id = ? ORDER BY rowid').all(type, id, keyId) as { value: string }[]).map((r) => r.value);
  }

  /** Find a key the scheme can see by name, ignoring case; unknown names get a "did you mean". */
  private findKey(projectId: number, name: unknown, opts: { activeOnly?: boolean; archived?: boolean } = {}): KeyRow {
    if (typeof name !== 'string' || !name.trim()) throw new PropertyError('A property key is required');
    // Archived keys only for review, which restores them; nothing can set one.
    const keys = this.keysFor(projectId).filter((k) => opts.archived || k.status !== 'archived');
    const found = keys.find((k) => loose(k.key) === loose(name));
    if (found && (!opts.activeOnly || found.status === 'active')) return found;
    if (found) throw new PropertyError(`${code(found.key)} is proposed and not approved yet, so it can't be set`);
    const near = keys.filter((k) => k.status === 'active' && nearDuplicate(k.key, name)).map((k) => code(k.key));
    const known = keys
      .filter((k) => k.status === 'active')
      .map((k) => code(k.key))
      .join(', ');
    throw new PropertyError(`There is no property ${code(name.trim())}${near.length ? `; did you mean ${near.join(' or ')}?` : '.'} Keys: ${known}.`);
  }

  /** The registry as a scheme sees it: global keys, then the scheme's own, with their values. */
  list(projectId: number) {
    return this.keysFor(projectId).map((k) => ({
      key: k.key,
      label: k.label,
      description: k.description,
      multi: !!k.multi,
      value_kind: k.value_kind,
      status: k.status,
      scope: k.scope === null ? 'global' : 'scheme',
      created_by: k.created_by,
      values: this.valuesOf(k.id).map((v) => ({
        value: v.value,
        label: v.label,
        description: v.description,
        aliases: aliasesOf(v),
        status: v.status,
        reviewed: !!v.reviewed,
        created_by: v.created_by,
      })),
    }));
  }

  /** A minion's or artifact's properties: key → value, or a list for multi keys. */
  forTarget(type: TargetType, id: number): Record<string, string | number | string[]> {
    return { ...scoped(this.db, `props:${type}:${id}`, () => this.forTargets(type, [id]).get(id)!) };
  }

  /** Inside a read scope (src/read-scope.ts): forTarget of every one of `ids` in one read. */
  warmTargets(type: TargetType, ids: number[]) {
    if (!inScope(this.db) || !ids.length) return;
    warm(
      this.db,
      [...this.forTargets(type, ids)].map(([id, r]) => [`props:${type}:${id}`, r]),
    );
  }

  /** forTarget for many targets in one query (a minions list, #1029): each id's record, {} when it has none. */
  forTargets(type: TargetType, ids: number[]): Map<number, Record<string, string | number | string[]>> {
    const rows = this.db
      .prepare(
        `SELECT p.target_id, k.key, k.multi, k.value_kind, p.value FROM properties p JOIN property_keys k ON k.id = p.key_id
         WHERE p.target_type = ? AND p.target_id IN (SELECT value FROM json_each(?)) ORDER BY k.scope IS NOT NULL, k.id, p.rowid`,
      )
      .all(type, JSON.stringify(ids)) as { target_id: number; key: string; multi: number; value_kind: ValueKind; value: string }[];
    const all = new Map(ids.map((id) => [id, {} as Record<string, string | number | string[]>]));
    for (const r of rows) {
      const out = all.get(r.target_id)!;
      if (r.multi) ((out[r.key] ??= []) as string[]).push(r.value);
      else out[r.key] = r.value_kind === 'integer' ? Number(r.value) : r.value;
    }
    return all;
  }

  /** Every minion in `projectId` carrying global text key `key`, with its value (the effort trigger, src/effort-retros.ts). */
  minionsWith(projectId: number, key: string): { id: number; value: string }[] {
    return this.db
      .prepare(
        `SELECT p.target_id AS id, p.value FROM properties p JOIN property_keys k ON k.id = p.key_id JOIN tickets t ON t.id = p.target_id
         WHERE p.target_type = 'minion' AND k.scope IS NULL AND k.key = ? AND t.project_id = ?`,
      )
      .all(key, projectId) as { id: number; value: string }[];
  }

  // ── Setting ────────────────────────────────────────────────────────────

  /**
   * The Citadel name of the person `raw` names by their name, sign-in login or linked GitHub login, in any case; null for
   * nobody. The inbox matches assigned against the name (#582: a Taskmaster stored Josh's GitHub login and his cards vanished).
   */
  personName(raw: string): string | null {
    return scoped(this.db, `person-name:${raw.trim()}`, () => this.personNameRead(raw));
  }

  private personNameRead(raw: string): string | null {
    const row = this.db
      .prepare(`SELECT u.name FROM users u LEFT JOIN credentials c ON c.user_id = u.id AND c.kind = 'github'
      WHERE lower(u.name) = lower(?1) OR lower(u.login) = lower(?1) OR lower(json_extract(c.meta, '$.login')) = lower(?1)
      ORDER BY lower(u.name) = lower(?1) DESC, lower(u.login) = lower(?1) DESC LIMIT 1`)
      .get(raw.trim()) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /** Resolve one written value to what gets stored, or say why it can't be. */
  private resolve(k: KeyRow, raw: unknown): string {
    if (k.value_kind === 'integer') {
      const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 1_000_000) throw new PropertyError(`${code(k.key)} must be a whole number`);
      return String(n);
    }
    if (typeof raw !== 'string' || !raw.trim() || /[\r\n]/.test(raw)) throw new PropertyError(`${code(k.key)} values must be one line of text`);
    if (k.value_kind === 'user' || k.value_kind === 'text') {
      const max = k.value_kind === 'user' ? 60 : 200;
      if (raw.trim().length > max) throw new PropertyError(`${code(k.key)} must be at most ${max} characters`);
      if (k.value_kind === 'text') return raw.trim();
      const person = this.personName(raw);
      if (person) return person;
      // One person, one spelling: "josh" becomes the "Josh" already in use on any person key, this one first.
      const seen = this.db.prepare("SELECT p.value FROM properties p JOIN property_keys k ON k.id = p.key_id WHERE k.value_kind = 'user' AND lower(p.value) = lower(?) ORDER BY p.key_id = ? DESC LIMIT 1").get(raw.trim(), k.id) as { value: string } | undefined;
      return seen?.value ?? raw.trim();
    }
    const values = this.valuesOf(k.id);
    const n = norm(raw);
    const hit = values.find((v) => norm(v.value) === n) ?? values.find((v) => aliasesOf(v).some((a) => norm(a) === n));
    if (hit?.status === 'active') return hit.value;
    if (hit) throw new PropertyError(`${code(`${k.key}: ${hit.value}`)} is ${hit.status === 'proposed' ? 'proposed and not approved yet' : 'archived'}, so it can't be set`);
    const active = values.filter((v) => v.status === 'active');
    const near = active.filter((v) => [v.value, ...aliasesOf(v)].some((s) => nearDuplicate(s, raw))).map((v) => code(v.value));
    throw new PropertyError(`${code(raw.trim())} isn't one of the ${code(k.key)} values${near.length ? `; did you mean ${near.join(' or ')}?` : '.'} Values: ${active.map((v) => code(v.value)).join(', ')}.` + ' If none fits, ask the Taskmaster to add a value instead of picking a near-duplicate.');
  }

  private plan(projectId: number, input: unknown): { k: KeyRow; values: string[] }[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PropertyError('properties must be an object of key: value');
    const plan: { k: KeyRow; values: string[] }[] = [];
    for (const [name, raw] of Object.entries(input)) {
      const k = this.findKey(projectId, name, { activeOnly: true });
      if (plan.some((p) => p.k.id === k.id)) throw new PropertyError(`${code(k.key)} is given twice`);
      const list = raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
      if (!k.multi && list.length > 1) throw new PropertyError(`${code(k.key)} takes one value`);
      plan.push({ k, values: [...new Set(list.map((v) => this.resolve(k, v)))] });
    }
    return plan;
  }

  /**
   * A scheme's promoted list groups (#253), checked: each "key: value" of one of the scheme's own keys,
   * written as stored ("Area: Balance" → "area: balance"), duplicates dropped, order kept.
   */
  listGroups(projectId: number, input: unknown): string[] {
    if (!Array.isArray(input)) throw new PropertyError('list_groups must be a list of "key: value"');
    if (input.length > 12) throw new PropertyError('list_groups takes at most 12 groups');
    const out: string[] = [];
    for (const raw of input) {
      const m = typeof raw === 'string' ? raw.match(/^([^:]+):(.+)$/) : null;
      if (!m) throw new PropertyError(`${code(String(raw))} isn't "key: value"`);
      const k = this.findKey(projectId, m[1].trim(), { activeOnly: true });
      if (k.scope === null) throw new PropertyError(`${code(k.key)} is a global key: list groups use the scheme's own keys (the list already groups by type and build)`);
      const g = `${k.key}: ${this.resolve(k, m[2].trim())}`;
      if (!out.includes(g)) out.push(g);
    }
    return out;
  }

  /** Check properties without writing them: what each key would hold, by its canonical name. */
  check(projectId: number, input: unknown): Record<string, string[]> {
    return Object.fromEntries(this.plan(projectId, input).map(({ k, values }) => [k.key, values]));
  }

  /**
   * Set properties on a minion or artifact: `{ key: value | [values] | null }`. Everything is
   * checked before anything is written. Returns what was stored, plus notes for the caller.
   */
  set(type: TargetType, id: number, projectId: number, input: unknown, by: string): { properties: Record<string, unknown>; notes: string[] } {
    const plan = this.plan(projectId, input);
    const notes: string[] = [];
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const { k, values } of plan) {
        this.db.prepare('DELETE FROM properties WHERE target_type = ? AND target_id = ? AND key_id = ?').run(type, id, k.id);
        const put = this.db.prepare('INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const v of values) put.run(type, id, k.id, v, by, now);
        if (type === 'minion' && k.scope === null && k.key === 'type' && values[0] === 'other') {
          notes.push('type is `other`: ask people with an ask_question card whether it should stay `other` or move to another type (or a new one), and change it if they say so.');
        }
        // The column the minions list groups by holds the same build.
        if (type === 'minion' && k.key === 'build') this.db.prepare('UPDATE tickets SET build = ? WHERE id = ?').run(Number(values[0]) || null, id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { properties: this.forTarget(type, id), notes };
  }

  /** Mirror a write to the build column onto the scheme's `build` key, when it has one. */
  setBuild(ticketId: number, build: number | null, by: string) {
    const row = this.db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticketId) as { project_id: number } | undefined;
    const k = row && (this.db.prepare("SELECT id FROM property_keys WHERE scope = ? AND key = 'build' AND status = 'active'").get(row.project_id) as { id: number } | undefined);
    if (!k) return;
    this.db.prepare('DELETE FROM properties WHERE target_type = ? AND target_id = ? AND key_id = ?').run('minion', ticketId, k.id);
    if (build !== null) this.db.prepare('INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)').run('minion', ticketId, k.id, String(build), by, Date.now());
  }

  /** A new minion's starting stage, unless one was given: idea for ideation, otherwise in-progress. */
  startStage(ticketId: number) {
    const stage = this.globalKey('stage');
    const type = this.globalKey('type');
    if (!stage || this.valuesFor('minion', ticketId, stage.id).length) return;
    const ideation = type && this.valuesFor('minion', ticketId, type.id)[0] === 'ideation';
    this.putStage(ticketId, stage.id, ideation ? 'idea' : 'in-progress');
  }

  /** Dismissing a minion moves it to done; reopening a done minion moves it back to in-progress. One that runs again, or reopens, isn't closed as anything. */
  statusChanged(ticketId: number, before: string, after: string) {
    if (before !== after && (before === 'closed' || after === 'running')) {
      this.db.prepare("DELETE FROM properties WHERE target_type = 'minion' AND target_id = ? AND key_id = (SELECT id FROM property_keys WHERE scope IS NULL AND key = 'closedAs')").run(ticketId);
    }
    const stage = this.globalKey('stage');
    if (!stage || before === after) return;
    const current = this.valuesFor('minion', ticketId, stage.id)[0];
    if (after === 'closed') this.putStage(ticketId, stage.id, 'done');
    else if (before === 'closed' && (current === 'done' || current === undefined)) this.putStage(ticketId, stage.id, 'in-progress');
  }

  private putStage(ticketId: number, keyId: number, value: string) {
    const known = this.valuesOf(keyId).some((v) => v.value === value && v.status === 'active');
    if (!known) return;
    this.db.prepare('DELETE FROM properties WHERE target_type = ? AND target_id = ? AND key_id = ?').run('minion', ticketId, keyId);
    this.db.prepare("INSERT INTO properties (target_type, target_id, key_id, value, set_by, set_at) VALUES ('minion', ?, ?, ?, 'Citadel', ?)").run(ticketId, keyId, value, Date.now());
  }

  // ── Changing the registry ─────────────────────────────────────────────

  /** People may change anything; a Taskmaster its own scheme's keys, and Citadel's Taskmaster the global ones. */
  private mayEdit(scope: number | null, actor: Actor): boolean {
    if (actor.kind === 'person') return true;
    if (actor.kind !== 'coordinator') return false;
    return scope === null ? actor.projectId === GLOBAL_OWNER : scope === actor.projectId;
  }

  private checkValueName(v: unknown, what: string): string {
    if (typeof v !== 'string' || !VALUE_NAME.test(v.trim())) {
      throw new PropertyError(`${what} ${code(String(v))} must be letters, digits and hyphens (kebab-case, or a proper name), at most 60 characters`);
    }
    return v.trim();
  }

  /**
   * Register a key, in the scheme or (global: true) for every scheme. A person's key is live at
   * once, and so is one a Taskmaster's approved setup plan lists; any other Taskmaster key waits for a person. Near-duplicates come back as warnings and nothing is
   * registered unless `force` is set.
   */
  registerKey(projectId: number, input: Record<string, unknown>, actor: Actor) {
    const name = typeof input?.key === 'string' ? input.key.trim() : '';
    if (!KEY_NAME.test(name)) throw new PropertyError('key must be camelCase letters and digits, 2 to 40 characters, e.g. playerClass');
    const scope = input.global ? null : projectId;
    if (!this.mayEdit(scope, actor)) {
      throw new PropertyError(actor.kind === 'thread' ? 'Minions ask the Taskmaster to add keys' : scope === null ? "Only the Citadel scheme's Taskmaster or a person can add global keys" : 'Outside this scheme', 403);
    }
    const kind = (input.value_kind ?? 'enum') as ValueKind;
    if (!VALUE_KINDS.includes(kind)) throw new PropertyError(`value_kind must be one of: ${VALUE_KINDS.join(', ')}`);
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : name;
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 4000) : '';
    const values: ValueInput[] = Array.isArray(input.values) ? input.values : [];
    if (values.length && kind !== 'enum') throw new PropertyError('Only enum keys have a list of values');

    // A name is unique across the global keys plus each scheme's own.
    const all = this.db.prepare('SELECT k.*, p.name AS project FROM property_keys k LEFT JOIN projects p ON p.id = k.scope').all() as unknown as (KeyRow & { project: string | null })[];
    const where = (k: { scope: number | null; project: string | null }) => (k.scope === null ? 'a global key' : `a key in ${k.project}`);
    const clashes = all.filter((k) => loose(k.key) === loose(name) && (scope === null || k.scope === null || k.scope === scope));
    if (clashes.length) throw new PropertyError(`${code(name)} clashes with ${clashes.map((k) => `${code(k.key)} (${where(k)})`).join(', ')}`, 409);
    if (!input.force) {
      const near = all.filter((k) => k.status !== 'archived' && (scope === null || k.scope === null || k.scope === scope) && nearDuplicate(k.key, name));
      if (near.length) {
        return { registered: false, warnings: near.map((k) => `${code(name)} is close to ${code(k.key)} (${where(k)}). Use ${code(k.key)}, or register again with force: true if it really is different.`) };
      }
    }
    this.checkValues(values, []);
    const status = actor.kind === 'person' || inSetupPlan(actor, name) ? 'active' : 'proposed';
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const r = this.db.prepare('INSERT INTO property_keys (scope, key, label, description, multi, value_kind, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(scope, name, label, description || (input.reason as string | undefined) || '', input.multi ? 1 : 0, kind, status, actor.name, now);
      for (const v of values) this.insertValue(Number(r.lastInsertRowid), v, 'active', actor);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { registered: true, status, scope: scope === null ? 'global' : 'scheme', warnings: [] as string[] };
  }

  /** Check a batch of new values and aliases against each other and the key's existing ones. */
  private checkValues(values: ValueInput[], existing: ValueRow[]) {
    const taken = new Map<string, string>(); // normalised name → the value it belongs to
    for (const v of existing) for (const s of [v.value, ...aliasesOf(v)]) taken.set(norm(s), v.value);
    for (const v of values) {
      const value = this.checkValueName(v?.value, 'Value');
      const own = existing.find((e) => norm(e.value) === norm(value));
      const owner = taken.get(norm(value));
      if (owner && !own) throw new PropertyError(`${code(value)} is already an alias of ${code(owner)}`, 409);
      taken.set(norm(value), own?.value ?? value);
      if (v.aliases !== undefined && !Array.isArray(v.aliases)) throw new PropertyError(`aliases of ${code(value)} must be a list`);
      for (const a of v.aliases ?? []) {
        const alias = this.checkValueName(a, 'Alias');
        const at = taken.get(norm(alias));
        if (at && at !== (own?.value ?? value)) throw new PropertyError(`Alias ${code(alias)} already means ${code(at)}`, 409);
        taken.set(norm(alias), own?.value ?? value);
      }
    }
  }

  private insertValue(keyId: number, v: ValueInput, status: string, actor: Actor) {
    const aliases = [...new Set((v.aliases ?? []).map((a) => a.trim()))];
    this.db
      .prepare('INSERT INTO property_values (key_id, value, label, description, aliases, status, reviewed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(keyId, v.value.trim(), (v.label ?? '').trim().slice(0, 60), (v.description ?? '').trim().slice(0, 1000), JSON.stringify(aliases), status, actor.kind === 'person' || inSetupPlan(actor, v.value.trim()) ? 1 : 0, actor.name, Date.now());
  }

  /**
   * Add values to an enum key, or aliases and labels to values it has. A Taskmaster's new values
   * are live at once but marked unreviewed until a person approves them, unless its approved setup plan lists them.
   */
  registerValues(projectId: number, keyName: unknown, values: unknown, actor: Actor, force = false) {
    const k = this.findKey(projectId, keyName);
    if (!this.mayEdit(k.scope, actor)) {
      throw new PropertyError(actor.kind === 'thread' ? 'Minions ask the Taskmaster to add values' : `Only the Citadel scheme's Taskmaster or a person can change ${code(k.key)}`, 403);
    }
    if (k.value_kind !== 'enum') throw new PropertyError(`${code(k.key)} takes any ${k.value_kind === 'integer' ? 'whole number' : k.value_kind}; it has no list of values`);
    if (!Array.isArray(values) || !values.length) throw new PropertyError('values must be a non-empty list of { value, label?, aliases? }');
    const existing = this.valuesOf(k.id);
    this.checkValues(values as ValueInput[], existing);
    const fresh = (values as ValueInput[]).filter((v) => !existing.some((e) => norm(e.value) === norm(v.value)));
    if (!force) {
      const warnings = fresh.flatMap((v) =>
        existing
          .filter((e) => e.status !== 'archived' && [e.value, ...aliasesOf(e)].some((s) => nearDuplicate(s, v.value)))
          .map((e) => `${code(v.value)} is close to ${code(`${k.key}: ${e.value}`)}. Use ${code(e.value)}, add ${code(v.value)} to its aliases, or register again with force: true if it really is different.`),
      );
      if (warnings.length) return { added: [] as string[], updated: [] as string[], unreviewed: [] as string[], warnings };
    }
    const added: string[] = [];
    const updated: string[] = [];
    this.db.exec('BEGIN');
    try {
      for (const v of values as ValueInput[]) {
        const own = existing.find((e) => norm(e.value) === norm(v.value));
        if (!own) {
          this.insertValue(k.id, v, 'active', actor);
          added.push(v.value.trim());
          continue;
        }
        const aliases = [...new Set([...aliasesOf(own), ...(v.aliases ?? []).map((a) => a.trim())])];
        this.db.prepare("UPDATE property_values SET aliases = ?, label = ?, description = ?, status = CASE status WHEN 'archived' THEN 'active' ELSE status END WHERE id = ?").run(JSON.stringify(aliases), v.label?.trim().slice(0, 60) ?? own.label, v.description?.trim().slice(0, 1000) ?? own.description, own.id);
        updated.push(own.value);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { added, updated, unreviewed: actor.kind === 'person' ? [] : added.filter((v) => !inSetupPlan(actor, v)), warnings: [] as string[] };
  }

  /**
   * Settle a key or value: approve a proposal (or, for people, an unreviewed value), reject a
   * proposal, archive or restore, or merge a value into another (it becomes an alias, and what
   * carried it moves over).
   */
  review(projectId: number, input: Record<string, unknown>, actor: Actor) {
    const action = input?.action as string;
    if (!['approve', 'reject', 'archive', 'restore', 'merge'].includes(action)) throw new PropertyError('action must be approve, reject, archive, restore or merge');
    const k = this.findKey(projectId, input.key, { archived: true });
    if (!this.mayEdit(k.scope, actor)) throw new PropertyError(`Only ${k.scope === null ? "the Citadel scheme's Taskmaster" : "this scheme's Taskmaster"} or a person can change ${code(k.key)}`, 403);
    if (input.value === undefined || input.value === null) {
      // Keys: only people approve, reject or archive them.
      if (actor.kind !== 'person') throw new PropertyError('New and archived keys need a person; ask Cara or Josh', 403);
      if (action === 'approve' && k.status === 'proposed') {
        // One click settles the key and everything listed under it (#180); single values can be archived or merged after.
        this.db.exec('BEGIN');
        try {
          this.db.prepare("UPDATE property_keys SET status = 'active' WHERE id = ?").run(k.id);
          this.db.prepare("UPDATE property_values SET status = 'active', reviewed = 1 WHERE key_id = ? AND status != 'archived'").run(k.id);
          this.db.exec('COMMIT');
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      } else if (action === 'reject' && k.status === 'proposed') {
        this.db.prepare('DELETE FROM property_values WHERE key_id = ?').run(k.id);
        this.db.prepare('DELETE FROM property_keys WHERE id = ?').run(k.id);
      } else if (action === 'archive' && k.status === 'active') this.db.prepare("UPDATE property_keys SET status = 'archived' WHERE id = ?").run(k.id);
      else if (action === 'restore' && k.status === 'archived') this.db.prepare("UPDATE property_keys SET status = 'active' WHERE id = ?").run(k.id);
      else throw new PropertyError(`Can't ${action} ${code(k.key)}: it is ${k.status}`, 409);
      return { key: k.key, action };
    }
    const values = this.valuesOf(k.id);
    const v = values.find((e) => e.value === input.value) ?? values.find((e) => norm(e.value) === norm(String(input.value)));
    if (!v) throw new PropertyError(`${code(k.key)} has no value ${code(String(input.value))}`, 404);
    const set = (sql: string, ...args: (string | number)[]) => this.db.prepare(`UPDATE property_values SET ${sql} WHERE id = ?`).run(...args, v.id);
    if (action === 'approve') {
      if (v.status === 'proposed') set("status = 'active', reviewed = ?", actor.kind === 'person' ? 1 : 0);
      else if (v.status === 'active' && !v.reviewed && actor.kind === 'person') set('reviewed = 1');
      else throw new PropertyError(`${code(v.value)} is ${v.status}${v.reviewed ? '' : ' and waits for a person to review it'}`, 409);
    } else if (action === 'reject') {
      if (v.status !== 'proposed') throw new PropertyError(`Only proposed values can be rejected; archive ${code(v.value)} instead`, 409);
      this.db.prepare('DELETE FROM property_values WHERE id = ?').run(v.id);
    } else if (action === 'archive') {
      if (v.status !== 'active') throw new PropertyError(`${code(v.value)} is ${v.status}`, 409);
      set("status = 'archived'");
    } else if (action === 'restore') {
      if (v.status !== 'archived') throw new PropertyError(`${code(v.value)} is ${v.status}`, 409);
      set("status = 'active'");
    } else {
      const into = values.find((e) => e.value === input.into && e.status === 'active');
      if (!into || into.id === v.id) throw new PropertyError(`merge needs into: another active ${code(k.key)} value`);
      this.db.exec('BEGIN');
      try {
        this.db.prepare('INSERT OR IGNORE INTO properties (target_type, target_id, key_id, value, set_by, set_at) SELECT target_type, target_id, key_id, ?, set_by, set_at FROM properties WHERE key_id = ? AND value = ?').run(into.value, k.id, v.value);
        this.db.prepare('DELETE FROM properties WHERE key_id = ? AND value = ?').run(k.id, v.value);
        const aliases = [...new Set([...aliasesOf(into), v.value, ...aliasesOf(v)])];
        this.db.prepare('UPDATE property_values SET aliases = ? WHERE id = ?').run(JSON.stringify(aliases), into.id);
        this.db.prepare('DELETE FROM property_values WHERE id = ?').run(v.id);
        // The scheme's promoted list group (#253) follows the value it named.
        const scheme = k.scope === null ? null : (this.db.prepare('SELECT list_groups FROM projects WHERE id = ?').get(k.scope) as { list_groups: string } | undefined);
        if (scheme) {
          const groups: string[] = JSON.parse(scheme.list_groups);
          const moved = [...new Set(groups.map((g) => (g === `${k.key}: ${v.value}` ? `${k.key}: ${into.value}` : g)))];
          if (moved.join('\n') !== groups.join('\n')) this.db.prepare('UPDATE projects SET list_groups = ? WHERE id = ?').run(JSON.stringify(moved), k.scope);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return { key: k.key, value: v.value, action };
  }

  /** Whether a key is global (its changes touch every scheme's doc). */
  isGlobal(projectId: number, keyName: unknown): boolean {
    try {
      return this.findKey(projectId, keyName).scope === null;
    } catch {
      return false;
    }
  }

  // ── The generated doc ──────────────────────────────────────────────────

  /** A scheme's property-vocabulary.md, rendered from the registry. */
  doc(projectId: number, schemeName: string): string {
    const keys = this.list(projectId);
    const section = (k: (typeof keys)[number]) => {
      const kind = k.value_kind === 'enum' ? (k.multi ? 'one or more values' : 'one value') : k.value_kind === 'integer' ? 'a whole number' : k.value_kind === 'user' ? "a person's login name" : 'free text';
      const lines = [`### \`${k.key}\`: ${k.label}${k.status === 'proposed' ? ' (proposed, not approved yet)' : ''}`, '', `Takes ${kind}.`, ''];
      if (k.description) lines.push(k.description, '');
      const shown = k.values.filter((v) => v.status !== 'archived');
      if (shown.length) {
        lines.push('| Value | Aliases | Notes |', '|---|---|---|');
        for (const v of shown) {
          const flags = [v.status === 'proposed' ? '**proposed**' : '', v.status === 'active' && !v.reviewed ? '**new, not reviewed yet**' : '', v.description].filter(Boolean).join(' · ');
          lines.push(`| \`${v.value}\` | ${v.aliases.map(code).join(', ')} | ${flags.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
        }
        lines.push('');
      }
      const archived = k.values.filter((v) => v.status === 'archived');
      if (archived.length) lines.push(`Archived (no longer used for new work): ${archived.map((v) => code(v.value)).join(', ')}.`, '');
      return lines.join('\n');
    };
    const live = (k: (typeof keys)[number]) => k.status !== 'archived';
    const global = keys.filter((k) => k.scope === 'global' && live(k));
    const own = keys.filter((k) => k.scope === 'scheme' && live(k));
    return [
      '---',
      'title: Property vocabulary',
      'generated: true',
      '---',
      '',
      `# Property vocabulary: ${schemeName}`,
      '',
      "> Generated by Citadel from its property registry. **Don't edit this file**: it is rewritten whenever the registry changes. Read the registry with the `list_properties` tool; Taskmasters change it with `register_property_values` and `register_property_key`, and minions suggest changes with `propose_property`.",
      '',
      'Rules:',
      '- Only use the keys and values listed here. Aliases resolve to their value when set, and are never stored.',
      '- Keys are camelCase. Values are lowercase kebab-case, except proper names, which keep their capitals.',
      '- The same word can be a value of different keys (`type: research`, `area: research`), so always show a property as `key: value`.',
      '- Every minion has a `type`. When nothing fits, use `other` and ask people whether it should stay `other` or go in another bucket.',
      '',
      '## All schemes',
      '',
      ...global.map(section),
      `## ${schemeName}`,
      '',
      ...(own.length ? own.map(section) : ['No scheme keys yet.', '']),
    ].join('\n');
  }
}
