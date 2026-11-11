// Stdio MCP server that stands in for a machine's own MCP server during a thread's turn (see
// src/machines.ts). It holds no tools of its own: every message from claude goes through the app
// to the machine, and every message the machine's server writes comes back to claude.
// Started by claude from the turn's --mcp-config with the machine's id as its argument; reaches the
// app with the thread's token from the environment, like src/mcp.ts.
import { createInterface } from 'node:readline';

const API = process.env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
const TOKEN = process.env.COORDINATOR_TOKEN ?? '';
const MACHINE = Number(process.argv[2]);
const NAME = process.argv[3] ?? `machine ${MACHINE}`;
// 'ws' for the machine agent's own workspace tools, else the MCP server it lends.
const SERVER = process.argv[4] === 'ws' ? 'ws' : 'mcp';
// A contraption turn's proxy opens its person's machine on its own route (#306), with its turn's token.
const ROUTE = process.env.COORDINATOR_MACHINE_ROUTE === 'contraption-session' ? 'contraption-session' : 'session';
const headers = { Authorization: `Bearer ${TOKEN}` };

function fail(text: string): never {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

/**
 * Open the machine's session stream. The first try fails fast; after the app restarts, it keeps trying,
 * through "offline" (503) answers too: the machine's agent reconnects some seconds after the app is back.
 */
async function connect(first: boolean): Promise<Response> {
  const started = Date.now();
  for (;;) {
    let why: string;
    try {
      const res = await fetch(`${API}/api/machines/${MACHINE}/${ROUTE}?server=${SERVER}`, { headers: { ...headers, Accept: 'text/event-stream' } });
      if (res.ok && res.body) return res;
      const text = await res.text().catch(() => '');
      // The app answered: on a first try a machine that is offline stays offline, so don't keep claude waiting.
      if (first || res.status !== 503) fail(`${NAME} is not available (${res.status}): ${text}`);
      why = `${NAME} is not available (${res.status}): ${text}`;
    } catch (err: any) {
      if (first) fail(`Could not reach the app: ${err.message}`);
      why = `Could not reach the app: ${err.message}`;
    }
    if (Date.now() - started > 120_000) fail(why);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let session = '';
let markReady: () => void;
let ready = new Promise<void>((r) => (markReady = r));
// Claude's MCP handshake, replayed to the new session after a reconnect; the machine's reply to it is dropped.
const handshake: any[] = [];
const REPLAY_ID = 'citadel-replayed-initialize';

// Claude's requests posted to the machine and not answered yet, by id: answered with an error if the stream ends first.
const pending = new Map<unknown, any>();

/** Reply to a request that can't reach the machine, so claude gets an error instead of waiting. */
function unreachable(message: any, why: string) {
  if (message?.id === undefined || !message.method || !pending.delete(message.id)) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `${NAME}: ${why}` } })}\n`);
}

async function post(message: any): Promise<Response> {
  return fetch(`${API}/api/machines/${MACHINE}/${ROUTE}/${session}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

// Claude's messages, sent one at a time so the machine sees them in order.
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.method === 'initialize' || message?.method === 'notifications/initialized') handshake.push(message);
  chain = chain.then(async () => {
    await ready;
    if (message?.id !== undefined && message.method) pending.set(message.id, message);
    try {
      const r = await post(message);
      if (!r.ok) unreachable(message, r.status === 503 || r.status === 404 ? 'the machine went offline' : `the app answered ${r.status}`);
    } catch (err: any) {
      unreachable(message, `could not reach the app (${err.message})`);
    }
  });
}).on('close', () => process.exit(0));

// The machine's messages, as server-sent events: first our session id, then one MCP message each.
// The stream ends when the app restarts; reconnect, and replay the handshake to the new session.
for (let first = true; ; first = false) {
  const res = await connect(first);
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body!) {
      buf += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const msg = JSON.parse(data);
        if (msg.closed) {
          // The machine's MCP server exited: reconnecting would only start it again, so give up.
          for (const m of [...pending.values()]) unreachable(m, 'its MCP server exited');
          process.stderr.write(`${NAME}: its MCP server exited\n`, () => process.stdout.write('', () => process.exit(1)));
          await new Promise(() => {});
        } else if (msg.session) {
          session = msg.session;
          if (!first) for (const m of handshake) await post(m.id === undefined ? m : { ...m, id: REPLAY_ID }).catch(() => {});
          markReady!();
        } else if (msg.message !== undefined && msg.message?.id !== REPLAY_ID) {
          if (msg.message?.id !== undefined && !msg.message.method) pending.delete(msg.message.id);
          process.stdout.write(`${JSON.stringify(msg.message)}\n`);
        }
      }
    }
  } catch {
    // Cut off mid-stream: the app went away.
  }
  // The machine's agent stops its servers when the app goes, so no reply to these will come.
  for (const m of [...pending.values()]) unreachable(m, 'the connection to the machine dropped (the app restarted?), so this call was lost');
  ready = new Promise<void>((r) => (markReady = r));
}
