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
const headers = { Authorization: `Bearer ${TOKEN}` };

function fail(text: string): never {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

const res = await fetch(`${API}/api/machines/${MACHINE}/session`, { headers: { ...headers, Accept: 'text/event-stream' } })
  .catch((err) => fail(`Could not reach the app: ${err.message}`));
if (!res.ok || !res.body) fail(`${NAME} is not available (${res.status}): ${await res.text().catch(() => '')}`);

let session = '';
let markReady: () => void;
const ready = new Promise<void>((r) => (markReady = r));

/** Reply to a request that can't reach the machine, so claude gets an error instead of waiting. */
function unreachable(message: any, why: string) {
  if (message?.id === undefined || !message.method) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `${NAME}: ${why}` } })}\n`);
}

// Claude's messages, sent one at a time so the machine sees them in order.
let chain = ready;
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  chain = chain.then(async () => {
    try {
      const r = await fetch(`${API}/api/machines/${MACHINE}/session/${session}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!r.ok) unreachable(message, r.status === 503 || r.status === 404 ? 'the machine went offline' : `the app answered ${r.status}`);
    } catch (err: any) {
      unreachable(message, `could not reach the app (${err.message})`);
    }
  });
}).on('close', () => process.exit(0));

// The machine's messages, as server-sent events: first our session id, then one MCP message each.
const decoder = new TextDecoder();
let buf = '';
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, end);
    buf = buf.slice(end + 2);
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    const msg = JSON.parse(data);
    if (msg.session) {
      session = msg.session;
      markReady!();
    } else if (msg.message !== undefined) {
      process.stdout.write(`${JSON.stringify(msg.message)}\n`);
    }
  }
}
fail(`${NAME} disconnected.`);
