// #890: Chrome and Edge open an installed app with its title bar showing, and only the window's own ⌃ hides it (no
// manifest member or web API can; Chrome forgets it on a reinstall). So once, a note under the ⌃ says where it is. It
// goes for good when it's closed or the title bar is hidden.
import { h } from './base.js';

const KEY = 'cc-wco-hint';

// A phone or tablet's installed app is standalone too and Chrome there may expose the overlay, but it has no title bar
// to hide. userAgentData.mobile is the platform's own answer (Chromium, the only engine with the overlay, has it);
// (pointer: fine) is the fallback, since a touch-first device's main pointer is coarse.
const isDesktop = () => navigator.userAgentData ? navigator.userAgentData.mobile === false : matchMedia('(pointer: fine)').matches;

// wco: navigator.windowControlsOverlay. installed: a query for the app window, which an install from the address bar
// turns on without a reload, hence the change listener.
export function wcoHint(wco = navigator.windowControlsOverlay, installed = matchMedia('(display-mode: standalone)'), desktop = isDesktop) {
  if (!wco) return;
  let note = null;
  const done = () => {
    note?.remove();
    note = null;
    try { localStorage.setItem(KEY, '1'); } catch {}
  };
  const show = () => {
    try { if (localStorage.getItem(KEY)) return; } catch {}
    if (note || wco.visible || !installed.matches || !desktop()) return;
    note = h('div', { class: 'cui-notice wco-hint', 'data-tone': 'info', role: 'status' },
      h('span', {}, 'Hide the title bar with the ', h('b', {}, '⌃'), ' up here'),
      h('button', { type: 'button', class: 'cui-btn cui-ghost', 'aria-label': 'Close', title: 'Close', onclick: done }, '✕'));
    document.body.append(note);
  };
  // Seen hidden, now or later, means they've found the ⌃: no note then, or when they show the title bar again.
  if (wco.visible) return done();
  wco.addEventListener('geometrychange', () => { if (wco.visible) done(); });
  installed.addEventListener('change', show);
  show();
}
