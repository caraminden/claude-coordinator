// tools/citadel-job (#1890): a job that outlives its turn, started, stopped, or asked about for citadel-wait
// (src/minion-jobs.ts). Jobs queued on a person's lent machine are routes/jobs.ts.
import { HttpError, json, readJson, type Route } from '../http.ts';
import { JobRefused } from '../minion-jobs.ts';

export const minionJobRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/tickets/:ticket/minion-jobs',
    who: ['minion'],
    refuse: 'Only the minion itself can start its jobs',
    async handler({ req, res, app, ticket }) {
      const body = (await readJson(req)) ?? {};
      const text = (k: string, max: number) => (typeof body[k] === 'string' && body[k].length <= max ? (body[k] as string) : '');
      const what = text('what', 100_000);
      try {
        if (body.do === 'stop') return json(res, 200, { stopped: app.minionJobs.stop(ticket.id, text('id', 40) || undefined) });
        if (!what) throw new HttpError(400, 'what is missing');
        const waited = Math.max(0, Number(body.waited) || 0);
        if (body.do === 'ask') return json(res, 200, await app.minionJobs.ask(ticket.id, what, waited));
        if (body.do !== 'start') throw new HttpError(400, 'do must be start, ask or stop');
        return json(res, 202, await app.minionJobs.start(ticket.id, { id: text('id', 40), dir: text('dir', 4096), what, kind: body.kind === 'wait' ? 'wait' : 'job', minutes: body.minutes === undefined ? undefined : Number(body.minutes), waited }));
      } catch (err) {
        if (err instanceof JobRefused) throw new HttpError(err.status, err.message, true);
        throw err;
      }
    },
  },
];
