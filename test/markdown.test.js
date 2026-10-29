// The Markdown renderer, one fixture per construct Delve's docs use (#155's audit,
// shared/project/markdown-parity-audit-2026-10.md), plus what chat relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, slug } from '../public/markdown.js';
import { linkThreadRefs, linkUrls } from '../public/threadrefs.js';
import { struckSource } from '../public/strike.js';

const md = (src, opts) => renderMarkdown(src, opts);
const chat = (src) => renderMarkdown(src, { breaks: true, text: (h) => linkThreadRefs(linkUrls(h), 2) });

test('a GFM table, with and without outer pipes', () => {
  const want = '<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>';
  assert.equal(md('| a | b |\n|---|---|\n| 1 | 2 |'), want);
  assert.equal(md('a | b\n--- | ---\n1 | 2'), want);
});

test('table columns align as the delimiter row says', () => {
  const html = md('| n | name | mid |\n|---:|:---|:---:|\n| 1 | x | y |');
  assert.match(html, /<th class="al-r">n<\/th><th>name<\/th><th class="al-c">mid<\/th>/);
  assert.match(html, /<td class="al-r">1<\/td><td>x<\/td><td class="al-c">y<\/td>/);
});

test('table cells: escaped pipes, inline code, <br>, missing cells', () => {
  const html = md('| a | b | c |\n|---|---|---|\n| x \\| y | `code` | one<br>two |\n| only |');
  assert.match(html, /<td>x \| y<\/td><td><code>code<\/code><\/td><td>one<br>two<\/td>/);
  assert.match(html, /<tr><td>only<\/td><td><\/td><td><\/td><\/tr>/);
});

test('a table inside a list item stays a table (heroes.md:83)', () => {
  const html = md('- **Moods** follow the outlook:\n\n  | Mood | Face |\n  |---|---|\n  | steady | a set mouth |\n- next');
  assert.match(html, /<ul><li><p><strong>Moods<\/strong> follow the outlook:<\/p><div class="table-wrap"><table>/);
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
    '<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>');
});

test('fenced code keeps its language, and nothing inside is Markdown', () => {
  assert.equal(md('```csharp\nvar x = a * b * c; // #12\n```'), '<pre><code class="language-csharp">var x = a * b * c; // #12</code></pre>');
  assert.equal(md('~~~\n<b>\n~~~'), '<pre><code>&lt;b&gt;</code></pre>');
  assert.equal(md('- step:\n  ```\n  run it\n  ```'), '<ul><li>step:<pre><code>run it</code></pre></li></ul>');
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
  assert.equal(md('![Six moods](../art/moods.png)'), '<p><span class="muted">[image: Six moods]</span></p>');
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
    '<p><a href="https://a.b" target="_blank" rel="noopener">w</a> <span class="link" title="f.md">f</span></p>');
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

test('emphasis never reaches into URLs or link targets', () => {
  assert.equal(chat('see https://x.io/a_b_c and https://x.io/*y*'),
    '<p>see <a href="https://x.io/a_b_c" target="_blank" rel="noopener">https://x.io/a_b_c</a> and <a href="https://x.io/*y*" target="_blank" rel="noopener">https://x.io/*y*</a></p>');
  assert.equal(chat('up at **https://x.io/p/198/**. Done'),
    '<p>up at <strong><a href="https://x.io/p/198/" target="_blank" rel="noopener">https://x.io/p/198/</a></strong>. Done</p>');
});

test('hard breaks: backslash or two spaces in a doc, every line in chat', () => {
  assert.equal(md('a\\\nb  \nc\nd'), '<p>a<br>b<br>c d</p>');
  assert.equal(chat('a\nb'), '<p>a<br>b</p>');
  // A stray "*" on one chat line doesn't italicise into the next.
  assert.equal(chat('cp d/*.conf\nsee d/*.conf'), '<p>cp d/*.conf<br>see d/*.conf</p>');
});

test('front matter in a doc shows apart; chat never reads it', () => {
  assert.equal(md('---\ntitle: Vocab\ngenerated: true\n---\n# Vocab'),
    '<pre class="front-matter"><code>title: Vocab\ngenerated: true</code></pre><h1 data-slug="vocab">Vocab</h1>');
  assert.equal(chat('---\nx: y\n---'), '<hr><p>x: y</p><hr>');
});

test('rules, comments and CRLF', () => {
  assert.equal(md('a\n---\n<!-- index -->\n***\r\nb\r\n'), '<p>a</p><hr><hr><p>b</p>');
});

test('chat: #N refs link outside code, and #127\'s strikes render', () => {
  assert.equal(chat('see #12, not `#13`'), '<p>see <a class="thread-ref" href="#/p/2/t/12">#12</a>, not <code>#13</code></p>');
  const struck = struckSource('- the build is green\n- next', [{ text: 'the build is green' }]);
  assert.equal(chat(struck), '<ul><li><del>the build is green</del></li><li>next</li></ul>');
  assert.equal(chat('~~**bold** struck~~ then ~~ spaced ~~'), '<p><del><strong>bold</strong> struck</del> then ~~ spaced ~~</p>');
});
