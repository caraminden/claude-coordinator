// What a minion waits on (t.wait, src/waits.ts, #544): the land line, a heavy slot, a CI run (#546), the restart. The list
// row's badge and thin bar, and the chat readout's line, whose opened view shows a landing's whole track.
import { h } from './base.js';

/** @import { Wait } from './types.js' */
/** What a wait's bar and clock read: a Wait, or a turn's { since } alone. @typedef {{ since?: number, usual?: number | null, ended?: number, total?: number, done?: number, stage?: string }} WaitLike */
/** A piece of a segmented track (segTrack). @typedef {{ size: number | null, state: string, clock: WaitLike | null, waits: boolean, name?: string, title?: string }} Seg */

/** A landing's stages in order (src/waits.ts TRACK): a wait at one of these shows the track. */
export const TRACK = /** @type {[string, string, string?][]} */ ([
  ['line', 'Ship line', 'Line'],
  ['rebase', 'Rebase'],
  ['test', 'Test'],
  ['deploy', 'Deploy'],
  ['restart', 'Restart'],
  ['live', 'Live'],
]);
/** @type {Record<string, string>} */
const OWN = { slot: 'Heavy slot', run: 'Heavy run' };
/** Running over the usual by more than this turns the bar amber. */
export const LATE = 1.15;
/** A counted bar on a capped track stops here, not at the time guess's cap, until the stage really ends. */
export const COUNT_CAP = 97;

/** Doing (blue) while its own landing or run is under way, waiting (violet) in a line, a CI queue or on the restart; a CI run that ended green or red, or grey with every job skipped (#558). */
/** @param {Pick<WaitLike, 'stage'>} w */
export const waitFam = (w) => (w.stage === 'passed' ? 'done' : w.stage === 'failed' || w.stage === 'cancelled' ? 'broken' : w.stage === 'skipped' ? 'idle' : /** @type {(string | undefined)[]} */ (['rebase', 'test', 'deploy', 'run', 'jobs']).includes(w.stage) ? 'work' : 'wait');
/** How long it has gone on: a CI run's stops when it ended. */
/** @param {WaitLike} w @param {number} now */
const took = (w, now) => (w.ended ?? now) - (w.since ?? Number.NaN); // a step count with no start: NaN, as before
/** @param {WaitLike} w @param {number} [now] */
export const waitLate = (w, now = Date.now()) => !!w.usual && !w.ended && took(w, now) > w.usual * 1000 * LATE;
/** How full its bar is: by its counts (tests or CI jobs done, #551) when it has them, else elapsed against usual. */
/** @param {WaitLike} w @param {number} now */
export const waitPct = (w, now) => (w.ended ? 100 : w.total ? (Number(w.done) / w.total) * 100 : w.usual ? Math.min(100, (took(w, now) / (w.usual * 1000)) * 100) : 0);

/** The width a bar draws: waitPct up to `cap`, but a real count on a capped track goes to COUNT_CAP, not the guess's cap. */
/** @param {WaitLike} w @param {number} now @param {number} [cap] */
export const waitFill = (w, now, cap = 100) => Math.min(w.total && cap < 100 ? Math.max(cap, COUNT_CAP) : cap, waitPct(w, now));

/** "1m 05s" style, for how long something has run. */
/** @param {number} ms */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/** "59s of ~2m 40s", or the elapsed time alone when nothing is known of the usual. */
/** @param {WaitLike} w @param {number} [now] */
export function waitTime(w, now = Date.now()) {
  return w.usual ? `${elapsedText(took(w, now))} of ~${elapsedText(w.usual * 1000)}` : elapsedText(took(w, now));
}

/**
 * A thin bar: tests or jobs done of all of them, or elapsed against usual, which the ticker below moves on; none with neither.
 * `cap`: a time-based fill stops there (a release's stage track stops at 90% until the stage really ends, #626); a real
 * count fills to its own done/total, with a small gap (COUNT_CAP) until the stage ends.
 * @param {WaitLike} w @param {string} [cls] @param {number} [cap]
 */
export function waitBar(w, cls = 'wait-bar', cap = 100) {
  if (!w.usual && !w.total) return '';
  const now = Date.now(),
    fam = waitFam(w);
  // A counted bar moves when the wait is sent again with new counts, not on the ticker.
  const clock = w.total ? {} : { 'data-since': w.since, 'data-usual': w.usual, 'data-ended': w.ended ?? '', ...(cap < 100 ? { 'data-cap': cap } : {}) };
  const fill = h('i');
  fill.style.width = `${waitFill(w, now, cap)}%`; // the page's CSP drops style attributes, not the style property
  return h('span', { class: `${cls}${!w.total && waitLate(w, now) ? ' late' : ''}${fam === 'done' || fam === 'broken' ? ` f-${fam}` : ''}`, ...clock, 'aria-hidden': 'true' }, fill);
}

/** How wide each piece of a segmented track is: its usual time, the others' average when unknown, never under 8% of the whole. */
/** @param {(number | null)[]} sizes */
export function segSizes(sizes) {
  const known = sizes.flatMap((n) => (n != null && n > 0 ? [n] : []));
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const full = sizes.map((n) => (n != null && n > 0 ? n : avg));
  const floor = full.reduce((a, b) => a + b, 0) * 0.08;
  return full.map((n) => Math.max(n, floor));
}

/**
 * A segmented track, one logic for the release's stages, the chat readout and the minions list (#630; Cara: "We should
 * standardize the release, minion list and chat segmented tracks to all use the same logic"). A piece per segment
 * ({ size, state: 'done' | 'now' | 'held' | '', clock, waits, name, title }), as wide as its usual time: one with none known
 * takes the others' average, and none goes under 8% of the whole, so a 1-second rebase still shows. Done pieces are
 * full; the one underway fills by its `clock` (a waitBar: elapsed over usual, or a count) up to `cap`, going amber past
 * LATE, or shows a sliver when nothing is known; hatched, never filled, while it `waits`. `labels` names them under.
 * @param {Seg[]} segs @param {{ cls?: string, cap?: number, labels?: boolean, label?: string }} [opts]
 */
export function segTrack(segs, { cls = '', cap = 90, labels = false, label = '' } = {}) {
  const grow = segSizes(segs.map((s) => s.size));
  return h(
    'ol',
    { class: `seg-track${cls ? ` ${cls}` : ''}`, ...(label ? { 'aria-label': label } : { 'aria-hidden': 'true' }) },
    segs.map((s, i) => {
      const now = s.state === 'now';
      const bar = (now && !s.waits && s.clock && waitBar(s.clock, 'wait-bar', cap)) || h('span', { class: 'wait-bar' }, h('i'));
      const li = h('li', { class: `${s.state ?? ''}${now && s.waits ? ' waits' : ''}`, ...(s.title ? { title: s.title } : {}) }, bar, labels ? h('span', { class: 'lbl' }, s.name ?? '') : '');
      li.style.flexGrow = String(grow[i]); // the page's CSP drops style attributes, not the style property
      return li;
    }),
  );
}

/** A wait that draws a bar: one with a count or a usual time, or a landing at a known stage. */
/** @param {Wait | null | undefined} w */
export const waitShows = (w) => !!w && !!(w.total || w.usual || TRACK.some(([key]) => key === w.stage));

/**
 * The one progress track for the chat readout and the list row (#630; Cara, on her bar during a land: "the progress
 * bars for 630 on the list and chat are out of sync, arent showing the stages"). A plan with a step underway draws
 * its steps (`track`: [guess minutes or null, 'c' done | 'i' underway | 'h' held | 'p' not started]), only the first step
 * underway drawn as under way (any other draws as not started, #2156), filling
 * by the `wait` when there is one (hatched while it waits in a line or queue), else against `since`/`usual`, its
 * scaled guess. A step built and now being tested ('h', #1923) is full, in the running colour. With no step underway, a landing draws its own stages; another wait its bar; a plan its steps.
 * @param {Parameters<typeof progressPieces>[0]} src @param {string} [cls]
 */
export function progressTrack(src, cls = '') {
  const what = progressPieces(src);
  return !what ? '' : what.bar ? waitBar(what.bar, `wait-bar${cls ? ` ${cls}` : ''}`) : segTrack(what.segs, { cls, label: what.label });
}

/** What progressTrack draws: { segs, label } for a segmented track, { bar } for a wait's own bar, or null. */
/** @param {{ track: [number | null, string][] | null | undefined, since?: number, usual?: number | null, wait?: Wait | null }} src @returns {{ segs: Seg[], label: string, bar?: undefined } | { bar: WaitLike, segs?: undefined, label?: undefined } | null} */
export function progressPieces({ track, since, usual, wait }) {
  const w = waitShows(wait) ? wait : null;
  const wClock = w && (w.total || w.usual) ? w : null;
  /** @param {string} state @param {number | null} size @param {WaitLike | null} [clock] @returns {Seg} */
  const piece = (state, size, clock = null) => ({ size, state, clock, waits: state === 'now' && !!w && waitFam(w) === 'wait' });
  if (track?.length && (track.some(([, st]) => st === 'i') || !w)) {
    // The first step underway owns the clock and the wait (planTrack puts the one the readout names first): only it draws
    // as under way, filling by the clock or hatching. Any other step underway draws as not started, so one row never
    // looks like several steps are moving at once (#2156).
    const owner = track.findIndex(([, st]) => st === 'i');
    return { segs: track.map(([g, st], i) => (i === owner ? piece('now', g, wClock ?? (usual ? { since: /** @type {number} */ (since), usual } : null)) : piece(st === 'c' ? 'done' : st === 'h' ? 'held' : '', g))), label: '' };
  }
  if (!w) return null;
  const { at } = stageOf(w);
  if (at < 0) return { bar: w };
  return { segs: TRACK.map(([, name], i) => ({ ...piece(i < at ? 'done' : i === at ? 'now' : '', null, i === at ? wClock : null), name })), label: `${TRACK[at][1]}, stage ${at + 1} of ${TRACK.length}` };
}

/** The wait's stage name and where it is on a landing's track. */
/** @param {Pick<Wait, 'stage' | 'kind'>} w */
function stageOf(w) {
  const at = TRACK.findIndex(([key]) => key === w.stage);
  return { at, label: at >= 0 ? TRACK[at][1] : w.kind === 'ci' ? 'CI' : (OWN[w.stage] ?? w.stage) };
}

/** The wait in plain words, for a list row's subtitle (#551): what is happening, with the server's detail. */
/** @param {Wait} w */
export function waitWords(w) {
  const lead = w.kind === 'ci' ? 'CI' : ['restart', 'live'].includes(w.stage) ? 'Going live' : w.stage === 'line' ? 'Waiting to ship' : w.kind === 'land' ? 'Shipping' : '';
  return lead ? `${lead}: ${w.text}` : w.text.charAt(0).toUpperCase() + w.text.slice(1);
}

/**
 * The readout line's "now" part while it waits (#551): the stage, "3/6" on a landing, and the detail: its `brief`
 * when it has one ("Test 3/6 · CI: the full suite", #630), the whole text when `full` (the opened readout).
 */
/** @param {Wait} w @param {boolean} [full] */
export function waitNow(w, full = false) {
  const { at, label } = stageOf(w);
  return [h('b', { class: `f-${waitFam(w)}` }, label), at >= 0 ? ` ${at + 1}/${TRACK.length}` : '', ` · ${full ? w.text : (w.brief ?? w.text)}`];
}

/** waitNow's short line as plain text, for the list row's subtitle, so the row and the chat say the same (#630). */
/** @param {Wait} w */
export function waitLine(w) {
  const { at, label } = stageOf(w);
  return `${label}${at >= 0 ? ` ${at + 1}/${TRACK.length}` : ''} · ${w.brief ?? w.text}`;
}

/** Elapsed (against usual, when known) that the ticker below moves on: a wait's, or a turn's ({ since }) with no usual. */
/** @param {WaitLike} w @param {string} [cls] */
export function waitClock(w, cls = 'wait-time') {
  return h('span', { class: cls, 'data-since': w.since, 'data-usual': w.usual ?? '', 'data-ended': w.ended ?? '' }, waitTime({ usual: null, ...w }));
}

/** A landing's whole track, for the opened readout; none for a wait that isn't a landing. */
/** @param {Wait} w */
export function waitTrack(w) {
  const { at } = stageOf(w);
  return at < 0
    ? ''
    : h(
        'ol',
        { class: 'wait-track' },
        TRACK.map(([, name, short = name], i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, h('i'), h('span', {}, short))),
      );
}

/** Moves every wait's bar and elapsed time on, without rebuilding rows. */
function tick() {
  const now = Date.now();
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.wait-time, .wait-bar[data-since]'))) {
    const w = { since: Number(el.dataset.since), usual: Number(el.dataset.usual) || null, ended: Number(el.dataset.ended) || undefined };
    if (el.classList.contains('wait-time')) {
      el.textContent = waitTime(w, now);
      if (el.closest('.progress-cap')) el.classList.toggle('late', waitLate(w, now)); // the step's own time goes amber with its bar (#630)
    } else {
      /** @type {HTMLElement} */ (el.firstChild).style.width = `${Math.min(Number(el.dataset.cap) || 100, waitPct(w, now))}%`;
      el.classList.toggle('late', waitLate(w, now));
    }
  }
}
if (typeof document !== 'undefined') setInterval(tick, 1000);
