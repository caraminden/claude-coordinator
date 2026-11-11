// Citadel UI: markdown. Served to apps as /apps/_citadel/ui/markdown.js (types: markdown.d.ts beside
// it) and imported by Citadel's own core.js, so both draw markdown the same way. Docs:
// kit/skills/contraption-ui/SKILL.md.
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages:
// - no imports from outside ui/;
// - styles come from a constructed sheet adopted on first use (Citadel's CSP is default-src 'self');
// - nothing it writes carries style="" or <style>;
// - classes are cui-*, and every rule sits in :where(), so an app's own selectors win;
// - its exports and their behaviour are an API apps depend on: test/ui-contract.test.ts holds them.
//   Add, never rename; a real break ships as a new file beside this one.
//
// Markdown to HTML, for chat messages and documents: GitHub-flavoured where the docs we show use it
// (audited against Delve's in #155). renderMarkdown is pure string work, so it tests without a
// browser; markdownDoc in Citadel's core.js hangs Citadel's links, file cards and #N refs on its hooks.
// Raw HTML is escaped, all but <br>.

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/;
/** `[label](target "title")`, on escaped text. */
const LINK = /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(?:&lt;)?((?:[^\s()]|\([^\s()]*\))*?)(?:&gt;)?(?:\s+&quot;(.*?)&quot;)?\s*\)/g;
const DELIM = /^\s*\|?(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

const indentOf = (l) => /^ */.exec(l)[0].length;
const isTableStart = (lines, i) => /^\s*\|/.test(lines[i]) || (lines[i].includes('|') && lines[i + 1]?.includes('|') && DELIM.test(lines[i + 1]));
/**
 * Whether lines[i] cuts into a paragraph above it. In a document only a bullet or a list counting
 * from 1 does, so a wrapped "450. About…" stays text; in chat (`breaks`) every line is as typed.
 */
const startsBlock = (lines, i, breaks) => {
  const l = lines[i];
  const item = ITEM.exec(l);
  return HEADING.test(l) || FENCE.test(l) || QUOTE.test(l) || HR.test(l) || isTableStart(lines, i)
    || (!!item && item[3] != null && (breaks || !/\d/.test(item[2]) || /^0*1\D/.test(item[2])));
};

/** A code span (not across a blank line) or an HTML comment, for stripComments. */
const CODE_OR_COMMENT = /(`+)(?!`)(?:(?!\n[ \t>]*\n)[\s\S])*?[^`]\1(?!`)|<!--[\s\S]*?-->/g;

/**
 * `src` without its HTML comments, except where they are code: inside a fenced block (tracked by
 * character and length, as blocks() does) or a code span. A comment never reaches across a fence.
 */
function stripComments(src) {
  const out = [];
  let run = [];
  let close = null;
  const flush = () => {
    if (run.length) out.push(run.join('\n').replace(CODE_OR_COMMENT, (m) => (m.startsWith('<') ? '' : m)));
    run = [];
  };
  for (const line of src.split('\n')) {
    if (close) {
      out.push(line);
      if (close.test(line)) close = null;
      continue;
    }
    const m = FENCE.exec(line.replace(/^[\s>]*/, ''));
    if (!m) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
    close = new RegExp(`^[\\s>]*${m[1][0]}{${m[1].length},}\\s*$`);
  }
  flush();
  return out.join('\n');
}

/** GitHub's id for a heading: lower case, punctuation dropped, spaces to hyphens. */
export function slug(html) {
  return unescapeHtml(html.replace(/<[^>]*>/g, '')).toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** The default link: http(s) and mailto open a new tab, never `_top` (that would take Citadel's whole window); anything else is inert. */
const defaultLink = (href, html) => (/^(https?:\/\/|mailto:)/i.test(href)
  ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`
  : `<span class="cui-link" title="${escapeHtml(href)}">${html}</span>`);

/**
 * A bare http(s) URL, DOI ("10.1234/x", "doi:10.1234/x") or web address with no scheme
 * ("console.firebase.google.com/x", #440) in escaped text. Each ends at a space, a tag, a quote or a
 * held-out marker; a DOI needs no "doi:" but can't sit inside a path or a number. A web address
 * counts only when its whole host ends in one of WEB_TLDS ("x.com.au" stays text rather than
 * linking x.com), in lower case, and doesn't sit in an email address, a path or a word, so file names ("land.sh", "README.md", "Node.js"), "ASP.NET" and package names
 * ("com.example.app") stay text.
 */
const WEB_TLDS = 'com|org|net|io|dev|app|ai|gov|edu|uk';
/** How a package name starts ("com.example.app"); no web address does, unlike "app." or "dev.". */
const PACKAGE_ROOT = /^(?:com|org|net|edu)$/i;
const URL_TAIL = `(?:(?!&quot;|&#39;|&lt;|&gt;)[^\\s<>"'\\u0000\\u0001])`;
const BARE = new RegExp(`(?<![A-Za-z0-9/])(https?:\\/\\/${URL_TAIL}+)`
  + `|(?<![A-Za-z0-9/.:-])(doi:\\s?)?(10\\.\\d{4,9}\\/${URL_TAIL}+)`
  + `|(?<![A-Za-z0-9/.:@\\\\-])(?<![A-Za-z0-9]_)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(${WEB_TLDS})(?![A-Za-z0-9-]|[._][A-Za-z0-9])(?::\\d{2,5})?(?:[/?#]${URL_TAIL}*)?)`, 'gi');

/**
 * A bare link's end without the marks that end the sentence around it, and in markdown (`md`) the
 * emphasis around it too ("x/**." keeps "x/", as GitHub does); a ")" or "]" stays when it closes one
 * inside it, and "&amp;" stays whole.
 */
function trimBare(s, md) {
  let end = s.length;
  for (;;) {
    const c = s[end - 1];
    const part = s.slice(0, end);
    if (part.endsWith('&amp;')) return part;
    if (/[.,:;!?]/.test(c) || (md && /[*_~]/.test(c))) end--;
    else if ((c === ')' || c === ']') && part.split(c).length > part.split(c === ')' ? '(' : '[').length) end--;
    else return part;
  }
}

/** Escaped text with its bare URLs, DOIs and web addresses as `link(href, html)`; in markdown, `held` holds each link's HTML out (see inline()). */
function linkBare(s, link, held = null) {
  return s.replace(BARE, (m, url, doiPrefix, doi, web, tld) => {
    // "ASP.NET", "Foo.IO": a web address's ending is written in lower case.
    // "org.apache.commons.io" is a package name, read backwards from its domain.
    if (web && (tld !== tld.toLowerCase() || PACKAGE_ROOT.test(web.split('.')[0]))) return m;
    const kept = trimBare(m, !!held);
    // What's left must still point somewhere: not "https://" or "10.1234/" alone.
    if (url ? /^https?:\/\/$/i.test(kept) : doi && !/\/[^/]/.test(kept)) return m;
    const href = url ? unescapeHtml(kept)
      : web ? `https://${unescapeHtml(kept)}`
      : `https://doi.org/${unescapeHtml(kept.slice(doiPrefix?.length ?? 0)).split('/').map(encodeURIComponent).join('/')}`;
    return (held ?? String)(link(href, kept)) + m.slice(kept.length);
  });
}

/**
 * Plain text (a record's field, a note) as HTML: everything escaped, its bare http(s) URLs, DOIs and
 * web addresses linked, opening a new tab. DOIs go to https://doi.org/, a web address to https://.
 */
export function linkify(text) {
  return linkBare(escapeHtml(String(text ?? '')), defaultLink);
}

/**
 * HTML you made (already escaped) with the bare URLs and DOIs in its text linked as linkify's. Tags,
 * links (<a>…</a>) and code (<code>, <pre>) are left as they are.
 */
export function linkifyHtml(html) {
  return String(html ?? '').replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => (tag ? all : linkBare(text, defaultLink)));
}

/**
 * While a reply is still arriving, its end may hold half of something: a table row or a header whose
 * separator hasn't come, a "**" or "`" not yet closed, a "[link](" without its ")", a list marker
 * without its words. Hold those back or close them, so the text never flashes pipes or asterisks that
 * a moment later become a table or bold. Nothing changes inside an open code fence.
 * Table rule from Theory of Crafting's app/web/markdown.ts; the rest is Mandate's mend (src/markdown.ts).
 */
function mendStreaming(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  if (lines.filter((l) => FENCE.test(l)).length % 2) return lines.join('\n');
  let line = lines.pop();
  // A partial link shows just its label until its address closes.
  line = line.replace(/!\[[^\]]*(\]\([^)\s]*)?$/, ''); // a half image waits whole: its alt text alone would flash
  line = line.replace(/\[([^\]]*)\]\([^)\s]*$/, '$1').replace(/\[([^\]]*)$/, '$1');
  // A trailing run of delimiters with nothing after it yet ("- **", "see `").
  line = line.replace(/(^|\s)[*_`]+$/, '$1');
  if ((line.split('`').length - 1) % 2) line += '`';
  // Half of a closing "**" ("**9:59 pm:*") completes it rather than showing a stray "*".
  if (/[^*\s]\*$/.test(line) && line.slice(0, -1).replace(/`[^`]*`/g, '').split('**').length % 2 === 0) line += '*';
  else {
    const bare = line.replace(/`[^`]*`/g, '');
    // The closer goes before any trailing space ("**9:59 " mid-word), since a closer can't follow one.
    if ((bare.split('**').length - 1) % 2 && /\*\*\S/.test(bare.slice(bare.lastIndexOf('**')))) line = line.replace(/\s*$/, '**$&');
  }
  // A table row still arriving, and a list marker still waiting for its words.
  if (!line.trimStart().startsWith('|') && !/^\s*([-*+]|\d{1,9}[.)])\s*$/.test(line)) lines.push(line);
  // A table's header row whose separator hasn't come yet.
  const last = lines.findLastIndex((l) => l.trim() !== '');
  if (last >= 0 && lines[last].trimStart().startsWith('|') && !lines[last - 1]?.includes('|')) lines.length = last;
  return lines.join('\n');
}

/**
 * `src` as HTML. Options:
 * - `breaks`: keep single line breaks as typed, as chat does;
 * - `streaming`: the text is still arriving (see mendStreaming);
 * - `headingBase`: the level a `#` is drawn as (default 3, so a reply's headings sit under the
 *   page's own; a document passes 1);
 * and hooks, each given the target unescaped and the text as HTML:
 * - `link(href, html)`: a link's HTML, for `[text](href)`, `<https://…>` and bare URLs and DOIs (a DOI's href is
 *   its https://doi.org/ address). Default: http(s) and mailto open a new tab, anything else is inert;
 * - `image(href, alt, title)`: an image's HTML (default: its alt text);
 * - `text(html)`: runs over the inline HTML outside code and links, e.g. to link #N.
 */
export function renderMarkdown(src, { link = defaultLink, image, text = (s) => s, breaks = false, streaming = false, headingBase = 3 } = {}) {
  image ??= (_href, alt) => `<span class="cui-alt">[image: ${alt}]</span>`;
  if (streaming) src = mendStreaming(src);
  const base = Math.min(Math.max(Math.trunc(headingBase) || 1, 1), 6) - 1;
  const slugs = new Map();

  const emphasis = (s) => s
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])/g, '$1<em>$2</em>')
    // Only between spaces or brackets, so snake_case_names and <date>_<branch> stay as they are.
    .replace(/(^|[\s([{]|&quot;|&#39;)_(?=[^_\s])(.+?)(?<=[^_\s])_(?=$|[\s.,;:!?)\]}]|&quot;|&#39;)/g, '$1<em>$2</em>');

  const inline = (t) => {
    // Code, escapes, links and URLs are held out as \0n\0 so emphasis can't reach into them; n is
    // written in private-use digits, not ASCII ones, so a `text` hook that rewrites numbers leaves it be.
    const held = [];
    const hold = (html) => `\u0000${String(held.push(html) - 1).replace(/\d/g, (d) => String.fromCharCode(0xE000 + Number(d)))}\u0000`;
    const MARK = /\u0000([\uE000-\uE009]+)\u0000/g;
    const at = (n) => held[Number([...n].map((c) => c.charCodeAt(0) - 0xE000).join(''))] ?? '';
    // An image's alt is an attribute, so what was held in it comes back as text.
    const plain = (html) => html.replace(MARK, (_, n) => at(n).replace(/<[^>]*>/g, ''));
    let s = escapeHtml(t)
      .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, c) => hold(`<code>${/^ .*[^ ].* $/.test(c) ? c.slice(1, -1) : c}</code>`))
      // shortcut: only the escapes Markdown needs, not all punctuation, so Windows paths like
      // "C:\Users\x\..." and "\\server" read as typed; widen it if someone needs "\." or "\\".
      .replace(/\\(&lt;|&gt;|[*_`|[\]~#])/g, (_, c) => hold(c))
      .replace(/&lt;br\s*\/?&gt;/gi, () => hold('<br>'))
      // Images first, so a linked image ("[![alt](a.png)](https://x)") keeps its picture.
      .replace(new RegExp(`!${LINK.source}`, 'g'), (_, alt, href, title) => hold(image(unescapeHtml(href), plain(alt), title ?? null)))
      .replace(LINK, (_, label, href) => hold(link(unescapeHtml(href), emphasis(label))))
      // "<https://x>", then bare URLs and DOIs, go through `link` too. Their trailing marks stay
      // outside: "**https://x/**." is bold, then a full stop.
      .replace(/&lt;(https?:\/\/(?:(?!&lt;|&gt;)[^\s<>\u0000])+)&gt;/gi, (_, url) => hold(link(unescapeHtml(url), url)));
    s = text(emphasis(linkBare(s, link, hold)));
    // A held piece can hold others, so at most one pass per piece; what a hook broke is dropped.
    for (let pass = 0; pass <= held.length && s.includes('\u0000'); pass++) s = s.replace(MARK, (_, n) => at(n));
    return s.replace(/\u0000[\uE000-\uE009]*/g, '');
  };

  /**
   * A paragraph's lines: a line ending in "\" or two spaces breaks. With `breaks` every line does,
   * and each is its own run of emphasis, so a stray "*" can't italicise the next line.
   */
  const paragraph = (para) => (breaks ? para.map((l) => inline(l.trim())).join('<br>') : inline(para.map((l, n) => {
    if (n === para.length - 1) return l.trim();
    if (/\\$/.test(l.trimEnd())) return `${l.trim().slice(0, -1)}\n`;
    return `${l.trim()}${/ {2,}$/.test(l) ? '\n' : ' '}`;
  }).join('')).replace(/\n/g, '<br>'));

  const table = (rows) => {
    const cells = (r) => r.trim().replace(/^\||(?<!\\)\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
    const hasHead = rows.length > 1 && DELIM.test(rows[1]) && rows[1].includes('-');
    const align = hasHead ? cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? ' class="cui-al-c"' : /-:$/.test(c) ? ' class="cui-al-r"' : '')) : [];
    const row = (r, tag) => {
      let cs = cells(r);
      if (hasHead) cs = align.map((_, n) => cs[n] ?? '');
      return `<tr>${cs.map((c, n) => `<${tag}${align[n] ?? ''}>${inline(c)}</${tag}>`).join('')}</tr>`;
    };
    const head = hasHead ? `<thead>${row(rows[0], 'th')}</thead>` : '';
    const body = (hasHead ? rows.slice(2) : rows).map((r) => row(r, 'td')).join('');
    return `<div class="cui-table"><table>${head}<tbody>${body}</tbody></table></div>`;
  };

  /** The list starting at lines[i]: its HTML and the line after it. */
  const list = (lines, i) => {
    const first = ITEM.exec(lines[i]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sibling = (l) => { const m = ITEM.exec(l); return !!m && m[1].length <= indent && /\d/.test(m[2]) === ordered; };
    const items = [];
    let loose = false;
    let item = null;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (sibling(l)) {
        const m = ITEM.exec(l);
        item = { lines: [m[3] ?? ''], content: m[1].length + m[2].length + 1 };
        items.push(item);
      } else if (!l.trim()) {
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k === lines.length) break;
        if (sibling(lines[k])) loose = true;
        else if (indentOf(lines[k]) > indent) {
          // A second paragraph in the item makes the list loose; a nested list after a gap doesn't.
          if (!ITEM.test(lines[k].slice(Math.min(item.content, indentOf(lines[k]))))) loose = true;
          item.lines.push(...lines.slice(i, k).map(() => ''));
        } else break;
        i = k - 1;
      } else if (indentOf(l) > indent) {
        item.lines.push(l.slice(Math.min(item.content, indentOf(l))));
      } else if (lines[i - 1].trim() && !startsBlock(lines, i, breaks) && !ITEM.test(l)) {
        item.lines.push(l.trim()); // a lazy wrap carries on the item's last line
      } else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : '';
    const lis = items.map((it) => {
      const task = /^\[([ xX])\]\s+/.exec(it.lines[0]);
      if (task) it.lines[0] = it.lines[0].slice(task[0].length);
      const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '';
      return `<li${task ? ' class="cui-task"' : ''}>${box}${blocks(it.lines, !loose)}</li>`;
    });
    return { html: `<${tag}${start}>${lis.join('')}</${tag}>`, next: i };
  };

  /** HTML for `lines`; `tight` drops the <p> around paragraphs, as in a list without gaps. */
  const blocks = (lines, tight = false) => {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i++;
      } else if ((m = FENCE.exec(line))) {
        const code = [];
        const close = new RegExp(`^ {0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}\\s*$`);
        for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
        i++;
        // shortcut: mermaid and other languages show as plain code; render them if people start writing diagrams.
        out.push(`<pre><code${m[2] ? ` class="language-${escapeHtml(m[2])}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      } else if ((m = HEADING.exec(line))) {
        const html = inline(m[2]);
        let id = slug(html);
        const n = slugs.get(id) ?? 0;
        slugs.set(id, n + 1);
        if (n) id += `-${n}`;
        const level = Math.min(m[1].length + base, 6);
        out.push(`<h${level} data-slug="${escapeHtml(id)}">${html}</h${level}>`);
        i++;
      } else if (HR.test(line)) {
        out.push('<hr>');
        i++;
      } else if (isTableStart(lines, i)) {
        const rows = [lines[i]];
        for (i++; i < lines.length && lines[i].includes('|') && (/^\s*\|/.test(lines[i]) || rows.length === 1 || !startsBlock(lines, i, breaks)); i++) rows.push(lines[i]);
        out.push(table(rows));
      } else if (QUOTE.test(line)) {
        const quoted = [];
        for (; i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && quoted.at(-1)?.trim() && !startsBlock(lines, i, breaks))); i++) {
          quoted.push(lines[i].replace(/^ {0,3}> ?/, ''));
        }
        out.push(`<blockquote>${blocks(quoted)}</blockquote>`);
      } else if (ITEM.test(line)) {
        const l = list(lines, i);
        out.push(l.html);
        i = l.next;
      } else {
        const para = [];
        for (; i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines, i, breaks)); i++) para.push(lines[i]);
        out.push(tight ? paragraph(para) : `<p>${paragraph(para)}</p>`);
      }
    }
    return out.join('');
  };

  // \0 marks held-out pieces inside inline(), so the text itself can't carry it (nor \1, which once did too).
  let lines = stripComments(src.replace(/[\u0000\u0001]/g, '\uFFFD').replace(/\r\n?/g, '\n')).split('\n');
  let front = '';
  // YAML front matter stays apart from the doc, as GitHub keeps it.
  const fm = !breaks && lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (fm > 0 && lines.slice(1, fm).every((l) => !l.trim() || /^[\w-]+:|^\s|^-/.test(l))) {
    front = `<pre class="cui-front-matter"><code>${escapeHtml(lines.slice(1, fm).join('\n'))}</code></pre>`;
    lines = lines.slice(fm + 1);
  }
  return front + blocks(lines);
}

/**
 * A reply squeezed into a line or two, for a preview or a button (Mandate's ReplyLine): no links
 * (their labels stay), a list item is a "• " line, every other block is its text on a line of its
 * own, joined with <br>. Bold, italics and code stay. HTML, escaped like renderMarkdown's.
 */
export function markdownLine(src, { streaming = false } = {}) {
  if (streaming) src = mendStreaming(src);
  const plain = { link: (_href, html) => html, image: (_href, alt) => alt, breaks: true };
  const out = [];
  for (const raw of stripComments(src.replace(/\r\n?/g, '\n')).split('\n')) {
    if (!raw.trim() || FENCE.test(raw) || HR.test(raw) || (raw.includes('|') && DELIM.test(raw) && raw.includes('-'))) continue;
    let l = raw.replace(/^(?: {0,3}>)+ ?/, '').trim();
    const item = ITEM.exec(l);
    const bullet = item ? '• ' : '';
    if (item) l = (item[3] ?? '').replace(/^\[[ xX]\]\s+/, '');
    else l = l.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '');
    if (/^\|.*\|$/.test(l)) l = l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()).join(' · ');
    // One paragraph of one line: its HTML is the line's, inside a single <p>.
    const html = renderMarkdown(l, plain).replace(/^<p>([\s\S]*)<\/p>$/, '$1');
    if (html || bullet) out.push(bullet + html);
  }
  return out.join('<br>');
}

// ---- In the page: an element that draws markdown, with the styles it needs. ----

/** Citadel's markdown look, on theme.css's variables. Moved from Citadel's style.css (.md) in #283. The first three
    rules are fully :where(), so Citadel's own .msg margins and link colour still win in Citadel. */
const CSS = `
:where(.cui-md > :first-child) { margin-top: 0; }
:where(.cui-md > :last-child) { margin-bottom: 0; }
:where(.cui-md a) { color: inherit; }
:where(.cui-md) { overflow-wrap: anywhere; }
:where(.cui-md :is(code, pre)) { font-family: var(--citadel-mono); font-size: 0.88em; }
:where(.cui-md pre) { background: var(--citadel-code-bg); padding: 0.6rem; border-radius: var(--citadel-radius-sm); overflow-x: auto; white-space: pre-wrap; margin: 0.4rem 0; }
:where(.cui-md :not(pre) > code) { background: var(--citadel-code-bg); padding: 0.05rem 0.3rem; border-radius: 4px; }
:where(.cui-md blockquote) { margin: 0.6rem 0; padding: 0.1rem 0.9rem; border-left: 3px solid var(--citadel-border); color: var(--citadel-muted); }
:where(.cui-md hr) { border: 0; border-top: 1px solid var(--citadel-border); margin: 1.2rem 0; }
:where(.cui-md .cui-table) { overflow-x: auto; margin: 0.75rem 0; }
:where(.cui-md table) { border-collapse: collapse; font-size: 0.9em; }
:where(.cui-md :is(th, td)) { border: 1px solid var(--citadel-border); padding: 0.3rem 0.55rem; text-align: left; vertical-align: top; overflow-wrap: normal; }
/* Words stay whole in a cell, but one long code token or URL may break, or it would widen the table and squeeze the other columns to a word per line (#462). */
:where(.cui-md :is(th, td) :is(code, a)) { overflow-wrap: anywhere; }
:where(.cui-md th) { background: var(--citadel-code-bg); }
:where(.cui-md :is(th, td).cui-al-r) { text-align: right; }
:where(.cui-md :is(th, td).cui-al-c) { text-align: center; }
:where(.cui-md li.cui-task) { list-style: none; }
:where(.cui-md li.cui-task > input) { margin: 0 0.35rem 0 -1.2rem; vertical-align: middle; }
:where(.cui-md li > p) { margin: 0.35rem 0; }
:where(.cui-md .cui-front-matter) { color: var(--citadel-muted); font-size: 0.85em; }
:where(.cui-md .cui-link) { text-decoration: underline dotted; }
:where(.cui-md .cui-alt) { color: var(--citadel-muted); }
:where(.cui-md .cui-copy) {
  float: right; margin: -0.25rem -0.25rem 0.2rem 0.6rem; padding: 0.15rem 0.5rem; line-height: 1.3;
  border: 1px solid var(--citadel-border); border-radius: var(--citadel-radius-sm); background: transparent; color: var(--citadel-text);
  font: 500 var(--citadel-size-small) var(--citadel-font); cursor: pointer; user-select: none;
}
:where(.cui-md .cui-copy)::before { content: 'Copy'; }
:where(.cui-md .cui-copy[data-copied="yes"])::before { content: 'Copied'; }
:where(.cui-md .cui-copy[data-copied="no"])::before { content: "Couldn't copy"; }
@media (hover: hover) { :where(.cui-md pre:not(:hover, :focus-within) > .cui-copy:not([data-copied])) { opacity: 0; } }
:where(.cui-copy-text) { position: fixed; top: 0; left: -9999px; opacity: 0; font-size: 16px; }
`;
let sheet = false;
function adoptStyles() {
  if (sheet) return;
  sheet = true;
  // Safari before 16.4 can't construct sheets: there the markdown draws unstyled rather than not at all.
  try {
    const s = new CSSStyleSheet();
    s.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  } catch {}
}

/**
 * Put `text` on the clipboard; whether it worked. navigator.clipboard needs a secure context (not
 * Citadel's plain-http tailnet address), so without it a hidden textarea is copied the old way. The
 * textarea goes beside `near` (default the body), so it can be selected inside a modal dialog too.
 */
export async function copyText(text, near = document.body) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement('textarea');
  ta.className = 'cui-copy-text';
  ta.value = text;
  ta.readOnly = true;
  const back = document.activeElement;
  near.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  back?.focus?.({ preventScroll: true });
  return ok;
}

/** A fenced block's Copy button: its label is CSS, so the block's text and a selection over it stay the code's. */
const copyButton = () => label(Object.assign(document.createElement('button'), { type: 'button', className: 'cui-copy' }), 'Copy code');
const label = (b, text) => (b.setAttribute('aria-label', text), b);
const copied = new WeakMap();
async function onCopy(e) {
  const b = e.target.closest?.('.cui-copy');
  const code = b?.parentElement.querySelector(':scope > code');
  if (!code) return;
  const ok = await copyText(code.textContent, b.parentElement);
  b.dataset.copied = ok ? 'yes' : 'no';
  label(b, ok ? 'Copied' : 'Couldn\'t copy');
  clearTimeout(copied.get(b));
  copied.set(b, setTimeout(() => {
    delete b.dataset.copied;
    label(b, 'Copy code');
  }, 2000));
}
const hooked = new WeakSet();

/** A div.cui-md drawing `src` (options as renderMarkdown's), with its styles adopted. */
export function markdownElement(src, opts) {
  const el = document.createElement('div');
  updateMarkdown(el, src, opts);
  return el;
}

/**
 * Draw `src` into `el` (made a .cui-md), as a reply streams in. Only what changed is replaced: the
 * blocks that render the same are kept, so a selection or a text search in them survives.
 */
export function updateMarkdown(el, src, opts) {
  adoptStyles();
  el.classList.add('cui-md');
  const t = document.createElement('template');
  t.innerHTML = renderMarkdown(src, opts);
  // Before comparing, so an unchanged block with its button still matches the one drawn.
  for (const pre of t.content.querySelectorAll('pre:not(.cui-front-matter)')) pre.prepend(copyButton());
  if (!hooked.has(el)) {
    hooked.add(el);
    el.addEventListener('click', onCopy);
  }
  const next = [...t.content.childNodes];
  const old = [...el.childNodes];
  let same = 0;
  while (same < next.length && same < old.length && old[same].isEqualNode(next[same])) same++;
  for (const n of old.slice(same)) n.remove();
  el.append(...next.slice(same));
}
