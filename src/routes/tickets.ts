// One minion's (or Taskmaster's) chat and state: what people, its Taskmaster and the minion itself
// may do to it. Who may call each route is its `who` (src/http.ts).
import { azureSpeech } from '../azure-speech.ts';
import { CARD_STOP, money, SPLIT, splitCeiling, START, startHoldKey } from '../minion-budget.ts';
import { parseSpend } from '../outside-spend.ts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { cleanPluginPicks, lines } from '../approvals.ts';
import { adminAskRefusal } from '../access.ts';
import { APP_NAME } from '../appname.ts';
import { AGENT_NAME, type Session } from '../auth.ts';
import { choicesPage, commentMessage, optionImageProblem, pageTitle } from '../artifacts.ts';
import { cardLabel } from '../card-links.ts';
import { cardTwin } from '../card-twins.ts';
import { checkNeed } from '../needs.ts';
import { armForCi, type Card, mergeCard, postCard, replyToKey, tellTaskmaster } from '../ci-armed.ts';
import { addRunnerWaiter } from '../ci-health.ts';
import { runnerLabel, schemeLabels } from '../ci-runner.ts';
import { CLAUDE_MODELS, pickReason } from '../../public/model-table.js';
import { buildOwnerKey, EFFORTS, MODELS, PERSON_NOTE_MAX, TICKET_STATES, type Ticket, type TicketState } from '../db.ts';
import { moveEffort } from '../effort-retros.ts';
import { unsealedBy } from '../held-mail.ts';
import { buildBranchLater } from '../workspace.ts';
import { historyPage } from '../history.ts';
import { factsText, liveFacts } from '../live-facts.ts';
import { hostCheck } from '../host-check.ts';
import { shipRisk, shipRiskText } from '../ship-risk.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import { landArgs } from '../land.ts';
import { checkHandoff, prepareHandoff, shipOnClick, startHandoff } from '../ship-handoff.ts';
import { laneHandoff, triggerHandoff } from '../armed-handoff.ts';
import { cleanStart, leftForPeople, startPicked, type CardStart } from '../card-starts.ts';
import { reviewRefusal } from '../review-gate.ts';
import { criticRefusal } from '../critic-gate.ts';
import { parseLearned, queueLesson, touchedFiles } from '../ship-lessons.ts';
import { MEDIA_TOOLS, type MediaTool } from '../openrouter.ts';
import { previewPath } from '../previews.ts';
import { repoSlug } from '../prlinks.ts';
import { NOTIFY_STATES } from '../push.ts';
import { addMention, clearMentions, mentionedIn } from '../mentions.ts';
import { MAX_UPLOAD_BYTES, saveUpload } from '../uploads.ts';
import { cleanPaths, defaultBranch, diffSize, LIMITS, overLimit, type BatchRow, type ReviewSpec } from '../ultrareview.ts';
import { sendIdOf, sendOnce } from '../send-ids.ts';
import { SIDE_MAX_CHARS } from '../side-ask.ts';
import { chatCommands } from '../slash-commands.ts';
import { afterAllWrites, buildNumber, HttpError, isRecord, json, type JsonBody, oneOf, ownWrites, publicOrigin, readJson, replyList, slowJson, str, ticketView, workflowSwitch, type App, type Ctx, type Route, type TicketView } from '../http.ts';
import { SECRET_ENV_PREFIX, secretName, secretValue, type SecretScope } from '../secrets.ts';
import { fileUploadsDir, messageFiles, resolveTicketFile, saveImages, ticketRoots } from './files.ts';
import { deciding, postPlan } from '../plan-cards.ts';

export { postPlan };
import { ensureCoordinatorFor, LINE_FIELDS, schemeTarget } from './projects.ts';
import { pacificTime, parseWakeTime, type Relay, relayDests, takeOffChain } from '../wake.ts';
import { gitOut } from '../git.ts';
import { thrown } from '../thrown.ts';
import type { ContentBlock } from '../claude-events.ts';
import { MachineJobs } from '../machine-jobs.ts';
import { NOT_NOW as KIT_NOT_NOW, SHIP as KIT_SHIP } from '../kit-sync.ts';
import { stopMinionShip } from '../ship-stop.ts';
import { approveRoster, FORM_GO } from '../cabal-start.ts';
import { cabalLead, putOnCabal } from './cabals.ts';

/** A minion's plugin picks (#361) as stored, from its scheme's optional folders; a Taskmaster loads none. */
/**
 * Set a minion's label fields from a PATCH body or a reply's status trailer (#711): any of title, state, note, replies,
 * build, model, effort, workflow and plugin_dirs, with their checks (a bad one throws HttpError). `name` is who set
 * them and `caller` the agent's ticket, if an agent did. Returns why a pending close_self was cancelled, if it was.
 */
export function setLabels(app: App, ticket: Ticket | TicketView, body: Record<string, unknown>, name: string, caller: number | null): string | null {
  const { id } = ticket;
  const { store, runner } = app;
  // Any of title, state, note, replies, build, model, effort, workflow and plugin_dirs; null (or "") clears all but the title.
  const fields: Partial<Pick<Ticket, 'title' | 'state' | 'note' | 'replies' | 'build' | 'model' | 'effort' | 'workflow' | 'plugin_dirs' | 'picked_because'>> = {};
  if (body.model !== undefined) fields.model = oneOf(body.model, MODELS, 'Model');
  if (body.workflow !== undefined) fields.workflow = workflowSwitch(body.workflow, ticket);
  if (body.plugin_dirs !== undefined) fields.plugin_dirs = pluginPicks(store, ticket, body.plugin_dirs);
  if (body.effort !== undefined) fields.effort = oneOf(body.effort, EFFORTS, 'Effort');
  if (body.title !== undefined) fields.title = str(body.title, 'Title', 120);
  if (body.state !== undefined) fields.state = oneOf(body.state === 'sealed' ? 'parked' : body.state, TICKET_STATES, 'State') as TicketState | null;
  if (body.note !== undefined) fields.note = body.note ? str(body.note, 'Note', 60) : null;
  if (body.build !== undefined) fields.build = buildNumber(body.build);
  if (body.replies !== undefined) fields.replies = replyList(body.replies);
  // Complete always says what's left (#547; Josh, 2026-11-11): its note comes with it, and stays while it holds.
  const clearsNote = ticket.state === 'complete' && body.state === undefined && body.note !== undefined;
  if ((body.state === 'complete' || clearsNote) && !fields.note) {
    throw new HttpError(400, 'State complete needs a note in the same call saying what is left: "nothing left", or what people should read now ("read: the PR #12 report"), at most 60 characters. Link the files themselves in your reply');
  }
  // Off its start_after chain, still sealed (#1823): its held brief becomes held mail, read when it is unsealed or messaged with unpark.
  if (body.start_after !== undefined) {
    if (body.start_after !== null) throw new HttpError(400, 'start_after can only be set to null here: it takes a minion off its chain (a chain is made by create_ticket)');
    if (ticket.kind === 'coordinator' || caller === id) throw new HttpError(400, `A minion can't take itself, or the ${AGENT_NAME}, off a chain`);
    if (!takeOffChain(ticket, name, { store, runner, waiters: app.waiters }, body.note === undefined)) throw new HttpError(409, `#${ticket.number} isn't sealed waiting on another minion's work`);
  }
  // A cabal's board (#2090): the Taskmaster or a person puts a minion on one, never the minion itself.
  // Checked here, done after the other fields: a refused field leaves it where it was.
  if (body.cabal !== undefined) {
    if (caller === id) throw new HttpError(400, "A minion can't put itself on a Plot or take itself off one: ask the Taskmaster");
    if (body.cabal !== null) cabalLead(store, ticket.project_id, body.cabal, id, typeof body.title === 'string' ? body.title : ticket.title);
  }
  // The view's replies are a list; compare the stored JSON.
  const stored = store.getTicket(id)!;
  for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === stored[k]) delete fields[k];
  // Clearing a sealed minion's state unseals it (#718): update_ticket's way for the Taskmaster. Not the minion's own.
  const unparks = 'state' in fields && fields.state === null && caller !== id && runner.parked(stored);
  if (unparks) delete fields.state;
  let closeCancelled: string | null = null;
  if (Object.keys(fields).length) {
    // A new model or effort changes why it runs where it does (#1061): a Taskmaster's change is a step-up after a stall, a person's is theirs.
    if ('model' in fields || 'effort' in fields) {
      fields.picked_because = pickReason(caller !== null && caller !== id ? 'step-up' : name, null, 'model' in fields ? (fields.model ?? null) : stored.model, 'effort' in fields ? (fields.effort ?? null) : stored.effort, typeof body.pick_reason === 'string' ? body.pick_reason.slice(0, 200) : '');
      store.addPick(id, 'model' in fields ? (fields.model ?? null) : stored.model, 'effort' in fields ? (fields.effort ?? null) : stored.effort, caller !== null && caller !== id ? 'Taskmaster' : name, fields.picked_because!);
    }
    store.updateTicket(id, fields, caller === id ? { kind: 'minion' } : { kind: caller === null ? 'person' : 'agent', name });
    if (fields.state === 'pending-deploy') runner.deployPending(id);
    if (fields.state) closeCancelled = runner.closeCancelled(id, caller !== id);
    if ('build' in fields) store.props.setBuild(id, fields.build ?? null, name);
    const who = caller === id ? 'Claude' : name;
    if (fields.title) runner.emit(id, 'note', { text: `${who} renamed this minion from "${ticket.title}" to "${fields.title}".` });
    const next = runner.isRunning(id) ? 'from the next turn' : 'from now on';
    if ('model' in fields) runner.emit(id, 'note', { text: `${who} set this minion to ${fields.model ? modelName(fields.model) : 'the default model'} ${next}.` });
    if ('effort' in fields) runner.emit(id, 'note', { text: `${who} set this minion to ${fields.effort ? `${fields.effort} effort` : 'the default effort'} ${next}.` });
    if ('workflow' in fields) runner.emit(id, 'note', { text: `${who} turned the Workflow tool ${fields.workflow ? 'on' : 'off'} for this minion ${next}.` });
    if ('plugin_dirs' in fields) {
      const text = fields.plugin_dirs ? `set this minion's extra plugin folders to ${lines(fields.plugin_dirs).join(', ')}` : "took this minion's extra plugin folders off";
      runner.emit(id, 'note', { text: `${who} ${text} ${next}.` });
    }
    runner.broadcastTicket(id);
    // A result or a blocker is worth a ping; whoever set it by hand already knows. The state and note are the ones
    // just written, never read back: a read that gives up on the write queue (src/db-writer.ts) answers from the row
    // before them, which said the old note or, for a state of null, dropped the ping altogether (#1634).
    // shortcut: a state with no note of its own still falls back to the row read above, so a note write still queued
    // when this one arrives pings the note before it; upgrade when a write can hand back the row it wrote.
    if (fields.state && NOTIFY_STATES[fields.state]) {
      app.notify(id, { kind: 'state', state: fields.state, note: 'note' in fields ? (fields.note ?? null) : stored.note }, caller ? null : name);
    }
  }
  if (body.cabal !== undefined) putOnCabal(app, ticket, body.cabal, name);
  if (unparks) {
    unparkTicket(app, stored, name, caller ? APP_NAME : name).catch((err) => {
      runner.emit(id, 'note', { text: `Unparking failed: ${err.message}` });
      runner.broadcastTicket(id);
    });
  }
  return closeCancelled;
}

function pluginPicks(store: App['store'], ticket: { kind: string; project_id: number }, v: unknown): string {
  if (ticket.kind === 'coordinator') throw new HttpError(400, 'Only minions pick plugin folders');
  try {
    return cleanPluginPicks(v, store.getProject(ticket.project_id)?.optional_plugin_dirs ?? '');
  } catch (err) {
    throw new HttpError(400, thrown(err).message!);
  }
}

/** One area of a batch ask as sent. */
interface RawArea {
  paths?: unknown;
  name?: unknown;
  question?: unknown;
}

const ULTRAREVIEW_REFUSE = 'Only a person can start an ultra review: it is billed to their own Claude account';
const ULTRAREVIEW_PREP_REFUSE = "Only a person, or this chat's own minion for the person its turn runs for, can prep ultra reviews";

/** Whose batch a prep call works on (#1399): the signed-in person, or for the chat's own minion the person its turn runs for. */
function prepper(app: App, session: Session, caller: Ticket | null, ticket: TicketView): { uid: number; name: string } | null {
  if (!caller) return session.uid ? { uid: session.uid, name: session.name } : null;
  if (caller.kind === 'coordinator') throw new HttpError(403, 'Only a minion preps ultra reviews for its person, not a Taskmaster');
  const uid = app.store.getTicket(ticket.id)?.person_id;
  const user = uid == null ? undefined : app.store.getUser(uid);
  return user ? { uid: user.id, name: user.name } : null;
}
/** At most this many areas in one batch ask (#1399). */
const BATCH_MAX = 20;
/** A batch row as the panel sees it: no repo path or user id. */
const rowView = ({ repo, uid, ...row }: BatchRow) => row;
const hasGithub = (app: App, uid: number) => {
  const person = app.store.getUser(uid);
  return !!(person && app.github.token(person));
};

/** The setting holding the last deploy report that failed (server.ts shows it in the ship line). */
export const DEPLOY_FAILURE = 'deploy-failure';

// A label Claude ended with "(Recommended)" (or "(rec.)") itself; the card adds those words to the flagged option.
const SAYS_RECOMMENDED = /\s*\((recommended|rec\.?)\)\s*$/i;
// A description that opens with "Recommended." flags its option when none is flagged (#481); the words go, the card shows them.
const DESCRIBED_RECOMMENDED = /^\s*recommended(?:\s*[.:;,!\u2013\u2014-]+\s*|\s*$)/i;

interface SecretAsk {
  name: string;
  scope: SecretScope;
  why?: string;
}

/** A question card's option as stored, once cleanQuestions has checked it. */
interface CardOption {
  label: string;
  description?: string;
  image?: string;
  recommended?: true;
  /** A pick starts this minion with no turn (#2050, src/card-starts.ts). */
  start?: CardStart;
}
/** A question card's question as stored. */
interface CardQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: CardOption[];
}
/** An option or a question as the ask sends it, before the checks. */
interface RawOption {
  label?: unknown;
  description?: unknown;
  image?: unknown;
  recommended?: unknown;
  start?: unknown;
}
interface RawQuestion {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: unknown;
}

/** A secret card's ask (#838): the name it saves under, whose it is (the answerer's own unless "scheme"), and why. */
function secretAsk(v: unknown): SecretAsk {
  if (!v || typeof v !== 'object') throw new HttpError(400, 'secret must be an object with a name');
  const raw: { scope?: unknown; name?: unknown; why?: unknown } = v;
  const scope = oneOf(raw.scope ?? 'person', ['person', 'scheme'], 'secret.scope') as SecretScope;
  return { name: secretName(raw.name), scope, ...(raw.why ? { why: str(raw.why, 'secret.why', 300) } : {}) };
}

/**
 * A question card from Claude: 1 to 4 questions, each with 2 to 6 options, one of them recommended
 * (any number on a pick-any question), so people always see what Claude would pick. An option's
 * image must be a picture or video the ticket may show, so a card can't reach files outside its folders.
 */
/** The shells a command block on a card (or in a reply) is tagged with: the Citadel-wide "Commands people run" rule. */
const SHELL_TAGS = ['powershell', 'powershell-admin', 'wsl', 'fish', 'bash', 'cmd'];
/** Whether a card's text opens a fenced block with no tag. A block closes on a bare fence at least as long as its opener, so fences inside a longer one (````md around ```bash) are its text. */
export function untaggedFence(text: string): boolean {
  let open = 0;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!open) {
      if (!m[2].trim()) return true;
      open = m[1].length;
    } else if (m[1].length >= open && !m[2].trim()) open = 0;
  }
  return false;
}

async function cleanQuestions(app: App, ticket: Ticket | TicketView, raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new HttpError(400, 'questions must be a list of 1 to 4 questions');
  const questions = raw.map((q: RawQuestion, i: number) => {
    const n = `Question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new HttpError(400, `${n} must be an object`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw new HttpError(400, `${n} needs 2 to 6 options`);
    const flagged = q.options.some((o: RawOption | null | undefined) => o?.recommended === true || o?.recommended === 'true');
    const options = q.options.map((o: RawOption | null | undefined, j: number): CardOption => {
      const says = typeof o?.label === 'string' && SAYS_RECOMMENDED.test(o.label);
      const described = !flagged && typeof o?.description === 'string' && DESCRIBED_RECOMMENDED.test(o.description);
      const description = described ? (o!.description as string).replace(DESCRIBED_RECOMMENDED, '') : o?.description;
      return {
        label: str(says ? (o!.label as string).replace(SAYS_RECOMMENDED, '') : o?.label, `${n} option ${j + 1} label`, 80),
        ...(description ? { description: str(description, `${n} option ${j + 1} description`, 300) } : {}),
        ...(o?.image ? { image: str(o.image, `${n} option ${j + 1} image`, 1000) } : {}),
        ...(o?.recommended === true || o?.recommended === 'true' || says || described ? { recommended: true } : {}),
        ...(o?.start != null ? { start: o.start as CardStart } : {}),
      };
    });
    if (new Set(options.map((o) => o.label)).size !== options.length) throw new HttpError(400, `${n} has duplicate option labels`);
    const recommended = options.filter((o) => o.recommended).length;
    if (!recommended) throw new HttpError(400, `${n} needs a recommended option: set "recommended": true on the one you would pick (exactly one; any number on a multiSelect question)`);
    if (recommended > 1 && q.multiSelect !== true) throw new HttpError(400, `${n} recommends ${recommended} options; mark just one`);
    const question = str(q.question, n, 500);
    const untagged = [question, ...options.map((o) => o.description ?? '')].some(untaggedFence);
    if (untagged)
      throw new HttpError(
        400,
        `${n} has a code block with no tag. A command people run goes in a fenced block tagged with where it runs (${SHELL_TAGS.map((t) => '```' + t).join(', ')}): the card draws it with that header and a Copy button, as a reply does, and every value in it is filled in, no <placeholder> but a secret. Tag anything else \`\`\`text`,
      );
    return {
      question,
      ...(q.header ? { header: str(q.header, `${n} header`, 24) } : {}),
      multiSelect: q.multiSelect === true,
      options,
    };
  });
  for (const [i, q] of questions.entries()) {
    for (const [j, o] of q.options.entries()) {
      // Checked here, not in the map above: it reads the file system (#2050).
      if (o.start) o.start = await cleanStart(app, ticket.project_id, o.start, `Question ${i + 1} option ${j + 1}`);
      const problem = o.image && (await optionImageProblem(o.image, ticket.cwd, ticketRoots(app, ticket)));
      if (problem) throw new HttpError(400, `Question ${i + 1} option ${j + 1} image ${problem}`);
    }
  }
  return questions;
}

/** The page a choices card opens (#804): a mock kit page with pick bars in the minion's folders, whose Send dock answers the card. */
async function choicesDoc(app: App, ticket: Ticket | TicketView, raw: unknown): Promise<{ path: string; title: string }> {
  const found = await resolveTicketFile(app, ticket, str(raw, 'doc', 1000));
  if (found?.type.kind !== 'html') throw new HttpError(400, 'doc must be an HTML page in your working directory or shared folder');
  const html = await readFile(found.file, 'utf8');
  if (!choicesPage(html)) throw new HttpError(400, 'doc must be a mock kit page with pick bars (it loads mockkit.js and calls mock.picks or mock.boards): its Send dock is what answers the card (citadel:docs-and-mocks skill)');
  return { path: found.abs, title: pageTitle(html, found.abs) };
}

/** The minion a close's `into` names, where the closing one's ask moved; refused before anything closes. */
function movedInto(app: App, ticket: Ticket | TicketView, body: Record<string, unknown>): Ticket | null {
  if (body.into == null) return null;
  if (body.as !== 'replaced') throw new HttpError(400, 'into goes with as: replaced');
  const into = app.store.getTicketByNumber(ticket.project_id, Number(body.into));
  if (!into || into.id === ticket.id || into.kind === 'coordinator') throw new HttpError(400, `into: no other minion #${body.into} here`);
  return into;
}

/** The stop button: the turn, its waiting test-box job and its running ship (unless past moving main: `ship` says which). */
export async function stopMinion(app: App, ticket: Ticket | TicketView, by: string) {
  const stopped = app.runner.stop(ticket.id);
  // Its test-box job still waiting for the screen leaves the line, turn or no turn: Citadel follows it after the turn ends (#1425).
  const followed = app.machines.minionStopped(ticket.id);
  // Its running ship stops too (#1168).
  const ship = ticket.kind === 'ticket' ? await stopMinionShip(app, ticket.id, by) : null;
  return { stopped: stopped || followed > 0, ship };
}

/**
 * A direct card's addressee (#687): `to` names one member of the asking scheme, by name or login, and comes back
 * as their name (what the chat, the inbox and push go by); null for a card to everyone. Only the asking scheme's
 * members: a card never reaches anyone a message in its chat couldn't.
 */
export function addressee(app: App, ticket: Ticket | TicketView, raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const want = String(raw).trim().replace(/^@/, '').toLowerCase();
  const members = app.store.listMembers(ticket.project_id);
  const m = members.find((u) => u.name.toLowerCase() === want || u.login.toLowerCase() === want);
  if (!m) throw new HttpError(400, `to must be a member of this scheme: ${members.map((u) => u.login).join(', ')}`);
  return m.name;
}

/** The calling turn's own token, for what it starts: a new one would cut the turn off its tools. */
const bearer = (req: Ctx['req']) => String(req.headers.authorization).replace(/^Bearer /, '');

/**
 * Hand a person's answer to a card back to the asking chat: it runs now, as a typed message does, whoever answers
 * and whether or not the card was addressed (`to`), so a cold asker wakes too (Cara, 2026-11-14: "normal cards in
 * your own minions should initiate a response from that minion"; #702 undid #687's held mail for answers).
 */
export function deliverAnswer(app: App, ticketId: number, author: string, text: string, extra: object, images: Awaited<ReturnType<typeof saveImages>> = [], files: Awaited<ReturnType<typeof messageFiles>> = []) {
  // A card's answer wakes a sealed minion too (#718): answering is as deliberate as Unseal.
  app.runner.send(ticketId, author, text, images, { ...extra, quick: true }, false, files);
}

/**
 * Unpark (#718; Cara, 2026-11-14: "there should be an "unpark" button ... The taskmaster should still be able to choose
 * to unpark them"). A minion chained on start_after starts now, its brief first; one in state parked has the state
 * cleared and, unless a message follows (`quiet`), starts a turn. What was held for it rides along either way.
 * `author` is whom the waking message comes from: the person who pressed Unseal, or the app for the Taskmaster.
 */
export async function unparkTicket(app: App, ticket: Ticket | TicketView, by: string, author: string, quiet = false): Promise<void> {
  if (ticket.kind === 'coordinator') throw new HttpError(400, `The ${AGENT_NAME} is never sealed`);
  if (ticket.status === 'closed') throw new HttpError(409, `#${ticket.number} is dismissed: reopen it instead`);
  // A brief expected over START_CARD_USD (#1674) starts on a person's OK: a person's Unseal (`author` is their name) is one and
  // settles its start card; the Taskmaster's or a minion's isn't.
  const hold = app.store.getSetting<{ usd: number; card: string }>(startHoldKey(ticket.id));
  if (hold) {
    if (author !== by) throw new HttpError(409, `#${ticket.number} waits for a person's start card (its brief expects about ${money(hold.usd)}): only a person's answer or Unseal starts it`);
    app.store.deleteSetting(startHoldKey(ticket.id));
    app.runner.settleCard(ticket.id, hold.card, by);
    // Not sealed since #1757 and not chained: this Unseal is its go.
    if (ticket.state !== 'parked' && !app.runner.heldFor(ticket.id)) {
      if (!quiet) app.runner.startHeld(ticket.id, author, "I OK'd your start.");
      await ownWrites();
      return;
    }
  }
  const who = unsealedBy(by, author);
  // A scheduled run or flaky-test fixer waiting for the box (#1302): Unseal is its "Start now", with no pressure check.
  if (app.held?.release(ticket.id, `${by} unsealed it`, who)) return;
  if (app.runner.heldFor(ticket.id)) {
    const chained = app.waiters.claim(ticket.id); // released by startChained as it sends the brief
    if (!chained) throw new HttpError(409, `#${ticket.number} is starting already`);
    await app.startChained(chained, `${by} unsealed it before its leader's work was in`);
    // Its brief is sent: what comes next goes to that turn, not held (the turn clears the state as it starts).
    if (!app.runner.heldFor(ticket.id) && app.store.getTicket(ticket.id)?.state === 'parked') app.store.updateTicket(ticket.id, { state: null }, who);
    await ownWrites();
    return;
  }
  if (!app.runner.unpark(ticket.id, by, author, quiet)) throw new HttpError(409, `#${ticket.number} isn't sealed`);
  // The message that wakes it, and the reply, re-read the state just cleared: a read waits only READ_WAIT_MS for the
  // write worker, so on a busy box they'd see it sealed still and hold the waking message (#1244, #1585).
  await ownWrites();
}

/** A person's picks for each question of a card: chosen option labels, plus optional free text. */
function cleanAnswers(questions: CardQuestion[], raw: unknown, pictured = false) {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new HttpError(400, 'Answer every question on the card (a question may have joined it since you opened it)');
  return questions.map((q, i) => {
    const a: { selected?: unknown; other?: unknown } = raw[i] ?? {};
    const selected = Array.isArray(a.selected) ? ([...new Set(a.selected.filter((l: unknown) => q.options.some((o) => o.label === l)))] as string[]) : [];
    const other = typeof a.other === 'string' ? a.other.trim().slice(0, 2000) : '';
    if (!q.multiSelect && selected.length > 1) throw new HttpError(400, `Pick one answer for question ${i + 1}`);
    // A picture sent with the answer counts for every question left blank (Cara, 2026-11-18).
    if (!selected.length && !other && !pictured) throw new HttpError(400, `Answer question ${i + 1}`);
    return other ? { selected, other } : { selected };
  });
}

/** "Opus 5.5" for "claude-opus-5-5"; a model with an advisor (#817) by the model table's own name for it. */
function modelName(id: string): string {
  const named = CLAUDE_MODELS.find(([m]) => m === id)?.[1];
  if (named) return named;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/**
 * A person wrote into a chat, which counts as continuing the loop guard there: for a minion's chat,
 * that minion; for the Taskmaster's, every minion of its scheme and its exchanges with other Taskmasters.
 */
export function personWrote({ app: { store, runner, presence }, caller, session, ticket }: Ctx) {
  if (caller) return;
  runner.personWrote(ticket.id);
  presence.wroteIn(ticket.id, session.name);
  // Writing in a minion's chat (or answering its card) touches it: its updates reach their Taskmaster too (#919).
  if (ticket.kind !== 'coordinator' && session.uid != null) store.touch(ticket.id, session.uid);
  // It keeps a worker they gave it (#1957).
  runner.startNow.touch(ticket.id, session.uid);
  const minions = ticket.kind === 'coordinator' ? store.listTickets(ticket.project_id) : [ticket];
  runner.continueLoops(
    minions.map((t) => t.id),
    session.name,
  );
}

/**
 * What an ultra review would review (#432): a minion's branch against the default branch, or an area of
 * the scheme's repo (`paths`), with how big its diff is. 400 with the reason when there's nothing to review.
 */
async function ultrareviewSpec(app: App, ticket: TicketView, mode: unknown, rawPaths: unknown): Promise<{ spec: ReviewSpec; size: { files: number; lines: number } }> {
  const repo = app.store.getProject(ticket.project_id)?.repo_dir;
  if (!repo) throw new HttpError(400, 'This scheme has no repo to review');
  const base = await defaultBranch(repo);
  let spec: ReviewSpec;
  if (mode === 'branch') {
    if (ticket.kind !== 'ticket' || !ticket.branch) throw new HttpError(400, 'Only a minion with a branch has a branch to review');
    spec = { mode, repo, base, branch: ticket.branch };
  } else if (mode === 'area') {
    try {
      spec = { mode, repo, base, paths: cleanPaths(rawPaths) };
    } catch (err) {
      throw new HttpError(400, thrown(err).message!);
    }
  } else throw new HttpError(400, 'mode must be branch or area');
  let size;
  try {
    size = await diffSize(spec);
  } catch (err) {
    throw new HttpError(
      400,
      String(thrown(err).stderr || thrown(err).message)
        .trim()
        .split('\n')[0],
    );
  }
  if (!size.files) throw new HttpError(400, spec.mode === 'branch' ? `Nothing to review: ${spec.branch} has no changes against ${base}` : 'Nothing to review: those paths hold no files');
  return { spec, size };
}

export const ticketRoutes: Route[] = [
  {
    // An ultra review's size, before the person confirms (#432). Person-only like starting one.
    method: 'GET',
    path: '/api/tickets/:ticket/ultrareview',
    who: ['person'],
    refuse: ULTRAREVIEW_REFUSE,
    async handler({ res, url, app, session, ticket }) {
      const paths = url.searchParams.getAll('path');
      const { spec, size } = await ultrareviewSpec(app, ticket, url.searchParams.get('mode'), paths);
      const linked = !!(session.uid && app.claude.place(session.uid));
      return json(res, 200, { mode: spec.mode, base: spec.base, ...(spec.mode === 'branch' ? { branch: spec.branch } : { paths: spec.paths }), size, limits: LIMITS, linked, running: !!session.uid && app.ultrareviews.busy(session.uid) });
    },
  },
  {
    // Start an ultra review on the clicker's own Claude login (#432). It spends a free run or usage credits,
    // so it is person-only: no minion, Taskmaster, schedule or contraption reaches this route, and the
    // body must carry the confirmation the button shows.
    method: 'POST',
    path: '/api/tickets/:ticket/ultrareview',
    who: ['person'],
    refuse: ULTRAREVIEW_REFUSE,
    async handler({ req, res, app, session, ticket }) {
      if (!session.uid) throw new HttpError(403, 'Sign in as yourself to run an ultra review: it runs on your own Claude login');
      const body = await readJson(req);
      if (body.confirm !== true) throw new HttpError(400, 'Confirm first: an ultra review uses one of your free runs, or costs about $5-25 in usage credits after');
      const { spec, size } = await ultrareviewSpec(app, ticket, body.mode, body.paths);
      const row = app.store.getTicket(ticket.id)!;
      try {
        const ev = await app.ultrareviews.start(ticket.id, session.uid, session.name, spec, size, app.sharedDir(row));
        return json(res, 202, ev);
      } catch (err) {
        throw new HttpError(409, thrown(err).message!);
      }
    },
  },
  {
    // A person's prepped ultra reviews in this chat (#1399): one draft PR per area, each waiting for its Start.
    method: 'GET',
    path: '/api/tickets/:ticket/ultrareview/batch',
    who: ['person', 'self'],
    refuse: ULTRAREVIEW_PREP_REFUSE,
    async handler({ res, app, session, caller, ticket }) {
      const uid = prepper(app, session, caller, ticket)?.uid;
      return json(res, 200, {
        rows: uid ? app.ultrareviews.rows(ticket.id, uid).map(rowView) : [],
        limits: LIMITS,
        linked: !!(uid && app.claude.place(uid)),
        github: !!(uid && hasGithub(app, uid)),
      });
    },
  },
  {
    // Prep a batch (#1399): each area is measured, one over the CLI's caps is refused with its size, and the rest each
    // get a draft PR as the asker's own GitHub login. Prepping costs nothing, so the chat's own minion may prep too, for
    // the person its turn runs for (Cara, 2026-11-20, "Yes, minions prep too"): the rows wait for that person's Start,
    // which stays person-only.
    method: 'POST',
    path: '/api/tickets/:ticket/ultrareview/batch',
    who: ['person', 'self'],
    refuse: ULTRAREVIEW_PREP_REFUSE,
    async handler({ req, res, app, session, caller, ticket }) {
      const who = prepper(app, session, caller, ticket);
      if (!who) throw new HttpError(403, caller ? 'No person to prep for: this chat has not run a turn for anyone yet, so nobody would get the Start' : 'Sign in as yourself to prep ultra reviews: their pull requests go out as your own GitHub login');
      if (caller && !hasGithub(app, who.uid)) throw new HttpError(409, `${who.name} has no GitHub login linked in Citadel, so there is nobody to open the draft PRs as. Ask them to link one in Settings; never borrow someone else's.`);
      const body = await readJson(req);
      if (!Array.isArray(body.areas) || !body.areas.length) throw new HttpError(400, 'areas must list at least one area');
      if (body.areas.length > BATCH_MAX) throw new HttpError(400, `At most ${BATCH_MAX} areas at once`);
      const repo = app.store.getProject(ticket.project_id)?.repo_dir;
      if (!repo) throw new HttpError(400, 'This scheme has no repo to review');
      const base = await defaultBranch(repo);
      const refused: { index: number; name: string; error: string; size?: { files: number; lines: number } }[] = [];
      for (const [index, a] of (body.areas as RawArea[]).entries()) {
        let name = '';
        try {
          const paths = cleanPaths(a?.paths);
          name = typeof a?.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : paths.join(', ').slice(0, 80);
          const question = typeof a?.question === 'string' && a.question.trim() ? a.question.trim().slice(0, 2000) : undefined;
          const size = await diffSize({ mode: 'area', repo, base, paths }).catch((err: unknown) => {
            throw new Error(
              String(thrown(err).stderr || thrown(err).message)
                .trim()
                .split('\n')[0],
            );
          });
          if (!size.files) throw new Error('Nothing to review: those paths hold no files');
          if (overLimit(size)) {
            refused.push({ index, name, size, error: `${size.lines.toLocaleString('en-US')} lines in ${size.files.toLocaleString('en-US')} files: over the CLI's limit of ${LIMITS.lines.toLocaleString('en-US')} lines and ${LIMITS.files} files. Split it.` });
            continue;
          }
          await app.ultrareviews.prep(ticket.id, who.uid, who.name, { repo, base, name, paths, question, size });
        } catch (err) {
          refused.push({ index, name, error: thrown(err).message! });
        }
      }
      return json(res, 200, { rows: app.ultrareviews.rows(ticket.id, who.uid).map(rowView), refused, for: who.name });
    },
  },
  {
    // Start one prepped review (#1399): billed to the clicker, so person-only and confirmed, like the single start.
    method: 'POST',
    path: '/api/tickets/:ticket/ultrareview/batch/:row/start',
    who: ['person'],
    refuse: ULTRAREVIEW_REFUSE,
    async handler({ req, res, app, session, ticket, params }) {
      if (!session.uid) throw new HttpError(403, 'Sign in as yourself to run an ultra review: it runs on your own Claude login');
      const body = await readJson(req);
      if (body.confirm !== true) throw new HttpError(400, 'Confirm first: an ultra review uses one of your free runs, or costs about $5-25 in usage credits after');
      const row = app.ultrareviews.rows(ticket.id, session.uid).find((x) => x.id === params.row);
      if (!row) throw new HttpError(404, 'No such prepped review in this chat');
      try {
        return json(res, 202, await app.ultrareviews.startRow(row.id, session.uid, session.name, app.sharedDir(app.store.getTicket(ticket.id)!)));
      } catch (err) {
        throw new HttpError(409, thrown(err).message!);
      }
    },
  },
  {
    // Discard a prepped review (#1399): its row goes now; its PR is closed and its branches deleted behind it.
    method: 'DELETE',
    path: '/api/tickets/:ticket/ultrareview/batch/:row',
    who: ['person'],
    refuse: ULTRAREVIEW_REFUSE,
    async handler({ res, app, session, ticket, params }) {
      if (!session.uid) throw new HttpError(403, 'Sign in as yourself');
      const row = app.ultrareviews.rows(ticket.id, session.uid).find((x) => x.id === params.row);
      try {
        if (row) app.ultrareviews.discard(row.id, session.uid);
      } catch (err) {
        throw new HttpError(409, thrown(err).message!);
      }
      return json(res, 200, { ok: true });
    },
  },
  {
    // Ask a minion on the side (#932): a read-only fork of its session answers in a side thread, on the asker's own
    // login (sender pays), so only a signed-in person reaches it. `thread` follows up the asker's own thread.
    method: 'POST',
    path: '/api/tickets/:ticket/side',
    who: ['person'],
    async handler({ req, res, app, session, ticket }) {
      if (!session.uid) throw new HttpError(403, 'Sign in as yourself to ask on the side: it runs on your own Claude login');
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'Side questions are for minions, not the Taskmaster');
      const body = await readJson(req);
      const text = str(body.text, 'text', SIDE_MAX_CHARS);
      const thread = body.thread === undefined || body.thread === null ? undefined : Number(body.thread);
      if (thread !== undefined && !Number.isSafeInteger(thread)) throw new HttpError(400, "thread must be a side thread's id");
      app.runner.startNow.touch(ticket.id, session.uid);
      try {
        return json(res, 202, await app.sideAsks.ask(ticket.id, session.uid, session.name, text, thread));
      } catch (err) {
        throw new HttpError(409, thrown(err).message!);
      }
    },
  },
  // The slash commands this chat's turns load, with a line on each (#937): the composer's menu and its check of what it sends.
  {
    method: 'GET',
    path: '/api/tickets/:ticket/commands',
    who: ['person'],
    async handler({ res, app, ticket }) {
      return json(res, 200, await chatCommands(app.store, ticket));
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket',
    who: ['person', 'taskmaster', 'minion'],
    everyScheme: true,
    async handler(ctx) {
      const { res, ticket, app } = ctx;
      const { store } = app;
      return json(res, 200, { ticket, picks: store.picksOf(ticket.id), project: store.getProject(ticket.project_id) });
    },
  },
  {
    // A waiting heavy run's newest output lines (#1681), for the readout under the wait; the page asks every few seconds.
    method: 'GET',
    path: '/api/tickets/:ticket/wait-tail',
    who: ['person', 'taskmaster', 'minion'],
    everyScheme: true,
    async handler({ res, ticket, app }) {
      return json(res, 200, { lines: (await app.waits?.tail(ticket.id, 20)) ?? [] });
    },
  },
  {
    method: 'PATCH',
    path: '/api/tickets/:ticket',
    who: ['person', 'taskmaster', 'minion'],
    async handler(ctx) {
      const { req, res, app, session, caller, ticket } = ctx;
      const closeCancelled = setLabels(app, ticket, await readJson(req), session.name, caller?.id ?? null);
      await ownWrites(); // the reply re-reads the row it just wrote (#1244)
      return json(res, 200, { ...ticketView(app, ticket.id), ...(closeCancelled && { close_cancelled: closeCancelled }) });
    },
  },
  {
    // People's own note (#146): one plain line, shown only to people, never in a ticket's JSON or its chat.
    method: 'PUT',
    path: '/api/tickets/:ticket/person-note',
    who: ['person'],
    refuse: 'Only people write person notes',
    async handler({ req, res, app, session, ticket }) {
      if (ticket.kind !== 'ticket') throw new HttpError(400, `The ${AGENT_NAME} has no person note`);
      const body = await readJson(req);
      if (typeof body.text !== 'string') throw new HttpError(400, 'Text is required');
      const text = body.text.replace(/\s+/g, ' ').trim();
      if (text.length > PERSON_NOTE_MAX) throw new HttpError(400, `A person note is at most ${PERSON_NOTE_MAX} characters`);
      const note = app.store.setPersonNote(ticket.id, text, session.name);
      app.broadcast({ type: 'person_note', projectId: ticket.project_id, ticketId: ticket.id, note });
      return json(res, 200, { note });
    },
  },
  {
    // A person's own pin (#179): the minion shows in a Pinned section atop their list, for them only.
    method: 'PUT',
    path: '/api/tickets/:ticket/pin',
    who: ['person'],
    refuse: 'Only people pin minions',
    async handler({ req, res, app, session, ticket }) {
      if (ticket.kind !== 'ticket') throw new HttpError(400, `The ${AGENT_NAME} can't be pinned`);
      const body = await readJson(req);
      if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'pinned must be true or false');
      app.store.setTicketPinned(session.name, ticket.id, body.pinned);
      // Every stream gets it; each tab keeps only its own person's pins.
      app.broadcast({ type: 'ticket_pin', name: session.name, projectId: ticket.project_id, ticketId: ticket.id, pinned: body.pinned });
      return json(res, 200, { pinned: body.pinned });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/seen',
    who: ['person'],
    refuse: 'Only people mark minions seen',
    async handler(ctx) {
      const { req, res, session, app, ticket } = ctx;
      const { id } = ticket;
      const { store } = app;
      // `left`: they've left it (navigated away, hid the tab). That records nothing new: a finished minion
      // they had open at its latest update closes (#811).
      const body = await readJson(req).catch((): JsonBody => ({}));
      if (body?.left === true) return json(res, 200, { seen_at: store.seenAt(session.name, id), closed: app.runner.closeIfSeen(id, session.name) });
      clearMentions(store, session.name, id);
      return json(res, 200, { seen_at: await store.markSeen(session.name, id) });
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/branch',
    who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, ticket } = ctx;
      const { id } = ticket;
      return json(res, 200, { status: await app.ticketBranch(id) });
    },
  },
  {
    // ship_risk (#1196): ships by risk per scheme and Pacific week. The Citadel scheme's minions and Taskmaster read every scheme (its process digest); another scheme's, its own.
    method: 'GET',
    path: '/api/tickets/:ticket/ship-risk',
    who: ['person', 'taskmaster', 'minion'],
    handler({ res, url, app, ticket }) {
      const weeks = Math.min(26, Math.max(1, Math.floor(Number(url.searchParams.get('weeks'))) || 4));
      const r = shipRisk(app.store, ticket.project_id === GLOBAL_OWNER ? null : [ticket.project_id], weeks);
      return json(res, 200, { ...r, text: shipRiskText(r) });
    },
  },
  {
    // live_facts (#1113): a minion's live facts in one read. A minion asks as itself, for a minion of its scheme by ?number=.
    method: 'GET',
    path: '/api/tickets/:ticket/facts',
    who: ['person', 'taskmaster', 'minion'],
    everyScheme: true,
    async handler({ res, url, app, caller, ticket }) {
      let id = ticket.id;
      if (caller && caller.kind !== 'coordinator' && url.searchParams.has('number')) {
        const n = Number(url.searchParams.get('number'));
        const target = Number.isInteger(n) && n > 0 ? app.store.getTicketByNumber(ticket.project_id, n) : undefined;
        if (!target || target.kind === 'coordinator') throw new HttpError(404, `There is no minion #${n} in this scheme`);
        id = target.id;
      }
      const facts = await liveFacts(app, id);
      return json(res, 200, { facts, text: factsText(facts) });
    },
  },
  {
    method: 'PUT',
    path: '/api/tickets/:ticket/uploads',
    who: ['person'],
    refuse: 'Only people attach files',
    async handler(ctx) {
      const { req, res, url, app, ticket } = ctx;
      // A file from the composer, streamed to disk as it arrives; the message that sends it names it.
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files must be under 200 MB');
      const saved = await saveUpload(fileUploadsDir(app, ticket), url.searchParams.get('name') ?? '', req);
      return json(res, 201, { name: saved.name, size: saved.size });
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/events',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler(ctx) {
      const { res, url, app, ticket } = ctx;
      const { id } = ticket;
      const { store } = app;
      // ?after=: everything since (catch-up). Else a page of whole turns before ?before= (history.ts).
      const num = (k: string) => Number(url.searchParams.get(k)) || undefined;
      if (url.searchParams.has('after')) return json(res, 200, store.listEvents(id, num('after')));
      return json(res, 200, historyPage(store, id, { before: num('before'), limit: num('limit'), from: num('from') }));
    },
  },
  {
    // One event whole: what an opened action row fetches when the page sent its input or result cut (public/eventcut.js).
    method: 'GET',
    path: '/api/tickets/:ticket/events/:event',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler({ res, app, ticket, params }) {
      const row = app.store.getEvent(Number(params.event));
      if (!row || row.ticket_id !== ticket.id) throw new HttpError(404, 'Not found');
      return json(res, 200, row);
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/messages',
    who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { req, res, app, session, caller } = ctx;
      const { runner } = app;
      // A person writes to their own Taskmaster (#919): one in another person's chat goes to theirs (R5, "Answer
      // cards only"), the first from a second member splits the scheme. The Overlord takes the words of anyone who has a
      // Taskmaster of their own (or no way to get one); a member without one gets theirs made first.
      const overlord = ctx.ticket.coordinator_of == null && app.store.isSplit(ctx.ticket.project_id);
      if (!caller && ctx.ticket.kind === 'coordinator' && !(overlord && app.store.coordinatorFor(ctx.ticket.project_id, session.uid!)?.coordinator_of === session.uid)) {
        const own = await ensureCoordinatorFor(app, app.store.getProject(ctx.ticket.project_id)!, session.uid);
        if (own.id !== ctx.ticket.id) ctx = { ...ctx, ticket: ticketView(app, own.id) };
      }
      const { ticket } = ctx;
      const { id } = ticket;
      // Room for MAX_IMAGES images at 5 MB each, base64-encoded.
      const body = await readJson(req, 45_000_000);
      const attached = (Array.isArray(body.images) && body.images.length > 0) || (Array.isArray(body.files) && body.files.length > 0);
      const text = attached && (typeof body.text !== 'string' || !body.text.trim()) ? '' : str(body.text, 'Message', 100_000);
      // A retry of a message already taken (its reply lost on the way) is answered, not sent again (send-ids.ts).
      const sendId = caller ? undefined : sendIdOf(body.sendId);
      let held: unknown;
      await sendOnce(id, sendId, async () => {
        const files = await messageFiles(app, ticket, body.files);
        // message_ticket with unseal (#718): the Taskmaster unseals it, and this message is what wakes it.
        // A person's "Send and unseal" does the same: held for nothing, the message is what wakes it.
        const unparks = body.unpark === true && runner.parked(ticket);
        if (unparks) await unparkTicket(app, ticket, session.name, caller ? APP_NAME : session.name, true); // quiet: author only tells a person from an agent
        // The Taskmaster's messages to a minion go through the loop guard; a person's never wait.
        if (caller && ticket.kind !== 'coordinator') {
          held = runner.relay(id, id, session.name, text, body.urgent === true || unparks, true, undefined, caller.id);
          // Its next message_coordinator answers this Taskmaster (#919), whose person now touches it.
          if (held !== true) {
            app.store.setSetting(replyToKey(id), caller.id);
            if (caller.coordinator_of != null) app.store.touch(id, caller.coordinator_of);
          }
          // The loop guard held the message meant to wake it: it stays sealed, so Unseal still shows.
          if (unparks && held === true && ticket.state === 'parked' && !runner.isRunning(id)) {
            app.store.updateTicket(id, { state: 'parked' });
            runner.emit(id, 'note', { text: 'The loop guard held the message that unsealed it, so it stays sealed.' });
            runner.broadcastTicket(id);
          }
          return;
        }
        // Mid-turn, a person's message steers the running turn unless they chose "Send after this turn".
        // Only here is a message a person's own typed words, the one kind that can be a go to merge (#201).
        // Its sendId goes on the message too, so the chat swaps in the server's copy for that exact message.
        // A sealed minion keeps it for its next turn (#718).
        // A person's @mentions (#1149) of members who can open this chat: a minion's, or the scheme's shared Taskmaster.
        const mentions = !caller && (ticket.kind !== 'coordinator' || ticket.coordinator_of == null) ? mentionedIn(text, app.store.listMembers(ticket.project_id), session.name) : [];
        const r = runner.send(id, session.name, text, await saveImages(app, ticket, body.images), { ...(caller ? {} : { typed: true }), ...(sendId ? { sendId } : {}), ...(mentions.length ? { mentions } : {}), hold: true }, !caller && body.after !== true, files);
        if (r.parked) held = 'parked';
        // The message just sent, as written: a re-read could miss it while the disk is slow.
        const sent = r.event;
        for (const name of mentions) {
          addMention(app.store, name, { ticketId: id, projectId: ticket.project_id, eventId: sent.id, at: sent.created_at, by: session.name, text });
          app.notify(id, { kind: 'mention', by: session.name, text, eventId: sent.id, to: name }, session.name);
        }
      });
      if (held !== undefined && held !== 'parked') return json(res, 202, { ...ticketView(app, id), held });
      personWrote(ctx);
      if (held === 'parked') return json(res, 202, { ...ticketView(app, id), held });
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/unqueue',
    who: ['person'],
    refuse: 'Only people can take back a queued message',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      const body = await readJson(req);
      if (!runner.unqueue(id, Number(body.id), session.name)) throw new HttpError(409, 'That message is no longer queued');
      return json(res, 200, ticketView(app, id));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/continue',
    who: ['person'],
    refuse: 'Only people continue a paused minion',
    async handler(ctx) {
      const { res, session, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // Continue button on a loop-guard pause: the minion's held messages go through.
      return json(res, 200, { released: runner.continueLoop(id, session.name) });
    },
  },
  {
    // Deliver now on the Held list (#1059): a ticket's held mail runs as a turn without waiting for the cold hold.
    method: 'POST',
    path: '/api/tickets/:ticket/deliver-mail',
    who: ['person'],
    refuse: 'Only people deliver held mail',
    async handler(ctx) {
      const { res, session, app, ticket } = ctx;
      if (app.runner.isRunning(ticket.id)) return json(res, 409, { error: 'It is running: its held mail reaches it with its next turn' });
      if (app.runner.startHold(ticket.id)) return json(res, 409, { error: 'It waits for a person to answer its start card: the answer starts it with its mail' });
      const project = app.store.getProject(ticket.project_id)!;
      return json(res, 200, { delivered: app.runner.releaseMail(ticket, project, session.name) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/comments',
    who: ['person'],
    refuse: 'Only people comment on files',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // A comment from a file's viewer: a chat message to the ticket that made the file, saying which file.
      const body = await readJson(req);
      if (typeof body.path !== 'string') throw new HttpError(404, 'That file is no longer there');
      const found = await resolveTicketFile(app, ticket, body.path);
      if (!found) throw new HttpError(404, 'That file is no longer there');
      const quote = typeof body.quote === 'string' ? body.quote.slice(0, 2000) : '';
      // Named as the ticket would write it: relative to its working directory, else in full.
      const path = found.abs.startsWith(ticket.cwd + sep) ? found.abs.slice(ticket.cwd.length + 1) : found.abs;
      const { about, text } = commentMessage(path, str(body.text, 'Comment', 10_000), quote);
      runner.send(id, session.name, text, [], { comment: { path: body.path, about }, hold: true });
      personWrote(ctx);
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/questions',
    who: ['self'],
    refuse: 'Only the minion itself can ask in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // Claude asks people multiple-choice questions; the card shows in the chat until someone answers.
      const body = await readJson(req);
      // Addressed to one person (#687): only their Needs-you list and devices get it. With no questions it's a notice, answered with Got it.
      const to = addressee(app, ticket, body.to);
      // A choices page (#804): the card opens it, its pick bars ask, and its Send settles the card.
      const doc = body.doc != null && body.questions == null ? await choicesDoc(app, ticket, body.doc) : null;
      const notice = to && body.questions == null && !doc && body.secret == null ? str(body.notice, 'Notice', 500) : null;
      // A secret card (#838): a masked field whose value goes to the secret store, never the chat.
      const secret = body.secret != null && body.questions == null && !doc && !notice ? secretAsk(body.secret) : null;
      const questions = notice || doc || secret ? [] : await cleanQuestions(app, ticket, body.questions);
      // A card asking for the go to ship says so, for the minions list's chip (#575). "ship" is the word people read
      // (Cara, 2026-11-19, picked "Ship" on #1020's card); it is stored as the older kind "merge", and "land" still counts.
      const kind = oneOf(body.kind ?? null, ['merge', 'ship', 'land'], 'kind') ? ('merge' as const) : null;
      // A feeder (a build whose branch exists, and not its owner) merges into the build: its go card says Merge, not Ship It.
      const proj = kind && ticket.build ? app.store.getProject(ticket.project_id) : null;
      const into = proj && ticket.kind !== 'coordinator' && (await buildBranchLater(proj.repo_dir, ticket.build)) && app.store.getSetting<number>(buildOwnerKey(proj.id, ticket.build!)) !== ticket.id ? ticket.build! : null;
      // A start (#2050) is a minion's plain card: a Taskmaster starts its own with create_ticket, and a ship card's pick is a go.
      if (questions.some((q) => q.options.some((o) => o.start)) && (kind || ticket.kind === 'coordinator' || body.for_everyone === true)) throw new HttpError(400, "start goes on a minion's own question card, not a ship card or a Taskmaster's (a Taskmaster starts minions with create_ticket)");
      const mergeable = questions.length > 0 && !kind && body.when_ci_passes !== true;
      const card: Card = { questions, ...(mergeable ? { mergeable: true as const } : {}), ...(kind ? { kind } : {}), ...(into ? { into } : {}), ...(to ? { to } : {}), ...(notice ? { notice } : {}), ...(doc ? { doc } : {}), ...(secret ? { secret } : {}) };
      // A card that repeats one open or just answered is refused once; not_duplicate posts it. Both are counted (settings
      // card_twin:refused and card_twin:override) so the false-alarm rate can be read.
      const checkTwin = () => {
        if (questions.length && !kind) {
          const bump = (k: string) => app.store.setSetting(`card_twin:${k}`, (app.store.getSetting<number>(`card_twin:${k}`) ?? 0) + 1);
          const twin = cardTwin(app.store, ticket, card);
          if (twin && body.not_duplicate !== true) {
            bump('refused');
            console.log(`card-twin: refused #${ticket.number ?? ticket.id}`);
            throw new HttpError(409, twin);
          }
          if (twin) {
            bump('override');
            console.log(`card-twin: override #${ticket.number ?? ticket.id}`);
          }
        }
      };
      // For everyone (#921): a person's Taskmaster asks a scheme-wide question in the Overlord's chat, where every member
      // sees it; its answer still comes back to the asker (Cara, 2026-11-17: "Asker acts on it").
      if (body.for_everyone === true) {
        if (ticket.kind !== 'coordinator' || !questions.length || to || body.when_ci_passes === true) throw new HttpError(400, "for_everyone is a Taskmaster's question card, with no to or when_ci_passes");
        checkTwin();
        const overlord = ticket.coordinator_of != null ? app.store.getOverlord(ticket.project_id) : undefined;
        if (overlord) {
          const forAll = { ...card, asker: ticket.id };
          return json(res, 201, mergeCard(app, overlord, ticket, forAll) ?? postCard(app, overlord, forAll));
        }
      }
      if (body.for_everyone !== true) checkTwin();
      // Held until CI passes on the pushed commit (#715): posted then with no turn, or now if it already passed.
      if (body.hand_off !== undefined) {
        if (!kind || !questions.length) throw new HttpError(400, 'hand_off goes with a question card of kind ship');
        card.handoff = await prepareHandoff(app, app.store.getTicket(ticket.id)!, body.hand_off, questions, bearer(req));
      }
      const armed = body.when_ci_passes === true ? await armForCi(app, ticket, { card }) : null;
      if (armed) return json(res, 202, { armed });
      return json(res, 201, mergeCard(app, ticket, ticket, card) ?? postCard(app, ticket, card));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/settle',
    who: ['self'],
    refuse: 'Only the minion itself can settle its question cards',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // settle_question: the minion judged that a typed reply answered its card (or a newer card replaced
      // it). The card stops waiting on people: out of the inbox, no longer holding a deploy's dismissal.
      // A plan-type card (propose_plan, edit_instructions' held edit) is withdrawn instead (#1488).
      const only = (await readJson(req)).questionId;
      const open = store.openCardsOf(id);
      // By the id its tool returned, its event id, or its link (`?e=<event id>`): the held edit's tool gave only a link.
      const want = only == null ? null : String(only).trim();
      const event = want === null ? null : /^\d+$/.test(want) ? Number(want) : Number(/[?&]e=(\d+)/.exec(want)?.[1] ?? NaN);
      // Without an id only question cards count: a plan waiting on a person is withdrawn only by its id.
      const pool = want === null ? open.filter((e) => e.kind !== 'plan') : open;
      const picked = want === null ? pool : open.filter((e) => e.id === event || JSON.parse(e.data).id === want);
      const list = (cards = open) => cards.map((e) => `${JSON.parse(e.data).id} (${e.kind === 'plan' ? 'plan' : 'question'} card "${cardLabel(e.kind, JSON.parse(e.data))}")`).join('; ');
      if (want !== null && !picked.length) throw new HttpError(404, `No open card with that id.${open.length ? ` Open: ${list()}` : ' None of yours is open.'}`);
      // Without an id it settles only a lone open card (#1488): settling every one at once took cards still waiting.
      if (want === null && picked.length > 1) throw new HttpError(409, `${picked.length} cards are open, so say which: pass question_id. Open: ${list(pool)}`);
      const busy = picked.find((e) => e.kind === 'plan' && deciding.has(e.id));
      if (busy) throw new HttpError(409, 'A person is answering that card right now');
      const at = Date.now();
      for (const e of picked) {
        const card = JSON.parse(e.data);
        if (e.kind === 'plan') {
          store.setEventData(e.id, { ...card, status: 'withdrawn', at });
          runner.emit(id, 'plan_result', { id: card.id, status: 'withdrawn', at });
        } else {
          store.setEventData(e.id, { ...card, settled: { at } });
          runner.emit(id, 'question_result', { id: card.id, settled: { at } });
        }
      }
      if (picked.length) runner.broadcastTicket(id);
      return json(res, 200, { settled: picked.map((e) => JSON.parse(e.data).id) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/dismiss',
    who: ['person'],
    refuse: 'Only people dismiss cards',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // A person dismisses an open question or plan card that is no longer relevant (Cara, 2026-11-22: "there should be a way
      // to dismiss a card that is no longer relevant"). Whoever may answer it may dismiss it ('person' is the rule /answer uses).
      const want = String((await readJson(req)).cardId ?? '');
      const event = store.openCardsOf(id).find((e) => JSON.parse(e.data).id === want);
      if (!event) {
        // Told how it ended, so two people racing read why theirs didn't count.
        const done = store
          .eventsOfKinds(id, ['question', 'plan'])
          .map((e) => JSON.parse(e.data))
          .find((d) => d.id === want);
        if (!done) throw new HttpError(404, 'No such card');
        const by = done.settled?.by ?? done.by;
        throw new HttpError(409, done.settled?.dismissed || done.status === 'dismissed' ? `${by} dismissed this card` : `This card was already ${done.status ?? (by ? 'handled by ' + by : 'answered or settled')}`);
      }
      const card = JSON.parse(event.data);
      // Ship and merge go cards keep their own buttons; a job's go, a notice's Got it and a memory tidy have their own way out.
      if (card.kind || card.job || card.kitSync || card.notice || card.memory) throw new HttpError(409, 'This card is answered with its own buttons, not dismissed');
      if (deciding.has(event.id)) throw new HttpError(409, 'A person is answering that card right now');
      const result = { at: Date.now(), by: session.name };
      if (event.kind === 'plan') {
        store.setEventData(event.id, { ...card, status: 'dismissed', ...result });
        runner.emit(id, 'plan_result', { id: card.id, status: 'dismissed', ...result });
      } else {
        store.setEventData(event.id, { ...card, settled: { ...result, dismissed: true } });
        runner.emit(id, 'question_result', { id: card.id, settled: { ...result, dismissed: true } });
      }
      // The minion hears it as it hears an answer (a Taskmaster's card for everyone: its asker), so one waiting only on this card moves on.
      const asker = card.asker != null ? store.getTicket(card.asker) : undefined;
      const to = asker && asker.status !== 'closed' ? asker.id : id;
      deliverAnswer(app, to, session.name, `${session.name} dismissed your card "${cardLabel(event.kind, card)}" as no longer relevant. Nothing was answered and this is not a go.`, {});
      runner.broadcastTicket(id);
      personWrote(ctx);
      return json(res, 200, ticketView(app, id));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/strike',
    who: ['self'],
    refuse: 'Only a thread itself can strike its words',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // strike_text: a minion or Taskmaster proven wrong strikes through its own words.
      const body = await readJson(req);
      const text = str(body.text, 'Text', 10_000);
      const reason = str(body.reason, 'Reason', 1000);
      try {
        // It rewrites the message's whole data: a strike still queued (two sent at once) would be written over.
        return json(res, 200, await afterAllWrites(() => runner.strike(id, text, reason)));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(/already/.test(thrown(err).message!) ? 409 : 404, thrown(err).message!);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/answer',
    who: ['person'],
    refuse: 'Only people answer question cards',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // Room for pasted screenshots, as /messages has (the card's box takes images too).
      const body = await readJson(req, 45_000_000);
      const card = store.eventsOfKinds(id, ['question']).find((e) => JSON.parse(e.data).id === body.questionId);
      if (!card) throw new HttpError(404, 'No such question');
      // Its answer can only come after it: the chat's earlier messages are never read.
      if (store.eventsOfKinds(id, ['user_message'], card.id).some((e) => JSON.parse(e.data).answer?.questionId === body.questionId)) {
        throw new HttpError(409, 'That question has already been answered');
      }
      const data = JSON.parse(card.data);
      if (data.settled) throw new HttpError(409, data.settled.dismissed ? `${data.settled.by} dismissed this card` : data.settled.by ? `${data.settled.by} already marked this seen` : 'Claude took this as answered in the chat');
      if (data.doc) throw new HttpError(409, 'This card is answered on its page: open it and press Send there');
      if (data.secret) throw new HttpError(409, 'This card takes a secret: type it into its field and press Save');
      // A notice (#687): Got it takes it out of the addressee's list, and sends the asker nothing.
      if (data.notice) {
        runner.startNow.touch(id, session.uid);
        const settled = { at: Date.now(), by: session.name };
        store.setEventData(card.id, { ...data, settled });
        runner.emit(id, 'question_result', { id: data.id, settled });
        runner.broadcastTicket(id);
        return json(res, 202, ticketView(app, id));
      }
      if (deciding.has(card.id)) throw new HttpError(409, 'Someone is answering that card right now');
      const { questions } = data;
      runner.startNow.touch(id, session.uid);
      const answers = cleanAnswers(questions, body.answers, (Array.isArray(body.images) && body.images.length > 0) || (Array.isArray(body.files) && body.files.length > 0));
      // A machine job's go card (#857): only the machine's owner or an admin answers it, and their pick is the job's go.
      // The minion that asked hears it held, with no turn: it is woken when the job ends or is refused.
      if (data.job) {
        const choice = MachineJobs.choiceOf(answers[0]?.selected[0] ?? '');
        if (!choice) throw new HttpError(400, "Pick one of the card's options");
        app.jobs.decide(data.job, choice, { uid: session.uid ?? -1, name: session.name, admin: !!session.admin }, true);
        runner.send(id, session.name, `My answer to job #${data.job}'s go card: ${answers[0].selected[0]}`, [], { answer: { questionId: body.questionId, answers }, hold: true });
        runner.broadcastTicket(id);
        return json(res, 202, ticketView(app, id));
      }
      // A kit sync's ship card (#1100): the server ships or drops the syncs itself, pushed as whoever answered, with no
      // turn. The answer is held mail for the Taskmaster, as a machine job's is.
      if (data.kitSync) {
        const choice = answers[0]?.selected[0];
        if (choice !== KIT_SHIP && choice !== KIT_NOT_NOW) throw new HttpError(400, "Pick one of the card's options");
        let line: string;
        try {
          line = await app.kitSync.decide({ ticket: id, question: data.id }, choice, { id: session.uid ?? -1, name: session.name });
        } catch (err) {
          throw new HttpError(409, thrown(err).message!);
        }
        runner.send(id, session.name, `My answer to the kit sync card: ${choice}`, [], { answer: { questionId: body.questionId, answers }, hold: true });
        runner.emit(id, 'note', { text: line });
        runner.broadcastTicket(id);
        return json(res, 202, ticketView(app, id));
      }
      // A start card (#1674): the server acts on it with no turn of its own. Start releases the held brief (a chained one
      // still waits for its leader); Split first dismisses it unrun and asks its Taskmaster to split the brief.
      if (data.startCost) {
        const pick = answers[0]?.selected[0];
        if (pick !== START && pick !== SPLIT) throw new HttpError(400, "Pick one of the card's options");
        if (ticket.status === 'closed') throw new HttpError(409, `#${ticket.number} is dismissed: reopen it instead`);
        store.deleteSetting(startHoldKey(id));
        const added = answers[0].other ? ` They added: ${answers[0].other}` : '';
        runner.recordAnswer(id, session.name, `My answer to your start card: ${pick}.${added}`, { answer: { questionId: body.questionId, answers } });
        if (pick === START) {
          if (runner.heldFor(id)) runner.emit(id, 'note', { text: `${session.name} OK'd its start; it starts once its leader's work is in.` });
          else if (store.getTicket(id)?.state === 'parked') runner.unpark(id, session.name, session.name);
          else runner.startHeld(id, session.name, `I picked ${START} on your start card: go ahead.`);
        } else {
          await runner.close(id, `${session.name} picked ${SPLIT} on its start card, so it was dismissed before it ran.`);
          await tellTaskmaster(
            app,
            ticket,
            `${session.name} picked "${SPLIT}" on the start card of #${ticket.number} ${ticket.title} (expected ${money(data.startCost)}): it was dismissed without running.${added} Split its brief (and the handoff it names) into minions expected at ${money(splitCeiling(data.startCost))} or less each, with an "Expected cost" line in each, and start those.`,
            false,
            true,
            'ask',
          );
        }
        await ownWrites();
        return json(res, 202, ticketView(app, id));
      }
      // A budget card's Stop (#1672): stopped as the stop button does. The answer is only recorded (it settles the card):
      // sent, it would start the very turn Stop is for.
      if (data.budget && answers[0]?.selected[0] === CARD_STOP) {
        await stopMinion(app, ticket, session.name);
        runner.recordAnswer(id, session.name, `My answer to your budget card: ${CARD_STOP}. I stopped your turn.`, { answer: { questionId: body.questionId, answers } });
        return json(res, 202, ticketView(app, id));
      }
      // A pick on the card of a turn that waits for its computer (Build 7 T4): recorded, as the turn it is about is the one that waits. Words or files added to it go in as a message too.
      const added = !!answers[0]?.other || (Array.isArray(body.images) && body.images.length > 0) || (Array.isArray(body.files) && body.files.length > 0);
      if (data.runsOn && runner.runsOn.answer(id, answers[0]?.selected[0]) && !added) {
        runner.recordAnswer(id, session.name, `My answer to your Runs on card: ${answers[0].selected[0]}.`, { answer: { questionId: body.questionId, answers } });
        return json(res, 202, ticketView(app, id));
      }
      const text = questions
        .map((q: CardQuestion, i: number) => {
          const { selected, other } = answers[i];
          // The text typed with a pick expands on it; typed alone, it is the answer.
          const picked = !selected.length && !other ? '(no option picked; see the attachment)' : selected.length ? `${selected.join('; ')}${other ? `\n  Added: ${other}` : ''}` : `In their own words: ${other}`;
          return `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}\n→ ${picked}`;
        })
        .join('\n\n')
        .concat(data.cabalForm && [FORM_GO, 'Start the cabal'].includes(String(answers[0]?.selected[0])) ? `\n\n${approveRoster(app, data.cabalForm, session)}` : ''); // (the old label too, on cards asked before #2270) a Plot's forming card (#2091): its go approves the rows it showed, and the lead reads which
      const answer = { answer: { questionId: body.questionId, answers } };
      const asker = data.asker != null ? store.getTicket(data.asker) : undefined;
      // Held from here, before the first wait: a second answer while this one saves its pictures or a ship is checked is refused.
      deciding.add(card.id);
      try {
        // Pictures and files pasted into the card's box ride in the answer message, as in the composer.
        const files = await messageFiles(app, ticket, body.files);
        // A Taskmaster's card for everyone (#921): kept where the card is, acted on by the Taskmaster that asked.
        if (asker && asker.status !== 'closed') {
          // Saved in both chats: the card's chat shows them on the settled card, the asker's turn reads its own copy.
          const kept = await saveImages(app, ticket, body.images);
          runner.recordAnswer(id, session.name, `My answers to the question card:\n\n${text}`, { ...answer, ...(kept.length ? { images: kept.map((i) => i.name) } : {}) });
          deliverAnswer(app, asker.id, session.name, `My answers to your question card ${asker.project_id !== ticket.project_id ? `in ${store.getProject(ticket.project_id)?.name}'s ${AGENT_NAME} chat` : "for everyone (in the Overlord's chat)"}:\n\n${text}`, {}, await saveImages(app, asker, body.images), files);
        } else {
          // Ship It on a card with its hand-off prepared ships now, with no turn (#1930); else the minion gets the answer, with why.
          const mine = `My answers to your question card:\n\n${text}`;
          const images = await saveImages(app, ticket, body.images);
          // A pick of an option carrying a start (#2050) starts that minion with no turn; held mail for the owner when that was all.
          const starts = (questions as CardQuestion[]).some((q) => q.options.some((o) => o.start)) ? await startPicked(app, store.getTicket(id)!, questions, answers, session, images.length + files.length > 0 || answers.some((a) => a.other)) : null;
          if (starts?.held) {
            runner.recordAnswer(id, session.name, mine, answer, { by: APP_NAME, text: `${mine}\n\n${starts.text}` });
            // Nothing left for people after it (#2175): dismissed now, not hours later by a Taskmaster.
            const left = await leftForPeople(app, id);
            if (!left) await runner.close(id, `Every pick on its card started, so the server dismissed this minion: ${starts.started.join('; ')}.`);
            else runner.emit(id, 'note', { text: `Every pick on its card started; this minion stays open because ${left}.` });
          } else if (starts) deliverAnswer(app, id, session.name, `${mine}\n\n${starts.text}`, answer, images, files);
          const why = starts
            ? null
            : await shipOnClick(
                app,
                store.getTicket(id)!,
                { event: card.id, data },
                {
                  by: session.name,
                  uid: session.uid ?? null,
                  picked: answers.flatMap((a) => a.selected),
                  added: images.length + files.length > 0 || answers.some((a) => a.other),
                  record: (held) => runner.recordAnswer(id, session.name, mine, answer, { by: APP_NAME, text: held }),
                },
              );
          if (why !== null) deliverAnswer(app, id, session.name, `${mine}${why ? `\n\n(${APP_NAME} didn't ship it by itself: ${why}.)` : ''}`, answer, images, files);
        }
      } finally {
        deciding.delete(card.id);
      }
      runner.echoOverlordAnswer(ticket, session.name, text, asker && asker.status !== 'closed' ? asker.id : id, session.uid);
      personWrote(ctx);
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/secret',
    who: ['person'],
    refuse: 'Only people save secrets',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner, secrets } = app;
      // A secret card's Save (#838): the value goes to the store, and the minion hears only the name it was saved as.
      const body = await readJson(req);
      const card = store.eventsOfKinds(id, ['question']).find((e) => JSON.parse(e.data).id === body.questionId);
      const data = card ? JSON.parse(card.data) : null;
      if (!data?.secret) throw new HttpError(404, 'No such secret card');
      if (data.settled) throw new HttpError(409, data.settled.saved ? `Already saved as ${data.settled.saved}` : 'This card was settled in the chat');
      const value = secretValue(body.value);
      const { name, scope } = data.secret as SecretAsk;
      if (scope === 'person' && !session.uid) throw new HttpError(403, 'Sign in as yourself to save your own secret');
      const owner = scope === 'scheme' ? ticket.project_id : session.uid!;
      secrets.put(scope, owner, name, value, session.uid ?? null);
      const settled = { at: Date.now(), by: session.name, saved: name, scope };
      store.setEventData(card!.id, { ...data, settled });
      runner.emit(id, 'question_result', { id: data.id, settled });
      const whose = scope === 'scheme' ? 'for this scheme: every turn in it gets' : `as my own: turns that run as me (${session.name}) get`;
      deliverAnswer(app, id, session.name, `I typed the secret into your card. It's saved as \`${name}\` ${whose} it in the env var $${SECRET_ENV_PREFIX}${name}, from the next turn on. Its value isn't in this chat: use the variable, and never print it.`, { answer: { questionId: data.id, secret: name } });
      personWrote(ctx);
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'PUT',
    path: '/api/tickets/:ticket/properties',
    who: ['person', 'taskmaster', 'minion'],
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // On the minion itself, or with `file` on one of the files it showed people (an artifact).
      const body = await readJson(req);
      if (body.file != null) {
        const file = str(body.file, 'file', 4096);
        const a = store.findArtifact(id, [isAbsolute(file) ? file : join(ticket.cwd, file), join(app.sharedDir(ticket), file)]);
        if (!a) throw new HttpError(404, `#${ticket.number} has shown no file ${file}; link it in a reply first`);
        return json(res, 200, store.props.set('artifact', a.id, a.project_id, body.properties, session.name));
      }
      const owner = () => String(store.props.forTarget('minion', id).assigned ?? '');
      const before = owner();
      const r = store.props.set('minion', id, ticket.project_id, body.properties, session.name);
      // A handover (#690) is said in the minion's chat and the Taskmaster's: "Josh took over #612".
      const after = owner();
      if (after !== before && ticket.kind === 'ticket') {
        const agent = session.agent != null ? store.getTicket(session.agent) : null;
        const by = !agent ? session.name : agent.kind === 'coordinator' ? 'The Taskmaster' : `#${agent.number}`;
        const text = !agent && after.toLowerCase() === by.toLowerCase() ? `${by} took over #${ticket.number}` : after ? `${by} handed #${ticket.number} to ${after}` : `${by} unassigned #${ticket.number}`;
        runner.emit(id, 'note', { text });
        // The old owner stays touched, so its updates still reach their Taskmaster (#919).
        const was = store.findUser('name', store.props.personName(before) || '')?.id;
        if (was != null) store.touch(id, was);
        if (!store.isSplit(ticket.project_id)) {
          const coordinator = store.getCoordinator(ticket.project_id);
          if (coordinator) runner.emit(coordinator.id, 'note', { text });
        } else {
          // Split: both owners' Taskmasters hear it as held mail.
          const tms = new Set([was ?? null, store.minionOwner(ticket)].map((uid) => store.coordinatorFor(ticket.project_id, uid)?.id));
          for (const tm of tms) if (tm != null) runner.leaveMail(tm, by, text);
          store.noteDigest(ticket.project_id, agent?.kind === 'coordinator' ? agent.id : 0, text);
        }
      }
      runner.broadcastTicket(id);
      return json(res, 200, r);
    },
  },
  {
    // Leave a minion (#919): its updates stop reaching your Taskmaster until you write in it again. The menu item is #920's.
    method: 'POST',
    path: '/api/tickets/:ticket/leave',
    who: ['person'],
    refuse: 'Only a person can leave a minion',
    async handler({ res, app, session, ticket }) {
      if (ticket.kind === 'coordinator') throw new HttpError(400, `Only a minion can be left, not a ${AGENT_NAME}`);
      app.store.leaveTouched(ticket.id, session.uid!);
      return json(res, 200, { left: ticket.id });
    },
  },
  {
    // Sleep or wake a minion (#1636): { asleep: boolean }. Out of Needs you and keepalives until this, or any turn, wakes it.
    method: 'POST',
    path: '/api/tickets/:ticket/sleep',
    who: ['person'],
    refuse: 'Only a person can put a minion to sleep',
    async handler({ req, res, app, session, ticket }) {
      if (ticket.kind === 'coordinator') throw new HttpError(400, `Only a minion can sleep, not a ${AGENT_NAME}`);
      if (ticket.status === 'closed') throw new HttpError(409, 'This minion is dismissed');
      const body = await readJson(req);
      if (typeof body.asleep !== 'boolean') throw new HttpError(400, 'asleep must be true or false');
      app.runner.sleep(ticket.id, session.name, body.asleep);
      return json(res, 200, { asleep: body.asleep });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/stop',
    who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, ticket, session } = ctx;
      return json(res, 200, await stopMinion(app, ticket, session?.agent !== undefined ? 'the Taskmaster' : (session?.name ?? 'a member')));
    },
  },
  // "Is this still going?" on a quiet turn's chip (#906): a look at its process, no message and no model call.
  {
    method: 'POST',
    path: '/api/tickets/:ticket/check',
    who: ['person'],
    async handler(ctx) {
      const { res, app, ticket } = ctx;
      const check = await app.runner.checkTurn(ticket.id);
      return check ? json(res, 200, check) : json(res, 409, { error: 'No turn is running.' });
    },
  },
  // A spend alert card's Stop and Keep going (#723): each names its turn's start, so a card left over from an earlier
  // turn can't stop or mute a later one.
  {
    method: 'POST',
    path: '/api/tickets/:ticket/spend-stop',
    who: ['person'],
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const turn = Number((await readJson(req))?.turn);
      const stopped = app.runner.turnStartedAt(ticket.id) === turn && app.runner.stop(ticket.id);
      if (stopped) app.machines.minionStopped(ticket.id);
      return json(res, 200, { stopped });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/spend-mute',
    who: ['person'],
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      return json(res, 200, { muted: app.runner.muteSpend(ticket.id, session.name, Number((await readJson(req))?.turn)) });
    },
  },
  // A Taskmaster's fresh session (#406): a person asks for one (the chat's button), or the Taskmaster's turn hands off (fresh_session).
  {
    method: 'POST',
    path: '/api/tickets/:ticket/fresh-session',
    who: ['person', 'self'],
    async handler(ctx) {
      const { req, res, app, session, caller, ticket } = ctx;
      const body = await readJson(req);
      const why = caller ? app.runner.recordHandoff(ticket.id, str(body.summary, 'Summary', 20_000)) : app.runner.requestFresh(ticket.id, `${session.name} asked for it`);
      if (why) throw new HttpError(409, why);
      return json(res, 202, ticketView(app, ticket.id));
    },
  },
  // Unseal (#718): the chat header's button and update_ticket's state change; for a chained minion, as Start now.
  {
    method: 'POST',
    path: '/api/tickets/:ticket/unpark',
    who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, session, caller, ticket } = ctx;
      await unparkTicket(app, ticket, session.name, caller ? APP_NAME : session.name);
      return json(res, 200, ticketView(app, ticket.id));
    },
  },
  // Start now (#261): a minion sealed on start_after starts before its leader's work is in, its held brief first.
  {
    method: 'POST',
    path: '/api/tickets/:ticket/start',
    who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, session, ticket } = ctx;
      if (ticket.kind === 'coordinator') throw new HttpError(400, "The Taskmaster never waits on another minion's work");
      const chained = app.waiters.claim(ticket.id); // released by startChained as it sends the brief
      if (!chained) throw new HttpError(409, `#${ticket.number} isn't sealed waiting on another minion's work`);
      await app.startChained(chained, `${session.name} started it before its leader's work was in`);
      return json(res, 200, ticketView(app, ticket.id));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/status',
    who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      const body = await readJson(req);
      if (body.status !== 'closed' && body.status !== 'idle') throw new HttpError(400, 'Status must be closed or idle');
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'The Taskmaster cannot be dismissed');
      if (runner.isRunning(id)) throw new HttpError(409, 'Stop the minion before dismissing it');
      // Why it closed, in one word (#1989; Josh, 2026-11-25, "Save one word"): an agent says it, a person's one click doesn't.
      const as = body.status === 'closed' && body.as != null ? { closedAs: body.as } : null;
      if (as) store.props.check(ticket.project_id, as);
      const into = movedInto(app, ticket, body);
      // Already as asked: a second dismissal, or a reopen of a minion that isn't dismissed, changes nothing.
      if ((body.status === 'closed') === (ticket.status === 'closed')) {
        if (as) store.props.set('minion', id, ticket.project_id, as, session.name);
        // A word said again about a closed minion replaces where its ask went.
        const joined = as && ticket.status === 'closed' ? moveEffort(store, ticket, into) : null;
        if (as) runner.broadcastTicket(id);
        if (joined) runner.broadcastTicket(into!.id);
        return json(res, 200, { ...ticketView(app, id), ...(joined ? { joined } : {}) });
      }
      let joined: string | null = null;
      if (body.status === 'closed') {
        // Before the close, which hands the effort over.
        joined = moveEffort(store, ticket, into);
        const closed = runner.close(id, `${session.name} dismissed this minion.`);
        if (as) store.props.set('minion', id, ticket.project_id, as, session.name);
        if (as) runner.broadcastTicket(id);
        await closed;
        if (joined) runner.broadcastTicket(into!.id);
      } else {
        store.updateTicket(id, { status: body.status });
        await ownWrites(); // the broadcast, the worktree check and the reply read it back (#1244)
        runner.emit(id, 'note', { text: `${session.name} reopened this minion.` });
        runner.broadcastTicket(id);
        // Its worktree back now if the sweep removed it (#660), behind any dismissal cleanup on its lane.
        void runner.reopened(id);
        void app.outbox?.poke({ type: 'reopened', ticket: id }); // its held deliveries (wake_at, ADR 0021) go now
      }
      await ownWrites();
      return json(res, 200, { ...ticketView(app, id), ...(joined ? { joined } : {}) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/coordinator',
    who: ['minion'],
    refuse: 'Only a minion can message its Taskmaster',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // A thread asks its project's coordinator for something only the coordinator can do (message_coordinator).
      const body = await readJson(req);
      const text = str(body.text, 'Message', 10_000);
      const checked = checkNeed(body);
      if ('error' in checked) throw new HttpError(400, checked.error);
      const { need } = checked;
      // A fyi is always held mail (#851), whatever wake says.
      const wake = body.wake !== false && need !== 'fyi';
      const armed = body.when_ci_passes === true ? await armForCi(app, ticket, { coordinator: { text, urgent: body.urgent === true, need, ...(wake ? {} : { wake: false }) } }) : null;
      if (armed) return json(res, 202, { sent: false, armed });
      const held = await tellTaskmaster(app, ticket, text, body.urgent === true, wake, need);
      if (held === true) return json(res, 202, { sent: false, held: true });
      return json(res, 202, { sent: true, ...(held === 'mail' ? { mail: true } : {}) });
    },
  },
  {
    // message_minion (#783): one minion messages another in its own scheme, with the Taskmaster's wake rules
    // (runner.relayMinion) and one loop guard per pair. It never reopens a dismissed one, and the Taskmaster
    // gets a one-line copy as held mail, which wakes nothing.
    method: 'POST',
    path: '/api/tickets/:ticket/minion-message',
    who: ['minion'],
    refuse: 'Only a minion messages another minion this way',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { store, runner } = app;
      const body = await readJson(req);
      const text = str(body.text, 'Message', 10_000);
      const to = Number(body.to);
      if (!Number.isInteger(to) || to <= 0) throw new HttpError(400, 'to must be a minion number');
      // By number in the sender's own scheme: no minion of another scheme can be named.
      const target = store.getTicketByNumber(ticket.project_id, to);
      if (!target || target.kind === 'coordinator') throw new HttpError(404, `There is no minion #${to} in this scheme. Another scheme's minions are reached through the Taskmaster (message_coordinator).`);
      if (target.id === ticket.id) throw new HttpError(400, 'That is you');
      if (target.status === 'closed') throw new HttpError(409, `#${to} is dismissed, and a message from a minion never reopens one. Ask the Taskmaster (message_coordinator) to reopen it or to pass this on.`);
      const author = `#${ticket.number} ${ticket.title}`;
      // unpark (Cara, 2026-11-16: "minions that are waiting on other minions should be woken without taskmaster involvement"):
      // the same unpark as the Taskmaster's, and this message is what wakes it. Not a chain a person put on hold.
      const unparks = body.unpark === true && runner.parked(target);
      if (unparks) {
        if (app.waiters.chains().some((c) => c.ticket === target.id && c.held)) throw new HttpError(409, `#${to} is on hold: only a person's Unseal or the Taskmaster starts it. Ask the Taskmaster (message_coordinator).`);
        await unparkTicket(app, target, `#${ticket.number}`, author, true);
      }
      const held = runner.relayMinion(ticket.id, target.id, author, text, body.urgent === true || unparks, body.wake !== false || unparks, unparks);
      if (unparks && held === true && target.state === 'parked' && !runner.isRunning(target.id)) {
        store.updateTicket(target.id, { state: 'parked' });
        runner.emit(target.id, 'note', { text: 'The loop guard held the message that unsealed it, so it stays sealed.' });
        runner.broadcastTicket(target.id);
      }
      if (held !== true) {
        const how = held === 'parked' ? 'Left for' : held ? 'Left held mail for' : unparks ? 'Unsealed and sent to' : 'Sent';
        runner.emit(ticket.id, 'note', { text: `${how} #${target.number} ${target.title}: ${text}` });
      }
      return json(res, 202, { held, number: target.number, title: target.title, state: target.state });
    },
  },
  {
    // read_minion (#783): another minion's line, worktree and recent chat, for its scheme's minions. Only
    // the chat's words: no cards, tool calls, approvals, attachments or costs.
    method: 'GET',
    path: '/api/tickets/:ticket/peer',
    who: ['minion'],
    refuse: 'Only a minion reads another this way',
    handler({ res, url, app, ticket }) {
      const { store, runner } = app;
      const n = Number(url.searchParams.get('number'));
      const last = Math.min(Math.max(Number(url.searchParams.get('last')) || 10, 1), 50);
      const target = Number.isInteger(n) && n > 0 ? store.getTicketByNumber(ticket.project_id, n) : undefined;
      if (!target || target.kind === 'coordinator') throw new HttpError(404, `There is no minion #${n} in this scheme`);
      const v = runner.view(target);
      // Its spend against its budget too (#1114), which list_tickets' lines leave out.
      const line = { ...Object.fromEntries(LINE_FIELDS.map((k) => [k, v[k]])), cost: v.cost, budget: v.budget, ...(target.cwd ? { worktree: target.cwd } : {}) };
      const events = store.listEvents(target.id).flatMap((e) => {
        const d = JSON.parse(e.data);
        const keep =
          e.kind === 'user_message'
            ? { author: d.author, text: d.text ?? '', ...(d.comment ? { comment: { about: d.comment.about } } : {}) }
            : e.kind === 'note' || e.kind === 'error'
              ? { text: d.text ?? '' }
              : e.kind === 'claude' && d.type === 'assistant' && !d.replaced && (d.message?.content ?? []).some((b: ContentBlock) => b.type === 'text' && b.text!.trim())
                ? { type: 'assistant', message: { content: d.message.content.filter((b: ContentBlock) => b.type === 'text') }, ...(d.parent_tool_use_id ? { parent_tool_use_id: d.parent_tool_use_id } : {}) }
                : e.kind === 'claude' && d.type === 'result'
                  ? { type: 'result', is_error: !!d.is_error }
                  : null;
        return keep ? [{ kind: e.kind, data: JSON.stringify(keep) }] : [];
      });
      return json(res, 200, { ticket: line, events: events.slice(-last), skipped: Math.max(events.length - last, 0) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/deploy',
    who: ['minion'],
    refuse: 'Only the deploying minion can report its deploy',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { store, runner, waiters } = app;
      // tools/deploy.sh, run for this minion, reports how its queued restart went. A failure shows as
      // an error and pushes, so a deploy that rolled back or gave up is never silent. A warning (live,
      // but the push to GitHub failed) is just as loud, yet still counts as live.
      const body = await readJson(req);
      const text = str(body.text, 'Report', 4000);
      const failed = body.ok === false;
      const loud = failed || body.warn === true;
      (loud ? console.error : console.log)(`Deploy report for minion ${id}: ${text}`);
      const event = runner.emit(id, loud ? 'error' : 'note', { text });
      if (loud) app.notify(id, { kind: 'error', text, eventId: event.id });
      app.urgentFixes?.deployReported(APP_NAME, id, !failed, text);
      if (failed) store.setSetting(DEPLOY_FAILURE, { text, head: waiters.head });
      // A failed deploy leaves the minion in pending-deploy, so the error stays in view.
      const dismissed = !failed && runner.deployLive(id);
      return json(res, 201, { dismissed });
    },
  },
  {
    // The host_check tool (#621): the host's read-only checks (masked database, a user unit's journal and status) for a turn in a container.
    method: 'POST',
    path: '/api/host-check',
    who: ['minion', 'taskmaster'],
    refuse: 'Only a turn can run host checks',
    async handler({ req, res, app, caller }) {
      const body = await readJson(req);
      // The database holds every scheme's chat, so only a turn whose person sees every scheme reads it (db.ts canSee).
      // A judge replay reads it too (#2074), and runs in the caller's worktree with the environment a land gets.
      const reads = body?.what === 'db' || body?.what === 'judge_replay';
      const refused = reads ? adminAskRefusal(app.store, caller!.id) : null;
      if (refused) throw new HttpError(403, refused);
      const { systemctl, journalctl } = app.services.opts;
      const own = body?.what === 'judge_replay' && caller!.kind === 'ticket' && caller!.cwd ? caller! : null;
      const worktree = own ? { cwd: own.cwd!, env: app.runner.hostEnv(own, bearer(req)) } : null;
      // A slow judge's replay outlasts the MCP server's fetch unless the answer beats (#2100).
      return slowJson(
        res,
        hostCheck({ db: join(app.dataDir, 'coordinator.db'), systemctl, journalctl, worktree }, body).then((output) => ({ output })),
      );
    },
  },
  {
    // The land tool (src/land.ts): run tools/land.sh in this minion's worktree on the host, for a turn in a container.
    method: 'POST',
    path: '/api/tickets/:ticket/land',
    who: ['minion'],
    refuse: 'Only the minion itself can ship its branch',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // { fix: true }: LAND_FIX=1, for the fix of a commit whose deploy was rolled back (tools/land.sh's bad_check). No body from older tools.
      const body = (req.headers['content-type'] ?? '').startsWith('application/json') ? await readJson(req) : {};
      if (ticket.kind !== 'ticket' || !ticket.cwd) throw new HttpError(403, 'Only a minion with a worktree lands with tools/land.sh');
      // Any scheme's: a container turn that ran land.sh itself couldn't see the host's landings in line (#574).
      if (!existsSync(join(ticket.cwd, 'tools', 'land.sh'))) throw new HttpError(404, 'This worktree has no tools/land.sh: land the way the scheme instructions say');
      // Only a minion's own bearer token gets here (who: minion).
      const token = bearer(req);
      const env = app.runner.hostEnv(ticket, token);
      if (body?.fix === true) env.LAND_FIX = '1';
      if (body?.outage === true) env.LAND_URGENT = '1'; // { outage: true }: its restart skips deploy.sh's starved-box hold (#1417)
      // { into, files, full, build }: land.sh's build-branch forms (#597), checked to the shapes it accepts.
      let args: string[];
      try {
        args = landArgs(body ?? {}, ticket.cwd);
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      const unjudged = await criticRefusal(app.store.reviews, ticket, args, body?.fix === true);
      if (unjudged) throw new HttpError(400, unjudged);
      const unread = reviewRefusal(app.store, ticket, args);
      if (unread) throw new HttpError(400, unread);
      return json(res, 202, await app.landings.start(ticket.id, ticket.cwd, env, args));
    },
  },
  {
    // generate_image, edit_image, generate_audio and generate_speech (#717, #808): the server calls OpenRouter on the key of the person this
    // turn runs for (ticket.person_id), booked against their monthly cap; the turn never sees the key.
    method: 'POST',
    path: '/api/tickets/:ticket/openrouter',
    who: ['minion'],
    refuse: 'Only the minion itself can make media in its folders',
    async handler({ req, res, app, ticket }) {
      const body = (await readJson(req)) ?? {};
      if (ticket.kind !== 'ticket' || !ticket.cwd) throw new HttpError(403, 'Only a minion with a worktree makes media');
      const tool = oneOf(body.tool, MEDIA_TOOLS, 'tool') as MediaTool | null;
      if (!tool) throw new HttpError(400, `tool must be one of: ${MEDIA_TOOLS.join(', ')}`);
      const args = isRecord(body.args) ? body.args : {};
      // provider "azure" (#842): any minion of the scheme spends the scheme's own key, with no per-person cap (the scheme's outside-spend cap only warns): raw SSML to Azure Speech on the scheme's own key, booked to the scheme as outside spend (#839), not OpenRouter.
      if (tool === 'generate_speech' && args.provider === 'azure') {
        return json(
          res,
          200,
          await azureSpeech(
            args,
            { roots: ticketRoots(app, ticket) },
            {
              secret: (name) => app.secrets.get('scheme', ticket.project_id, name),
              book: (s) => app.outsideSpend.record(ticket.project_id, s, `minion:#${ticket.number}`),
            },
          ),
        );
      }
      if (args.provider !== undefined && args.provider !== 'openrouter') throw new HttpError(400, "provider is 'openrouter' (the default) or 'azure'");
      return json(res, 200, await app.openrouter.tool(tool, args, { userId: ticket.person_id, ticketId: ticket.id, projectId: ticket.project_id, roots: ticketRoots(app, ticket) }));
    },
  },
  {
    // report_spend (#839): a minion books what an outside API call cost to its scheme's month.
    method: 'POST',
    path: '/api/tickets/:ticket/spend',
    who: ['minion'],
    refuse: 'Only the minion itself can report its spend',
    async handler({ req, res, app, ticket }) {
      return json(res, 200, app.outsideSpend.record(ticket.project_id, parseSpend(await readJson(req)), `minion:#${ticket.number}`));
    },
  },
  {
    // log_learned (#1119): a pull-request ship's three lines; hand_off_land takes them as learned instead.
    method: 'POST',
    path: '/api/tickets/:ticket/learned',
    who: ['minion'],
    refuse: 'Only the minion itself logs what it learned',
    async handler({ req, res, app, ticket }) {
      const body = (await readJson(req)) ?? {};
      const lines = parseLearned(body.learned);
      if (lines === null) throw new HttpError(400, 'learned is text: up to three lines, or "nothing"');
      const files = ticket.cwd ? await touchedFiles(ticket.cwd) : [];
      const row = queueLesson(app.store, app.dataDir, ticket, lines, files, 'tool', (text) => void tellTaskmaster(app, ticket, text, false, true, 'fyi', true).catch((e) => console.error(`Ship lessons repeat alert failed: ${e?.message ?? e}`)));
      return json(res, 200, { id: row.id, lines: row.lines, files: row.files.length });
    },
  },
  {
    // hand_off_land (#706): the server runs tools/land.sh and reports it (LandHandoffs in src/land.ts), so the minion ends its turn now.
    method: 'POST',
    path: '/api/tickets/:ticket/land/handoff',
    who: ['minion'],
    refuse: 'Only the minion itself can ship its branch',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const body = (await readJson(req)) ?? {};
      const mine = app.store.getTicket(ticket.id)!;
      const ready = await checkHandoff(app, mine, body, bearer(req));
      // `when` arms it on its flake proof or on something going live (#2089); a pipeline change waits for the pipeline lane,
      // armed (#2046): the server ships it when the lane is its own, or it may ship beside the holder.
      const armed = (await triggerHandoff(app, mine, body)) ?? (await laneHandoff(app, mine, body));
      if (armed) return json(res, 202, { ok: true, armed });
      if (!(await startHandoff(app, mine, ready, { kind: 'minion' }))) throw new HttpError(409, 'A landing already runs for this minion: wait for its report');
      return json(res, 202, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/land',
    who: ['minion'],
    refuse: 'Only the minion itself can ship its branch',
    handler: async ({ res, app, ticket }) => {
      const run = await app.landings.look(ticket.id);
      if (!run) throw new HttpError(404, 'Nothing has started shipping for this minion');
      return json(res, 200, run);
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/preview',
    who: ['person', 'taskmaster', 'minion'],
    async handler(ctx) {
      const { res, url, app, ticket } = ctx;
      const { id } = ticket;
      const { store } = app;
      // start_preview: (re)start this minion's preview from its worktree as it is now.
      if (!app.previews) throw new HttpError(403, 'A preview has no previews of its own');
      await app.previews.start(ticket);
      return json(res, 200, { url: `${publicOrigin(ctx.req, app.preview)}/${previewPath(id)}` });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/wake',
    who: ['person', 'taskmaster', 'minion'],
    async handler(ctx) {
      const { req, res, ticket, app } = ctx;
      const { id } = ticket;
      const { store, waiters } = app;
      // wake_when_live: the minion itself, or its Taskmaster for it, waits for a commit (or the next
      // deploy) to be live.
      if (ticket.kind === 'coordinator') throw new HttpError(403, 'Only minions wait on deploys');
      const body = await readJson(req);
      const reason = str(body.reason, 'Reason', 1000);
      let commit: string | null = null;
      const elsewhere = await waiters.elsewhere(id);
      if (body.commit == null || body.commit === '') {
        if (elsewhere) throw new HttpError(400, "This scheme has no deploys; give the commit you're waiting on");
      } else {
        // Elsewhere, only the scheme's own commits can ever be on its main.
        commit = await waiters.resolve(String(body.commit), store.getProject(ticket.project_id)?.repo_dir ?? null, !!elsewhere);
        if (!commit) throw new HttpError(400, `No commit ${String(body.commit).slice(0, 40)} in ${elsewhere ? '' : 'the live checkout or '}the scheme's repo`);
      }
      const waiting = await waiters.add(id, commit, reason);
      app.runner.broadcastTicket(id); // a sealed row moves to Waiting (#718)
      return json(res, 201, { waiting, commit, head: waiters.head, merged: !!elsewhere });
    },
  },
  {
    // relay_when_live: a note for another scheme's Taskmaster or a minion of this scheme, sent as held mail once a commit is live.
    // The minion's own Taskmaster sees the full text now (held mail, no wake), so it can notice if something is off.
    method: 'POST',
    path: '/api/tickets/:ticket/relay-when-live',
    who: ['minion'],
    refuse: 'Only a minion queues a relay',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { store, runner, waiters } = app;
      const body = await readJson(req);
      const mine = () => waiters.relays(ticket.id).map((r) => ({ id: r.id, to: 'scheme' in r.to ? r.to.scheme : `#${r.to.number}`, commit: r.commit, text: r.text }));
      if (body.cancel != null) {
        const r = waiters.cancelRelay(ticket.id, Number(body.cancel));
        if (!r) throw new HttpError(404, `No pending relay ${Number(body.cancel)} of yours`);
        const taskmaster = store.ownerCoordinator(ticket);
        if (taskmaster) runner.leaveMail(taskmaster.id, `#${ticket.number} ${ticket.title}`, `(for your tracking; nothing to do) #${ticket.number} cancelled its relay to ${'scheme' in r.to ? r.to.scheme : `#${r.to.number}`}.`);
        return json(res, 200, { cancelled: r.id, relays: mine() });
      }
      if (body.to == null) return json(res, 200, { relays: mine() });
      const text = str(body.text, 'Text', 10_000);
      const targets = [...new Set((Array.isArray(body.to) ? body.to : [body.to]).map((t: unknown) => String(t).trim()).filter(Boolean))] as string[];
      if (!targets.length) throw new HttpError(400, 'Say who it is for in `to`');
      if (targets.length > 20) throw new HttpError(400, 'At most 20 recipients in one call');
      const tos: Relay['to'][] = [];
      for (const target of targets) {
        if (/^#?\d+$/.test(target)) {
          const n = Number(target.replace('#', ''));
          const m = store.getTicketByNumber(ticket.project_id, n);
          if (!m || m.kind === 'coordinator') throw new HttpError(404, `There is no minion #${n} in this scheme`);
          if (m.id === ticket.id) throw new HttpError(400, 'That is you');
          tos.push({ minion: m.id, number: m.number! });
        } else {
          const { project } = schemeTarget(app, ticket, target);
          tos.push({ scheme: project.name, taskmaster: (await ensureCoordinatorFor(app, project, null)).id }); // not for a member: the Overlord (#919)
        }
      }
      const commit = body.commit == null || body.commit === '' ? (ticket.cwd ? await gitOut(['rev-parse', 'HEAD'], ticket.cwd) : null) : await waiters.resolve(String(body.commit), store.getProject(ticket.project_id)?.repo_dir ?? null, !!(await waiters.elsewhere(ticket.id)));
      if (!commit) throw new HttpError(400, body.commit ? `No commit ${String(body.commit).slice(0, 40)} in the live checkout or the scheme's repo` : 'No commit to wait for: commit the work first, or give a commit');
      const added = [];
      for (const to of tos) added.push({ to, ...(await waiters.addRelay({ ticket: ticket.id, to, text, commit })) });
      const taskmaster = store.ownerCoordinator(ticket);
      const queuedRs = added.filter((a) => a.queued).map((a) => a.relay);
      const sentRs = added.filter((a) => !a.queued).map((a) => a.relay);
      const dest = relayDests(added.map((a) => a.relay));
      // One note for the whole call, naming every recipient (#1001).
      if (queuedRs.length && taskmaster) runner.leaveMail(taskmaster.id, `#${ticket.number} ${ticket.title}`, `(for your tracking; nothing to do) #${ticket.number} will send this to ${relayDests(queuedRs)} once ${commit.slice(0, 7)} is live: ${text}`);
      if (sentRs.length) waiters.sent(sentRs);
      const short = text.length > 200 ? text.slice(0, 200) + '…' : text;
      if (queuedRs.length) runner.emit(ticket.id, 'note', { text: `Relay to ${relayDests(queuedRs)} queued until ${commit.slice(0, 7)} is live: ${short}` });
      if (sentRs.length) runner.emit(ticket.id, 'note', { text: `Relay to ${relayDests(sentRs)} sent: ${commit.slice(0, 7)} was live already: ${short}` });
      const queued = queuedRs.length > 0;
      const relay = queuedRs[0] ?? added[0].relay;
      return json(res, 201, { queued, id: relay.id, ids: queuedRs.map((r) => r.id), commit, to: dest, relays: mine() });
    },
  },
  {
    // wake_at (#722): the minion or Taskmaster itself sets, lists or cancels timed wakes in its own chat.
    method: 'POST',
    path: '/api/tickets/:ticket/wake-at',
    who: ['self'],
    refuse: 'Only the minion or Taskmaster itself can set a wake in its chat',
    async handler(ctx) {
      const { req, res, ticket, app, session } = ctx;
      const { timedWakes: wakes, runner } = app;
      const body = await readJson(req);
      const view = (list = wakes.list(ticket.id)) => list.map((w) => ({ id: w.id, at: w.at, when: pacificTime(w.at), note: w.note }));
      if (body.cancel != null) {
        const w = wakes.list(ticket.id).find((o) => o.id === Number(body.cancel));
        if (!w || !wakes.cancel(ticket.id, w.id)) throw new HttpError(404, `No pending wake ${Number(body.cancel)} in this chat`);
        runner.emit(ticket.id, 'note', { text: `Wake cancelled: ${pacificTime(w.at)}: ${w.note}` });
        return json(res, 200, { cancelled: w.id, wakes: view() });
      }
      if (body.at == null) return json(res, 200, { wakes: view() });
      const note = str(body.note, 'Note', 1000);
      let w;
      try {
        w = wakes.add(ticket.id, parseWakeTime(String(body.at)), note, session.name);
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      // The row people see until it fires; the wake itself arrives as a message.
      runner.emit(ticket.id, 'note', { text: `Wake set for ${pacificTime(w.at)}: ${note}` });
      return json(res, 200, { set: view([w])[0], wakes: view() });
    },
  },
  {
    // The list chip's Cancel (ADR 0021 step 7): a person drops one of the outbox's waiting rows for this minion.
    method: 'POST',
    path: '/api/tickets/:ticket/waits/:wait/cancel',
    who: ['person'],
    refuse: 'Only people cancel a wait from the list',
    async handler({ res, app, ticket, params, session }) {
      const row = app.store.getDelivery(Number(params.wait));
      if (!row || row.to_kind !== 'minion' || row.to_id !== ticket.id) throw new HttpError(404, 'No such wait on this minion');
      // A chain's row is its held brief: dropping it would leave the minion sealed with nothing to start it.
      if (row.kind === 'chain') throw new HttpError(409, "That wait is this minion's brief: Start now starts it, or dismiss the minion");
      if (!app.outbox?.cancel(row.id, `cancelled by ${session.name}`)) throw new HttpError(409, 'It already went out or was cancelled');
      app.runner.broadcastTicket(ticket.id);
      return json(res, 200, { cancelled: row.id });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/wake-runners',
    who: ['minion'],
    async handler(ctx) {
      const { req, res, ticket, app } = ctx;
      // wake_when_runners_back (#541): a landing sealed because CI gave no verdict waits for the scheme's runners.
      const project = app.store.getProject(ticket.project_id);
      if (!repoSlug(project?.repo_url ?? null)) throw new HttpError(400, "This scheme's repo isn't on GitHub, so it has no runners to watch");
      const label = runnerLabel(project!.name);
      if (!label) throw new HttpError(409, `${project!.name}'s name has no letters a-z or digits to make a runner label from, so no runner can match`);
      const body = await readJson(req);
      addRunnerWaiter(app.store, ticket.id, str(body.reason, 'Reason', 1000), app.outbox);
      app.runner.broadcastTicket(ticket.id); // a sealed row moves to Waiting (#718)
      return json(res, 201, { label, labels: schemeLabels(project!.name) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/close',
    who: ['minion'],
    refuse: 'A minion may only be dismissed by itself',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // A thread closes itself once its current turn ends (close_self); the token decides which thread.
      const body = await readJson(req);
      const reason = typeof body.reason === 'string' && body.reason.trim() ? str(body.reason.trim(), 'Reason', 500) : null;
      // A state ready is cleared rather than refused (#480): a finished minion sets it by habit before close_self.
      const kept = runner.keptOpen(id, true);
      if (kept) throw new HttpError(409, `Not dismissed: ${kept}. Leave the minion open for them; if nothing is left for people (the card was answered in the chat, or there is nothing to try), settle the card or clear the state first. If it stays open, say why in your reply`);
      const cleared = app.store.getTicket(id)!.state === 'ready';
      // Checked before the close, written after it: a refused one leaves no word.
      if (body.as != null) app.store.props.check(ticket.project_id, { closedAs: body.as });
      const into = movedInto(app, ticket, body);
      if (!runner.closeAfterTurn(id, reason)) throw new HttpError(409, 'The minion is not mid-turn');
      if (body.as != null) app.store.props.set('minion', id, ticket.project_id, { closedAs: body.as }, session.name);
      const joined = moveEffort(app.store, ticket, into);
      return json(res, 202, { ...ticketView(app, id), cleared, ...(joined ? { joined } : {}) });
    },
  },
];
