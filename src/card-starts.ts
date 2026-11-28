// A pick on a card starts the minion (#2050; Josh, 2026-11-25, picked "Start" on #2031's choices page; docs/adr/0038).
// A minion's ask_question option can carry `start`: the handoff it starts from and its title, type, model and effort. A
// person's plain pick makes that minion with no Taskmaster turn, through the Taskmaster's own create path (createMinion:
// the duplicate-handoff check, the start card over START_CARD_USD, the worker pool), as the person who picked. A pick that comes with
// typed words or a picture starts nothing: the words may change the brief, so the card's owner is woken, as before.
// Every scheme's cards get this. Choices pages don't yet: their Send still goes to the minion, which passes the picks on.
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Session } from './auth.ts';
import { workLines } from './branch.ts';
import { tellTaskmaster } from './ci-armed.ts';
import { handoffBrief } from './cloud-pool.ts';
import { gitOut } from './git.ts';
import { buildOwnerKey, EFFORTS, MODELS, type Ticket } from './db.ts';
import { buildNumber, HttpError, oneOf, str, type App } from './http.ts';
import { money, START_CARD_USD, startHoldKey } from './minion-budget.ts';
import { createMinion } from './routes/projects.ts';
import { thrown } from './thrown.ts';
import { projectSharedDir } from './workspace.ts';
import { TIERS, tierLabel } from '../public/model-table.js';

/** An option's start, as stored on the card once cleanStart has checked it. `handoff` is its path in the shared folder. */
export interface CardStart {
  handoff: string;
  title: string;
  type: string;
  model?: string;
  effort?: string;
  start_after?: number;
  build?: number;
}

/** The handoff's path inside the scheme's shared folder (the folder's own spelling, not a link's target), or why not. */
async function handoffPath(shared: string, raw: string, where = ''): Promise<string> {
  // The duplicate check and the brief's cost line read a handoff's path out of the brief's text, which ends a path at a space or quote.
  if (/[\s`'"()<>[\]]/.test(raw)) throw new HttpError(400, `${where}start.handoff ${raw}: rename the file without spaces, quotes or brackets, so its brief can name it`);
  const abs = isAbsolute(raw) ? raw : join(shared, raw);
  let real: string;
  let root: string;
  try {
    real = await realpath(abs);
    root = await realpath(shared);
  } catch {
    throw new HttpError(400, `${where}start.handoff ${raw} does not exist: write the handoff first, then post the card`);
  }
  if (!real.startsWith(`${root}/`) || !real.endsWith('.md') || !(await stat(real)).isFile()) throw new HttpError(400, `${where}start.handoff must be a .md file in this scheme's shared folder (${shared}), not ${raw}`);
  return join(shared, relative(root, real));
}

/** Check an option's `start` when the card is posted, so a bad one is refused to its author rather than at the pick. */
export async function cleanStart(app: App, projectId: number, raw: unknown, where: string): Promise<CardStart> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `${where} start must be an object: { handoff, title, type, model?, effort?, start_after?, build? }`);
  const s = raw as Record<string, unknown>;
  const handoff = await handoffPath(projectSharedDir(app.dataDir, projectId), str(s.handoff, `${where} start.handoff`, 1000), `${where} `);
  const title = str(s.title, `${where} start.title`, 120);
  const type = str(s.type, `${where} start.type`, 40);
  try {
    if (!app.store.props.check(projectId, { type }).type?.length) throw new Error(`${type} is not a type here`);
  } catch (err) {
    throw new HttpError(400, `${where} start.type: ${thrown(err).message}`);
  }
  // Checked against the model table: a tier it names (TIERS), both or neither; left out, the table's pick for its type (pickFor).
  const model = oneOf(s.model ?? null, MODELS, `${where} start.model`);
  const effort = oneOf(s.effort ?? null, EFFORTS, `${where} start.effort`);
  if (model || effort) {
    const fable = app.store.getProject(projectId)?.fable_ok !== 'off';
    const tiers = TIERS.filter((t) => fable || !t.model.startsWith('claude-fable'));
    if (!tiers.some((t) => t.model === model && t.effort === effort))
      throw new HttpError(400, `${where} start: ${model ?? '(no model)'} at ${effort ?? '(no effort)'} isn't a tier of the model table. Give a tier's model and effort (${[...new Set(tiers.map((t) => tierLabel(t.model, t.effort)))].join(', ')}), or leave both out for the table's pick for its type`);
  }
  if (s.start_after != null && !(Number.isInteger(s.start_after) && (s.start_after as number) > 0)) throw new HttpError(400, `${where} start.start_after must be a minion number`);
  const build = s.build == null ? null : buildNumber(s.build);
  return { handoff, title, type, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(s.start_after != null ? { start_after: s.start_after as number } : {}), ...(build ? { build } : {}) };
}

/** The first line of the brief a pick starts: the handoff is the whole brief (citadel:briefing). Named "the handoff" so the duplicate check finds it wherever it sits. */
export const startBrief = (handoff: string) => `Start from the handoff ${handoff}`;

// Handoffs being started right now: a second pick of the same one, on another card, waits for none and is refused.
const starting = new Set<string>();

interface Answer {
  selected: string[];
  other?: string;
}
interface Question {
  options: { label: string; start?: CardStart }[];
}

/**
 * Start the minions a person's pick names. Null when no picked option carries a start: the answer goes as usual. Otherwise
 * `held` says the card's owner hears it as held mail (every pick started, nothing else picked); else it is woken, with `text`
 * (what started, what didn't and why) after the answer.
 */
export async function startPicked(app: App, owner: Ticket, questions: Question[], answers: Answer[], session: Session, added: boolean): Promise<{ held: boolean; text: string; started: string[] } | null> {
  const { store } = app;
  const picks = questions.flatMap((q, i) => (answers[i]?.selected ?? []).map((label) => q.options.find((o) => o.label === label)));
  const starts = [...new Map(picks.flatMap((o) => (o?.start ? [[o.start.handoff, o.start] as const] : []))).values()];
  if (!starts.length) return null;
  if (added) return { held: false, started: [], text: `(Citadel started nothing by itself: words or a picture came with the pick, and they may change a brief. Act on them, and have your Taskmaster start what they picked, as before.)` };
  const project = store.getProject(owner.project_id)!;
  const started: string[] = [];
  const refused: string[] = [];
  for (const s of starts) {
    if (starting.has(s.handoff)) {
      refused.push(`${s.title}: another pick is starting ${s.handoff} right now`);
      continue;
    }
    starting.add(s.handoff);
    try {
      // Again at the pick: a handoff moved or deleted since the card was posted would start a minion with no brief.
      const shared = projectSharedDir(app.dataDir, owner.project_id);
      const text = await readFile(await handoffPath(shared, s.handoff), 'utf8');
      const t = await createMinion(
        app,
        project,
        {
          title: s.title,
          message: handoffBrief(startBrief(s.handoff), text, s.type, shared), // #2153
          properties: { type: s.type },
          model: s.model ?? null,
          effort: s.effort ?? null,
          parent: owner.number,
          ...(s.start_after != null ? { start_after: s.start_after } : {}),
          ...(s.build != null ? { build: s.build } : {}),
        },
        session,
        owner,
        true,
      );
      const waits = store.getSetting(startHoldKey(t.id)) ? `, waiting for its start card (its brief expects over ${money(START_CARD_USD)})` : t.state === 'parked' ? `, sealed until #${s.start_after}'s work is in` : '';
      started.push(`#${t.number} ${t.title} (${t.model ?? ''} ${t.effort ?? ''}, from ${s.handoff}${waits})`.replace(/\( +/, '('));
    } catch (err) {
      refused.push(`${s.title}: ${thrown(err).message}`);
    } finally {
      starting.delete(s.handoff);
    }
  }
  const lines = [...(started.length ? [`Citadel started ${started.join('; ')}, as ${session.name}'s.`] : []), ...(refused.length ? [`Not started: ${refused.join('; ')}.`] : [])];
  if (started.length) {
    app.runner.emit(owner.id, 'note', { text: lines[0] });
    await tellTaskmaster(app, owner, `(for your tracking; nothing to do) ${session.name} picked on #${owner.number}'s card, and ${lines.join(' ')}`, false, false, 'fyi', true); // notice: a reply the minion owes another Taskmaster keeps its way back
  }
  // Held only when the pick was all starts and all of them went: anything else is the owner's to act on.
  const held = !refused.length && picks.every((o) => o?.start);
  const tail = refused.length ? ' Fix what refused them, or have your Taskmaster start them.' : held ? '' : ' Act on the rest of the answer.';
  return { held, started, text: `${lines.join(' ')}${tail}` };
}

/**
 * Why the owner of a card whose pick started everything still has something left for people, or null when nothing is (#2175):
 * then the server dismisses it, as the Closing rule asks. Kept open by a branch with work main lacks (commits, or files not
 * committed yet), or one git can't read; another card; a state other than ready (try, pending-deploy, sealed, outside,
 * complete, blocked); a turn running or owed; leading a build or cabal; and belonging to a Plot (a feeder closes itself on merge, so a member still open has work owed, #2314). The git reads come first, so the checks that
 * can change meanwhile are read last, with no wait between them and the close.
 */
export async function leftForPeople(app: { store: Pick<App['store'], 'getTicket' | 'getProject' | 'getCabal' | 'getSetting'>; runner: Pick<App['runner'], 'busy' | 'keptOpen'> }, id: number): Promise<string | null> {
  const { store, runner } = app;
  const first = store.getTicket(id);
  const repo = first && store.getProject(first.project_id)?.repo_dir;
  if (repo && first.branch) {
    // Fail closed: a git call that fails (a timeout under load) keeps the minion open.
    const tip = await gitOut(['for-each-ref', '--format=%(objectname)', `refs/heads/${first.branch}`], repo);
    if (tip === null) return "git couldn't read its branch";
    if (tip) {
      const main = (await gitOut(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo))?.replace(/^origin\//, '') || 'main';
      const ahead = await gitOut(['rev-list', '--count', `refs/heads/${main}..${tip}`], repo);
      if (ahead === null) return `git couldn't compare its branch with ${main}`;
      if (Number(ahead) > 0) return `its branch has commits ${main} lacks`;
    }
    if (first.cwd) {
      const status = await gitOut(['--no-optional-locks', 'status', '--porcelain'], first.cwd, { trim: false });
      if (status === null) return "git couldn't read its worktree";
      if (workLines(status)) return 'its worktree has work not committed';
    }
  }
  const t = store.getTicket(id);
  if (!t || t.status === 'closed') return 'it is closed already';
  if (t.kind !== 'ticket') return 'it is a Taskmaster';
  if (t.state && t.state !== 'ready') return `its state is ${t.state}`;
  if (runner.busy(id)) return 'a turn of its own runs or is owed';
  const kept = runner.keptOpen(id, true);
  if (kept) return kept;
  if (store.getCabal(id) || (t.build != null && store.getSetting<number>(buildOwnerKey(t.project_id, t.build)) === id)) return 'it leads a build or cabal';
  // Still in a Plot with nothing on its branch: mid-job (waiting on others, or carrying on), not a pure proposer (#2314).
  if (t.build != null) return 'it is a Plot member, still in its job';
  return null;
}
