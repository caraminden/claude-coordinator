// Citadel UI: marks on a picture. Served to apps as /apps/_citadel/ui/marks.js (types: marks.d.ts beside it).
// Like every file in public/ui/, standalone: no imports from outside ui/.
//
// Marks on a picture (#946, #960): pen, arrow and box (people's drawing) and numbered pins and short labels (a
// minion pointing at a screenshot). One look, drawn two ways: on a canvas while someone draws (drawMark), and as
// an SVG over a chat picture, from the marks a minion wrote in the image's title (marksTitle, markSvg).
//
// A marked image in markdown: ![alt](picture.png "marks 1280x900: box 71 4.5 80.5 8.5; arrow 52 20 70.5 7;
// pin 1 81.5 6.5; label 40 22 Fresh session; box yellow 10 10 20 20"). Numbers are percent of the picture's
// width and height, from its top left; the size is the picture's own, so lines and pins keep #946's weight.

export const COLOURS = { red: '#e5383b', yellow: '#ffd23f' };

/**
 * A line about 1/200 of the picture's longer edge: 10 px on a 2000 px screenshot, never under 3.
 * @type {typeof import('./marks.js').lineWidth}
 */
export const lineWidth = (w, h) => Math.max(3, Math.round(Math.max(w, h) / 200));

/** @import { Mark } from './marks.js' */
/** @typedef {{ x: number, y: number }} Point */

/** @param {unknown} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** @param {number} v */
const n1 = (v) => Math.round(v * 10) / 10;

// The shapes both drawings share, so a pin or a label looks the same on the canvas and over a chat picture.
/** @param {number} width */
const pinRadius = (width) => width * 3.2;
/** @param {number} width */
const labelFont = (width) => width * 3.6;
/**
 * A label's pill: as wide as its text at about 0.56 em a letter, half an em either side.
 * @param {string} text
 * @param {number} width
 */
const labelBox = (text, width) => {
  const fs = labelFont(width);
  return { fs, w: text.length * fs * 0.56 + fs, h: fs * 1.6 };
};
/**
 * An arrow's shaft end and head corners; the shaft stops short of the tip so its round cap doesn't poke through.
 * @param {Point} a
 * @param {Point} b
 * @param {number} width
 */
function arrowParts(a, b, width) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const head = width * 4.5;
  return {
    end: { x: b.x - head * 0.6 * Math.cos(ang), y: b.y - head * 0.6 * Math.sin(ang) },
    left: { x: b.x - head * Math.cos(ang - 0.45), y: b.y - head * Math.sin(ang - 0.45) },
    right: { x: b.x - head * Math.cos(ang + 0.45), y: b.y - head * Math.sin(ang + 0.45) },
  };
}
const FONT = 'system-ui, sans-serif';

/**
 * Draws one mark on a canvas: { tool, colour, pts: [{x, y}, …] } in image pixels; arrows and boxes use the first
 * and last point, pins ({ n }) and labels ({ text }) the first.
 * @type {typeof import('./marks.js').drawMark}
 */
export function drawMark(g, m, width) {
  g.strokeStyle = g.fillStyle = COLOURS[m.colour] ?? m.colour;
  g.lineWidth = width;
  g.lineCap = g.lineJoin = 'round';
  const a = m.pts[0];
  const b = m.pts[m.pts.length - 1];
  g.beginPath();
  if (m.tool === 'pen') {
    g.moveTo(a.x, a.y);
    for (const p of m.pts) g.lineTo(p.x, p.y);
    g.stroke();
  } else if (m.tool === 'box') {
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (m.tool === 'arrow') {
    const p = arrowParts(a, b, width);
    g.moveTo(a.x, a.y);
    g.lineTo(p.end.x, p.end.y);
    g.stroke();
    g.beginPath();
    g.moveTo(b.x, b.y);
    g.lineTo(p.left.x, p.left.y);
    g.lineTo(p.right.x, p.right.y);
    g.closePath();
    g.fill();
  } else if (m.tool === 'pin' || m.tool === 'label') {
    const pin = m.tool === 'pin';
    const text = String(pin ? m.n : m.text);
    const box = pin ? null : labelBox(text, width);
    if (pin) {
      g.arc(a.x, a.y, pinRadius(width), 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = width / 2;
      g.stroke();
    } else if (box) {
      g.roundRect(a.x - box.w / 2, a.y - box.h / 2, box.w, box.h, box.h / 2);
      g.fill();
    }
    g.fillStyle = m.colour === 'yellow' ? '#111' : '#fff';
    g.font = `700 ${box ? box.fs : pinRadius(width) * 1.25}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, a.x, a.y, box ? box.w - box.fs : undefined);
  }
}

/**
 * One mark as SVG, in image pixels, the same shapes as drawMark.
 * @type {typeof import('./marks.js').markSvg}
 */
export function markSvg(m, width) {
  const c = COLOURS[m.colour] ?? COLOURS.red;
  const ink = m.colour === 'yellow' ? '#111' : '#fff';
  const a = m.pts[0];
  const b = m.pts[m.pts.length - 1];
  /** @param {number} v */
  const r = (v) => n1(v);
  if (m.tool === 'box') {
    return `<rect x="${r(Math.min(a.x, b.x))}" y="${r(Math.min(a.y, b.y))}" width="${r(Math.abs(b.x - a.x))}" height="${r(Math.abs(b.y - a.y))}" fill="none" stroke="${c}" stroke-width="${width}" stroke-linejoin="round"/>`;
  }
  if (m.tool === 'arrow') {
    const p = arrowParts(a, b, width);
    return `<line x1="${r(a.x)}" y1="${r(a.y)}" x2="${r(p.end.x)}" y2="${r(p.end.y)}" stroke="${c}" stroke-width="${width}" stroke-linecap="round"/>` + `<polygon points="${r(b.x)},${r(b.y)} ${r(p.left.x)},${r(p.left.y)} ${r(p.right.x)},${r(p.right.y)}" fill="${c}"/>`;
  }
  /**
   * @param {number} size
   * @param {unknown} s
   * @param {number} [fit]
   */
  const text = (size, s, fit) => `<text x="${r(a.x)}" y="${r(a.y)}" fill="${ink}" font-family="${FONT}" font-weight="700" font-size="${r(size)}" text-anchor="middle" dominant-baseline="central"${fit ? ` textLength="${r(fit)}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(s)}</text>`;
  if (m.tool === 'pin') {
    const pr = pinRadius(width);
    return `<circle cx="${r(a.x)}" cy="${r(a.y)}" r="${r(pr)}" fill="${c}" stroke="#fff" stroke-width="${width / 2}"/>${text(pr * 1.25, m.n)}`;
  }
  if (m.tool === 'label') {
    const label = /** @type {string} */ (m.text); // a label has its words
    const box = labelBox(label, width);
    return `<rect x="${r(a.x - box.w / 2)}" y="${r(a.y - box.h / 2)}" width="${r(box.w)}" height="${r(box.h)}" rx="${r(box.h / 2)}" fill="${c}"/>${text(box.fs, label, label.length > 1 ? box.w - box.fs : 0)}`;
  }
  return '';
}

const KINDS = { box: 4, arrow: 4, pin: 3, label: 2 };
export const MAX_MARKS = 20;
export const MAX_LABEL = 40;

/**
 * The marks in an image title, or null when it isn't one: { w, h, marks } with marks in image pixels. A mark
 * it can't read is a wrong title, so the whole title is refused and the picture shows plain.
 * @type {typeof import('./marks.js').parseMarks}
 */
export function parseMarks(title) {
  const m = /^\s*marks\s+(\d{1,5})x(\d{1,5})\s*:(.*)$/s.exec(title ?? '');
  if (!m) return null;
  const w = +m[1];
  const h = +m[2];
  if (!w || !h) return null;
  /** @type {Mark[]} */
  const marks = [];
  for (const part of m[3]
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const words = part.split(/\s+/);
    const word = words.shift();
    if (word === undefined || !(word in KINDS)) return null;
    const tool = /** @type {keyof typeof KINDS} */ (word);
    const colour = /** @type {Mark['colour']} */ (words[0] === 'red' || words[0] === 'yellow' ? words.shift() : 'red');
    const nums = words.slice(0, KINDS[tool]).map(Number);
    if (nums.length < KINDS[tool] || nums.some((v) => !Number.isFinite(v))) return null;
    const pct = tool === 'pin' ? nums.slice(1) : nums;
    if (pct.some((v) => v < 0 || v > 100)) return null;
    /** @type {Point[]} */
    const pts = [];
    for (let i = 0; i < pct.length; i += 2) pts.push({ x: (pct[i] * w) / 100, y: (pct[i + 1] * h) / 100 });
    /** @type {Mark} */
    const mark = { tool, colour, pts };
    if (tool === 'pin') {
      if (!Number.isInteger(nums[0]) || nums[0] < 0 || nums[0] > 99) return null;
      mark.n = nums[0];
    }
    if (tool === 'label') {
      mark.text = words.slice(2).join(' ');
      if (!mark.text || mark.text.length > MAX_LABEL) return null;
    } else if (words.length > KINDS[tool]) return null;
    marks.push(mark);
  }
  return marks.length && marks.length <= MAX_MARKS ? { w, h, marks } : null;
}

/**
 * Marks back as an image title, the inverse of parseMarks (marks in image pixels of a w × h picture).
 * @type {typeof import('./marks.js').marksTitle}
 */
export function marksTitle(w, h, marks) {
  /** @param {Point} p */
  const pc = (p) => `${n1((p.x * 100) / w)} ${n1((p.y * 100) / h)}`;
  return `marks ${w}x${h}: ${marks.map((m) => [m.tool, m.colour === 'yellow' ? 'yellow' : '', m.tool === 'pin' ? m.n : '', ...(m.tool === 'pin' || m.tool === 'label' ? [pc(m.pts[0])] : [pc(m.pts[0]), pc(m.pts[m.pts.length - 1])]), m.tool === 'label' ? m.text : ''].filter((s) => s !== '').join(' ')).join('; ')}`;
}

/**
 * The SVG that lies over a w × h picture, drawn at the picture's own size and scaled with it.
 * @type {typeof import('./marks.js').marksOverlay}
 */
export function marksOverlay({ w, h, marks }) {
  const width = lineWidth(w, h);
  return `<svg class="cui-marks" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${marks.map((m) => markSvg(m, width)).join('')}</svg>`;
}
