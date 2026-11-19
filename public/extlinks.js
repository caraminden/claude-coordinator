// "Open links in Firefox" (#988): an installed Chrome or Edge app opens every external link in Chrome, even when
// Firefox is the default browser. With the switch on, an external web link is handed to Windows as
// citadel-firefox:<address> instead; public/citadel-firefox-link.ps1 (run once on the PC) registers that
// scheme, and its program opens the address in Firefox. (Firefox's own firefox-bridge: scheme went away in 126.)
//
// The switch lives on the device (localStorage), off until someone turns it on, and is offered on Windows desktops only.
// Citadel's own pages use mountLinkHandler directly. A framed contraption's click can't be seen from here, so rail.js
// (every app loads it) catches its external links when Citadel's state message says the switch is on, and posts the
// address up; rail.js launches it through launchFirefox, which checks the address again.

export const SCHEME = 'citadel-firefox:';
const KEY = 'citadel-open-in-firefox';

/**
 * `citadel-firefox:<address>` for an external http(s) link, else null: not a web link, a link carrying a login
 * (user:pw@), or one to a host in `own` (Citadel's host and its contraptions' hosts, lower case), which stay as they are.
 * `href` resolves against `base`, so a relative link is Citadel's own.
 */
export function firefoxLink(href, base, own = []) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (own.some((h) => h.toLowerCase() === url.hostname)) return null;
  return SCHEME + url.href;
}

const NAME = /^\/apps\/([a-z0-9][a-z0-9-]{0,31})(?=\/|$)/;

/**
 * `{ name, to }` for a link to one of our apps, else null: `to` is the path (with query and hash) the app view loads,
 * always `/apps/<name>/…` on Citadel's own host. A link counts by `/apps/<name>/…` on a host in `own` (Citadel's), or by
 * the app's own host in `apps` (host -> name, lower case), where `/` is the app's front page. Anything else (a path
 * outside the app, credentials, `_citadel`) is not an app link and falls through to the Firefox rule.
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

/** Whether this browser can use the switch: a Windows desktop (the one-time setup is a Windows script). */
export function firefoxAvailable(nav = typeof navigator === 'object' ? navigator : {}) {
  const data = nav.userAgentData;
  if (data) return data.platform === 'Windows' && !data.mobile;
  return /\bWindows NT\b/.test(nav.userAgent ?? '');
}

/** This device's switch. */
export const firefoxOn = () => {
  try { return firefoxAvailable() && localStorage.getItem(KEY) === '1'; } catch { return false; }
};
export function setFirefoxOn(on) {
  try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch {}
  for (const f of listeners) f(on);
}
const listeners = new Set();
/** Hear about the switch changing (a frame's page needs telling). */
export const onFirefoxChange = (fn) => void listeners.add(fn);

/**
 * Hand `address` (an http(s) address) to Windows as a citadel-firefox: link, through a hidden frame that is removed
 * a few seconds later: a page navigating itself would run its own beforeunload guard ("Leave app?"), a frame's
 * navigation doesn't. Returns false for anything that isn't a web address.
 */
export function launchFirefox(address) {
  const link = firefoxLink(address, 'https://invalid.example/', []);
  if (!link) return false;
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = link;
  document.body.append(frame);
  setTimeout(() => frame.remove(), 5000);
  return true;
}

/**
 * What a click on `href` (at `base`) should do, the one rule every handler uses. `ctx`: `own` Citadel's hosts, `apps`
 * app host -> name, `domain` the apps domain (APPS_DOMAIN: every host on it is Citadel's), `self` the app this page is (null on Citadel's own pages), `firefox` the switch. Answers
 *   { kind: 'app', app: { name, to } }  Citadel's app view (a registered app, by its host or /apps/<name>/…)
 *   { kind: 'firefox', address }        Firefox (outside the above, or an app path the view can't show, switch on)
 *   { kind: 'page' }                    nothing to do: not a web link, or the page's own (same origin, same app)
 *   { kind: 'window' }                  Citadel's, but not an app's or this page's: this window goes there, never a new tab
 *   { kind: 'browser' }                 outside, switch off: the browser's default
 * Order: another app's link first (even same-origin: Citadel's host serves every app's /apps/<y>/), then same origin
 * stays with the page, then Citadel's own hosts and anything on the apps domain, then outside. Never edit `own` or `apps` to steer one case.
 */
export function classifyLink(href, base, { own = [], apps = {}, domain = null, self = null, firefox = false } = {}) {
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
  return firefox ? { kind: 'firefox', address: url.href } : { kind: 'browser' };
}

/**
 * Catch clicks (and middle clicks) on external links before anything else sees them. `on()` says whether the switch is
 * on, `own()` lists Citadel's own hosts, `apps()` maps each app's own host to its name, `domain()` the apps domain, `openWindow(address)` goes there in this window, `openApp({ name, to }, address)` shows an app, `open(address)` takes the address. A modifier key, a
 * `download` link or a click something already handled is left to the browser.
 */
export function mountLinkHandler({ on, own, open, apps = () => ({}), domain = () => null, self = () => null, openApp, openWindow, base = () => location.href }) {
  const handle = (e) => {
    if (e.defaultPrevented || (e.type === 'click' ? e.button !== 0 : e.button !== 1)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.('a[href]');
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    const c = classifyLink(href, base(), { own: own(), apps: apps(), domain: domain(), self: self(), firefox: on() });
    // A click shows an app in the app view; a middle click can't, so it's the browser's.
    if (c.kind === 'app' && e.type === 'click' && openApp) {
      e.preventDefault();
      e.stopPropagation();
      return openApp(c.app, new URL(href, base()).href);
    }
    // Citadel's own: a plain link already goes there in this window; one meant for a new tab comes here instead.
    if (c.kind === 'window' && e.type === 'click' && openWindow && a.target && a.target !== '_self') {
      e.preventDefault();
      e.stopPropagation();
      return openWindow(new URL(href, base()).href);
    }
    const address = c.kind === 'firefox' ? c.address : null; // a middle click on Citadel's own address stays with the browser
    if (!address) return;
    e.preventDefault();
    e.stopPropagation();
    open(address);
  };
  addEventListener('click', handle, true);
  addEventListener('auxclick', handle, true);
}
// Another tab of Citadel flipping the switch.
globalThis.addEventListener?.('storage', (e) => { if (e.key === KEY) for (const f of listeners) f(firefoxOn()); });
