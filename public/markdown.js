// Markdown to HTML, for chat messages and the documents threads write: GitHub-flavoured where the
// docs we show use it (audited against Delve's in #155). Pure string work, so it can be tested
// without a browser; markdownDoc in core.js hangs the app's links, file cards and #N refs on it.
// Raw HTML is escaped, all but <br>.

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/;
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

/** GitHub's id for a heading: lower case, punctuation dropped, spaces to hyphens. */
export function slug(html) {
  return unescapeHtml(html.replace(/<[^>]*>/g, '')).toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/**
 * `src` as HTML. Hooks, each given the target unescaped and the text as HTML:
 * - `link(href, html)`: a link's HTML (default: http(s) opens a new tab, anything else is inert);
 * - `image(href, alt, title)`: an image's HTML (default: its alt text);
 * - `text(html)`: runs over the inline HTML outside code and links, e.g. to link bare URLs and #N.
 * `breaks` keeps single line breaks as typed, as chat does.
 */
export function renderMarkdown(src, { link, image, text = (s) => s, breaks = false } = {}) {
  link ??= (href, html) => (/^https?:\/\//i.test(href)
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${html}</a>`
    : `<span class="link" title="${escapeHtml(href)}">${html}</span>`);
  image ??= (_href, alt) => `<span class="muted">[image: ${alt}]</span>`;
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
    // Code, escapes, links and URLs are held out as \0n\0 so emphasis can't reach into them.
    const held = [];
    const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
    const urls = [];
    let s = escapeHtml(t)
      .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, c) => hold(`<code>${/^ .*[^ ].* $/.test(c) ? c.slice(1, -1) : c}</code>`))
      // shortcut: only the escapes Markdown needs, not all punctuation, so Windows paths like
      // "C:\Users\x\..." and "\\server" read as typed; widen it if someone needs "\." or "\\".
      .replace(/\\(&lt;|&gt;|[*_`|[\]~#])/g, (_, c) => hold(c))
      .replace(/&lt;br\s*\/?&gt;/gi, () => hold('<br>'))
      .replace(/(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(?:&lt;)?([^\s()]*?)(?:&gt;)?(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, bang, label, href, title) => hold(bang
        ? image(unescapeHtml(href), label, title ?? null)
        : link(unescapeHtml(href), emphasis(label))))
      // A URL's trailing marks stay outside it: "**https://x/**." is bold, then a full stop.
      .replace(/https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<>\u0000])+/gi, (url) => {
        const tail = /[*_~.,:;!?]*$/.exec(url)[0];
        return `\u0001${urls.push(url.slice(0, url.length - tail.length)) - 1}\u0001${tail}`;
      });
    s = text(emphasis(s).replace(/\u0001(\d+)\u0001/g, (_, i) => urls[i]));
    while (s.includes('\u0000')) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
    return s;
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
    const align = hasHead ? cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? ' class="al-c"' : /-:$/.test(c) ? ' class="al-r"' : '')) : [];
    const row = (r, tag) => {
      let cs = cells(r);
      if (hasHead) cs = align.map((_, n) => cs[n] ?? '');
      return `<tr>${cs.map((c, n) => `<${tag}${align[n] ?? ''}>${inline(c)}</${tag}>`).join('')}</tr>`;
    };
    const head = hasHead ? `<thead>${row(rows[0], 'th')}</thead>` : '';
    const body = (hasHead ? rows.slice(2) : rows).map((r) => row(r, 'td')).join('');
    return `<div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`;
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
      return `<li${task ? ' class="task"' : ''}>${box}${blocks(it.lines, !loose)}</li>`;
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
        out.push(`<h${m[1].length} data-slug="${escapeHtml(id)}">${html}</h${m[1].length}>`);
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

  let lines = src.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let front = '';
  // YAML front matter stays apart from the doc, as GitHub keeps it.
  const fm = !breaks && lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (fm > 0 && lines.slice(1, fm).every((l) => !l.trim() || /^[\w-]+:|^\s|^-/.test(l))) {
    front = `<pre class="front-matter"><code>${escapeHtml(lines.slice(1, fm).join('\n'))}</code></pre>`;
    lines = lines.slice(fm + 1);
  }
  return front + blocks(lines);
}
