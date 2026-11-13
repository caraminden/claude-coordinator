// Front end: hash-routed views over the JSON API, live via SSE. This entry starts the app;
// each view lives in its own module (see base.js for what they share, core.js for the shell).
import { api, h, tintTitleBar, view } from './base.js';
import { app, reloadNow, renderInvite, renderUsage, start, usage } from './core.js';
import { renderSidebar } from './sidebar.js';
import { initDrawers } from './drawers.js';
import { mountDialogs } from './ui/dialog.js';

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
  api('api/me').then(start).catch((err) => {
    if (err.message === 'Not logged in') return;
    app.replaceChildren(h('p', { class: 'error' }, `Couldn't open Citadel: ${err.message}`), h('button', { type: 'button', onclick: boot }, 'Try again'));
  });
}
// The service worker makes the app installable (home screen, full screen) and shows push notifications; it caches nothing.
// Absolute on purpose: a preview (/preview/N/) shares the live app's one worker instead of registering its own.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Only in the installed app, so browser tabs look and behave as before: colour the title/status bar
// like the top bar, and on Android shrink the page when the keyboard opens so the composer stays in view.
// With the title bar folded into the page (#637), the window controls take the page's colour; the first match wins.
if (matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches) {
  const viewport = document.querySelector('meta[name=viewport]');
  viewport.content += ', interactive-widget=resizes-content';
  for (const [scheme, color] of [['light', '#f6f5f2'], ['dark', '#161514']]) {
    document.head.append(h('meta', { name: 'theme-color', content: color, media: `(display-mode: window-controls-overlay) and (prefers-color-scheme: ${scheme})` }));
  }
  for (const [scheme, color] of [['light', '#ffffff'], ['dark', '#201f1d']]) {
    document.head.append(h('meta', { name: 'theme-color', content: color, media: `(prefers-color-scheme: ${scheme})` }));
  }
  // A Taskmaster chat tints the window controls (core.js route); a light/dark switch re-reads its tint.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => tintTitleBar(document.querySelector('.split .chat.role-taskmaster')));
}
