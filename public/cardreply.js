// Whether an everyone card's reply starts open (#1589). No imports, so a test can load it in node.

/** A fence's opening line, the rule public/ui/markdown.js draws a code block by (a line-start ```x``` is inline code): the commands a person has to run. */
const FENCE = /^ {0,3}(`{3,}(?!.*`)|~{3,})/m;

/** Short replies and any with a code block start open; a long one without starts collapsed (#1581, #1589). */
export function replyStartsOpen(text) {
  if (FENCE.test(text)) return true;
  return !(text.length > 500 || text.split('\n').length > 8);
}
