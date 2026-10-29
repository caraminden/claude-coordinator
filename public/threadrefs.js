// "#12" in any text the UI shows becomes a link to thread 12 of the current project.
// Pure string work, so it can be tested without a browser.

/** Between the numbers of a list: "#1, #2 and #3", "#1/#2", "#1 &amp; #2". */
const LIST_SEP = String.raw`(?:\s*(?:,|\/|&amp;)\s*|,?\s+(?:and|or)\s+)`;
/**
 * A pull request mention: "PR #12", "PRs #1, #2 and #3", "pull request #9", or "PR 173" without the
 * "#" (one number only, so "PR 12 and 3 more" doesn't take the 3). Each number is a PR, not a minion.
 */
const PR_LIST = String.raw`\b(?:(?:PRs?|[Pp]ull [Rr]equests?|[Pp]ulls?)\s#\d{1,6}(?:${LIST_SEP}#\d{1,6})*|(?:PR|[Pp]ull [Rr]equest)\s\d{1,6})(?![\w#/-])`;
/** "issue #4" / "issues #4, #5 and #6": GitHub issues, which nothing here owns, so they stay plain. */
const ISSUE_LIST = String.raw`\b[Ii]ssues?\s#\d{1,6}(?:${LIST_SEP}#\d{1,6})*`;
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

/** "minion #5" or "minions #5 and #6". */
const MINION_LIST = String.raw`(?:[Mm]inions\s+#\d{1,6}(?:${LIST_SEP}#\d{1,6})*|[Mm]inion\s+#\d{1,6})(?![\w#/-])`;
/** What may follow a scheme's name to name its minions: MINION_LIST or a bare "#5". */
const SCHEME_MINIONS = String.raw`(?:${MINION_LIST}|#\d{1,6}(?![\w#/-]))`;
/** A possessive "'s", straight (escaped or not) or curly. */
const POSSESSIVE = String.raw`(?:&#39;|'|\u2019)s`;

/**
 * Link #N references in a string of HTML. Only text between tags is touched, and nothing inside
 * an existing <a>, <code> or <pre>, so links, code and attributes are left alone. `titleOf(n)` may
 * give a hover title for a thread it knows; numbers it doesn't know still link, and opening one
 * that doesn't exist shows the usual "There is no thread #N" message. With `schemes` (the
 * projects list, { id, name }), a scheme's name scopes the numbers it names to that scheme: "Delve #68",
 * "Delve's minion #68", "Delve minions #5 and #6", "minion #5 in Delve".
 *
 * With `prRoute(projectId, n)` (see prNumberRoute), "PR #186" and "Delve's PR #186" link to the minion
 * owning that PR. One it can't place yet becomes a `span.pr-ref` carrying the scheme and number, for
 * linkPrRefs to link once the PR list arrives; without `prRoute` PR mentions stay plain text.
 */
export function linkThreadRefs(html, projectId, titleOf = () => null, schemes = [], prRoute = null) {
  if (projectId == null || !(html.includes('#') || (prRoute && /\b(?:PR|[Pp]ull [Rr]equest)\s\d/.test(html)))) return html;
  const ids = new Map(schemes.filter((p) => p.name?.trim()).map((p) => [nameKey(escapeAttr(p.name)), p.id]));
  // Longest first, so "Delve Two #3" isn't read as "Delve" + "Two #3".
  const names = [...ids.keys()].sort((x, y) => y.length - x.length).map(namePattern).join('|');
  const scheme = names
    ? String.raw`(?<![\p{L}\p{N}_])(?<name>${names})(?:${POSSESSIVE})?\s+(?:(?<spr>${PR_LIST})|(?<sm>${SCHEME_MINIONS}))|`
      + String.raw`(?<tm>${MINION_LIST})\s+in\s+(?<tname>${names})(?![\p{L}\p{N}_])|`
    : '';
  const refs = new RegExp(`(?<issue>${ISSUE_LIST})|(?<pr>${PR_LIST})|${scheme}${REF}`, 'gu');
  const threadLink = (p) => (number, text) => {
    const title = p === projectId ? titleOf(number) : null;
    return `<a class="thread-ref" href="${threadNumberHref(p, number)}"${title ? ` title="${escapeAttr(title)}"` : ''}>${text}</a>`;
  };
  const prLink = (p) => (number, text) => prRefHtml(p, number, text, prRoute(p, number));
  return html.replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => {
    if (tag) return all;
    return text.replace(refs, (ref, ...args) => {
      const { issue, pr, name, spr, sm, tm, tname, n } = args.at(-1);
      if (issue) return ref;
      const p = name || tname ? ids.get(nameKey(name ?? tname)) : projectId;
      if (pr || spr) return prRoute ? linkList(pr ?? spr, ref.slice(0, ref.length - (pr ?? spr).length), prLink(p)) : ref;
      if (sm) return linkList(sm, ref.slice(0, ref.length - sm.length), threadLink(p));
      if (tm) return linkList(tm, '', threadLink(p)) + ref.slice(tm.length);
      return threadLink(p)(Number(n), ref);
    });
  });
}

/** Each number of a list linked by `link(number, text)`: the first with its words ("Delve PR #186"), the rest alone ("#187"). */
const linkList = (list, lead, link) => list.replace(/^\D*\d{1,6}|#\d{1,6}/g, (m, at) => link(Number(/\d+$/.exec(m)[0]), at ? m : lead + m));

/** A PR mention as a link to its owner (`to`, from prNumberRoute), or a span linkPrRefs can link later. */
const prRefHtml = (projectId, number, text, to) => to
  ? `<a class="thread-ref" href="${escapeAttr(to.hash)}" title="${escapeAttr(to.title)}">${text}</a>`
  : `<span class="pr-ref" data-project="${projectId}" data-pr="${number}">${text}</span>`;

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
 * does). A URL into this app (see inAppHash, against `here`) switches view in place; a PR's goes to
 * the minion owning it when `prRoute(url)` (see prOwnerRoute) knows one; others open a new tab.
 */
export function linkUrls(html, here = null, prRoute = null) {
  if (!/https?:\/\//i.test(html)) return html;
  return html.replace(/(<(a|code|pre)\b[\s\S]*?<\/\2>|<[^>]*>)|([^<]+)/gi, (all, tag, _name, text) => tag ? all
    : text.replace(BARE_URL, (match) => {
      const url = trimUrl(match);
      if (/^https?:\/\/$/i.test(url)) return match;
      const route = here && inAppHash(url.replace(/&amp;/g, '&'), here);
      const open = route ? `<a href="${escapeAttr(route)}">` : prLinkOpen(url, prRoute?.(url)) ?? `<a href="${url}" target="_blank" rel="noopener">`;
      return `${open}${url}</a>${match.slice(url.length)}`;
    }));
}

/**
 * The opening tag of a link to GitHub PR `url` (escaped HTML) that goes to its owner `to` (from
 * prOwnerRoute) instead, keeping the GitHub address for copying; null when there's no owner.
 */
export function prLinkOpen(url, to) {
  return to ? `<a href="${escapeAttr(to.hash)}" title="${escapeAttr(to.title)}" data-pr-url="${url}">` : null;
}

/** Where PR `number` of `repo` (one entry of GET api/prs) should go: its owner, unless that's the minion on screen. */
function ownerRoute(repo, number, hereId) {
  const owner = repo?.prs[number];
  if (!owner || owner.id === hereId) return null;
  return { hash: threadNumberHref(repo.projectId, owner.number), title: `${repo.scheme} #${owner.number} ${owner.title} (owns PR #${number})` };
}

/**
 * Where a link to a PR should go instead: the minion that owns it, from `repos` (GET api/prs as a
 * Map by repo). Null for other links, PRs no minion owns, and the PR of the minion on screen (`hereId`).
 */
export function prOwnerRoute(repos, href, hereId = null) {
  const pr = prUrlParts(href);
  return pr ? ownerRoute(repos?.get(pr.repo), pr.number, hereId) : null;
}

/** As prOwnerRoute, for "PR #`number`" said in scheme `projectId`: its repo's PR of that number. `repos` is any list of api/prs entries. */
export function prNumberRoute(repos, projectId, number, hereId = null) {
  for (const repo of repos?.values() ?? []) if (repo.projectId === projectId) return ownerRoute(repo, number, hereId);
  return null;
}
