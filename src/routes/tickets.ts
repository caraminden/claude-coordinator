// One minion's (or Taskmaster's) chat and state: what people, its Taskmaster and the minion itself
// may do to it. Who may call each route is its `who` (src/http.ts).
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { lines } from '../approvals.ts';
import { AGENT_NAME } from '../auth.ts';
import { commentMessage, optionImageProblem } from '../artifacts.ts';
import { EFFORTS, MODELS, PERSON_NOTE_MAX, TICKET_STATES, TICKET_TAGS, type Ticket, type TicketState, type TicketTag } from '../db.ts';
import { historyPage } from '../history.ts';
import { previewPath } from '../previews.ts';
import { NOTIFY_STATES } from '../push.ts';
import { tripwireConfig } from '../runner.ts';
import { claudeConfigDir } from '../sessions.ts';
import { MAX_UPLOAD_BYTES, saveUpload } from '../uploads.ts';
import { buildNumber, HttpError, json, oneOf, readJson, replyList, str, ticketView, type App, type Ctx, type Route } from '../http.ts';
import { fileUploadsDir, messageFiles, resolveTicketFile, saveImages, ticketRoots } from './files.ts';
import { ensureCoordinator } from './projects.ts';

// How long one wait for an approval card's outcome holds the request open.
const APPROVAL_POLL_MS = 25_000;

/** The setting holding the last deploy report that failed (server.ts shows it in the ship line). */
export const DEPLOY_FAILURE = 'deploy-failure';

// A label Claude ended with "(Recommended)" itself; the card adds those words to the flagged option.
const SAYS_RECOMMENDED = /\s*\(recommended\)\s*$/i;

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
    const options = q.options.map((o: any, j: number) => {
      const says = typeof o?.label === 'string' && SAYS_RECOMMENDED.test(o.label);
      return {
        label: str(says ? o.label.replace(SAYS_RECOMMENDED, '') : o?.label, `${n} option ${j + 1} label`, 80),
        ...(o?.description ? { description: str(o.description, `${n} option ${j + 1} description`, 300) } : {}),
        ...(o?.image ? { image: str(o.image, `${n} option ${j + 1} image`, 1000) } : {}),
        ...(o?.recommended === true || says ? { recommended: true } : {}),
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
function personWrote({ app: { store, runner }, caller, session, ticket }: Ctx) {
  if (caller) return;
  runner.personWrote(ticket.id);
  const minions = ticket.kind === 'coordinator' ? store.listTickets(ticket.project_id) : [ticket];
  for (const t of minions) runner.continueLoop(t.id, session.name);
}

export const ticketRoutes: Route[] = [
  {
    method: 'GET', path: '/api/tickets/:ticket', who: ['person', 'taskmaster', 'minion'],
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
      const { id } = ticket;
      const { store, runner } = app;
      // Any of title, tag, state, note, replies, build, model and effort; null (or "") clears all but the title.
      const body = await readJson(req);
      const fields: Partial<Pick<Ticket, 'title' | 'tag' | 'state' | 'note' | 'replies' | 'build' | 'model' | 'effort'>> = {};
      if (body.model !== undefined) fields.model = oneOf(body.model, MODELS, 'Model');
      if (body.effort !== undefined) fields.effort = oneOf(body.effort, EFFORTS, 'Effort');
      if (body.title !== undefined) fields.title = str(body.title, 'Title', 120);
      if (body.tag !== undefined) fields.tag = oneOf(body.tag, TICKET_TAGS, 'Tag') as TicketTag | null;
      if (body.state !== undefined) fields.state = oneOf(body.state, TICKET_STATES, 'State') as TicketState | null;
      if (body.note !== undefined) fields.note = body.note ? str(body.note, 'Note', 60) : null;
      if (body.build !== undefined) fields.build = buildNumber(body.build);
      if (body.replies !== undefined) fields.replies = replyList(body.replies);
      // The view's replies are a list; compare the stored JSON.
      const stored = store.getTicket(id)!;
      for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === stored[k]) delete fields[k];
      if (Object.keys(fields).length) {
        store.updateTicket(id, fields);
        if (fields.state === 'pending-deploy') runner.deployPending(id);
        if ('tag' in fields) store.props.setTypeFromTag(id, fields.tag ?? null, session.name);
        if ('build' in fields) store.props.setBuild(id, fields.build ?? null, session.name);
        const who = caller?.id === id ? 'Claude' : session.name;
        if (fields.title) runner.emit(id, 'note', { text: `${who} renamed this minion from "${ticket.title}" to "${fields.title}".` });
        const next = runner.isRunning(id) ? 'from the next turn' : 'from now on';
        if ('model' in fields) runner.emit(id, 'note', { text: `${who} set this minion to ${fields.model ? modelName(fields.model) : 'the default model'} ${next}.` });
        if ('effort' in fields) runner.emit(id, 'note', { text: `${who} set this minion to ${fields.effort ? `${fields.effort} effort` : 'the default effort'} ${next}.` });
        runner.broadcastTicket(id);
        // A result or a blocker is worth a ping; whoever set it by hand already knows.
        if (fields.state && NOTIFY_STATES[fields.state]) {
          const after = store.getTicket(id)!;
          app.notify(id, { kind: 'state', state: after.state, note: after.note }, caller ? null : session.name);
        }
      }
      return json(res, 200, ticketView(app, id));
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
    method: 'GET', path: '/api/tickets/:ticket/events', who: ['person', 'taskmaster'],
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
      const { runner, waiters } = app;
      // Room for MAX_IMAGES images at 5 MB each, base64-encoded.
      const body = await readJson(req, 45_000_000);
      const attached = (Array.isArray(body.images) && body.images.length > 0) || (Array.isArray(body.files) && body.files.length > 0);
      const text = attached && (typeof body.text !== 'string' || !body.text.trim()) ? '' : str(body.text, 'Message', 100_000);
      const files = await messageFiles(app, ticket, body.files);
      // A chained minion that hasn't started: writing to it starts it now, its held brief first.
      const chained = waiters.release(id);
      if (chained) await app.startChained(chained, `${session.name} wrote to it before its leader's work was in`);
      // The Taskmaster's messages to a minion go through the loop guard; a person's never wait.
      if (caller && ticket.kind !== 'coordinator') {
        return json(res, 202, { ...ticketView(app, id), held: runner.relay(id, id, session.name, text) });
      }
      // Mid-turn, a person's message steers the running turn unless they chose "Send after this turn".
      runner.send(id, session.name, text, await saveImages(app, ticket, body.images), {}, !caller && body.after !== true, files);
      personWrote(ctx);
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
      runner.send(id, session.name, text, [], { comment: { path: body.path, about } });
      personWrote(ctx);
      return json(res, 202, ticketView(app, id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/questions', who: ['self'], refuse: 'Only the minion itself can ask in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // Claude asks people multiple-choice questions; the card shows in the chat until someone answers.
      const questions = await cleanQuestions(app, ticket, (await readJson(req)).questions);
      const questionId = randomBytes(6).toString('hex');
      runner.emit(id, 'question', { id: questionId, questions });
      runner.broadcastTicket(id);
      app.notify(id, { kind: 'question', questions });
      return json(res, 201, { id: questionId });
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
      const events = store.listEvents(id);
      const answered = new Set(events.map((e) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId).filter(Boolean));
      const open = events.filter((e) => {
        const q = e.kind === 'question' ? JSON.parse(e.data) : null;
        return q && !q.settled && !answered.has(q.id) && (only == null || q.id === only);
      });
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
      const events = store.listEvents(id);
      const card = events.find((e) => e.kind === 'question' && JSON.parse(e.data).id === body.questionId);
      if (!card) throw new HttpError(404, 'No such question');
      if (events.some((e) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId === body.questionId)) {
        throw new HttpError(409, 'That question has already been answered');
      }
      if (JSON.parse(card.data).settled) throw new HttpError(409, 'Claude took this as answered in the chat');
      const { questions } = JSON.parse(card.data);
      const answers = cleanAnswers(questions, body.answers);
      const text = questions.map((q: any, i: number) => {
        const picked = [...answers[i].selected, ...(answers[i].other ? [`Other: ${answers[i].other}`] : [])];
        return `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}\n→ ${picked.join('; ')}`;
      }).join('\n\n');
      runner.send(id, session.name, `My answers to your question card:\n\n${text}`, [], { answer: { questionId: body.questionId, answers } });
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
      // A new plan replaces any earlier one still open (waiting, or sent back for changes).
      for (const e of store.listEvents(id)) {
        const old = e.kind === 'plan' ? JSON.parse(e.data) : null;
        if (old?.status !== 'pending' && old?.status !== 'revising') continue;
        store.setEventData(e.id, { ...old, status: 'superseded' });
        runner.emit(id, 'plan_result', { id: old.id, status: 'superseded' });
      }
      const planId = randomBytes(6).toString('hex');
      runner.emit(id, 'plan', { id: planId, summary, plan, status: 'pending' });
      runner.broadcastTicket(id);
      app.notify(id, { kind: 'plan', summary });
      return json(res, 201, { id: planId });
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
      const notes = body.verdict === 'revise' ? str(body.notes, 'Notes', 10_000) : null;
      const event = store.listEvents(id).find((e) => e.kind === 'plan' && JSON.parse(e.data).id === body.planId);
      if (!event) throw new HttpError(404, 'No such plan');
      const card = JSON.parse(event.data);
      if (card.status === 'superseded') throw new HttpError(409, 'A newer plan replaced this one');
      if (card.status !== 'pending') throw new HttpError(409, `${card.by} already ${card.status === 'approved' ? 'approved this plan' : 'asked for changes'}`);
      const result = { status: body.verdict === 'approve' ? 'approved' : 'revising', by: session.name, at: Date.now() };
      store.setEventData(event.id, { ...card, ...result });
      runner.emit(id, 'plan_result', { id: card.id, ...result });
      runner.send(id, session.name, notes === null
        ? `Plan approved: build it this way. ("${card.summary}")`
        : `Revise the plan ("${card.summary}") before building:\n\n${notes}\n\nPost the revised plan with propose_plan, and write no code until it is approved.`,
        [], { plan: { planId: card.id, verdict: body.verdict } });
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
      const r = runner.approvals.ask(id, tool, input, ticket.cwd, tripwireConfig(project.id, claudeConfigDir(process.env), true), lines(project.approval_rules).length > 0);
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
      if (runner.approvals.isTripwire(approvalId) && !session.admin) throw new HttpError(403, 'Only an admin can approve a tripwire card');
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
      const r = store.props.set('minion', id, ticket.project_id, body.properties, session.name);
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
      if (body.status === 'closed') {
        await runner.close(id, `${session.name} dismissed this minion.`);
      } else {
        store.updateTicket(id, { status: body.status });
        runner.emit(id, 'note', { text: `${session.name} reopened this minion.` });
        runner.broadcastTicket(id);
      }
      return json(res, 200, ticketView(app, id));
    },
  },
  {
    method: 'POST', path: '/api/tickets/:ticket/coordinator', who: ['minion'], refuse: 'Only a minion can message its Taskmaster',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // A thread asks its project's coordinator for something only the coordinator can do (message_coordinator).
      const text = str((await readJson(req)).text, 'Message', 10_000);
      const coordinator = await ensureCoordinator(app, store.getProject(ticket.project_id)!);
      if (runner.relay(id, coordinator.id, `#${ticket.number} ${ticket.title}`, text)) return json(res, 202, { sent: false, held: true });
      runner.emit(id, 'note', { text: `Sent the Taskmaster: ${text.length > 200 ? text.slice(0, 200) + '…' : text}` });
      return json(res, 202, { sent: true });
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
      runner.emit(id, loud ? 'error' : 'note', { text });
      if (loud) app.notify(id, { kind: 'error', text });
      if (failed) store.setSetting(DEPLOY_FAILURE, { text, head: waiters.head });
      // A failed deploy leaves the minion in pending-deploy, so the error stays in view.
      const dismissed = !failed && runner.deployLive(id);
      return json(res, 201, { dismissed });
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
      const elsewhere = waiters.elsewhere(id);
      if (body.commit == null || body.commit === '') {
        if (elsewhere) throw new HttpError(400, "This scheme has no deploys; give the commit you're waiting on");
      } else {
        // Elsewhere, only the scheme's own commits can ever be on its main.
        commit = waiters.resolve(String(body.commit), store.getProject(ticket.project_id)?.repo_dir ?? null, !!elsewhere);
        if (!commit) throw new HttpError(400, `No commit ${String(body.commit).slice(0, 40)} in ${elsewhere ? '' : 'the live checkout or '}the scheme's repo`);
      }
      const waiting = waiters.add(id, commit, reason);
      return json(res, 201, { waiting, commit, head: waiters.head, merged: !!elsewhere });
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
      const kept = runner.keptOpen(id);
      if (kept) throw new HttpError(409, `Not dismissed: ${kept}. Leave the minion open for them; if nothing is left for people (the card was answered in the chat, or there is nothing to try), settle the card or clear the state first`);
      if (!runner.closeAfterTurn(id, reason)) throw new HttpError(409, 'The minion is not mid-turn');
      return json(res, 202, ticketView(app, id));
    },
  },
];
