// "#12" in any text the UI shows becomes a link to thread 12 of the current project.
// Pure string work, so it can be tested without a browser.

/**
 * A standalone #N: not part of a word, URL, path, HTML entity (&#39;) or another #, and not a
 * GitHub-style "PR #12" / "issue #12", which mean something else.
 */
const THREAD_REF = /(?<![\w&/#.:?=+-])(?<!\b(?:PRs?|[Ii]ssues?|[Pp]ull [Rr]equests?|[Pp]ulls?)\s)#(\d{1,6})(?![\w#/-])/g;

/** Where thread `number` of project `projectId` lives (see threadHref in app.js). */
export const threadNumberHref = (projectId, number) => `#/p/${projectId}/t/${number}`;

/**
 * Link #N references in a string of HTML. Only text between tags is touched, and nothing inside
 * an existing <a>, <code> or <pre>, so links, code and attributes are left alone. `titleOf(n)` may
 * give a hover title for a thread it knows; numbers it doesn't know still link, and opening one
 * that doesn't exist shows the usual "There is no thread #N" message.
 */
export function linkThreadRefs(html, projectId, titleOf = () => null) {
  if (projectId == null || !html.includes('#')) return html;
  return html.replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => {
    if (tag) return all;
    return text.replace(THREAD_REF, (ref, n) => {
      const title = titleOf(Number(n));
      return `<a class="thread-ref" href="${threadNumberHref(projectId, Number(n))}"${title ? ` title="${escapeAttr(title)}"` : ''}>${ref}</a>`;
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

/** Make bare PR URLs in some HTML links, leaving tags, links and code alone (as linkThreadRefs does). */
export function linkPrUrls(html) {
  if (!html.includes('github.com/')) return html;
  return html.replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => tag ? all
    : text.replace(/(?<![\w/])https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?![\w/#?-])/gi, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
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
