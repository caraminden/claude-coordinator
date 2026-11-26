// A cabal's board (#2090, src/cabal-board.ts): read by people (the lead's chat panel and its own page), its lead and its
// members (cabal_board); written by the lead (roster rows, answers, its log, the red-run line) and each member (its own
// note and files, its asks). An ask is held mail to the lead unless it is blocking, which wakes it.
import { type Board, boardText, readBoard } from '../cabal-board.ts';
import type { Store } from '../db.ts';
import type { CabalRowFields } from '../db/cabals.ts';
import type { Ticket } from '../db-rows.ts';
import { type App, HttpError, json, readJson, type Route } from '../http.ts';

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

/** The lead a cabal: #N names, checked (a 400 says why not); `self` is the minion joining, if it exists yet. */
export function cabalLead(store: Store, projectId: number, cabal: unknown, self: number | null): Ticket {
  const n = Number(cabal);
  const lead = Number.isInteger(n) && n > 0 ? store.getTicketByNumber(projectId, n) : undefined;
  if (!lead || lead.kind === 'coordinator') throw new HttpError(400, `cabal must be the #N of a minion in this scheme that leads it: no minion #${String(cabal).slice(0, 20)}`);
  if (lead.id === self) throw new HttpError(400, "A minion can't be on its own cabal: it leads it");
  if (store.cabalRowOf(lead.id)) throw new HttpError(400, `#${n} is on another cabal's board, so it can't lead one`);
  if (self != null && store.getCabal(self)) throw new HttpError(400, "This minion leads a cabal, so it can't join another");
  return lead;
}

/**
 * create_ticket's and update_ticket's cabal (#2090): put a minion on the board of the lead #N in its own scheme (a roster
 * row with its title becomes its row), or take it off with null. A lead can't be a member, nor a member a lead.
 */
export function putOnCabal(app: App, t: Pick<Ticket, 'id' | 'project_id' | 'title'>, cabal: unknown, by: string) {
  const { store, runner } = app;
  const was = store.cabalRowOf(t.id)?.lead_id ?? null;
  if (cabal === null) {
    store.leaveCabal(t.id);
    if (was != null) {
      runner.emit(t.id, 'note', { text: `${by} took this minion off #${store.getTicket(was)?.number}'s cabal board.` });
      app.broadcast({ type: 'cabal', projectId: t.project_id, lead: was });
    }
    return;
  }
  const lead = cabalLead(store, t.project_id, cabal, t.id);
  if (was === lead.id) return;
  store.joinCabal(t.id, lead.id, t.project_id, t.title);
  runner.emit(t.id, 'note', { text: `${by} put this minion on #${lead.number}'s cabal board.` });
  for (const l of new Set([was, lead.id])) if (l != null) app.broadcast({ type: 'cabal', projectId: t.project_id, lead: l });
}

export async function boardFor(app: App, leadId: number): Promise<Board | null> {
  return readBoard(app.store, leadId, { parked: (t) => app.runner.parked(t) });
}

const changed = (app: App, t: Pick<Ticket, 'project_id'>, lead: number) => app.broadcast({ type: 'cabal', projectId: t.project_id, lead });

export const cabalRoutes: Route[] = [
  {
    // The board the minion is on or leads ({ board: null } for none). ?text=1 adds the compact text cabal_board reads.
    method: 'GET',
    path: '/api/tickets/:ticket/cabal',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, ticket }) {
      const lead = cabalLeadOf(app.store, ticket.id);
      const board = lead == null ? null : await boardFor(app, lead);
      return json(res, 200, { lead, board, ...(url.searchParams.get('text') === '1' ? { text: board ? boardText(board, ticket.number) : null } : {}) });
    },
  },
  {
    // The board page (#/p/N/cabal/M): the board led by minion #M of this scheme, for people.
    method: 'GET',
    path: '/api/projects/:project/cabal/:number',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler({ res, app, project, params }) {
      const lead = app.store.getTicketByNumber(project.id, Number(params.number));
      const board = lead && app.store.getCabal(lead.id) ? await boardFor(app, lead.id) : null;
      if (!board) throw new HttpError(404, `#${String(params.number).slice(0, 20)} leads no cabal in this scheme`);
      return json(res, 200, { lead: lead!.id, board });
    },
  },
  {
    // cabal_board's writes, by the calling minion: note and ask are a member's, the rest the lead's.
    method: 'POST',
    path: '/api/tickets/:ticket/cabal',
    who: ['minion'],
    refuse: 'Only a cabal member or its lead writes on its board',
    async handler({ req, res, app, ticket }) {
      const { store, runner } = app;
      const body = await readJson(req);
      const action = String(body.action ?? '');
      const leads = !!store.getCabal(ticket.id);
      const own = store.cabalRowOf(ticket.id);
      const author = `#${ticket.number} ${ticket.title}`;
      // A minion on no board makes its own with its first lead write: that's how a lead lays out its roster.
      const leadOnly = () => {
        if (own && !leads) throw new HttpError(403, `Only the cabal's lead does ${action}: ask it instead (action ask)`);
        if (!leads && ['answer', 'row', 'log', 'red'].includes(action)) store.ensureCabal(ticket.id, ticket.project_id);
      };
      if (action === 'note' || action === 'ask') {
        if (!own) throw new HttpError(409, leads ? `You lead this cabal: ${action === 'ask' ? 'answer asks, and log decisions with action log' : 'set notes on rows with action row'}` : 'You are not on a cabal board');
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
        const held = runner.relayMinion(ticket.id, lead.id, author, `Cabal ask ${id}${blocking ? ', blocking' : ''}: ${text}\n(Answer with cabal_board, action answer, ask ${id}.)`, blocking, blocking);
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
        const held = to && to.status !== 'closed' ? runner.relayMinion(ticket.id, to.id, author, `Answer to your cabal ask ${ask.id} ("${ask.text.slice(0, 120)}"): ${text}`, !!ask.blocking, !!ask.blocking) : null;
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
        if (body.minion !== undefined) {
          const t = body.minion === null ? null : store.getTicketByNumber(ticket.project_id, Number(body.minion));
          if (body.minion !== null && (!t || t.kind === 'coordinator')) throw new HttpError(404, `No minion #${String(body.minion).slice(0, 20)} in this scheme`);
          if (t?.id === ticket.id) throw new HttpError(400, 'That is you: the lead has no row of its own');
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
        if (body.remove === true) store.deleteCabalRow(row.id);
        else store.updateCabalRow(row.id, fields);
        changed(app, ticket, ticket.id);
        return json(res, 200, { row: row.id, removed: body.remove === true });
      }
      if (action === 'log') {
        const id = store.addCabalLog(ticket.id, author, line(body.text, 'Log line', 500));
        changed(app, ticket, ticket.id);
        return json(res, 200, { log: id });
      }
      if (action === 'red') {
        store.setCabalRed(ticket.id, body.text == null || body.text === '' ? null : line(body.text, 'Red-run line', 500));
        changed(app, ticket, ticket.id);
        return json(res, 200, { ok: true });
      }
      throw new HttpError(400, 'action must be read, note, ask, answer, row, log or red');
    },
  },
];
