// Contraptions (src/contraptions.ts): admins register them, edit them, enable them per person and
// rotate their keys; anyone signed in lists the ones enabled for them, for the app rail.
import { CONTRAPTION_NAME } from '../contraptions.ts';
import type { ContraptionRow } from '../db.ts';
import { HttpError, json, readJson, type App, type Route } from '../http.ts';

// Names the turn API (section 4) and the rail take under /api/contraptions/.
const RESERVED = new Set(['mine', 'turns', 'sessions']);

/** A contraption as Settings → Contraptions shows it: never a key. */
function view(app: App, c: ContraptionRow) {
  return {
    name: c.name, title: c.title, icon: c.icon, port: c.port, home_scheme: c.home_scheme, open_paths: JSON.parse(c.open_paths) as string[],
    default_model: c.default_model, turn_cap: c.turn_cap, keys_at: c.keys_at, keys_dir: app.contraptions.folder(c.name),
    people: app.store.contraptionUsers(c.id),
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

const admin = { who: ['person'], access: 'admin' } as const;

export const contraptionRoutes: Route[] = [
  {
    // The rail's list: the contraptions enabled for you. Empty for most people.
    method: 'GET', path: '/api/contraptions/mine', who: ['person'],
    handler: ({ res, app, session }) => json(res, 200, typeof session.uid === 'number' ? app.store.contraptionsFor(session.uid) : []),
  },
  { method: 'GET', path: '/api/contraptions', ...admin, handler: ({ res, app }) => json(res, 200, app.store.listContraptions().map((c) => view(app, c))) },
  {
    // Register: its key files are written now, for its own service to read.
    method: 'POST', path: '/api/contraptions', ...admin,
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
  },
  {
    // Its name stays: it is in its paths and its key folder.
    method: 'PATCH', path: '/api/contraptions/:name', ...admin,
    async handler({ req, res, app, params }) {
      const c = contraption(app, params.name);
      app.store.updateContraption(c.name, fields(app, await readJson(req), false));
      return json(res, 200, view(app, contraption(app, c.name)));
    },
  },
  {
    // Enable or disable it for one person; disabling takes at their next request.
    method: 'PUT', path: '/api/contraptions/:name/people/:person', ...admin,
    async handler({ req, res, app, params, session }) {
      const c = contraption(app, params.name);
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Say enabled: true or false');
      if (!app.store.getUser(Number(params.person))) throw new HttpError(404, 'No such person');
      app.store.setContraptionUser(c.id, Number(params.person), body.enabled, session.uid ?? null);
      return json(res, 200, view(app, c));
    },
  },
  {
    // Rotate: new identity key pair and contraption key, both files rewritten. Its service restarts to read them.
    method: 'POST', path: '/api/contraptions/:name/keys', ...admin,
    handler({ res, app, params }) {
      const c = contraption(app, params.name);
      app.contraptions.rotate(c.name);
      return json(res, 200, view(app, contraption(app, c.name)));
    },
  },
];
