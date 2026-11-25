// Urgent minions and the line for a worker (#1888): a person's press, drag or take-off, a Taskmaster's mark with its reason,
// and the line as its drawer shows it, and Start now (#1957), a worker of its own. What they mean is src/urgent.ts and src/start-now.ts, the line's order src/turn-line.ts.
import type { Ticket } from '../db.ts';
import { HttpError, json, readJson, str, type App, type Route } from '../http.ts';

const REASON_MAX = 200;

/** A minion that can be in the group, or start now. */
function markable(t: Ticket | undefined, what = 'is Urgent'): Ticket {
  if (!t || t.kind === 'coordinator') throw new HttpError(400, `Only a minion ${what}: Taskmasters never wait for a worker`);
  if (t.status === 'closed') throw new HttpError(409, 'It is closed');
  return t;
}

/** The line as `session` may see it: the workers people gave a minion, the Urgent group whole, waiting or not, then the waiting in the order they would start. */
function line({ runner, store }: Pick<App, 'runner' | 'store'>, session: { uid?: number; admin?: boolean }) {
  const minion = (id: number) => {
    const t = store.getTicket(id);
    return t && store.canSee(session, t.project_id) ? { ticket: id, project: t.project_id, number: t.number, title: t.title } : { ticket: null };
  };
  return {
    forced: runner.startNow.list().map((h) => {
      const t = minion(h.ticket);
      return { ...t, waiting: runner.turnLine.has(h.ticket), working: runner.isRunning(h.ticket), since: h.since, ...(t.ticket ? { by: h.by, user: h.user } : {}) };
    }),
    urgent: runner.urgent.list().map((m) => {
      const t = minion(m.ticket);
      // Who and why only to those who see it: a Taskmaster's mark names its scheme.
      return { ...t, waiting: runner.turnLine.has(m.ticket), kind: m.kind, at: m.at, ...(t.ticket ? { by: m.by, reason: m.reason } : {}) };
    }),
    line: runner.turnLine.line().map((w) => ({
      ...minion(w.ticket),
      person: store.getUser(w.person)?.name ?? null,
      since: w.since,
      urgent: w.urgent !== undefined,
      forced: !!runner.startNow.get(w.ticket),
      held: runner.startNow.get(w.ticket) ? runner.turnLine.heldBy(w) : null,
      // Why it stands where it does in its person's share.
      first: !!w.first,
      warm: w.heat === 0,
      fresh: w.heat === 2,
    })),
  };
}

export const urgentRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/line',
    who: ['person'],
    handler: ({ res, app, session }) => json(res, 200, line(app, session)),
  },
  {
    // { on, before? }: before is the minion to go just ahead of, null for the group's end (a drag). on: false takes it out.
    method: 'PUT',
    path: '/api/tickets/:ticket/urgent',
    who: ['person'],
    refuse: 'Only people mark a minion Urgent here; a Taskmaster has mark_urgent',
    async handler({ req, res, app, session, ticket }) {
      const body = await readJson(req);
      const { on, before } = (body ?? {}) as { on?: unknown; before?: unknown };
      if (typeof on !== 'boolean') throw new HttpError(400, 'on is true or false');
      if (before !== undefined && before !== null && !Number.isInteger(before)) throw new HttpError(400, 'before is a minion in the Urgent group, or null for its end');
      const { urgent } = app.runner;
      if (on) {
        markable(app.store.getTicket(ticket.id));
        // One that left the group since the drag began: say so, not a spot the person didn't pick.
        if (before != null && urgent.place(Number(before)) === undefined) throw new HttpError(409, 'That minion is not Urgent any more');
        urgent.set(ticket.id, { kind: 'person', by: session.name }, before as number | null | undefined);
      } else urgent.unset(ticket.id, { kind: 'person', by: session.name });
      return json(res, 200, { urgent: urgent.view(ticket.id) });
    },
  },
  {
    // { on }: true gives a waiting minion a worker of its own, past the pool's size; false is Release, anyone's to press.
    method: 'PUT',
    path: '/api/tickets/:ticket/start-now',
    who: ['person'],
    refuse: 'Only people start a minion now; a Taskmaster has mark_urgent',
    async handler({ req, res, app, session, ticket }) {
      const { on } = ((await readJson(req)) ?? {}) as { on?: unknown };
      if (typeof on !== 'boolean') throw new HttpError(400, 'on is true or false');
      if (session.uid == null) throw new HttpError(403, 'Sign in as yourself to start a minion now');
      const { store, runner } = app;
      const { startNow, turnLine } = runner;
      if (on) {
        const t = markable(store.getTicket(ticket.id), 'starts now');
        if (!turnLine.has(t.id) && startNow.get(t.id)?.user !== session.uid) throw new HttpError(409, "It isn't waiting for a worker");
        const refused = startNow.press(t.id, session.uid, session.name);
        if (refused && 'theirs' in refused) throw new HttpError(409, `${refused.theirs.by} gave it a worker of its own already`);
        if (refused) {
          const holds = refused.full.map((h) => {
            const m = store.getTicket(h.ticket)!;
            return { ticket: m.id, project: m.project_id, number: m.number, title: m.title, since: h.since };
          });
          return json(res, 409, { error: `You hold a worker for ${holds.map((m) => `#${m.number}`).join(' and ')} already, and ${holds.length} is the most`, holds });
        }
        turnLine.force(t.id);
      } else startNow.end(ticket.id);
      return json(res, 200, { start_now: startNow.view(ticket.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:project/urgent',
    who: ['taskmaster'],
    refuse: "Only a scheme's Taskmaster marks its minions Urgent",
    async handler({ req, res, app, project }) {
      const body = await readJson(req);
      const n = Number(String(body?.minion ?? '').replace(/^#/, ''));
      const ticket = Number.isInteger(n) && n > 0 ? app.store.getTicketByNumber(project.id, n) : undefined;
      if (!ticket) throw new HttpError(404, 'No such minion in this scheme');
      const on = body?.on !== false;
      const reason = on ? str(body?.reason, 'reason', REASON_MAX, ': why it goes ahead of the others').replace(/\s+/g, ' ') : '';
      const first = body?.first === true;
      const beforeN = body?.before == null ? undefined : Number(String(body.before).replace(/^#/, ''));
      if (beforeN !== undefined && (!Number.isInteger(beforeN) || beforeN < 1)) throw new HttpError(400, 'before is the number of a minion in the Urgent group');
      if (!on && (first || beforeN !== undefined)) throw new HttpError(400, 'before and first go with marking a minion, not taking it off');
      if (first && beforeN !== undefined) throw new HttpError(400, 'Give before or first, not both');
      const target = beforeN === undefined ? undefined : app.store.getTicketByNumber(project.id, beforeN);
      if (beforeN !== undefined && !target) throw new HttpError(404, `No minion #${beforeN} in this scheme`);
      const how = { kind: 'taskmaster' as const, by: `${project.name} Taskmaster`, ...(on ? { reason } : {}) };
      const { urgent } = app.runner;
      let refused: string | null;
      if (!on) refused = urgent.unset(ticket.id, how);
      else if (target || first) refused = urgent.put(markable(ticket).id, how, target ? target.id : 'first');
      else refused = urgent.set(markable(ticket).id, how);
      if (refused) throw new HttpError(409, `#${n} stays as it is: ${refused}`);
      return json(res, 200, { said: on ? `#${n} is Urgent: ${spot(app, ticket.id)}.` : `#${n} is not Urgent.` });
    },
  },
];

const spot = ({ runner: r }: App, id: number) => `${(r.urgent.place(id) ?? 0) + 1} of ${r.urgent.list().length} in the group`;
