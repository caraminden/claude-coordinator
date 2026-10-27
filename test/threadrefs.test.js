import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkThreadRefs } from '../public/threadrefs.js';

const link = (html, titleOf) => linkThreadRefs(html, 2, titleOf);
const a = (n, text = `#${n}`) => `<a class="thread-ref" href="#/p/2/t/${n}">${text}</a>`;

test('links standalone #N', () => {
  assert.equal(link('See #6 and ticket #12.'), `See ${a(6)} and ticket ${a(12)}.`);
  assert.equal(link('#3 first'), `${a(3)} first`);
  assert.equal(link('(#4)'), `(${a(4)})`);
  assert.equal(link('Created #15 · tag: feature'), `Created ${a(15)} · tag: feature`);
});

test('leaves code, links and tags alone', () => {
  assert.equal(link('<code>#5</code> #5'), `<code>#5</code> ${a(5)}`);
  assert.equal(link('<pre><code>x #5\ny</code></pre>'), '<pre><code>x #5\ny</code></pre>');
  assert.equal(link('<a href="https://x.dev/#7">see #7</a>'), '<a href="https://x.dev/#7">see #7</a>');
  assert.equal(link('<span class="link" title="a#8">b</span>'), '<span class="link" title="a#8">b</span>');
  // The renderer's code placeholders carry no "#".
  assert.equal(link('\u00000\u0000 #2'), `\u00000\u0000 ${a(2)}`);
});

test('skips URLs, entities, words and other numbering', () => {
  for (const s of ['page#12', 'https://x.dev/#12', 'x.dev/a#12', '&#39;', 'abc#1', '#12abc', '#1-2', '##3', 'C#1', 'PR #12', 'issue #4', 'Pull request #9', 'a=#3', '#/p/2/t/3']) {
    assert.equal(link(s), s, s);
  }
});

test('titles known threads and needs a project', () => {
  assert.equal(link('#3', (n) => (n === 3 ? '#3 Fix "it"' : null)),
    '<a class="thread-ref" href="#/p/2/t/3" title="#3 Fix &quot;it&quot;">#3</a>');
  assert.equal(linkThreadRefs('#3', null), '#3');
});
