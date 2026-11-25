// People: an admin invites them and manages them; anyone signed in changes their own password; a
// scheme's owner picks who else is in it.
import type { User } from '../db.ts';
import type { IncomingMessage } from 'node:http';
import { clientIp, HttpError, isSecure, json, ownWrites, publicOrigin, readJson, SECURITY_HEADERS, send, type App, type Route } from '../http.ts';
import { cleanLogin, cleanName, newPasswordHash } from './app.ts';
import { secretName, secretValue, type SecretScope } from '../secrets.ts';
import { CONTRAPTION_NAME } from '../contraptions.ts';
import { dropKeptPerson, keptDirs, optOutKey } from '../replay-keep.ts';
import { thrown } from '../thrown.ts';
import { AVATAR_MAX_BYTES, avatarsOnKey, avatarsView, dropAvatar, readAvatar, saveAvatar } from '../avatar.ts';

/** A person as Settings → People shows them: never a hash or a token. */
function personView(app: App, u: User) {
  return {
    id: u.id,
    name: u.name,
    login: u.login,
    admin: !!u.admin,
    server_login: !!u.server_login,
    disabled: !!u.disabled_at,
    has_password: !!u.password_hash,
    invite_open: (u.invite_expires ?? 0) > Date.now(),
    github: app.github.login(u.id),
    claude: app.claude.linked(u.id),
    claude_accounts: app.claude.accounts(u.id)?.accounts.length ?? 0,
    server_login_owner: u.id === app.store.serverLoginOwner(),
    week: app.runner.usageOf(u.id)?.weekly ?? null,
  };
}

/** The signed-in person's id; a cookie from before per-person logins has none. */
/** The Settings card's Codex: its sign-in, and the override it makes possible (#337). */
const codexState = (app: App, uid: number) => ({ ...app.codex.status(uid), override: app.runner.codexView(uid) });

function uidOf(session: { uid?: number }): number {
  if (typeof session.uid !== 'number') throw new HttpError(400, 'Sign in again first');
  return session.uid;
}

/** Whose secret a PUT or DELETE names: your own, or a scheme's you're a member of (an admin counts, as everywhere). */
function secretOwner(app: App, session: { uid?: number; admin?: boolean }, body: Record<string, unknown>): [SecretScope, number] {
  if (body.scope === 'person' || body.scope == null) return ['person', uidOf(session)];
  if (body.scope !== 'scheme') throw new HttpError(400, 'scope is person or scheme');
  const project = typeof body.project === 'number' && Number.isInteger(body.project) ? app.store.getProject(body.project) : undefined;
  if (!project) throw new HttpError(400, "A scheme secret needs project: the scheme's id");
  if (!app.store.canSee(session, project.id)) throw new HttpError(403, `Only ${project.name}'s members change its secrets`);
  return ['scheme', project.id];
}

/** Where GitHub sends people back: the address they reached Citadel at, which must be a callback URL of the OAuth App and of the GitHub App. */
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
    method: 'GET',
    path: '/api/people',
    who: ['person'],
    handler: ({ res, app, session }) =>
      json(
        res,
        200,
        app.store
          .listUsers()
          .filter((u) => session.admin || !u.disabled_at)
          .map((u) => (session.admin ? personView(app, u) : { id: u.id, name: u.name, login: u.login })),
      ),
  },
  {
    // A new person and their invite link's token (shown once; only its hash is kept).
    method: 'POST',
    path: '/api/people',
    ...admin,
    async handler({ req, res, app }) {
      const body = await readJson(req);
      const name = cleanName(body.name);
      const login = cleanLogin(body.login ?? name);
      if (app.store.findUser('name', name)) throw new HttpError(409, `There is already someone called ${name}`);
      if (app.store.findUser('login', login)) throw new HttpError(409, `The login ${login} is taken`);
      const user = app.store.createUser({ name, login });
      return json(res, 201, { person: personView(app, app.store.getUser(user.id)!), token: app.auth.newInvite(user.id), origin: publicOrigin(req, app.preview) });
    },
  },
  {
    // A fresh link that sets their password: an invite again, or a reset for someone who forgot theirs.
    method: 'POST',
    path: '/api/people/:person/invite',
    ...admin,
    async handler({ req, res, app, params }) {
      const user = person(app, params.person);
      const token = app.auth.newInvite(user.id);
      await ownWrites(); // the view shows the invite just made (#1244)
      return json(res, 200, { person: personView(app, app.store.getUser(user.id)!), token, origin: publicOrigin(req, app.preview) });
    },
  },
  {
    method: 'PATCH',
    path: '/api/people/:person',
    ...admin,
    async handler({ req, res, app, params, session }) {
      const user = person(app, params.person);
      const body = await readJson(req);
      if (body.disabled !== undefined) {
        if (user.id === session.uid) throw new HttpError(400, "You can't disable yourself");
        app.store.updateUser(user.id, { disabled_at: body.disabled ? Date.now() : null });
        if (body.disabled) dropStreams(app, user.id);
      }
      if (body.server_login !== undefined) {
        // The server's login is one person's subscription (#213); everyone else links their own Claude.
        if (body.server_login && user.id !== app.store.serverLoginOwner()) throw new HttpError(400, `Only the server login's owner runs on it; ${user.name} links their own Claude in Settings → Your account.`);
        app.store.updateUser(user.id, { server_login: body.server_login ? 1 : 0 });
      }
      await ownWrites(); // the reply re-reads the row it just wrote (#1244)
      return json(res, 200, personView(app, app.store.getUser(user.id)!));
    },
  },
  {
    // Their schemes become yours; their messages keep their name.
    method: 'DELETE',
    path: '/api/people/:person',
    ...admin,
    async handler({ res, app, params, session }) {
      const user = person(app, params.person);
      if (user.id === session.uid) throw new HttpError(400, "You can't remove yourself");
      app.store.deleteUser(user.id, uidOf(session));
      app.store.deleteSetting(avatarsOnKey(user.id));
      await dropAvatar(app.store, app.dataDir, user.id);
      dropStreams(app, user.id);
      // Their collaborator invites go too (#310); a refusal stays on its row for the next boot's sweep.
      void app.repoAccess.tidy().catch((err) => console.error('repo access after removing a person', err));
      return json(res, 200, {});
    },
  },
  {
    method: 'PUT',
    path: '/api/me/password',
    who: ['person'],
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
  {
    // Your own order of the schemes shelf or the app rail, from a drag (#649): GET /api/projects and /api/contraptions/mine follow it.
    method: 'PUT',
    path: '/api/me/order/:list',
    who: ['person'],
    async handler({ req, res, app, session, params }) {
      const list = params.list;
      if (list !== 'schemes' && list !== 'apps') throw new HttpError(404, 'No such list');
      const { keys } = await readJson(req);
      const ok = list === 'schemes' ? (k: unknown) => Number.isSafeInteger(k) && (k as number) > 0 : (k: unknown) => typeof k === 'string' && CONTRAPTION_NAME.test(k);
      if (!Array.isArray(keys) || keys.length > 1000 || !keys.every(ok) || new Set(keys).size !== keys.length) throw new HttpError(400, `keys must be a list of ${list === 'schemes' ? 'scheme ids' : 'app names'}, each once`);
      app.store.setListOrder(uidOf(session), list, keys);
      return json(res, 200, { keys });
    },
  },
  // Linking your own GitHub (src/github-link.ts): its state, GitHub's authorize page and back, and unlinking.
  { method: 'GET', path: '/api/me/github', who: ['person'], handler: async ({ res, app, session }) => json(res, 200, await app.github.status(uidOf(session))) },
  {
    method: 'GET',
    path: '/api/github/link',
    who: ['person'],
    handler({ req, res, app, url, session }) {
      // kind=limited links through Citadel's GitHub App (#464); anything else is the OAuth App's full access.
      const limited = url.searchParams.get('kind') === 'limited';
      if (!(limited ? app.github.limited : app.github.full)) throw new HttpError(503, `${limited ? 'Limited GitHub linking' : 'GitHub linking'} isn't set up on this server yet: an admin adds the ${limited ? 'GitHub App' : 'OAuth App'} (see the README).`);
      const project = Number(url.searchParams.get('project'));
      if (!Number.isSafeInteger(project) || !app.store.getProject(project) || !app.store.canSee(session, project)) throw new HttpError(400, "Which scheme's Settings to come back to?");
      res.writeHead(302, { Location: app.github.authorizeUrl(uidOf(session), project, callbackUrl(req), limited), 'Cache-Control': 'no-store' }).end();
    },
  },
  {
    method: 'GET',
    path: '/api/github/callback',
    who: ['person'],
    async handler({ req, res, app, url, session }) {
      const project = await app.github.finish(uidOf(session), url.searchParams, callbackUrl(req));
      await ownWrites(); // the invites below read the GitHub link just saved (#1244)
      // Newly linked: their schemes' repos invite them, and as an owner their members (#310). The redirect doesn't wait.
      void app.repoAccess.syncPerson(uidOf(session)).catch((err) => console.error('repo access after linking', err));
      res.writeHead(302, { Location: project === null ? '../../c/' : `../../c/#/p/${project}/account`, 'Cache-Control': 'no-store' }).end();
    },
  },
  {
    // The GitHub App's Setup URL (README, "A limited GitHub link"): GitHub sends people here after they install it,
    // with the install link's state, the scheme they came from. Installing links nothing, so someone not linked
    // goes straight on to the limited link; anyone linked already sees their account (#670).
    method: 'GET',
    path: '/api/github/installed',
    who: ['person'],
    handler({ req, res, app, url, session }) {
      const uid = uidOf(session);
      const asked = Number(url.searchParams.get('state'));
      const project = Number.isSafeInteger(asked) && app.store.getProject(asked) && app.store.canSee(session, asked) ? asked : (app.store.listProjects().find((p) => app.store.canSee(session, p.id))?.id ?? null);
      const to = project === null ? '../../c/' : !app.store.getCredential(uid, 'github') && app.github.limited ? app.github.authorizeUrl(uid, project, callbackUrl(req), true) : `../../c/#/p/${project}/account`;
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }).end();
    },
  },
  // The last limited link refused for the GitHub App's expiring tokens, for the People page (#670).
  { method: 'GET', path: '/api/github/refused', ...admin, handler: ({ res, app }) => json(res, 200, app.github.refused()) },
  {
    method: 'DELETE',
    path: '/api/me/github',
    who: ['person'],
    async handler({ res, app, session }) {
      await app.github.unlink(uidOf(session));
      await ownWrites(); // the reply reads the credential back (#1244), as the OpenRouter ones below
      return json(res, 200, await app.github.status(uidOf(session)));
    },
  },
  // Saved secrets (src/secrets.ts, #838): your own, and those of each scheme you're in. Names only: a value goes in
  // (Save, Replace) and never comes back out to a browser.
  {
    method: 'GET',
    path: '/api/secrets',
    who: ['person'],
    handler({ res, app, session }) {
      const uid = uidOf(session);
      const schemes = app.store.listProjects().filter((p) => app.store.canSee(session, p.id));
      return json(res, 200, {
        person: app.secrets.list('person', uid),
        schemes: schemes.flatMap((p) => app.secrets.list('scheme', p.id).map((s) => ({ ...s, project_name: p.name }))),
      });
    },
  },
  {
    method: ['PUT', 'DELETE'],
    path: '/api/secrets',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const body = (await readJson(req)) ?? {};
      const [scope, owner] = secretOwner(app, session, body);
      const name = secretName(body.name);
      if (req.method === 'DELETE') {
        if (!app.secrets.remove(scope, owner, name)) throw new HttpError(404, `No secret called ${name}`);
      } else {
        app.secrets.put(scope, owner, name, secretValue(body.value), uidOf(session));
      }
      return json(res, 200, { name, scope, ...(scope === 'scheme' ? { project: owner } : {}) });
    },
  },
  // Your own OpenRouter key and monthly cap (src/openrouter.ts, #717): connect (checked with OpenRouter, then sealed),
  // change the cap, disconnect. The key goes in once and never comes back out.
  { method: 'GET', path: '/api/me/openrouter', who: ['person'], handler: ({ res, app, session }) => json(res, 200, app.openrouter.status(uidOf(session))) },
  {
    method: 'POST',
    path: '/api/me/openrouter',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const body = (await readJson(req)) ?? {};
      await app.openrouter.connect(uidOf(session), body.key, body.cap);
      await ownWrites();
      return json(res, 200, app.openrouter.status(uidOf(session)));
    },
  },
  {
    method: 'PATCH',
    path: '/api/me/openrouter',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const body = (await readJson(req)) ?? {};
      app.openrouter.setCap(uidOf(session), body.cap);
      await ownWrites();
      return json(res, 200, app.openrouter.status(uidOf(session)));
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/openrouter',
    who: ['person'],
    async handler({ res, app, session }) {
      app.openrouter.unlink(uidOf(session));
      await ownWrites();
      return json(res, 200, app.openrouter.status(uidOf(session)));
    },
  },
  // Linking your own Claude plan (src/claude-link.ts, #213): its state, starting the sign-in, the code
  // Anthropic shows you, and unlinking. Only the one-time code passes through; never a token.
  { method: 'GET', path: '/api/me/claude', who: ['person'], handler: ({ res, app, session }) => json(res, 200, { ...app.claude.status(uidOf(session)), usage: app.runner.usageOf(uidOf(session)) }) },
  {
    method: 'POST',
    path: '/api/me/claude',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const uid = uidOf(session);
      // Which account (#779): another one, or one to sign in again. A page from before #779 sends no body.
      const body = (req.headers['content-type'] ?? '').startsWith('application/json') ? await readJson(req) : {};
      let n: number;
      try {
        n = app.claude.linkSlot(uid, body.account === undefined ? undefined : Number(body.account));
      } catch (err) {
        throw new HttpError(400, thrown(err).message ?? String(err));
      }
      // Starting the container can take minutes the first time (it builds the image): Settings polls GET meanwhile.
      void app.claude.link(uid, n).catch((err) => console.warn(`claude-link: linking account ${n} for user ${uid} failed: ${err.message}`));
      return json(res, 202, app.claude.status(uid));
    },
  },
  {
    method: 'POST',
    path: '/api/me/claude/use',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const uid = uidOf(session);
      // Pins account n (#793): new and cold turns run on it while it's ready. { account: null } unpins.
      const n = (await readJson(req)).account;
      if (n !== null && !Number.isInteger(n)) throw new HttpError(400, 'Which account? Send { account: n }.');
      try {
        app.claude.use(uid, n);
      } catch (err) {
        throw new HttpError(400, thrown(err).message ?? String(err));
      }
      await ownWrites(); // the reply reads the credential back (#1244)
      return json(res, 200, { ...app.claude.status(uid), usage: app.runner.usageOf(uid) });
    },
  },
  {
    method: 'POST',
    path: '/api/me/claude/code',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const code = String((await readJson(req)).code ?? '').trim();
      // It is typed into the sign-in's terminal: printable characters only, so nothing can act as a key press.
      if (!/^[\x21-\x7e]{1,2000}$/.test(code)) throw new HttpError(400, 'Paste the code Anthropic showed you.');
      await app.claude.code(uidOf(session), code).catch((err) => {
        throw new HttpError(400, err.message);
      });
      await ownWrites(); // the reply reads the credential back (#1244)
      return json(res, 200, app.claude.status(uidOf(session)));
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/claude',
    who: ['person'],
    async handler({ res, app, session, url }) {
      // One account of several (#779), or with none named, the whole link.
      const account = url.searchParams.get('account');
      const n = account ? Number(account) : undefined;
      // Only Unlink's unlink=1 removes a linked account (#1856). Without it this is Cancel, an old tab's Unlink included.
      await (url.searchParams.has('unlink') ? app.claude.unlink(uidOf(session), n) : app.claude.cancelSignIn(uidOf(session), n)).catch((err) => {
        throw new HttpError(400, err.message);
      });
      await ownWrites(); // the reply reads the credential back (#1244)
      return json(res, 200, { ...app.claude.status(uidOf(session)), usage: app.runner.usageOf(uidOf(session)) });
    },
  },
  // Signing in to Codex (src/codex-link.ts, #330): in the person's Claude container, by OpenAI's device code. No token passes through.
  {
    method: 'GET',
    path: '/api/me/codex',
    who: ['person'],
    handler({ res, app, session }) {
      const uid = uidOf(session);
      // Fresh usage windows for the card's bar (#342): they arrive as a 'codex' message.
      void app.codex.readLimits(uid).then(
        (l) => l && app.runner.updateCodexUsage(l, uid),
        () => {},
      );
      return json(res, 200, codexState(app, uid));
    },
  },
  {
    method: 'POST',
    path: '/api/me/codex',
    who: ['person'],
    handler({ res, app, session }) {
      const uid = uidOf(session);
      if (app.codex.status(uid).state === 'no container') throw new HttpError(400, 'Codex signs in inside your own Claude container, and you have none: link your Claude first.');
      // Starting the container can take minutes (it rebuilds the image after an update): Settings polls GET meanwhile.
      void app.codex.link(uid);
      return json(res, 202, codexState(app, uid));
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/codex',
    who: ['person'],
    async handler({ res, app, session, url }) {
      // Only Sign out's unlink=1 signs out, as for Claude above (#1856).
      if (!url.searchParams.has('unlink')) app.codex.cancel(uidOf(session));
      else
        await app.codex.unlink(uidOf(session)).catch((err) => {
          throw new HttpError(400, err.message);
        });
      return json(res, 200, codexState(app, uidOf(session)));
    },
  },
  // "Enable Codex override" (#337): Codex becomes the person's default everywhere their turns run.
  {
    method: 'PUT',
    path: '/api/me/codex/switch',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const uid = uidOf(session);
      const { on } = await readJson(req);
      if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true or false');
      const why = app.runner.setCodexSwitch(uid, on);
      if (why) throw new HttpError(400, `Can't switch to Codex: ${why}.`);
      return json(res, 200, app.runner.codexView(uid));
    },
  },
  // Kept app chats (#836): on by default; turning it off deletes what was kept of the person's and keeps no more.
  {
    method: 'PUT',
    path: '/api/me/replay',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const uid = uidOf(session);
      const { keep } = await readJson(req);
      if (typeof keep !== 'boolean') throw new HttpError(400, 'keep must be true or false');
      app.store.setSetting(optOutKey(uid), !keep);
      if (!keep) dropKeptPerson(keptDirs(app.dataDir), uid);
      return json(res, 200, { keep });
    },
  },
  {
    // Speaker avatars in chat (#1976): your own switch, off until you turn it on.
    method: 'PUT',
    path: '/api/me/avatars',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const { on } = await readJson(req);
      if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true or false');
      const uid = uidOf(session);
      app.store.setSetting(avatarsOnKey(uid), on);
      return json(res, 200, avatarsView(app.store, uid));
    },
  },
  {
    // Your picture: the page crops it to a small square first, so the body is the image itself.
    method: 'PUT',
    path: '/api/me/avatar',
    who: ['person'],
    async handler({ req, res, app, session }) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > AVATAR_MAX_BYTES) throw new HttpError(413, `The picture must be under ${AVATAR_MAX_BYTES / 1024} KB`);
        chunks.push(chunk);
      }
      const uid = uidOf(session);
      await saveAvatar(app.store, app.dataDir, uid, Buffer.concat(chunks));
      return json(res, 200, avatarsView(app.store, uid));
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/avatar',
    who: ['person'],
    async handler({ res, app, session }) {
      const uid = uidOf(session);
      await dropAvatar(app.store, app.dataDir, uid);
      return json(res, 200, avatarsView(app.store, uid));
    },
  },
  {
    // A person's picture. Its URL carries its version, so it can be kept long.
    method: 'GET',
    path: '/api/people/:person/avatar',
    who: ['person'],
    async handler({ res, app, params }) {
      const pic = await readAvatar(app.store, app.dataDir, person(app, params.person).id);
      if (!pic) throw new HttpError(404, 'No picture');
      send(res, 200, { ...SECURITY_HEADERS, 'Content-Type': pic.type, 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=31536000, immutable' }, pic.body);
    },
  },
  { method: 'GET', path: '/api/projects/:project/members', who: ['person'], handler: ({ res, app, project }) => json(res, 200, members(app, project.id)) },
  {
    method: 'POST',
    path: '/api/projects/:project/members',
    who: ['person'],
    // Any member, not only the owner (#621): reaching here means the person is in the scheme (http.ts canSee).
    async handler({ req, res, app, project }) {
      const user = person(app, String((await readJson(req)).person));
      if (user.disabled_at) throw new HttpError(400, `${user.name} is disabled`);
      app.store.addMember(project.id, user.id);
      await ownWrites(); // the GitHub invite and the reply read the membership back (#1244)
      app.broadcast({ type: 'project', project: app.store.getProject(project.id) });
      // Adding someone already in tries their GitHub invite again (#310).
      await app.repoAccess.sync(project.id, user.id);
      await ownWrites(); // and the invite it recorded
      return json(res, 200, members(app, project.id));
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:project/members/:person',
    who: ['person'],
    async handler({ res, app, project, params }) {
      app.store.removeMember(project.id, Number(params.person));
      await ownWrites(); // as adding
      // Only a collaborator Citadel added comes off the repo; the refusal is said, and the next boot tries again.
      const error = await app.repoAccess.remove(project.id, Number(params.person));
      if (error) throw new HttpError(502, `They're out of the scheme, but not off GitHub yet: ${error}`);
      await ownWrites();
      return json(res, 200, members(app, project.id));
    },
  },
];
