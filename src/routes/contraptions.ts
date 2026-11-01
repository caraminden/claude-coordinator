// Contraptions (src/contraptions.ts): admins register them, edit them, enable them per person and
// rotate their keys, as does Citadel's Taskmaster on an admin's turn (#246); anyone signed in lists
// the ones enabled for them, for the app rail; a contraption's own server sends its people's bug
// reports and feature asks to its home scheme (src/contraption-asks.ts) and runs turns for its people through the turn API (src/contraption-turns.ts).
import type { IncomingMessage } from 'node:http';
import { APP_NAME } from '../appname.ts';
import { AGENT_NAME } from '../auth.ts';
import { ASK_FILES_MAX, askFiles, askMessage, saveAskFiles } from '../contraption-asks.ts';
import { parseTurn, TurnError } from '../contraption-turns.ts';
import { CONTRAPTION_NAME } from '../contraptions.ts';
import type { ContraptionRow } from '../db.ts';
import { HttpError, json, oneOf, readJson, str, type App, type Ctx, type Route } from '../http.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import { projectSharedDir } from '../workspace.ts';
import { ensureCoordinator } from './projects.ts';

// Names the turn API (section 4) and the rail take under /api/contraptions/.
const RESERVED = new Set(['mine', 'turns', 'sessions', 'asks']);

/** A contraption as Settings → Contraptions shows it: never a key. */
function view(app: App, c: ContraptionRow) {
  return {
    name: c.name, title: c.title, icon: c.icon, port: c.port, home_scheme: c.home_scheme, open_paths: JSON.parse(c.open_paths) as string[],
    default_model: c.default_model, turn_cap: c.turn_cap, keys_at: c.keys_at, keys_dir: app.contraptions.folder(c.name),
    people: app.store.contraptionUsers(c.id),
    logins: app.store.contraptionUsers(c.id).map((id) => app.store.getUser(id)?.login).filter(Boolean),
  };
}

function contraption(app: App, name: string): ContraptionRow {
  const c = app.store.getContraption(name);
  if (!c) throw new HttpError(404, 'No such contraption');
  return c;
}

/** Null for '' or null, else an integer in range. */
function int(v: unknown, what: string, min: number, max: number): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}`);
  return n;
}

function path(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^\/[\x21-\x7e]{0,199}$/.test(v)) throw new HttpError(400, `${what} must be a path starting with /, without spaces`);
  return v;
}

/** The registry fields a body sets; on create, the required ones must be there. */
function fields(app: App, body: any, creating: boolean) {
  const out: Partial<Omit<ContraptionRow, 'id' | 'name' | 'created_at'>> = {};
  if (creating || body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
    if (!title || title.length > 60) throw new HttpError(400, 'Title is required, at most 60 characters');
    out.title = title;
  }
  if (creating || body.port !== undefined) {
    out.port = int(body.port, 'Port', 1024, 65535) ?? undefined;
    if (out.port === undefined) throw new HttpError(400, 'Port is required');
  }
  if (body.icon !== undefined) out.icon = body.icon === null || body.icon === '' ? null : path(body.icon, 'Icon');
  if (body.home_scheme !== undefined) {
    const id = int(body.home_scheme, 'Home scheme', 1, Number.MAX_SAFE_INTEGER);
    if (id !== null && !app.store.getProject(id)) throw new HttpError(400, 'No such scheme');
    out.home_scheme = id;
  }
  if (body.open_paths !== undefined) {
    if (!Array.isArray(body.open_paths) || body.open_paths.length > 20) throw new HttpError(400, 'Open paths must be a list of at most 20 paths');
    out.open_paths = JSON.stringify(body.open_paths.map((p: unknown) => path(p, 'An open path')));
  }
  if (body.default_model !== undefined) {
    const m = body.default_model;
    if (m !== null && m !== '' && (typeof m !== 'string' || !/^[\w.\[\]-]{1,60}$/.test(m))) throw new HttpError(400, 'Default model must be a model name like haiku');
    out.default_model = m || null;
  }
  if (body.turn_cap !== undefined) out.turn_cap = int(body.turn_cap, 'Turn cap', 1, 100_000);
  return out;
}

/**
 * An admin route: for admins, and for the Citadel scheme's Taskmaster on a turn run for an admin (its
 * contraption tools in src/mcp.ts). The registry is Citadel-wide, so other schemes' Taskmasters ask that one.
 */
const admin = (route: Pick<Route, 'method' | 'path' | 'handler'>): Route => ({
  ...route, who: ['person', 'taskmaster'], access: 'admin',
  handler(ctx) {
    const { app, caller } = ctx;
    if (!caller) return route.handler(ctx);
    if (caller.project_id !== GLOBAL_OWNER) {
      throw new HttpError(403, `Only the ${APP_NAME} scheme's ${AGENT_NAME} manages contraptions: ask it with message_taskmaster`);
    }
    // Whose turn it is (src/runner.ts turnPerson), set at the turn's start.
    const person = caller.person_id === null ? undefined : app.store.getUser(caller.person_id);
    if (!person?.admin || person.disabled_at) {
      throw new HttpError(403, `Only a turn run for a ${APP_NAME} admin may manage contraptions; this one runs for ${person?.name ?? 'nobody'}. Ask an admin to send the request.`);
    }
    return route.handler(ctx);
  },
});

/** Asks per contraption and person: ASK_LIMIT in ASK_WINDOW_MS, then 429. shortcut: kept in memory, so a restart forgets it; fine as a loop backstop. */
const ASK_LIMIT = 10;
const ASK_WINDOW_MS = 10 * 60_000;
const askTimes = new Map<string, number[]>();

/** A turn API route: 'contraption' routes get the calling contraption (src/contraptions.ts caller) as ctx.contraption. */
const fromContraption = (method: string, path: string, handler: (ctx: Ctx, c: ContraptionRow) => unknown): Route => ({
  method, path, who: 'contraption', handler: (ctx) => handler(ctx, ctx.contraption),
});

/** The `person` a sessions call names, who must have the contraption enabled. */
function enabledPerson(app: App, c: ContraptionRow, url: URL): number {
  const person = Number(url.searchParams.get('person'));
  if (!Number.isInteger(person) || person < 1) throw new HttpError(400, 'person must be a person\'s id');
  if (!app.contraptions.enabled(c.name, person)) throw new HttpError(403, 'not_enabled');
  return person;
}

/** Server-sent events, one at a time, unbuffered. */
function eventStream(req: IncomingMessage, res: Ctx['res']) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  req.socket.setNoDelay(true);
  return (event: string, data: object) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export const contraptionRoutes: Route[] = [
  fromContraption('POST', '/api/contraptions/turns', async ({ req, res, app }, c) => {
    const body = await readJson(req, 4_000_000);
    const emit = eventStream(req, res);
    // The contraption hung up: stop its turn rather than run it for nobody.
    let turn: number | null = null;
    let gone = false;
    res.on('close', () => {
      if (res.writableFinished) return;
      gone = true;
      if (turn !== null) app.contraptionTurns.cancel(c.id, turn);
    });
    try {
      await app.contraptionTurns.run(c, parseTurn(body, c), (event, data) => {
        if (event === 'start') {
          turn = (data as { turn: number }).turn;
          if (gone) app.contraptionTurns.cancel(c.id, turn);
        }
        emit(event, data);
      });
    } catch (err) {
      if (!(err instanceof TurnError)) throw err;
      emit('error', { code: err.code, message: err.message });
    }
    res.end();
  }),
  fromContraption('POST', '/api/contraptions/turns/:turn/cancel', ({ res, app, params }, c) => {
    if (!app.contraptionTurns.cancel(c.id, Number(params.turn))) throw new HttpError(404, 'No such turn running');
    return json(res, 200, { ok: true });
  }),
  fromContraption('GET', '/api/contraptions/sessions', ({ res, app, url }, c) => {
    return json(res, 200, app.contraptionTurns.sessions(c.id, enabledPerson(app, c, url)));
  }),
  fromContraption('DELETE', '/api/contraptions/sessions/:session', ({ res, app, url, params }, c) => {
    let name: string;
    try {
      name = decodeURIComponent(params.session);
    } catch {
      throw new HttpError(400, 'Not a session name');
    }
    const done = app.contraptionTurns.deleteSession(c, enabledPerson(app, c, url), name);
    if (done === 'busy') throw new HttpError(409, 'busy');
    if (done === 'missing') throw new HttpError(404, 'No such session');
    return json(res, 200, { ok: true });
  }),
  {
    // The rail's list: the contraptions enabled for you, and whether each is up. Empty for most people.
    method: 'GET', path: '/api/contraptions/mine', who: ['person'],
    handler: async ({ res, app, session }) => json(res, 200, typeof session.uid !== 'number' ? [] : await Promise.all(
      app.store.contraptionsFor(session.uid).map(async (c) => ({ name: c.name, title: c.title, icon: c.icon, up: await app.contraptions.up(c) })))),
  },
  admin({ method: 'GET', path: '/api/contraptions', handler: ({ res, app }) => json(res, 200, app.store.listContraptions().map((c) => view(app, c))) }),
  admin({
    // Register: its key files are written now, for its own service to read.
    method: 'POST', path: '/api/contraptions',
    async handler({ req, res, app }) {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!CONTRAPTION_NAME.test(name) || RESERVED.has(name)) throw new HttpError(400, 'Name must be a short slug: lowercase letters, digits and dashes, like mandate');
      if (app.store.getContraption(name)) throw new HttpError(409, `There is already a contraption called ${name}`);
      const f = fields(app, body, true);
      const c = app.contraptions.register({
        name, title: f.title!, port: f.port!, icon: f.icon ?? null, home_scheme: f.home_scheme ?? null, open_paths: f.open_paths ?? '[]',
        default_model: f.default_model ?? null, turn_cap: f.turn_cap ?? null,
      });
      return json(res, 201, view(app, c));
    },
  }),
  admin({
    // Its name stays: it is in its paths and its key folder.
    method: 'PATCH', path: '/api/contraptions/:name',
    async handler({ req, res, app, params }) {
      const c = contraption(app, params.name);
      app.store.updateContraption(c.name, fields(app, await readJson(req), false));
      return json(res, 200, view(app, contraption(app, c.name)));
    },
  }),
  admin({
    // Enable or disable it for one person, by id or @login; disabling takes at their next request.
    method: 'PUT', path: '/api/contraptions/:name/people/:person',
    async handler({ req, res, app, params, session, caller }) {
      const c = contraption(app, params.name);
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Say enabled: true or false');
      // @login, since a login may be all digits.
      const ref = params.person.replace(/^%40/i, '@');
      const person = ref.startsWith('@') ? app.store.findUser('login', ref.slice(1)) : app.store.getUser(Number(ref));
      if (!person) throw new HttpError(404, 'No such person');
      app.store.setContraptionUser(c.id, person.id, body.enabled, session.uid ?? caller?.person_id ?? null);
      return json(res, 200, view(app, c));
    },
  }),
  admin({
    // Rotate: new identity key pair and contraption key, both files rewritten. Its service restarts to read them.
    method: 'POST', path: '/api/contraptions/:name/keys',
    handler({ res, app, params }) {
      const c = contraption(app, params.name);
      app.contraptions.rotate(c.name);
      return json(res, 200, view(app, contraption(app, c.name)));
    },
  }),
  {
    // A bug report or feature ask from a contraption's server, as one of its people: files into the home
    // scheme's shared folder, the ask to its Taskmaster, waking it.
    method: 'POST', path: '/api/contraptions/asks', who: 'contraption',
    async handler({ req, res, app, contraption: c }) {
      // Base64 is 4/3 of the files, plus room for the text.
      const body = (await readJson(req, Math.ceil(ASK_FILES_MAX * 4 / 3) + 1_000_000)) ?? {};
      const person = Number.isInteger(body.person) ? app.store.getUser(body.person) : undefined;
      if (!person || !app.contraptions.enabled(c.name, person.id)) throw new HttpError(403, `${c.title} isn't enabled for that person`);
      // A contraption stuck in a loop would wake the Taskmaster on every call.
      const key = `${c.name}:${person.id}`;
      const recent = (askTimes.get(key) ?? []).filter((t) => Date.now() - t < ASK_WINDOW_MS);
      if (recent.length >= ASK_LIMIT) throw new HttpError(429, `At most ${ASK_LIMIT} asks per person in ${ASK_WINDOW_MS / 60_000} minutes: try again later`);
      const kind = oneOf(body.kind, ['bug', 'feature'], 'Kind') as 'bug' | 'feature' | null;
      if (!kind) throw new HttpError(400, 'Kind is required: bug or feature');
      const text = str(body.text, 'Text', 10_000);
      const files = askFiles(body.files);
      const scheme = c.home_scheme === null ? undefined : app.store.getProject(c.home_scheme);
      if (!scheme) throw new HttpError(409, `${c.title} has no home scheme to send asks to: an admin sets one in Settings → Contraptions`);
      const taskmaster = await ensureCoordinator(app, scheme);
      askTimes.set(key, [...recent, Date.now()]);
      const paths = saveAskFiles(projectSharedDir(app.dataDir, scheme.id), c.name, person.login, files);
      // A member as #211 counts one: in the scheme, or an admin.
      const member = app.store.canSee({ uid: person.id, admin: !!person.admin }, scheme.id);
      const ask = askMessage(c, scheme, person, member, kind, text, paths);
      app.runner.send(taskmaster.id, ask.author, ask.text);
      return json(res, 202, { scheme: scheme.name, member, proposal: !member && kind === 'feature', files: paths });
    },
  },
];
