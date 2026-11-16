// The app as a whole: signing in and out, health for tools/deploy.sh, who you are, the event stream,
// costs and which minion owns each PR.
import { hashPassword, looksLikeUrl, NOT_PEOPLE, type Session } from '../auth.ts';
import { costDays, dayBudget, spendSplit } from '../costs.ts';
import { fallbacks } from '../fallbacks.ts';
import { prOwners } from '../prlinks.ts';
import { ServiceError } from '../app-services.ts';
import type { Store } from '../db.ts';
import { mayReceive } from '../access.ts';
import { randomUUID } from 'node:crypto';
import { clientIp, HttpError, isSecure, json, readJson, str, type Ctx, type Route } from '../http.ts';

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
    // The front-end error beacon (public/error-beacon.js, #724): one uncaught error or rejection from a page, for the
    // post-deploy watch. Repeats and floods are dropped per person (ClientErrors); the answer is the same either way.
    method: 'POST', path: '/api/client-errors', who: ['person'],
    async handler({ req, res, app, session }) {
      const body = await readJson(req, 8_000);
      const detail = app.health?.clientErrors.take(String(session.uid ?? session.name), body);
      if (detail) app.health?.watch?.record('client-error', detail);
      return json(res, 202, {});
    },
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
      // stream: this tab's id, which its presence heartbeats name (#695).
      const stream = randomUUID();
      res.write(`data: ${JSON.stringify({ type: 'hello', version: app.assetVersion, usage: app.runner.usageOf(session.uid), codex: app.runner.codexView(session.uid), stream })}\n\n`);
      for (const msg of app.presence.snapshot()) if (mayReceive(app.store, session, msg.projectId)) res.write(`data: ${JSON.stringify(msg)}\n\n`);
      app.clients.set(res, session);
      app.presence.open(stream, session.name);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        app.clients.delete(res);
        app.presence.close(stream);
      });
    },
  },
  // A tab's presence heartbeat (#695, public/presence.js): the chat it has open, or null. Starts no turn.
  { method: 'POST', path: '/api/presence', who: ['person'], handler: async ({ req, res, app: { store, presence }, session }) => {
    const body = await readJson(req);
    const ticketId = body?.ticketId == null ? null : Number(body.ticketId);
    if (ticketId !== null) {
      const t = Number.isInteger(ticketId) ? store.getTicket(ticketId) : undefined;
      if (!t || !store.canSee(session, t.project_id)) throw new HttpError(404, 'No such minion');
    }
    // An unknown stream (the server restarted under the tab): its EventSource reconnects and reports under the new id.
    if (!presence.view(String(body?.stream ?? ''), session.name, ticketId)) throw new HttpError(409, 'No such stream');
    return json(res, 200, {});
  } },
  // Every scheme's spend on the server's Claude login, so only for admins.
  { method: 'GET', path: '/api/costs', who: ['person'], access: 'admin', handler: ({ res, app: { store, runner } }) => json(res, 200, { days: costDays(store), dayBudget: dayBudget(store, runner.usageOf(store.serverLoginOwner())?.weekly), split: spendSplit(store) }) },
  // Which minion owns each PR, so the front end can open it instead of GitHub (src/prlinks.ts).
  { method: 'GET', path: '/api/prs', who: ['person'], handler: async ({ res, app: { store }, session }) => {
    const seen = store.visibleProjects(session);
    return json(res, 200, await prOwners(store.listProjects().filter((p) => !seen || seen.has(p.id)), (id) => store.listTickets(id)));
  } },
  // The release monitor (#625, src/releases.ts): the schemes this person may see; ?scope=member keeps those they own or
  // are a member of, for the All view (Josh, 2026-11-13: "all should only show schemes you are a member of").
  { method: 'GET', path: '/api/releases', who: ['person'], handler: ({ res, url, app: { store, releases }, session }) => {
    const member = url.searchParams.get('scope') === 'member' ? store.memberSchemes(session.uid) : null;
    return json(res, 200, { schemes: releases.view((id) => store.canSee(session, id) && (!member || member.has(id))) });
  } },
  // A release card's Deploy button (#629; Cara, 2026-11-12: "Yes, on any target that can deploy"): any member of the
  // target's scheme deploys it at once. Starts it and answers; the releases event follows it.
  { method: 'POST', path: '/api/releases/deploy', who: ['person'], handler: async ({ req, res, app: { store, autoDeploy, releases }, session }) => {
    const { projectId, target } = releaseTarget(store, session, await readJson(req));
    try {
      await autoDeploy.deployNow(projectId, target, store.getUser(session.uid as number)?.name ?? 'a member', session.uid ?? null);
    } catch (err) {
      if (err instanceof ServiceError) throw new HttpError(err.status, err.message);
      throw err;
    }
    releases.poll();
    return json(res, 202, { ok: true });
  } },
  // publish_release (#663; Josh, 2026-11-13: "We should fix things so that any scheme member can publish"): a scheme's
  // Taskmaster or minion releases the Android app of a contraption its scheme owns, on the server, so a container turn can
  // too. The same step as the card's Deploy button (src/auto-deploy.ts), signing-key check and record included.
  { method: 'POST', path: '/api/projects/:project/releases/publish', who: ['taskmaster', 'minion'], handler: async ({ req, res, app: { store, autoDeploy, releases }, caller, params }) => {
    const projectId = Number(params.project);
    const name = str((await readJson(req))?.contraption, 'contraption', 100);
    const c = store.getContraption(name);
    if (!c || c.home_scheme !== projectId) throw new HttpError(403, `${name} isn't one of this scheme's contraptions`);
    const t = autoDeploy.apkOf(projectId, name);
    if (!t) throw new HttpError(404, `${name} has no Android release Citadel can publish: it needs a release workflow and an android/latest.json feed`);
    const by = caller!.kind === 'coordinator' ? `${store.getProject(projectId)?.name ?? 'the'} Taskmaster` : `#${caller!.number}`;
    let said: string | undefined;
    try {
      said = await autoDeploy.deployNow(projectId, t.id, by, store.turnAsker(caller!.id));
    } catch (err) {
      if (err instanceof ServiceError) throw new HttpError(err.status, err.message);
      throw err;
    }
    releases.poll();
    return json(res, 200, { said: said ?? `Started ${t.name}'s release.` });
  } },
  // A target's auto-deploy on or off (#629: "A scheme can turn it off"), from its card, by any member of its scheme.
  { method: 'PUT', path: '/api/releases/auto-deploy', who: ['person'], handler: async ({ req, res, app: { store, autoDeploy, releases }, session }) => {
    const body = await readJson(req);
    const { projectId, target } = releaseTarget(store, session, body);
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
    if (!autoDeploy.setOn(projectId, target, body.on)) throw new HttpError(404, `${target} has no release step Citadel can start`);
    releases.poll();
    return json(res, 200, { on: body.on });
  } },
];

/** The scheme and target a release action names, if the person may see that scheme. */
function releaseTarget(store: Store, session: Session, body: any): { projectId: number; target: string } {
  const projectId = Number(body?.projectId);
  if (!Number.isInteger(projectId) || !store.canSee(session, projectId)) throw new HttpError(404, 'No such scheme');
  return { projectId, target: str(body?.target, 'target') };
}
