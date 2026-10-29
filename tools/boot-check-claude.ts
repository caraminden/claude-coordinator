// A stand-in for `claude -p` that tools/boot-check.ts runs one minion turn and one Taskmaster turn
// with, through the runner's real arguments. It checks what a turn needs to start: every argument under
// Linux's 128 KiB cap, a --settings that parses, and the turn's own MCP server (the pinned copy, with
// the turn's environment) answering initialize, tools/list and a read-only tool call. It writes what it
// found to report.json in its working directory and ends the turn as claude would.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// MAX_ARG_STRLEN: one argument, with its terminating NUL.
const MAX_ARG = 128 * 1024;
const args = process.argv.slice(2);
const role = process.env.COORDINATOR_ROLE ?? '';
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function check(): Promise<string> {
  for (const [i, a] of args.entries()) {
    const size = Buffer.byteLength(a) + 1;
    if (size > MAX_ARG) throw new Error(`Argument ${i} (${args[i - 1] ?? 'first'}) is ${size} bytes, over Linux's ${MAX_ARG}-byte cap on one argument`);
  }
  const settings = flag('--settings');
  if (!settings) throw new Error('No --settings');
  const parsed = JSON.parse(settings.trimStart().startsWith('{') ? settings : readFileSync(settings, 'utf8'));
  if (!parsed.hooks) throw new Error('--settings has no hooks (the tripwire)');

  const server = JSON.parse(flag('--mcp-config') ?? '{}').mcpServers?.[role];
  if (!server) throw new Error(`--mcp-config has no ${role || '(no role)'} server`);
  const mcp = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  mcp.stderr.on('data', (d) => (stderr += d));
  const replies = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  const call = async (id: number, method: string, params: object) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error(`MCP ${method} timed out`)), 10_000).unref());
    const { value, done } = await Promise.race([replies.next(), timeout]);
    if (done) throw new Error(`The ${role} MCP server exited before answering ${method}${stderr ? `: ${stderr.trim().slice(-1000)}` : ''}`);
    const reply = JSON.parse(value);
    if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  try {
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boot-check-claude', version: '1' } });
    const tools = (await call(2, 'tools/list', {})).tools as { name: string }[];
    if (!tools?.length) throw new Error(`The ${role} MCP server listed no tools`);
    // Both read through the API with the turn's token.
    const name = role === 'coordinator' ? 'list_tickets' : 'list_properties';
    const result = await call(3, 'tools/call', { name, arguments: {} });
    if (result.isError) throw new Error(`MCP ${name} failed: ${JSON.stringify(result.content)}`);
    return `${tools.length} tools; largest argument ${Math.max(...args.map((a) => Buffer.byteLength(a) + 1))} bytes`;
  } finally {
    mcp.kill();
  }
}

const out = (o: object) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'boot-check', model: 'boot-check', cwd: process.cwd(), mcp_servers: [] });
try {
  const found = await check();
  writeFileSync('report.json', JSON.stringify({ ok: true, found }));
  out({ type: 'result', subtype: 'success', is_error: false, result: `boot check: ${found}`, session_id: 'boot-check' });
  process.exit(0);
} catch (err: any) {
  writeFileSync('report.json', JSON.stringify({ ok: false, error: err.message }));
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: err.message, session_id: 'boot-check' });
  process.exit(1);
}
