// A stand-in for `claude -p` that tools/boot-check.ts runs one minion turn and one Taskmaster turn
// with, through the runner's real arguments. An argument over Linux's 128 KiB cap fails the turn's spawn
// (E2BIG) before this runs, and this fails any over 100 KiB and any file the launch wrote over 1 MiB; it
// checks the rest a turn needs to start: a --settings that parses, and the turn's own MCP server (the pinned copy, with the turn's environment)
// answering initialize, tools/list and read-only tool calls (a Taskmaster's: list_tickets, read_ticket on
// the longest chat and the scheme instructions, as boot-check.json in its folder names them). It writes
// what it found to report.json in its working directory and ends the turn as claude would.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const role = process.env.COORDINATOR_ROLE ?? '';
const MAX_ARG = 100 * 1024;
/** Every file a launch writes into its turn's folder may be 1 MiB, half the smallest cap among them (Claude Code's on settings). */
const FILE_BUDGET = 1024 * 1024;
const LAUNCH_FILES: Record<string, string> = {
  'settings.json': 'Claude Code refuses a settings file past 2 MiB',
  'mcp.json': 'Claude Code loads it at launch',
  'codex-tripwire.json': 'the tripwire reads it on every Codex tool call',
  'scheme-refs.json': 'the link and scheme-refs checks read it on every reply and tool call',
};
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function check(): Promise<string> {
  const settings = flag('--settings');
  if (!settings) throw new Error('No --settings');
  // A file since #92: inline, it grows past Linux's 128 KiB on one argument.
  if (settings.trimStart().startsWith('{')) throw new Error('--settings is inline JSON, not a file');
  const parsed = JSON.parse(readFileSync(settings, 'utf8'));
  if (!parsed.hooks) throw new Error('--settings has no hooks (the tripwire)');

  const config = flag('--mcp-config') ?? '{}';
  const server = JSON.parse(config.trimStart().startsWith('{') ? config : readFileSync(config, 'utf8')).mcpServers?.[role];
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
  let id = 0;
  const tool = async (name: string, params: object = {}): Promise<string> => {
    const result = await call(++id, 'tools/call', { name, arguments: params });
    const text = (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
    if (result.isError) throw new Error(`MCP ${name} failed: ${text.slice(0, 1000)}`);
    return text;
  };
  try {
    await call(++id, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boot-check-claude', version: '1' } });
    const tools = (await call(++id, 'tools/list', {})).tools as { name: string }[];
    if (!tools?.length) throw new Error(`The ${role} MCP server listed no tools`);
    // All read through the API with the turn's token: the calls that broke live before (#120, #142).
    const found = [`${tools.length} tools`];
    if (role !== 'coordinator') await tool('list_properties');
    else {
      await tool('list_tickets');
      // What boot-check.ts picked from the copy: the scheme's longest open chat, and the first line of its instructions.
      const want = JSON.parse(readFileSync('boot-check.json', 'utf8'));
      if (want.longest) {
        await tool('read_ticket', { ticket_id: want.longest });
        found.push(`read_ticket #${want.longest}`);
      }
      const instructions = await tool('get_project_instructions');
      if (want.instructions && !instructions.includes(want.instructions)) throw new Error(`MCP get_project_instructions left out the scheme's instructions: ${instructions.slice(0, 300)}`);
    }
    // Linux refuses any one argument over 128 KiB (E2BIG), which stopped every Taskmaster turn once (#92): fail well before.
    const largest = args.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a), '');
    const bytes = Buffer.byteLength(largest);
    if (bytes > MAX_ARG) throw new Error(`The largest launch argument is ${bytes} bytes, over ${MAX_ARG / 1024} KiB (Linux's cap is 128 KiB): ${largest.slice(0, 80)}…`);
    // Each file the launch wrote, against the budget: one Taskmaster's settings.json passed Claude Code's
    // 2 MiB at launch (#661), with git rules per open minion's worktree, in every scheme on a Citadel member's ask.
    // Every launch writes all four into the turn's folder, beside the settings file its --settings names.
    const dir = dirname(settings);
    const sizes = Object.entries(LAUNCH_FILES).map(([name, why]) => {
      if (!existsSync(join(dir, name))) throw new Error(`The launch wrote no ${name} beside its --settings (${settings})`);
      return { name, why, bytes: statSync(join(dir, name)).size };
    });
    for (const f of sizes) if (f.bytes > FILE_BUDGET) throw new Error(`The launch's ${f.name} is ${f.bytes} bytes, over the ${FILE_BUDGET / 1024} KiB budget for a launch file (${f.why})`);
    const folders = new Set((parsed.permissions?.allow ?? []).filter((r: string) => r.startsWith('Bash(git -C ')).map((r: string) => r.split(' ')[2])).size;
    return `${found.join('; ')}; largest argument ${bytes} bytes; settings.json ${sizes[0].bytes} bytes, git rules for ${folders} folders`;
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
