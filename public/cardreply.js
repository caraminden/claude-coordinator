// Whether an everyone card's reply starts open (#1589). No imports, so a test can load it in node.

/** A fenced code block opens at a line's start (up to 3 spaces in): the commands a person has to run. */
const FENCE = /^ {0,3}(```|~~~)/m;

/** Short replies and any with a code block start open; a long one without starts collapsed (#1581, #1589). */
export function replyStartsOpen(text) {
  if (FENCE.test(text)) return true;
  return !(text.length > 500 || text.split('\n').length > 8);
}
