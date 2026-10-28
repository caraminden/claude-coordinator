// Boot check for tools/deploy.sh: start a checkout's server on a spare port against a copy of the
// database, confirm it serves the app and that its MCP server initializes and reaches the API, then
// stop it. Prints the front-end version it served; exits non-zero with the reason on any failure.
//   node tools/boot-check.ts <checkout> <coordinator.db>
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync, backup } from 'node:sqlite';

const [checkout, db] = process.argv.slice(2);
if (!checkout || !db) throw new Error('usage: boot-check.ts <checkout> <coordinator.db>');
const { Auth } = await import(join(checkout, 'src', 'auth.ts'));

const root = mkdtempSync(join(tmpdir(), 'citadel-boot-check-'));
const procs: ChildProcess[] = [];
let log = '';
const fail = (why: string) => {
  throw new Error(`${why}${log ? `\n--- server output ---\n${log.slice(-3000)}` : ''}`);
};

try {
  // A consistent copy even while the live server writes (WAL).
  const copy = join(root, 'coordinator.db');
  const live = new DatabaseSync(db, { readOnly: true });
  await backup(live, copy);
  live.close();

  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const server = spawn(process.execPath, [join(checkout, 'server.ts')], {
    cwd: checkout,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: root, BOOT_CHECK: '1', CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: password, SESSION_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(server);
  server.stdout!.on('data', (d) => (log += d));
  server.stderr!.on('data', (d) => (log += d));

  let health: any = null;
  for (const end = Date.now() + 20_000; !health; await new Promise((r) => setTimeout(r, 100))) {
    if (server.exitCode !== null) fail(`The server exited during boot (code ${server.exitCode})`);
    if (Date.now() > end) fail('The server did not answer /api/health within 20 s');
    health = await fetch(`${base}/api/health`).then((r) => (r.ok ? r.json() : null), () => null);
  }
  const page = await fetch(`${base}/`);
  if (page.status !== 200 || !/<html/i.test(await page.text())) fail(`The app page answered ${page.status}`);

  // The MCP server a turn would start, run as a ticket of the copy so its tool call goes through the API.
  const store = new DatabaseSync(copy, { readOnly: true });
  const ticket = (store.prepare("select id, project_id, kind from tickets order by kind = 'coordinator' desc, id limit 1").get() ?? null) as any;
  store.close();
  const mcp = spawn(process.execPath, [join(checkout, 'src', 'mcp.ts')], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      COORDINATOR_API: base, COORDINATOR_TOKEN: ticket ? new Auth(password, secret).agentToken(ticket.id) : '',
      COORDINATOR_PROJECT: String(ticket?.project_id ?? 0), COORDINATOR_TICKET: String(ticket?.id ?? 0),
      COORDINATOR_ROLE: ticket?.kind === 'coordinator' ? 'coordinator' : 'thread',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(mcp);
  mcp.stderr!.on('data', (d) => (log += `[mcp] ${d}`));
  const replies = createInterface({ input: mcp.stdout! })[Symbol.asyncIterator]();
  const call = async (id: number, method: string, params: object) => {
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error(`MCP ${method} timed out`)), 10_000).unref());
    const { value, done } = await Promise.race([replies.next(), timeout]);
    if (done) fail(`The MCP server exited before answering ${method}`);
    const reply = JSON.parse(value);
    if (reply.error) fail(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boot-check', version: '1' } });
  const tools = (await call(2, 'tools/list', {})).tools as { name: string }[];
  if (!tools?.length) fail('The MCP server listed no tools');
  if (ticket) {
    // list_tickets (Taskmaster) or list_properties (minion): both read through the API with the token.
    const name = ticket.kind === 'coordinator' ? 'list_tickets' : 'list_properties';
    const result = await call(3, 'tools/call', { name, arguments: {} });
    if (result.isError) fail(`MCP ${name} failed: ${JSON.stringify(result.content)}`);
  }
  console.log(health.version);
} finally {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
}
