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
 * Catch clicks (and middle clicks) on external links before anything else sees them. `on()` says whether the switch is
 * on, `own()` lists the hosts that count as Citadel's own, `open(address)` takes the address. A modifier key, a
 * `download` link or a click something already handled is left to the browser.
 */
export function mountLinkHandler({ on, own, open, base = () => location.href }) {
  const handle = (e) => {
    if (e.defaultPrevented || (e.type === 'click' ? e.button !== 0 : e.button !== 1)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !on()) return;
    const a = e.target?.closest?.('a[href]');
    if (!a || a.hasAttribute('download')) return;
    const link = firefoxLink(a.getAttribute('href'), base(), own());
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    open(link.slice(SCHEME.length));
  };
  addEventListener('click', handle, true);
  addEventListener('auxclick', handle, true);
}
// Another tab of Citadel flipping the switch.
addEventListener('storage', (e) => { if (e.key === KEY) for (const f of listeners) f(firefoxOn()); });
