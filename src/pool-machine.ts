// A turn's link to a machine's MCP server inside the shared tool server (#1259), in place of a src/machine-mcp.ts
// process per machine per turn. Lazy: a turn's start (initialize, tools/list) is answered from the machine's
// remembered tool list, and the machine's session opens only on the turn's first real call. Without a remembered
// list the session opens at tools/list, and every session that opens refreshes the list.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callEnv } from './pool-context.ts';
import { thrown } from './thrown.ts';

/** A JSON-RPC message, as far as this file reads it. */
interface Rpc {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: unknown;
}
type Link = { session: string; stream: AbortController; pending: Map<unknown, (msg: Rpc) => void>; queue: Promise<unknown> };
type Turn = { handshake: Rpc[]; link: Promise<Link> | null };

// Claude's MCP handshake replayed to a session it never saw (or a new one): the machine's reply to it is dropped.
const REPLAY_ID = 'citadel-replayed-initialize';
const REFRESH_ID = 'citadel-tools-refresh';
/** By turn token, then machine and server. */
const turns = new Map<string, Map<string, Turn>>();

/** Close a forgotten turn's machine sessions. */
export function dropLinks(token: string) {
  for (const t of turns.get(token)?.values() ?? [])
    t.link?.then(
      (l) => l.stream.abort(),
      () => {},
    );
  turns.delete(token);
}

const cachePath = (dir: string, machine: number, server: string) => join(dir, `${machine}-${server}.json`);
function readCache(dir: string, machine: number, server: string): { init: Record<string, unknown>; tools: unknown[] } | null {
  try {
    const c = JSON.parse(readFileSync(cachePath(dir, machine, server), 'utf8'));
    return c?.init && Array.isArray(c?.tools) ? c : null;
  } catch {
    return null;
  }
}
function writeCache(dir: string, machine: number, server: string, patch: { init?: Record<string, unknown>; tools?: unknown[] }) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = cachePath(dir, machine, server);
    let old: Record<string, unknown> = {};
    try {
      old = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
    writeFileSync(`${file}.${process.pid}`, JSON.stringify({ ...old, ...patch }), { mode: 0o600 });
    renameSync(`${file}.${process.pid}`, file);
  } catch {}
}

const error = (id: unknown, message: string) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } });

/** One MCP message from a turn to a machine: its answer, or null for a notification. */
export async function machineRequest(token: string, machine: number, server: 'mcp' | 'ws', name: string, msg: Rpc, cacheDir: string): Promise<object | null> {
  const env = callEnv();
  const api = env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
  const route = env.COORDINATOR_MACHINE_ROUTE === 'contraption-session' ? 'contraption-session' : 'session';
  const k = `${machine}/${server}`;
  let byKey = turns.get(token);
  if (!byKey) turns.set(token, (byKey = new Map()));
  let turn = byKey.get(k);
  if (!turn) byKey.set(k, (turn = { handshake: [], link: null }));
  if (msg?.method === 'initialize' || msg?.method === 'notifications/initialized') {
    turn.handshake = msg.method === 'initialize' ? [msg] : [...turn.handshake.filter((m) => m.method === 'initialize'), msg];
  }
  const headers = { Authorization: `Bearer ${token}` };
  async function post(l: Link, m: Rpc) {
    const r = await fetch(`${api}/api/machines/${machine}/${route}/${l.session}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: m }) });
    if (!r.ok) throw new Error(r.status === 503 || r.status === 404 ? 'the machine went offline' : `the app answered ${r.status}`);
  }
  const cache = readCache(cacheDir, machine, server);
  if (msg?.id === undefined) {
    // A notification reaches an open session only; the handshake is replayed when one opens. A lost one is dropped:
    // a throw here would end the pool, and every turn's calls with it.
    if (turn.link) turn.link.then((l) => post(l, msg)).catch(() => {});
    return null;
  }
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  if (!turn.link && cache && (msg.method === 'initialize' || msg.method === 'tools/list')) {
    return { jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? cache.init : { tools: cache.tools } };
  }
  const t = turn;
  if (!t.link) {
    t.link = open(api, route, machine, server, name, headers, msg.method === 'initialize' ? [] : t.handshake, cacheDir, () => {
      if (byKey!.get(k) === t) t.link = null;
    });
    t.link.catch(() => (t.link = null));
  }
  let link: Link;
  try {
    link = await t.link;
  } catch (err) {
    return error(msg.id, `${name}: ${thrown(err).message}`);
  }
  const answer = new Promise<Rpc>((done) => link.pending.set(msg.id, done));
  // The machine sees a turn's messages in order.
  link.queue = link.queue.then(() => post(link, msg)).catch((err: unknown) => link.pending.get(msg.id)?.(error(msg.id, `${name}: ${thrown(err).message}`)));
  const reply = await answer;
  link.pending.delete(msg.id);
  if (!reply.error) {
    if (msg.method === 'initialize') writeCache(cacheDir, machine, server, { init: reply.result });
    if (msg.method === 'tools/list' && Array.isArray(reply.result?.tools)) writeCache(cacheDir, machine, server, { tools: reply.result.tools });
  }
  return reply;
}

/** Open the machine's session stream; a machine that is offline (503) gets about 20 s to come back. */
async function open(api: string, route: string, machine: number, server: string, name: string, headers: Record<string, string>, replay: Rpc[], cacheDir: string, closed: () => void): Promise<Link> {
  const stream = new AbortController();
  const started = Date.now();
  let res: Response;
  for (;;) {
    let why: string;
    try {
      res = await fetch(`${api}/api/machines/${machine}/${route}?server=${server}`, { headers: { ...headers, Accept: 'text/event-stream' }, signal: stream.signal });
      if (res.ok && res.body) break;
      why = `${name} is not available (${res.status}): ${await res.text().catch(() => '')}`;
      if (res.status !== 503) throw new Error(why);
    } catch (err) {
      const e = thrown(err);
      if (e.name === 'AbortError' || /not available/.test(e.message!)) throw err;
      why = `could not reach the app: ${e.message}`;
    }
    if (Date.now() - started > 20_000) throw new Error(why);
    await new Promise((r) => setTimeout(r, 1000));
  }
  let markReady!: (l: Link) => void;
  let fail!: (e: Error) => void;
  const ready = new Promise<Link>((ok, no) => ((markReady = ok), (fail = no)));
  const link: Link = { session: '', stream, pending: new Map(), queue: Promise.resolve() };
  const end = (why: string) => {
    closed();
    for (const [id, done] of link.pending) done(error(id, `${name}: ${why}`));
    fail(new Error(why));
  };
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body!) {
        buf += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const m = JSON.parse(data);
          if (m.closed) return end('its MCP server exited');
          if (m.session) {
            link.session = m.session;
            // Replay the turn's handshake if the machine hasn't seen it, then refresh the remembered tool list.
            for (const h of replay) await post(h.id === undefined ? h : { ...h, id: REPLAY_ID });
            if (replay.length) await post({ jsonrpc: '2.0', id: REFRESH_ID, method: 'tools/list' });
            markReady(link);
          } else if (m.message?.id === REFRESH_ID) {
            if (Array.isArray(m.message.result?.tools)) writeCache(cacheDir, machine, server, { tools: m.message.result.tools });
          } else if (m.message?.id === REPLAY_ID) {
            if (m.message.result) writeCache(cacheDir, machine, server, { init: m.message.result });
          } else if (m.message?.id !== undefined && !m.message.method) {
            const done = link.pending.get(m.message.id);
            if (done) done(m.message);
          }
          // shortcut: the machine's own notifications and requests to the client are dropped (no stream back to Claude); add a GET stream if a machine needs them.
        }
      }
      end('the connection to the machine dropped (the app restarted?), so this call was lost');
    } catch (err) {
      end(thrown(err).name === 'AbortError' ? 'the turn ended' : 'the connection to the machine dropped (the app restarted?), so this call was lost');
    }
  })();
  async function post(m: Rpc) {
    const r = await fetch(`${api}/api/machines/${machine}/${route}/${link.session}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: m }) });
    if (!r.ok) throw new Error(`the app answered ${r.status}`);
  }
  return ready;
}
