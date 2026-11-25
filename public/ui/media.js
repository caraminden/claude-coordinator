// Citadel UI: the media viewer parts. Served to apps as /apps/_citadel/ui/media.js (types: media.d.ts beside it).
// Ported from TripPresenter's Show (#833; Cara, 2026-11-16, picked "C3 Media viewer parts in the kit"):
//   scrubber(video, opts)  a video's play button, frame strip, seek bar and Start/End pins
//   panner(img, opts)      a panorama that pans end to end, with a mini-map, Pause and a look-around slider
//   lightbox(items, opts)  pictures and clips one at a time, with ‹ ›, a filmstrip and the ←/→ keys
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages: no imports from
// outside ui/, nothing it writes carries style="" or <style> (nor a CSSOM style write: positions are SVG
// attributes and scrollLeft), and its exports are an API apps depend on (test/ui-contract.test.ts). Add, never
// rename. It brings its own constructed stylesheet, as chat.js does, and needs base.css for its buttons.
//
import { openDialog } from './dialog.js';

// The parts store nothing: pins come in as numbers (ms) and go out through callbacks, and the app saves them.

const CSS = `
:where(:is(.cui-scrubber, .cui-panner, .cui-lb) :is(button, select)) { font-family: inherit; }
:where(.cui-scrubber) { box-sizing: border-box; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center;
  gap: var(--citadel-space-2) var(--citadel-space-3); padding: var(--citadel-space-2) var(--citadel-space-3); background: var(--citadel-surface);
  border-top: 1px solid var(--citadel-border); color: var(--citadel-text); font: var(--citadel-size-small)/1.3 var(--citadel-font); }
:where(.cui-scrub-play) { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: max(36px, var(--citadel-control-h));
  height: max(36px, var(--citadel-control-h)); padding: 0; border: 0; border-radius: 50%; background: var(--citadel-accent); color: var(--citadel-on-accent);
  font-size: 14px; line-height: 1; cursor: pointer; }
:where(.cui-scrub-play:disabled) { background: var(--citadel-neutral); cursor: not-allowed; }
:where(.cui-scrub-play:focus-visible, .cui-scrub-frame:focus-visible, .cui-lb-thumb:focus-visible, .cui-lb-step:focus-visible) { outline: var(--citadel-focus-ring); outline-offset: var(--citadel-focus-offset); }
:where(.cui-scrub-main) { position: relative; display: flex; flex-direction: column; gap: var(--citadel-space-1); min-width: 0; }
:where(.cui-scrub-frames) { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; height: 34px; touch-action: none; }
:where(.cui-scrub-frame) { position: relative; min-width: 0; padding: 0; border: 0; border-radius: 3px; background: var(--citadel-code-bg); cursor: pointer; }
:where(.cui-scrub-frame:disabled) { cursor: not-allowed; }
:where(.cui-scrub-frame > canvas) { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 3px; opacity: 0.55; }
:where(.cui-scrub-frame.cui-past > canvas) { opacity: 1; }
:where(.cui-scrub-pop) { box-sizing: border-box; display: none; position: absolute; bottom: calc(100% + 18px); left: 50%; translate: -50% 0; z-index: 3; width: 128px;
  flex-direction: column; border: 2px solid var(--citadel-text); border-radius: var(--citadel-radius-sm); overflow: hidden; background: var(--citadel-surface); }
:where(.cui-scrub-frame:first-child > .cui-scrub-pop) { left: 0; translate: 0 0; }
:where(.cui-scrub-frame:last-child > .cui-scrub-pop) { left: auto; right: 0; translate: 0 0; }
:where(.cui-scrub-pop > canvas) { display: block; width: 100%; height: auto; background: var(--citadel-code-bg); }
:where(.cui-scrub-pop > span) { padding: 2px; text-align: center; font: 600 11px/1.3 var(--citadel-mono); color: var(--citadel-text); }
:where(.cui-scrub-frame:hover > .cui-scrub-pop, .cui-scrub-frame:focus-visible > .cui-scrub-pop) { display: flex; }
:where(.cui-scrub-range) { box-sizing: border-box; display: block; width: 100%; height: 24px; margin: 0; accent-color: var(--citadel-accent); }
:where(.cui-scrub-pins) { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
:where(.cui-scrub-pins line) { stroke: var(--citadel-accent-2); stroke-width: 2px; }
:where(.cui-scrub-pins rect) { fill: color-mix(in srgb, var(--citadel-surface) 60%, transparent); }
/* The labels sit on the frames' top edge, on a chip so they read over any picture. */
:where(.cui-scrub-pins .cui-scrub-chip) { fill: var(--citadel-accent-2); }
:where(.cui-scrub-pins text) { fill: var(--citadel-on-accent); font: 700 10px var(--citadel-mono); }
:where(.cui-scrub-acts) { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--citadel-space-2); }
:where(.cui-scrub-time) { min-width: 11ch; color: var(--citadel-muted); font: 600 var(--citadel-size-meta)/1.3 var(--citadel-mono); font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; }
:where(.cui-scrub-pin) { color: var(--citadel-accent-2); border-color: var(--citadel-accent-2); }
:where(.cui-scrub-fail) { grid-column: 1 / -1; }
:where(.cui-scrub-video) { cursor: pointer; }

:where(.cui-panner) { display: flex; flex-direction: column; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; }
:where(.cui-pan-stage) { position: relative; display: flex; flex: 1; min-height: 0; }
:where(.cui-pan-over) { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
:where(.cui-pan-over > *) { pointer-events: auto; }
:where(.cui-pan-view) { display: flex; flex: 1; min-width: 0; min-height: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
:where(.cui-pan-view)::-webkit-scrollbar { display: none; }
/* Panning needs the picture wider than its box: an app's img reset (max-width: 100%, as Tailwind's preflight has) would
   shrink it to fit, and its height: auto would undo the fit to the box's height, so these two properties win. */
:where(.cui-pan-view > img) { display: block; flex: none; width: auto; max-width: none !important; height: 100% !important; }
:where(.cui-pan-fits .cui-pan-view > img) { flex: 1; width: 100%; object-fit: contain; }
:where(.cui-pan-bar) { box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--citadel-space-2) var(--citadel-space-3);
  padding: var(--citadel-space-2) var(--citadel-space-3); background: var(--citadel-surface); border-top: 1px solid var(--citadel-border); color: var(--citadel-text);
  font: var(--citadel-size-small)/1.3 var(--citadel-font); }
:where(.cui-pan-fits .cui-pan-bar) { display: none; }
:where(.cui-pan-label) { margin-right: auto; color: var(--citadel-muted); font-size: var(--citadel-size-meta); }
:where(.cui-pan-map) { display: block; flex: none; width: 200px; height: 40px; border-radius: 4px; background: var(--citadel-code-bg); cursor: pointer; touch-action: none; }
:where(.cui-pan-map .cui-pan-shade) { fill: color-mix(in srgb, var(--citadel-surface) 55%, transparent); }
:where(.cui-pan-map .cui-pan-win) { fill: none; stroke: var(--citadel-accent); stroke-width: 2px; }
:where(.cui-pan-look) { box-sizing: border-box; width: 140px; height: 24px; margin: 0; accent-color: var(--citadel-accent); }
:where(.cui-pan-dir) { width: auto; }

/* 100% of the viewport the dialog sits in, not 100vw, which counts a page's reserved scrollbar gutter and puts it off-centre. */
:where(.cui-lightbox) { --cui-dialog-pad: 0px; width: calc(100% - 2 * var(--citadel-space-3)); height: calc(100dvh - var(--cui-dialog-top, 0px) - 2 * var(--citadel-space-3)); }
:where(.cui-lightbox[open]) { display: flex; flex-direction: column; overflow: hidden; }
:where(.cui-lightbox > .cui-dialog-head) { margin: 0; padding-inline-start: var(--citadel-space-3); }
:where(.cui-lb) { display: flex; flex-direction: column; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; }
:where(.cui-lb-stage) { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; container-type: size; touch-action: pan-y pinch-zoom; }
:where(.cui-lb-stage > img, .cui-lb-stage > video) { display: block; flex: 1; width: 100%; min-height: 0; object-fit: contain; }
:where(.cui-lb-stage > img.cui-r90, .cui-lb-stage > img.cui-r270) { position: absolute; left: 50%; top: 50%; flex: none; width: 100cqh; height: 100cqw; translate: -50% -50%; rotate: 90deg; }
:where(.cui-lb-stage > img.cui-r270) { rotate: 270deg; }
:where(.cui-lb-stage > img.cui-r180) { rotate: 180deg; }
:where(.cui-lb-step) { box-sizing: border-box; position: absolute; top: 50%; z-index: 2; display: inline-flex; align-items: center; justify-content: center; width: 40px;
  height: 40px; padding: 0; translate: 0 -50%; border: 0; border-radius: 50%; font-size: 22px; line-height: 1; cursor: pointer;
  /* A fixed dark scrim with a light ring, not theme colours: it sits on pictures, which don't change with the theme. */
  background: rgb(0 0 0 / 0.55); color: white; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.5), 0 2px 8px rgb(0 0 0 / 0.3); }
:where(.cui-lb-step:hover) { background: rgb(0 0 0 / 0.75); }
/* Never the click's target (#963): a redraw swaps the icon, and a press that began on a node since removed makes no click. */
:where(.cui-media-icon) { display: block; width: 16px; height: 16px; pointer-events: none; }
/* The icons take their colour themselves: a host's button { color: inherit } (Tailwind's preflight has one) outranks :where(). */
:where(.cui-scrub-play > .cui-media-icon) { color: var(--citadel-on-accent); }
:where(.cui-lb-step > .cui-media-icon) { width: 20px; height: 20px; color: white; }
:where(.cui-lb-prev) { left: var(--citadel-space-3); }
:where(.cui-lb-next) { right: var(--citadel-space-3); }
:where(.cui-lb-foot) { box-sizing: border-box; display: flex; flex: none; align-items: center; gap: var(--citadel-space-3); padding: var(--citadel-space-2) var(--citadel-space-3);
  background: var(--citadel-surface); border-top: 1px solid var(--citadel-border); }
:where(.cui-lb-count) { flex: none; min-width: 7ch; color: var(--citadel-muted); font: 600 var(--citadel-size-small)/1.3 var(--citadel-font); font-variant-numeric: tabular-nums; text-align: center; }
:where(.cui-lb-strip) { display: flex; flex: 1; gap: 6px; min-width: 0; margin: 0; padding: 4px; list-style: none; overflow-x: auto; }
:where(.cui-lb-thumb) { box-sizing: border-box; position: relative; display: block; flex: none; width: 76px; height: 46px; padding: 0; border: 0; border-radius: 5px;
  overflow: hidden; background: var(--citadel-code-bg); opacity: 0.7; cursor: pointer; }
:where(.cui-lb-thumb[aria-current="true"]) { opacity: 1; box-shadow: 0 0 0 2px var(--citadel-accent); }
:where(.cui-lb-thumb > img, .cui-lb-thumb > video) { display: block; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
:where(.cui-lb-thumb > img.cui-r90) { rotate: 90deg; } :where(.cui-lb-thumb > img.cui-r180) { rotate: 180deg; } :where(.cui-lb-thumb > img.cui-r270) { rotate: 270deg; }
:where(.cui-lb-badge) { position: absolute; bottom: 2px; left: 2px; padding: 1px 4px; border-radius: 3px; background: color-mix(in srgb, var(--citadel-text) 70%, transparent);
  color: var(--citadel-bg); font: 700 9px/1.3 var(--citadel-font); }
:where(.cui-lb-one .cui-lb-foot, .cui-lb-one .cui-lb-step) { display: none; }

@media (max-width: 800px) {
  :where(.cui-scrubber) { grid-template-columns: auto minmax(0, 1fr); }
  :where(.cui-scrub-frames, .cui-scrub-range) { height: 40px; }
  /* Time and mute on one row, the pin buttons in equal cells under them. */
  :where(.cui-scrub-acts) { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  :where(.cui-scrub-time) { grid-column: span 2; text-align: left; }
  :where(.cui-scrub-mute) { justify-self: end; }
  :where(.cui-pan-map) { flex: 1 1 140px; width: auto; }
  :where(.cui-pan-look) { flex: 1 1 100px; height: 40px; }
  :where(.cui-pan-dir) { flex: 1 1 auto; }
  :where(.cui-lightbox) { width: calc(100% - 2 * var(--citadel-space-2)); height: calc(100dvh - var(--cui-dialog-top, 0px) - 2 * var(--citadel-space-2)); }
  /* A phone swipes or taps the strip, and its bars wrap, so ‹ › would sit on them; Space is a keyboard's. */
  :where(.cui-lb-step, .cui-pan-label) { display: none; }
}
`;
let sheet = false;
function adoptStyles() {
  if (sheet || typeof document === 'undefined') return;
  sheet = true;
  // Safari before 16.4 can't construct sheets: there the parts draw unstyled rather than not at all.
  try {
    const s = new CSSStyleSheet();
    s.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  } catch {}
}

const SVG = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  e.append(...kids);
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
/** A 16 px line icon in currentColor; filled paths come after the line ones' d. */
function icon(d, fill = '') {
  const e = svg('svg', { class: 'cui-media-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  if (d) e.append(svg('path', { d }));
  if (fill) e.append(svg('path', { d: fill, fill: 'currentColor', stroke: 'none' }));
  return e;
}
const speaker = (muted) => icon(muted ? 'M2.5 6h2.5l3.5-3v10l-3.5-3H2.5zM11 6l4 4M15 6l-4 4' : 'M2.5 6h2.5l3.5-3v10l-3.5-3H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6.5 6.5 0 0 1 0 9');
const playIcon = (playing) => icon('', playing ? 'M4 3h3v10H4zM9 3h3v10H9z' : 'M5 2.5v11l9-5.5z');

/** A time as m:ss, as the parts write it. */
export function clock(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** A key press inside a field (or a control that takes the key itself) is the field's, not the part's. */
const typing = (t) => !!t?.closest?.('textarea, input:not([type=range]), select, [contenteditable=""], [contenteditable="true"]');

// ———————————————————————————————————————————————————————— the scrubber

/**
 * A video's controls under it: play, a strip of frames to hover and drag along, a seek bar (arrows step a second,
 * , and . a frame), the time, and Start/End pins when the app passes onStart/onEnd. The video itself stays where the
 * app put it; a click on it plays or pauses. A file that won't play shows why, with Try again.
 */
export function scrubber(video, opts = {}) {
  adoptStyles();
  const n = opts.frames ?? 10;
  const pins = { start: opts.start ?? null, end: opts.end ?? null };
  const keys = opts.pinKeys === false ? {} : { start: 's', end: 'e', ...opts.pinKeys }; // a key given as null (or left out of false) is no key
  const keyTip = (which) => (keys[which] ? ` (${keys[which].toUpperCase()})` : '');
  const stopAtEnd = opts.stopAtEnd !== false;
  let dur = Number.isFinite(video.duration) ? video.duration : (opts.duration ?? 0);
  let broken = false;
  video.controls = false;
  video.classList.add('cui-scrub-video');

  const play = el('button', { type: 'button', class: 'cui-scrub-play', 'aria-label': 'Play', 'data-tip': 'Play or pause (Space)' }, playIcon(false));
  const mute = el('button', { type: 'button', class: 'cui-btn cui-ghost cui-small cui-icon cui-scrub-mute', 'aria-label': 'Unmute', 'aria-pressed': 'false', 'data-tip': 'Sound on or off (M)' });
  const frames = el('div', { class: 'cui-scrub-frames', role: 'group', 'aria-label': 'Frames' });
  const cells = [];
  for (let i = 0; i < n; i++) {
    const small = el('canvas', { width: 160, height: 90, 'aria-hidden': 'true' });
    const big = el('canvas', { width: 160, height: 90, 'aria-hidden': 'true' });
    const label = el('span');
    const b = el('button', { type: 'button', class: 'cui-scrub-frame' }, small, el('span', { class: 'cui-scrub-pop' }, big, label));
    cells.push({ b, small, big, label });
    frames.append(b);
  }
  const range = el('input', { type: 'range', class: 'cui-scrub-range', min: 0, max: 1, step: 'any', value: 0, 'aria-label': 'Seek' });
  const marks = svg('svg', { class: 'cui-scrub-pins', 'aria-hidden': 'true' });
  const main = el('div', { class: 'cui-scrub-main' }, n ? frames : '', range, marks);
  const time = el('span', { class: 'cui-scrub-time', 'aria-hidden': 'true' });
  const acts = el('div', { class: 'cui-scrub-acts' }, time, mute);
  const pinButton = (which, name) => el('button', { type: 'button', class: 'cui-btn cui-small cui-scrub-pin', 'data-tip': `Pin the ${name} here; the file is never trimmed` }, `⚑ ${name} here`);
  const clearButton = el('button', { type: 'button', class: 'cui-btn cui-small cui-ghost', 'data-tip': 'Take the pins off' }, 'Clear');
  const startBtn = opts.onStart ? pinButton('start', 'Start') : null;
  const endBtn = opts.onEnd ? pinButton('end', 'End') : null;
  if (startBtn) acts.append(startBtn);
  if (endBtn) acts.append(endBtn);
  if (startBtn || endBtn) acts.append(clearButton);
  const retry = el('button', { type: 'button', class: 'cui-btn cui-small' }, 'Try again');
  const fail = el('div', { class: 'cui-notice cui-scrub-fail', 'data-tone': 'danger', role: 'alert', hidden: true }, "This video won't play here: this browser can't decode it, or the file is missing. ", retry);
  const root = el('div', { class: 'cui-scrubber' }, play, main, acts, fail);

  const at = (frac) => frac * dur;
  const ms = (s) => Math.round(s * 1000);
  let held = false;
  function draw() {
    const t = video.currentTime || 0;
    if (!held) range.value = String(t); // not under a dragging finger, or the thumb jumps back to the last decoded frame
    range.max = String(dur || 1);
    range.setAttribute('aria-valuetext', `${clock(t)} of ${clock(dur)}`);
    time.textContent = `${clock(t)} / ${clock(dur)}`;
    cells.forEach((c, i) => {
      const ft = at(i / n);
      c.b.classList.toggle('cui-past', ft <= t);
      c.b.setAttribute('aria-label', `Go to ${clock(ft)}`);
      c.label.textContent = clock(ft);
    });
    const playing = !video.paused && !video.ended;
    if (play.getAttribute('aria-label') !== (playing ? 'Pause' : 'Play') || !play.firstChild) play.replaceChildren(playIcon(playing));
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (mute.getAttribute('aria-label') !== (video.muted ? 'Unmute' : 'Mute') || !mute.firstChild) mute.replaceChildren(speaker(video.muted));
    mute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    mute.setAttribute('aria-pressed', String(!video.muted));
    for (const b of [play, range, mute, startBtn, endBtn, ...cells.map((c) => c.b)]) if (b) b.disabled = broken;
    clearButton.disabled = broken || (pins.start == null && pins.end == null);
    if (startBtn) startBtn.setAttribute('data-tip', `${pins.start == null ? 'Pin the Start here' : `Start is at ${clock(pins.start / 1000)}: move it here`}; the file is never trimmed${keyTip('start')}`);
    if (endBtn) endBtn.setAttribute('data-tip', `${pins.end == null ? 'Pin the End here' : `End is at ${clock(pins.end / 1000)}: move it here`}; the file is never trimmed${keyTip('end')}`);
    fail.hidden = !broken;
    drawPins();
  }
  // Pins and the trimmed-off ends, in percentages so the strip can be any width (SVG attributes, not styles).
  function drawPins() {
    marks.replaceChildren();
    if (!dur) return;
    const pct = (v) => `${(Math.min(1, Math.max(0, v / 1000 / dur)) * 100).toFixed(3)}%`;
    const top = 0;
    const band = n ? frames.offsetHeight : 0; // 34 px, 40 on a phone
    if (pins.start != null && band) marks.append(svg('rect', { x: 0, y: top, width: pct(pins.start), height: band }));
    if (pins.end != null && band) marks.append(svg('rect', { x: pct(pins.end), y: top, width: `${100 - parseFloat(pct(pins.end))}%`, height: band }));
    for (const [which, name] of [
      ['start', 'Start'],
      ['end', 'End'],
    ]) {
      const v = pins[which];
      if (v == null) continue;
      const x = pct(v);
      const f = parseFloat(x) / 100;
      marks.append(svg('line', { x1: x, x2: x, y1: 0, y2: '100%' }));
      // The label sits on the line's open side, and turns back before running off the end.
      const right = which === 'start' ? f < 0.75 : f < 0.25;
      const text = `${name} ${clock(v / 1000)}`;
      const w = text.length * 6 + 8; // 10 px mono is 6 px a character; the chip is 4 px wider each side
      marks.append(svg('rect', { class: 'cui-scrub-chip', x, y: 0, width: w, height: 13, rx: 3, transform: `translate(${right ? 1 : -1 - w} 0)` }));
      const label = svg('text', { x, y: 10, dx: right ? 5 : -5, 'text-anchor': right ? 'start' : 'end' });
      label.textContent = text;
      marks.append(label);
    }
  }

  // user: a person's own move (the bar, the strip, keys), which onUser hears of; the methods the app calls are quiet.
  function seek(sec, user = false) {
    if (broken) return;
    const t = Math.min(Math.max(0, sec), dur || sec);
    video.currentTime = t;
    draw();
    if (user) opts.onUser?.('seek', t);
  }
  function toggle(user = false) {
    if (broken) return;
    if (!video.paused && !video.ended) {
      video.pause();
      if (user) opts.onUser?.('pause');
      return;
    }
    // At (or past) the End pin, play starts again from the Start; with a Start and no End, from the clip's end.
    const t = video.currentTime || 0;
    const over = pins.end != null ? stopAtEnd && t >= pins.end / 1000 - 0.05 : pins.start != null && !!dur && t >= dur - 0.05;
    if (over) video.currentTime = (pins.start ?? 0) / 1000;
    video.play()?.catch?.((e) => {
      if (e?.name === 'NotSupportedError') {
        broken = true;
        draw();
      }
    }); // AbortError: a pause cut it short
    if (user) opts.onUser?.('play');
  }
  const step = (sec, user = false) => seek((video.currentTime || 0) + sec, user);
  function setPin(which) {
    const v = ms(video.currentTime || 0);
    const other = which === 'start' ? 'end' : 'start';
    const crosses = pins[other] != null && (which === 'start' ? v >= pins[other] : pins[other] >= v);
    if (crosses && opts.order === 'refuse') return void opts.onRefuse?.(which, v); // the old pins stay
    pins[which] = v;
    // Two pins the wrong way round: the other one goes.
    if (pins.start != null && pins.end != null && pins.start >= pins.end) {
      pins[other] = null;
      (other === 'start' ? opts.onStart : opts.onEnd)?.(null);
    }
    draw();
    (which === 'start' ? opts.onStart : opts.onEnd)?.(v);
  }
  function clear() {
    if (pins.start != null && opts.onStart) {
      pins.start = null;
      opts.onStart(null);
    }
    if (pins.end != null && opts.onEnd) {
      pins.end = null;
      opts.onEnd(null);
    }
    draw();
  }

  // Frames: from the app's sprite (one strip of n frames side by side), or read from the clip itself.
  function paint(source, sx, sy, sw, sh) {
    return (c) => {
      for (const cv of [c.small, c.big]) {
        cv.width = Math.max(1, Math.round(90 * (sw / sh)));
        cv.height = 90;
        try {
          cv.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        } catch {}
      }
    };
  }
  let capture = null;
  function loadFrames() {
    if (!n) return;
    if (opts.sprite) {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth / n;
        cells.forEach((c, i) => paint(img, i * w, 0, w, img.naturalHeight)(c));
      };
      img.src = opts.sprite;
      return;
    }
    const src = video.currentSrc || video.src;
    if (!src || capture) return;
    capture = document.createElement('video');
    capture.muted = true;
    capture.preload = 'auto';
    capture.playsInline = true;
    if (video.crossOrigin != null) capture.crossOrigin = video.crossOrigin;
    let i = 0;
    const next = () => {
      if (i >= n || (!root.isConnected && i > 0)) return void capture.removeAttribute('src');
      if (!Number.isFinite(capture.duration)) return; // a live stream has no length to cut frames from
      capture.currentTime = Math.min(capture.duration - 0.05, ((i + 0.5) * capture.duration) / n);
    };
    capture.addEventListener('loadeddata', next, { once: true });
    capture.addEventListener('seeked', () => {
      const c = cells[i++];
      if (c && capture.videoWidth) paint(capture, 0, 0, capture.videoWidth, capture.videoHeight)(c);
      next();
    });
    capture.src = src;
  }

  const onMeta = () => {
    if (Number.isFinite(video.duration)) dur = video.duration;
    if (pins.start != null && opts.seekToStart !== false && (video.currentTime || 0) < 0.01) video.currentTime = pins.start / 1000;
    loadFrames();
    draw();
  };
  const onTime = () => {
    // Playing up to the End pin stops there.
    if (stopAtEnd && pins.end != null && !video.paused && video.currentTime >= pins.end / 1000) {
      video.pause();
      video.currentTime = pins.end / 1000;
    }
    draw();
  };
  const onError = () => {
    broken = true;
    draw();
  };
  const onClick = () => toggle(true);
  const listeners = [
    ['loadedmetadata', onMeta],
    ['durationchange', onMeta],
    ['timeupdate', onTime],
    ['seeked', draw],
    ['play', draw],
    ['pause', draw],
    ['ended', draw],
    ['volumechange', draw],
    ['error', onError],
    ['click', onClick],
  ];
  for (const [ev, fn] of listeners) video.addEventListener(ev, fn);
  // A <source> child that fails says so on itself, not on the video.
  for (const s of video.querySelectorAll('source')) s.addEventListener('error', onError);

  play.addEventListener('click', () => toggle(true));
  mute.addEventListener('click', () => {
    video.muted = !video.muted;
  });
  range.addEventListener('input', () => seek(Number(range.value), true));
  range.addEventListener('pointerdown', () => {
    held = true;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    range.addEventListener(type, () => {
      held = false;
      draw();
    });
  range.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation(); // the lightbox's ←/→ are for the next picture, not this bar
      step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1), true);
    }
  });
  retry.addEventListener('click', () => {
    broken = false;
    draw();
    video.load();
  });
  if (startBtn) startBtn.addEventListener('click', () => setPin('start'));
  if (endBtn) endBtn.addEventListener('click', () => setPin('end'));
  clearButton.addEventListener('click', clear);
  // The strip: a press and drag seeks to the pointer; a frame pressed from the keyboard goes to its own time.
  let dragging = false;
  const toPointer = (e) => {
    const r = frames.getBoundingClientRect();
    if (r.width) seek(at(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))), true);
  };
  frames.addEventListener('pointerdown', (e) => {
    if (broken || e.button !== 0) return;
    dragging = true;
    frames.setPointerCapture?.(e.pointerId);
    toPointer(e);
  });
  frames.addEventListener('pointermove', (e) => {
    if (dragging) toPointer(e);
  });
  const stop = () => {
    dragging = false;
  };
  frames.addEventListener('pointerup', stop);
  frames.addEventListener('pointercancel', stop);
  cells.forEach((c, i) =>
    c.b.addEventListener('click', (e) => {
      if (e.detail === 0) seek(at(i / n), true);
    }),
  );
  // Keys while focus is in the bar: Space plays, , and . step a frame, M mutes, S and E (pinKeys) pin.
  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    const onButton = e.target.closest?.('button');
    if (e.key === ' ' && !onButton) toggle(true);
    else if (e.key === ',' || e.key === '.') step(e.key === ',' ? -1 / 30 : 1 / 30, true);
    else if (e.key === 'm' || e.key === 'M') video.muted = !video.muted;
    else if (startBtn && keys.start && e.key.toLowerCase() === keys.start.toLowerCase()) setPin('start');
    else if (endBtn && keys.end && e.key.toLowerCase() === keys.end.toLowerCase()) setPin('end');
    else return;
    e.preventDefault();
  });

  if (video.readyState >= 1) onMeta();
  else draw();
  if (video.error) onError();

  return {
    el: root,
    video,
    toggle: () => toggle(),
    seek: (sec) => seek(sec),
    step: (sec) => step(sec),
    update(next = {}) {
      if ('start' in next) pins.start = next.start ?? null;
      if ('end' in next) pins.end = next.end ?? null;
      draw();
    },
    setStart: () => setPin('start'),
    setEnd: () => setPin('end'),
    destroy() {
      for (const [ev, fn] of listeners) video.removeEventListener(ev, fn);
      video.classList.remove('cui-scrub-video');
      capture?.removeAttribute('src');
      root.remove();
    },
  };
}

// ———————————————————————————————————————————————————————— the panner

const DIRS = [
  ['auto', 'Pan: there and back'],
  ['ltr', 'Pan: left to right'],
  ['rtl', 'Pan: right to left'],
  ['off', 'Pan: off'],
];

/**
 * A panorama in its box: it pans end to end and back (16 s a way), with a mini-map of the window, Pause, a
 * look-around slider, and a direction menu when the app passes onPan. Reduced motion, a swipe or a scroll pause it.
 * A picture that fits its box shows whole, without the bar. The img moves into the part, which takes its place.
 */
export function panner(img, opts = {}) {
  adoptStyles();
  let dir = opts.pan ?? 'auto';
  const ms = opts.duration ?? 16_000;
  let paused = dir === 'off' || reduceMotion();
  // phase runs 0→1 (left to right), then 1→2 (back).
  let phase = dir === 'rtl' ? 1 : dir === 'off' ? 0.5 : 0;

  const view = el('div', { class: 'cui-pan-view', tabindex: '-1' });
  const label = el('span', { class: 'cui-pan-label', text: opts.label ?? 'Panorama · pans end to end, Space pauses' });
  const map = svg('svg', { class: 'cui-pan-map', viewBox: '0 0 1000 100', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Where the view is in the panorama' });
  const pic = svg('image', { x: 0, y: 0, width: 1000, height: 100, preserveAspectRatio: 'none' });
  const shadeL = svg('rect', { class: 'cui-pan-shade', x: 0, y: 0, width: 0, height: 100 });
  const shadeR = svg('rect', { class: 'cui-pan-shade', x: 1000, y: 0, width: 0, height: 100 });
  const win = svg('rect', { class: 'cui-pan-win', x: 0, y: 1, width: 250, height: 98, 'vector-effect': 'non-scaling-stroke' });
  map.append(pic, shadeL, shadeR, win);
  const pause = el('button', { type: 'button', class: 'cui-btn cui-small cui-icon', 'data-tip': 'Pause or pan (Space)' });
  const look = el('input', { type: 'range', class: 'cui-pan-look', min: 0, max: 1000, value: 0, 'aria-label': 'Look around' });
  const pick = opts.onPan ? el('select', { class: 'cui-input cui-pan-dir', 'aria-label': 'Pan direction' }, ...DIRS.map(([v, t]) => el('option', { value: v, text: t }))) : null;
  if (pick) pick.value = dir;
  const bar = el('div', { class: 'cui-pan-bar' }, label, map, pause, look, pick ?? '');
  // The app's own layer over the picture, above the bar; presses pass through it (an app's controls on it opt back in).
  const overlay = el('div', { class: 'cui-pan-over' });
  const root = el('div', { class: 'cui-panner' }, el('div', { class: 'cui-pan-stage' }, view, overlay), bar);
  if (img.parentNode) img.replaceWith(root);
  view.append(img);
  img.draggable = false;

  const sync = () => pic.setAttribute('href', img.currentSrc || img.src);
  let fits = false;
  let barH = 0;
  let told = null; // the last fits the app heard
  function fit() {
    const w = img.naturalWidth || 4;
    const h = img.naturalHeight || 1;
    // Judged at the size with the bar showing: a picture that fits hides the bar, which makes the view taller, and measuring that
    // would flip it back (and flicker, and tell onFit over and over).
    if (!fits) barH = bar.offsetHeight;
    const box = view.clientWidth / Math.max(1, view.clientHeight - (fits ? barH : 0));
    fits = !!view.clientWidth && w / h <= box * 1.02;
    root.classList.toggle('cui-pan-fits', fits);
    if (img.naturalWidth && fits !== told) opts.onFit?.((told = fits));
    const f = Math.min(1, box / (w / h));
    win.setAttribute('width', String(Math.max(4, f * 1000)));
  }
  let set = -1; // the scrollLeft this part last set, so a person's own scroll can be told apart
  function place(pos) {
    const room = view.scrollWidth - view.clientWidth;
    if (room > 0) {
      set = Math.round(pos * room);
      view.scrollLeft = set;
    }
    const w = Number(win.getAttribute('width'));
    const x = pos * (1000 - w);
    win.setAttribute('x', String(x));
    shadeL.setAttribute('width', String(x));
    shadeR.setAttribute('x', String(x + w));
    shadeR.setAttribute('width', String(Math.max(0, 1000 - x - w)));
    look.value = String(Math.round(pos * 1000));
  }
  const posOf = () => {
    const p = phase < 1 ? phase : 2 - phase;
    return (1 - Math.cos(Math.PI * p)) / 2;
  };
  function drawPause() {
    pause.textContent = paused ? '▶' : '❚❚';
    pause.setAttribute('aria-label', paused ? 'Pan' : 'Pause the pan');
  }
  // person: a press, scroll or tap of the person's own, which onPause hears of when it changes the state.
  function setPaused(p, person = false) {
    const was = paused;
    paused = p;
    drawPause();
    if (person && was !== p) opts.onPause?.(p);
  }
  // Look at a spot (0 left … 1 right): it pauses, and a pan from here starts from here.
  function lookAt(v, person = false) {
    setPaused(true, person);
    phase = Math.acos(1 - 2 * Math.min(1, Math.max(0, v))) / Math.PI;
    place(posOf());
  }

  let raf = 0;
  let last = 0;
  let seen = false;
  let legs = 0;
  function tick(now) {
    if (!root.isConnected) {
      if (seen) return;
    } else seen = true; // dropped from the page: stop
    if (!paused && !fits && last) {
      const next = phase + (now - last) / ms;
      if (Math.floor(next) > Math.floor(phase)) {
        // A leg (0→1, 1→2) ended: once, it stops on the end.
        opts.onLeg?.(++legs);
        if (opts.once) {
          phase = Math.floor(next) % 2;
          setPaused(true);
        } else phase = next % 2;
      } else phase = next;
      opts.onProgress?.(phase % 1 || (paused ? 1 : 0));
    }
    last = now;
    if (!fits) place(posOf());
    raf = requestAnimationFrame(tick);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  ro?.observe(view);
  img.addEventListener('load', () => {
    sync();
    fit();
  });
  if (img.complete) {
    sync();
    fit();
  }
  view.addEventListener('scroll', () => {
    if (set >= 0 && Math.abs(view.scrollLeft - set) <= 1) return;
    const room = view.scrollWidth - view.clientWidth;
    if (room > 0) lookAt(view.scrollLeft / room, true);
  });
  view.addEventListener('pointerdown', () => setPaused(true, true));
  pause.addEventListener('click', () => setPaused(!paused, true));
  look.addEventListener('input', () => lookAt(Number(look.value) / 1000, true));
  let dragging = false;
  const toPointer = (e) => {
    const r = map.getBoundingClientRect();
    const w = Number(win.getAttribute('width')) / 1000;
    if (r.width) lookAt(((e.clientX - r.left) / r.width - w / 2) / Math.max(0.001, 1 - w), true);
  };
  map.addEventListener('pointerdown', (e) => {
    dragging = true;
    map.setPointerCapture?.(e.pointerId);
    toPointer(e);
  });
  map.addEventListener('pointermove', (e) => {
    if (dragging) toPointer(e);
  });
  map.addEventListener('pointerup', () => {
    dragging = false;
  });
  map.addEventListener('pointercancel', () => {
    dragging = false;
  });
  pick?.addEventListener('change', () => {
    dir = pick.value;
    if (dir === 'off') lookAt(0.5);
    else {
      phase = dir === 'rtl' ? 1 : 0;
      setPaused(reduceMotion());
    }
    opts.onPan(dir);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || e.target.closest?.('button, select')) return;
    e.preventDefault();
    setPaused(!paused, true);
  });
  drawPause();
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);

  return {
    el: root,
    img,
    overlay,
    get fits() {
      return fits;
    },
    toggle: () => setPaused(!paused),
    play: () => setPaused(false),
    pause: () => setPaused(true),
    look: (v) => lookAt(v),
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      root.replaceWith(img);
    },
  };
}

// ———————————————————————————————————————————————————————— the lightbox

const kindOf = (item) => item.kind ?? (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(item.src) ? 'video' : 'image');

/** What the lightbox shows for an item unless the app passes render: a picture (whole; panned when wide and the app opted in) or a clip with the scrubber. */
function show(item, stage, opts) {
  if (kindOf(item) === 'video') {
    const auto = !!opts.autoplay;
    const v = el('video', { src: item.src, poster: item.poster, preload: auto ? 'auto' : 'metadata', playsinline: true, autoplay: auto, muted: auto, loop: auto, 'aria-label': item.alt ?? item.caption ?? 'Video' });
    v.muted = auto; // the attribute alone doesn't always count as muted for autoplay
    stage.append(v);
    const s = scrubber(v, { start: item.start, end: item.end, sprite: item.sprite, onStart: item.onStart, onEnd: item.onEnd });
    stage.append(s.el);
    return s;
  }
  const img = el('img', { src: item.src, alt: item.alt ?? item.caption ?? '', class: item.rotate ? `cui-r${item.rotate}` : null });
  stage.append(img);
  // Panning is opt-in: the lightbox's `pan: true`, or the item's own pan direction or onPan. Otherwise the picture shows whole.
  if (item.rotate || opts.pan === false || !(opts.pan === true || item.pan || item.onPan)) return null;
  // An opted-in picture twice as wide as tall pans when it doesn't fit its box (the panner shows it whole when it does).
  const ctl = { toggle() {} };
  const wide = () => {
    if (img.isConnected && img.naturalWidth >= 2 * img.naturalHeight) Object.assign(ctl, panner(img, { pan: item.pan, onPan: item.onPan }));
  };
  if (img.complete && img.naturalWidth) wide();
  else img.addEventListener('load', wide, { once: true });
  return ctl;
}

/**
 * Pictures and clips one at a time: ‹ › on the edges, a filmstrip with the count, ←/→ and a swipe to step, Space to
 * play the clip or pause the pan. With `into` it draws inside that element; without, it opens in the kit dialog.
 */
export function lightbox(items, opts = {}) {
  adoptStyles();
  let at = Math.min(Math.max(0, opts.at ?? 0), Math.max(0, items.length - 1));
  let current = null;
  const stage = el('div', { class: 'cui-lb-stage' });
  const prev = el('button', { type: 'button', class: 'cui-lb-step cui-lb-prev', 'aria-label': 'Previous', 'data-tip': 'Previous (←)' }, icon('M10 3L5 8l5 5'));
  const next = el('button', { type: 'button', class: 'cui-lb-step cui-lb-next', 'aria-label': 'Next', 'data-tip': 'Next (→)' }, icon('M6 3l5 5-5 5'));
  const count = el('span', { class: 'cui-lb-count', 'aria-live': 'polite' });
  const strip = el('ol', { class: 'cui-lb-strip', 'aria-label': opts.label ?? 'Pictures and clips' });
  const thumbs = items.map((item, i) => {
    const video = kindOf(item) === 'video';
    const name = item.alt ?? item.caption ?? (video ? 'Video' : 'Picture');
    const pic = video && !item.thumb && !item.poster ? el('video', { src: `${item.src}#t=0.1`, preload: 'metadata', muted: true, playsinline: true, 'aria-hidden': 'true' }) : el('img', { src: item.thumb ?? item.poster ?? item.src, alt: '', loading: 'lazy', class: item.rotate ? `cui-r${item.rotate}` : null });
    const b = el('button', { type: 'button', class: 'cui-lb-thumb', 'aria-label': `${i + 1}: ${name}` }, pic, video ? el('span', { class: 'cui-lb-badge', 'aria-hidden': 'true', text: '▶' }) : '');
    b.addEventListener('click', () => move(i));
    strip.append(el('li', {}, b));
    return b;
  });
  const foot = el('div', { class: 'cui-lb-foot' }, count, strip);
  const root = el('div', { class: `cui-lb${items.length < 2 ? ' cui-lb-one' : ''}` }, stage, foot);
  let title = null;
  let dialog = null;
  if (opts.into) opts.into.append(root);
  else {
    // The kit dialog (#872), which also closes it on a backdrop click.
    dialog = openDialog({
      title: '',
      className: 'cui-lightbox',
      body: root,
      onClose: () => {
        stop();
        opts.onClose?.();
      },
    });
    title = dialog.querySelector('.cui-dialog-head > h2');
  }

  function stop() {
    for (const v of stage.querySelectorAll('video')) v.pause();
    current?.destroy?.();
    current = null;
  }
  function go(i) {
    if (!items.length) return;
    i = (i + items.length) % items.length;
    stop();
    at = i;
    stage.replaceChildren();
    const item = items[i];
    current = (opts.render ? opts.render(item, stage, i, () => show(item, stage, opts)) : show(item, stage, opts)) ?? null;
    if (items.length > 1) stage.append(prev, next);
    count.textContent = `${i + 1} / ${items.length}`;
    thumbs.forEach((b, k) => b.setAttribute('aria-current', String(k === i)));
    thumbs[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // One item has no count to give: its caption (or alt) alone names it.
    const n = items.length > 1 ? `${i + 1} / ${items.length}` : '';
    // The heading names the dialog, so a lone picture with no caption or alt is still called something.
    if (title) title.textContent = [item.caption ?? (n ? null : item.alt), n].filter(Boolean).join(' · ') || 'Picture';
  }
  // A person's move: the app hears of it (to update its URL, say). go() from the app stays quiet.
  function move(i) {
    if (items.length < 2) return;
    go(i);
    opts.onChange?.(at, items[at]);
  }
  prev.addEventListener('click', () => move(at - 1));
  next.addEventListener('click', () => move(at + 1));

  const onKey = (e) => {
    if (!root.isConnected) return void removeEventListener('keydown', onKey);
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    // Inside another dialog than this one's own (the app's), the keys aren't ours.
    const modal = e.target.closest?.('dialog');
    if (modal && !modal.contains(root)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target.closest?.('input[type=range]')) return;
      e.preventDefault();
      move(at + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === ' ' && current?.toggle && !e.target.closest?.('button, input, select, a')) {
      e.preventDefault();
      current.toggle();
    }
  };
  if (opts.keys !== false) addEventListener('keydown', onKey);

  // A swipe across the stage on a touch screen steps; the panner's own swipe looks around instead. A second finger
  // is a pinch, and one finger on a zoomed-in page pans it.
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    const zoomed = (window.visualViewport?.scale ?? 1) > 1.01; // a page at rest can report a hair over 1
    swipe = e.pointerType === 'touch' && e.isPrimary && !zoomed && !e.target.closest?.('.cui-pan-view, .cui-scrubber') ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  });
  stage.addEventListener('pointercancel', () => {
    swipe = null;
  });
  stage.addEventListener('pointerup', (e) => {
    const s = swipe;
    if (!s || e.pointerId !== s.id) return;
    swipe = null;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 60 && Math.abs(e.clientY - s.y) < Math.abs(dx) / 2) move(at + (dx < 0 ? 1 : -1));
  });

  go(at);
  return {
    el: dialog ?? root,
    get at() {
      return at;
    },
    get current() {
      return current;
    },
    go,
    next: () => go(at + 1),
    prev: () => go(at - 1),
    close() {
      if (dialog?.open) dialog.close();
      else this.destroy();
    },
    destroy() {
      stop();
      removeEventListener('keydown', onKey);
      (dialog ?? root).remove();
    },
  };
}
