// Briefs in a Markdown file, which the file viewer offers to start as minions (#129). A brief is a
// heading that starts with "Brief", up to the next heading as high or higher, or a whole handoff-*.md
// file. No DOM here, so test/briefs.test.js can run it.

// public/ui/markdown.js's FENCE (not exported there): keep the two the same. A ```code``` line is inline code, not a fence.
const FENCE = /^ {0,3}(`{3,}(?!.*`)|~{3,})\s*([^`\s]*)/;

/** The headings markdownDoc renders at the top level, in order, with the line each is on. */
function headings(lines) {
  const out = [];
  let fence = null; // the open code fence's closing line, as public/ui/markdown.js closes it
  lines.forEach((l, line) => {
    let f;
    if (fence) {
      if (fence.test(l)) fence = null;
      return;
    }
    if ((f = FENCE.exec(l))) fence = new RegExp(`^ {0,3}${f[1][0] === '`' ? '`' : '~'}{${f[1].length},}\\s*$`);
    const m = !fence && /^(#{1,6})\s+(.*?)\s*#*$/.exec(l);
    if (m) out.push({ line, level: m[1].length, text: m[2].replace(/\*\*|`/g, '').trim() });
  });
  return out;
}

/** "Page the chat history (feature/perf, M)" → its title and the type its brackets open with. */
function titleAndType(text) {
  const m = /\s*\(([^)]*)\)\s*$/.exec(text);
  return {
    title: (m ? text.slice(0, m.index) : text).trim(),
    typeHint: m
      ? m[1]
          .trim()
          .split(/[\s/,;]+/)[0]
          .toLowerCase()
      : '',
  };
}

/**
 * Every brief in `src`, a file named `name`: `heading` is the heading as written (its key; '' for a
 * whole handoff file), `index` which top-level heading it hangs on (-1: the top of the file), and
 * `body` the section verbatim.
 */
export function findBriefs(src, name = '') {
  // markdownDoc drops comments before it renders, so line up with what it shows.
  const lines = src.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const hs = headings(lines);
  const briefs = [];
  if (/^handoff-.*\.md$/i.test(name)) {
    const top = hs[0]?.text ?? name.replace(/^handoff-|\.md$/gi, '').replace(/-/g, ' ');
    briefs.push({ index: -1, heading: '', ...titleAndType(top.replace(/^handoff\b\s*[:\-–—]?\s*/i, '')), body: lines.join('\n').trim() });
  }
  const seen = new Map();
  hs.forEach((hd, index) => {
    if (!/^brief\b/i.test(hd.text)) return;
    const end = hs.slice(index + 1).find((x) => x.level <= hd.level)?.line ?? lines.length;
    // The heading is the brief's key, so a repeat of one gets a number to keep it apart.
    const n = (seen.get(hd.text) ?? 0) + 1;
    seen.set(hd.text, n);
    briefs.push({ index, heading: n > 1 ? `${hd.text} (${n})` : hd.text, ...titleAndType(hd.text.replace(/^brief\b[^:]{0,12}:\s*/i, '')), body: lines.slice(hd.line, end).join('\n').trim() });
  });
  return briefs;
}

/** The registered type a hint like "feature", "process" or "fix" names (by value or alias), or ''. */
export function matchType(hint, types) {
  if (!hint) return '';
  return types.find((t) => t.value === hint || t.aliases?.includes(hint))?.value ?? '';
}

/** The new minion's first message: the brief verbatim, then where it came from, to read the rest. */
export function briefMessage(brief, filePath) {
  return brief.heading ? `${brief.body}\n\n(Brief from ${filePath}; read the whole file for its context.)` : `${brief.body}\n\n(Handoff file: ${filePath})`;
}
