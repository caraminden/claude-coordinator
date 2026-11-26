// A minion's time log (#1991): what the progress line opens to. src/time-log.ts cuts it; a reader thread answers it (READER_ROUTES).
// Explain (#1994): Haiku's reading of each part, on the presser's own login, kept for everyone (src/time-log-explain.ts).
import { join } from 'node:path';
import { setImmediate as yieldNow } from 'node:timers/promises';
import type { EventRow } from '../db-rows.ts';
import type { Store } from '../db.ts';
import { HttpError, json, type Route } from '../http.ts';
import { runOneShot } from '../review-describe.ts';
import { EXPLAIN_MODEL, EXPLAIN_ROUNDS, EXPLAIN_SYSTEM, type ExplainLine, explainInput, explainView, mergeReading, nothingRead, readExplain, readReading, rowKey } from '../time-log-explain.ts';
import { timeLog, type LogTicket } from '../time-log.ts';
import { thrown } from '../thrown.ts';
import { turnEnv } from '../turn-launch.ts';

/** The log and its saved reading, as the page reads them. */
async function logWithExplain(store: Store, ticket: LogTicket & { id: number }) {
  const log = await timeLog(store, ticket);
  const saved = readExplain(store.timeLogExplain(ticket.id));
  return { ...log, explain: explainView(saved, log, saved.presses.length ? store.timeLogNewSince(ticket.id, saved.upTo) : null) };
}

/** Everything an Explain reads from `after` on, a page at a time so other requests run between pages. */
async function eventsFrom(store: Store, id: number, after: number): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (;;) {
    const rows = store.explainEvents(id, after, 500);
    out.push(...rows);
    if (rows.length < 500) return out;
    after = rows.at(-1)!.id;
    await yieldNow();
  }
}

export const timeLogRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/tickets/:ticket/time-log',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler({ res, app, ticket }) {
      // A Taskmaster's chat never ends, so it has no log.
      if (ticket.kind === 'coordinator') throw new HttpError(404, 'Only minions have a time log');
      return json(res, 200, await logWithExplain(app.store, ticket));
    },
  },
  {
    // A press of Explain: the parts with nothing read yet, or with new events since, on the presser's own Claude login
    // (sender pays). It never touches the minion: no event in its chat, no message in its queue, nothing in its folder.
    method: 'POST',
    path: '/api/tickets/:ticket/time-log/explain',
    who: ['person'],
    everyScheme: true,
    refuse: 'Only a person explains a time log, on their own Claude login',
    async handler({ res, app, session, ticket }) {
      if (ticket.kind === 'coordinator') throw new HttpError(404, 'Only minions have a time log');
      const uid = session.uid!; // who: ['person']
      const place = app.claude.place(uid);
      if (!place) throw new HttpError(409, "Your Claude plan isn't linked (Settings → Your account), so there's no login of yours to run Explain on");
      const store = app.store;
      const log = await timeLog(store, ticket);
      let saved = readExplain(store.timeLogExplain(ticket.id));
      const view = explainView(saved, log, saved.presses.length ? store.timeLogNewSince(ticket.id, saved.upTo) : null);
      if (view.writing) throw new HttpError(409, `${view.writing.by} is writing it now`);
      if (!view.fresh.length) return json(res, 200, await logWithExplain(store, ticket));
      const by = session.name ?? 'Someone';
      const mine = { by, at: Date.now() };
      store.saveTimeLogExplain(ticket.id, JSON.stringify({ ...saved, writing: mine }));
      try {
        // From a while before the first new part, so a wait has the minion's last words before it.
        const from = Math.min(...log.rows.filter((r) => view.fresh.includes(rowKey(r)!)).map((r) => r.start!));
        const after = saved.presses.length ? Math.max(0, store.eventIdAt(from - 30 * 60_000) - 1) : 0;
        const events = await eventsFrom(store, ticket.id, after);
        // A long log goes in a few calls; a later call that fails keeps what the earlier ones read.
        const read = new Map<string, ExplainLine[]>();
        let cost: number | null = null;
        let left = view.fresh;
        for (let round = 0; round < EXPLAIN_ROUNDS && left.length; round++) {
          const input = await explainInput(ticket.title, log, events, left);
          try {
            const got = await runOneShot(place, `Log (times Pacific):\n\n${input.text}`, {
              claudeBin: process.env.CLAUDE_BIN ?? 'claude',
              hostEnv: turnEnv(process.env),
              cwd: join(app.claude.turnsDir(uid), 'time-log-explain'),
              timeoutMs: 3 * 60_000,
              model: EXPLAIN_MODEL,
              effort: 'low',
              system: EXPLAIN_SYSTEM,
            });
            for (const [key, lines] of readReading(got.text, input.labels, input.parts)) read.set(key, lines);
            if (got.cost !== null) cost = (cost ?? 0) + got.cost;
          } catch (err) {
            if (!read.size) throw err;
            break;
          }
          const sent = new Set(input.parts.values());
          left = left.filter((key) => !sent.has(key));
        }
        if (nothingRead(read)) throw new Error('Haiku wrote nothing the chat backs up');
        // Every fresh part loses its old lines, read or not: one left out stays fresh (no reading) for the next press.
        saved = readExplain(store.timeLogExplain(ticket.id));
        const upTo = events.at(-1)?.id ?? saved.upTo;
        store.saveTimeLogExplain(ticket.id, JSON.stringify(mergeReading(saved, log, read, view.fresh, { by, at: Date.now(), cost, parts: read.size }, upTo)));
      } catch (err) {
        // Clear only this press's marker: one that ran past the limit may have a newer press behind it.
        const now = readExplain(store.timeLogExplain(ticket.id));
        if (now.writing?.at === mine.at && now.writing.by === by) store.saveTimeLogExplain(ticket.id, JSON.stringify({ ...now, writing: undefined }));
        throw new HttpError(502, String(thrown(err).message ?? err).replace(/^The agent didn't answer: /, ''));
      }
      return json(res, 200, await logWithExplain(store, ticket));
    },
  },
];
