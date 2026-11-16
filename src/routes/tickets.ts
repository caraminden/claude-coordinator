// One minion's (or Taskmaster's) chat and state: what people, its Taskmaster and the minion itself
// may do to it. Who may call each route is its `who` (src/http.ts).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { cleanPluginPicks, lines, mcpMerge, mergeTarget, plainMerge } from '../approvals.ts';
import { adminAskRefusal, lendsMachine, managesMachine } from '../access.ts';
import { APP_NAME } from '../appname.ts';
import { AGENT_NAME } from '../auth.ts';
import { commentMessage, optionImageProblem } from '../artifacts.ts';
import { cardHref } from '../card-links.ts';
import { armForCi, postCard, tellTaskmaster } from '../ci-armed.ts';
import { addRunnerWaiter } from '../ci-health.ts';
import { runnerLabel } from '../ci-runner.ts';
import { EFFORTS, MODELS, PERSON_NOTE_MAX, TICKET_STATES, type Ticket, type TicketState } from '../db.ts';
import { originRepo } from '../github.ts';
import { historyPage } from '../history.ts';
import { lineDiff } from '../instructions.ts';
import { hostCheck } from '../host-check.ts';
import { landArgs, landConflict, type Handoff } from '../land.ts';
import { parseMerge, prInfo } from '../merge-card.ts';
import { MEDIA_TOOLS, type MediaTool } from '../openrouter.ts';
import { previewPath } from '../previews.ts';
import { repoSlug } from '../prlinks.ts';
import { NOTIFY_STATES } from '../push.ts';
import { tripwireConfig } from '../turn-launch.ts';
import { tmpDirFor } from '../turn-tmp.ts';
import { claudeConfigDir } from '../sessions.ts';
import { MAX_UPLOAD_BYTES, saveUpload } from '../uploads.ts';
import { cleanPaths, defaultBranch, diffSize, LIMITS, type ReviewSpec } from '../ultrareview.ts';
import { sendIdOf, sendOnce } from '../send-ids.ts';
import { buildNumber, HttpError, json, oneOf, readJson, replyList, str, ticketView, workflowSwitch, type App, type Ctx, type Route, type TicketView } from '../http.ts';
import { fileUploadsDir, messageFiles, resolveTicketFile, saveImages, ticketRoots } from './files.ts';
import { machineNotes, patchMachine } from './machines.ts';
import { LINE_FIELDS } from './projects.ts';
import { pacificTime, parseWakeTime } from '../wake.ts';

/** A minion's plugin picks (#361) as stored, from its scheme's optional folders; a Taskmaster loads none. */
/**
 * Set a minion's label fields from a PATCH body or a reply's status trailer (#711): any of title, state, note, replies,
 * build, model, effort, workflow and plugin_dirs, with their checks (a bad one throws HttpError). `name` is who set
 * them and `caller` the agent's ticket, if an agent did. Returns why a pending close_self was cancelled, if it was.
 */
export function setLabels(app: App, ticket: Ticket, body: any, name: string, caller: number | null): string | null {
  const { id } = ticket;
  const { store, runner } = app;
  // Any of title, state, note, replies, build, model, effort, workflow and plugin_dirs; null (or "") clears all but the title.
  const fields: Partial<Pick<Ticket, 'title' | 'state' | 'note' | 'replies' | 'build' | 'model' | 'effort' | 'workflow' | 'plugin_dirs'>> = {};
  if (body.model !== undefined) fields.model = oneOf(body.model, MODELS, 'Model');
  if (body.workflow !== undefined) fields.workflow = workflowSwitch(body.workflow, ticket);
  if (body.plugin_dirs !== undefined) fields.plugin_dirs = pluginPicks(store, ticket, body.plugin_dirs);
  if (body.effort !== undefined) fields.effort = oneOf(body.effort, EFFORTS, 'Effort');
  if (body.title !== undefined) fields.title = str(body.title, 'Title', 120);
  if (body.state !== undefined) fields.state = oneOf(body.state, TICKET_STATES, 'State') as TicketState | null;
  if (body.note !== undefined) fields.note = body.note ? str(body.note, 'Note', 60) : null;
  if (body.build !== undefined) fields.build = buildNumber(body.build);
  if (body.replies !== undefined) fields.replies = replyList(body.replies);
  // Complete always says what's left (#547; Josh, 2026-11-11): its note comes with it, and stays while it holds.
  const clearsNote = ticket.state === 'complete' && body.state === undefined && body.note !== undefined;
  if ((body.state === 'complete' || clearsNote) && !fields.note) {
    throw new HttpError(400, 'State complete needs a note in the same call saying what is left: "nothing left", or what people should read now ("read: the PR #12 report"), at most 60 characters. Link the files themselves in your reply');
  }
  // The view's replies are a list; compare the stored JSON.
  const stored = store.getTicket(id)!;
  for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === stored[k]) delete fields[k];
  // Clearing a parked minion's state unparks it (#718): update_ticket's way for the Taskmaster. Not the minion's own.
  const unparks = 'state' in fields && fields.state === null && caller !== id && runner.parked(stored);
  if (unparks) delete fields.state;
  let closeCancelled: string | null = null;
  if (Object.keys(fields).length) {
    store.updateTicket(id, fields);
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
    // A result or a blocker is worth a ping; whoever set it by hand already knows.
    if (fields.state && NOTIFY_STATES[fields.state]) {
      const after = store.getTicket(id)!;
      app.notify(id, { kind: 'state', state: after.state, note: after.note }, caller ? null : name);
    }
  }
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
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
}

const ULTRAREVIEW_REFUSE = 'Only a person can start an ultra review: it is billed to their own Claude account';

// How long one wait for an approval card's outcome holds the request open.
const APPROVAL_POLL_MS = 25_000;

/** The setting holding the last deploy report that failed (server.ts shows it in the ship line). */
export const DEPLOY_FAILURE = 'deploy-failure';

// A label Claude ended with "(Recommended)" (or "(rec.)") itself; the card adds those words to the flagged option.
const SAYS_RECOMMENDED = /\s*\((recommended|rec\.?)\)\s*$/i;
// A description that opens with "Recommended." flags its option when none is flagged (#481); the words go, the card shows them.
const DESCRIBED_RECOMMENDED = /^\s*recommended(?:\s*[.:;,!\u2013\u2014-]+\s*|\s*$)/i;

/**
 * A question card from Claude: 1 to 4 questions, each with 2 to 6 options, one of them recommended
 * (any number on a pick-any question), so people always see what Claude would pick. An option's
 * image must be a picture or video the ticket may show, so a card can't reach files outside its folders.
 */
async function cleanQuestions(app: App, ticket: Ticket, raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new HttpError(400, 'questions must be a list of 1 to 4 questions');
  const questions = raw.map((q: any, i: number) => {
    const n = `Question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new HttpError(400, `${n} must be an object`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw new HttpError(400, `${n} needs 2 to 6 options`);
    const flagged = q.options.some((o: any) => o?.recommended === true || o?.recommended === 'true');
    const options = q.options.map((o: any, j: number) => {
      const says = typeof o?.label === 'string' && SAYS_RECOMMENDED.test(o.label);
      const described = !flagged && typeof o?.description === 'string' && DESCRIBED_RECOMMENDED.test(o.description);
      const description = described ? o.description.replace(DESCRIBED_RECOMMENDED, '') : o?.description;
      return {
        label: str(says ? o.label.replace(SAYS_RECOMMENDED, '') : o?.label, `${n} option ${j + 1} label`, 80),
        ...(description ? { description: str(description, `${n} option ${j + 1} description`, 300) } : {}),
        ...(o?.image ? { image: str(o.image, `${n} option ${j + 1} image`, 1000) } : {}),
        ...(o?.recommended === true || o?.recommended === 'true' || says || described ? { recommended: true } : {}),
      };
    });
    if (new Set(options.map((o: any) => o.label)).size !== options.length) throw new HttpError(400, `${n} has duplicate option labels`);
    const recommended = options.filter((o: any) => o.recommended).length;
    if (!recommended) throw new HttpError(400, `${n} needs a recommended option: set "recommended": true on the one you would pick`);
    if (recommended > 1 && q.multiSelect !== true) throw new HttpError(400, `${n} recommends ${recommended} options; mark just one`);
    return {
      question: str(q.question, n, 500),
      ...(q.header ? { header: str(q.header, `${n} header`, 24) } : {}),
      multiSelect: q.multiSelect === true,
      options,
    };
  });
  for (const [i, q] of questions.entries()) {
    for (const [j, o] of q.options.entries()) {
      const problem = o.image && await optionImageProblem(o.image, ticket.cwd, ticketRoots(app, ticket));
      if (problem) throw new HttpError(400, `Question ${i + 1} option ${j + 1} image ${problem}`);
    }
  }
  return questions;
}

/**
 * A direct card's addressee (#687): `to` names one member of the asking scheme, by name or login, and comes back
 * as their name (what the chat, the inbox and push go by); null for a card to everyone. Only the asking scheme's
 * members: a card never reaches anyone a message in its chat couldn't.
 */
function addressee(app: App, ticket: Ticket, raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const want = String(raw).trim().replace(/^@/, '').toLowerCase();
  const members = app.store.listMembers(ticket.project_id);
  const m = members.find((u) => u.name.toLowerCase() === want || u.login.toLowerCase() === want);
  if (!m) throw new HttpError(400, `to must be a member of this scheme: ${members.map((u) => u.login).join(', ')}`);
  return m.name;
}

/**
 * Hand a person's answer to a card back to the asking chat: it runs now, as a typed message does, whoever answers
 * and whether or not the card was addressed (`to`), so a cold asker wakes too (Cara, 2026-11-14: "normal cards in
 * your own minions should initiate a response from that minion"; #702 undid #687's held mail for answers).
 */
function deliverAnswer(app: App, ticketId: number, author: string, text: string, extra: object) {
  // A card's answer wakes a parked minion too (#718): answering is as deliberate as Unpark.
  app.runner.send(ticketId, author, text, [], extra);
}

/**
 * Unpark (#718; Cara, 2026-11-14: "there should be an "unpark" button ... The taskmaster should still be able to choose
 * to unpark them"). A minion chained on start_after starts now, its brief first; one in state parked has the state
 * cleared and, unless a message follows (`quiet`), starts a turn. What was held for it rides along either way.
 * `author` is whom the waking message comes from: the person who pressed Unpark, or the app for the Taskmaster.
 */
export async function unparkTicket(app: App, ticket: Ticket, by: string, author: string, quiet = false): Promise<void> {
  if (ticket.kind === 'coordinator') throw new HttpError(400, `The ${AGENT_NAME} is never parked`);
  if (ticket.status === 'closed') throw new HttpError(409, `#${ticket.number} is dismissed: reopen it instead`);
  if (app.runner.heldFor(ticket.id)) {
    const chained = app.waiters.claim(ticket.id); // released by startChained as it sends the brief
    if (!chained) throw new HttpError(409, `#${ticket.number} is starting already`);
    await app.startChained(chained, `${by} unparked it before its leader's work was in`);
    // Its brief is sent: what comes next goes to that turn, not held (the turn clears the state as it starts).
    if (!app.runner.heldFor(ticket.id) && app.store.getTicket(ticket.id)?.state === 'parked') app.store.updateTicket(ticket.id, { state: null });
    return;
  }
  if (!app.runner.unpark(ticket.id, by, author, quiet)) throw new HttpError(409, `#${ticket.number} isn't parked`);
}

/** A person's picks for each question of a card: chosen option labels, plus optional free text. */
function cleanAnswers(questions: any[], raw: unknown) {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new HttpError(400, 'Answer every question on the card');
  return questions.map((q, i) => {
    const a: any = raw[i] ?? {};
    const selected = Array.isArray(a.selected) ? [...new Set(a.selected.filter((l: unknown) => q.options.some((o: any) => o.label === l)))] as string[] : [];
    const other = typeof a.other === 'string' ? a.other.trim().slice(0, 2000) : '';
    if (!q.multiSelect && selected.length > 1) throw new HttpError(400, `Pick one answer for question ${i + 1}`);
    if (!selected.length && !other) throw new HttpError(400, `Answer question ${i + 1}`);
    return other ? { selected, other } : { selected };
  });
}

/** "Opus 5.5" for "claude-opus-5-5". */
function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/**
 * A person wrote into a chat, which counts as continuing the loop guard there: for a minion's chat,
 * that minion; for the Taskmaster's, every minion of its scheme and its exchanges with other Taskmasters.
 */
function personWrote({ app: { store, runner, presence }, caller, session, ticket }: Ctx) {
  if (caller) return;
  runner.personWrote(ticket.id);
  presence.wroteIn(ticket.id, session.name);
  const minions = ticket.kind === 'coordinator' ? store.listTickets(ticket.project_id) : [ticket];
  for (const t of minions) runner.continueLoop(t.id, session.name);
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
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  } else throw new HttpError(400, 'mode must be branch or area');
  let size;
  try {
    size = await diffSize(spec);
  } catch (err: any) {
    throw new HttpError(400, String(err?.stderr || err?.message).trim().split('\n')[0]);
  }
  if (!size.files) throw new HttpError(400, spec.mode === 'branch' ? `Nothing to review: ${spec.branch} has no changes against ${base}` : 'Nothing to review: those paths hold no files');
  return { spec, size };
}

/**
 * Post a plan card that waits, across restarts, for a person. A new one replaces any earlier one of its kind still open
 * (waiting, or sent back for changes): a plan replaces plans, and a machine's notes card (#617) that machine's earlier ones.
 */
function postPlan(app: App, id: number, card: Record<string, unknown> & { summary: string; plan: string; machine?: { id: number } }) {
  const { store, runner } = app;
  for (const e of store.eventsOfKinds(id, ['plan'])) {
    const old = JSON.parse(e.data);
    if (old?.status !== 'pending' && old?.status !== 'revising') continue;
    if (old.machine?.id !== card.machine?.id) continue;
    store.setEventData(e.id, { ...old, status: 'superseded' });
    runner.emit(id, 'plan_result', { id: old.id, status: 'superseded' });
  }
  const event = runner.emit(id, 'plan', { id: randomBytes(6).toString('hex'), ...card, status: 'pending' });
  runner.broadcastTicket(id);
  app.notify(id, { kind: 'plan', summary: card.summary, eventId: event.id, ...(typeof card.to === 'string' ? { to: card.to } : {}) });
  return event;
}

export const ticketRoutes: Route[] = [
  {
    // An ultra review's size, before the person confirms (#432). Person-only like starting one.
    method: 'GET', path: '/api/tickets/:ticket/ultrareview', who: ['person'], refuse: ULTRAREVIEW_REFUSE,
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
    method: 'POST', path: '/api/tickets/:ticket/ultrareview', who: ['person'], refuse: ULTRAREVIEW_REFUSE,
    async handler({ req, res, app, session, ticket }) {
      if (!session.uid) throw new HttpError(403, 'Sign in as yourself to run an ultra review: it runs on your own Claude login');
      const body = await readJson(req);
      if (body.confirm !== true) throw new HttpError(400, 'Confirm first: an ultra review uses one of your free runs, or costs about $5-25 in usage credits after');
      const { spec, size } = await ultrareviewSpec(app, ticket, body.mode, body.paths);
      const row = app.store.getTicket(ticket.id)!;
      try {
        const ev = await app.ultrareviews.start(ticket.id, session.uid, session.name, spec, size, app.sharedDir(row));
        return json(res, 202, ev);
      } catch (err: any) {
        throw new HttpError(409, err.message);
      }
    },
  },
  {
    method: 'GET', path: '/api/tickets/:ticket', who: ['person', 'taskmaster', 'minion'], everyScheme: true,
    async handler(ctx) {
      const { res, ticket, app } = ctx;
      const { store } = app;
      return json(res, 200, { ticket, project: store.getProject(ticket.project_id) });
    },
  },
  {
    method: 'PATCH', path: '/api/tickets/:ticket', who: ['person', 'taskmaster', 'minion'],
    async handler(ctx) {
      const { req, res, app, session, caller, ticket } = ctx;
      const closeCancelled = setLabels(app, ticket, await readJson(req), session.name, caller?.id ?? null);
      return json(res, 200, { ...ticketView(app, ticket.id), ...(closeCancelled && { close_cancelled: closeCancelled }) });
    },
  },
  {
    // People's own note (#146): one plain line, shown only to people, never in a ticket's JSON or its chat.
    method: 'PUT', path: '/api/tickets/:ticket/person-note', who: ['person'], refuse: 'Only people write person notes',
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
    method: 'PUT', path: '/api/tickets/:ticket/pin', who: ['person'], refuse: 'Only people pin minions',
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
    method: 'POST', path: '/api/tickets/:ticket/seen', who: ['person'], refuse: 'Only people mark minions seen',
    async handler(ctx) {
      const { res, session, app, ticket } = ctx;
      const { id } = ticket;
      const { store } = app;
      return json(res, 200, { seen_at: store.markSeen(session.name, id) });
    },
  },
  {
    method: 'GET', path: '/api/tickets/:ticket/branch', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, ticket } = ctx;
      const { id } = ticket;
      return json(res, 200, { status: await app.ticketBranch(id) });
    },
  },
  {
    method: 'PUT', path: '/api/tickets/:ticket/uploads', who: ['person'], refuse: 'Only people attach files',
    async handler(ctx) {
      const { req, res, url, app, ticket } = ctx;
      // A file from the composer, streamed to disk as it arrives; the message that sends it names it.
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files must be under 200 MB');
      const saved = await saveUpload(fileUploadsDir(app, ticket), url.searchParams.get('name') ?? '', req);
      return json(res, 201, { name: saved.name, size: saved.size });
    },
  },
  {
    method: 'GET', path: '/api/tickets/:ticket/events', who: ['person', 'taskmaster'], everyScheme: true,
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
    method: 'POST', path: '/api/tickets/:ticket/messages', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { req, res, app, session, caller, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // Room for MAX_IMAGES images at 5 MB each, base64-encoded.
      const body = await readJson(req, 45_000_000);
      const attached = (Array.isArray(body.images) && body.images.length > 0) || (Array.isArray(body.files) && body.files.length > 0);
      const text = attached && (typeof body.text !== 'string' || !body.text.trim()) ? '' : str(body.text, 'Message', 100_000);
      // A retry of a message already taken (its reply lost on the way) is answered, not sent again (send-ids.ts).
      const sendId = caller ? undefined : sendIdOf(body.sendId);
      let held: unknown;
      await sendOnce(id, sendId, async () => {
        const files = await messageFiles(app, ticket, body.files);
        // message_ticket with unpark (#718): the Taskmaster unparks it, and this message is what wakes it.
        // Urgent as well, so a cold minion doesn't take it as held mail.
        const unparks = !!caller && body.unpark === true && runner.parked(ticket);
        if (unparks) await unparkTicket(app, ticket, session.name, APP_NAME, true);
        // The Taskmaster's messages to a minion go through the loop guard; a person's never wait.
        if (caller && ticket.kind !== 'coordinator') {
          held = runner.relay(id, id, session.name, text, body.urgent === true || unparks);
          // The loop guard held the message meant to wake it: it stays parked, so Unpark still shows.
          if (unparks && held === true && ticket.state === 'parked' && !runner.isRunning(id)) {
            app.store.updateTicket(id, { state: 'parked' });
            runner.emit(id, 'note', { text: 'The loop guard held the message that unparked it, so it stays parked.' });
            runner.broadcastTicket(id);
          }
          return;
        }
        // Mid-turn, a person's message steers the running turn unless they chose "Send after this turn".
        // Only here is a message a person's own typed words, the one kind that can be a go to merge (#201).
        // Its sendId goes on the message too, so the chat swaps in the server's copy for that exact message.
        // A parked minion keeps it for its next turn (#718).
        const r = runner.send(id, session.name, text, await saveImages(app, ticket, body.images), { ...(caller ? {} : { typed: true }), ...(sendId ? { sendId } : {}), hold: true }, !caller && body.after !== true, files);
        if (r === 'parked') held = 'parked';
      });
      if (held !== undefined && held !== 'parked') return json(res, 202, { ...ticketView(app, id), held });
      personWrote(ctx);
      if (held === 'parked') return json(res, 202, { ...ticketView(app, id), held });
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/unqueue', who: ['person'], refuse: 'Only people can take back a queued message',
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
    method: 'POST', path: '/api/tickets/:ticket/continue', who: ['person'], refuse: 'Only people continue a paused minion',
    async handler(ctx) {
      const { res, session, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // Continue button on a loop-guard pause: the minion's held messages go through.
      return json(res, 200, { released: runner.continueLoop(id, session.name) });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/comments', who: ['person'], refuse: 'Only people comment on files',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // A comment from a file's viewer: a chat message to the ticket that made the file, saying which file.
      const body = await readJson(req);
      const found = typeof body.path === 'string' && await resolveTicketFile(app, ticket, body.path);
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
    method: 'POST', path: '/api/tickets/:ticket/questions', who: ['self'], refuse: 'Only the minion itself can ask in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // Claude asks people multiple-choice questions; the card shows in the chat until someone answers.
      const body = await readJson(req);
      // Addressed to one person (#687): only their Needs-you list and devices get it. With no questions it's a notice, answered with Got it.
      const to = addressee(app, ticket, body.to);
      const notice = to && body.questions == null ? str(body.notice, 'Notice', 500) : null;
      const questions = notice ? [] : await cleanQuestions(app, ticket, body.questions);
      // A card asking for the go to merge or land says so, for the minions list's chip (#575).
      const kind = oneOf(body.kind ?? null, ['merge'], 'kind') as 'merge' | null;
      const card = { questions, ...(kind ? { kind } : {}), ...(to ? { to } : {}), ...(notice ? { notice } : {}) };
      // Held until CI passes on the pushed commit (#715): posted then with no turn, or now if it already passed.
      const armed = body.when_ci_passes === true ? await armForCi(app, ticket, { card }) : null;
      if (armed) return json(res, 202, { armed });
      return json(res, 201, postCard(app, ticket, card));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/settle', who: ['self'], refuse: 'Only the minion itself can settle its question cards',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // settle_question: the minion judged that a typed reply answered its card (or a newer card replaced
      // it). The card stops waiting on people: out of the inbox, no longer holding a deploy's dismissal.
      const only = (await readJson(req)).questionId;
      const asked = store.eventsOfKinds(id, ['question']).filter((e) => {
        const q = JSON.parse(e.data);
        return !q.settled && (only == null || q.id === only);
      });
      // An answer comes after its card: only messages after the oldest card still asked are read.
      const answered = new Set(asked.length ? store.eventsOfKinds(id, ['user_message'], asked[0].id).map((e) => JSON.parse(e.data).answer?.questionId).filter(Boolean) : []);
      const open = asked.filter((e) => !answered.has(JSON.parse(e.data).id));
      if (only != null && !open.length) throw new HttpError(404, 'No open question card with that id');
      const settled = { at: Date.now() };
      for (const e of open) {
        const q = JSON.parse(e.data);
        store.setEventData(e.id, { ...q, settled });
        runner.emit(id, 'question_result', { id: q.id, settled });
      }
      if (open.length) runner.broadcastTicket(id);
      return json(res, 200, { settled: open.map((e) => JSON.parse(e.data).id) });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/strike', who: ['self'], refuse: 'Only a thread itself can strike its words',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // strike_text: a minion or Taskmaster proven wrong strikes through its own words.
      const body = await readJson(req);
      const text = str(body.text, 'Text', 10_000);
      const reason = str(body.reason, 'Reason', 1000);
      try {
        return json(res, 200, runner.strike(id, text, reason));
      } catch (err: any) {
        throw new HttpError(/already/.test(err.message) ? 409 : 404, err.message);
      }
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/answer', who: ['person'], refuse: 'Only people answer question cards',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      const body = await readJson(req);
      const card = store.eventsOfKinds(id, ['question']).find((e) => JSON.parse(e.data).id === body.questionId);
      if (!card) throw new HttpError(404, 'No such question');
      // Its answer can only come after it: the chat's earlier messages are never read.
      if (store.eventsOfKinds(id, ['user_message'], card.id).some((e) => JSON.parse(e.data).answer?.questionId === body.questionId)) {
        throw new HttpError(409, 'That question has already been answered');
      }
      const data = JSON.parse(card.data);
      if (data.settled) throw new HttpError(409, data.settled.by ? `${data.settled.by} already marked this seen` : 'Claude took this as answered in the chat');
      // A notice (#687): Got it takes it out of the addressee's list, and sends the asker nothing.
      if (data.notice) {
        const settled = { at: Date.now(), by: session.name };
        store.setEventData(card.id, { ...data, settled });
        runner.emit(id, 'question_result', { id: data.id, settled });
        runner.broadcastTicket(id);
        return json(res, 202, ticketView(app, id));
      }
      const { questions } = data;
      const answers = cleanAnswers(questions, body.answers);
      const text = questions.map((q: any, i: number) => {
        const { selected, other } = answers[i];
        // The text typed with a pick expands on it; typed alone, it is the answer.
        const picked = selected.length ? `${selected.join('; ')}${other ? `\n  Added: ${other}` : ''}` : `In their own words: ${other}`;
        return `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}\n→ ${picked}`;
      }).join('\n\n');
      deliverAnswer(app, id, session.name, `My answers to your question card:\n\n${text}`, { answer: { questionId: body.questionId, answers } });
      personWrote(ctx);
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/plans', who: ['self'], refuse: 'Only the minion or Taskmaster itself can propose a plan in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // Claude proposes a plan: an Approve / Revise card that waits, across restarts, for a person.
      const body = await readJson(req);
      const plan = str(body.plan, 'Plan', 20_000);
      const summary = str(body.summary, 'Summary', 200);
      const to = addressee(app, ticket, body.to);
      const event = postPlan(app, id, { summary, plan, ...(to ? { to } : {}) });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id) });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/machine-notes', who: ['minion'], refuse: 'Only the minion itself can propose a machine\'s notes in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { store } = app;
      // A minion proposes a machine's whole new notes (#617, Josh: "Minion proposes, owner approves"): a plan card
      // only the machine's owner or an admin can approve, which writes them through the Machines page's PATCH.
      const body = await readJson(req);
      const name = str(body.machine, 'Machine', 30).toLowerCase();
      const notes = machineNotes(body.notes);
      const project = store.getProject(ticket.project_id)!;
      const asker = store.turnAsker(ticket.id);
      const machine = store.listMachines().find((m) => m.name === name);
      // As a turn of this minion's gets it (src/runner.ts): lent to this scheme, and someone's own only on its owner's ask.
      if (!machine || !lendsMachine(store, machine, project, asker === null ? [] : [asker])) throw new HttpError(404, `No machine called ${name} that this minion gets`);
      if (notes === machine.notes) throw new HttpError(400, `Those are already ${name}'s notes`);
      const owner = machine.owner_id === null ? null : store.getUser(machine.owner_id)?.name ?? null;
      const event = postPlan(app, ticket.id, {
        summary: `New notes for ${name}`,
        plan: notes,
        machine: { id: machine.id, name, owner },
        old: machine.notes,
        diff: lineDiff(machine.notes, notes),
      });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id), owner });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/verdict', who: ['person'], refuse: 'Only people approve plans',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // A person approves a plan card (the go) or sends it back with notes; never the minion or the Taskmaster.
      const body = await readJson(req);
      if (body.verdict !== 'approve' && body.verdict !== 'revise') throw new HttpError(400, 'verdict must be approve or revise');
      const event = store.eventsOfKinds(id, ['plan']).find((e) => JSON.parse(e.data).id === body.planId);
      if (!event) throw new HttpError(404, 'No such plan');
      const card = JSON.parse(event.data);
      // A machine's notes card (#617): a reason to reject is optional, and only its owner or an admin approves.
      const notes = body.verdict === 'approve' ? null : card.machine && !String(body.notes ?? '').trim() ? '' : str(body.notes, 'Notes', 10_000);
      if (card.status === 'superseded') throw new HttpError(409, card.machine ? `A newer proposal for ${card.machine.name}'s notes replaced this one` : 'A newer plan replaced this one');
      if (card.status !== 'pending') throw new HttpError(409, card.machine ? `${card.by} already ${card.status === 'approved' ? 'approved' : 'rejected'} these notes` : `${card.by} already ${card.status === 'approved' ? 'approved this plan' : 'asked for changes'}`);
      if (card.machine && notes === null) {
        const machine = store.getMachine(card.machine.id);
        if (!machine) throw new HttpError(409, `${card.machine.name} was removed`);
        if (!managesMachine(session, machine)) throw new HttpError(403, `Only ${card.machine.owner ? `${card.machine.owner}, who owns ${card.machine.name},` : 'an admin'}${card.machine.owner ? ' or an admin' : ''} can approve its notes`);
        // Approve writes what the card showed, or nothing: notes changed since (on the Machines page) aren't overwritten unseen.
        if (machine.name !== card.machine.name || machine.notes !== card.old) throw new HttpError(409, `${card.machine.name}'s notes changed since this was proposed; ask the minion to propose them again`);
        patchMachine(app, session, machine, { notes: card.plan });
      }
      const result = { status: body.verdict === 'approve' ? 'approved' : card.machine ? 'rejected' : 'revising', by: session.name, at: Date.now() };
      store.setEventData(event.id, { ...card, ...result });
      runner.emit(id, 'plan_result', { id: card.id, ...result });
      deliverAnswer(app, id, session.name, card.machine
        ? notes === null
          ? `Approved: ${card.machine.name}'s new notes are saved, and turns read them from their next start.`
          : `Rejected your proposed notes for ${card.machine.name}; they are unchanged.${notes ? `\n\n${notes}` : ''}`
        : notes === null
          ? `Plan approved: build it this way. ("${card.summary}")`
          : `Revise the plan ("${card.summary}") before building:\n\n${notes}\n\nPost the revised plan with propose_plan, and write no code until it is approved.`,
        { plan: { planId: card.id, verdict: body.verdict } });
      personWrote(ctx);
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/approvals', who: ['minion'], refuse: 'Only the minion itself can ask for approval in its chat',
    async handler(ctx) {
      const { req, res, ticket, app } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // Claude Code asks before a tool call (a tripwire ask or an approval rule): an Approve / Deny card, or a refusal.
      if (!runner.isRunning(id)) throw new HttpError(409, 'The minion is not mid-turn');
      const body = await readJson(req);
      const tool = str(body.tool_name, 'Tool name', 300);
      const input = body.input && typeof body.input === 'object' ? body.input : {};
      const project = store.getProject(ticket.project_id)!;
      const rules = lines(project.approval_rules).length > 0;
      // A merge's card shows the PR, looked up once now as the turn's own GitHub login.
      const merge = rules && tool === 'Bash' && typeof input.command === 'string' ? parseMerge(input.command) : null;
      const env = merge && runner.turnGithubEnv(id);
      const pr = merge && env ? await prInfo(merge, ticket.cwd, env) : null;
      // With a person's typed go standing in the scheme (#201, #260), a plain merge's PR decides whether it skips the card.
      const goCall = rules && runner.approvals.hasGo(project.id) ? (tool === 'Bash' ? (plainMerge(String(input.command), merge) ? merge : null) : mcpMerge(tool, input)) : null;
      const goEnv = goCall && goCall !== merge ? runner.turnGithubEnv(id) : null;
      const goPr = goCall === merge ? pr : goCall && goEnv ? await prInfo(goCall, ticket.cwd, goEnv) : null;
      // A merge in another shape (chained, a cd, no --repo) may be its PR's: then it's sent back once with the plain command (#209).
      const near = rules && !goCall && merge && env && !merge.admin && merge.method !== 'rebase' && runner.approvals.hasGo(project.id) ? merge : null;
      const schemeRepo = (goCall || near) && project.repo_dir ? await originRepo(project.repo_dir) : null;
      const target = goCall ? mergeTarget(goPr, schemeRepo) : null;
      // The card's lookup skips a moved shell's PR; a refusal runs nothing, so the worktree's answer does here.
      const nearPr = near ? pr ?? (near.moved && !near.repo ? await prInfo({ ...near, moved: false }, ticket.cwd, env) : null) : null;
      const nearTarget = near ? mergeTarget(nearPr, schemeRepo) : null;
      const retry = nearTarget && { target: nearTarget, command: `gh pr merge ${nearTarget.number} --repo ${schemeRepo} ${near!.method === 'merge' ? '--merge' : '--squash'}${near!.auto ? ' --auto' : ''}` };
      if ((merge || goCall) && !runner.isRunning(id)) throw new HttpError(409, 'The minion is not mid-turn');
      // Judged with the turn's TMPDIR (src/turn-launch.ts), as its hook judged it, not the server's own.
      const cfg = { ...tripwireConfig(project.id, claudeConfigDir(process.env), true), env: { ...process.env, TMPDIR: tmpDirFor(runner.tmpRoot(project.id), id) } };
      const r = runner.approvals.ask(id, tool, input, ticket.cwd, cfg, rules, merge ? { ...merge, pr } : undefined, target, retry);
      return json(res, 'id' in r ? 201 : 200, r);
    },
  },
  {
    method: 'GET', path: '/api/tickets/:ticket/approvals', who: ['minion'], refuse: 'Only the minion itself can wait on its approvals',
    async handler(ctx) {
      const { res, url, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // The thread's MCP server waits here for the card's outcome, half a minute at a time.
      return json(res, 200, await runner.approvals.wait(id, url.searchParams.get('id') ?? '', APPROVAL_POLL_MS));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/approve', who: ['person'], refuse: 'Only people approve tool calls',
    async handler(ctx) {
      const { req, res, session, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // Only a signed-in person's click settles a card; the coordinator and threads cannot.
      const body = await readJson(req);
      if (typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
      const approvalId = String(body.approvalId ?? '');
      const before = runner.approvals.get(id, approvalId);
      if (before.state === 'expired') throw new HttpError(409, 'This request expired; the turn that asked has ended');
      if (before.state !== 'pending') throw new HttpError(409, `${before.by} already ${before.state === 'allowed' ? 'approved' : 'denied'} this`);
      if (body.allow && runner.approvals.isTripwire(approvalId) && !session.admin) throw new HttpError(403, 'Only an admin can approve a tripwire card');
      return json(res, 200, runner.approvals.decide(id, approvalId, body.allow, session.name));
    },
  },
  {
    method: 'PUT', path: '/api/tickets/:ticket/properties', who: ['person', 'taskmaster', 'minion'],
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
        const text = !agent && after.toLowerCase() === by.toLowerCase() ? `${by} took over #${ticket.number}`
          : after ? `${by} handed #${ticket.number} to ${after}` : `${by} unassigned #${ticket.number}`;
        runner.emit(id, 'note', { text });
        const coordinator = store.getCoordinator(ticket.project_id);
        if (coordinator) runner.emit(coordinator.id, 'note', { text });
      }
      runner.broadcastTicket(id);
      return json(res, 200, r);
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/stop', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      return json(res, 200, { stopped: runner.stop(id) });
    },
  },
  // A spend alert card's Stop and Keep going (#723): each names its turn's start, so a card left over from an earlier
  // turn can't stop or mute a later one.
  {
    method: 'POST', path: '/api/tickets/:ticket/spend-stop', who: ['person'],
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const turn = Number((await readJson(req))?.turn);
      return json(res, 200, { stopped: app.runner.turnStartedAt(ticket.id) === turn && app.runner.stop(ticket.id) });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/spend-mute', who: ['person'],
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      return json(res, 200, { muted: app.runner.muteSpend(ticket.id, session.name, Number((await readJson(req))?.turn)) });
    },
  },
  // A Taskmaster's fresh session (#406): a person asks for one (the chat's button), or the Taskmaster's turn hands off (fresh_session).
  {
    method: 'POST', path: '/api/tickets/:ticket/fresh-session', who: ['person', 'self'],
    async handler(ctx) {
      const { req, res, app, session, caller, ticket } = ctx;
      const body = await readJson(req);
      const why = caller
        ? app.runner.recordHandoff(ticket.id, str(body.summary, 'Summary', 20_000))
        : app.runner.requestFresh(ticket.id, `${session.name} asked for it`);
      if (why) throw new HttpError(409, why);
      return json(res, 202, ticketView(app, ticket.id));
    },
  },
  // Unpark (#718): the chat header's button and update_ticket's state change; for a chained minion, as Start now.
  {
    method: 'POST', path: '/api/tickets/:ticket/unpark', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, session, caller, ticket } = ctx;
      await unparkTicket(app, ticket, session.name, caller ? APP_NAME : session.name);
      return json(res, 200, ticketView(app, ticket.id));
    },
  },
  // Start now (#261): a minion parked on start_after starts before its leader's work is in, its held brief first.
  {
    method: 'POST', path: '/api/tickets/:ticket/start', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { res, app, session, ticket } = ctx;
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'The Taskmaster never waits on another minion\'s work');
      const chained = app.waiters.claim(ticket.id); // released by startChained as it sends the brief
      if (!chained) throw new HttpError(409, `#${ticket.number} isn't parked waiting on another minion's work`);
      await app.startChained(chained, `${session.name} started it before its leader's work was in`);
      return json(res, 200, ticketView(app, ticket.id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/status', who: ['person', 'taskmaster'],
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      const body = await readJson(req);
      if (body.status !== 'closed' && body.status !== 'idle') throw new HttpError(400, 'Status must be closed or idle');
      if (ticket.kind === 'coordinator') throw new HttpError(400, 'The Taskmaster cannot be dismissed');
      if (runner.isRunning(id)) throw new HttpError(409, 'Stop the minion before dismissing it');
      // Already as asked: a second dismissal, or a reopen of a minion that isn't dismissed, changes nothing.
      if ((body.status === 'closed') === (ticket.status === 'closed')) return json(res, 200, ticketView(app, id));
      if (body.status === 'closed') {
        await runner.close(id, `${session.name} dismissed this minion.`);
      } else {
        store.updateTicket(id, { status: body.status });
        runner.emit(id, 'note', { text: `${session.name} reopened this minion.` });
        runner.broadcastTicket(id);
        // Its worktree back now if the sweep removed it (#660), behind any dismissal cleanup on its lane.
        void runner.reopened(id);
      }
      return json(res, 200, ticketView(app, id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/coordinator', who: ['minion'], refuse: 'Only a minion can message its Taskmaster',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // A thread asks its project's coordinator for something only the coordinator can do (message_coordinator).
      const body = await readJson(req);
      const text = str(body.text, 'Message', 10_000);
      const armed = body.when_ci_passes === true ? await armForCi(app, ticket, { coordinator: { text, urgent: body.urgent === true, ...(body.wake === false ? { wake: false } : {}) } }) : null;
      if (armed) return json(res, 202, { sent: false, armed });
      const held = await tellTaskmaster(app, ticket, text, body.urgent === true, body.wake !== false);
      if (held === true) return json(res, 202, { sent: false, held: true });
      return json(res, 202, { sent: true, ...(held === 'cold' ? { cold: true } : held === 'mail' ? { mail: true } : {}) });
    },
  },
  {
    // message_minion (#783): one minion messages another in its own scheme, with the Taskmaster's wake rules
    // (runner.relayMinion) and one loop guard per pair. It never reopens a dismissed one, and the Taskmaster
    // gets a one-line copy as held mail, which wakes nothing.
    method: 'POST', path: '/api/tickets/:ticket/minion-message', who: ['minion'], refuse: 'Only a minion messages another minion this way',
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
      const held = runner.relayMinion(ticket.id, target.id, author, text, body.urgent === true, body.wake !== false);
      if (held !== true) {
        const how = held === 'parked' ? 'Left for' : held ? 'Left held mail for' : 'Sent';
        runner.emit(ticket.id, 'note', { text: `${how} #${target.number} ${target.title}: ${text}` });
        const coordinator = store.getCoordinator(ticket.project_id);
        const line = text.replace(/\s+/g, ' ');
        if (coordinator) runner.leaveMail(coordinator.id, author, `(to #${target.number}, for your tracking; nothing to do) ${line.length > 200 ? line.slice(0, 200) + '…' : line}`);
      }
      return json(res, 202, { held, number: target.number, title: target.title, state: target.state });
    },
  },
  {
    // read_minion (#783): another minion's line, worktree and recent chat, for its scheme's minions. Only
    // the chat's words: no cards, tool calls, approvals, attachments or costs.
    method: 'GET', path: '/api/tickets/:ticket/peer', who: ['minion'], refuse: 'Only a minion reads another this way',
    handler({ res, url, app, ticket }) {
      const { store, runner } = app;
      const n = Number(url.searchParams.get('number'));
      const last = Math.min(Math.max(Number(url.searchParams.get('last')) || 10, 1), 50);
      const target = Number.isInteger(n) && n > 0 ? store.getTicketByNumber(ticket.project_id, n) : undefined;
      if (!target || target.kind === 'coordinator') throw new HttpError(404, `There is no minion #${n} in this scheme`);
      const v = runner.view(target);
      const line = { ...Object.fromEntries(LINE_FIELDS.map((k) => [k, v[k]])), ...(target.cwd ? { worktree: target.cwd } : {}) };
      const events = store.listEvents(target.id).flatMap((e) => {
        const d = JSON.parse(e.data);
        const keep = e.kind === 'user_message' ? { author: d.author, text: d.text ?? '', ...(d.comment ? { comment: { about: d.comment.about } } : {}) }
          : e.kind === 'note' || e.kind === 'error' ? { text: d.text ?? '' }
          : e.kind === 'claude' && d.type === 'assistant' && !d.replaced && (d.message?.content ?? []).some((b: any) => b.type === 'text' && b.text.trim())
            ? { type: 'assistant', message: { content: d.message.content.filter((b: any) => b.type === 'text') }, ...(d.parent_tool_use_id ? { parent_tool_use_id: d.parent_tool_use_id } : {}) }
          : e.kind === 'claude' && d.type === 'result' ? { type: 'result', is_error: !!d.is_error }
          : null;
        return keep ? [{ kind: e.kind, data: JSON.stringify(keep) }] : [];
      });
      return json(res, 200, { ticket: line, events: events.slice(-last), skipped: Math.max(events.length - last, 0) });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/deploy', who: ['minion'], refuse: 'Only the deploying minion can report its deploy',
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
      if (failed) store.setSetting(DEPLOY_FAILURE, { text, head: waiters.head });
      // A failed deploy leaves the minion in pending-deploy, so the error stays in view.
      const dismissed = !failed && runner.deployLive(id);
      return json(res, 201, { dismissed });
    },
  },
  {
    // The host_check tool (#621): the host's read-only checks (masked database, a user unit's journal and status) for a turn in a container.
    method: 'POST', path: '/api/host-check', who: ['minion', 'taskmaster'], refuse: 'Only a turn can run host checks',
    async handler({ req, res, app, caller }) {
      const body = await readJson(req);
      // The database holds every scheme's chat, so only a turn whose person sees every scheme reads it (db.ts canSee).
      const refused = body?.what === 'db' ? adminAskRefusal(app.store, caller!.id) : null;
      if (refused) throw new HttpError(403, refused);
      const { systemctl, journalctl } = app.services.opts;
      return json(res, 200, { output: await hostCheck({ db: join(app.dataDir, 'coordinator.db'), systemctl, journalctl }, body) });
    },
  },
  {
    // The land tool (src/land.ts): run tools/land.sh in this minion's worktree on the host, for a turn in a container.
    method: 'POST', path: '/api/tickets/:ticket/land', who: ['minion'], refuse: 'Only the minion itself can land its branch',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // { fix: true }: LAND_FIX=1, for the fix of a commit whose deploy was rolled back (tools/land.sh's bad_check). No body from older tools.
      const body = (req.headers['content-type'] ?? '').startsWith('application/json') ? await readJson(req) : {};
      if (ticket.kind !== 'ticket' || !ticket.cwd) throw new HttpError(403, 'Only a minion with a worktree lands with tools/land.sh');
      // Any scheme's: a container turn that ran land.sh itself couldn't see the host's landings in line (#574).
      if (!existsSync(join(ticket.cwd, 'tools', 'land.sh'))) throw new HttpError(404, 'This worktree has no tools/land.sh: land the way the scheme instructions say');
      // Only a minion's own bearer token gets here (who: minion).
      const token = String(req.headers.authorization).replace(/^Bearer /, '');
      const env = app.runner.hostEnv(ticket, token);
      if (body?.fix === true) env.LAND_FIX = '1';
      // { into, files, full, build }: land.sh's build-branch forms (#597), checked to the shapes it accepts.
      let args: string[];
      try {
        args = landArgs(body ?? {}, ticket.cwd);
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      return json(res, 202, app.landings.start(ticket.id, ticket.cwd, env, args));
    },
  },
  {
    // generate_image, edit_image and generate_audio (#717): the server calls OpenRouter on the key of the person this
    // turn runs for (ticket.person_id), booked against their monthly cap; the turn never sees the key.
    method: 'POST', path: '/api/tickets/:ticket/openrouter', who: ['minion'], refuse: 'Only the minion itself can make media in its folders',
    async handler({ req, res, app, ticket }) {
      const body = (await readJson(req)) ?? {};
      if (ticket.kind !== 'ticket' || !ticket.cwd) throw new HttpError(403, 'Only a minion with a worktree makes media');
      const tool = oneOf(body.tool, MEDIA_TOOLS, 'tool') as MediaTool | null;
      if (!tool) throw new HttpError(400, `tool must be one of: ${MEDIA_TOOLS.join(', ')}`);
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
      return json(res, 200, await app.openrouter.tool(tool, args, { userId: ticket.person_id, ticketId: ticket.id, projectId: ticket.project_id, roots: ticketRoots(app, ticket) }));
    },
  },
  {
    // hand_off_land (#706): the server runs tools/land.sh and reports it (LandHandoffs in src/land.ts), so the minion ends its turn now.
    method: 'POST', path: '/api/tickets/:ticket/land/handoff', who: ['minion'], refuse: 'Only the minion itself can land its branch',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const body = (await readJson(req)) ?? {};
      if (ticket.kind !== 'ticket' || !ticket.cwd) throw new HttpError(403, 'Only a minion with a worktree lands with tools/land.sh');
      if (!existsSync(join(ticket.cwd, 'tools', 'land.sh'))) throw new HttpError(404, 'This worktree has no tools/land.sh: land the way the scheme instructions say');
      const h: Handoff = { summary: str(body.summary, 'Summary', 300), risk: oneOf(body.risk || undefined, ['low', 'medium', 'high'], 'Risk') as Handoff['risk'], reason: str(body.risk_reason, 'Risk reason', 300) };
      if (h.risk === 'high') {
        if (typeof body.go !== 'string' || !body.go.trim()) throw new HttpError(400, 'A high-risk change lands only on a person\'s go: name who gave it and when in go, or ask with a merge card first');
        h.go = str(body.go, 'Go', 200);
      }
      if (body.deploy !== undefined && typeof body.deploy !== 'boolean') throw new HttpError(400, 'deploy must be true or false');
      if (body.deploy === false) h.deploy = false;
      let args: string[];
      try {
        args = landArgs(body, ticket.cwd);
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      // The build minion's take-in of main isn't the end of its work: a clean one would dismiss it mid-build.
      if (args.includes('--full')) throw new HttpError(400, 'A build minion takes main in within its turn: run tools/land.sh --into build/<n> --full yourself (in a container, the land tool)');
      // As land.sh's own first check, but now, before the minion ends its turn on a land that would refuse at once.
      const dirty = await new Promise<string>((done) => execFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ticket.cwd! }, (err, out) => done(err ? `git status failed: ${err.message}` : out.trim())));
      if (dirty) throw new HttpError(409, `Not handed off: your worktree has uncommitted changes. Commit them first.\n${dirty.slice(0, 2000)}`);
      const env = app.runner.hostEnv(ticket, String(req.headers.authorization).replace(/^Bearer /, ''));
      if (body.fix === true) env.LAND_FIX = '1';
      // A branch that wouldn't rebase cleanly is sent back now, in the minion's own turn, not after its wait in line (#770).
      const clash = await landConflict(ticket.cwd, env, args);
      if (clash) throw new HttpError(409, `Not handed off: ${clash}`);
      if (!app.landings.handOff(ticket.id, ticket.cwd, env, args, h)) throw new HttpError(409, 'A landing already runs for this minion: wait for its report');
      app.store.updateTicket(ticket.id, { state: 'outside', note: 'landing: handed to the server' });
      app.runner.broadcastTicket(ticket.id);
      return json(res, 202, { ok: true });
    },
  },
  {
    method: 'GET', path: '/api/tickets/:ticket/land', who: ['minion'], refuse: 'Only the minion itself can land its branch',
    handler: ({ res, app, ticket }) => {
      const run = app.landings.get(ticket.id);
      if (!run) throw new HttpError(404, 'No landing has started for this minion');
      return json(res, 200, run);
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/preview', who: ['person', 'taskmaster', 'minion'],
    async handler(ctx) {
      const { res, url, app, ticket } = ctx;
      const { id } = ticket;
      const { store } = app;
      // start_preview: (re)start this minion's preview from its worktree as it is now.
      if (!app.previews) throw new HttpError(403, 'A preview has no previews of its own');
      await app.previews.start(ticket);
      const origin = store.getSetting<string>('public_origin');
      return json(res, 200, { url: `${origin ?? ''}/${previewPath(id)}` });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/wake', who: ['person', 'taskmaster', 'minion'],
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
      app.runner.broadcastTicket(id); // a parked row moves to Waiting (#718)
      return json(res, 201, { waiting, commit, head: waiters.head, merged: !!elsewhere });
    },
  },
  {
    // wake_at (#722): the minion or Taskmaster itself sets, lists or cancels timed wakes in its own chat.
    method: 'POST', path: '/api/tickets/:ticket/wake-at', who: ['self'], refuse: 'Only the minion or Taskmaster itself can set a wake in its chat',
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
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      // The row people see until it fires; the wake itself arrives as a message.
      runner.emit(ticket.id, 'note', { text: `Wake set for ${pacificTime(w.at)}: ${note}` });
      return json(res, 200, { set: view([w])[0], wakes: view() });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/wake-runners', who: ['minion'],
    async handler(ctx) {
      const { req, res, ticket, app } = ctx;
      // wake_when_runners_back (#541): a landing parked because CI gave no verdict waits for the scheme's runners.
      const project = app.store.getProject(ticket.project_id);
      if (!repoSlug(project?.repo_url ?? null)) throw new HttpError(400, "This scheme's repo isn't on GitHub, so it has no runners to watch");
      const label = runnerLabel(project!.name);
      if (!label) throw new HttpError(409, `${project!.name}'s name has no letters a-z or digits to make a runner label from, so no runner can match`);
      const body = await readJson(req);
      addRunnerWaiter(app.store, ticket.id, str(body.reason, 'Reason', 1000));
      app.runner.broadcastTicket(ticket.id); // a parked row moves to Waiting (#718)
      return json(res, 201, { label });
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/close', who: ['minion'], refuse: 'A minion may only be dismissed by itself',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // A thread closes itself once its current turn ends (close_self); the token decides which thread.
      const body = await readJson(req);
      const reason = typeof body.reason === 'string' && body.reason.trim() ? str(body.reason.trim(), 'Reason', 500) : null;
      // A state ready is cleared rather than refused (#480): a finished minion sets it by habit before close_self.
      const kept = runner.keptOpen(id, true);
      if (kept) throw new HttpError(409, `Not dismissed: ${kept}. Leave the minion open for them; if nothing is left for people (the card was answered in the chat, or there is nothing to try), settle the card or clear the state first`);
      const cleared = app.store.getTicket(id)!.state === 'ready';
      if (!runner.closeAfterTurn(id, reason)) throw new HttpError(409, 'The minion is not mid-turn');
      return json(res, 202, { ...ticketView(app, id), cleared });
    },
  },
];
