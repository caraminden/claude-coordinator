/**
 * Claude Code's hook input, as the kit's hooks read it: JSON on stdin, so nothing here is checked at runtime, every
 * field is optional and the hooks keep their own typeof checks. Fields no hook reads are left out (#1799).
 */
export interface ToolInput {
  command?: string;
  run_in_background?: boolean;
  file_path?: string;
  notebook_path?: string;
  [field: string]: unknown;
}

/** One of a Stop input's background_tasks: a Bash job, a Grunt or a workflow run. */
export interface BackgroundTask {
  id?: string;
  type?: string;
  status?: string;
  description?: string;
  command?: string;
  pid?: number;
}

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  /** PreToolUse, PostToolUse, PostToolUseFailure */
  tool_name?: string;
  tool_input?: ToolInput;
  tool_use_id?: string;
  /** Bash's is { stdout, stderr, ... }; some tools' is a string. */
  tool_response?: string | { stdout?: string; stderr?: string; [field: string]: unknown };
  /** PostToolUseFailure */
  error?: unknown;
  /** Stop, SubagentStop */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: BackgroundTask[];
  agent_id?: string;
  agent_transcript_path?: string;
}

/** One content block of a transcript message (JSONL, parsed unchecked like the input). */
export interface TranscriptBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | TranscriptBlock[];
}

/** One line of a session's transcript, the fields the hooks read. */
export interface TranscriptEntry {
  type?: string;
  promptId?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  message?: { id?: string; model?: string; content?: string | TranscriptBlock[] };
  /** type 'attachment' */
  attachment?: { type?: string; prompt?: unknown };
  /** type 'queue-operation' */
  operation?: string;
  content?: unknown;
}
