// The Markdown renderer, one fixture per construct Delve's docs use (#155's audit,
// shared/project/markdown-parity-audit-2026-10.md), plus what chat relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, linkifyHtml, renderMarkdown, slug } from '../public/ui/markdown.js';
import { linkThreadRefs, linkUrls } from '../public/threadrefs.js';
import { struckSource } from '../public/strike.js';

// Headings as written, as Citadel draws documents and chat (core.js markdownDoc).
const md = (src, opts) => renderMarkdown(src, { headingBase: 1, ...opts });
const chat = (src) => renderMarkdown(src, { breaks: true, headingBase: 1, text: (h) => linkThreadRefs(linkUrls(h), 2) });

test('a GFM table, with and without outer pipes', () => {
  const want = '<div class="cui-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>';
  assert.equal(md('| a | b |\n|---|---|\n| 1 | 2 |'), want);
  assert.equal(md('a | b\n--- | ---\n1 | 2'), want);
});

test('table columns align as the delimiter row says', () => {
  const html = md('| n | name | mid |\n|---:|:---|:---:|\n| 1 | x | y |');
  assert.match(html, /<th class="cui-al-r">n<\/th><th>name<\/th><th class="cui-al-c">mid<\/th>/);
  assert.match(html, /<td class="cui-al-r">1<\/td><td>x<\/td><td class="cui-al-c">y<\/td>/);
});

test('table cells: escaped pipes, inline code, <br>, missing cells', () => {
  const html = md('| a | b | c |\n|---|---|---|\n| x \\| y | `code` | one<br>two |\n| only |');
  assert.match(html, /<td>x \| y<\/td><td><code>code<\/code><\/td><td>one<br>two<\/td>/);
  assert.match(html, /<tr><td>only<\/td><td><\/td><td><\/td><\/tr>/);
});

test('a table inside a list item stays a table (heroes.md:83)', () => {
  const html = md('- **Moods** follow the outlook:\n\n  | Mood | Face |\n  |---|---|\n  | steady | a set mouth |\n- next');
  assert.match(html, /<ul><li><p><strong>Moods<\/strong> follow the outlook:<\/p><div class="cui-table"><table>/);
  assert.match(html, /<td>steady<\/td><td>a set mouth<\/td>/);
  assert.match(html, /<li><p>next<\/p><\/li><\/ul>$/);
});

test('rows that were never a table (the Tech Tree export) stay paragraphs, as on GitHub', () => {
  assert.equal(md('tech_Storecraft | Storecraft | Tech |\n\ntech_Masonry | Masonry | Tech |'),
    '<p>tech_Storecraft | Storecraft | Tech |</p><p>tech_Masonry | Masonry | Tech |</p>');
});

test('a line without pipes after a table is a paragraph, not a row', () => {
  assert.match(md('| a |\n|---|\n| 1 |\nFirst hero: 28'), /<\/table><\/div><p>First hero: 28<\/p>$/);
});

test('nested lists, tight and loose', () => {
  assert.equal(md('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  assert.equal(md('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  // A second paragraph in an item.
  assert.equal(md('1. a\n\n   more\n2. b'), '<ol><li><p>a</p><p>more</p></li><li><p>b</p></li></ol>');
});

test('ordered lists: ")" markers, a start past 1, a list nested on the same line', () => {
  assert.equal(md('0) zero\n1) one'), '<ol start="0"><li>zero</li><li>one</li></ol>');
  assert.equal(md('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md('- 1. **Suits**\n- 2. Chips'), '<ul><li><ol><li><strong>Suits</strong></li></ol></li><li><ol start="2"><li>Chips</li></ol></li></ul>');
});

test('a wrapped line starting with a number carries on the sentence (places.md:123)', () => {
  assert.equal(md('- a pier within\n  450. About a third stay plain.\n- next'),
    '<ul><li>a pier within 450. About a third stay plain.</li><li>next</li></ul>');
  // In chat every line is as typed, so "3." after a bold line still starts a list.
  assert.equal(chat('**Waiting:**\n3. Play it'), '<p><strong>Waiting:</strong></p><ol start="3"><li>Play it</li></ol>');
});

test('an ordered list then bullets are two lists', () => {
  assert.equal(md('1. a\n2. b\n- c'), '<ol><li>a</li><li>b</li></ol><ul><li>c</li></ul>');
});

test('task lists get checkboxes', () => {
  assert.equal(md('- [ ] todo\n- [x] done'),
    '<ul><li class="cui-task"><input type="checkbox" disabled> todo</li><li class="cui-task"><input type="checkbox" disabled checked> done</li></ul>');
});

test('fenced code keeps its language, and nothing inside is Markdown', () => {
  assert.equal(md('```csharp\nvar x = a * b * c; // #12\n```'), '<pre><code class="language-csharp">var x = a * b * c; // #12</code></pre>');
  assert.equal(md('~~~\n<b>\n~~~'), '<pre><code>&lt;b&gt;</code></pre>');
  assert.equal(md('- step:\n  ```\n  run it\n  ```'), '<ul><li>step:<pre><code>run it</code></pre></li></ul>');
});

test('a line that opens and closes its backticks at once is code, not a fence', () => {
  assert.equal(md('```npm test```\n\nThen deploy.'), '<p><code>npm test</code></p><p>Then deploy.</p>');
  assert.equal(chat('```npm test```\nThen deploy.'), '<p><code>npm test</code><br>Then deploy.</p>');
});

test('blockquotes, with lists inside and lazy lines', () => {
  assert.equal(md('> quoted\nlazy\n\n> 1) one\n> 2) two'),
    '<blockquote><p>quoted lazy</p></blockquote><blockquote><ol><li>one</li><li>two</li></ol></blockquote>');
});

test('raw HTML is escaped, all but <br>', () => {
  assert.equal(md('<details><summary>x</summary></details> <img src=x onerror=alert(1)> a<br/>b'),
    '<p>&lt;details&gt;&lt;summary&gt;x&lt;/summary&gt;&lt;/details&gt; &lt;img src=x onerror=alert(1)&gt; a<br>b</p>');
  assert.equal(md('`<br>`'), '<p><code>&lt;br&gt;</code></p>');
});

test('images go through the hook; without one they show their alt text', () => {
  assert.equal(md('![Six moods](../art/moods.png)'), '<p><span class="cui-alt">[image: Six moods]</span></p>');
  const image = (href, alt) => `<img src="${href}" alt="${alt}">`;
  assert.equal(md('![a "b"](x.png "title")', { image }), '<p><img src="x.png" alt="a &quot;b&quot;"></p>');
});

test('links go through the hook with their target unescaped and their text rendered', () => {
  const seen = [];
  const link = (href, html) => { seen.push(href); return `<a href="#">${html}</a>`; };
  assert.equal(md('[**decisions**](decisions.md) and [x](../a/b.md#sec) and [q](https://x.io/?a=1&b=2)', { link }),
    '<p><a href="#"><strong>decisions</strong></a> and <a href="#">x</a> and <a href="#">q</a></p>');
  assert.deepEqual(seen, ['decisions.md', '../a/b.md#sec', 'https://x.io/?a=1&b=2']);
  // The default: web links open, anything else is inert.
  assert.equal(md('[w](https://a.b) [f](f.md)'),
    '<p><a href="https://a.b" target="_blank" rel="noopener noreferrer">w</a> <span class="cui-link" title="f.md">f</span></p>');
});

test('a link target may hold balanced parentheses', () => {
  assert.equal(md('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and [f](fn(a).md).'),
    '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">wiki</a> and <span class="cui-link" title="fn(a).md">f</span>.</p>');
});

test('headings carry GitHub\'s slug, deduplicated', () => {
  assert.equal(md('## Open questions\n## Open questions\n### 1. A this-moment key: for `playtests`'),
    '<h2 data-slug="open-questions">Open questions</h2><h2 data-slug="open-questions-1">Open questions</h2>'
    + '<h3 data-slug="1-a-this-moment-key-for-playtests">1. A this-moment key: for <code>playtests</code></h3>');
  assert.equal(slug('Build 2: the roll-up'), 'build-2-the-roll-up');
});

test('emphasis: underscores, bold italic, and what must stay plain', () => {
  assert.equal(md('_Not_: a combined element'), '<p><em>Not</em>: a combined element</p>');
  assert.equal(md('***both***'), '<p><strong><em>both</em></strong></p>');
  assert.equal(md('snake_case_name and <date>_<branch> vs <date>_<sha>'),
    '<p>snake_case_name and &lt;date&gt;_&lt;branch&gt; vs &lt;date&gt;_&lt;sha&gt;</p>');
  assert.equal(md('src/** and tools/**'), '<p>src/** and tools/**</p>');
  assert.equal(md('\\*not italic\\* and a\\|b'), '<p>*not italic* and a|b</p>');
  assert.equal(md('C:\\Users\\x\\... and \\\\server'), '<p>C:\\Users\\x\\... and \\\\server</p>');
});

test('an escaped backtick is a backtick, not a code span; a backslash inside code stays', () => {
  assert.equal(md('a \\`not code\\` b'), '<p>a `not code` b</p>');
  assert.equal(md('in `C:\\` then'), '<p>in <code>C:\\</code> then</p>');
});

test('emphasis never reaches into URLs or link targets', () => {
  assert.equal(chat('see https://x.io/a_b_c and https://x.io/*y*'),
    '<p>see <a href="https://x.io/a_b_c" target="_blank" rel="noopener noreferrer">https://x.io/a_b_c</a> and <a href="https://x.io/*y" target="_blank" rel="noopener noreferrer">https://x.io/*y</a>*</p>');
  assert.equal(chat('up at **https://x.io/p/198/**. Done'),
    '<p>up at <strong><a href="https://x.io/p/198/" target="_blank" rel="noopener noreferrer">https://x.io/p/198/</a></strong>. Done</p>');
});

test('hard breaks: backslash or two spaces in a doc, every line in chat', () => {
  assert.equal(md('a\\\nb  \nc\nd'), '<p>a<br>b<br>c d</p>');
  assert.equal(chat('a\nb'), '<p>a<br>b</p>');
  // A stray "*" on one chat line doesn't italicise into the next.
  assert.equal(chat('cp d/*.conf\nsee d/*.conf'), '<p>cp d/*.conf<br>see d/*.conf</p>');
});

test('front matter in a doc shows apart; chat never reads it', () => {
  assert.equal(md('---\ntitle: Vocab\ngenerated: true\n---\n# Vocab'),
    '<pre class="cui-front-matter"><code>title: Vocab\ngenerated: true</code></pre><h1 data-slug="vocab">Vocab</h1>');
  assert.equal(chat('---\nx: y\n---'), '<hr><p>x: y</p><hr>');
});

test('a doc that opens with a rule and a list, or two rules, has no front matter', () => {
  assert.equal(md('---\n- a\n- b\n---\nrest'), '<hr><ul><li>a</li><li>b</li></ul><hr><p>rest</p>');
  assert.equal(md('---\n\n---\nrest'), '<hr><hr><p>rest</p>');
});

test('rules, comments and CRLF', () => {
  assert.equal(md('a\n---\n<!-- index -->\n***\r\nb\r\n'), '<p>a</p><hr><hr><p>b</p>');
});

test('an HTML comment in code is code: in a fence or a code span it shows, and it can\'t swallow a fence', () => {
  assert.equal(md('```html\n<!-- the nav -->\n<nav></nav>\n```'),
    '<pre><code class="language-html">&lt;!-- the nav --&gt;\n&lt;nav&gt;&lt;/nav&gt;</code></pre>');
  assert.equal(md('Write `<!-- TODO -->` above it <!-- gone -->'), '<p>Write <code>&lt;!-- TODO --&gt;</code> above it</p>');
  assert.match(md('a <!-- note\n\n```\nx\n```\n\n-->'), /<pre><code>x<\/code><\/pre>/);
  assert.equal(markdownLine('Write `<!-- TODO -->` above it'), 'Write <code>&lt;!-- TODO --&gt;</code> above it');
});

test('a comment that opens a line hides all to its end, a fenced block too, as GitHub does (#468 S14-3 review)', () => {
  assert.equal(md('before\n\n<!--\n```js\nold()\n```\n-->\n\nafter'), '<p>before</p><p>after</p>');
  assert.equal(md('before\n\n<!-- old:\n```\nx\n``` --> after'), '<p>before</p><p>after</p>');
  // Never closed: no comment, so nothing is hidden.
  assert.match(md('<!-- open\n```\nx\n```'), /<pre><code>x<\/code><\/pre>/);
});

test('chat: #N refs link outside code, and #127\'s strikes render', () => {
  assert.equal(chat('see #12, not `#13`'), '<p>see <a class="thread-ref" href="#/p/2/t/12">#12</a>, not <code>#13</code></p>');
  const struck = struckSource('- the build is green\n- next', [{ text: 'the build is green' }]);
  assert.equal(chat(struck), '<ul><li><del>the build is green</del></li><li>next</li></ul>');
  assert.equal(chat('~~**bold** struck~~ then ~~ spaced ~~'), '<p><del><strong>bold</strong> struck</del> then ~~ spaced ~~</p>');
});

test('a text hook that rewrites digits, or leaves a stray NUL, can\'t hang the render', () => {
  const text = (h) => h.replace(/\b\d+\b/g, (n) => `<b>${n}</b>`);
  assert.equal(md('Paid `rent` 1200 today', { text }), '<p>Paid <code>rent</code> <b>1200</b> today</p>');
  assert.equal(md('a `b` c', { text: (h) => `${h}\u0000` }), '<p>a <code>b</code> c</p>');
});

test('a NUL or \\u0001 in the text can neither hang the render nor reach held HTML', () => {
  assert.equal(md('a\u0000b `c\u0000d`'), '<p>a�b <code>c�d</code></p>');
  const image = (href, alt) => `<img src="${href}" alt="${alt}">`;
  assert.equal(md('![\u00001\u0000](p.png) [x](http://e/"onerror=1)', { image }),
    '<p><img src="p.png" alt="�1�"> <a href="http://e/&quot;onerror=1" target="_blank" rel="noopener noreferrer">x</a></p>');
});

test('a linked image keeps its picture, and alt text is plain', () => {
  const image = (href, alt) => `<img src="${href}" alt="${alt}">`;
  assert.equal(md('[![badge](b.png)](https://x.io)', { image }),
    '<p><a href="https://x.io" target="_blank" rel="noopener noreferrer"><img src="b.png" alt="badge"></a></p>');
  assert.equal(md('![a `x` b](u.png)', { image }), '<p><img src="u.png" alt="a x b"></p>');
});

// ---- Citadel UI additions (#283): what apps get from /apps/_citadel/ui/markdown.js. ----
import { markdownLine } from '../public/ui/markdown.js';

const live = (src) => renderMarkdown(src, { streaming: true, headingBase: 1 });

test('streaming: a table is held back at every cut point, never shown as pipes (ToC\'s test)', () => {
  const reply = 'Pieces:\n\n| Piece | Gives |\n|---|---|\n| Wand | Spell damage |\n| Ring | Mana |\n';
  for (let n = 0; n <= reply.length; n++) assert.doesNotMatch(live(reply.slice(0, n)), /\|/, `cut at ${n}: ${JSON.stringify(reply.slice(0, n))}`);
  // The header waits for its separator; then the table shows, with no row still arriving.
  assert.equal(live(reply.slice(0, reply.indexOf('| Piece') + 4)), '<p>Pieces:</p>');
  assert.equal(live(reply.slice(0, reply.indexOf('|---') + 5)), '<p>Pieces:</p>');
  assert.match(live(reply.slice(0, reply.indexOf('| Wand') + 3)), /<thead>.*<tbody><\/tbody>/);
  assert.equal(live(reply), md(reply));
  // Once the reply is done, a lone pipe line is just text.
  assert.equal(md('a | b'), '<p>a | b</p>');
});

test('streaming: half-written markup is closed or hidden (Mandate\'s mend)', () => {
  const p = (html) => `<p>${html}</p>`;
  assert.equal(live('**9:59'), p('<strong>9:59</strong>'));
  assert.equal(live('- **9:59'), '<ul><li><strong>9:59</strong></li></ul>');
  assert.equal(live('- **9:59 pm:*'), '<ul><li><strong>9:59 pm:</strong></li></ul>', 'half of the closer');
  assert.equal(live('an *aside*'), p('an <em>aside</em>'));
  assert.equal(live('Done. **'), p('Done.'));
  assert.equal(live('see `item_add'), p('see <code>item_add</code>'));
  assert.equal(live('fill in [the form](https://exa'), p('fill in the form'));
  assert.equal(live('fill in [the fo'), p('fill in the fo'));
  assert.equal(live('see ![the chart](https://exa'), p('see'), 'a half image waits whole, not as its alt text');
  assert.equal(live('see ![the ch'), p('see'));
  assert.equal(live('2 ** 3'), p('2 ** 3'));
  assert.equal(live('```\nconst **x'), '<pre><code>const **x</code></pre>', 'inside an open fence nothing changes');
  assert.equal(renderMarkdown('**a\n**b', { streaming: true, breaks: true }), p('**a<br><strong>b</strong>'), 'only the last line is mended');
  // A list marker waits for its words, so the dash or number never flashes as text.
  assert.equal(live('- a\n-'), '<ul><li>a</li></ul>');
  assert.equal(live('1. a\n2.'), '<ol><li>a</li></ol>');
  // Not streaming, nothing is mended.
  assert.equal(md('**9:59'), p('**9:59'));
});

test('streaming: a fence inside a longer open fence leaves it open, so its code is not mended', () => {
  assert.equal(live('````md\n```js\nconst x = a *'), '<pre><code class="language-md">```js\nconst x = a *</code></pre>');
  assert.equal(live('````md\n```js\n| a | b'), '<pre><code class="language-md">```js\n| a | b</code></pre>');
  assert.equal(live('````md\n```js\nx\n```\n````\nsee `item'), '<pre><code class="language-md">```js\nx\n```</code></pre><p>see <code>item</code></p>');
});

test('headingBase: a reply\'s # is an h3 by default, a document passes 1, and levels stop at 6', () => {
  assert.equal(renderMarkdown('# A\n## B'), '<h3 data-slug="a">A</h3><h4 data-slug="b">B</h4>');
  assert.equal(renderMarkdown('# A', { headingBase: 1 }), '<h1 data-slug="a">A</h1>');
  assert.equal(renderMarkdown('##### A'), '<h6 data-slug="a">A</h6>');
});

test('default links: http(s) and mailto open a new tab, never _top; anything else is inert', () => {
  assert.equal(renderMarkdown('[a](mailto:x@y.z)'), '<p><a href="mailto:x@y.z" target="_blank" rel="noopener noreferrer">a</a></p>');
  assert.equal(renderMarkdown('[a](javascript:alert)'), '<p><span class="cui-link" title="javascript:alert">a</span></p>');
  assert.doesNotMatch(renderMarkdown('[a](https://x.y) https://z.w'), /_top/);
});

const ext = (href, text = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test('linkify: bare URLs and DOIs in plain text become new-tab links, everything else escaped', () => {
  // Trailing punctuation ends the sentence, not the URL.
  assert.equal(linkify('see https://x.io/a.'), `see ${ext('https://x.io/a')}.`);
  assert.equal(linkify('Is it https://x.io/a?b=1&c=2?'), `Is it ${ext('https://x.io/a?b=1&amp;c=2')}?`);
  // A URL inside parentheses leaves the closing one out, but keeps one it opened itself.
  assert.equal(linkify('(see https://x.io/a)'), `(see ${ext('https://x.io/a')})`);
  assert.equal(linkify('(https://en.wikipedia.org/wiki/Foo_(bar))'), `(${ext('https://en.wikipedia.org/wiki/Foo_(bar)')})`);
  // DOIs, bare or with "doi:", go to doi.org; one inside a path or a version number doesn't.
  assert.equal(linkify('doi:10.1000/xyz123, then 10.1016/S0140-6736(20)30183-5.'),
    `${ext('https://doi.org/10.1000/xyz123', 'doi:10.1000/xyz123')}, then ${ext('https://doi.org/10.1016/S0140-6736(20)30183-5', '10.1016/S0140-6736(20)30183-5')}.`);
  assert.equal(linkify('DOI: 10.1234/a<b>'), `${ext('https://doi.org/10.1234/a', 'DOI: 10.1234/a')}&lt;b&gt;`);
  assert.equal(linkify('a/10.1234/x and v1.10.1234/y and 10.1234/'), 'a/10.1234/x and v1.10.1234/y and 10.1234/');
  // It never injects HTML: tags are escaped and a quote ends a URL.
  assert.equal(linkify('<b>x</b> https://a.b/"onmouseover=alert(1)'), `&lt;b&gt;x&lt;/b&gt; ${ext('https://a.b/')}&quot;onmouseover=alert(1)`);
  assert.equal(linkify('https:// alone'), 'https:// alone');
  // Outside markdown a trailing "_" or "*" is part of the address.
  assert.equal(linkify('https://x.io/item_'), ext('https://x.io/item_'));
  assert.equal(linkify(null), '');
});

test('linkify: a web address with no scheme links to https://, file and package names stay text (#440)', () => {
  assert.equal(linkify('Open console.firebase.google.com, then github.com/a/b_c.'),
    `Open ${ext('https://console.firebase.google.com', 'console.firebase.google.com')}, then ${ext('https://github.com/a/b_c', 'github.com/a/b_c')}.`);
  assert.equal(linkify('(web.dev/learn) x.co.uk/p example.com:8080/x?y=1'),
    `(${ext('https://web.dev/learn', 'web.dev/learn')}) ${ext('https://x.co.uk/p', 'x.co.uk/p')} ${ext('https://example.com:8080/x?y=1', 'example.com:8080/x?y=1')}`);
  // Hosts starting "app." or "dev." are addresses; a host ending in an unlisted country stays text whole.
  assert.equal(linkify('app.firebase.google.com dev.azure.com/x'),
    `${ext('https://app.firebase.google.com', 'app.firebase.google.com')} ${ext('https://dev.azure.com/x', 'dev.azure.com/x')}`);
  assert.equal(linkify('example.com.au/x and google.com.'), `example.com.au/x and ${ext('https://google.com', 'google.com')}.`);
  // Not an address: a file, an email, a path, a word with an underscore, a capitalised ending, a package name.
  const prose = 'land.sh README.md Node.js me@x.com a/b.com C:\\x.com foo_bar.com google.com_x ASP.NET Foo.IO org.apache.commons.io com.example.app localhost:3000';
  assert.equal(linkify(prose), prose.replace('&', '&amp;'));
});

test('linkifyHtml: links bare URLs in text, leaves tags, existing links and code alone', () => {
  assert.equal(linkifyHtml('<a href="https://x.y">https://x.y</a> <code>https://c.d</code> <pre>10.1234/p</pre> <em>https://e.f</em>'),
    `<a href="https://x.y">https://x.y</a> <code>https://c.d</code> <pre>10.1234/p</pre> <em>${ext('https://e.f')}</em>`);
  assert.equal(linkifyHtml('<img alt="https://x.y" src="a.png">'), '<img alt="https://x.y" src="a.png">');
});

test('markdown autolinks bare URLs and DOIs through the link hook, not inside links or code', () => {
  assert.equal(md('[l](https://a.b) <https://c.d/e> `https://code` https://f.g/h_i_j, doi:10.1234/x_y_z.'),
    `<p>${ext('https://a.b', 'l')} ${ext('https://c.d/e')} <code>https://code</code> ${ext('https://f.g/h_i_j')}, ${ext('https://doi.org/10.1234/x_y_z', 'doi:10.1234/x_y_z')}.</p>`);
  assert.equal(md('(see https://x.io/a)'), `<p>(see ${ext('https://x.io/a')})</p>`);
  // Emphasis by underscores around a URL or DOI still links it.
  assert.equal(md('_https://a.io/x_ and __doi:10.1234/ab__'), `<p><em>${ext('https://a.io/x')}</em> and <strong>${ext('https://doi.org/10.1234/ab', 'doi:10.1234/ab')}</strong></p>`);
  const seen = [];
  md('at https://x.io and 10.1234/q', { link: (href, html) => (seen.push([href, html]), html) });
  assert.deepEqual(seen, [['https://x.io', 'https://x.io'], ['https://doi.org/10.1234/q', '10.1234/q']]);
  // A web address with no scheme links, bold or in emphasis; in code it stays code (#440).
  assert.equal(md('Open **console.firebase.google.com** → _web.dev_ `x.com`'),
    `<p>Open <strong>${ext('https://console.firebase.google.com', 'console.firebase.google.com')}</strong> → <em>${ext('https://web.dev', 'web.dev')}</em> <code>x.com</code></p>`);
  // An image's alt is text, so a URL in it isn't a link.
  assert.equal(md('![see https://x.y](p.png)'), '<p><span class="cui-alt">[image: see https://x.y]</span></p>');
});

test('markdownLine: one line per block, "• " for items, no links, emphasis kept', () => {
  assert.equal(markdownLine('# Done\nMoved **Tuesday** to [Thursday](https://x.y).\n\n- one\n  2. two\n- [x] three\n\n---\n> said'),
    'Done<br>Moved <strong>Tuesday</strong> to Thursday.<br>• one<br>• two<br>• three<br>said');
  assert.equal(markdownLine('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(markdownLine('| a | b |\n|---|---|\n| 1 | 2 |'), 'a · b<br>1 · 2');
  assert.equal(markdownLine('<b>x</b> & y'), '&lt;b&gt;x&lt;/b&gt; &amp; y');
  assert.equal(markdownLine('Working on **it', { streaming: true }), 'Working on <strong>it</strong>');
});

// #898: a fenced block tagged with where it runs gets a header (label + tone); any other tag draws as before.
test('a shell-tagged fence says where it runs', () => {
  const pre = (tag, tone, label) =>
    `<pre class="cui-shell" data-tone="${tone}" data-label="${label}"><code class="language-${tag}">x</code></pre>`;
  assert.equal(md('```powershell-admin\nx\n```'), pre('powershell-admin', 'admin', 'PowerShell · Admin · Windows · Run as administrator'));
  assert.equal(md('```powershell\nx\n```'), pre('powershell', 'powershell', 'PowerShell · Windows'));
  assert.equal(md('```wsl\nx\n```'), pre('wsl', 'wsl', 'WSL · bash (Linux on your desktop)'));
  assert.equal(md('```fish\nx\n```'), pre('fish', 'fish', 'perigee · fish'));
  assert.equal(md('```bash\nx\n```'), pre('bash', 'bash', 'bash'));
  assert.equal(md('```cmd\nx\n```'), pre('cmd', 'cmd', 'cmd · Windows'));
});

test('shell aliases share the tone, tags are case-insensitive, one tone each', () => {
  const tone = (tag) => /data-tone="(\w+)"/.exec(md('```' + tag + '\nx\n```'))?.[1];
  for (const a of ['ps1', 'pwsh', 'PowerShell']) assert.equal(tone(a), 'powershell');
  for (const a of ['sh', 'zsh', 'console', 'shell']) assert.equal(tone(a), 'bash');
  assert.equal(tone('pwsh-admin'), 'admin');
  assert.equal(new Set(['powershell-admin', 'powershell', 'wsl', 'fish', 'bash', 'cmd'].map(tone)).size, 6);
});

test('an unknown or missing tag gets no header', () => {
  assert.equal(md('```js\nx\n```'), '<pre><code class="language-js">x</code></pre>');
  assert.equal(md('```\nx\n```'), '<pre><code>x</code></pre>');
});
