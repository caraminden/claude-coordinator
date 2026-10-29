// The app as a whole: signing in and out, health for tools/deploy.sh, who you are, the event stream,
// costs and which minion owns each PR.
import { looksLikeUrl, NOT_PEOPLE } from '../auth.ts';
import { costDays, dayBudget } from '../costs.ts';
import { prOwners } from '../prlinks.ts';
import { clientIp, HttpError, isSecure, json, readJson, type Route } from '../http.ts';

const MAX_CLIENTS = 100;

/** Display names end up in prompts as "[Name]: ...", so keep them plain. */
function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f\[\]:]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new HttpError(400, 'Name is required');
  if (looksLikeUrl(name)) throw new HttpError(400, 'That looks like a web address. Type your name.');
  return name.slice(0, 40);
}

export const appRoutes: Route[] = [
  {
    method: 'POST', path: '/api/login', who: 'anyone',
    async handler({ req, res, app: { auth } }) {
      const ip = clientIp(req);
      const body = await readJson(req);
      const name = cleanName(body.name);
      if (NOT_PEOPLE.some((n) => n.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'That name is reserved');
      // Checked right before the password (no await in between) so parallel bursts are counted.
      if (auth.limited(ip)) throw new HttpError(429, 'Too many attempts; try again later');
      if (!auth.checkPassword(ip, String(body.password ?? ''))) throw new HttpError(401, 'Wrong password');
      return json(res, 200, { name }, { 'Set-Cookie': auth.issueCookie(name, isSecure(req)) });
    },
  },
  { method: 'POST', path: '/api/logout', who: 'anyone', handler: ({ res, app }) => json(res, 200, {}, { 'Set-Cookie': app.auth.clearCookie() }) },
  {
    // For tools/deploy.sh, so no login: is this server up, which code it booted from, which front end
    // it serves, and that it reloads public/ on SIGHUP (an older server would exit on one).
    method: 'GET', path: '/api/health', who: 'anyone',
    // interruptible: running turns a restart would stop (they don't run in a unit of their own).
    handler: ({ res, app }) => json(res, 200, { ok: true, commit: app.bootCommit, version: app.assetVersion, reload: 'sighup', interruptible: app.runner.interruptible(), preview: app.preview }),
  },
  {
    method: 'GET', path: '/api/me', who: ['person', 'taskmaster', 'minion'],
    handler({ req, res, app: { store }, session, caller }) {
      // The app's public address, as Caddy forwards it, so start_preview can hand out a full link.
      const host = req.headers['x-forwarded-host'];
      const origin = typeof host === 'string' && !caller ? `${isSecure(req) ? 'https' : 'http'}://${host}` : null;
      if (origin && store.getSetting('public_origin') !== origin) store.setSetting('public_origin', origin);
      return json(res, 200, { name: session.name });
    },
  },
  {
    method: 'GET', path: '/api/stream', who: ['person'],
    handler({ req, res, app }) {
      if (app.clients.size >= MAX_CLIENTS) throw new HttpError(503, 'Too many open streams');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', version: app.assetVersion, usage: app.runner.usage })}\n\n`);
      app.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        app.clients.delete(res);
      });
    },
  },
  { method: 'GET', path: '/api/costs', who: ['person'], handler: ({ res, app: { store, runner } }) => json(res, 200, { days: costDays(store), dayBudget: dayBudget(store, runner.usage?.weekly) }) },
  // Which minion owns each PR, so the front end can open it instead of GitHub (src/prlinks.ts).
  { method: 'GET', path: '/api/prs', who: ['person'], handler: async ({ res, app: { store } }) => json(res, 200, await prOwners(store.listProjects(), (id) => store.listTickets(id))) },
];
