// Whether an everyone card's reply starts open. No imports, so a test can load it in node.

/** Always open (#1630): the context above an Overlord card in a person's Taskmaster chat reads as part of the exchange; a person can still collapse it. */
/** @param {string} [_text] */
export function replyStartsOpen(_text) {
  return true;
}
