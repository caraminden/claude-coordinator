// The scheme settings PATCH, out of src/routes/projects.ts (#2324): `planSettings` validates a body against the scheme and returns
// what to write, `settingsNotes` words the permanent lines for the Taskmaster's chat. Neither touches the server, so a table test reaches them.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanMsgSettings, cleanNeverHold } from './msg-settings.ts';
import { cleanPluginDirs, cleanRules, cleanShotNote, cleanShotThemes, cleanShotWidths, cleanWorkflows, lines } from './approvals.ts';
import type { Session } from './auth.ts';
import { BUILDS_MODES, EFFORTS, FABLE_OKS, GH_RUNNERS_MODES, GRILL_MODES, LAND_MODES, MAX_INSTRUCTIONS, ONBOARDING, ONBOARDING_MODES, type Project } from './db.ts';
import { adminAskRefusal, adminOwned } from './access.ts';
import { GO_FROM, label, SHIP_PATHS, shippingGate, TRY_FIRST, values } from '../public/shipping.js';
import { refuseStaleFields } from './instructions-save.ts';
import { KIT_DIR, listSkills, offSkills } from './skills.ts';
import { thrown } from './thrown.ts';
import { AGENT_NAME } from './auth.ts';
import { afterAllWrites, HttpError, oneOf, str, writes, type App } from './http.ts';

/** Every setting the PATCH takes; what is left out stays. */
export const SETTING_FIELDS = [
  'name',
  'instructions',
  'approval_rules',
  'plugin_dirs',
  'optional_plugin_dirs',
  'default_effort',
  'onboarding',
  'onboarding_mode',
  'list_groups',
  'ci_quiet',
  'ci_watch',
  'land_mode',
  'fable_ok',
  'builds',
  'grill',
  'gh_runners',
  'shot_widths',
  'shot_themes',
  'shots_required',
  'shot_note',
  'ship_path',
  'go_from',
  'try_first',
  'rules_review',
  'msg_loop_limit',
  'msg_loop_min',
  'msg_cold_min',
  'msg_hold_h',
  'msg_never_hold',
  'repo_url',
  'skills_off',
] as const;

type Store = App['store'];
export type SettingsPatch = Partial<
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
>;

export type SettingsPlan = { name: string; settings: SettingsPatch; instructions: string; repoUrl: string | null };

/** Validates a scheme settings body and works out what to write; throws an HttpError to refuse. Writes nothing. */
export async function planSettings(body: Record<string, any>, project: Project, store: Store, session: Session, caller: { id: number } | null | undefined): Promise<SettingsPlan> {
  const settings: SettingsPatch = {};
  const name = body.name === undefined ? project.name : str(body.name, 'Name', 80);
  // Unlike oneOf, null and '' are refused: there is no "unset" onboarding.
  const required = (v: unknown, all: readonly string[], field: string) => {
    if (typeof v !== 'string' || !all.includes(v)) throw new HttpError(400, `${field} must be one of: ${all.join(', ')}`);
    return v;
  };
  if (body.onboarding !== undefined) settings.onboarding = required(body.onboarding, ONBOARDING, 'onboarding') as Project['onboarding'];
  if (body.onboarding_mode !== undefined) settings.onboarding_mode = required(body.onboarding_mode, ONBOARDING_MODES, 'onboarding_mode') as Project['onboarding_mode'];
  if (body.land_mode !== undefined) settings.land_mode = required(body.land_mode, LAND_MODES, 'land_mode') as Project['land_mode'];
  if (body.fable_ok !== undefined) settings.fable_ok = required(body.fable_ok, FABLE_OKS, 'fable_ok') as Project['fable_ok'];
  if (body.builds !== undefined) settings.builds = required(body.builds, BUILDS_MODES, 'builds') as Project['builds'];
  if (body.grill !== undefined) settings.grill = required(body.grill, GRILL_MODES, 'grill') as Project['grill'];
  if (body.gh_runners !== undefined) settings.gh_runners = required(body.gh_runners, GH_RUNNERS_MODES, 'gh_runners') as Project['gh_runners'];
  // Fast mode is the kit's land.sh's LAND_FAST (#1017): a land.sh without it would land every change on the full gate.
  if (settings.land_mode === 'fast' && project.land_mode !== 'fast') {
    const land = project.repo_dir ? await readFile(join(project.repo_dir, 'tools', 'land.sh'), 'utf8').catch(() => '') : '';
    if (!/\bLAND_FAST\b/.test(land) || !/--verify\b/.test(land)) throw new HttpError(409, `This scheme's tools/land.sh ${land ? "doesn't know fast mode yet" : 'is missing'}: re-sync it from the kit's land template (kit/skills/scheme-setup/templates/land.sh) on main first, then turn fast mode on.`);
  }
  // Screenshot settings (#1044): widths in px, themes light and/or dark, a switch and one line of free text.
  try {
    if (body.shot_widths !== undefined) settings.shot_widths = cleanShotWidths(body.shot_widths);
    if (body.shot_themes !== undefined) settings.shot_themes = cleanShotThemes(body.shot_themes);
    if (body.shot_note !== undefined) settings.shot_note = cleanShotNote(body.shot_note);
  } catch (err) {
    throw new HttpError(400, thrown(err).message!);
  }
  // Message settings (#1059): whole numbers inside src/msg-settings.ts's bounds.
  try {
    Object.assign(settings, cleanMsgSettings(body));
    if (body.msg_never_hold !== undefined) settings.msg_never_hold = cleanNeverHold(body.msg_never_hold);
  } catch (err) {
    throw new HttpError(400, thrown(err).message!);
  }
  if (body.shots_required !== undefined) {
    if (typeof body.shots_required !== 'boolean') throw new HttpError(400, 'shots_required must be true or false');
    settings.shots_required = body.shots_required ? 1 : 0;
  }
  if (body.ship_path !== undefined) settings.ship_path = required(body.ship_path, values(SHIP_PATHS), 'ship_path') as Project['ship_path'];
  if (body.go_from !== undefined) settings.go_from = required(body.go_from, values(GO_FROM), 'go_from') as Project['go_from'];
  if (body.rules_review !== undefined) {
    if (typeof body.rules_review !== 'boolean') throw new HttpError(400, 'rules_review must be true or false');
    settings.rules_review = body.rules_review ? 1 : 0;
  }
  // Kit skills turned off on the Skills page (#1062): any member, nothing locked (Josh, 2026-11-19); only skills the kit has.
  if (body.skills_off !== undefined) {
    const kit = new Set(
      listSkills(KIT_DIR, null)
        .filter((i) => i.kind === 'skill')
        .map((i) => i.slug),
    );
    if (!Array.isArray(body.skills_off) || body.skills_off.some((s: unknown) => typeof s !== 'string' || !kit.has(s))) throw new HttpError(400, "skills_off must be a list of the kit's skill names");
    settings.skills_off = [...new Set(body.skills_off as string[])].sort().join(' ');
  }
  if (body.try_first !== undefined) settings.try_first = required(body.try_first, values(TRY_FIRST), 'try_first') as Project['try_first'];
  if ((settings.ship_path ?? project.ship_path) === 'pr-person' && settings.go_from !== undefined && settings.go_from !== 'all') {
    throw new HttpError(400, 'When a person merges every pull request, every change waits for their go: pick another way to ship first');
  }
  // null or "" leaves effort to Claude Code's default.
  if (body.default_effort !== undefined) settings.default_effort = oneOf(body.default_effort || null, EFFORTS, 'Default effort') ?? '';
  try {
    if (body.approval_rules !== undefined) settings.approval_rules = cleanRules(body.approval_rules);
    if (body.plugin_dirs !== undefined) settings.plugin_dirs = cleanPluginDirs(body.plugin_dirs);
    if (body.optional_plugin_dirs !== undefined) settings.optional_plugin_dirs = cleanPluginDirs(body.optional_plugin_dirs);
    if (body.ci_quiet !== undefined) settings.ci_quiet = cleanWorkflows(body.ci_quiet);
    if (body.ci_watch !== undefined) settings.ci_watch = cleanWorkflows(body.ci_watch, 'Watched CI workflows');
    if (body.list_groups !== undefined) settings.list_groups = JSON.stringify(store.props.listGroups(project.id, body.list_groups));
  } catch (err) {
    throw new HttpError(400, thrown(err).message!);
  }
  // Plugins load code from any folder on the server: an admin's, or an admin's scheme's Taskmaster's.
  // The optional ones too (#361): a minion picks from them without an admin, so registering one is the gate.
  const pluginsChanged = (['plugin_dirs', 'optional_plugin_dirs'] as const).some((k) => settings[k] !== undefined && settings[k] !== (project[k] ?? ''));
  if (pluginsChanged && !session.admin) {
    if (!caller || !adminOwned(store, project)) throw new HttpError(403, 'Only an admin can change plugin folders');
    const refused = adminAskRefusal(store, caller.id);
    if (refused) throw new HttpError(403, refused);
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new HttpError(400, 'instructions must be text');
  const instructions = body.instructions === undefined ? project.instructions : body.instructions.replace(/\r\n/g, '\n').trim();
  if (instructions.length > MAX_INSTRUCTIONS) {
    throw new HttpError(400, `Instructions are ${instructions.length.toLocaleString('en')} characters; the limit is ${MAX_INSTRUCTIONS.toLocaleString('en')}`);
  }
  // A repo URL only records where the repo lives: no clone, no re-pointing of a checkout. Refused before anything saves.
  let repoUrl: string | null = null;
  if (body.repo_url !== undefined) {
    repoUrl = typeof body.repo_url === 'string' ? body.repo_url.trim() : '';
    if (!/^(https:\/\/|git@)/.test(repoUrl!)) throw new HttpError(400, 'Repo URL must be https:// or git@');
    if (/\s/.test(repoUrl!) || /^https:\/\/[^/]*@/.test(repoUrl!)) throw new HttpError(400, 'Repo URL cannot hold spaces or a login');
    if (repoUrl === project.repo_url) repoUrl = null;
    else if (project.repo_url && body.replace_repo !== true) {
      throw new HttpError(409, `This scheme's repo is already ${project.repo_url}; send replace_repo: true to point it at ${repoUrl} instead`);
    }
  }
  while (body.was !== undefined && writes.landed?.(true)) await afterAllWrites(() => {}); // another save still queued is another version; from here to this save's write there is no await
  if (body.was !== undefined) refuseStaleFields(body.was, store.getProject(project.id)!, { instructions, ...settings });
  // Worked out before anything is written, since it can still refuse (too many approval rules). The one gate (#1043): the go threshold and the merge approval can't disagree, whichever of them this save changed.
  const gate = shippingGate({ ...project, ...settings });
  if (gate.go_from !== (settings.go_from ?? project.go_from)) settings.go_from = gate.go_from;
  if (gate.approval_rules !== (settings.approval_rules ?? project.approval_rules)) {
    try {
      settings.approval_rules = cleanRules(gate.approval_rules);
    } catch (e) {
      throw new HttpError(400, `Shipping ticks "Merge a pull request" under Approvals, which doesn't fit: ${(e as Error).message}`);
    }
  }
  return { name, settings, instructions, repoUrl };
}

/** The permanent lines for the Taskmaster's chat about what a save changed (who changed what, since rules decide what needs a person's OK). */
export function settingsNotes(project: Project, settings: SettingsPatch, who: string): string[] {
  const notes: string[] = [];
  const say = (text: string) => notes.push(text);
  const shown = (text: string) => (text ? lines(text).join(', ') : 'none');
  const next = "They apply from each minion's next turn.";
  if (settings.approval_rules !== undefined) say(`${who} set the approval rules to: ${shown(settings.approval_rules)}. ${next}`);
  if (settings.plugin_dirs !== undefined) say(`${who} set the plugin folders to: ${shown(settings.plugin_dirs)}. ${next}`);
  if (settings.optional_plugin_dirs !== undefined) say(`${who} set the optional plugin folders to: ${shown(settings.optional_plugin_dirs)}. Minions load them only when they pick them, from their next turn.`);
  if (settings.ci_quiet !== undefined) say(`${who} set the quiet CI workflows to: ${shown(settings.ci_quiet)}. Their red scheduled and dispatched runs no longer tell you.`);
  if (settings.ci_watch !== undefined) say(`${who} set the watched CI workflows to: ${shown(settings.ci_watch)}. When one goes red on main, you're woken once per red streak and told when it's back to green.`);
  if (settings.land_mode !== undefined) {
    say(
      settings.land_mode === 'fast'
        ? `${who} turned fast mode on. Low and medium changes now ship live on the smoke check alone, and the full suite runs on main behind them: a red reopens the minion whose change broke it, and comes to you if it isn't fixed in 30 minutes. High-risk changes and pipeline changes keep the full gate.`
        : `${who} turned fast mode off. Every change waits for the full check and CI again before it ships.`,
    );
  }
  if ((['ship_path', 'go_from', 'try_first'] as const).some((k) => settings[k] !== undefined)) {
    const now = { ...project, ...settings };
    say(
      `${who} set Shipping to: ${label(SHIP_PATHS, now.ship_path)}; a person's go: ${label(GO_FROM, now.go_from).toLowerCase()}; try it first: ${label(TRY_FIRST, now.try_first).toLowerCase()}. It applies from each minion's next turn and wins over the scheme instructions. If those still describe shipping differently, offer the members a card to bring them in line.`,
    );
  }
  if (settings.skills_off !== undefined) {
    const was = new Set(offSkills(project));
    const now = offSkills({ skills_off: settings.skills_off });
    const off = now.filter((x) => !was.has(x));
    const on = [...was].filter((x) => !now.includes(x));
    const named = (xs: string[]) => xs.map((x) => `citadel:${x}`).join(', ');
    say(`${who} ${[off.length ? `turned off ${named(off)}` : '', on.length ? `turned back on ${named(on)}` : ''].filter(Boolean).join(' and ')} on the Skills page. It applies from each minion's next turn.`);
  }
  if (settings.default_effort !== undefined) say(`${who} set the scheme's default effort to ${settings.default_effort || "Claude Code's default"}. It applies from each minion's next turn.`);
  if (settings.onboarding === 'skipped') say(`${who} skipped the scheme's setup. Tell the ${AGENT_NAME} to pick it up again any time.`);
  return notes;
}
