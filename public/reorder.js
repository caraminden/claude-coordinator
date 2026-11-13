// Drag to reorder (#649, Josh 2026-11-13: "Can we make the scheme list reorderable? Click hold drag, same for
// the contraption list"): the schemes shelf (hidden.js) and the app rail (rail.js). One pointer-events path for
// mouse, pen and touch. A mouse picks the row up once it moves a few px held down; a finger or pen by holding still,
// and one that moves before the hold is a scroll, so a swipe still scrolls the list. Alt+Up and Alt+Down move the
// focused row, for a keyboard. The row follows the
// pointer, the rows it passes slide aside, a dashed slot marks where it will land, and onDrop says where it went; a plain click still opens it.
// Standalone like rail.js beside it, which contraptions load as /apps/_citadel/rail.js; the server imports inOrder.

const HOLD_MS = 350;
const SLOP = 8; // px a press may wander and still be a click, or a hold

/** `items` in `keys`' order: those it names first, as it orders them, then the rest as they came (a new one goes at the end). */
export function inOrder(items, keyOf, keys) {
  if (!keys?.length) return items;
  const at = new Map(keys.map((k, i) => [String(k), i]));
  const rank = (x) => at.get(String(keyOf(x))) ?? Infinity;
  return items.map((x, i) => [x, i]).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([x]) => x);
}

/** `keys` with the one at `from` moved to `to`. */
export function moved(keys, from, to) {
  const next = keys.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * Let people drag `list`'s rows into a new order. items() lists the rows that can move, in order (anything else in
 * the list, a heading or a collapsed Hidden section, stays put); carry(row) gives what moves with a row, like the
 * release lines under a scheme. onDrop(from, to) gets indexes into items(), only when the row changed place, and
 * must have redrawn the list in its new order by the time it returns (the keyboard's move refocuses the row there).
 * Once per list element: a redraw that keeps the element keeps it working.
 */
export function dragReorder(list, { items, carry = () => [], onDrop }) {
  if (list.hasAttribute('data-reorder')) return;
  list.setAttribute('data-reorder', '');
  addStyles();
  let press = null; // { row, id, x, y, mouse, timer, dragging, from, to, slots, pitch, marker }

  const parts = (row) => [row, ...carry(row)];
  const shift = (row, px) => {
    for (const el of parts(row)) el.style.transform = px ? `translateY(${px}px)` : '';
  };
  const stop = () => {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.dragging) {
      for (const el of parts(press.row)) el.classList.remove('reorder-dragging');
      shift(press.row, 0);
      for (const s of press.slots) shift(s.row, 0);
    }
    press.marker?.remove();
    list.classList.remove('reorder-active');
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', cancel, true);
    press = null;
  };

  /** Where `row` sits with its carried lines, measured once as the drag starts. */
  const extent = (row) => {
    const all = parts(row).map((el) => el.getBoundingClientRect()).filter((b) => b.height);
    return { row, top: all[0].top, bottom: Math.max(...all.map((b) => b.bottom)), left: all[0].left, width: all[0].width };
  };

  const begin = () => {
    const rows = items();
    const from = rows.indexOf(press.row);
    if (from < 0) return stop(); // redrawn under the finger
    press.dragging = true;
    press.from = press.to = from;
    press.self = extent(press.row);
    press.slots = rows.filter((r) => r !== press.row).map(extent);
    // How far the rows it passes slide to make room: its height and the gap after it (or before it, if last).
    const { self, slots } = press;
    const gap = slots[from] ? slots[from].top - self.bottom : slots[from - 1] ? self.top - slots[from - 1].bottom : 0;
    press.pitch = self.bottom - self.top + Math.max(0, gap);
    press.marker = Object.assign(document.createElement('div'), { className: 'reorder-marker' });
    list.append(press.marker);
    for (const el of parts(press.row)) el.classList.add('reorder-dragging');
    list.classList.add('reorder-active');
    getSelection?.()?.removeAllRanges();
  };

  const follow = (y) => {
    const { self, slots, from, pitch } = press;
    shift(press.row, y - press.y);
    // It lands before the first row whose middle is below the pointer; the rows between slide to open the gap.
    const to = slots.filter((s) => (s.top + s.bottom) / 2 < y).length;
    press.to = to;
    slots.forEach((s, i) => shift(s.row, i >= from && i < to ? -pitch : i >= to && i < from ? pitch : 0));
    // The gap it will drop into, outlined in the list's own coordinates.
    const top = to > from ? slots[to - 1].bottom - (self.bottom - self.top) : to < from ? slots[to].top : self.top;
    const at = press.marker.offsetParent ?? document.documentElement; // the list, unless a page made it static
    const box = at.getBoundingClientRect();
    Object.assign(press.marker.style, {
      top: `${top - box.top - at.clientTop + at.scrollTop}px`, left: `${self.left - box.left - at.clientLeft + at.scrollLeft}px`,
      width: `${self.width}px`, height: `${self.bottom - self.top}px`,
    });
  };

  function move(e) {
    if (e.pointerId !== press.id) return;
    if (press.dragging) return void follow(e.clientY);
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= SLOP) return;
    if (!press.mouse) return stop(); // a finger moving before the hold is a scroll
    begin();
    if (press) follow(e.clientY);
  }

  function up(e) {
    if (e.pointerId !== press.id) return;
    const { dragging, from, to } = press;
    stop();
    if (!dragging) return;
    swallowClick();
    if (to !== from) onDrop(from, to);
  }

  function cancel(e) {
    if (e.pointerId === press?.id) stop();
  }

  list.addEventListener('pointerdown', (e) => {
    if (press || e.button !== 0 || !e.isPrimary) return;
    const row = items().find((r) => r.contains(e.target));
    if (!row || e.target.closest('button, input, select, textarea')) return;
    press = { row, id: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse', dragging: false };
    // A finger or pen picks a row up by holding it; a mouse once it moves, so a slow click still opens it.
    if (!press.mouse) press.timer = setTimeout(() => press && !press.dragging && (begin(), press && follow(press.y)), HOLD_MS);
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', cancel, true);
  });
  // A keyboard's way: Alt+Up or Alt+Down moves the focused row one place, and focus stays on it.
  list.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || press) return;
    const rows = items();
    const from = rows.findIndex((r) => r.contains(document.activeElement));
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    e.preventDefault();
    onDrop(from, to);
    const row = items()[to];
    (row?.matches('a, button, [tabindex]') ? row : row?.querySelector('a, button, [tabindex]'))?.focus();
  });
  // Once a row is up, the finger moves it: no scrolling, and no drawer swipe (drawers.js listens on document).
  list.addEventListener('touchmove', (e) => {
    if (!press?.dragging) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
  // The phone's long-press menu, and the browser's own drag of a link or an image, would steal the press.
  list.addEventListener('contextmenu', (e) => press && e.preventDefault());
  list.addEventListener('dragstart', (e) => items().some((r) => r.contains(e.target)) && e.preventDefault());
}

/** The click a drop ends in (the row is a link) doesn't open it. */
function swallowClick() {
  const eat = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  addEventListener('click', eat, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', eat, true), 0); // a touch drop may end in no click at all
}

// A constructed sheet, as in rail.js: Citadel's Content-Security-Policy refuses inline <style>.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(`
:where([data-reorder]) { position: relative; }
[data-reorder] a { -webkit-touch-callout: none; }
[data-reorder].reorder-active { -webkit-user-select: none; user-select: none; cursor: grabbing; }
[data-reorder].reorder-active > * { transition: transform 0.15s ease; }
[data-reorder].reorder-active > .reorder-dragging { position: relative; z-index: 2; transition: none; cursor: grabbing; pointer-events: none;
  filter: drop-shadow(0 6px 14px rgb(0 0 0 / 0.3)); }
.reorder-marker { position: absolute; z-index: 1; box-sizing: border-box; border-radius: 8px; pointer-events: none;
  border: 2px dashed var(--accent, #fb923c); background: color-mix(in srgb, var(--accent, #fb923c) 12%, transparent); }
@media (prefers-reduced-motion: reduce) { [data-reorder].reorder-active > * { transition: none; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
