// The app as a whole: signing in and out, health for tools/deploy.sh, who you are, the event stream,
// costs and which minion owns each PR.
import { hashPassword, looksLikeUrl, NOT_PEOPLE, type Session } from '../auth.ts';
import { costDays, hostWeek, spendSplit, weekLimit, whereItWent } from '../costs.ts';
import { fallbacks } from '../fallbacks.ts';
import { prOwners } from '../prlinks.ts';
import { ServiceError } from '../app-services.ts';
import type { ContraptionRow, Store } from '../db.ts';
import { hasKey } from '../release-key.ts';
import { mayReceive } from '../access.ts';
import { randomUUID } from 'node:crypto';
import { clientIp, HttpError, isSecure, json, readJson, str, type App, type Ctx, type Route } from '../http.ts';
import { optOutKey } from '../replay-keep.ts';
import { ordinal } from '../waits.ts';

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
  return { id: user?.id ?? null, name: session.name, login: user?.login ?? null, admin: !!session.admin, turns: !!user?.server_login || (!!user && claude.linked(user.id) === 'linked'), payer: runner.payerOf(user?.id), keepChats: !!user && !store.getSetting<boolean>(optOutKey(user.id)) };
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
  { method: 'GET', path: '/api/costs', who: ['person'], access: 'admin', handler: ({ res, app: { store, runner, outsideSpend } }) => json(res, 200, { outside: outsideSpend.bill(), days: costDays(store), week: hostWeek(store, runner.usageOf(store.serverLoginOwner())), split: spendSplit(store) }) },
  // Where your own spend went this week (#905): yours only, so any person (Cara, 2026-11-17: "Per person only"); a Taskmaster
  // reads its asker's (usage_split).
  { method: 'GET', path: '/api/costs/mine', who: ['person', 'taskmaster'], handler: ({ res, app: { store, runner, claude }, session, caller, url }) => {
    const uid = session.uid ?? (caller ? store.turnAsker(caller.id) : null);
    if (!uid) throw new HttpError(409, 'No person asked for this turn, so there is no one whose spend to show');
    const payer = runner.payerOf(uid);
    // 100% is all the person's accounts together (Cara, 2026-11-17: "All accounts combined"), each priced like the one in use.
    const accounts = Math.max(1, claude.accounts(uid)?.accounts.filter((a) => !a.expired).length ?? 1);
    const week = weekLimit(store, payer, runner.usageOf(uid));
    return json(res, 200, { ...whereItWent(store, payer, week && week * accounts, Date.now(), url.searchParams.get('range') === 'all' ? 'all' : 'week'), accounts });
  } },
  // Which minion owns each PR, so the front end can open it instead of GitHub (src/prlinks.ts).
  { method: 'GET', path: '/api/prs', who: ['person'], handler: async ({ res, app: { store }, session }) => {
    const seen = store.visibleProjects(session);
    return json(res, 200, await prOwners(store.listProjects().filter((p) => !seen || seen.has(p.id)), (id) => store.listTickets(id)));
  } },
  // The release monitor (#625, src/releases.ts): the schemes this person may see; ?scope=member keeps those they own or
  // are a member of, for the All view (Josh, 2026-11-13: "all should only show schemes you are a member of").
  { method: 'GET', path: '/api/releases', who: ['person'], handler: ({ res, url, app: { store, releases, contraptions }, session }) => {
    const member = url.searchParams.get('scope') === 'member' ? store.memberSchemes(session.uid) : null;
    // An app's link is shown as its own host when APPS_DOMAIN is set (#827); an APK's or any deeper path stays as it is.
    const short = (link: string | null | undefined) => { const n = link && /^\/apps\/([a-z0-9-]+)\/$/.exec(link)?.[1]; return (n && contraptions.appUrl(n)) || link; };
    const schemes = releases.view((id) => store.canSee(session, id) && (!member || member.has(id)));
    if (!contraptions.appsDomain) return json(res, 200, { schemes });
    const fix = <T extends { link?: string | null }>(r: T | null | undefined): T | null | undefined => (r && r.link ? { ...r, link: short(r.link) } : r);
    return json(res, 200, { schemes: schemes.map((s) => ({ ...s, targets: s.targets.map((t) => ({ ...t, target: fix(t.target), current: fix(t.current), next: fix(t.next), recent: t.recent.map((r) => fix(r)) })) })) });
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
  // A keyless Capacitor app's Make release key button (#837; Cara, 2026-11-17, "Both"): any member of its home scheme
  // makes the key on the server, as approving make_release_key's card does. Neither the key nor its password is sent back.
  { method: 'POST', path: '/api/releases/release-key', who: ['person'], handler: async ({ req, res, app, session }) => {
    const body = await readJson(req);
    const projectId = Number(body?.projectId);
    if (!Number.isInteger(projectId) || !app.store.canSee(session, projectId)) throw new HttpError(404, 'No such scheme');
    const c = homeApp(app, projectId, str(body?.contraption, 'contraption', 100));
    await makeKey(app, session, c.name);
    return json(res, 201, { ok: true });
  } },
  // The land line's order (#1002; Cara, 2026-11-18: "In the releases tab, I should be able to drag the order and choose which
  // one gets released next"): any member of the scheme whose line it is sets the order of the landings waiting in it,
  // `order` their line tickets front first; the holder keeps the lock. `moved` is the one dragged or sent to land next, for
  // the line in each waiting landing's output and the server log saying who moved what.
  { method: 'POST', path: '/api/releases/land-order', who: ['person'], handler: async ({ req, res, app: { store, releases, waits }, session }) => {
    const body = await readJson(req);
    const projectId = Number(body?.projectId);
    if (!Number.isInteger(projectId) || !store.canSee(session, projectId)) throw new HttpError(404, 'No such scheme');
    const seqs = body?.order;
    if (!Array.isArray(seqs) || seqs.length > 200 || !seqs.every((n) => Number.isInteger(n) && n > 0)) throw new HttpError(400, 'order must be a list of line tickets');
    const line = releases.view((id) => id === projectId)[0]?.targets.flatMap((t) => t.line) ?? [];
    if (!waits || !line.length) throw new HttpError(404, 'This scheme has no land line here');
    const moved = line.find((e) => e.seq === body?.moved && !e.holds);
    if (!moved) throw new HttpError(409, 'That landing is no longer waiting in line');
    const who = store.getUser(session.uid as number)?.name ?? 'a member';
    const place = seqs.indexOf(moved.seq);
    const note = `${who} moved ${moved.name} ${place === 0 ? 'to land next' : `to ${ordinal(place + 1)} of the waiting landings`}`;
    let order: number[];
    try {
      order = waits.setOrder(seqs, note);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
    console.log(`Land line: ${note} (${order.join(', ')})`);
    releases.poll();
    return json(res, 200, { order });
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

/**
 * `name`, a contraption of scheme `projectId` waiting for its first release key (#837), or an HttpError saying why not:
 * only an app whose build found no key (a deployed Capacitor app with no release workflow) gets one, so its APK builds.
 */
export function homeApp(app: App, projectId: number, name: string): ContraptionRow {
  const c = app.store.getContraption(name);
  if (!c || c.home_scheme !== projectId) throw new HttpError(403, `${name} isn't one of this scheme's contraptions`);
  if (hasKey(app.apkBuilds.keyDir, c.name)) throw new HttpError(409, `${c.title} already has a release key; it's never replaced, as phones would have to uninstall the app`);
  if (!app.apkBuilds.keyless(c.name)) throw new HttpError(409, `${c.title} isn't waiting for a release key: only a deployed Capacitor app with no release workflow gets one, once its build finds none`);
  return c;
}

/** Make `name`'s release key and start its APK build (#837), for a member of its home scheme: the card's Approve and the Releases button. */
export async function makeKey(app: App, session: Session, name: string) {
  const c = app.store.getContraption(name);
  if (!c || c.home_scheme == null) throw new HttpError(409, `${name} was removed`);
  if (!app.store.canSee(session, c.home_scheme)) throw new HttpError(403, `Only a member of ${app.store.getProject(c.home_scheme)?.name ?? 'its'} scheme can make ${c.title}'s release key`);
  try {
    await app.apkBuilds.makeKey(c, session.name);
  } catch (err: any) {
    throw new HttpError(409, err?.message ?? String(err));
  }
  app.releases.poll();
}

/** The scheme and target a release action names, if the person may see that scheme. */
function releaseTarget(store: Store, session: Session, body: any): { projectId: number; target: string } {
  const projectId = Number(body?.projectId);
  if (!Number.isInteger(projectId) || !store.canSee(session, projectId)) throw new HttpError(404, 'No such scheme');
  return { projectId, target: str(body?.target, 'target') };
}
