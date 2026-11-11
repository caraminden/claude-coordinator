// What a minion waits on (t.wait, src/waits.ts, #544): the land line, a heavy slot, the restart. The list
// row's badge and thin bar, and the chat readout's line that opens to a landing's whole track.
import { h } from './base.js';

/** A landing's stages in order (src/waits.ts TRACK): a wait at one of these shows the track. */
export const TRACK = [['line', 'Land line'], ['rebase', 'Rebase'], ['test', 'Test'], ['deploy', 'Deploy'], ['restart', 'Restart'], ['live', 'Live']];
const OWN = { slot: 'Heavy slot', run: 'Heavy run' };
/** Running over the usual by more than this turns the bar amber. */
const LATE = 1.15;

/** Doing (blue) while its own landing or run is under way, waiting (violet) while in a line or on the restart. */
export const waitFam = (w) => (['rebase', 'test', 'deploy', 'run'].includes(w.stage) ? 'work' : 'wait');
export const waitLate = (w, now = Date.now()) => !!w.usual && now - w.since > w.usual * 1000 * LATE;
const pct = (w, now) => (w.usual ? Math.min(100, ((now - w.since) / (w.usual * 1000)) * 100) : 0);

/** "1m 05s" style, for how long something has run. */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/** "59s of ~2m 40s", or the elapsed time alone when nothing is known of the usual. */
export function waitTime(w, now = Date.now()) {
  return w.usual ? `${elapsedText(now - w.since)} of ~${elapsedText(w.usual * 1000)}` : elapsedText(now - w.since);
}

/** Elapsed against usual, as a thin bar that the ticker below moves on; none without a usual. */
export function waitBar(w, cls = 'wait-bar') {
  if (!w.usual) return '';
  const now = Date.now();
  return h('span', { class: `${cls}${waitLate(w, now) ? ' late' : ''}`, 'data-since': w.since, 'data-usual': w.usual, 'aria-hidden': 'true' },
    h('i', { style: `width: ${pct(w, now)}%` }));
}

/**
 * The readout's line: the stage, "3 of 6" on a landing, the detail and elapsed against usual. It starts
 * closed (Cara, 2026-11-11); `open` shows a landing's whole track above it, and `toggle` flips that.
 */
export function waitBlock(w, open, toggle) {
  const at = TRACK.findIndex(([key]) => key === w.stage);
  const label = at >= 0 ? TRACK[at][1] : OWN[w.stage] ?? w.stage;
  const track = open && at >= 0 ? h('ol', { class: 'wait-track' }, TRACK.map(([, name], i) =>
    h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, h('i'), h('span', {}, name)))) : '';
  const head = h(at >= 0 ? 'button' : 'div', { class: `wait-head f-${waitFam(w)}`, ...(at >= 0 ? { type: 'button', 'aria-expanded': String(open), onclick: toggle } : {}) },
    h('span', { class: 'text' }, h('b', {}, label), at >= 0 ? ` ${at + 1} of ${TRACK.length}` : '', ` · ${w.text}`),
    h('span', { class: 'wait-time', 'data-since': w.since, 'data-usual': w.usual ?? '' }, waitTime(w)),
    at >= 0 ? h('span', { class: 'chev' }, open ? '▴' : '▾') : '');
  return h('div', { class: 'wait-line' }, track, head, waitBar(w, 'wait-bar big'));
}

/** Moves every wait's bar and elapsed time on, without rebuilding rows. */
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.wait-time, .wait-bar')) {
    const w = { since: Number(el.dataset.since), usual: Number(el.dataset.usual) || null };
    if (el.classList.contains('wait-time')) el.textContent = waitTime(w, now);
    else {
      el.firstChild.style.width = `${pct(w, now)}%`;
      el.classList.toggle('late', waitLate(w, now));
    }
  }
}
if (typeof document !== 'undefined') setInterval(tick, 1000);
