// The app as a whole: signing in and out, health for tools/deploy.sh, who you are, the event stream,
// costs and which minion owns each PR.
import { hashPassword, looksLikeUrl, NOT_PEOPLE } from '../auth.ts';
import { costDays, dayBudget } from '../costs.ts';
import { fallbacks } from '../fallbacks.ts';
import { prOwners } from '../prlinks.ts';
import { clientIp, HttpError, isSecure, json, readJson, type Ctx, type Route } from '../http.ts';

const MAX_CLIENTS = 100;

/** Display names end up in prompts as "[Name]: ...", so keep them plain. */
export function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f\[\]:]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new HttpError(400, 'Name is required');
  if (looksLikeUrl(name)) throw new HttpError(400, 'That looks like a web address. Type your name.');
  if (NOT_PEOPLE.some((n) => n.toLowerCase() === name.toLowerCase()) || /^#\d/.test(name)) throw new HttpError(400, 'That name is reserved');
  return name.slice(0, 40);
}

/** What someone signs in with: short, plain, no spaces. */
export function cleanLogin(v: unknown): string {
  const login = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(login)) throw new HttpError(400, 'A login is 2 to 32 letters, digits, dots, dashes or underscores');
  return login;
}

export async function newPasswordHash(v: unknown): Promise<string> {
  if (typeof v !== 'string' || v.length < 10 || v.length > 200) throw new HttpError(400, 'A password is 10 to 200 characters');
  return hashPassword(v);
}

/** Who you are, as the front end needs it. */
function meView({ store, claude, runner }: Ctx['app'], session: Ctx['session']) {
  const user = session.uid ? store.getUser(session.uid) : undefined;
  return { id: user?.id ?? null, name: session.name, login: user?.login ?? null, admin: !!session.admin, turns: !!user?.server_login || (!!user && claude.linked(user.id) === 'linked'), payer: runner.payerOf(user?.id) };
}

export const appRoutes: Route[] = [
  {
    method: 'POST', path: '/api/login', who: 'anyone',
    async handler({ req, res, app: { auth } }) {
      const ip = clientIp(req);
      const body = await readJson(req);
      // `name` is what sign-in sent before per-person logins (and tools/boot-check.ts still does).
      const login = String(body.login ?? body.name ?? '').trim().slice(0, 64);
      if (!login) throw new HttpError(400, 'Login is required');
      if (auth.limited(ip)) throw new HttpError(429, 'Too many attempts; try again later');
      const user = await auth.signIn(ip, login, String(body.password ?? '').slice(0, 1000));
      if (!user) throw new HttpError(401, 'Wrong login or password');
      return json(res, 200, { name: user.name }, { 'Set-Cookie': auth.issueCookie(user, isSecure(req)) });
    },
  },
  {
    // An invite (or password-reset) link: who it is for, and setting the password, which signs them in.
    method: ['GET', 'POST'], path: '/api/invite/:token', who: 'anyone',
    async handler({ req, res, params, app: { auth, store } }) {
      const ip = clientIp(req);
      if (auth.limited(ip)) throw new HttpError(429, 'Too many attempts; try again later');
      const user = auth.inviteUser(ip, params.token);
      if (!user) throw new HttpError(404, 'This link has expired or was already used. Ask for a new one.');
      if (req.method === 'GET') return json(res, 200, { name: user.name, login: user.login });
      const hash = await newPasswordHash((await readJson(req)).password);
      store.updateUser(user.id, { password_hash: hash, invite_hash: null, invite_expires: null });
      return json(res, 200, { name: user.name }, { 'Set-Cookie': auth.issueCookie(user, isSecure(req)) });
    },
  },
  { method: 'POST', path: '/api/logout', who: 'anyone', handler: ({ res, app }) => json(res, 200, {}, { 'Set-Cookie': app.auth.clearCookie() }) },
  {
    // For tools/deploy.sh, so no login: is this server up, which code it booted from, which front end
    // it serves, and that it reloads public/ on SIGHUP (an older server would exit on one).
    method: 'GET', path: '/api/health', who: 'anyone',
    // interruptible: running turns a restart would stop (they don't run in a unit of their own); interruptibleTurns:
    // which minions' turns, by id only (#584): deploy.sh names them from the database. fallbacks: jobs
    // systemd-run couldn't put in a unit of their own since the server started, which ran in it instead (#519).
    handler: ({ res, app }) => json(res, 200, { ok: true, commit: app.liveCommit, version: app.assetVersion, reload: 'sighup', interruptible: app.runner.interruptible(), interruptibleTurns: app.runner.interruptibleTurns(), fallbacks: fallbacks.count, preview: app.preview }),
  },
  {
    method: 'GET', path: '/api/me', who: ['person', 'taskmaster', 'minion'],
    handler({ req, res, app, session, caller }) {
      const { store } = app;
      // The app's public address, as Caddy forwards it, so start_preview can hand out a full link.
      const host = req.headers['x-forwarded-host'];
      const origin = typeof host === 'string' && !caller ? `${isSecure(req) ? 'https' : 'http'}://${host}` : null;
      if (origin && store.getSetting('public_origin') !== origin) store.setSetting('public_origin', origin);
      return json(res, 200, caller ? { name: session.name } : meView(app, session));
    },
  },
  {
    method: 'GET', path: '/api/stream', who: ['person'],
    handler({ req, res, app, session }) {
      if (app.clients.size >= MAX_CLIENTS) throw new HttpError(503, 'Too many open streams');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', version: app.assetVersion, usage: app.runner.usageOf(session.uid), codex: app.runner.codexView(session.uid) })}\n\n`);
      app.clients.set(res, session);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        app.clients.delete(res);
      });
    },
  },
  // Every scheme's spend on the server's Claude login, so only for admins.
  { method: 'GET', path: '/api/costs', who: ['person'], access: 'admin', handler: ({ res, app: { store, runner } }) => json(res, 200, { days: costDays(store), dayBudget: dayBudget(store, runner.usage?.weekly) }) },
  // Which minion owns each PR, so the front end can open it instead of GitHub (src/prlinks.ts).
  { method: 'GET', path: '/api/prs', who: ['person'], handler: async ({ res, app: { store }, session }) => {
    const seen = store.visibleProjects(session);
    return json(res, 200, await prOwners(store.listProjects().filter((p) => !seen || seen.has(p.id)), (id) => store.listTickets(id)));
  } },
];
