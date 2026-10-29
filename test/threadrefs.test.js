import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkPrUrls, linkThreadRefs, prOwnerRoute, prUrlParts } from '../public/threadrefs.js';

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

test('every number in a PR or issue list is a PR, not a minion', () => {
  for (const s of ['PRs #186 and #187', 'PRs #186, #187 and #188', 'PRs #186, #187, and #188', 'PRs #186/#187', 'issues #4 or #5', 'PRs #1 &amp; #2']) {
    assert.equal(link(s), s, s);
  }
  assert.equal(link('PR #186 shipped. #187 next'), `PR #186 shipped. ${a(187)} next`);
});

test('"<Scheme> #N" links into that scheme', () => {
  const schemes = [{ id: 1, name: 'Delve' }, { id: 2, name: 'Citadel' }, { id: 7, name: 'Delve Two' }, { id: 9, name: "Tom's game" }];
  const lnk = (html, titleOf) => linkThreadRefs(html, 2, titleOf, schemes);
  const at = (p, n, text) => `<a class="thread-ref" href="#/p/${p}/t/${n}">${text}</a>`;
  assert.equal(lnk('Delve #68'), at(1, 68, 'Delve #68'));
  assert.equal(lnk('see delve #68.'), `see ${at(1, 68, 'delve #68')}.`);
  assert.equal(lnk('Delve Two #3 and Delve #4'), `${at(7, 3, 'Delve Two #3')} and ${at(1, 4, 'Delve #4')}`);
  assert.equal(lnk('Tom&#39;s game #5'), at(9, 5, 'Tom&#39;s game #5'));
  assert.equal(lnk('Citadel #68', (n) => (n === 68 ? '#68 Sixty' : null)),
    '<a class="thread-ref" href="#/p/2/t/68" title="#68 Sixty">Citadel #68</a>');
  // Not a whole word, or not a scheme: today's behaviour.
  assert.equal(lnk('Undelve #6'), `Undelve ${a(6)}`);
  assert.equal(lnk('Perigee #6'), `Perigee ${a(6)}`);
  assert.equal(lnk('#68'), a(68));
  assert.equal(lnk('Delve PR #68'), 'Delve PR #68');
  assert.equal(lnk('<code>Delve #68</code>'), '<code>Delve #68</code>');
});

test('titles known threads and needs a project', () => {
  assert.equal(link('#3', (n) => (n === 3 ? '#3 Fix "it"' : null)),
    '<a class="thread-ref" href="#/p/2/t/3" title="#3 Fix &quot;it&quot;">#3</a>');
  assert.equal(linkThreadRefs('#3', null), '#3');
});

test('inAppHash keeps links into this app in the app', async () => {
  const { inAppHash } = await import('../public/threadrefs.js');
  const here = new URL('https://cara.apps.webplatformisbestplatform.net/#/p/2');
  assert.equal(inAppHash('#/p/2/t/11', here), '#/p/2/t/11');
  assert.equal(inAppHash('https://cara.apps.webplatformisbestplatform.net/#/p/2/t/11', here), '#/p/2/t/11');
  assert.equal(inAppHash('/#/a/5', here), '#/a/5');
  assert.equal(inAppHash('https://example.com/#/p/2/t/11', here), null);
  assert.equal(inAppHash('https://cara.apps.webplatformisbestplatform.net/other#/p/2', here), null);
  assert.equal(inAppHash('https://cara.apps.webplatformisbestplatform.net/api/x', here), null);
  assert.equal(inAppHash('#section', here), null);
  assert.equal(inAppHash('http://[bad', here), null);
});


test('PR URLs: only a PR\'s own page counts', () => {
  assert.deepEqual(prUrlParts('https://github.com/CaraMinden/gamedevtest/pull/186'), { repo: 'caraminden/gamedevtest', number: 186 });
  for (const s of ['https://github.com/o/r/pull/1/files', 'https://github.com/o/r/pull/1#issuecomment-2', 'https://github.com/o/r/issues/1', 'http://github.com/o/r/pull/1', null]) {
    assert.equal(prUrlParts(s), null, s);
  }
});

test('bare PR URLs become links, other text and existing links stay', () => {
  const url = 'https://github.com/o/r/pull/186';
  assert.equal(linkPrUrls(`draft PR ${url}.`), `draft PR <a href="${url}" target="_blank" rel="noopener">${url}</a>.`);
  for (const s of [`<a href="${url}">${url}</a>`, `<code>${url}</code>`, `${url}/files`, `${url}#issuecomment-1`, 'no links here']) {
    assert.equal(linkPrUrls(s), s, s);
  }
});

test('a PR link routes to the minion that owns it, not the one on screen', () => {
  const repos = new Map([['o/r', { projectId: 1, scheme: 'Delve', repo: 'o/r', prs: { 186: { id: 162, number: 68, title: 'Laptop scripts' } } }]]);
  assert.deepEqual(prOwnerRoute(repos, 'https://github.com/O/R/pull/186', 5), { hash: '#/p/1/t/68', title: 'Delve #68 Laptop scripts (owns PR #186)' });
  assert.equal(prOwnerRoute(repos, 'https://github.com/o/r/pull/186', 162), null);
  assert.equal(prOwnerRoute(repos, 'https://github.com/o/r/pull/7', 5), null);
  assert.equal(prOwnerRoute(null, 'https://github.com/o/r/pull/186', 5), null);
  assert.equal(prOwnerRoute(repos, 'https://example.com/', 5), null);
});
