// Links out of Citadel's pages. Decides what a click
// on a link does: an app's link opens in Citadel's app view, Citadel's own address goes to this window, anything else
// is left to the browser. Citadel's own pages use mountLinkHandler directly; a framed contraption's rail.js does too,
// with the lists Citadel's state message carries.

const NAME = /^\/apps\/([a-z0-9][a-z0-9-]{0,31})(?=\/|$)/;

/**
 * `{ name, to }` for a link to one of our apps, else null: `to` is the path (with query and hash) the app view loads,
 * always `/apps/<name>/…` on Citadel's own host. A link counts by `/apps/<name>/…` on a host in `own` (Citadel's), or by
 * the app's own host in `apps` (host -> name, lower case), where `/` is the app's front page. Anything else (a path
 * outside the app, credentials, `_citadel`) is not an app link.
 */
export function appLink(href, base, own = [], apps = {}) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  const tail = url.pathname + url.search + url.hash;
  const appName = Object.hasOwn(apps, url.hostname) ? apps[url.hostname] : null;
  if (appName) {
    const to = url.pathname === '/' ? `/apps/${appName}/${url.search}${url.hash}` : tail;
    return NAME.exec(to)?.[1] === appName ? { name: appName, to } : null;
  }
  if (!own.some((h) => h.toLowerCase() === url.hostname)) return null;
  const name = NAME.exec(url.pathname)?.[1];
  return name ? { name, to: tail } : null;
}

/** The hash route that opens `{ name, to }` in the app view (core.js route). */
export const appHash = ({ name, to }) => `#/apps/${name}?to=${encodeURIComponent(to)}`;

/** The address the app view loads for `to` inside app `name`, or null unless it resolves to that app on `origin`. */
export function appSrc(name, to, origin) {
  let url;
  try {
    url = new URL(to, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || NAME.exec(url.pathname)?.[1] !== name) return null;
  return url.pathname + url.search + url.hash;
}


/**
 * What a click on `href` (at `base`) should do, the one rule every handler uses. `ctx`: `own` Citadel's hosts, `apps`
 * app host -> name, `domain` the apps domain (APPS_DOMAIN: every host on it is Citadel's), `self` the app this page is (null on Citadel's own pages). Answers
 *   { kind: 'app', app: { name, to } }  Citadel's app view (a registered app, by its host or /apps/<name>/…)
 *   { kind: 'page' }                    nothing to do: not a web link, or the page's own (same origin, same app)
 *   { kind: 'window' }                  Citadel's, but not an app's or this page's: this window goes there, never a new tab
 *   { kind: 'browser' }                 outside: the browser's default
 * Order: another app's link first (even same-origin: Citadel's host serves every app's /apps/<y>/), then same origin
 * stays with the page, then Citadel's own hosts and anything on the apps domain, then outside. Never edit `own` or `apps` to steer one case.
 */
export function classifyLink(href, base, { own = [], apps = {}, domain = null, self = null } = {}) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return { kind: 'page' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return { kind: 'page' };
  const app = appLink(url.href, base, own, apps);
  if (app && app.name !== self) return { kind: 'app', app };
  if (url.origin === new URL(base).origin) return { kind: 'page' };
  const d = domain?.toLowerCase();
  if (own.some((h) => h.toLowerCase() === url.hostname) || (d && (url.hostname === d || url.hostname.endsWith(`.${d}`)))) return { kind: 'window' };
  return { kind: 'browser' };
}

/**
 * Catch clicks (and middle clicks) on links before anything else sees them. `own()` lists Citadel's own hosts, `apps()`
 * maps each app's own host to its name, `domain()` the apps domain, `openWindow(address)` goes there in this window,
 * `openApp({ name, to }, address)` shows an app. A modifier key, a `download` link, or a click something already
 * handled is left to the browser.
 */
export function mountLinkHandler({ own, apps = () => ({}), domain = () => null, self = () => null, openApp, openWindow, base = () => location.href }) {
  const handle = (e) => {
    if (e.defaultPrevented || (e.type === 'click' ? e.button !== 0 : e.button !== 1)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.('a[href]');
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    const c = classifyLink(href, base(), { own: own(), apps: apps(), domain: domain(), self: self() });
    // A click or middle click on an app's link shows it in the app view: a new tab of Citadel's own address would be the browser's.
    if (c.kind === 'app' && openApp) {
      e.preventDefault();
      e.stopPropagation();
      return openApp(c.app, new URL(href, base()).href);
    }
    // Citadel's own: a plain link already goes there in this window; one meant for a new tab (target, or a middle click) comes here instead.
    if (c.kind === 'window' && openWindow && (e.type === 'auxclick' || (a.target && a.target !== '_self'))) {
      e.preventDefault();
      e.stopPropagation();
      openWindow(new URL(href, base()).href);
    }
  };
  addEventListener('click', handle, true);
  addEventListener('auxclick', handle, true);
}
