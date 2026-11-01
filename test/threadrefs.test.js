import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jumpParts, linkThreadRefs, linkUrls, prNumberRoute, prOwnerRoute, prUrlParts } from '../public/threadrefs.js';

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

test('a scheme\'s name scopes "\'s", "minion" and "minion #N in <Scheme>" to that scheme', () => {
  const schemes = [{ id: 1, name: 'Delve' }, { id: 2, name: 'Citadel' }, { id: 9, name: "Tom's game" }];
  const lnk = (html) => linkThreadRefs(html, 2, () => null, schemes);
  const at = (p, n, text = `#${n}`) => `<a class="thread-ref" href="#/p/${p}/t/${n}">${text}</a>`;
  // Escaped as the renderer escapes it: a straight apostrophe is &#39;.
  assert.equal(lnk('Delve&#39;s #5'), at(1, 5, 'Delve&#39;s #5'));
  assert.equal(lnk('Delve\u2019s #5'), at(1, 5, 'Delve\u2019s #5'));
  assert.equal(lnk("Delve's minion #5."), `${at(1, 5, "Delve's minion #5")}.`);
  assert.equal(lnk('Delve&#39;s minion #5'), at(1, 5, 'Delve&#39;s minion #5'));
  assert.equal(lnk('Delve minion #5'), at(1, 5, 'Delve minion #5'));
  assert.equal(lnk('Delve&#39;s minions #5 and #6'), `${at(1, 5, 'Delve&#39;s minions #5')} and ${at(1, 6)}`);
  assert.equal(lnk('see minion #5 in Delve.'), `see ${at(1, 5, 'minion #5')} in Delve.`);
  assert.equal(lnk('minions #5, #6 in Delve'), `${at(1, 5, 'minions #5')}, ${at(1, 6)} in Delve`);
  assert.equal(lnk('Tom&#39;s game&#39;s #3'), at(9, 3, 'Tom&#39;s game&#39;s #3'));
  // A plain #5 is still the scheme on screen, and so is anything looser than the forms above.
  assert.equal(lnk('#5'), at(2, 5));
  assert.equal(lnk('minion #5'), `minion ${at(2, 5)}`);
  assert.equal(lnk('#5 in Delve'), `${at(2, 5)} in Delve`);
  assert.equal(lnk('Delve #5 and #6'), `${at(1, 5, 'Delve #5')} and ${at(2, 6)}`);
  assert.equal(lnk('Delve&#39;s new minion #5'), `Delve&#39;s new minion ${at(2, 5)}`);
  assert.equal(lnk('minion #5 in Delveland'), `minion ${at(2, 5)} in Delveland`);
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

const tab = (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;

test('bare PR URLs become links, existing links and code stay', () => {
  const url = 'https://github.com/o/r/pull/186';
  assert.equal(linkUrls(`draft PR ${url}.`), `draft PR ${tab(url)}.`);
  // A PR's other pages link whole, never cut down to the PR.
  assert.equal(linkUrls(`${url}/files`), tab(`${url}/files`));
  assert.equal(linkUrls(`${url}#issuecomment-1`), tab(`${url}#issuecomment-1`));
  for (const s of [`<a href="${url}">${url}</a>`, `<code>${url}</code>`, `<pre>see ${url}</pre>`, 'no links here', 'xhttps://a.b', 'https://']) {
    assert.equal(linkUrls(s), s, s);
  }
});

test('bare URLs link without the punctuation around them', () => {
  const url = 'https://cara.apps.webplatformisbestplatform.net/preview/183/';
  assert.equal(linkUrls(`<strong>${url}</strong>`), `<strong>${tab(url)}</strong>`);
  for (const p of ['.', ',', ')', ':', ';', '!', '?', '),', '.)']) {
    assert.equal(linkUrls(`at ${url}${p}`), `at ${tab(url)}${p}`, p);
  }
  assert.equal(linkUrls(`(see ${url})`), `(see ${tab(url)})`);
  assert.equal(linkUrls(`[preview: ${url}]`), `[preview: ${tab(url)}]`);
  assert.equal(linkUrls(`https://a.io/${')'.repeat(30000)}`), `${tab('https://a.io/')}${')'.repeat(30000)}`);
  const wiki = 'https://en.wikipedia.org/wiki/Foo_(bar)';
  assert.equal(linkUrls(`${wiki}.`), `${tab(wiki)}.`);
  assert.equal(linkUrls('https://a.io/?q[0]=1).'), `${tab('https://a.io/?q[0]=1')}).`);
  const query = 'https://x.io/a?b=1&amp;c=2';
  assert.equal(linkUrls(`${query} and &quot;${query}&quot;`), `${tab(query)} and &quot;${tab(query)}&quot;`);
  // A code span's placeholder (core.js inline()) is not part of the URL.
  assert.equal(linkUrls('http://a.io\u00000\u0000'), `${tab('http://a.io')}\u00000\u0000`);
  assert.equal(linkUrls('<img src="https://a.io/x.png">'), '<img src="https://a.io/x.png">');
});

test('bare URLs into this app switch view in place; previews and the API open a new tab', () => {
  const here = new URL('https://cara.apps.webplatformisbestplatform.net/#/p/2');
  assert.equal(linkUrls('go to https://cara.apps.webplatformisbestplatform.net/#/p/2/t/11.', here), 'go to <a href="#/p/2/t/11">https://cara.apps.webplatformisbestplatform.net/#/p/2/t/11</a>.');
  for (const url of ['https://cara.apps.webplatformisbestplatform.net/preview/183/', 'https://cara.apps.webplatformisbestplatform.net/preview/183/#/p/2/t/11', 'https://cara.apps.webplatformisbestplatform.net/api/x']) {
    assert.equal(linkUrls(url, here), tab(url), url);
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

// Delve (scheme 1) owns o/r, where minion #68 (id 162) opened PR #186.
const delveRepos = new Map([['o/r', { projectId: 1, scheme: 'Delve', repo: 'o/r', prs: { 186: { id: 162, number: 68, title: 'Laptop "scripts"' } } }]]);
const toOwner = (text) => `<a class="thread-ref" href="#/p/1/t/68" title="Delve #68 Laptop &quot;scripts&quot; (owns PR #186)">${text}</a>`;
const pending = (n, text = `#${n}`, p = 1) => `<span class="pr-ref" data-project="${p}" data-pr="${n}">${text}</span>`;

test('prNumberRoute finds a PR by its scheme\'s repo', () => {
  assert.deepEqual(prNumberRoute(delveRepos, 1, 186, 5), { hash: '#/p/1/t/68', title: 'Delve #68 Laptop "scripts" (owns PR #186)' });
  // #267: the minion on screen's own PR opens GitHub, as its URL does; one the repo doesn't have is false, not "unknown".
  assert.deepEqual(prNumberRoute(delveRepos, 1, 186, 162), { url: 'https://github.com/o/r/pull/186', title: 'o/r PR #186 on GitHub' }, 'the minion on screen');
  assert.equal(prNumberRoute(delveRepos, 1, 7, 5), null, 'not in the repo');
  assert.equal(prNumberRoute(delveRepos, 2, 186, 5), null, 'another scheme, with no repo');
  assert.equal(prNumberRoute(null, 1, 186, 5), null, 'not loaded yet');
});

test('"PR #N" links to the minion owning the PR in the scheme on screen', () => {
  const schemes = [{ id: 1, name: 'Delve' }, { id: 2, name: 'Citadel' }];
  // Minion #187 is known; PR #7 isn't in the repo, so it waits, plain, in a span for linkPrRefs.
  const lnk = (html, p = 1) => linkThreadRefs(html, p, (n) => (n === 187 ? 'Minion 187' : null), schemes, (projectId, n) => prNumberRoute(delveRepos, projectId, n, 5));
  const at = (p, n, text = `#${n}`) => `<a class="thread-ref" href="#/p/${p}/t/${n}">${text}</a>`;
  assert.equal(lnk('PR #186 shipped. #187 next'), `${toOwner('PR #186')} shipped. <a class="thread-ref" href="#/p/1/t/187" title="Minion 187">#187</a> next`);
  assert.equal(lnk('pull request #186.'), `${toOwner('pull request #186')}.`);
  assert.equal(lnk('Pull Requests #186'), toOwner('Pull Requests #186'));
  assert.equal(lnk('[PR 186]'), `[${toOwner('PR 186')}]`);
  // Each number of a list, the first with its words.
  assert.equal(lnk('PRs #186, #7 and #186'), `${toOwner('PRs #186')}, ${pending(7)} and ${toOwner('#186')}`);
  assert.equal(lnk('PRs #7 &amp; #186'), `${pending(7, 'PRs #7')} &amp; ${toOwner('#186')}`);
  // "PR 12" without a "#" is one number: "and 3 more" isn't a PR.
  assert.equal(lnk('PR 12 and 3 more'), `${pending(12, 'PR 12')} and 3 more`);
  // Issues stay plain; so do look-alikes.
  for (const s of ['issues #4 and #5', 'issue #186', 'Pulls 3', 'PR #186abc', 'PR 2026-10-28', 'PRESS 186', 'PR186', '<code>PR #186</code>', '<a href="x">PR #186</a>']) {
    assert.equal(lnk(s), s, s);
  }
  // In Citadel, "PR #186" is Citadel's PR, and "Delve PR #186" Delve's.
  assert.equal(lnk('PR #186', 2), pending(186, 'PR #186', 2));
  assert.equal(lnk('see Delve PR #186 and Delve #5', 2), `see ${toOwner('Delve PR #186')} and ${at(1, 5, 'Delve #5')}`);
  assert.equal(lnk('Delve&#39;s PR #186', 2), toOwner('Delve&#39;s PR #186'));
  assert.equal(lnk('delve PRs #7 and #186', 2), `${pending(7, 'delve PRs #7')} and ${toOwner('#186')}`);
  // Without a PR lookup, PR mentions stay plain text as before.
  assert.equal(linkThreadRefs('PR #186 and Delve PR #186', 2, () => null, schemes), 'PR #186 and Delve PR #186');
});

test('bare PR URLs go to their owner from the start, GitHub otherwise', () => {
  const route = (url) => prOwnerRoute(delveRepos, url.replace(/&amp;/g, '&'), 5);
  const owned = 'https://github.com/o/r/pull/186';
  assert.equal(linkUrls(`see ${owned}.`, null, route),
    `see <a href="#/p/1/t/68" title="Delve #68 Laptop &quot;scripts&quot; (owns PR #186)" data-pr-url="${owned}">${owned}</a>.`);
  for (const url of ['https://github.com/o/r/pull/7', `${owned}/files`, 'https://github.com/x/y/pull/186']) {
    assert.equal(linkUrls(url, null, route), tab(url), url);
  }
  assert.equal(linkUrls(owned, null, (url) => prOwnerRoute(delveRepos, url, 162)), tab(owned), 'its own PR opens GitHub');
});

test('jumpParts: a chat address asking to open at one event, or its latest reply (#236)', () => {
  assert.deepEqual(jumpParts('#/p/2/t/34?e=901'), { hash: '#/p/2/t/34', target: '901' });
  assert.deepEqual(jumpParts('#/p/2?e=latest'), { hash: '#/p/2', target: 'latest' }, 'the Taskmaster\'s chat');
  assert.deepEqual(jumpParts('#/t/7?e=3'), { hash: '#/t/7', target: '3' });
  for (const hash of ['#/p/2/t/34', '#/p/2/artifacts?e=1', '#/p/2/t/34?e=', '#/p/2/t/34?e=1x', '', undefined]) assert.equal(jumpParts(hash), null, String(hash));
});

// #267: Delve (scheme 1) has minions #5 and #68; its repo o/r has PRs #115, #146 (nobody's) and #186 (#68's) and issue #120.
const knownRepos = new Map([['o/r', { ...delveRepos.get('o/r'), pulls: [115, 146, 186], issues: [120] }]]);
const gh = (kind, n, text) => `<a href="https://github.com/o/r/${kind}/${n}" target="_blank" rel="noopener" title="o/r ${kind === 'pull' ? 'PR' : 'issue'} #${n} on GitHub">${text}</a>`;

test('a bare #N with no minion of that number links its repo\'s PR or issue, or stays plain', () => {
  const minions = new Map([[5, 'Five'], [68, 'Laptop']]);
  const lnk = (html, repos = knownRepos) => linkThreadRefs(html, 1, (n) => minions.get(n) ?? null, [], (p, n) => prNumberRoute(repos, p, n, 5));
  assert.equal(lnk('#5'), '<a class="thread-ref" href="#/p/1/t/5" title="Five">#5</a>', 'a minion stays a minion');
  assert.equal(lnk('#186'), toOwner('#186'), 'a PR a minion owns goes to it');
  assert.equal(lnk('#115.'), `${gh('pull', 115, '#115')}.`, 'a PR nobody owns goes to GitHub');
  assert.equal(lnk('#120'), gh('issue', 120, '#120'), 'an issue goes to GitHub');
  // Neither a minion nor (yet) in the repo: plain text, never a dead link, in a span linkPrRefs links if a fresher list has it.
  assert.equal(lnk('#999 and #7'), `${pending(999)} and ${pending(7)}`);
  assert.equal(lnk('#999', null), pending(999), 'PRs not loaded yet');
  assert.equal(lnk('#999', new Map()), pending(999), 'a scheme with no GitHub repo');
});

test('"PR #N" nobody owns links to GitHub, and so does the PR of the minion on screen', () => {
  assert.deepEqual(prNumberRoute(knownRepos, 1, 115, 5), { url: 'https://github.com/o/r/pull/115', title: 'o/r PR #115 on GitHub' });
  assert.deepEqual(prNumberRoute(knownRepos, 1, 186, 162), { url: 'https://github.com/o/r/pull/186', title: 'o/r PR #186 on GitHub' });
  assert.equal(prNumberRoute(knownRepos, 1, 999, 5), null, 'not in the repo');
  const lnk = (html) => linkThreadRefs(html, 1, () => null, [], (p, n) => prNumberRoute(knownRepos, p, n, 5));
  assert.equal(lnk('PR #115'), gh('pull', 115, 'PR #115'));
  assert.equal(lnk('PR #999'), pending(999, 'PR #999'));
});

test('"PRs (#115 and #146)" reads every number after "PRs" as a PR, not a minion', () => {
  const lnk = (html) => linkThreadRefs(html, 1, () => 'a minion', [], (p, n) => prNumberRoute(knownRepos, p, n, 5));
  assert.equal(lnk('The tech tree PRs (#115 and #146) and the walk fixes (PR #186)'),
    `The tech tree ${gh('pull', 115, 'PRs (#115')} and ${gh('pull', 146, '#146')}) and the walk fixes (${toOwner('PR #186')})`);
  assert.equal(lnk('PRs: #115, #146'), `${gh('pull', 115, 'PRs: #115')}, ${gh('pull', 146, '#146')}`);
});
