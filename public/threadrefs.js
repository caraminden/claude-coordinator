// "#12" in any text the UI shows becomes a link to thread 12 of the current project.
// Pure string work, so it can be tested without a browser.

/** A GitHub-style "PR #12" / "issues #4, #5 and #6": every number in it means something else. */
const PR_LIST = String.raw`\b(?:PRs?|[Ii]ssues?|[Pp]ull [Rr]equests?|[Pp]ulls?)\s#\d{1,6}(?:(?:\s*(?:,|\/|&amp;)\s*|,?\s+(?:and|or)\s+)#\d{1,6})*`;
/** A standalone #N: not part of a word, URL, path, HTML entity (&#39;) or another #. */
const REF = String.raw`(?<![\w&/#.:?=+-])#(?<n>\d{1,6})(?![\w#/-])`;

/** Scheme names as the HTML has them, compared without case or spacing: "delve two" -> id. */
const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
/** A regex matching `name` in any case, with any run of spaces where it has one. */
const namePattern = (name) => [...name].map((c) => {
  if (/\s/.test(c)) return String.raw`\s+`;
  const [lo, up] = [c.toLowerCase(), c.toUpperCase()];
  return lo !== up && lo.length === 1 && up.length === 1 ? `[${lo}${up}]` : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}).join('');

/** Where thread `number` of project `projectId` lives (see threadHref in app.js). */
export const threadNumberHref = (projectId, number) => `#/p/${projectId}/t/${number}`;

/**
 * Link #N references in a string of HTML. Only text between tags is touched, and nothing inside
 * an existing <a>, <code> or <pre>, so links, code and attributes are left alone. `titleOf(n)` may
 * give a hover title for a thread it knows; numbers it doesn't know still link, and opening one
 * that doesn't exist shows the usual "There is no thread #N" message. With `schemes` (the
 * projects list, { id, name }), "Delve #68" links to Delve's #68 instead.
 */
export function linkThreadRefs(html, projectId, titleOf = () => null, schemes = []) {
  if (projectId == null || !html.includes('#')) return html;
  const ids = new Map(schemes.filter((p) => p.name?.trim()).map((p) => [nameKey(escapeAttr(p.name)), p.id]));
  // Longest first, so "Delve Two #3" isn't read as "Delve" + "Two #3".
  const names = [...ids.keys()].sort((x, y) => y.length - x.length).map(namePattern);
  const scheme = names.length ? String.raw`(?<![\p{L}\p{N}_])(?<name>${names.join('|')})\s+#(?<sn>\d{1,6})(?![\w#/-])|` : '';
  const refs = new RegExp(`(?<pr>${PR_LIST})|${scheme}${REF}`, 'gu');
  return html.replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => {
    if (tag) return all;
    return text.replace(refs, (ref, ...args) => {
      const { pr, name, sn, n } = args.at(-1);
      if (pr) return ref;
      const p = name ? ids.get(nameKey(name)) : projectId;
      const title = p === projectId ? titleOf(Number(sn ?? n)) : null;
      return `<a class="thread-ref" href="${threadNumberHref(p, Number(sn ?? n))}"${title ? ` title="${escapeAttr(title)}"` : ''}>${ref}</a>`;
    });
  });
}

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The in-app route ("#/p/2/t/11") a link points at, if it stays in this app: a bare "#/…" route,
 * or an absolute URL on this page (same origin and path) whose hash is a route. Null otherwise,
 * so links elsewhere keep opening in a new tab.
 */
export function inAppHash(href, here) {
  if (/^#\//.test(href)) return href;
  let url;
  try { url = new URL(href, here.href); } catch { return null; }
  if (url.origin !== here.origin || url.pathname !== here.pathname || url.search !== here.search) return null;
  return /^#\/./.test(url.hash) || url.hash === '#/' ? url.hash : null;
}

/** A GitHub pull request's own page ("https://github.com/o/r/pull/12"), as { repo: "o/r", number }. */
export function prUrlParts(href) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/i.exec(href ?? '');
  return m ? { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) } : null;
}

/** A bare http(s) URL in escaped HTML text: it ends at a space, a tag, a quote or a code-span marker. */
const BARE_URL = /(?<![\w/])https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<>"'\u0000])+/gi;

/** A URL without the punctuation that ends the sentence around it; a ")" or "]" stays when it closes one in the URL. */
function trimUrl(url) {
  const opens = { ')': url.split('(').length, ']': url.split('[').length };
  const closes = { ')': url.split(')').length, ']': url.split(']').length };
  let end = url.length;
  for (;;) {
    const c = url[end - 1];
    if (/[.,:;!?]/.test(c)) end--;
    else if (closes[c] > opens[c]) { closes[c]--; end--; }
    else return url.slice(0, end);
  }
}

/**
 * Make bare http(s) URLs in some HTML links, leaving tags, links and code alone (as linkThreadRefs
 * does). A URL into this app (see inAppHash, against `here`) switches view in place; others open a
 * new tab, and a PR's is pointed at the minion owning it when hovered or clicked (prOwnerRoute).
 */
export function linkUrls(html, here = null) {
  if (!/https?:\/\//i.test(html)) return html;
  return html.replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => tag ? all
    : text.replace(BARE_URL, (match) => {
      const url = trimUrl(match);
      if (/^https?:\/\/$/i.test(url)) return match;
      const route = here && inAppHash(url.replace(/&amp;/g, '&'), here);
      const open = route ? `<a href="${escapeAttr(route)}">` : `<a href="${url}" target="_blank" rel="noopener">`;
      return `${open}${url}</a>${match.slice(url.length)}`;
    }));
}

/**
 * Where a link to a PR should go instead: the minion that owns it, from `repos` (GET api/prs as a
 * Map by repo). Null for other links, PRs no minion owns, and the PR of the minion on screen (`hereId`).
 */
export function prOwnerRoute(repos, href, hereId = null) {
  const pr = prUrlParts(href);
  const repo = pr && repos?.get(pr.repo);
  const owner = repo?.prs[pr.number];
  if (!owner || owner.id === hereId) return null;
  return { hash: threadNumberHref(repo.projectId, owner.number), title: `${repo.scheme} #${owner.number} ${owner.title} (owns PR #${pr.number})` };
}
