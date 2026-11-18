// Drawing on an image waiting to send (#946): pen, arrow and box marks in red or yellow, drawn on a canvas at the
// picture's own size so thin lines stay readable when Claude sees it. It fills a lightbox stage (lightbox's
// opts.render) with the pen already on; Done hands back the marked canvas, closing without Done changes nothing.
import { h } from './base.js';
import { COLOURS, drawMark, lineWidth } from './ui/marks.js';

export { COLOURS, drawMark, lineWidth };

const TOOLS = [['pen', '✎', 'Pen'], ['arrow', '↗', 'Arrow'], ['box', '▭', 'Box']];

// The page's CSP refuses style attributes; a property set from script is allowed.
const swatch = (hex) => {
  const i = h('i', { class: 'swatch' });
  i.style.background = hex;
  return i;
};

/**
 * Fills `stage` with the picture and its drawing tools. `marks` (kept by the caller) start on it, so reopening
 * a marked picture can undo back to the clean one; a minion's marks (#960) come with `size`, the picture size they
 * were placed on, and are scaled to the picture as it loads. onDone(canvas, marks) runs on Done, with the marked picture
 * (null when every mark was undone); the caller closes the lightbox.
 */
export function annotator(stage, src, { marks = [], size = null, onDone, doneLabel = 'Done' }) {
  marks = [...marks];
  const s = { tool: 'pen', colour: 'red' };
  const canvas = h('canvas', { class: 'annotate-canvas', 'aria-label': 'Picture to draw on' });
  const g = canvas.getContext('2d');
  const img = new Image();
  let width = 3;
  const paint = () => {
    if (!img.naturalWidth) return;
    g.drawImage(img, 0, 0);
    for (const m of marks) drawMark(g, m, width);
  };
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    width = lineWidth(canvas.width, canvas.height);
    if (size && (size.w !== canvas.width || size.h !== canvas.height)) {
      const sx = canvas.width / size.w;
      const sy = canvas.height / size.h;
      marks = marks.map((m) => ({ ...m, pts: m.pts.map((p) => ({ x: p.x * sx, y: p.y * sy })) }));
    }
    paint();
    sync();
  };
  img.src = src;

  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  };
  let cur = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !img.naturalWidth) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    cur = { tool: s.tool, colour: s.colour, pts: [at(e)] };
    marks.push(cur);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return;
    if (cur.tool === 'pen') cur.pts.push(at(e));
    else cur.pts[1] = at(e);
    paint();
  });
  const end = () => {
    if (!cur) return;
    // A tap with no drag leaves no mark (a stray touch while reaching for a button).
    if (cur.pts.length < 2) marks.pop();
    cur = null;
    paint();
    sync();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // The lightbox's swipe-to-step listens on the stage; a stroke is not a swipe.
  canvas.addEventListener('pointerdown', (e) => e.stopPropagation());
  canvas.addEventListener('pointerup', (e) => e.stopPropagation());

  const choice = (label, title, pressed, onclick, extra) =>
    h('button', { type: 'button', class: 'cui-choice', title, 'aria-label': title, 'aria-pressed': String(pressed), onclick }, extra ?? label);
  const undo = h('button', { type: 'button', class: 'cui-btn cui-icon', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => { marks.pop(); paint(); sync(); } }, '↶');
  const clear = h('button', { type: 'button', class: 'cui-btn', onclick: () => { marks = []; paint(); sync(); } }, 'Clear');
  const done = h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: () => onDone(marks.length ? canvas : null, marks) }, doneLabel);
  const toolsEl = h('div', { class: 'cui-choices', role: 'group', 'aria-label': 'Tool' });
  const coloursEl = h('div', { class: 'cui-choices annotate-colours', role: 'group', 'aria-label': 'Colour' });
  const sync = () => {
    toolsEl.replaceChildren(...TOOLS.map(([t, label, title]) => choice(label, title, s.tool === t, () => { s.tool = t; sync(); })));
    coloursEl.replaceChildren(...Object.entries(COLOURS).map(([c, hex]) =>
      choice('', c[0].toUpperCase() + c.slice(1), s.colour === c, () => { s.colour = c; sync(); }, swatch(hex))));
    undo.disabled = clear.disabled = !marks.length;
  };
  sync();
  const bar = h('div', { class: 'annotate-bar' }, toolsEl, coloursEl, h('span', { class: 'annotate-gap' }), undo, clear, done);
  stage.append(h('div', { class: 'annotate-pic' }, canvas), bar);
  stage.classList.add('annotate');

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && canvas.isConnected) {
      e.preventDefault();
      undo.click();
    }
  };
  addEventListener('keydown', onKey);
  return {
    get marks() { return marks; },
    destroy() {
      removeEventListener('keydown', onKey);
      stage.classList.remove('annotate');
    },
  };
}

/**
 * Whether a picture can be drawn on and saved: one this server sends (or a blob or data URL). A picture from
 * another site would taint the canvas, so it only shows.
 */
export function drawable(src) {
  try {
    const u = new URL(src, location.href);
    return u.protocol === 'blob:' || u.protocol === 'data:' || u.origin === location.origin;
  } catch {
    return false;
  }
}

/** The marked picture as a PNG blob, for the message box (which shrinks it if it must, as a pasted one). */
export const canvasBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not save the marked picture'))), 'image/png'));
