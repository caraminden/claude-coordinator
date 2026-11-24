// The `claude` arguments, settings and input line of a contraption turn (src/contraption-turns.ts), with no runtime
// imports of Citadel's own: `citadel-replay` (src/replay.ts) is pinned beside this file on every turn's PATH and
// reruns kept chats with exactly these flags.
import { join } from 'node:path';

// Local shapes, not imports: src/turn-launch.ts pins a file's './' imports, type-only ones too, and these would pull
// in the whole turn engine. TurnRequest, McpServer and ImageBlock fit them.
type McpServer = { name: string; path: string; headers?: Record<string, string> };
/** The parts of a turn request (src/contraption-turns.ts TurnRequest) these read. */
export interface TurnShape {
  system: string;
  blind: boolean;
  model: string | null;
  compactWindow: number;
  /** `claude --effort` (#1084); null leaves Claude Code's default. */
  effort: string | null;
  /** Claude Code's tool search (#1084): MCP tools load when the model searches for them, not in every request. */
  toolSearch: boolean;
  mcp: McpServer[];
  agents: { max: number } | false;
  webSearch: boolean;
  media: boolean;
}
type ImageBlock = { media_type: string; data: string };
type TurnRequest = TurnShape;

/** Citadel's own media server's name in a turn's MCP config (#732). */
export const MEDIA_SERVER = 'citadel';

/**
 * The naming rule for a turn's MCP tools (#763): an app's own prompt tends to name them bare (`reference`), and now and
 * then the model calls one that way, which Claude Code refuses with "No such tool available".
 */
export function toolNamesPrompt(servers: string[]): string {
  if (!servers.length) return '';
  const full = servers.map((s) => `mcp__${s}__<tool>`).join(', ');
  return `Your tools' full names are ${full}. Where these instructions name a tool without that prefix, such as \`x\`, call it by its full name (mcp__${servers[0]}__x): a bare name fails with "No such tool available".`;
}

/** The built-in tools a turn gets: Agent, WebSearch/WebFetch and ToolSearch, each only if asked for. */
export function builtins(req: TurnRequest): string[] {
  // ToolSearch is all tool search needs: Claude Code defers MCP tools whenever it may use it (2.1.323), and `--tools ''` drops it.
  return [...(req.agents ? ['Agent'] : []), ...(req.webSearch ? ['WebSearch', 'WebFetch'] : []), ...(req.toolSearch ? ['ToolSearch'] : [])];
}

/** The `claude` arguments for a turn: only the contraption's MCP servers and (maybe) Agent and web search, nothing of the user's or Citadel's. */
export function args(req: TurnRequest, dir: string, claudeSession: string, resume: boolean): string[] {
  const a = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Messages in as minion turns take them, so the app can steer the turn; each is echoed back once claude takes it in.
    '--input-format',
    'stream-json',
    '--replay-user-messages',
    // No user, project or local settings: no CLAUDE.md, hooks, plugins, permissions or MCP servers of theirs.
    '--setting-sources',
    '',
    // The built-in tools: Agent, web search and tool search if asked for, else none. Subagents get no more than this.
    '--tools',
    builtins(req).join(','),
    '--strict-mcp-config',
    '--mcp-config',
    join(dir, 'mcp.json'),
    '--settings',
    join(dir, 'settings.json'),
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    // A resumed session gets this turn's system text, not its first one's (#618).
    '--system-prompt-snapshot',
    'off',
  ];
  // Blind: the app's text is the whole prompt, not an addition to Claude Code's own.
  if (req.system) a.push(req.blind ? '--system-prompt-file' : '--append-system-prompt-file', join(dir, 'system.md'));
  if (req.model) a.push('--model', req.model);
  if (req.effort) a.push('--effort', req.effort);
  a.push(resume ? '--resume' : '--session-id', claudeSession);
  return a;
}

/** The contraption's MCP servers as `--mcp-config` takes them: HTTP on its own port, headers as sent. */
export function mcpConfig(port: number, servers: McpServer[]) {
  return { mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: 'http', url: `http://127.0.0.1:${port}${s.path}`, headers: s.headers }])) };
}

/** The turn's --settings: what it may use, where it compacts, and the Agent cap's hook. */
export function settings(req: TurnRequest, hook: { node: string; script: string; slots: string } | null, machines: string[] = []) {
  const allow = [...req.mcp, ...machines.map((name) => ({ name })), ...(req.media ? [{ name: MEDIA_SERVER }] : [])].map((s) => `mcp__${s.name}`);
  allow.push(...builtins(req));
  const out: Record<string, unknown> = {
    permissions: { allow, defaultMode: 'dontAsk' },
    autoCompactWindow: req.compactWindow,
    autoMemoryEnabled: false,
    syncClaudeAiSkills: false,
    disableClaudeAiConnectors: true,
    enableAllProjectMcpServers: false,
  };
  if (req.agents && hook) {
    const command = [hook.node, hook.script, hook.slots, String(req.agents.max)].map((s) => `'${s}'`).join(' ');
    const on = [{ matcher: '^(Agent|Task)$', hooks: [{ type: 'command', command, timeout: 10 }] }];
    out.hooks = { PreToolUse: on, PostToolUse: on, PostToolUseFailure: on };
  }
  return out;
}

/** One message as claude's stream-json input takes it; claude echoes `uuid` back once it takes it in. */
export const userLine = (text: string, uuid?: string, images: ImageBlock[] = []) =>
  JSON.stringify({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })), { type: 'text', text }] } }) + '\n';
