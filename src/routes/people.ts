// People: an admin invites them and manages them; anyone signed in changes their own password; a
// scheme's owner picks who else is in it.
import type { User } from '../db.ts';
import type { IncomingMessage } from 'node:http';
import { clientIp, HttpError, isSecure, json, readJson, type App, type Route } from '../http.ts';
import { cleanLogin, cleanName, newPasswordHash } from './app.ts';

/** A person as Settings → People shows them: never a hash or a token. */
function personView(app: App, u: User) {
  return {
    id: u.id, name: u.name, login: u.login, admin: !!u.admin, server_login: !!u.server_login,
    disabled: !!u.disabled_at, has_password: !!u.password_hash, invite_open: (u.invite_expires ?? 0) > Date.now(),
    github: app.github.login(u.id),
    claude: app.claude.linked(u.id), server_login_owner: u.id === app.store.serverLoginOwner(),
    week: app.runner.usageOf(u.id)?.weekly ?? null,
  };
}

/** The signed-in person's id; a cookie from before per-person logins has none. */
function uidOf(session: { uid?: number }): number {
  if (typeof session.uid !== 'number') throw new HttpError(400, 'Sign in again first');
  return session.uid;
}

/** Where GitHub sends people back: the address they reached Citadel at, which must be the OAuth App's callback URL. */
function callbackUrl(req: IncomingMessage): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  return `${isSecure(req) ? 'https' : 'http'}://${host}/api/github/callback`;
}

function person(app: App, id: string): User {
  const user = app.store.getUser(Number(id));
  if (!user) throw new HttpError(404, 'No such person');
  return user;
}

/** A scheme's people, each with what Citadel did for them on its GitHub repo (#310). */
const members = (app: App, projectId: number) => app.store.listMembers(projectId).map((m) => ({ ...m, github: m.owner ? null : app.repoAccess.view(projectId, m.id) }));

/** End a person's open streams, so a disabled or removed person stops getting news at once. */
function dropStreams(app: App, userId: number) {
  for (const [res, who] of app.clients) if (who.uid === userId) res.end();
}

const admin = { who: ['person'], access: 'admin' } as const;

export const peopleRoutes: Route[] = [
  {
    // Everyone sees names and logins, to add people to their schemes; admins see the rest.
    method: 'GET', path: '/api/people', who: ['person'],
    handler: ({ res, app, session }) => json(res, 200, app.store.listUsers().filter((u) => session.admin || !u.disabled_at)
      .map((u) => (session.admin ? personView(app, u) : { id: u.id, name: u.name, login: u.login }))),
  },
  {
    // A new person and their invite link's token (shown once; only its hash is kept).
    method: 'POST', path: '/api/people', ...admin,
    async handler({ req, res, app }) {
      const body = await readJson(req);
      const name = cleanName(body.name);
      const login = cleanLogin(body.login ?? name);
      if (app.store.findUser('name', name)) throw new HttpError(409, `There is already someone called ${name}`);
      if (app.store.findUser('login', login)) throw new HttpError(409, `The login ${login} is taken`);
      const user = app.store.createUser({ name, login });
      return json(res, 201, { person: personView(app, app.store.getUser(user.id)!), token: app.auth.newInvite(user.id) });
    },
  },
  {
    // A fresh link that sets their password: an invite again, or a reset for someone who forgot theirs.
    method: 'POST', path: '/api/people/:person/invite', ...admin,
    handler({ res, app, params }) {
      const user = person(app, params.person);
      return json(res, 200, { person: personView(app, user), token: app.auth.newInvite(user.id) });
    },
  },
  {
    method: 'PATCH', path: '/api/people/:person', ...admin,
    async handler({ req, res, app, params, session }) {
      const user = person(app, params.person);
      const body = await readJson(req);
      if (body.disabled !== undefined) {
        if (user.id === session.uid) throw new HttpError(400, 'You can\'t disable yourself');
        app.store.updateUser(user.id, { disabled_at: body.disabled ? Date.now() : null });
        if (body.disabled) dropStreams(app, user.id);
      }
      if (body.server_login !== undefined) {
        // The server's login is one person's subscription (#213); everyone else links their own Claude.
        if (body.server_login && user.id !== app.store.serverLoginOwner()) throw new HttpError(400, `Only the server login's owner runs on it; ${user.name} links their own Claude in Settings → Your account.`);
        app.store.updateUser(user.id, { server_login: body.server_login ? 1 : 0 });
      }
      return json(res, 200, personView(app, app.store.getUser(user.id)!));
    },
  },
  {
    // Their schemes become yours; their messages keep their name.
    method: 'DELETE', path: '/api/people/:person', ...admin,
    handler({ res, app, params, session }) {
      const user = person(app, params.person);
      if (user.id === session.uid) throw new HttpError(400, 'You can\'t remove yourself');
      app.store.deleteUser(user.id, uidOf(session));
      dropStreams(app, user.id);
      // Their collaborator invites go too (#310); a refusal stays on its row for the next boot's sweep.
      void app.repoAccess.tidy().catch((err) => console.error('repo access after removing a person', err));
      return json(res, 200, {});
    },
  },
  {
    method: 'PUT', path: '/api/me/password', who: ['person'],
    async handler({ req, res, app: { auth, store }, session }) {
      const body = await readJson(req);
      const ip = clientIp(req);
      const me = session.uid ? store.getUser(session.uid) : undefined;
      if (!me) throw new HttpError(400, 'Sign in again first');
      if (auth.limited(ip)) throw new HttpError(429, 'Too many attempts; try again later');
      if ((await auth.signIn(ip, me.login, String(body.current ?? '').slice(0, 1000)))?.id !== me.id) throw new HttpError(403, 'Your current password is wrong');
      store.updateUser(me.id, { password_hash: await newPasswordHash(body.password) });
      return json(res, 200, {});
    },
  },
  // Linking your own GitHub (src/github-link.ts): its state, GitHub's authorize page and back, and unlinking.
  { method: 'GET', path: '/api/me/github', who: ['person'], handler: async ({ res, app, session }) => json(res, 200, await app.github.status(uidOf(session))) },
  {
    method: 'GET', path: '/api/github/link', who: ['person'],
    handler({ req, res, app, url, session }) {
      if (!app.github.configured) throw new HttpError(503, 'GitHub linking isn\'t set up on this server yet: an admin adds the OAuth App (see the README).');
      const project = Number(url.searchParams.get('project'));
      if (!Number.isSafeInteger(project) || !app.store.getProject(project) || !app.store.canSee(session, project)) throw new HttpError(400, 'Which scheme\'s Settings to come back to?');
      res.writeHead(302, { Location: app.github.authorizeUrl(uidOf(session), project, callbackUrl(req)), 'Cache-Control': 'no-store' }).end();
    },
  },
  {
    method: 'GET', path: '/api/github/callback', who: ['person'],
    async handler({ req, res, app, url, session }) {
      const project = await app.github.finish(uidOf(session), url.searchParams, callbackUrl(req));
      // Newly linked: their schemes' repos invite them, and as an owner their members (#310). The redirect doesn't wait.
      void app.repoAccess.syncPerson(uidOf(session)).catch((err) => console.error('repo access after linking', err));
      res.writeHead(302, { Location: project === null ? '../../c/' : `../../c/#/p/${project}/account`, 'Cache-Control': 'no-store' }).end();
    },
  },
  {
    method: 'DELETE', path: '/api/me/github', who: ['person'],
    async handler({ res, app, session }) {
      await app.github.unlink(uidOf(session));
      return json(res, 200, await app.github.status(uidOf(session)));
    },
  },
  // Linking your own Claude plan (src/claude-link.ts, #213): its state, starting the sign-in, the code
  // Anthropic shows you, and unlinking. Only the one-time code passes through; never a token.
  { method: 'GET', path: '/api/me/claude', who: ['person'], handler: ({ res, app, session }) => json(res, 200, { ...app.claude.status(uidOf(session)), usage: app.runner.usageOf(uidOf(session)) }) },
  {
    method: 'POST', path: '/api/me/claude', who: ['person'],
    handler({ res, app, session }) {
      const uid = uidOf(session);
      if (app.store.getUser(uid)?.server_login) throw new HttpError(400, 'Your turns run on the server\'s own Claude login, so there\'s nothing to link.');
      // Starting the container can take minutes the first time (it builds the image): Settings polls GET meanwhile.
      void app.claude.link(uid);
      return json(res, 202, app.claude.status(uid));
    },
  },
  {
    method: 'POST', path: '/api/me/claude/code', who: ['person'],
    async handler({ req, res, app, session }) {
      const code = String((await readJson(req)).code ?? '').trim();
      // It is typed into the sign-in's terminal: printable characters only, so nothing can act as a key press.
      if (!/^[\x21-\x7e]{1,2000}$/.test(code)) throw new HttpError(400, 'Paste the code Anthropic showed you.');
      return json(res, 200, await app.claude.code(uidOf(session), code).catch((err) => { throw new HttpError(400, err.message); }));
    },
  },
  {
    method: 'DELETE', path: '/api/me/claude', who: ['person'],
    async handler({ res, app, session }) {
      await app.claude.unlink(uidOf(session)).catch((err) => { throw new HttpError(400, err.message); });
      return json(res, 200, app.claude.status(uidOf(session)));
    },
  },
  { method: 'GET', path: '/api/projects/:project/members', who: ['person'], handler: ({ res, app, project }) => json(res, 200, members(app, project.id)) },
  {
    method: 'POST', path: '/api/projects/:project/members', who: ['person'], access: 'owner',
    async handler({ req, res, app, project }) {
      const user = person(app, String((await readJson(req)).person));
      if (user.disabled_at) throw new HttpError(400, `${user.name} is disabled`);
      app.store.addMember(project.id, user.id);
      app.broadcast({ type: 'project', project: app.store.getProject(project.id) });
      // Adding someone already in tries their GitHub invite again (#310).
      await app.repoAccess.sync(project.id, user.id);
      return json(res, 200, members(app, project.id));
    },
  },
  {
    method: 'DELETE', path: '/api/projects/:project/members/:person', who: ['person'], access: 'owner',
    async handler({ res, app, project, params }) {
      app.store.removeMember(project.id, Number(params.person));
      // Only a collaborator Citadel added comes off the repo; the refusal is said, and the next boot tries again.
      const error = await app.repoAccess.remove(project.id, Number(params.person));
      if (error) throw new HttpError(502, `They're out of the scheme, but not off GitHub yet: ${error}`);
      return json(res, 200, members(app, project.id));
    },
  },
];
