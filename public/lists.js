// Numbered lists in the message boxes: Enter or Shift+Enter on a "1. …" line starts "2. ", and the
// same on an empty item after the first ends the list.

const ITEM = /^( *)(\d{1,9})([.)])(?:[ \t]+(.*)|$)/;

/**
 * What Enter does at `start`–`end` in `value` when the caret's line is a numbered item:
 * { from, to, text } to replace, or null when Enter should do what it always does.
 */
export function listEnter(value, start, end) {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const m = ITEM.exec(value.slice(lineStart, start));
  if (!m) return null;
  const [, indent, num, delim, rest = ''] = m;
  const prev = value.slice(value.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0));
  // An empty item that follows another ends the list; "1." on its own still starts one.
  if (!rest.trim() && !value.slice(start).split('\n', 1)[0].trim() && lineStart && ITEM.test(prev)) {
    return { from: lineStart, to: start, text: '' };
  }
  return { from: start, to: start, text: `\n${indent}${Number(num) + 1}${delim} ` };
}

/** Handles Enter or Shift+Enter on a numbered item in `textarea`; true when it did, so the caller doesn't send. */
export function continueList(textarea, e) {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  const edit = listEnter(textarea.value, textarea.selectionStart, textarea.selectionEnd);
  if (!edit) return false;
  e.preventDefault();
  textarea.setSelectionRange(edit.from, edit.to);
  // insertText keeps Ctrl+Z working and fires input, which saves the draft and resizes the box.
  if (!(edit.text ? document.execCommand('insertText', false, edit.text) : document.execCommand('delete'))) {
    textarea.setRangeText(edit.text, edit.from, edit.to, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}
