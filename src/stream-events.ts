// Reading one stream-json event of a turn: what of it is stored, what it says the minion is doing, and whether a command pushes.
// Moved out of runner.ts (#1840), which re-exports what it exported.
import type { ClaudeEvent, ContentBlock } from './claude-events.ts';
import { hideTokens } from './hide-tokens.ts';
import { activityLabel, isWorkTool } from '../public/progress.js';

// Stream events that carry no information for the ticket view.
export const DROPPED_TYPES = new Set(['rate_limit_event', 'stream_event']);

const MAX_TOOL_OUTPUT = 20_000;

function truncate(s: string): string {
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + `\n… [truncated ${s.length - MAX_TOOL_OUTPUT} chars]` : s;
}

/**
 * Shrink a stream-json event before storing it, keeping only what the chat, the progress readout
 * and the coordinator's transcript read: thinking, usage, ids and background-task echoes are most
 * of a long thread's history and none of them are shown. Returns null for events not worth keeping.
 * `stored` is for events already in the database, whose tool output was capped when it was saved.
 */
export function slimEvent(ev: ClaudeEvent, stored = false): ClaudeEvent | null {
  if (ev.type === 'system') {
    return ev.subtype === 'init' ? { type: 'system', subtype: 'init', session_id: ev.session_id, model: ev.model, cwd: ev.cwd } : null;
  }
  if ((ev.type === 'assistant' || ev.type === 'user') && Array.isArray(ev.message?.content)) {
    const content = ev.message!.content!.flatMap((block: ContentBlock): ContentBlock[] => {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return [];
      if (block?.type === 'text' && typeof block.text === 'string') return [{ ...block, text: hideTokens(block.text) }];
      if (block?.type !== 'tool_result' || stored) return [block];
      let content = block.content;
      if (Array.isArray(content)) {
        content = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      }
      return [{ ...block, content: truncate(hideTokens(String(content ?? ''))) }];
    });
    if (!content.length) return null;
    const slim: ClaudeEvent = { type: ev.type, message: { role: ev.message!.role, content } };
    if (ev.parent_tool_use_id) slim.parent_tool_use_id = ev.parent_tool_use_id;
    if (ev.turn_state) slim.turn_state = ev.turn_state;
    return slim;
  }
  if (ev.type === 'result') {
    const { subtype, is_error, duration_ms, num_turns, total_cost_usd } = ev;
    // A successful turn's result repeats its last message; only a failure's says something new.
    return { type: 'result', subtype, is_error, duration_ms, num_turns, total_cost_usd, ...(ev.is_error ? { result: ev.result } : {}) };
  }
  return null;
}

/** Whether a shell command pushes to GitHub or opens a pull request (for the chat note), by its words. */
export function pushKind(command: string): 'push' | 'pr' | null {
  // Quoted words are messages and arguments (git commit -m "then git push"), not commands.
  command = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  if (/\bgh\s+pr\s+create\b/.test(command)) return 'pr';
  return /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b/.test(command) ? 'push' : null;
}

export function describeActivity(ev: ClaudeEvent): string | null {
  if (ev.type !== 'assistant') return null;
  const blocks = (ev.message?.content ?? []) as ContentBlock[];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    // A Grunt's report (a subagent's words) isn't what the minion is doing; its tool calls are.
    if (b?.type === 'text' && !ev.parent_tool_use_id && typeof b.text === 'string' && b.text.trim())
      return b.text
        .trim()
        .split('\n')[0]
        .replace(/\*\*|`/g, '')
        .slice(0, 160);
    // The same plain words as the readout ("Ran the tests", "Edited app.js"), not "Using Bash".
    if (b.type === 'tool_use' && isWorkTool(b.name)) return activityLabel(b);
  }
  return null;
}

/** The window before a result has reported one: a `[1m]` model id has 1M, the rest 200k. */
export const guessWindow = (model: string | null | undefined) => (/\[1m\]/i.test(model ?? '') ? 1_000_000 : 200_000);
