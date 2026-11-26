// The shared tool server (#1259): one process per place (a person's container, or the host) and pinned version serves
// the Citadel tools (src/mcp.ts) and the machine links (src/pool-machine.ts) of every turn there, over Claude Code's
// HTTP MCP transport, in place of two helper processes per turn. A turn is known only by its own token, which its
// wrapper registers with the pool's key (src/pool-client.mjs); each call runs in that turn's env and folder.
// Usage: node mcp-pool.ts <dir> <version>. Exits once no turn has registered for a while.
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { handle } from './mcp.ts';
import { poolAlive } from './pool-client.mjs';
import { beatWhileOpen, turnStore, type TurnContext } from './pool-context.ts';
import { dropLinks, machineRequest } from './pool-machine.ts';
import { POOLED_WINDOWS } from './machine-pick.ts';
import { thrown } from './thrown.ts';
import type { RpcRequest } from './mcp-types.ts';

const [dir, version] = process.argv.slice(2);
if (!dir || !version) throw new Error('usage: mcp-pool.ts <dir> <version>');
/** A turn whose wrapper hasn't registered it again in this long is forgotten (its wrapper beats every 2 s). */
const TTL = Number(process.env.CITADEL_POOL_TTL_MS) || 30_000;
/** With no turn registered for this long, the pool exits. */
const IDLE = Number(process.env.CITADEL_POOL_IDLE_MS) || 60_000;
/** A call from a token the pool doesn't know yet (it just restarted) waits this long for the wrapper to register it. */
const WAIT = Number(process.env.CITADEL_POOL_WAIT_MS) || 10_000;

const key = randomBytes(24).toString('hex');
const turns = new Map<string, TurnContext & { seen: number }>();
const waiting = new Map<string, (() => void)[]>();
let idleSince = Date.now();

const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';

async function body<T>(req: IncomingMessage): Promise<T> {
  let text = '';
  for await (const c of req) {
    text += c;
    if (text.length > 20_000_000) throw new Error('too large');
  }
  return JSON.parse(text);
}

function send(res: ServerResponse, status: number, data?: object) {
  if (data === undefined) return void res.writeHead(status).end();
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
}

/** The turn behind `token`, waiting a little for a registration that a pool restart lost. */
async function turnOf(token: string): Promise<TurnContext | null> {
  if (!token) return null;
  if (!turns.has(token)) {
    await new Promise<void>((done) => {
      const list = waiting.get(token) ?? [];
      waiting.set(token, list);
      const wake = () => (clearTimeout(t), done());
      // A token that never registers leaves nothing behind.
      const t = setTimeout(() => {
        list.splice(list.indexOf(wake), 1);
        if (!list.length && waiting.get(token) === list) waiting.delete(token);
        done();
      }, WAIT);
      list.push(wake);
    });
  }
  const t = turns.get(token);
  return t ? { env: t.env, cwd: t.cwd } : null;
}

function register(token: string, b: Record<string, unknown>): string | null {
  if (!token) return 'no token';
  if (!b || typeof b.env !== 'object' || !b.env || typeof b.cwd !== 'string') return 'needs env and cwd';
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.env)) if (typeof v === 'string') env[k] = v;
  // The token is the identity: a turn's tools always call the app as the token that reached them.
  env.COORDINATOR_TOKEN = token;
  const old = turns.get(token);
  turns.set(token, { env: old && JSON.stringify(old.env) === JSON.stringify(env) ? old.env : env, cwd: b.cwd, seen: Date.now() });
  for (const wake of waiting.get(token) ?? []) wake();
  waiting.delete(token);
  return null;
}

/**
 * One MCP message for a turn. A request's answer goes back as an event stream with comment beats, so a call that
 * waits long (an approval card can wait days) keeps its connection; a notification gets 202.
 */
async function serve(req: IncomingMessage, res: ServerResponse, turn: TurnContext, run: (msg: RpcRequest) => Promise<object | null>) {
  let msg: RpcRequest;
  try {
    msg = await body(req);
  } catch {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // shortcut: one message per POST, which is all Claude Code sends; a batch is refused.
  if (Array.isArray(msg)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } });
  if (msg?.id === undefined) {
    turnStore.run(turn, () => run(msg)).catch(() => {});
    return send(res, 202);
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const stopBeat = beatWhileOpen(res);
  const answer = await turnStore.run(turn, () => run(msg)).catch((err: unknown) => ({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: thrown(err).message } }));
  stopBeat();
  res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://pool');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { version, pid: process.pid });
    const token = bearer(req);
    if (req.method === 'POST' && url.pathname === '/register') {
      if (req.headers['x-pool-key'] !== key) return send(res, 403, { error: 'wrong key' });
      let b: Parameters<typeof register>[1];
      try {
        b = await body(req);
      } catch {
        return send(res, 400, { error: 'bad body' });
      }
      const why = register(token, b);
      return why ? send(res, 400, { error: why }) : send(res, 204);
    }
    const machine = /^\/machine\/(\d+|windows)\/(mcp|ws)$/.exec(url.pathname);
    if (url.pathname !== '/mcp' && !machine) return send(res, 404, { error: 'not found' });
    // No server-to-client stream: Claude Code takes 405 as "none", and every answer rides its request's POST.
    if (req.method === 'GET') return send(res, 405);
    if (req.method === 'DELETE') return send(res, 204);
    if (req.method !== 'POST') return send(res, 405);
    const turn = await turnOf(token);
    if (!turn) return send(res, 401, { error: 'unknown turn' });
    if (url.pathname === '/mcp') return await serve(req, res, turn, handle);
    const [, id, srv] = machine!;
    const name = url.searchParams.get('name') || `machine ${id}`;
    return await serve(req, res, turn, (msg) => machineRequest(token, id === POOLED_WINDOWS ? id : Number(id), srv as 'mcp' | 'ws', name, msg, join(dirname(dir), 'machine-tools'), url.searchParams.get('lent')));
  } catch (err) {
    if (!res.headersSent) send(res, 500, { error: thrown(err).message });
    else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

const poolFile = join(dir, 'pool.json');
/** The port this place's pool had before, so turns started then still reach it after a restart. */
function lastPort(): number {
  try {
    return Number(JSON.parse(readFileSync(join(dir, 'port'), 'utf8'))) || 0;
  } catch {
    return 0;
  }
}

const listen = (port: number) =>
  new Promise<boolean>((done) => {
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => done(true));
  });
/**
 * Running turns' Claude has the last port in its env for good, so a restart waits up to 10 s for it to come free
 * before taking a new one (then only turns started from now on reach the pool; the others lose their tools).
 */
async function bind(): Promise<boolean> {
  const last = lastPort();
  for (const end = Date.now() + 10_000; last; ) {
    if (await listen(last)) return true;
    if (Date.now() > end) break;
    await sleep(500);
  }
  return listen(0);
}
if (!(await bind())) throw new Error('could not listen');
const port = (server.address() as AddressInfo).port;
const write = (file: string, text: string) => {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};
/** Another pool already serving this place and version (a second starter raced a slow start): its turns hold its port, so this one goes. */
function other(): boolean {
  try {
    const pid = JSON.parse(readFileSync(poolFile, 'utf8')).pid;
    return Number.isInteger(pid) && pid !== process.pid && poolAlive(pid);
  } catch {
    return false;
  }
}
/** Put this pool on record unless a live one is: a hard link, which fails if the record exists, so two starters can't both win. */
function claim(): boolean {
  const mine = `${poolFile}.${process.pid}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, port, key, version }), { mode: 0o600 });
  try {
    for (let i = 0; i < 2; i++) {
      try {
        linkSync(mine, poolFile);
        return true;
      } catch (err) {
        if (thrown(err).code !== 'EEXIST') throw err;
      }
      if (other()) return false;
      try {
        unlinkSync(poolFile); // a dead pool's record
      } catch {}
    }
    return false;
  } finally {
    unlinkSync(mine);
  }
}
if (!claim()) process.exit(0);
write(join(dir, 'port'), String(port));
/** This pool is the one on record (another starter may have cleared it in the moment it claimed). */
const onRecord = () => {
  try {
    return JSON.parse(readFileSync(poolFile, 'utf8')).pid === process.pid;
  } catch {
    return false;
  }
};

setInterval(
  () => {
    const now = Date.now();
    for (const [token, t] of turns)
      if (now - t.seen > TTL) {
        turns.delete(token);
        dropLinks(token);
      }
    if (turns.size) idleSince = now;
    else if (now - idleSince > IDLE || !onRecord()) {
      // Gone from pool.json first, so a turn starting now starts a fresh pool rather than registering with this one.
      try {
        if (onRecord()) unlinkSync(poolFile);
      } catch {}
      process.exit(0);
    }
  },
  Math.min(1000, TTL / 2),
).unref();
// Keep running while idle so turns can find it; the interval above decides when to go.
setInterval(() => {}, 1 << 30);
