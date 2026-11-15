// What a minion waits on (t.wait, src/waits.ts, #544): the land line, a heavy slot, a CI run (#546), the restart. The list
// row's badge and thin bar, and the chat readout's line, whose opened view shows a landing's whole track.
import { h } from './base.js';

/** A landing's stages in order (src/waits.ts TRACK): a wait at one of these shows the track. */
export const TRACK = [['line', 'Land line', 'Line'], ['rebase', 'Rebase'], ['test', 'Test'], ['deploy', 'Deploy'], ['restart', 'Restart'], ['live', 'Live']];
const OWN = { slot: 'Heavy slot', run: 'Heavy run' };
/** Running over the usual by more than this turns the bar amber. */
export const LATE = 1.15;

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

/**
 * A thin bar: tests or jobs done of all of them, or elapsed against usual, which the ticker below moves on; none with neither.
 * `cap`: the fill stops there (a release's stage track stops at 90% until the stage really ends, #626).
 */
export function waitBar(w, cls = 'wait-bar', cap = 100) {
  if (!w.usual && !w.total) return '';
  const now = Date.now(), fam = waitFam(w);
  // A counted bar moves when the wait is sent again with new counts, not on the ticker.
  const clock = w.total ? {} : { 'data-since': w.since, 'data-usual': w.usual, 'data-ended': w.ended ?? '', ...(cap < 100 ? { 'data-cap': cap } : {}) };
  const fill = h('i');
  fill.style.width = `${Math.min(cap, waitPct(w, now))}%`; // the page's CSP drops style attributes, not the style property
  return h('span', { class: `${cls}${!w.total && waitLate(w, now) ? ' late' : ''}${fam === 'done' || fam === 'broken' ? ` f-${fam}` : ''}`, ...clock, 'aria-hidden': 'true' }, fill);
}

/** How wide each piece of a segmented track is: its usual time, the others' average when unknown, never under 8% of the whole. */
export function segSizes(sizes) {
  const known = sizes.filter((n) => n > 0);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const full = sizes.map((n) => (n > 0 ? n : avg));
  const floor = full.reduce((a, b) => a + b, 0) * 0.08;
  return full.map((n) => Math.max(n, floor));
}

/**
 * A segmented track, one logic for the release's stages, the chat readout and the minions list (#630; Cara: "We should
 * standardize the release, minion list and chat segmented tracks to all use the same logic"). A piece per segment
 * ({ size, state: 'done' | 'now' | '', clock, waits, name, title }), as wide as its usual time: one with none known
 * takes the others' average, and none goes under 8% of the whole, so a 1-second rebase still shows. Done pieces are
 * full; the one underway fills by its `clock` (a waitBar: elapsed over usual, or a count) up to `cap`, going amber past
 * LATE, or shows a sliver when nothing is known; hatched, never filled, while it `waits`. `labels` names them under.
 */
export function segTrack(segs, { cls = '', cap = 90, labels = false, label = '' } = {}) {
  const grow = segSizes(segs.map((s) => s.size));
  return h('ol', { class: `seg-track${cls ? ` ${cls}` : ''}`, ...(label ? { 'aria-label': label } : { 'aria-hidden': 'true' }) }, segs.map((s, i) => {
    const now = s.state === 'now';
    const bar = (now && !s.waits && s.clock && waitBar(s.clock, 'wait-bar', cap)) || h('span', { class: 'wait-bar' }, h('i'));
    const li = h('li', { class: `${s.state ?? ''}${now && s.waits ? ' waits' : ''}`, ...(s.title ? { title: s.title } : {}) },
      bar, labels ? h('span', { class: 'lbl' }, s.name ?? '') : '');
    li.style.flexGrow = String(grow[i]); // the page's CSP drops style attributes, not the style property
    return li;
  }));
}

/** A wait that draws a bar: one with a count or a usual time, or a landing at a known stage. */
export const waitShows = (w) => !!w && !!(w.total || w.usual || TRACK.some(([key]) => key === w.stage));

/**
 * The one progress track for the chat readout and the list row (#630; Cara, on her bar during a land: "the progress
 * bars for 630 on the list and chat are out of sync, arent showing the stages"). A plan with a step underway draws
 * its steps (`track`: [guess minutes or null, 'c' done | 'i' underway | 'p' not started]), the step underway filling
 * by the `wait` when there is one (hatched while it waits in a line or queue), else against `since`/`usual`, its
 * scaled guess. With no step underway, a landing draws its own stages; another wait its bar; a plan its steps.
 */
export function progressTrack(src, cls = '') {
  const what = progressPieces(src);
  return !what ? '' : what.bar ? waitBar(what.bar, `wait-bar${cls ? ` ${cls}` : ''}`) : segTrack(what.segs, { cls, label: what.label });
}

/** What progressTrack draws: { segs, label } for a segmented track, { bar } for a wait's own bar, or null. */
export function progressPieces({ track, since, usual, wait }) {
  const w = waitShows(wait) ? wait : null;
  const wClock = w && (w.total || w.usual) ? w : null;
  const piece = (state, size, clock = null) => ({ size, state, clock, waits: state === 'now' && !!w && waitFam(w) === 'wait' });
  if (track?.length && (track.some(([, st]) => st === 'i') || !w)) {
    // Nothing in the track or the wait ties a wait to a step, so the first step underway owns it (a guess): only it fills
    // by the clock or hatches; any other step underway shows as underway with a sliver.
    const owner = track.findIndex(([, st]) => st === 'i');
    return { segs: track.map(([g, st], i) => st === 'c' ? piece('done', g) : st === 'i' ? (i === owner ? piece('now', g, wClock ?? (usual ? { since, usual } : null)) : { ...piece('now', g), waits: false }) : piece('', g)), label: '' };
  }
  if (!w) return null;
  const { at } = stageOf(w);
  if (at < 0) return { bar: w };
  return { segs: TRACK.map(([, name], i) => ({ ...piece(i < at ? 'done' : i === at ? 'now' : '', null, i === at ? wClock : null), name })), label: `${TRACK[at][1]}, stage ${at + 1} of ${TRACK.length}` };
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

/**
 * The readout line's "now" part while it waits (#551): the stage, "3/6" on a landing, and the detail: its `brief`
 * when it has one ("Test 3/6 · CI: the full suite", #630), the whole text when `full` (the opened readout).
 */
export function waitNow(w, full = false) {
  const { at, label } = stageOf(w);
  return [h('b', { class: `f-${waitFam(w)}` }, label), at >= 0 ? ` ${at + 1}/${TRACK.length}` : '', ` · ${full ? w.text : w.brief ?? w.text}`];
}

/** waitNow's short line as plain text, for the list row's subtitle, so the row and the chat say the same (#630). */
export function waitLine(w) {
  const { at, label } = stageOf(w);
  return `${label}${at >= 0 ? ` ${at + 1}/${TRACK.length}` : ''} · ${w.brief ?? w.text}`;
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
    if (el.classList.contains('wait-time')) {
      el.textContent = waitTime(w, now);
      if (el.closest('.progress-cap')) el.classList.toggle('late', waitLate(w, now)); // the step's own time goes amber with its bar (#630)
    }
    else {
      el.firstChild.style.width = `${Math.min(Number(el.dataset.cap) || 100, waitPct(w, now))}%`;
      el.classList.toggle('late', waitLate(w, now));
    }
  }
}
if (typeof document !== 'undefined') setInterval(tick, 1000);
