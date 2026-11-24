/**
 * The Claude CLI's stream-json output, as Citadel reads it: one JSON object per line, parsed with JSON.parse, so
 * nothing here is checked at runtime. Every field is optional past `type`, and the code reading them keeps its own
 * guards (Array.isArray, typeof). Fields Citadel doesn't read are left out (#1799: these replace `ev: any`).
 */

/** One block of a message's content: text, tool_use, tool_result, thinking, image. */
export interface ContentBlock {
  type: string;
  text?: string;
  /** tool_use */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** tool_result */
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

/** A model's token counts, on an assistant message and on the result event. */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One model's totals on the result event's modelUsage. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
}

export interface ClaudeMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: ContentBlock[] | string;
  usage?: TokenUsage;
}

/** One stream-json line: system (init and others), assistant, user, result, rate_limit_event and the rest. */
export interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  message?: ClaudeMessage;
  /** result */
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, ModelUsage>;
  /** system init */
  model?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  slash_commands?: string[];
  plugins?: { name: string; path: string }[];
  claude_code_version?: string;
  plugin_errors?: unknown[];
  mcp_server_errors?: unknown[];
  /** rate_limit_event */
  rate_limit_info?: Record<string, unknown>;
}

/** A message's content as blocks: a bare string or a missing content reads as none. */
export function blocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}
