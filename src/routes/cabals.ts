// A cabal's board (#2090, src/cabal-board.ts): read by people (the lead's chat panel and its own page), its lead and its
// members (cabal_board); written by the lead (roster rows, answers, its log, the red-run line) and each member (its own
// note and files, its asks). An ask is held mail to the lead unless it is blocking, which wakes it.
import { type Board, boardText, readBoard, timelineText } from '../cabal-board.ts';
import type { Store } from '../db.ts';
import { cabalBoardFor } from '../access.ts';
import { APPROVED_FIELDS, cabalChanged, memberJoined, retroCheck, cabalStart, cabalTaskmaster, handoffPath, memberAction, postForming, rowScheme } from '../cabal-start.ts';
import { schemeTarget } from './projects.ts';
import { EFFORTS, MODELS } from '../db.ts';
import type { CabalRowFields } from '../db/cabals.ts';
import type { Ticket } from '../db-rows.ts';
import { type App, HttpError, json, oneOf, readJson, type Route } from '../http.ts';

/** The lead of the board a minion is on or leads, or null. */
export function cabalLeadOf(store: Store, ticketId: number): number | null {
  if (store.getCabal(ticketId)) return ticketId;
  return store.cabalRowOf(ticketId)?.lead_id ?? null;
}

const line = (v: unknown, what: string, max: number) => {
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be text`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) throw new HttpError(400, `${what} is empty`);
  if (s.length > max) throw new HttpError(400, `${what} is over ${max} characters`);
  return s;
};
const files = (v: unknown) => {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,\s]+/) : null;
  if (!list || list.some((f) => typeof f !== 'string' || f.length > 300) || list.length > 100) throw new HttpError(400, 'files must be a list of up to 100 repo paths');
  return (list as string[])
    .map((f) => f.trim())
    .filter(Boolean)
    .join('\n');
};

/**
 * The lead a cabal names, checked (a 400 says why not): #N in this scheme, or "<scheme>#N" for a lead in another (#2094),
 * which takes only a row its forming card approved for this scheme, matched by `title`. `self` is the minion joining, if it exists yet.
 */
export function cabalLead(store: Store, projectId: number, cabal: unknown, self: number | null, title = ''): Ticket {
  const cross = typeof cabal === 'string' ? /^(.+?)\s*#(\d+)$/.exec(cabal.trim()) : null;
  const scheme = cross ? store.listProjects().find((p) => p.name.toLowerCase() === cross[1].trim().toLowerCase() || String(p.id) === cross[1].trim()) : undefined;
  if (cross && !scheme) throw new HttpError(400, `cabal "${String(cabal).slice(0, 80)}": no scheme called ${cross[1].slice(0, 60)}`);
  const n = Number(cross ? cross[2] : cabal);
  const home = scheme?.id ?? projectId;
  const lead = Number.isInteger(n) && n > 0 ? store.getTicketByNumber(home, n) : undefined;
  if (!lead || lead.kind === 'coordinator') throw new HttpError(400, `cabal must be the #N of a minion that leads it, in this scheme or as "<scheme>#N": no minion #${String(cabal).slice(0, 20)}${scheme ? ` in ${scheme.name}` : ''}`);
  if (home !== projectId) crossRow(store, lead, projectId, title);
  if (lead.id === self) throw new HttpError(400, "A minion can't be on its own cabal: it leads it");
  if (store.cabalRowOf(lead.id)) throw new HttpError(400, `#${n} is on another Plot's board, so it can't lead one`);
  if (self != null && store.getCabal(self)) throw new HttpError(400, "This minion leads a Plot, so it can't join another");
  return lead;
}

/** The approved, unstarted row a lead in another scheme planned for `projectId`, with this title: only its people's go starts one. */
function crossRow(store: Store, lead: Ticket, projectId: number, title: string) {
  const open = store.getCabal(lead.id) ? store.cabalRows(lead.id).filter((r) => r.ticket_id == null && r.project_id === projectId && r.approved_at != null) : [];
  const row = open.find((r) => r.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (!row)
    throw new HttpError(
      409,
      `#${lead.number} in ${store.getProject(lead.project_id)?.name} has ${open.length ? `no row titled "${title.slice(0, 120)}" approved for this scheme; its rows waiting here: ${open.map((r) => `"${r.title}"`).join(', ')}` : 'no row approved for this scheme: its people approve one on the forming card first'}`,
    );
  return row;
}

/**
 * create_ticket's and update_ticket's cabal (#2090): put a minion on the board of the lead #N in its own scheme (a roster
 * row with its title becomes its row), or take it off with null. A lead can't be a member, nor a member a lead.
 */
export function putOnCabal(app: App, t: Pick<Ticket, 'id' | 'project_id' | 'title'>, cabal: unknown, by: string, rowId?: number) {
  const { store, runner } = app;
  const was = store.cabalRowOf(t.id)?.lead_id ?? null;
  if (cabal === null) {
    store.leaveCabal(t.id);
    if (was != null) {
      runner.emit(t.id, 'note', { text: `${by} took this minion off #${store.getTicket(was)?.number}'s cabal board.` });
      cabalChanged(app, was);
      retroCheck(app, was);
    }
    return;
  }
  const lead = cabalLead(store, t.project_id, cabal, t.id, t.title);
  if (was === lead.id) return;
  const there = lead.project_id !== t.project_id ? store.getProject(lead.project_id)?.name : undefined;
  const row = store.joinCabal(t.id, lead.id, lead.project_id, t.title, Date.now(), there ? crossRow(store, lead, t.project_id, t.title).id : rowId, t.project_id);
  runner.emit(t.id, 'note', { text: `${by} put this minion on ${there ? `${there} ` : ''}#${lead.number}'s cabal board.` });
  if (there) memberJoined(app, lead, t.id, row, by);
  for (const l of new Set([was, lead.id])) if (l != null) cabalChanged(app, l);
}

export async function boardFor(app: App, leadId: number): Promise<Board | null> {
  return readBoard(app.store, leadId, { parked: (t) => app.runner.parked(t) });
}

/** A board was written (src/cabal-start.ts cabalChanged). */
const changed = (app: App, _t: unknown, lead: number) => cabalChanged(app, lead);

export const cabalRoutes: Route[] = [
  {
    // The board the minion is on or leads ({ board: null } for none). ?text=1 adds the compact text cabal_board reads.
    method: 'GET',
    path: '/api/tickets/:ticket/cabal',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, ticket, session, caller }) {
      const lead = cabalLeadOf(app.store, ticket.id);
      const whole = lead == null ? null : await boardFor(app, lead);
      // Who sees a row in another scheme (#2094): an agent reads as its scheme's people would, a person as they are.
      const board = whole && cabalBoardFor(whole, caller ? (p) => p === caller.project_id : (p) => app.store.canSee(session, p));
      const want = url.searchParams.get('timeline') === '1' ? () => timelineText(app.store, board!) : url.searchParams.get('text') === '1' ? () => boardText(board!, ticket) : null;
      return json(res, 200, { lead, board, ...(want ? { text: board ? want() : null } : {}) });
    },
  },
  {
    // The board page (#/p/N/cabal/M): the board led by minion #M of this scheme, for people.
    method: 'GET',
    path: '/api/projects/:project/cabal/:number',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler({ res, app, project, params, session }) {
      const lead = app.store.getTicketByNumber(project.id, Number(params.number));
      const whole = lead && app.store.getCabal(lead.id) ? await boardFor(app, lead.id) : null;
      if (!whole) throw new HttpError(404, `#${String(params.number).slice(0, 20)} leads no Plot in this scheme`);
      const board = cabalBoardFor(whole, (p) => app.store.canSee(session, p));
      return json(res, 200, { lead: lead!.id, board });
    },
  },
  {
    // cabal_board's writes, by the calling minion: note and ask are a member's, the rest the lead's.
    method: 'POST',
    path: '/api/tickets/:ticket/cabal',
    who: ['minion'],
    refuse: 'Only a Plot member or its lead writes on its board',
    async handler({ req, res, app, ticket }) {
      const { store, runner } = app;
      const body = await readJson(req);
      const action = String(body.action ?? '');
      const leads = !!store.getCabal(ticket.id);
      const own = store.cabalRowOf(ticket.id);
      const lead0 = own ? store.getTicket(own.lead_id) : undefined;
      const author = `${lead0 && lead0.project_id !== ticket.project_id ? `${store.getProject(ticket.project_id)?.name} ` : ''}#${ticket.number} ${ticket.title}`;
      // A minion on no board makes its own with its first lead write: that's how a lead lays out its roster.
      const leadOnly = () => {
        if (own && !leads) throw new HttpError(403, `Only the Plot's lead does ${action}: ask it instead (action ask)`);
        if (!leads && ['answer', 'row', 'log', 'red'].includes(action)) store.ensureCabal(ticket.id, ticket.project_id);
        if (action === 'form' && !leads) throw new HttpError(409, 'Lay out your roster first (action row), then post it with form');
      };
      if (action === 'note' || action === 'ask') {
        if (!own) throw new HttpError(409, leads ? `You lead this Plot: ${action === 'ask' ? 'answer asks, and log decisions with action log' : 'set notes on rows with action row'}` : 'You are not on a Plot board');
        const lead = store.getTicket(own.lead_id);
        if (!lead) throw new HttpError(404, "This cabal's lead is gone");
        if (action === 'note') {
          if (body.note === undefined && body.files === undefined) throw new HttpError(400, 'note needs note, files or both');
          store.updateCabalRow(own.id, { ...(body.note !== undefined ? { note: body.note === null ? '' : line(body.note, 'note', 200), note_at: Date.now() } : {}), ...(body.files !== undefined ? { files: files(body.files) } : {}) });
          changed(app, ticket, lead.id);
          return json(res, 200, { ok: true });
        }
        const text = line(body.text, 'Ask', 1000);
        const blocking = body.blocking === true;
        const id = store.addCabalAsk(lead.id, ticket.id, text, blocking);
        // A blocking ask wakes the lead; any other is held mail it reads at its next wake with the rest (spec, "Claims").
        const held = runner.relayMinion(ticket.id, lead.id, author, `Plot ask ${id}${blocking ? ', blocking' : ''}: ${text}\n(Answer with cabal_board, action answer, ask ${id}.)`, blocking, blocking);
        changed(app, ticket, lead.id);
        return json(res, 200, { ask: id, held, lead: lead.number });
      }
      leadOnly();
      if (action === 'answer') {
        const ask = store.cabalAsk(Number(body.ask));
        if (!ask || ask.lead_id !== ticket.id) throw new HttpError(404, `No ask ${String(body.ask).slice(0, 20)} on your board`);
        if (ask.answered_at != null) throw new HttpError(409, `Ask ${ask.id} is already answered`);
        const text = line(body.text, 'Answer', 2000);
        store.answerCabalAsk(ask.id, text, author);
        const to = store.getTicket(ask.ticket_id);
        // The asker hears back the way it asked: woken if it was blocked, else held mail.
        const held = to && to.status !== 'closed' ? runner.relayMinion(ticket.id, to.id, author, `Answer to your Plot ask ${ask.id} ("${ask.text.slice(0, 120)}"): ${text}`, !!ask.blocking, !!ask.blocking) : null;
        changed(app, ticket, ticket.id);
        return json(res, 200, { ok: true, held, to: to?.number ?? null });
      }
      if (action === 'row') {
        const fields: CabalRowFields = {};
        for (const [k, max] of [
          ['label', 12],
          ['title', 120],
          ['lane', 40],
          ['after', 60],
          ['role', 40],
          ['note', 200],
        ] as const) {
          if (body[k] === undefined) continue;
          fields[k] = body[k] === null || body[k] === '' ? '' : line(body[k], k, max);
        }
        if (fields.note !== undefined) fields.note_at = Date.now();
        if (body.files !== undefined) fields.files = body.files === null ? '' : files(body.files);
        // What a start needs (#2091): its handoff, model, effort and expected dollars, shown on the forming card.
        if (body.handoff !== undefined) fields.handoff = body.handoff === null || body.handoff === '' ? '' : await handoffPath(app, ticket.project_id, body.handoff);
        if (body.model !== undefined) fields.model = body.model === null ? '' : String(oneOf(body.model, MODELS, 'model'));
        if (body.effort !== undefined) fields.effort = body.effort === null ? '' : String(oneOf(body.effort, EFFORTS, 'effort'));
        if (body.cost !== undefined) {
          const c = body.cost === null ? null : Number(body.cost);
          if (c != null && !(Number.isFinite(c) && c > 0 && c <= 10_000)) throw new HttpError(400, 'cost is dollars, more than 0');
          fields.cost = c;
        }
        // The scheme its member runs in (#2094): another one only if the lead's person is in it, as message_taskmaster reaches.
        if (body.scheme !== undefined) {
          const want = String(body.scheme ?? '').trim();
          const home = store.getProject(ticket.project_id)!;
          fields.project_id = !want || want.toLowerCase() === home.name.toLowerCase() || want === String(home.id) ? null : schemeTarget(app, ticket, want).project.id;
        }
        if (body.minion !== undefined) {
          if (body.minion !== null && rowScheme(ticket, { project_id: fields.project_id !== undefined ? fields.project_id : (store.cabalRow(Number(body.row))?.project_id ?? null) }) !== ticket.project_id)
            throw new HttpError(400, "A row in another scheme gets its member from that scheme's Taskmaster: ask it with message_taskmaster");
          const t = body.minion === null ? null : store.getTicketByNumber(ticket.project_id, Number(body.minion));
          if (body.minion !== null && (!t || t.kind === 'coordinator')) throw new HttpError(404, `No minion #${String(body.minion).slice(0, 20)} in this scheme`);
          if (t?.id === ticket.id) throw new HttpError(400, 'That is you: the lead has no row of its own');
          if (t && store.getCabal(t.id)) throw new HttpError(400, `#${t.number} leads a Plot, so it can't be on another's board`);
          const other = t ? store.cabalRowOf(t.id) : undefined;
          if (other && other.id !== Number(body.row)) throw new HttpError(409, `#${t!.number} already has a row${other.lead_id === ticket.id ? ` (row ${other.id})` : ' on another board'}`);
          fields.ticket_id = t?.id ?? null;
        }
        if (body.row === undefined || body.row === null) {
          if (body.remove) throw new HttpError(400, 'remove needs row');
          if (!fields.title && !fields.label && fields.ticket_id == null) throw new HttpError(400, 'A new row needs a title, a label or a minion');
          const id = store.addCabalRow(ticket.id, fields);
          changed(app, ticket, ticket.id);
          return json(res, 200, { row: id });
        }
        const row = store.cabalRow(Number(body.row));
        if (!row || row.lead_id !== ticket.id) throw new HttpError(404, `No row ${String(body.row).slice(0, 20)} on your board`);
        // A member the lead started stays on its row while open: the row is what makes it the lead's own, and it counts in the width.
        const member = row.approved_at != null && row.ticket_id != null ? store.getTicket(row.ticket_id) : undefined;
        if (row.ticket_id != null && fields.project_id !== undefined && fields.project_id !== row.project_id) throw new HttpError(409, `Row ${row.id} is started: its scheme stays`);
        if (member && member.status !== 'closed' && (body.remove === true || (fields.ticket_id !== undefined && fields.ticket_id !== row.ticket_id))) throw new HttpError(409, `#${member.number} is open: its row stays on the board until it is dismissed`);
        if (body.remove === true) store.deleteCabalRow(row.id);
        else {
          // A change to what the forming card showed takes back its go: a changed row needs a new card.
          if (row.approved_at != null && row.ticket_id == null && APPROVED_FIELDS.some((k) => fields[k] !== undefined && fields[k] !== row[k])) Object.assign(fields, { approved_by: null, approved_at: null, next_at: null, asked_at: null });
          store.updateCabalRow(row.id, fields);
        }
        changed(app, ticket, ticket.id);
        if (body.remove === true) retroCheck(app, ticket.id);
        return json(res, 200, { row: row.id, removed: body.remove === true });
      }
      if (action === 'log') {
        const id = store.addCabalLog(ticket.id, author, line(body.text, 'Log line', 500));
        changed(app, ticket, ticket.id);
        return json(res, 200, { log: id });
      }
      if (action === 'form') {
        const r = await postForming(app, store.getTicket(ticket.id)!, body.width);
        return json(res, 200, r);
      }
      if (action === 'red') {
        const red = body.text == null || body.text === '' ? null : line(body.text, 'Red-run line', 500);
        const was = store.getCabal(ticket.id)!.red;
        store.setCabalRed(ticket.id, red);
        // Kept on the log too: the retro's timeline needs when each red started and cleared (#2096).
        if (red !== was) store.addCabalLog(ticket.id, author, red == null ? 'Red cleared' : `Red: ${red}`.slice(0, 500));
        changed(app, ticket, ticket.id);
        return json(res, 200, { ok: true });
      }
      throw new HttpError(400, 'action must be read, note, ask, answer, row, log, red or form');
    },
  },
  {
    // cabal_start (#2091): the lead starts a row its forming card approved, or it waits as next up past the width.
    method: 'POST',
    path: '/api/tickets/:ticket/cabal/start',
    who: ['minion'],
    refuse: "Only a Plot's lead starts its members",
    async handler({ req, res, app, ticket }) {
      const body = await readJson(req);
      return json(res, 200, await cabalStart(app, app.store.getTicket(ticket.id)!, body.row, body.text));
    },
  },
  {
    // A lead's message_taskmaster (#2094): a start, unseal, stop or seal for its own row in another scheme, asked of that scheme's Taskmaster.
    method: 'POST',
    path: '/api/tickets/:ticket/cabal/taskmaster',
    who: ['minion'],
    refuse: "Only a Plot's lead asks another scheme's Taskmaster about its members",
    async handler({ req, res, app, ticket }) {
      const body = await readJson(req);
      return json(res, 200, await cabalTaskmaster(app, app.store.getTicket(ticket.id)!, body));
    },
  },
  {
    // cabal_member (#2091): the lead unseals, stops or reseals one of its own members.
    method: 'POST',
    path: '/api/tickets/:ticket/cabal/member',
    who: ['minion'],
    refuse: "Only a Plot's lead acts on its members",
    async handler({ req, res, app, ticket }) {
      const body = await readJson(req);
      return json(res, 200, { text: await memberAction(app, app.store.getTicket(ticket.id)!, body.action, body.minion) });
    },
  },
];
