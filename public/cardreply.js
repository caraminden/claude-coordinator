// Whether an everyone card's reply starts open (#1589). No imports, so a test can load it in node.

/** A fence's opening line, as public/ui/markdown.js draws a code block (a line-start ```x``` is inline code), inside a quote or list item too: the commands a person has to run. */
const FENCE = /^[ \t>]*(`{3,}(?!.*`)|~{3,})/m;

/** Short replies and any with a code block start open; a long one without starts collapsed (#1581, #1589). */
export function replyStartsOpen(text) {
  if (FENCE.test(text)) return true;
  return !(text.length > 500 || text.split('\n').length > 8);
}
