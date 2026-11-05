// Which of Claude's words collapse out of the chat and which stay. Pure string work, so it can be
// tested without a browser.

/** Narration is shorter than this; anything this long is something Claude is telling you. */
export const NARRATION_MAX = 300;
/** A message kept mid-turn that's longer than this shows its first lines, with "Show all". */
export const CLAMP_OVER = 2000;

// A line that starts a heading, list item, table row, code block or quote.
const STRUCTURE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|~~~|>)/m;

/**
 * Whether `text` is an in-between remark ("Checking the merged code boots:") that may collapse once
 * more work follows it: one plain paragraph, short, with no Markdown structure. Answers, lists,
 * tables and reports never are.
 */
export function isNarration(text) {
  const t = text.trim();
  return t.length < NARRATION_MAX && !/\n\s*\n/.test(t) && !STRUCTURE.test(t);
}

// Tools that only keep the minion's own records (its status, properties, task list, cards), so
// words followed by nothing else weren't narrating any work.
const BOOKKEEPING = new Set([
  'mcp__thread__set_thread_status', 'mcp__thread__set_properties', 'mcp__thread__settle_question',
  'mcp__thread__strike_text', 'mcp__thread__close_self',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch',
]);

/** Whether a tool call is bookkeeping rather than work, by its name. */
export function isBookkeeping(name) {
  return BOOKKEEPING.has(name);
}

// Cards the words before them explain.
const CARDS = new Set(['mcp__thread__ask_question', 'mcp__thread__propose_plan']);

/**
 * Sorts a turn's words as its texts and tool calls arrive, in order. Each call returns the texts it
 * settles as `{ text, fate }`: 'fold' (narration followed by work), 'keep', or 'clamp' (kept, long).
 * Words followed by nothing but bookkeeping before the next words, or by a card, are kept. The
 * turn's last words are never settled, so they always stay whole.
 */
export function narrationSorter() {
  let pending = null;
  const settle = (work) => {
    const text = pending;
    pending = null;
    if (!text) return [];
    return [{ text, fate: work && isNarration(text.text) ? 'fold' : text.text.length > CLAMP_OVER ? 'clamp' : 'keep' }];
  };
  return {
    /** `text` is any object with the words as its `text`. */
    text(text) {
      const out = settle(false);
      pending = text;
      return out;
    },
    tool(name) {
      return isBookkeeping(name) ? [] : settle(!CARDS.has(name));
    },
  };
}
