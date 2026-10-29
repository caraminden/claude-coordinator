// Front end: hash-routed views over the JSON API, live via SSE. This entry starts the app;
// each view lives in its own module (see core.js for what they share).
import { api, app, h, reloadNow, renderUsage, start, usage, view } from './core.js';
import { renderSidebar } from './sidebar.js';
import { initDrawers } from './drawers.js';

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
// Phones: edge swipes pull out the overview (left) and threads (right) panels as drawers.
initDrawers();
// Phones: a refresh button at the top of the screen, since an installed app has no browser reload.
// It lives in the top bar and, on pages that hide the top bar, at the right end of the first thread
// bar's title line. Thread bars are rebuilt often, so it is put back after each change.
document.querySelector('.topbar .refresh-btn').addEventListener('click', reloadNow);
new MutationObserver(() => {
  const row = app.querySelector('.ticket-head > .row');
  if (!row || row.querySelector(':scope > .refresh-btn')) return;
  const btn = h('button', { type: 'button', class: 'refresh-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: reloadNow }, '↻');
  // After the title's ✎ (a minion with no person note yet), which shares the title's line too.
  row.insertBefore(btn, (row.querySelector(':scope > h2 + .note-btn') ?? row.querySelector(':scope > h2'))?.nextSibling ?? row.firstChild);
}).observe(app, { childList: true, subtree: true });
// Keep relative times honest: the usage readout, and the minions list's waits and usage-reset countdowns.
setInterval(() => {
  if (usage) renderUsage();
  if (view?.kind === 'project') renderSidebar();
}, 30_000);

api('api/me').then((r) => start(r.name)).catch(() => {});
// The service worker makes the app installable (home screen, full screen) and shows push notifications; it caches nothing.
// Absolute on purpose: a preview (/preview/N/) shares the live app's one worker instead of registering its own.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Only in the installed app, so browser tabs look and behave as before: colour the title/status bar
// like the top bar, and on Android shrink the page when the keyboard opens so the composer stays in view.
if (matchMedia('(display-mode: standalone)').matches) {
  const viewport = document.querySelector('meta[name=viewport]');
  viewport.content += ', interactive-widget=resizes-content';
  for (const [scheme, color] of [['light', '#ffffff'], ['dark', '#201f1d']]) {
    document.head.append(h('meta', { name: 'theme-color', content: color, media: `(prefers-color-scheme: ${scheme})` }));
  }
}
