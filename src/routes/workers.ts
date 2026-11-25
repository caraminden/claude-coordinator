// The worker pool (#1868, src/turn-line.ts) as the Status page's Workers tile reads and sets it: its size and the pause.
// Any person, admin or not: the pool is all of Citadel's.
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import { POOL } from '../turn-line.ts';

const SIZE_MAX = 50;

function tile({ runner, store }: Pick<App, 'runner' | 'store'>) {
  const { people, ...rest } = runner.turnLine.summary();
  return { ...rest, min: POOL.min, max: POOL.max, people: people.map(({ person, ...p }) => ({ name: store.getUser(person)?.name ?? 'Automatic', ...p })) };
}

export const workerRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/workers',
    who: ['person'],
    handler: ({ res, app }) => json(res, 200, tile(app)),
  },
  {
    method: 'PUT',
    path: '/api/workers',
    who: ['person'],
    handler: async ({ req, res, app, session }) => {
      const body: unknown = await readJson(req);
      const { size, pause } = (body ?? {}) as { size?: unknown; pause?: unknown };
      // One at a time: a wider pool with a pause would start turns on the way to the pause.
      if ((size === undefined) === (pause === undefined)) throw new HttpError(400, 'size or pause is needed, not both');
      if (size !== undefined && size !== null && !(Number.isInteger(size) && Number(size) >= 1 && Number(size) <= SIZE_MAX)) throw new HttpError(400, `size is a whole number from 1 to ${SIZE_MAX}, or null for Auto`);
      if (pause !== undefined && pause !== true && pause !== false && pause !== 'stop') throw new HttpError(400, "pause is true, 'stop' or false");
      const line = app.runner.turnLine;
      if (size !== undefined) line.setSize(size === null ? null : Number(size), session.name);
      if (pause !== undefined) line.setPause(pause, session.name);
      return json(res, 200, tile(app));
    },
  },
];
