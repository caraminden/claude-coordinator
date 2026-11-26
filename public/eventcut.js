// A chat's history as its page sends it (#1530). The chat shows a tool call's input and result only when someone
// opens that action's row, so a page sends a short beginning of each long one, with its full length in `cut`, and
// the row fetches the whole event when opened (progress-ui.js fullAction). The chat page and the kept copy of a chat
// (core.js keepOpenChat) both send events through here; stored events stay whole.
import { TASK_TOOLS, workKind } from './progress.js';

/** @import { ChatAction, ToolBlock } from './types/chat.js' */
/** @import { ChatEvent } from './types.js' */
/** @typedef {{ type?: string, text?: unknown, content?: unknown, id: string, input?: Record<string, unknown>, name: string, work?: string, cut?: unknown }} RawBlock */

/** A Grunt's tool result: nothing reads it unopened but a failure's first line (progress-ui.js actionEl). */
export const GRUNT_RESULT_HEAD = 200;
/** The minion's own: "Created #15 …" and a TaskCreate's "#3" are at the start (chattext.js ticketActionRef, progress.js). */
export const RESULT_HEAD = 1000;
/** A tool input's one string field: a Bash command's phase reads the whole command (progress.js commandPhase). */
export const INPUT_HEAD = 1000;
/** Claude's own user-side text (a compacted session's summary, a Grunt's brief): the chat draws none of it. */
export const TEXT_HEAD = 300;
/** Smaller events are sent as stored: nothing in them is worth parsing to cut. */
const SMALL = 2000;

/** @param {unknown} content */
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n') : '');

/** One stored event row ({ id, ticket_id, kind, data, created_at }) as a page sends it: the same row, or a copy with big fields cut. */
/** @param {ChatEvent} row */
export function cutEvent(row) {
  if (row.kind !== 'claude' || typeof row.data !== 'string' || row.data.length <= SMALL) return row;
  /** @type {{ type?: string, parent_tool_use_id?: unknown, message?: { content?: unknown } }} */ // JSON 'null' leaves no content, so it returns below
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return row;
  }
  const content = data?.message?.content;
  if (!Array.isArray(content)) return row;
  let changed = false;
  for (const block of /** @type {RawBlock[]} */ (content)) {
    if (!block || typeof block !== 'object') continue;
    if (data.type === 'user' && block.type === 'tool_result') {
      const text = textOf(block.content);
      const head = data.parent_tool_use_id ? GRUNT_RESULT_HEAD : RESULT_HEAD;
      if (text.length <= head) continue;
      Object.assign(block, { content: text.slice(0, head), cut: text.length });
      changed = true;
    } else if (data.type === 'user' && block.type === 'text' && typeof block.text === 'string' && block.text.length > TEXT_HEAD) {
      Object.assign(block, { text: block.text.slice(0, TEXT_HEAD), cut: block.text.length });
      changed = true;
    } else if (data.type === 'assistant' && block.type === 'tool_use' && block.input && typeof block.input === 'object' && !TASK_TOOLS.has(block.name)) {
      for (const [key, value] of Object.entries(block.input)) {
        if (typeof value !== 'string' || value.length <= INPUT_HEAD) continue;
        block.work ??= workKind(/** @type {ToolBlock} */ (block)); // the whole call's kind, read before its words go (#1923)
        block.input[key] = value.slice(0, INPUT_HEAD);
        /** @type {Record<string, number>} */ ((block.cut ??= {}))[key] = value.length;
        changed = true;
      }
    }
  }
  return changed ? { ...row, data: JSON.stringify(data) } : row;
}

/** Whether an action ({ block, result } from thread.js) was cut on the way, so opening it fetches the rest. */
/** @param {Pick<ChatAction, 'block' | 'result'>} action */
export const actionCut = (action) => !!(action.block?.cut || action.result?.cut);
