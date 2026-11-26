// "Point at something" (#1141, Josh picked the takes on 2026-11-19): the page dims, the person clicks or taps the thing
// they mean, and the chat's message box gets a crop of it (pick-crop.js) and a chip naming the page, the part, the screen
// size and the theme, whose text goes with the message. Started by the 🎯 beside Attach (composer.js), the overview
// drawer's line on a phone (project.js) or Alt+Shift+P anywhere. From a page with no chat, it goes to the scheme's
// Taskmaster (Josh, Q2). The right-click menu's "Point at this" and "Point and draw…" (context-menu.js, #1663) skip the
// dim and point at what was right-clicked, through pointAtElement(). An app in Citadel's frame points through its own
// menu (app-menu.js, #1665), which sends what it pointed at here. In the desktop app the crop is a screenshot of the
// window (desktop/main.cjs capturePage), exact even inside an app's frame.
import { h, taskmasterName, threadHref, view } from './base.js';
import { toast } from './ui/status.js';
import { PICKABLE, cropBox, cropPart, describePart } from './pick-crop.js';
import { pointAt } from './composer.js';
import { FRAME } from './rail.js';

export { PICKABLE };

/** @import { Ticket, View } from './types.js' */
/**
 * @typedef {{ left: number, top: number, width: number, height: number }} Box
 * @typedef {{ capture?: (box: Box) => Promise<Uint8Array<ArrayBuffer>>, inspect?: (x: number, y: number) => void }} DesktopBridge
 */

/** The desktop app's bridge (desktop/preload.cjs); absent in a browser. */
const desktopBridge = /** @type {{ citadelDesktop?: DesktopBridge }} */ (/** @type {unknown} */ (window)).citadelDesktop;

/** @type {{ stop: () => void } | null} */
let active = null;

/** The chat a pick goes to, now: this chat, or the scheme's Taskmaster from a page with no chat. Null (and a toast) with neither. */
function target() {
  const chatId = view?.main === 'chat' ? view.id : view?.coordinator?.id;
  if (!chatId) {
    toast('Open a scheme first: what you point at goes to one of its chats', { tone: 'warn' });
    return null;
  }
  const v = /** @type {View} */ (view); // chatId is set only when view is
  const coordinator = chatId === v.coordinator?.id ? v.coordinator : null;
  return { chatId, coordinator, ticket: coordinator ?? v.ticket };
}

/**
 * Point at `el` with no dim step (the right-click menu, #1663); `draw` opens its crop in the drawing tools.
 * @param {Element} el
 * @param {{ draw?: boolean }} [opts]
 */
export function pointAtElement(el, { draw = false } = {}) {
  const to = target();
  if (to) deliver(el, to.chatId, to.coordinator, draw);
}

export function startPick() {
  if (active) return;
  // Where it goes is settled now, so a pick on a page that changes underneath still lands in the chat it began from.
  const to = target();
  if (!to) return;
  const { chatId, coordinator } = to;
  const box = h('div', { class: 'pick-box', hidden: true });
  const hint = h('div', { class: 'pick-hint', role: 'status' }, h('span', {}, matchMedia('(hover: hover)').matches ? 'Click the thing you mean' : 'Tap the thing you mean'), h('button', { type: 'button', class: 'secondary small', onclick: () => stop() }, 'Cancel'));
  // The dim catches every press, so nothing under it acts on the click that picks.
  const dim = h('div', { class: 'pick-dim' });
  document.body.append(dim, box, hint);
  /**
   * @param {number} x
   * @param {number} y
   */
  const under = (x, y) => {
    const el = document.elementsFromPoint(x, y).find((e) => e !== dim && e !== box && !hint.contains(e));
    return el && el !== document.documentElement && el !== document.body ? (el.closest(PICKABLE) ?? el) : null;
  };
  /** @param {Element | null} el */
  const show = (el) => {
    box.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    for (const [k, v] of Object.entries({ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 })) box.style.setProperty(k, `${v}px`);
  };
  /** @param {PointerEvent} e */
  const onMove = (e) => {
    if (e.pointerType === 'mouse') {
      show(under(e.clientX, e.clientY));
      /** @type {ChildNode} */ (hint.firstChild).textContent = 'Click the thing you mean';
    }
    // Keep the hint off what the pointer is near: top unless the pointer's up there.
    hint.classList.toggle('low', e.clientY < 96);
  };
  /** @param {PointerEvent} e */
  const onUp = (e) => {
    if (e.button !== 0) return;
    pick(e);
  };
  let picked = false; // a double-click's second press lands inside the 300 ms the dim stays
  /** @param {MouseEvent} e */
  const pick = (e) => {
    e.preventDefault();
    if (picked) return;
    const el = under(e.clientX, e.clientY);
    if (!el) return;
    picked = true;
    show(el);
    // The dim stays a moment to take the click that follows a tap, so it can't reach what's under it. A screenshot
    // (the desktop app) would catch it and the box: they go see-through.
    if (capture) {
      dim.style.setProperty('background', 'transparent');
      box.hidden = true;
    }
    hint.remove();
    removeEventListener('keydown', onKey, true);
    setTimeout(stop, 300);
    deliver(el, chatId, coordinator);
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stop();
  };
  const stop = () => {
    dim.remove();
    box.remove();
    hint.remove();
    removeEventListener('keydown', onKey, true);
    active = null;
  };
  dim.addEventListener('pointermove', onMove);
  dim.addEventListener('pointerup', onUp);
  // The press that picks mustn't focus or click what's under the dim either.
  dim.addEventListener('pointerdown', (e) => e.preventDefault());
  dim.addEventListener('click', (e) => e.preventDefault());
  // A right-click while picking picks too (#1663), rather than opening a menu over the dim.
  dim.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    pick(e);
  });
  addEventListener('keydown', onKey, true);
  active = { stop };
}

/**
 * @param {Element} el
 * @param {number} chatId
 * @param {Ticket | null} coordinator
 * @param {boolean} [draw]
 */
async function deliver(el, chatId, coordinator, draw = false) {
  // The note is in the message box at once; the crop (a picture of the part, which takes a moment) joins it when ready.
  // It starts before anything moves, so it sees the page as it was picked; a screenshot is taken before anything moves.
  const cropping = capture ? captureBox(cropBox(el)) : cropPart(el);
  if (capture) await cropping;
  pointAt(chatId, null, describe(el));
  if (coordinator && !(view?.main === 'chat' && view.id === chatId)) location.hash = threadHref(coordinator);
  const crop = await cropping;
  if (crop) pointAt(chatId, crop, null, { draw });
}

/** The desktop app's screenshot of the window (preload.cjs), or null in a browser. */
const capture = desktopBridge?.capture ?? null;

/**
 * A PNG of `box` (the window's CSS pixels) from the desktop app, once the page has drawn without what just closed (the
 * menu); null if there's no box or it fails.
 * @param {Box | null} box
 */
async function captureBox(box) {
  if (!box) return null;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const png = await /** @type {NonNullable<typeof capture>} */ (capture)(box);
    return png?.byteLength ? new Blob([png], { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}

/** The chip's short label and the text the message carries: page, part, screen size, theme. */
/** @param {Element} el */
export const describe = (el) => describePart(/** @type {HTMLElement} */ (el), pageName(), location.hash || '#/');

export function pageName() {
  if (!view) return 'Citadel';
  if (view.main === 'chat') return view.id === view.coordinator?.id ? `${taskmasterName()}'s chat` : `#${view.ticket?.number ?? view.id}'s chat`;
  const main = typeof view.main === 'string' ? view.main : view.kind;
  return `${String(main ?? 'Citadel')
    .replace(/[-_]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())} page`;
}

/**
 * A framed app's menu (app-menu.js): `point` { note: { label, text }, draw, crop?: Blob, rect? }, with the app's own crop or,
 * in the desktop app, the part's place in the frame to screenshot; `inspect` { x, y } opens DevTools there (desktop app).
 * The chip goes to the chat under the frame (or the Taskmaster), which then shows.
 * @param {Record<string, number> | null | undefined} r
 */
const frameRect = (r) => (r && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(r[k])) ? r : null);
addEventListener('message', async (e) => {
  const frame = [.../** @type {NodeListOf<HTMLIFrameElement>} */ (document.querySelectorAll('#frames iframe'))].find((f) => f.contentWindow === e.source);
  const d = e.data;
  if (!frame || d?.protocol !== FRAME) return;
  const at = frame.getBoundingClientRect();
  if (d.type === 'inspect' && Number.isFinite(d.x) && Number.isFinite(d.y)) desktopBridge?.inspect?.(at.left + d.x, at.top + d.y);
  if (d.type !== 'point' || typeof d.note?.label !== 'string' || typeof d.note?.text !== 'string') return;
  const to = target();
  if (!to) return;
  const note = { label: d.note.label.slice(0, 200), text: d.note.text.slice(0, 2000) };
  const r = frameRect(d.rect);
  const crop = d.crop instanceof Blob && d.crop.type === 'image/png' ? d.crop : capture && r ? await captureBox({ left: at.left + r.left, top: at.top + r.top, width: r.width, height: r.height }) : null;
  pointAt(to.chatId, null, note);
  if (to.ticket) location.hash = threadHref(to.ticket);
  if (crop) pointAt(to.chatId, crop, null, { draw: !!d.draw });
});

// Alt+Shift+P anywhere starts it on a desktop; the drawer line and the 🎯 do on a phone.
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.repeat) {
    e.preventDefault();
    startPick();
  }
});
