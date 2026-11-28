// The runner pool (Build 11, src/runner-pool.ts): GET /api/ci/pool, read by the CI page beside /api/ci and by the Machines
// page; PATCH /api/projects/:project/ci-pool, the per-scheme switch between the pool and standing runners (P3).
import { HttpError, json, readJson, type Route } from '../http.ts';
import { managesMachine } from '../access.ts';
import { poolKey, poolOn } from '../runner-pool.ts';
import { poolLocked } from '../ci-runner.ts';
import { offWords } from '../owner-busy.ts';

export const ciPoolRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/ci/pool',
    who: ['person'],
    refuse: 'Only people read the runner pool',
    // The jobs of the schemes they can see, each with its place in the whole line; the room and what runs there of each
    // machine their Machines page shows (their own; an admin's all), another scheme's job by its size only; the schemes they
    // see that are on the pool. Null with no pool.
    handler: ({ res, app, session }) => {
      const pool = app.pool?.view();
      if (!pool) return json(res, 200, null);
      const sees = (id: number) => app.store.canSee(session, id);
      json(res, 200, {
        ...pool,
        line: pool.line.filter((j) => sees(j.scheme)),
        total: pool.line.length,
        machines: pool.machines
          .filter((m) => {
            const row = app.store.getMachine(m.id);
            return !!row && managesMachine(session, row);
          })
          .map((m) => {
            // A Pause or "Run CI anyway" since the pool's last pass shows at once, not after the next one (P4).
            const use = m.use && app.ownerBusy ? app.ownerBusy.use(m.id) : m.use;
            const off = use && m.off !== 'is offline' ? offWords(use) : m.off;
            return { ...m, use, off, running: m.running.map((r) => (sees(r.scheme) ? r : { ...r, repo: '', scheme: 0, name: "another scheme's job" })) };
          }),
        pooled: app.store
          .listProjects()
          .filter((p) => sees(p.id) && poolOn(app.store, p.id))
          .map((p) => p.id),
      });
    },
  },
  {
    // Any member flips it, as any scheme setting (#621). On: the pool starts the scheme's jobs and its standing runners come
    // off (src/ci-auto.ts, within its next pass); off: they come back the old way. A runner already on a job finishes it.
    method: 'PATCH',
    path: '/api/projects/:project/ci-pool',
    who: ['person', 'taskmaster'],
    async handler({ req, res, app, project }) {
      const { on } = await readJson(req, 1_000);
      if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true (the runner pool) or false (standing runners)');
      const locked = poolLocked(project!.name, on);
      if (locked) throw new HttpError(409, locked);
      if (on) app.store.setSetting(poolKey(project!.id), true);
      else app.store.deleteSetting(poolKey(project!.id));
      console.log(`Runner pool: ${project!.name} is now on ${on ? 'the runner pool' : 'its standing runners'}`);
      json(res, 200, { on });
    },
  },
];
