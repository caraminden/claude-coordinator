// Minion day strips (#1996): every minion of a scheme that went live on a day, from its start to live. src/day-strips.ts
// cuts them from each one's time log; a reader thread answers it (READER_ROUTES), so the main thread never folds a day.
import { dayStartMs, dayStripsKept } from '../day-strips.ts';
import { HttpError, json, type Route } from '../http.ts';
import { pacificDay } from '../pacific.ts';

export const dayStripsRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects/:project/day-strips',
    who: ['person', 'taskmaster'],
    everyScheme: true,
    async handler({ res, app, project, url }) {
      const day = url.searchParams.get('day') ?? pacificDay(Date.now());
      if (dayStartMs(day) == null) throw new HttpError(400, 'day must be a date, like 2026-11-25');
      return json(res, 200, await dayStripsKept(app.store, project.id, day));
    },
  },
];
