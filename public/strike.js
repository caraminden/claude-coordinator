// Words a thread struck through with strike_text, turned into ~~Markdown~~ before the message renders.
// Pure string work, so it can be tested without a browser.

// What starts a line without being its words: indent, quote marks, a list marker, a heading's hashes.
const LINE_START = /^(\s*(?:>\s?)*(?:[-*+]\s+|\d+\.\s+)?(?:#{1,6}\s+)?)(.*?)(\s*)$/;

/**
 * `text` with each struck quote (its first occurrence) wrapped in ~~, line by line so lists and
 * quotes keep their shape. shortcut: a quote inside a code block or a table row shows its ~~ as is
 * or breaks the row; fine while strikes are short claims in prose.
 */
/** @param {string} text @param {{ text: string }[] | null | undefined} strikes */
export function struckSource(text, strikes) {
  for (const { text: quote } of strikes ?? []) {
    const at = text.indexOf(quote);
    if (at < 0) continue;
    const wrapped = quote
      .split('\n')
      .map((/** @type {string} */ line) => {
        const [, start, words, end] = /** @type {RegExpExecArray} */ (LINE_START.exec(line));
        return words ? `${start}~~${words}~~${end}` : line;
      })
      .join('\n');
    text = text.slice(0, at) + wrapped + text.slice(at + quote.length);
  }
  return text;
}

/** A strike_text note's struck words, reason and chat, or null for another note. Older notes kept only text, read back here. */
/** @param {{ strike?: { quote: string, reason: string, chat?: { project: number, number: number | null } | null }, text?: string }} data */
export function noteStrike(data) {
  if (data.strike) return data.strike;
  const old = data.text?.match(/^Struck through as wrong: "(.*?)"\. (.*)$/s);
  return old && { quote: old[1], reason: old[2] };
}
