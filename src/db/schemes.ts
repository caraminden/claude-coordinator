// Schemes: their rows, settings and order, and the layers of instructions (app, scheme, personal) (#1313: src/db.ts by area).
import { type AppInstructions, type PersonalLayer, type Project, type Ticket, onboardingOpen } from '../db-rows.ts';
import { scheduleFirstWeek } from '../first-week.ts';
import { copyRow, scoped } from '../read-scope.ts';
import { thrown } from '../thrown.ts';
import type { Store } from '../db.ts';

const APP_INSTRUCTIONS = 'app_instructions';

export const schemeQueries = {
  listProjects(this: Store): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as Project[];
  },

  getProject(this: Store, id: number): Project | undefined {
    const p = scoped(this.db, `project:${id}`, () => this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined);
    return copyRow(p);
  },

  createProject(this: Store, name: string, repoUrl: string | null, ownerId: number | null = null): Project {
    const r = this.db.prepare('INSERT INTO projects (name, repo_url, owner_id, created_at) VALUES (?, ?, ?, ?)').run(name, repoUrl, ownerId, Date.now());
    if (ownerId !== null) this.lendCiToJoined(Number(r.lastInsertRowid), ownerId);
    return this.getProject(Number(r.lastInsertRowid))!;
  },

  setProjectRepoDir(this: Store, id: number, dir: string) {
    this.db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(dir, id);
  },

  /** Where a scheme's repo lives upstream, and why putting it on GitHub failed (null once it worked). */
  setProjectUpstream(this: Store, id: number, repoUrl: string | null, githubError: string | null) {
    this.db.prepare('UPDATE projects SET repo_url = ?, github_error = ? WHERE id = ?').run(repoUrl, githubError, id);
  },

  /** Saves a scheme's instructions, with a history row of who changed them from what. */
  setProjectInstructions(this: Store, id: number, instructions: string, by: string) {
    const at = Date.now();
    this.db.exec('BEGIN');
    try {
      const old = (this.db.prepare('SELECT instructions FROM projects WHERE id = ?').get(id) as { instructions: string } | undefined)?.instructions ?? '';
      this.db.prepare('UPDATE projects SET instructions = ?, instructions_updated_by = ?, instructions_updated_at = ? WHERE id = ?').run(instructions, by, at, id);
      this.db.prepare('INSERT INTO instruction_history (project_id, by, at, old_text, new_text) VALUES (?, ?, ?, ?, ?)').run(id, by, at, old, instructions);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** A scheme's latest instruction saves, newest first. */
  instructionHistory(this: Store, projectId: number, limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT by, at, old_text, new_text FROM instruction_history WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as { by: string; at: number; old_text: string; new_text: string }[];
  },

  /** The Citadel-wide instructions every minion and Taskmaster in every scheme gets; '' when unset. */
  appInstructions(this: Store): AppInstructions {
    return this.getSetting<AppInstructions>(APP_INSTRUCTIONS) ?? { text: '', by: null, at: null };
  },

  /** Saves the Citadel-wide instructions, with a history row of who changed them from what. */
  setAppInstructions(this: Store, text: string, by: string) {
    const at = Date.now();
    this.db.exec('BEGIN');
    try {
      const old = this.appInstructions().text;
      this.setSetting(APP_INSTRUCTIONS, { text, by, at });
      this.db.prepare('INSERT INTO app_instruction_history (by, at, old_text, new_text) VALUES (?, ?, ?, ?)').run(by, at, old, text);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** A person's own instructions for everywhere (projectId null) or one scheme, with when they last changed; '' when unset. */
  personalInstructions(this: Store, userId: number, projectId: number | null): { text: string; at: number | null } {
    const r = this.db.prepare('SELECT new_text, at FROM personal_instructions WHERE user_id = ? AND project_id IS ? ORDER BY id DESC LIMIT 1').get(userId, projectId) as { new_text: string; at: number } | undefined;
    return { text: r?.new_text ?? '', at: r?.at ?? null };
  },

  /** Saves a person's own instructions for one scope; the row is its history entry too. */
  setPersonalInstructions(this: Store, userId: number, projectId: number | null, text: string) {
    const old = this.personalInstructions(userId, projectId).text;
    if (old === text) return;
    this.db.prepare('INSERT INTO personal_instructions (user_id, project_id, at, old_text, new_text) VALUES (?, ?, ?, ?, ?)').run(userId, projectId, Date.now(), old, text);
  },

  /** The personal layer of a minion's prompt (#688): its owner's (`assigned`) texts; null for the Taskmaster, nobody or no text. */
  personalLayer(this: Store, ticket: Pick<Ticket, 'id' | 'kind' | 'project_id'>): PersonalLayer | null {
    if (ticket.kind === 'coordinator') return null;
    const assigned = String(this.props.forTarget('minion', ticket.id).assigned ?? '').trim();
    const name = assigned && this.props.personName(assigned);
    const user = name ? this.findUser('name', name) : undefined;
    if (!user) return null;
    const layer = { name: user.name, everywhere: this.personalInstructions(user.id, null).text, scheme: this.personalInstructions(user.id, ticket.project_id).text };
    return layer.everywhere || layer.scheme ? layer : null;
  },

  /** A person's latest saves for one scope, newest first. */
  personalInstructionHistory(this: Store, userId: number, projectId: number | null, limit: number): { at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT at, old_text, new_text FROM personal_instructions WHERE user_id = ? AND project_id IS ? ORDER BY id DESC LIMIT ?').all(userId, projectId, limit) as { at: number; old_text: string; new_text: string }[];
  },

  /** The latest Citadel-wide instruction saves, newest first. */
  appInstructionHistory(this: Store, limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT by, at, old_text, new_text FROM app_instruction_history ORDER BY id DESC LIMIT ?').all(limit) as { by: string; at: number; old_text: string; new_text: string }[];
  },

  setProjectSettings(
    this: Store,
    id: number,
    fields: Partial<
      Pick<
        Project,
        | 'approval_rules'
        | 'plugin_dirs'
        | 'optional_plugin_dirs'
        | 'default_effort'
        | 'onboarding'
        | 'onboarding_mode'
        | 'list_groups'
        | 'ci_quiet'
        | 'ci_watch'
        | 'land_mode'
        | 'fable_ok'
        | 'builds'
        | 'grill'
        | 'gh_runners'
        | 'shot_widths'
        | 'shot_themes'
        | 'shots_required'
        | 'shot_note'
        | 'ship_path'
        | 'go_from'
        | 'try_first'
        | 'msg_loop_limit'
        | 'msg_loop_min'
        | 'msg_cold_min'
        | 'msg_hold_h'
        | 'msg_never_hold'
        | 'rules_review'
        | 'skills_off'
      >
    >,
  ) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    // A setup round starts at interview, or when a closed one opens again: only plans approved after it count (#180).
    const was = this.getProject(id);
    if (fields.onboarding && onboardingOpen(fields as Pick<Project, 'onboarding'>) && (fields.onboarding === 'interview' || (was && !onboardingOpen(was)))) {
      this.setSetting(`onboarding_opened:${id}`, Date.now());
    }
    // Setup finishing opens the pass on Minion rules, whoever or whatever set it (#1046).
    if (fields.onboarding === 'done' && was && was.onboarding !== 'done' && fields.rules_review === undefined) fields = { ...fields, rules_review: 1 };
    const keys2 = Object.keys(fields) as (keyof typeof fields)[];
    this.db.prepare(`UPDATE projects SET ${keys2.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys2.map((k) => fields[k] ?? ''), id);
    // Setup reaching done books the first-week check, seven days out, in that scheme (#1101).
    if (fields.onboarding === 'done' && was && was.onboarding !== 'done') scheduleFirstWeek(this, id);
  },

  /** When this scheme's current setup or tune-up round opened, or 0 for one opened before that was recorded. */
  onboardingOpenedAt(this: Store, id: number): number {
    return this.getSetting<number>(`onboarding_opened:${id}`) ?? 0;
  },

  /** Change a project's display name; its repo, folders and links go by id and stay put. */
  renameProject(this: Store, id: number, name: string): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('The scheme name cannot be empty');
    try {
      this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(trimmed, id);
    } catch (err) {
      if (/UNIQUE/.test(thrown(err).message ?? '')) throw new Error(`There is already a scheme called "${trimmed}"`);
      throw err;
    }
    return this.getProject(id)!;
  },

  /** The schemes this person hid for themselves (#226). */
  hiddenProjects(this: Store, uid: number): Set<number> {
    const rows = this.db.prepare('SELECT project_id FROM project_hides WHERE user_id = ?').all(uid) as { project_id: number }[];
    return new Set(rows.map((r) => r.project_id));
  },

  setProjectHidden(this: Store, uid: number, projectId: number, hidden: boolean) {
    if (hidden) this.db.prepare('INSERT INTO project_hides (user_id, project_id, hidden_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(uid, projectId, Date.now());
    else this.db.prepare('DELETE FROM project_hides WHERE user_id = ? AND project_id = ?').run(uid, projectId);
  },

  /** The order this person dragged a list into (#649): scheme ids or contraption names; [] when they never did. */
  listOrder(this: Store, uid: number, list: 'schemes' | 'apps'): (number | string)[] {
    const row = this.db.prepare('SELECT keys FROM list_orders WHERE user_id = ? AND list = ?').get(uid, list) as { keys: string } | undefined;
    return row ? JSON.parse(row.keys) : [];
  },

  setListOrder(this: Store, uid: number, list: 'schemes' | 'apps', keys: (number | string)[]) {
    this.db
      .prepare(`INSERT INTO list_orders (user_id, list, keys, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, list) DO UPDATE SET keys = excluded.keys, updated_at = excluded.updated_at`)
      .run(uid, list, JSON.stringify(keys), Date.now());
  },

  deleteProject(this: Store, id: number) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};
