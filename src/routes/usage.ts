// The usage ledger's two routes (#1306): the front end reports a page opened, and an admin reads what nobody touched in 30 days.
import { json, readJson, type Route } from '../http.ts';
import { pacificDay } from '../pacific.ts';
import { unusedList, usageName } from '../usage-ledger.ts';

export const usageRoutes: Route[] = [
  {
    // A page opened: the route with its numbers replaced (`p/n/settings`), so no scheme or minion id is kept.
    method: 'POST', path: '/api/usage/page', who: ['person'],
    async handler({ req, res, app, session }) {
      const body = await readJson(req);
      if (typeof body.name === 'string') app.store.usage.used('page', usageName(body.name.replace(/^#\/?/, '').replace(/[?#].*$/, '').replace(/\d+/g, 'n')), session.uid ?? session.name);
      return json(res, 200, { ok: true });
    },
  },
  {
    method: 'GET', path: '/api/admin/usage', who: ['person'], access: 'admin',
    handler({ res, app }) {
      const ledger = app.store.usage;
      const rows = ledger.rows();
      return json(res, 200, { since: ledger.since(), items: unusedList(rows, app.usageKnown?.() ?? [], ledger.since(), pacificDay(Date.now())) });
    },
  },
];
