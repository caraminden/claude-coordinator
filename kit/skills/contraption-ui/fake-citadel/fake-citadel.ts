// A fake Citadel for an app's tests: no server, no Claude login. Start it in-process, point the app's
// CITADEL_URL at `fake.url`, its CITADEL_KEYS at `fake.keysDir`, and call `fake.identity(person)` for the
// X-Citadel-Identity header a page request would carry. Node 24+, no dependencies.
//
// It answers the calls `references/api.md` describes, with the same statuses and body shapes:
//   turns (SSE, scripted), cancel, messages, verdict, sessions, media + openrouter, spend, asks (and asks/files uploads), home,
//   minions, relay, push (each enabled person has one phone, and every send reaches it).
// Citadel's own repo runs it against the real API (test/fake-citadel-contract.test.ts), so the two can't
// drift. What it leaves out: the audit, caps, containers, jobs, embeddings and secrets; a call to one of
// those answers 404 `not_faked` so a test never passes by accident. Also not faked, and so unlike the real
// stream and asks: the `taken` event for a steered message, an `interrupted` error's `retry`, and an ask's
// `scheme` (the fake answers the home's id, Citadel its name). Asks hit the 429 and the dismissed-minion 409
// only when scripted: `askLimit` and a minion's `status: 'closed'`.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What an app sent to POST /api/contraptions/turns. */
export interface TurnRequest {
  person: number;
  session: string;
  prompt: string;
  fresh?: boolean;
  system?: string;
  model?: string;
  compactWindow?: number;
  effort?: 'low' | 'medium' | 'high';
  toolSearch?: boolean;
  mcp?: { name: string; path: string; headers?: Record<string, string> }[];
  agents?: false | { max?: number; model?: string };
  webSearch?: boolean;
  machines?: boolean;
  blind?: boolean;
  keep?: boolean;
  images?: string[];
  media?: boolean;
  timeoutSec?: number;
}

/**
 * One step of a scripted turn.
 * - text: the agent's words (a new model message after each tool call, as the real stream does).
 * - tool: a tool call. `run` does what the tool would (an app test calls its own MCP server there); a throw
 *   or `ok: false` makes the tool_result fail.
 * - media: a `media` event before the next tool_result, as a media tool's call does.
 * - grunt: an Agent call whose inner tool steps carry its id as `parent`; its text steps are not streamed, as Citadel never streams a Grunt's words.
 * - error: ends the turn with an `error` event of that code.
 * - wait: holds the stream open until the promise settles (to press Stop, say).
 */
export type Step = { text: string } | { tool: string; input?: Record<string, unknown>; ok?: boolean; error?: string; run?: () => unknown | Promise<unknown> } | { media: Record<string, unknown> } | { grunt: string; steps: Step[] } | { error: string; message?: string } | { wait: Promise<unknown> };

export interface FakePerson {
  id: number;
  login: string;
  name: string;
  apps?: string[];
  member?: boolean;
}
export interface FakeApp {
  key?: string;
  title?: string;
  origin?: () => string;
  relayPaths?: string[];
}

export interface FakeOptions {
  /** Your app's name (the `app` claim; `/apps/<app>`). */
  app: string;
  /** Who's enabled. Default: one person, id 1, login `tester`, enabled for `app`. */
  people?: FakePerson[];
  /** The scripted answer to each turn. Default: one short reply. */
  script?: (req: TurnRequest) => Step[] | Promise<Step[]>;
  /** Other contraptions the relay can reach (your own is `app`; it is not listed). */
  apps?: Record<string, FakeApp>;
  /** Your home scheme, or null for none (asks, spend and home then answer 409). */
  home?: { id: number; name: string } | null;
  /** Asks one person may send before the next answers 429, as Citadel's loop backstop does. Default: no limit. */
  askLimit?: number;
  /** Minions of the home scheme, for GET /minions/<n>. */
  minions?: Record<number, Record<string, unknown>>;
  /** The openrouter state for GET /openrouter, by person. */
  openrouter?: Record<number, { connected: boolean; [k: string]: unknown }>;
  port?: number;
}

export interface FakeCitadel {
  /** CITADEL_URL for your app. */
  url: string;
  /** CITADEL_KEYS for your app: a folder with identity.pub and contraption.key, as on the box. */
  keysDir: string;
  /** Your app's bearer key. */
  key: string;
  /** The public key the fake signs with, to build a verifier from. */
  publicKey: KeyObject;
  /** A signed X-Citadel-Identity header for a person (default: the first). `from` names a relayed caller. */
  identity(person?: number, extra?: { from?: string; fromTitle?: string; app?: string; ttlSec?: number }): string;
  /** Everything recorded, for assertions. */
  turns: TurnRequest[];
  canceled: string[];
  messages: { turn: string; person: number; text: string }[];
  verdicts: { turn: string; verdict: string; reason?: string }[];
  asks: Record<string, unknown>[];
  spend: Record<string, unknown>[];
  /** POST /api/contraptions/push bodies that passed its checks, with the logins it skipped. */
  pushes: { to: string[]; title?: string; body?: string; open?: string; tag?: string; data?: Record<string, string>; skipped: string[] }[];
  relayed: { to: string; method: string; path: string; identity: string }[];
  close(): Promise<void>;
}

const ASK_KINDS = ['bug', 'feature', 'data'];
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => void res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const fail = (res: ServerResponse, status: number, error: string) => json(res, status, { error });
const under = (path: string, entry: string) => path === entry || path.startsWith(entry.endsWith('/') ? entry : `${entry}/`);
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** A call's JSON body: unchecked, each route checks the fields it reads. */
type AppBody = Record<string, unknown>;

/** Why a push body would be refused (Citadel's src/fcm.ts parsePush), or null. */
function pushProblem(app: string, b: AppBody): string | null {
  const to = typeof b?.to === 'string' ? [b.to] : b?.to;
  if (!Array.isArray(to) || !to.length || to.length > 100 || to.some((l) => typeof l !== 'string' || !l || l.length > 200)) return 'to must be a login, or a list of 1 to 100 logins';
  for (const [k, max, min] of [
    ['title', 200, 1],
    ['body', 2000, 0],
    ['open', 1000, 0],
    ['tag', 100, 0],
  ] as const) {
    const v = b[k];
    if (v !== undefined && (typeof v !== 'string' || v.length < min || v.length > max)) return `${k} must be a string of at most ${max} characters`;
  }
  if (b.title === undefined && (b.body !== undefined || b.open !== undefined || b.tag !== undefined)) return 'body, open and tag go with a title';
  if (b.open !== undefined && (!(b.open as string).startsWith(`/apps/${app}/`) || /[\\\u0000-\u001f\u007f]|%2e|%2f|%5c|\/\.\.?(\/|$|\?|#)/i.test(b.open as string))) return `open must be a path under /apps/${app}/`;
  const data: Record<string, string> = {};
  if (b.data !== undefined) {
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return 'data must be an object of string values';
    for (const [k, v] of Object.entries(b.data)) {
      if (typeof v !== 'string') return `data.${k} must be a string`;
      if (!k || k.startsWith('citadel_') || ['from', 'notification', 'message_type'].includes(k) || k.startsWith('google.') || k.startsWith('gcm.')) return `data key "${k}" is reserved`;
      data[k] = v;
    }
  }
  if (b.title === undefined && !Object.keys(data).length) return 'Send a title or data (or both)';
  // Firebase's 4 KB, counted over the data block Citadel sends (the app's keys plus citadel_*).
  const sent: Record<string, unknown> = { ...data, citadel_app: app, ...(b.title === undefined ? {} : { citadel_title: b.title, citadel_body: b.body ?? '', citadel_open: b.open, citadel_tag: b.tag }) };
  const bytes = Object.entries(sent).reduce((n, [k, v]) => n + (v === undefined ? 0 : Buffer.byteLength(k) + Buffer.byteLength(v as string)), 0);
  return bytes > 4096 ? `the data block comes to ${bytes} bytes; Firebase takes at most 4096` : null;
}

export async function startFakeCitadel(opts: FakeOptions): Promise<FakeCitadel> {
  const keys = generateKeyPairSync('ed25519');
  const appKeys = new Map<string, { key: string; priv: KeyObject }>();
  const people = (opts.people ?? [{ id: 1, login: 'tester', name: 'Tester' }]).map((p) => ({ apps: [opts.app], member: false, ...p }));
  const key = 'ck_' + randomBytes(32).toString('base64url');
  const keysDir = mkdtempSync(join(tmpdir(), 'fake-citadel-keys-'));
  writeFileSync(join(keysDir, 'identity.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(keysDir, 'contraption.key'), key);
  const others = opts.apps ?? {};
  for (const [name, a] of Object.entries(others)) appKeys.set(name, { key: a.key ?? 'ck_' + randomBytes(32).toString('base64url'), priv: generateKeyPairSync('ed25519').privateKey });
  const script = opts.script ?? (() => [{ text: 'Done.' }]);
  const home = opts.home === undefined ? { id: 1, name: 'Home' } : opts.home;

  const sign1 = (app: string, priv: KeyObject, p: FakePerson, extra: { from?: string; fromTitle?: string; ttlSec?: number } = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({ app, sub: p.id, login: p.login, name: p.name, iat, exp: iat + (extra.ttlSec ?? 60), ...(extra.from ? { from: extra.from, fromTitle: extra.fromTitle } : {}) })).toString('base64url');
    return `v1.${claims}.${sign(null, Buffer.from(`v1.${claims}`), priv).toString('base64url')}`;
  };

  const f: FakeCitadel = {
    url: '',
    keysDir,
    key,
    publicKey: keys.publicKey,
    identity: (person = people[0].id, extra = {}) => {
      const p = people.find((x) => x.id === person);
      if (!p) throw new Error(`fake Citadel: no person ${person}`);
      return sign1(extra.app ?? opts.app, keys.privateKey, p, extra);
    },
    turns: [],
    canceled: [],
    messages: [],
    verdicts: [],
    asks: [],
    spend: [],
    pushes: [],
    relayed: [],
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(keysDir, { recursive: true, force: true });
          r();
        });
      }),
  };

  const sessions = new Map<string, { person: number; name: string; lastUsed: number; busy: boolean }>();
  const turnState = new Map<string, { person: number; ended: boolean; replied: boolean }>();
  // Big files for asks, from POST /api/contraptions/asks/files: counted, not kept.
  const uploads = new Map<string, { person: number; name: string }>();
  const running = new Map<string, () => void>();
  let n = 0;
  let turnN = 0;
  const askCount = new Map<string, number>();

  const body = async (req: IncomingMessage, res: ServerResponse, max: number): Promise<AppBody | undefined> => {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return void fail(res, 415, 'Send application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) return void fail(res, 413, 'Too large');
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return void fail(res, 400, 'Invalid JSON');
    }
  };
  // The person a call acts for: enabled for this app, else 403 not_enabled; bad id, 400.
  // A query string's person is a digit string (bad id, 400); an ask's body person is a JSON integer, and
  // anything else (a string included) is 403 as on Citadel.
  const enabled = (res: ServerResponse, raw: unknown, inBody = false) => {
    const id = !inBody && typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!whole(id)) return void (inBody ? json(res, 403, { error: 'not_enabled' }) : fail(res, 400, 'person must be a user id'));
    const p = people.find((x) => x.id === id);
    if (!p || !p.apps.includes(opts.app)) return void json(res, 403, { error: 'not_enabled' });
    return p;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      if (req.headers['x-forwarded-for'] || req.headers.forwarded || /(^|;\s*)cc_session=/.test(req.headers.cookie ?? '')) return fail(res, 403, 'not_local');
      const auth = req.headers.authorization;
      const callerEntry = [...appKeys].find(([, a]) => auth === `Bearer ${a.key}`);
      if (auth !== `Bearer ${key}` && !callerEntry) return fail(res, 401, 'bad contraption key');
      if (callerEntry && !path.startsWith('/api/contraptions/relay/')) return fail(res, 401, 'bad contraption key');
      const q = url.searchParams;
      const m = req.method;

      if (path.startsWith('/api/contraptions/relay/')) return relay(req, res, path, url.search, callerEntry?.[0] ?? opts.app);
      if (path === '/api/contraptions/turns' && m === 'POST') return turn(req, res);
      let t = /^\/api\/contraptions\/turns\/([^/]+)\/(cancel|messages|verdict)$/.exec(path);
      if (t && m === 'POST') {
        const state = turnState.get(t[1]);
        if (t[2] === 'cancel') {
          if (!state || state.ended) return fail(res, 404, 'No such turn');
          f.canceled.push(t[1]);
          running.get(t[1])?.();
          return json(res, 200, { ok: true });
        }
        const b = await body(req, res, 100_000);
        if (b === undefined) return;
        if (t[2] === 'messages') {
          if (!whole(b.person) || typeof b.text !== 'string' || !b.text.trim()) return fail(res, 400, 'person and text are required');
          if (!state) return fail(res, 404, 'No such turn');
          if (b.person !== state.person) return fail(res, 403, "Not the turn's person");
          f.messages.push({ turn: t[1], person: b.person, text: b.text });
          if (state.ended) return json(res, 200, { steered: false, reason: 'ended' });
          if (state.replied) return json(res, 200, { steered: false, reason: 'replied' });
          return json(res, 200, { steered: true, id: `msg-${f.messages.length}` });
        }
        if (b.verdict !== 'pass' && b.verdict !== 'fallback') return fail(res, 400, 'verdict is pass or fallback');
        if (b.reason != null && (typeof b.reason !== 'string' || b.reason.length > 2000)) return fail(res, 400, 'reason is too long');
        if (!state) return fail(res, 404, 'No such turn');
        f.verdicts.push({ turn: t[1], verdict: b.verdict, reason: b.reason ?? undefined });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/contraptions/sessions' && m === 'GET') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        return json(
          res,
          200,
          [...sessions.values()]
            .filter((s) => s.person === p.id)
            .sort((a, b) => b.lastUsed - a.lastUsed)
            .map(({ name, lastUsed, busy }) => ({ name, lastUsed, busy })),
        );
      }
      t = /^\/api\/contraptions\/sessions\/([^/]+)$/.exec(path);
      if (t && m === 'DELETE') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        const name = decodeURIComponent(t[1]);
        const s = sessions.get(`${p.id}:${name}`);
        if (!s) return fail(res, 404, 'No such session');
        if (s.busy) return fail(res, 409, 'busy');
        sessions.delete(`${p.id}:${name}`);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/contraptions/openrouter' && m === 'GET') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        return json(res, 200, opts.openrouter?.[p.id] ?? { connected: false, account_url: null });
      }
      if (path === '/api/contraptions/media' && m === 'GET') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        return json(res, 200, { files: [] });
      }
      if (path === '/api/contraptions/spend' && m === 'POST') {
        const b = await body(req, res, 100_000);
        if (b === undefined) return;
        if (typeof b.service !== 'string' || !b.service || b.service.length > 64 || typeof b.usd !== 'number' || !(b.usd > 0) || b.usd > 10_000) return fail(res, 400, 'service and usd are required');
        if (!home) return fail(res, 409, 'No home scheme');
        f.spend.push(b);
        const month = f.spend.reduce((s, x) => s + (x.usd as number), 0);
        return json(res, 200, { month_usd: month, cap_usd: null, over: false, over_cap: false });
      }
      if (path === '/api/contraptions/push' && m === 'POST') {
        const b = await body(req, res, 64 * 1024);
        if (b === undefined) return;
        const bad = pushProblem(opts.app, b);
        if (bad) return fail(res, 400, bad);
        const to: string[] = [...new Set<string>(typeof b.to === 'string' ? [b.to] : (b.to as string[]))];
        const skipped = to.filter((l) => !people.some((p) => p.login === l && p.apps.includes(opts.app)));
        const data = b.data && Object.keys(b.data).length ? (b.data as Record<string, string>) : undefined;
        f.pushes.push({ to, title: b.title as string | undefined, body: b.body as string | undefined, open: b.open as string | undefined, tag: b.tag as string | undefined, data, skipped });
        const devices = to.length - skipped.length;
        return json(res, 200, { devices, sent: devices, dropped: 0, skipped });
      }
      if (path === '/api/contraptions/asks/files' && m === 'POST') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        if (!home) return fail(res, 409, 'No home scheme');
        let size = 0;
        for await (const c of req) size += c.length;
        if (size > 200 * 1024 * 1024) return fail(res, 413, 'An uploaded file is at most 200 MiB');
        const upload = randomBytes(12).toString('hex');
        const name = (q.get('name') ?? '').split(/[\\/]/).pop() || 'file';
        uploads.set(upload, { person: p.id, name });
        return json(res, 201, { upload, name, size });
      }
      if (path === '/api/contraptions/asks' && m === 'POST') {
        const b = await body(req, res, 23_000_000);
        if (b === undefined) return;
        const p = enabled(res, b.person, true);
        if (!p) return;
        if (!ASK_KINDS.includes(b.kind as string)) return fail(res, 400, 'kind is bug, feature or data');
        if (b.kind !== 'data' && (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 10_000)) return fail(res, 400, 'text is required');
        if (b.files != null && !Array.isArray(b.files)) return fail(res, 400, 'Files must be a list');
        if (b.kind === 'data' && !((b.files as unknown[] | null | undefined)?.length || b.text || b.summary || b.item)) return fail(res, 400, 'data needs files, text, summary or item');
        if (b.minion != null && (b.kind === 'data' || !whole(b.minion))) return fail(res, 400, 'minion is a whole number from 1');
        if (!home) return fail(res, 409, 'No home scheme');
        if (opts.askLimit !== undefined) {
          const k = `${p.id}${b.kind === 'data' ? ':data' : ''}`;
          if ((askCount.get(k) ?? 0) >= opts.askLimit) return fail(res, 429, `At most ${opts.askLimit} asks per person: try again later`);
          askCount.set(k, (askCount.get(k) ?? 0) + 1);
        }
        if (b.minion != null && !p.member) return fail(res, 403, 'Only members can ask a minion');
        if (b.minion != null && !opts.minions?.[b.minion as number]) return fail(res, 404, 'No such minion');
        if (b.minion != null && opts.minions![b.minion as number].status === 'closed') return fail(res, 409, `#${b.minion} is dismissed: a person reopens it first`);
        const asked = (b.files ?? []) as { name?: string; upload?: string }[];
        const named = asked.map((x) => (x.upload === undefined ? x.name : uploads.get(x.upload)?.person === p.id ? (x.name ?? uploads.get(x.upload)!.name) : null));
        if (named.includes(null)) return fail(res, 404, 'No upload');
        for (const x of asked) if (x.upload !== undefined) uploads.delete(x.upload);
        f.asks.push(b);
        const files = named.map((name) => `inbox/${opts.app}/${p.login}/${name}`);
        if (b.kind === 'data') return json(res, 202, { scheme: home.id, member: !!p.member, proposal: false, files, sidecar: `inbox/${opts.app}/${p.login}/${Date.now()}-ask.json` });
        if (b.minion != null) return json(res, 202, { scheme: home.id, minion: b.minion, member: true, proposal: false, files });
        return json(res, 202, { scheme: home.id, member: !!p.member, proposal: b.kind === 'feature' && !p.member, files });
      }
      if (path === '/api/contraptions/home' && m === 'GET') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        if (!home) return fail(res, 409, 'No home scheme');
        return json(res, 200, { id: home.id, name: home.name, member: !!p.member });
      }
      t = /^\/api\/contraptions\/minions(?:\/([^/]+))?$/.exec(path);
      if (t && m === 'GET') {
        const p = enabled(res, q.get('person'));
        if (!p) return;
        if (!home) return fail(res, 409, 'No home scheme');
        if (!p.member) return fail(res, 403, 'Members only');
        if (t[1] === undefined) {
          const ns = (q.get('n') ?? '').split(',').filter(Boolean).map(Number);
          if (!ns.length || ns.length > 50 || !ns.every(whole)) return fail(res, 400, 'n is 1 to 50 minion numbers');
          return json(res, 200, { minions: [...new Set(ns)].filter((x) => opts.minions?.[x]).map((x) => opts.minions![x]) });
        }
        const num = /^\d+$/.test(t[1]) ? Number(t[1]) : 0;
        if (!whole(num)) return fail(res, 400, 'a minion number is a whole number from 1');
        const mn = opts.minions?.[num];
        return mn ? json(res, 200, mn) : fail(res, 404, 'No such minion');
      }
      return fail(res, 404, 'not_faked');
    } catch (err) {
      if (!res.headersSent) fail(res, 500, (err as Error).message);
      else res.end();
    }
  });

  async function turn(req: IncomingMessage, res: ServerResponse) {
    const b = (await body(req, res, 4_000_000)) as TurnRequest | undefined;
    if (b === undefined) return;
    // From here on, like Citadel, every outcome is an event on a 200 stream.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: string, data: unknown) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const refuse = (code: string, message: string) => {
      send('error', { code, message });
      res.end();
    };
    const bad = badTurn({ ...b });
    if (bad) return refuse('bad_request', bad);
    const p = people.find((x) => x.id === b.person);
    if (!p || !p.apps.includes(opts.app)) return refuse('not_enabled', 'That person does not have this app enabled');
    const key = `${p.id}:${b.session}`;
    if (sessions.get(key)?.busy) return refuse('busy', 'A turn is already running in that session');
    f.turns.push(b);
    sessions.set(key, { person: p.id, name: b.session, lastUsed: Date.now(), busy: true });
    const id = ++turnN;
    const key2 = String(id);
    const state = { person: p.id, ended: false, replied: false };
    turnState.set(key2, state);
    let canceled = false;
    let stopWaiting = () => {};
    running.set(key2, () => {
      canceled = true;
      stopWaiting();
    });
    res.on('close', () => {
      if (!state.ended) {
        canceled = true;
        stopWaiting();
      }
    });
    send('start', { turn: id, session: b.session, claudeSession: `fake-session-${id}`, provider: 'claude', model: b.model ?? null });
    let message = 1;
    const run = async (steps: Step[], parent: string | null): Promise<boolean> => {
      for (const step of steps) {
        if (canceled) return false;
        if ('wait' in step)
          await Promise.race([
            step.wait,
            new Promise<void>((r) => {
              stopWaiting = r;
            }),
          ]);
        else if ('text' in step) {
          if (!parent) send('text', { delta: step.text, parent, message: `${id}-m${message}` });
        } else if ('media' in step) send('media', step.media);
        else if ('error' in step) {
          if (!parent) send('error', { code: step.error, message: ('message' in step ? step.message : undefined) ?? `fake ${step.error}` });
          return false;
        } else {
          const callId = `tool-${++n}`;
          if (!parent) message++;
          if ('grunt' in step) {
            send('tool', { id: callId, name: 'Agent', input: { description: step.grunt, subagent_type: 'general-purpose', prompt: step.grunt }, parent });
            const ok = await run(step.steps, callId);
            send('tool_result', { id: callId, ok, parent });
            continue;
          }
          send('tool', { id: callId, name: step.tool, input: step.input ?? {}, parent });
          let ok = step.ok ?? true;
          let error = step.error;
          try {
            await step.run?.();
          } catch (err) {
            ok = false;
            error = (err as Error).message;
          }
          send('tool_result', { id: callId, ok, parent, ...(ok ? {} : { error: error ?? 'The tool failed' }) });
        }
      }
      return true;
    };
    let ended = false;
    try {
      const ok = await run(await script(b), null);
      state.replied = true;
      if (canceled) send('error', { code: 'canceled', message: 'The turn was canceled' });
      else if (ok) {
        send('end', { stop: 'end_turn', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, provider: 'claude', model: b.model ?? null });
        ended = true;
      } else ended = true; // an error step already sent its event
    } catch (err) {
      send('error', { code: 'failed', message: (err as Error).message });
    } finally {
      void ended;
      state.ended = true;
      running.delete(key2);
      const s = sessions.get(key);
      if (s) {
        s.busy = false;
        s.lastUsed = Date.now();
      }
      res.end();
    }
  }

  // The turn body's rules from api.md ("Start a turn"); the first broken one names itself.
  function badTurn(b: AppBody): string | null {
    if (!whole(b?.person)) return 'person must be a user id from 1';
    if (typeof b.session !== 'string' || !/^[\w.:@-]{1,100}$/.test(b.session)) return 'session must match ^[\\w.:@-]{1,100}$';
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) return 'prompt must not be blank';
    if (b.model != null && !(typeof b.model === 'string' && /^[\w.[\]-]{1,60}$/.test(b.model))) return 'model is not valid';
    if (b.compactWindow != null && !(whole(b.compactWindow) && b.compactWindow >= 10_000 && b.compactWindow <= 1_000_000)) return 'compactWindow must be 10000 to 1000000';
    if (b.effort != null && !['low', 'medium', 'high'].includes(b.effort as string)) return 'effort must be low, medium or high';
    for (const flag of ['fresh', 'toolSearch', 'webSearch', 'machines', 'blind', 'keep', 'media']) if (b[flag] !== undefined && typeof b[flag] !== 'boolean') return `${flag} must be true or false`;
    if (b.timeoutSec != null && !(whole(b.timeoutSec) && b.timeoutSec <= 900)) return 'timeoutSec must be 1 to 900';
    if (b.mcp !== undefined) {
      if (!Array.isArray(b.mcp) || b.mcp.length > 10) return 'mcp is at most 10 servers';
      const seen = new Set<string>();
      for (const s of b.mcp) {
        if (typeof s?.name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(s.name) || seen.has(s.name)) return 'mcp names are unique, 1 to 40 of A-Za-z0-9_-';
        seen.add(s.name);
        if (typeof s.path !== 'string' || !s.path.startsWith('/') || s.path.length > 200) return 'mcp path starts with / and is at most 200 characters';
      }
      if (b.media && seen.has('citadel')) return 'with media on, an mcp server cannot be called citadel';
    }
    if (b.agents !== undefined && b.agents !== false && !(b.agents && typeof b.agents === 'object')) return 'agents is false or { max, model }';
    if (b.blind && b.keep) return 'keep cannot be used with blind';
    if (b.images !== undefined && (!Array.isArray(b.images) || b.images.length > 8)) return 'images is at most 8 paths';
    return null;
  }

  // The relay: the checks in the order api.md lists them, then the call goes on with a fresh identity
  // signed for the target. Only registered `apps` can be reached; the fake's own app is the caller.
  async function relay(req: IncomingMessage, res: ServerResponse, path: string, search: string, caller: string) {
    const m = /^\/api\/contraptions\/relay\/([a-z0-9-]+)(\/.*)?$/.exec(path);
    const to = m?.[1] ?? '';
    const target = others[to];
    if (!m || !target || to === caller) return fail(res, 404, 'no_route');
    const pid = String(req.headers['x-citadel-person'] ?? '');
    if (!/^\d+$/.test(pid)) return fail(res, 400, 'X-Citadel-Person must be a user id');
    const p = people.find((x) => x.id === Number(pid));
    if (!p || !p.apps.includes(caller) || !p.apps.includes(to)) return fail(res, 403, 'not_enabled');
    const sub = m[2] ?? '/';
    if (/%2e|%2f|%5c|\/\.\.?(\/|$)/i.test(sub) || !(target.relayPaths ?? []).some((e) => under(sub, e))) return fail(res, 404, 'no_route');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) return fail(res, 413, 'too_large');
      chunks.push(c);
    }
    const type = req.headers['content-type'];
    if (size && !/^application\/json\b/.test(type ?? '')) return fail(res, 415, 'send application/json');
    if (size && req.method === 'GET') return fail(res, 400, 'a GET has no body');
    const identity = sign1(to, appKeys.get(to)!.priv, p, { from: caller, fromTitle: caller === opts.app ? opts.app : (others[caller]?.title ?? caller) });
    f.relayed.push({ to, method: req.method ?? 'GET', path: sub, identity });
    if (!target.origin) return fail(res, 502, `${target.title ?? to} is not answering`);
    try {
      const headers: Record<string, string> = { 'x-citadel-identity': identity };
      if (type) headers['content-type'] = type;
      if (req.headers.accept) headers.accept = req.headers.accept as string;
      const out = await fetch(`${target.origin()}/apps/${to}${sub}${search}`, { method: req.method, headers, body: size ? Buffer.concat(chunks) : undefined, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const ct = out.headers.get('content-type');
      res.writeHead(out.status, ct ? { 'content-type': ct } : {}).end(Buffer.from(await out.arrayBuffer()));
    } catch (err) {
      fail(res, (err as Error).name === 'TimeoutError' ? 504 : 502, (err as Error).name === 'TimeoutError' ? 'timeout' : `${target.title ?? to} is not answering`);
    }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return f;
}
