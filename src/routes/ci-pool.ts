// The runner pool's line (Build 11 P1, src/runner-pool.ts): GET /api/ci/pool, read by the CI page beside /api/ci.
import { json, type Route } from '../http.ts';

export const ciPoolRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/ci/pool',
    who: ['person'],
    refuse: 'Only people read the runner pool',
    // Watching only: the jobs of the schemes they can see, each with its place in the whole line; null with no pool.
    handler: ({ res, app, session }) => {
      const pool = app.pool?.view();
      json(res, 200, pool ? { ...pool, line: pool.line.filter((j) => app.store.canSee(session, j.scheme)), total: pool.line.length } : null);
    },
  },
];
