// What a minion waits on (t.wait, src/waits.ts, #544): the land line, a heavy slot, a CI run (#546), the restart. The list
// row's badge and thin bar, and the chat readout's line, whose opened view shows a landing's whole track.
import { h } from './base.js';

/** A landing's stages in order (src/waits.ts TRACK): a wait at one of these shows the track. */
export const TRACK = [['line', 'Land line', 'Line'], ['rebase', 'Rebase'], ['test', 'Test'], ['deploy', 'Deploy'], ['restart', 'Restart'], ['live', 'Live']];
const OWN = { slot: 'Heavy slot', run: 'Heavy run' };
/** Running over the usual by more than this turns the bar amber. */
const LATE = 1.15;

/** Doing (blue) while its own landing or run is under way, waiting (violet) in a line, a CI queue or on the restart; a CI run that ended green or red, or grey with every job skipped (#558). */
export const waitFam = (w) => (w.stage === 'passed' ? 'done' : w.stage === 'failed' || w.stage === 'cancelled' ? 'broken' : w.stage === 'skipped' ? 'idle'
  : ['rebase', 'test', 'deploy', 'run', 'jobs'].includes(w.stage) ? 'work' : 'wait');
/** How long it has gone on: a CI run's stops when it ended. */
const took = (w, now) => (w.ended ?? now) - w.since;
export const waitLate = (w, now = Date.now()) => !!w.usual && !w.ended && took(w, now) > w.usual * 1000 * LATE;
/** How full its bar is: by its counts (tests or CI jobs done, #551) when it has them, else elapsed against usual. */
export const waitPct = (w, now) => (w.ended ? 100 : w.total ? (w.done / w.total) * 100 : w.usual ? Math.min(100, (took(w, now) / (w.usual * 1000)) * 100) : 0);

/** "1m 05s" style, for how long something has run. */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/** "59s of ~2m 40s", or the elapsed time alone when nothing is known of the usual. */
export function waitTime(w, now = Date.now()) {
  return w.usual ? `${elapsedText(took(w, now))} of ~${elapsedText(w.usual * 1000)}` : elapsedText(took(w, now));
}

/** A thin bar: tests or jobs done of all of them, or elapsed against usual, which the ticker below moves on; none with neither. */
export function waitBar(w, cls = 'wait-bar') {
  if (!w.usual && !w.total) return '';
  const now = Date.now(), fam = waitFam(w);
  // A counted bar moves when the wait is sent again with new counts, not on the ticker.
  const clock = w.total ? {} : { 'data-since': w.since, 'data-usual': w.usual, 'data-ended': w.ended ?? '' };
  const fill = h('i');
  fill.style.width = `${waitPct(w, now)}%`; // the page's CSP drops style attributes, not the style property
  return h('span', { class: `${cls}${!w.total && waitLate(w, now) ? ' late' : ''}${fam === 'done' || fam === 'broken' ? ` f-${fam}` : ''}`, ...clock, 'aria-hidden': 'true' }, fill);
}

/** The wait's stage name and where it is on a landing's track. */
function stageOf(w) {
  const at = TRACK.findIndex(([key]) => key === w.stage);
  return { at, label: at >= 0 ? TRACK[at][1] : w.kind === 'ci' ? 'CI' : OWN[w.stage] ?? w.stage };
}

/** The wait in plain words, for a list row's subtitle (#551): what is happening, with the server's detail. */
export function waitWords(w) {
  const lead = w.kind === 'ci' ? 'CI' : ['restart', 'live'].includes(w.stage) ? 'Going live' : w.stage === 'line' ? 'Waiting to land' : w.kind === 'land' ? 'Landing' : '';
  return lead ? `${lead}: ${w.text}` : w.text.charAt(0).toUpperCase() + w.text.slice(1);
}

/** The readout line's "now" part while it waits (#551): the stage, "3/6" on a landing, and the detail. */
export function waitNow(w) {
  const { at, label } = stageOf(w);
  return [h('b', { class: `f-${waitFam(w)}` }, label), at >= 0 ? ` ${at + 1}/${TRACK.length}` : '', ` · ${w.text}`];
}

/** Elapsed (against usual, when known) that the ticker below moves on: a wait's, or a turn's ({ since }) with no usual. */
export function waitClock(w, cls = 'wait-time') {
  return h('span', { class: cls, 'data-since': w.since, 'data-usual': w.usual ?? '', 'data-ended': w.ended ?? '' }, waitTime({ usual: null, ...w }));
}

/** A landing's whole track, for the opened readout; none for a wait that isn't a landing. */
export function waitTrack(w) {
  const { at } = stageOf(w);
  return at < 0 ? '' : h('ol', { class: 'wait-track' }, TRACK.map(([, name, short = name], i) =>
    h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, h('i'), h('span', {}, short))));
}

/** Moves every wait's bar and elapsed time on, without rebuilding rows. */
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.wait-time, .wait-bar[data-since]')) {
    const w = { since: Number(el.dataset.since), usual: Number(el.dataset.usual) || null, ended: Number(el.dataset.ended) || undefined };
    if (el.classList.contains('wait-time')) el.textContent = waitTime(w, now);
    else {
      el.firstChild.style.width = `${waitPct(w, now)}%`;
      el.classList.toggle('late', waitLate(w, now));
    }
  }
}
if (typeof document !== 'undefined') setInterval(tick, 1000);
