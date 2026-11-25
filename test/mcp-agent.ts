// The real MCP server (src/mcp.ts) driven over stdio as one agent turn would, for tests of what a tool says or does.
// Builds the fixture only: tests make their own asserts on what comes back.
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type Env = Record<string, string | undefined>;
/** A JSON-RPC reply: `result`, or `error` for a call src/mcp.ts refused (an unknown tool, say). */
export type McpReply = { id: number; result?: McpResult; error?: { code: number; message: string } };
export type McpTool = { name: string; description: string; inputSchema: { type: string; properties?: Record<string, { type?: unknown; enum?: unknown[]; description?: string }>; required?: string[] } };
/** A result: tools/call's content and isError, or tools/list's tools. */
export type McpResult = { content: { type: string; text: string }[]; isError?: boolean; tools: McpTool[] };
/** A tools/call answer: its first text, whether it was an error, and the whole result. */
export type ToolAnswer = { isError: boolean; text: string; result: McpResult };

const MCP = join(import.meta.dirname, '..', 'src', 'mcp.ts');

/**
 * The env an agent turn hands src/mcp.ts: the scheme, minion and role a call runs as, plus `extra` (COORDINATOR_MEMORY,
 * COORDINATOR_MACHINES and the like).
 */
export const agentEnv = (api: string, token: string, t: { id: number; project_id: number }, role = 'thread', extra: Env = {}): Env => ({
  COORDINATOR_API: api,
  COORDINATOR_TOKEN: token,
  COORDINATOR_PROJECT: String(t.project_id),
  COORDINATOR_TICKET: String(t.id),
  COORDINATOR_ROLE: role,
  ...extra,
});

/**
 * One src/mcp.ts process serving every call as `env`. A turn's own COORDINATOR_* and MACHINES_URL (a minion running the
 * tests has them) are left out of the inherited env, so a call sees only what `env` names. `track` hands the child to a
 * tempRoot (`tmp.track`) so its teardown stops it; without one, call close() in an after() or finally.
 */
export function mcpAgent(env: Env, track: (p: ChildProcess) => ChildProcess = (p) => p, file = MCP) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^COORDINATOR_|^MACHINES_URL$/.test(k)));
  const child = track(spawn(process.execPath, [file], { env: { ...inherited, ...env }, stdio: ['pipe', 'pipe', 'inherit'] }));
  const waiting = new Map<number, { ok: (m: McpReply) => void; fail: (e: Error) => void }>();
  let ended: Error | null = null;
  createInterface({ input: child.stdout! }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.ok(m);
    waiting.delete(m.id);
  });
  child.once('exit', (code, signal) => {
    ended = new Error(`src/mcp.ts ended (${code ?? signal}) before it answered`);
    for (const w of waiting.values()) w.fail(ended);
    waiting.clear();
  });
  let next = 0;
  /** One JSON-RPC request; the reply whole, error included. */
  const rpc = (method: string, params?: object) =>
    new Promise<McpReply>((ok, fail) => {
      if (ended) return fail(ended);
      const id = ++next;
      waiting.set(id, { ok, fail });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) })}\n`);
    });
  /** One request's `result`. */
  const call = async (method: string, params?: object) => (await rpc(method, params)).result as McpResult;
  const tool = async (name: string, args: object = {}): Promise<ToolAnswer> => {
    const result = await call('tools/call', { name, arguments: args });
    return { isError: !!result.isError, text: result.content[0].text, result };
  };
  /** The tools offered, as tools/list gives them. */
  const list = async () => (await call('tools/list')).tools;
  return { rpc, call, tool, list, child, close: () => child.kill() };
}

/** One request's `result` from a src/mcp.ts started for it alone, for a test whose env changes from call to call. */
export async function mcpOnce(env: Env, method: string, params?: object, track?: (p: ChildProcess) => ChildProcess) {
  const agent = mcpAgent(env, track);
  try {
    return await agent.call(method, params);
  } finally {
    agent.close();
  }
}
