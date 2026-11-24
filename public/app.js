// Front end: hash-routed views over the JSON API, live via SSE. This entry starts the app;
// each view lives in its own module (see base.js for what they share, core.js for the shell).
import { api, forgetKept, reloadQuietly, h, keptChat, view } from './base.js';
import { app, goLive, reloadNow, renderInvite, renderUsage, start, startKept, usage } from './core.js';
import { renderSidebar } from './sidebar.js';
import { initDrawers } from './drawers.js';
import { mountDialogs } from './ui/dialog.js';
import { wcoHint } from './wco-hint.js';
import './context-menu.js'; // Citadel's right-click menu (#1663)

// ---------- boot ----------

// Sticky elements sit just below the top bar, whose height changes with wrapping and safe areas.
// On wider screens it is a rail down the left edge instead, and nothing needs to clear it.
const topbar = document.querySelector('.topbar');
// Use the exact height: at fractional display scaling (e.g. 175%) a rounded one leaves a sliver
// where scrolled chat text shows through.
new ResizeObserver(() => {
  const r = topbar.getBoundingClientRect();
  document.documentElement.style.setProperty('--topbar-h', `${r.width > r.height ? r.height : 0}px`);
}).observe(topbar);
// A click on a dialog's backdrop closes it (the kit's cui-dialog).
mountDialogs();
// Phones: edge swipes pull out the overview (left) and threads (right) panels as drawers. Views redraw
// the panels, so they're found afresh each time; the chat (the split's last child) is held still.
initDrawers({
  left: { el: () => document.querySelector('#app .panels > .shelf'), label: 'Overview' },
  right: { el: () => document.querySelector('#app .panels > .sidebar'), label: 'Minions' },
  main: () => [document.querySelector('#app .split > :not(.panels)'), topbar],
});
// Phones: a refresh button at the top of the screen, since an installed app has no browser reload.
// It lives in the top bar and, on pages that hide the top bar, in the first thread bar: just before
// ‹ › × where it has them, else after the title. Thread bars are rebuilt often, so it is put back after each change.
document.querySelector('.topbar .refresh-btn').addEventListener('click', reloadNow);
new MutationObserver(() => {
  const row = app.querySelector('.ticket-head > .row');
  const head = row?.parentElement;
  if (!row || head.querySelector('.refresh-btn')) return;
  const btn = h('button', { type: 'button', class: 'refresh-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: reloadNow }, '↻');
  const nav = head.querySelector('.head-nav');
  if (nav) nav.prepend(btn);
  else row.insertBefore(btn, row.querySelector(':scope > h2')?.nextSibling ?? row.firstChild);
}).observe(app, { childList: true, subtree: true });
// Keep relative times honest: the usage readout, and the minions list's waits and usage-reset countdowns.
setInterval(() => {
  if (usage) renderUsage();
  if (view?.kind === 'project') renderSidebar();
}, 30_000);

const invite = location.hash.match(/^#\/invite\/([\w-]+)$/);
if (invite) renderInvite(invite[1]);
else boot();

// A sign-in check that fails for any reason but "Not logged in" (which shows the login) used to leave
// a blank page with only the refresh button: say so, with a retry.
function boot() {
  // The installed app opens on the last chat kept on this device (#1144), at once, while the live answers come;
  // a launch that names somewhere else, or nothing kept, waits for them as before.
  const kept = keptChat(location.hash);
  const live = api('api/me');
  if (!kept) {
    return live.then(start).catch((err) => {
      if (err.message === 'Not logged in') return;
      app.replaceChildren(h('p', { class: 'error' }, `Couldn't open Citadel: ${err.message}`), h('button', { type: 'button', onclick: boot }, 'Try again'));
    });
  }
  if (location.hash !== kept.hash) history.replaceState(null, '', kept.hash); // no hashchange: startKept routes
  startKept(kept).then(() => catchUp(live, kept.login));
}

/** Swap the kept chat for the live one once the server answers; offline, try again when the device is back online. */
function catchUp(live, login) {
  live
    .then((who) => {
      // Someone else signed in on this device since: start afresh, with nothing of theirs kept.
      if (who.login !== login) {
        forgetKept();
        return reloadQuietly();
      }
      return goLive(who);
    })
    .catch((err) => {
      if (err.message === 'Not logged in') return; // the login shows, and the kept chat is forgotten
      const again = () => {
        removeEventListener('online', again);
        clearTimeout(timer);
        catchUp(api('api/me'), login);
      };
      addEventListener('online', again);
      const timer = setTimeout(again, 15_000);
    });
}
// The service worker makes the app installable (home screen, full screen), shows push notifications and keeps the app's own
// files for opening with no network (src/shell.ts).
// Absolute on purpose: a preview (/preview/N/) shares the live app's one worker instead of registering its own.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Only in the installed app, so browser tabs behave as before: on Android shrink the page when the keyboard opens so
// the composer stays in view. The title bar's colour is index.html's theme-color metas.
if (matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches) {
  const viewport = document.querySelector('meta[name=viewport]');
  viewport.content += ', interactive-widget=resizes-content';
}
// Once, in the installed app with its title bar showing: where the ⌃ that hides it is.
wcoHint();
