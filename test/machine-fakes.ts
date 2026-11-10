import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonLines, REPO } from './helpers.ts';

/**
 * Stand-ins for a machine test, written into root: a tiny MCP server, and a `claude -p` that acts
 * as the MCP client, starting each machine server from its --mcp-config just as claude would.
 * On a machine's workspace server (`<name>-ws`) it lists the workspaces, fetches `report.zip` and
 * runs task `hi` from workspace `w`. turns() reads what each turn saw. startMachineAgent runs the real
 * public/machine-agent.mjs against a server (by default lending the stand-in MCP server) and pushes it
 * onto `procs`, for the caller's cleanup.
 */
export function machineFakes(root: string, procs: ChildProcess[] = []) {
  // A tiny MCP server with one tool that says which process answered.
  const mcpServer = join(root, 'fake-mcp.mjs');
  writeFileSync(mcpServer, `
import { createInterface } from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pid ' + process.pid }] } });
});
`);

  // Stands in for claude: records its arguments, talks to each machine server it was given, writes
  // what came back, then ends the turn.
  const fakeClaude = join(root, 'claude-fake');
  writeFileSync(fakeClaude, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
// A contraption turn with no system prompt has no file.
const system = args.includes('--append-system-prompt-file') ? readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8') : '';
const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const allow = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).permissions.allow;
const report = (r) => appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify(r) + '\\n');
process.stdin.resume();
(async () => {
  const results = {};
  for (const [name, s] of Object.entries(config.mcpServers)) {
    if (name === 'thread') continue;
    // As claude does: a server's own env on top of claude's (a contraption turn's proxy gets its token that way).
    const p = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...s.env } });
    const replies = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    const call = async (id, method, params) => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
      return JSON.parse((await replies.next()).value);
    };
    const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
    const tools = await call(2, 'tools/list', {});
    // A machine's workspace tools: list the workspaces, copy a file over, run a task.
    const ws = name.endsWith('-ws');
    const called = await call(3, 'tools/call', { name: ws ? 'workspaces' : 'whoami', arguments: {} });
    results[name] = { tools: tools.result.tools.map((t) => t.name), text: text(called) };
    if (ws) {
      results[name].fetched = text(await call(4, 'tools/call', { name: 'fetch_file', arguments: { workspace: 'w', path: 'report.zip' } }));
      results[name].ran = text(await call(5, 'tools/call', { name: 'run_task', arguments: { workspace: 'w', task: 'hi' } }));
    }
    p.stdin.end();
  }
  report({ args, system, allow, results, token: process.env.COORDINATOR_TOKEN });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
})().catch((err) => { report({ args, error: String(err) }); process.exit(1); });
`);
  chmodSync(fakeClaude, 0o755);

  /** `run` is the agent's command line after the token (default: the stand-in MCP server); `env` is added to the process environment. */
  function startMachineAgent({ base, token, run = ['--', process.execPath, mcpServer], env = {} }: { base: string; token: string; run?: string[]; env?: NodeJS.ProcessEnv }) {
    const agent = spawn(process.execPath, [join(REPO, 'public/machine-agent.mjs'), base, token, ...run], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MACHINES_URL: undefined, ...env } });
    procs.push(agent);
    let out = '';
    agent.stdout!.on('data', (d) => (out += d));
    agent.stderr!.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => agent.on('exit', r));
    return { agent, output: () => out, exited };
  }

  return { mcpServer, fakeClaude, turns: () => jsonLines(join(root, 'turns.jsonl')), startMachineAgent };
}
