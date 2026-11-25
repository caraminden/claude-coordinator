// A minion's time log (#1991): what the progress line opens to. src/time-log.ts cuts it; a reader thread answers it (READER_ROUTES).
import { HttpError, json, type Route } from '../http.ts';
import { timeLog } from '../time-log.ts';

export const timeLogRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/tickets/:ticket/time-log',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler({ res, app, ticket }) {
      // A Taskmaster's chat never ends, so it has no log.
      if (ticket.kind === 'coordinator') throw new HttpError(404, 'Only minions have a time log');
      return json(res, 200, await timeLog(app.store, ticket));
    },
  },
];
