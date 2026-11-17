// Contraptions (src/contraptions.ts): admins register them, edit them, enable them per person and
// rotate their keys, as does Citadel's Taskmaster on an admin's turn (#246); anyone signed in lists
// the ones enabled for them, for the app rail; a contraption's own server sends its people's bug
// reports, feature asks and data to its home scheme (src/contraption-asks.ts) and runs turns for its people through the turn API (src/contraption-turns.ts).
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { APP_NAME } from '../appname.ts';
import { adminAskRefusal } from '../access.ts';
import { AGENT_NAME } from '../auth.ts';
import { ASK_FILES_MAX, ASK_ITEM_MAX, ASK_SUMMARY_MAX, askFiles, askLine, askMessage, askSummary, saveAskFiles } from '../contraption-asks.ts';
import { parseTurn, TurnError } from '../contraption-turns.ts';
import { loadImages } from '../turn-images.ts';
import { listMedia, mcpMessage, mediaDir, mediaFile, mediaTools, MEDIA_TYPE, runMediaTool } from '../contraption-media.ts';
import { CONTRAPTION_NAME } from '../contraptions.ts';
import { ServiceError } from '../app-services.ts';
import { contraptionRead } from '../contraption-read.ts';
import { mandateItem, SCHEME_CALLER } from '../mandate-items.ts';
import { relay } from '../relay.ts';
import type { ContraptionRow, Ticket } from '../db.ts';
import { HttpError, json, oneOf, readJson, send, SECURITY_HEADERS, str, type App, type Ctx, type Route } from '../http.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import { projectSharedDir } from '../workspace.ts';
import { ensureCoordinator } from './projects.ts';

// Names the turn API (section 4) and the rail take under /api/contraptions/.
const RESERVED = new Set(['mine', 'turns', 'sessions', 'asks', 'relay', 'home', 'minions', 'media', 'openrouter']);

/** A contraption as Settings → Contraptions shows it: never a key. */
function view(app: App, c: ContraptionRow) {
  return {
    name: c.name, title: c.title, icon: c.icon, port: c.port, home_scheme: c.home_scheme, open_paths: JSON.parse(c.open_paths) as string[],
    relay_paths: JSON.parse(c.relay_paths) as string[],
    default_model: c.default_model, turn_cap: c.turn_cap, keys_at: c.keys_at, keys_dir: app.contraptions.folder(c.name),
    repo: c.repo, branch: c.branch, folder: c.folder, // as set: null means main and ~/apps/<name>
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
  for (const [key, list, one] of [['open_paths', 'Open paths', 'An open path'], ['relay_paths', 'Relay paths', 'A relay path']] as const) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key]) || body[key].length > 20) throw new HttpError(400, `${list} must be a list of at most 20 paths`);
    out[key] = JSON.stringify(body[key].map((p: unknown) => path(p, one)));
  }
  if (body.default_model !== undefined) {
    const m = body.default_model;
    if (m !== null && m !== '' && (typeof m !== 'string' || !/^[\w.\[\]-]{1,60}$/.test(m))) throw new HttpError(400, 'Default model must be a model name like haiku');
    out.default_model = m || null;
  }
  if (body.turn_cap !== undefined) out.turn_cap = int(body.turn_cap, 'Turn cap', 1, 100_000);
  // Where it deploys from (#266): only an admin sets these, so only a repo an admin chose is ever built.
  const optional = (key: 'repo' | 'branch' | 'folder', ok: RegExp, says: string) => {
    if (body[key] === undefined) return;
    const v = typeof body[key] === 'string' ? body[key].trim() : body[key];
    if (v !== null && v !== '' && (typeof v !== 'string' || !ok.test(v) || v.split('/').includes('..'))) throw new HttpError(400, says);
    out[key] = v || null;
  };
  optional('repo', /^[\w.-]{1,100}\/[\w.-]{1,100}$/, 'Repo must be a GitHub owner/name, like caraminden/mandate');
  optional('branch', /^(?!-)[\w.\/-]{1,100}$/, 'Branch must be a branch name, like main');
  optional('folder', /^~?\/[\w.+\/-]{1,200}$/, 'Folder must be an absolute path or one under ~/, like ~/apps/mandate');
  return out;
}

/**
 * An admin route: for admins, and for the Citadel scheme's Taskmaster on a turn an admin asked for (its
 * contraption tools in src/mcp.ts). The registry is Citadel-wide, so other
 * schemes' Taskmasters ask that one.
 */
const admin = (route: Pick<Route, 'method' | 'path' | 'handler'>): Route => ({
  ...route, who: ['person', 'taskmaster'], access: 'admin',
  handler(ctx) {
    const { app, caller } = ctx;
    if (!caller) return route.handler(ctx);
    if (caller.project_id !== GLOBAL_OWNER) {
      throw new HttpError(403, `Only the ${APP_NAME} scheme's ${AGENT_NAME} manages contraptions: ask it with message_taskmaster`);
    }
    const refused = adminAskRefusal(app.store, caller.id);
    if (refused) throw new HttpError(403, refused);
    return route.handler(ctx);
  },
});

/** A service call (src/app-services.ts), its refusals as HTTP errors. */
async function service<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ServiceError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

/** The to-do list each contraption's home Taskmaster was last sent (by contraption and scheme), so a deploy that changes nothing wakes no one. */
const lastTodo = new Map<string, string>();

/**
 * A deployed app's to-dos (#418: no rail icon, or a web manifest that won't install it) to its home scheme's
 * Taskmaster, as the person who deployed it. Not when that Taskmaster deployed it (its tool answer lists
 * them), nor when it was sent the same list already; an empty list (all done) forgets the last one sent.
 */
export async function deployTodo(app: Pick<App, 'store' | 'runner' | 'dataDir'>, c: ContraptionRow, caller: Ctx['caller'], asker: number | null, todo: string[]) {
  const scheme = c.home_scheme === null ? undefined : app.store.getProject(c.home_scheme);
  if (!scheme) return;
  const at = `${c.name}:${scheme.id}`;
  const key = todo.join('\n');
  if (!todo.length) return void lastTodo.delete(at);
  if (lastTodo.get(at) === key || (caller?.kind === 'coordinator' && caller.project_id === scheme.id)) return;
  const text = `To do for ${c.title} (${c.name}): it deployed, but it still lacks what every contraption ships with, a rail icon and a web manifest that installs it as its own app:\n${todo.map((t) => `- ${t}`).join('\n')}\n\nIf no minion is on it yet, start one: the citadel:contraption-ui skill's references/installing.md and its starter's icon files say how. Then deploy again, which checks.`;
  const taskmaster = await ensureCoordinator(app as App, scheme);
  app.runner.send(taskmaster.id, APP_NAME, text, [], { asker });
  lastTodo.set(at, key);
}

/**
 * The contraption a deploy call names, if the caller may deploy it: an admin; Citadel's Taskmaster on a
 * turn an admin asked for; or a Taskmaster or minion of its home scheme. Anyone else learns nothing of it.
 */
function deployable(app: App, name: string, caller: Ctx['caller']): ContraptionRow {
  const c = app.store.getContraption(name);
  if (!caller) {
    // A person is an admin by now (the route's access).
    if (!c) throw new HttpError(404, 'No such contraption');
    return c;
  }
  if (c && c.home_scheme !== null && caller.project_id === c.home_scheme) return c;
  if (caller.kind === 'coordinator' && caller.project_id === GLOBAL_OWNER) {
    const refused = adminAskRefusal(app.store, caller.id);
    if (refused) throw new HttpError(403, refused);
    if (!c) throw new HttpError(404, 'No such contraption');
    return c;
  }
  throw new HttpError(403, `Only its home scheme's ${AGENT_NAME} and minions, or an admin, deploy a contraption`);
}

/**
 * Start a contraption's deploy by `by` (deploy_contraption, a release card's Deploy button, or auto-deploy, #629): its
 * install check reads the app's page as person `uid` (none: only the registry's icon is checked), and its to-dos go to
 * its home Taskmaster. Throws a ServiceError when it can't start (no repo, a deploy already running, services off).
 */
export function startDeploy(app: App, c: ContraptionRow, by: string, caller: Ctx['caller'], uid: number | null) {
  const person = uid != null ? app.store.getUser(uid) : undefined;
  const identity = person ? () => app.contraptions.signIdentity(c.name, person) : undefined;
  const hooks = {
    // Only into an empty icon: one set by hand meanwhile stays.
    setIcon: (icon: string) => {
      if (app.store.getContraption(c.name)?.icon) return false;
      app.store.updateContraption(c.name, { icon });
      return true;
    },
    todo: (todo: string[]) => void deployTodo(app, c, caller, person?.id ?? null, todo).catch((err) => console.error(`Couldn't send ${c.name}'s deploy to-dos to its home Taskmaster:`, err)),
  };
  return app.services.deploy(c, by, app.store.listContraptions(), identity, hooks);
}

/** Asks per contraption and person: ASK_LIMIT in ASK_WINDOW_MS, then 429. shortcut: kept in memory, so a restart forgets it; fine as a loop backstop. */
const ASK_LIMIT = 10;
/** Data asks wake no one, so they get more room (one per save, say); a loop backstop on their count, not their size. */
const DATA_ASK_LIMIT = 60;
const ASK_WINDOW_MS = 10 * 60_000;
const askTimes = new Map<string, number[]>();

/** A turn API route: 'contraption' routes get the calling contraption (src/contraptions.ts caller) as ctx.contraption. */
const fromContraption = (method: string | readonly string[], path: string, handler: (ctx: Ctx, c: ContraptionRow) => unknown): Route => ({
  method, path, who: 'contraption', handler: (ctx) => handler(ctx, ctx.contraption),
});

/** The `person` a sessions call names, who must have the contraption enabled. */
function enabledPerson(app: App, c: ContraptionRow, url: URL): number {
  const person = Number(url.searchParams.get('person'));
  if (!Number.isInteger(person) || person < 1) throw new HttpError(400, 'person must be a person\'s id');
  if (!app.contraptions.enabled(c.name, person)) throw new HttpError(403, 'not_enabled');
  return person;
}

/** The app's home scheme and whether `person` is a member: in it, or an admin, as #211 counts one. */
function homeOf(app: App, c: ContraptionRow, person: number) {
  const scheme = c.home_scheme === null ? undefined : app.store.getProject(c.home_scheme);
  if (!scheme) throw new HttpError(409, `${c.title} has no home scheme: an admin sets one in Settings → Contraptions`);
  const user = app.store.getUser(person);
  return { scheme, member: !!user && app.store.canSee({ uid: user.id, admin: !!user.admin }, scheme.id) };
}

/** The home scheme a minion read (#421) looks in, for a member only: minion state is the scheme's business. */
function memberHome(app: App, c: ContraptionRow, url: URL) {
  const person = enabledPerson(app, c, url);
  const { scheme, member } = homeOf(app, c, person);
  if (!member) throw new HttpError(403, `That person isn't a ${scheme.name} member, so can't see its minions`);
  return scheme;
}

/** A minion as a contraption sees it (#421): what the minions list shows, never chat text. */
function minionProgress(app: App, t: Ticket) {
  const card = t.status === 'closed' ? null : app.store.openCardAt(t.id);
  return {
    number: t.number, title: t.title, status: t.status, state: t.state, note: t.note, ...app.runner.progressOf(t),
    activity_at: t.updated_at, card_waiting: card !== null, card_since: card, link: `/c/#/p/${t.project_id}/t/${t.number}`,
  };
}

/** Answer JSON with an ETag, or 304 when the caller's If-None-Match already has it, so polling costs next to nothing. */
function jsonTagged(req: IncomingMessage, res: Ctx['res'], body: unknown) {
  const text = JSON.stringify(body);
  const tag = `"${createHash('sha1').update(text).digest('base64url')}"`;
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  return json(res, 200, body, { ETag: tag, 'Cache-Control': 'no-cache' });
}

/** A call to the embed route: at most this many texts, each about 1,000 tokens at most, well inside one llama-server slot. */
const EMBED_TEXTS = 16;
const EMBED_CHARS = 4000;

/** The most minions one list read names. */
const MINIONS_MAX = 50;

/** Server-sent events, one at a time, unbuffered. */
function eventStream(req: IncomingMessage, res: Ctx['res']) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  req.socket.setNoDelay(true);
  return (event: string, data: object) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export const contraptionRoutes: Route[] = [
  // First, so a relayed path like /people/5 never reads as an admin route on a contraption called relay (reserved anyway).
  { method: ['GET', 'PUT', 'POST', 'DELETE'], path: '/api/contraptions/relay/:to/*rest', who: 'contraption', handler: (ctx) => relay(ctx, ctx.contraption) },
  // mandate_item (#268): a minion or Taskmaster puts or clears an item in its asker's Mandate.
  { method: ['PUT', 'DELETE'], path: '/api/mandate/items/:key', who: ['taskmaster', 'minion'], refuse: 'Only a minion or Taskmaster puts items for its scheme', handler: mandateItem },
  // contraption_read (#295): a minion or Taskmaster reads its asker's data in a contraption, through the app's read commands.
  { method: 'POST', path: '/api/contraption-read/:app', who: ['taskmaster', 'minion'], refuse: "Only a minion or Taskmaster reads a person's contraption data", handler: contraptionRead },
  // Semantic memory's model for the app's own data (#488): texts in, unit vectors out. The box's CPU does it,
  // so nothing leaves it; the app stores and searches the vectors itself, and keeps them with `model`.
  fromContraption('POST', '/api/contraptions/embed', async ({ req, res, app }) => {
    const { texts } = await readJson(req);
    if (!Array.isArray(texts) || !texts.length || texts.length > EMBED_TEXTS || texts.some((t) => typeof t !== 'string' || !t.trim() || t.length > EMBED_CHARS)) {
      throw new HttpError(400, `texts: 1 to ${EMBED_TEXTS} non-empty strings of at most ${EMBED_CHARS} characters`);
    }
    const vecs = await app.memory.embed(texts).catch((err) => {
      console.error('Embedding for a contraption failed:', err?.cause?.code ?? err?.message ?? err);
      throw new HttpError(503, "The embedding service isn't answering");
    });
    return json(res, 200, { model: app.memory.model, vectors: vecs.map((v) => [...v]) });
  }),
  // #421: whether a person is a member of the app's home scheme, and its minions' progress for members.
  fromContraption('GET', '/api/contraptions/home', ({ res, app, url }, c) => {
    const { scheme, member } = homeOf(app, c, enabledPerson(app, c, url));
    return json(res, 200, { id: scheme.id, name: scheme.name, member });
  }),
  fromContraption('GET', '/api/contraptions/minions', ({ req, res, app, url }, c) => {
    const scheme = memberHome(app, c, url);
    const raw = url.searchParams.get('n') ?? '';
    const numbers = raw.split(',').map(Number);
    if (!raw || numbers.length > MINIONS_MAX || numbers.some((n) => !Number.isInteger(n) || n < 1)) throw new HttpError(400, `n must be 1 to ${MINIONS_MAX} minion numbers, comma-separated`);
    const minions = [...new Set(numbers)].flatMap((n) => {
      const t = app.store.getTicketByNumber(scheme.id, n);
      return t && t.kind !== 'coordinator' ? [minionProgress(app, t)] : [];
    });
    return jsonTagged(req, res, { minions });
  }),
  fromContraption('GET', '/api/contraptions/minions/:number', ({ req, res, app, url, params }, c) => {
    const scheme = memberHome(app, c, url);
    const n = Number(params.number);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Not a minion number');
    const t = app.store.getTicketByNumber(scheme.id, n);
    if (!t || t.kind === 'coordinator') throw new HttpError(404, `No minion #${n} in ${scheme.name}`);
    return jsonTagged(req, res, minionProgress(app, t));
  }),
  fromContraption('POST', '/api/contraptions/turns', async ({ req, res, app }, c) => {
    const body = await readJson(req, 4_000_000);
    // Before the stream opens, so a refused image is a plain HTTP 400 or 413 (#834).
    const imageBlocks = body && typeof body === 'object' && body.images !== undefined ? await loadImages(body.images, app.services.dataDir(c)) : [];
    const emit = eventStream(req, res);
    // The contraption hung up: stop its turn rather than run it for nobody.
    let turn: number | null = null;
    let gone = false;
    const hungUp = new AbortController();
    res.on('close', () => {
      if (res.writableFinished) return;
      gone = true;
      hungUp.abort();
      if (turn !== null) app.contraptionTurns.cancel(c.id, turn);
    });
    try {
      await app.contraptionTurns.run(c, { ...parseTurn(body, c), imageBlocks }, (event, data) => {
        if (event === 'start') {
          turn = (data as { turn: number }).turn;
          if (gone) app.contraptionTurns.cancel(c.id, turn);
        }
        emit(event, data);
      }, hungUp.signal);
    } catch (err) {
      if (!(err instanceof TurnError)) throw err;
      emit('error', { code: err.code, message: err.message });
    }
    res.end();
  }),
  // Media on contraption turns (#732, src/contraption-media.ts): the files a person's turns made, and their OpenRouter standing.
  fromContraption('GET', '/api/contraptions/media', ({ res, app, url }, c) => json(res, 200, { files: listMedia(mediaDir(app.dataDir, c.name, enabledPerson(app, c, url))) })),
  fromContraption(['GET', 'DELETE'], '/api/contraptions/media/*path', ({ req, res, app, url, params }, c) => {
    const file = mediaFile(mediaDir(app.dataDir, c.name, enabledPerson(app, c, url)), params.path);
    if (req.method === 'GET') return send(res, 200, { ...SECURITY_HEADERS, 'Content-Type': MEDIA_TYPE[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }, readFileSync(file));
    rmSync(file);
    if (!file.endsWith('.json')) rmSync(`${file}.json`, { force: true });
    return json(res, 200, { ok: true });
  }),
  fromContraption('GET', '/api/contraptions/openrouter', ({ res, app, url }, c) => {
    const person = enabledPerson(app, c, url);
    const user = app.store.getUser(person);
    const who = { uid: person, admin: !!user?.admin };
    // The account page lives under a scheme: the home scheme if they're in it, else any they see.
    const scheme = (c.home_scheme !== null && app.store.canSee(who, c.home_scheme) ? c.home_scheme : null) ?? app.store.listProjects().find((p) => app.store.canSee(who, p.id))?.id;
    const account_url = scheme === undefined ? null : `/c/#/p/${scheme}/account`;
    const s = app.openrouter.status(person);
    if (!s.connected) return json(res, 200, { connected: false, account_url });
    return json(res, 200, { connected: true, failed: s.failed, cap_usd: s.cap_usd, spent_usd: s.spent_usd, left_usd: s.left_usd, resets: s.resets, account_url });
  }),
  // The `citadel` MCP server a media turn's agent calls (streamable HTTP, JSON answers), with the turn's own token.
  {
    method: ['POST', 'GET', 'DELETE'], path: '/api/contraption-media/mcp', who: 'anyone',
    handler: async ({ req, res, app }) => {
      const token = (req.headers.authorization ?? '').match(/^Bearer (cmt_[\w-]+)$/)?.[1];
      const turn = token ? app.contraptionTurns.mediaTurn(token) : null;
      if (!turn) throw new HttpError(401, 'Not a running contraption turn with media');
      // No server-sent stream and no sessions: every answer comes back on its POST.
      if (req.method !== 'POST') return send(res, 405, { Allow: 'POST' }, '');
      const answer = await mcpMessage(await readJson(req, 1_000_000), mediaTools(turn), (tool, args) => runMediaTool(app.openrouter, app.dataDir, turn, tool, args));
      if (!answer) return send(res, 202, {}, '');
      return json(res, 200, answer);
    },
  },
  fromContraption('POST', '/api/contraptions/turns/:turn/cancel', ({ res, app, params }, c) => {
    if (!app.contraptionTurns.cancel(c.id, Number(params.turn))) throw new HttpError(404, 'No such turn running');
    return json(res, 200, { ok: true });
  }),
  // Steer a running turn as its person: { person, text } → { steered: true, id } (its `taken` event carries
  // the id), or { steered: false, reason: 'ended' | 'replied' }, when the app sends it as the next turn.
  fromContraption('POST', '/api/contraptions/turns/:turn/messages', async ({ req, res, app, params }, c) => {
    const body = await readJson(req, 4_000_000);
    if (!Number.isInteger(body?.person) || body.person < 1) throw new HttpError(400, 'person must be a person\'s id');
    if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required');
    const out = app.contraptionTurns.steer(c.id, Number(params.turn), body.person, body.text);
    if (!out) throw new HttpError(404, 'No such turn');
    if (out === 'other_person') throw new HttpError(403, 'Only the turn\'s own person can steer it');
    return json(res, 200, out);
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
    // The rail's list: the contraptions enabled for you, in the order you dragged them into (#649), and whether each is up. Empty for most people.
    method: 'GET', path: '/api/contraptions/mine', who: ['person'],
    handler: async ({ res, app, session }) => json(res, 200, typeof session.uid !== 'number' ? [] : await app.contraptions.mine(session.uid)),
  },
  admin({ method: 'GET', path: '/api/contraptions', handler: ({ res, app }) => json(res, 200, app.store.listContraptions().map((c) => view(app, c))) }),
  admin({
    // Register: its key files are written now, for its own service to read.
    method: 'POST', path: '/api/contraptions',
    async handler({ req, res, app }) {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!CONTRAPTION_NAME.test(name) || RESERVED.has(name)) throw new HttpError(400, 'Name must be a short slug: lowercase letters, digits and dashes, like mandate');
      // Mandate takes a scheme-<id> caller as Citadel speaking for that scheme (src/mandate-items.ts).
      if (SCHEME_CALLER.test(name)) throw new HttpError(400, `${name} is reserved: scheme-<number> names stand for ${APP_NAME}'s schemes`);
      if (app.store.getContraption(name)) throw new HttpError(409, `There is already a contraption called ${name}`);
      const f = fields(app, body, true);
      const c = app.contraptions.register({
        name, title: f.title!, port: f.port!, icon: f.icon ?? null, home_scheme: f.home_scheme ?? null, open_paths: f.open_paths ?? '[]', relay_paths: f.relay_paths ?? '[]',
        default_model: f.default_model ?? null, turn_cap: f.turn_cap ?? null, repo: f.repo ?? null, branch: f.branch ?? null, folder: f.folder ?? null,
      });
      void app.releases.refresh(true); // its App row shows up at once (#627)
      return json(res, 201, view(app, c));
    },
  }),
  admin({
    // Its name stays: it is in its paths and its key folder.
    method: 'PATCH', path: '/api/contraptions/:name',
    async handler({ req, res, app, params }) {
      const c = contraption(app, params.name);
      app.store.updateContraption(c.name, fields(app, await readJson(req), false));
      void app.releases.refresh(true); // a new home scheme or repo moves its row (#627)
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
      app.store.setContraptionUser(c.id, person.id, body.enabled, session.uid ?? (caller ? app.store.turnAsker(caller.id) : null));
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
  // Its systemd user service (#266): what it is doing, install (writes its units from its manifest), start, stop, restart, and its journal.
  admin({
    method: 'GET', path: '/api/contraptions/:name/service',
    handler: async ({ res, app, params }) => json(res, 200, await service(() => app.services.status(contraption(app, params.name)))),
  }),
  admin({
    method: 'POST', path: '/api/contraptions/:name/service',
    async handler({ req, res, app, params }) {
      const c = contraption(app, params.name);
      const body = await readJson(req);
      const action = oneOf(body.action, ['install', 'start', 'stop', 'restart'], 'Action');
      if (!action) throw new HttpError(400, 'Action is required: install, start, stop or restart');
      const said = await service(async () => {
        if (action === 'install') return app.services.install(c, { replace: body.replace === true, all: app.store.listContraptions() });
        const { waited } = await app.services.act(c, action as 'start' | 'stop' | 'restart');
        return [...(waited ? [waited] : []), `${{ start: 'Started', stop: 'Stopped', restart: 'Restarted' }[action]} ${app.services.unitOf(c)}.`];
      });
      return json(res, 200, { said, status: await service(() => app.services.status(c)) });
    },
  }),
  admin({
    method: 'GET', path: '/api/contraptions/:name/service/logs',
    handler: async ({ res, app, params, url }) => json(res, 200, { log: await service(() => app.services.logs(contraption(app, params.name), Number(url.searchParams.get('lines')) || 100)) }),
  }),
  // Deploy it from its repo (#266): admins, Citadel's Taskmaster on an admin's turn, and its home scheme's
  // Taskmaster and minions, for that one contraption. Starts it and answers at once; GET follows it.
  {
    method: 'POST', path: '/api/contraptions/:name/deploy', who: ['person', 'taskmaster', 'minion'], access: 'admin',
    handler({ res, app, params, session, caller }) {
      const c = deployable(app, params.name, caller);
      const by = caller ? (caller.kind === 'coordinator' ? `${app.store.getProject(caller.project_id)?.name ?? 'a'} Taskmaster` : `#${caller.number}`) : app.store.getUser(session.uid as number)?.name ?? 'an admin';
      // The install check reads the app's page as the person deploying (a turn's: whoever asked for it).
      const uid = session.uid ?? (caller ? app.store.turnAsker(caller.id) : null);
      return service(async () => json(res, 202, startDeploy(app, c, by, caller, typeof uid === 'number' ? uid : null)));
    },
  },
  {
    method: 'GET', path: '/api/contraptions/:name/deploy', who: ['person', 'taskmaster', 'minion'], access: 'admin',
    handler: async ({ res, app, params, caller }) => {
      const c = deployable(app, params.name, caller);
      return json(res, 200, await service(() => app.services.lastDeploy(c.name)));
    },
  },
  {
    // A bug report or feature ask from a contraption's server, as one of its people: files into the home
    // scheme's shared folder, the ask to its Taskmaster, waking it. A data ask (#318) only files: its files
    // and a sidecar holding its words, with no message and no wake. With `minion`, a member's ask goes
    // straight to that minion instead (#416).
    method: 'POST', path: '/api/contraptions/asks', who: 'contraption',
    async handler({ req, res, app, contraption: c }) {
      // Base64 is 4/3 of the files, plus room for the text.
      const body = (await readJson(req, Math.ceil(ASK_FILES_MAX * 4 / 3) + 1_000_000)) ?? {};
      const person = Number.isInteger(body.person) ? app.store.getUser(body.person) : undefined;
      if (!person || !app.contraptions.enabled(c.name, person.id)) throw new HttpError(403, `${c.title} isn't enabled for that person`);
      const kind = oneOf(body.kind, ['bug', 'feature', 'data'], 'Kind') as 'bug' | 'feature' | 'data' | null;
      if (!kind) throw new HttpError(400, 'Kind is required: bug, feature or data');
      const minion = body.minion ?? null;
      if (minion !== null && (!Number.isInteger(minion) || minion < 1)) throw new HttpError(400, 'Minion must be a minion number');
      if (minion !== null && kind === 'data') throw new HttpError(400, 'A data ask goes to no one: send a bug or feature to a minion');
      // A contraption stuck in a loop would wake the Taskmaster on every call, or fill the disk with data.
      const key = `${c.name}:${person.id}${kind === 'data' ? ':data' : ''}`;
      const limit = kind === 'data' ? DATA_ASK_LIMIT : ASK_LIMIT;
      const recent = (askTimes.get(key) ?? []).filter((t) => Date.now() - t < ASK_WINDOW_MS);
      if (recent.length >= limit) throw new HttpError(429, `At most ${limit} ${kind === 'data' ? 'data asks' : 'asks'} per person in ${ASK_WINDOW_MS / 60_000} minutes: try again later`);
      const text = kind === 'data' && (body.text === undefined || body.text === null) ? null : str(body.text, 'Text', 10_000);
      const summary = askLine(body.summary, 'Summary', ASK_SUMMARY_MAX) ?? (text === null ? null : askSummary(text));
      const item = askLine(body.item, 'Item', ASK_ITEM_MAX);
      const files = askFiles(body.files);
      const scheme = c.home_scheme === null ? undefined : app.store.getProject(c.home_scheme);
      if (!scheme) throw new HttpError(409, `${c.title} has no home scheme to send asks to: an admin sets one in Settings → Contraptions`);
      // A member as #211 counts one: in the scheme, or an admin.
      const member = app.store.canSee({ uid: person.id, admin: !!person.admin }, scheme.id);
      const shared = projectSharedDir(app.dataDir, scheme.id);
      if (kind === 'data') {
        if (!files.length && text === null && summary === null && item === null) throw new HttpError(400, 'A data ask needs files, text, a summary or an item');
        askTimes.set(key, [...recent, Date.now()]);
        const paths = saveAskFiles(shared, c.name, person.login, files);
        const at = new Date().toISOString();
        const record = { contraption: c.name, person: person.login, item, summary, text, files: paths, at };
        const [sidecar] = saveAskFiles(shared, c.name, person.login, [{ name: `${at.replace(/[:.]/g, '-')}-ask.json`, data: Buffer.from(`${JSON.stringify(record, null, 2)}\n`) }]);
        return json(res, 202, { scheme: scheme.name, member, proposal: false, files: paths, sidecar });
      }
      // Straight to one minion of the home scheme (#416), with no Taskmaster in the path: members only,
      // since a non-member's feature ask is only a proposal for the Taskmaster to weigh.
      if (minion !== null) {
        if (!member) throw new HttpError(403, `${person.name} isn't a ${scheme.name} member, so can't send to a minion directly: leave out minion to send the ask to the Taskmaster`);
        const t = app.store.getTicketByNumber(scheme.id, minion);
        if (!t || t.kind === 'coordinator') throw new HttpError(404, `No minion #${minion} in ${scheme.name}`);
        if (t.status === 'closed') throw new HttpError(409, `#${minion} in ${scheme.name} is dismissed: a person reopens it first`);
        askTimes.set(key, [...recent, Date.now()]);
        const paths = saveAskFiles(shared, c.name, person.login, files);
        const ask = askMessage(c, scheme, person, member, kind, text!, paths, item);
        // Under the person's own name, so the turn runs as them (runner.turnPerson goes by author); never typed, so never a go to merge.
        app.runner.send(t.id, person.name, ask.text, [], { asker: person.id, hold: true, ask: { kind, contraption: c.title, person: person.name, member, summary, ...(item ? { item } : {}) } });
        return json(res, 202, { scheme: scheme.name, minion: t.number, member, proposal: false, files: paths });
      }
      const taskmaster = await ensureCoordinator(app, scheme);
      askTimes.set(key, [...recent, Date.now()]);
      const paths = saveAskFiles(shared, c.name, person.login, files);
      const ask = askMessage(c, scheme, person, member, kind, text!, paths, item);
      // The chat shows the ask collapsed to a header and its summary (public/askcard.js); the turn reads the whole text.
      const shown = { kind, contraption: c.title, person: person.name, member, summary, ...(item ? { item } : {}) };
      app.runner.send(taskmaster.id, ask.author, ask.text, [], { asker: person.id, ask: shown });
      return json(res, 202, { scheme: scheme.name, member, proposal: !member && kind === 'feature', files: paths });
    },
  },
];
