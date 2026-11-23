// Citadel UI: the right-click menu (#1663, Cara picked take B on #1661, 2026-11-22: "B · Citadel's own menu").
// Served to apps as /apps/_citadel/ui/menu.js (types: menu.d.ts beside it); its look is base.css's cui-menu.
// Docs: kit/skills/contraption-ui/references/menu.md.
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages: no imports from
// outside ui/, nothing it writes carries style="" or <style> (its left, top, max-height and chip hue are CSSOM writes,
// which CSP allows and placement needs), and its exports are an API apps depend on
// (test/ui-contract.test.ts). Add, never rename.
//
// openMenu() draws one menu at a time: a header naming what was clicked (a hued kind chip and its name), then
// items. It opens at the cursor and flips at the window's edges; arrows, Home and End move, Enter picks, Escape
// closes and puts focus back; scroll, resize, a press elsewhere or the window losing focus close it.
// mountMenus() wires the page's right-click and Shift+F10 / the Menu key to a function that says what menu a
// thing gets. Text boxes keep the browser's own menu (spelling, paste), and so does Shift+right-click.
//
// On a phone (#1664, Cara 2026-11-22: "Long-press opens the menu on phones: Yes, a sheet"): with `longPress` on,
// mountMenus opens the menu as a bottom sheet (spec.sheet) after a 450 ms touch hold that stays within 10 px, and
// swallows the tap that ends it. Its own timer, because iPhone Safari sends no contextmenu; Android's contextmenu
// from a touch is answered the same way. A sheet has a grab bar, rows 44 px tall and a dimmed page behind it: a tap
// on the dim or a swipe down on the head closes it.

/** Kept clear at the window's edges. */
const EDGE = 8;

/**
 * Where a `w` × `h` menu opened at (`x`, `y`) goes in a `vw` × `vh` window: just past the cursor, flipped to the
 * cursor's other side when it would cross the right or bottom edge, and kept inside the window. A menu taller than
 * the window gets `maxHeight` (it scrolls). Pure, for tests.
 */
export function placeMenu(x, y, w, h, vw, vh) {
  const maxHeight = Math.max(0, vh - 2 * EDGE);
  const hh = Math.min(h, maxHeight);
  let left = x + 2;
  let top = y + 2;
  let flipX = false;
  let flipY = false;
  if (left + w > vw - EDGE) { left = x - w - 2; flipX = true; }
  if (top + hh > vh - EDGE) { top = y - hh - 2; flipY = true; }
  left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
  top = Math.max(EDGE, Math.min(top, vh - hh - EDGE));
  return { left, top, maxHeight, flipX, flipY };
}

let open = null; // { el, close }

/** Close the open menu, if any. Focus goes back where it was unless `refocus` is false. */
export function closeMenu(refocus = true) {
  open?.close(refocus);
}

/** Whether a menu is open now. */
export const menuOpen = () => !!open;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Open a menu at (`x`, `y`) in the window. `spec`: { kind, hue?, tone?, name?, items, foot?, label?, returnTo?,
 * onClose? }. An item is { label, run?, icon?, keys?, point?, danger?, disabled?, reason?, from? }, or '-' for a
 * line. Returns the menu element; openMenu() again replaces it.
 */
export function openMenu(spec, x, y) {
  closeMenu(false);
  const returnTo = spec.returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const menu = el('div', 'cui-menu');
  if (spec.sheet) menu.dataset.sheet = '';
  menu.setAttribute('popover', 'manual');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', spec.label ?? `${spec.kind ?? 'Page'} actions`);
  let scrim = null;
  if (spec.sheet) {
    // The dim behind the sheet, closed by a tap. Ignored for a moment so the finger still down from the press can't close it.
    scrim = el('div', 'cui-menu-scrim');
    const born = Date.now();
    scrim.addEventListener('click', () => { if (Date.now() - born > 350) close(true); });
    document.body.append(scrim);
  }
  const head = el('div', 'cui-menu-head');
  if (spec.sheet) head.append(el('span', 'cui-menu-grab'));
  const chip = el('span', 'cui-chip cui-menu-kind', spec.kind ?? 'Page');
  if (spec.tone) chip.dataset.tone = spec.tone;
  else if (spec.hue) { chip.dataset.tone = 'custom'; chip.style.setProperty('--cui-tone', spec.hue); }
  head.append(chip);
  if (spec.name) {
    const name = el('span', 'cui-menu-name', spec.name);
    name.title = spec.name;
    head.append(name);
  }
  menu.append(head);
  let from = null;
  const items = (spec.items ?? []).filter(Boolean);
  items.forEach((it, i) => {
    if (it === '-') {
      if (i && i < items.length - 1 && items[i - 1] !== '-') menu.append(el('hr', 'cui-menu-sep'));
      return;
    }
    // An app's own items sit under a "From <app>" line.
    if (it.from && it.from !== from) menu.append(el('div', 'cui-menu-from', `From ${it.from}`));
    from = it.from ?? null;
    const b = el('button', `cui-menu-item${it.point ? ' cui-menu-point' : ''}${it.danger ? ' cui-menu-danger' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    const icon = el('span', 'cui-menu-icon', it.icon ?? '');
    icon.setAttribute('aria-hidden', 'true');
    b.append(icon, el('span', 'cui-menu-label', it.disabled && it.reason ? `${it.label} · ${it.reason}` : it.label));
    if (it.keys) b.append(el('span', 'cui-menu-keys', it.keys));
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (it.disabled) return;
      close(false);
      it.run?.(e);
    });
    menu.append(b);
  });
  if (spec.foot) menu.append(el('div', 'cui-menu-foot', spec.foot));
  document.body.append(menu);
  menu.showPopover?.();
  if (!spec.sheet) {
    const vw = document.documentElement.clientWidth;
    const p = placeMenu(x, y, menu.offsetWidth, menu.offsetHeight, vw, innerHeight);
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
    menu.style.maxHeight = `${p.maxHeight}px`;
    menu.dataset.origin = `${p.flipY ? 'bottom' : 'top'} ${p.flipX ? 'right' : 'left'}`;
  } else {
    // Swipe down on the head to close: it follows the finger, and past 60 px (or let go) it closes or springs back.
    let drag = null;
    head.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, id: e.pointerId, dy: 0 }; head.setPointerCapture?.(e.pointerId); });
    head.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dy = Math.max(0, e.clientY - drag.y);
      menu.style.transition = 'none';
      menu.style.transform = `translateY(${drag.dy}px)`;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const far = drag.dy > 60;
      drag = null;
      menu.style.transition = '';
      menu.style.transform = '';
      if (far) close(true);
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  const buttons = () => [...menu.querySelectorAll('.cui-menu-item')];
  const focusAt = (n) => {
    const list = buttons();
    if (list.length) list[(n + list.length) % list.length].focus({ preventScroll: true });
  };
  const onKey = (e) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i < 0 ? -1 : i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Tab') { e.preventDefault(); close(true); }
  };
  // On a sheet the dim handles its own tap (a pointerdown that closed it would let the click fall through).
  const onPress = (e) => { if (!menu.contains(e.target) && e.target !== scrim) close(false); };
  // A scroll that moves what the menu is about (or the page) closes it; a redraw's scroll elsewhere (a list
  // rebuilt by a live update) doesn't, or menus would vanish in a busy scheme. A wheel always does.
  const onScroll = (e) => {
    const s = e.target;
    if (s instanceof Node && menu.contains(s)) return;
    if (!(s instanceof Element) || s === document.documentElement || !returnTo?.isConnected || s.contains(returnTo)) close(false);
  };
  const onWheel = (e) => { if (!menu.contains(e.target)) close(false); };
  // A phone's address bar sliding away resizes the window's height: that isn't a reason to close a sheet.
  const width = innerWidth;
  const onResize = () => { if (!spec.sheet || innerWidth !== width) close(false); };
  const onBlur = () => close(false);
  menu.addEventListener('keydown', onKey);
  addEventListener('pointerdown', onPress, true);
  addEventListener('scroll', onScroll, true);
  addEventListener('wheel', onWheel, { capture: true, passive: true });
  addEventListener('resize', onResize);
  addEventListener('blur', onBlur);
  addEventListener('hashchange', onResize);
  const close = (refocus) => {
    if (open?.el !== menu) return;
    open = null;
    removeEventListener('pointerdown', onPress, true);
    removeEventListener('scroll', onScroll, true);
    removeEventListener('wheel', onWheel, { capture: true });
    removeEventListener('resize', onResize);
    removeEventListener('blur', onBlur);
    removeEventListener('hashchange', onResize);
    menu.remove();
    scrim?.remove();
    if (refocus) (returnTo?.isConnected ? returnTo : redrawnCopy(returnTo))?.focus({ preventScroll: true });
    spec.onClose?.();
  };
  open = { el: menu, close };
  // A touch sheet has no use for a focus ring on its first row: focus the sheet, and the arrows still work from there.
  if (spec.sheet) { menu.tabIndex = -1; menu.focus({ preventScroll: true }); } else focusAt(0);
  return menu;
}

/** The element a redraw put in place of `gone`: same tag, same id or data-id. Null when there's none to tell by. */
function redrawnCopy(gone) {
  if (!gone) return null;
  if (gone.id) return document.getElementById(gone.id);
  const id = gone.dataset?.id;
  return id ? document.querySelector(`${gone.localName}[data-id="${CSS.escape(id)}"]`) : null;
}

/** Text boxes keep the browser's own menu: spelling suggestions and Paste need it. */
const EDITABLE = 'input:not([type=button], [type=submit], [type=reset], [type=checkbox], [type=radio], [type=range], [type=color], [type=file]), textarea, select, [contenteditable]:not([contenteditable=false])';

/**
 * Wire right-click and Shift+F10 / the Menu key under `root` (default the document) to `menuFor(target, event)`,
 * which returns a spec for openMenu() or null for the browser's own menu. Text boxes and Shift+right-click always
 * get the browser's own. Returns a function that unmounts it.
 */
export function mountMenus({ root = document, menuFor, longPress = false } = {}) {
  let keyed = 0; // when the keyboard last opened one, so the contextmenu that follows the key is swallowed
  const at = (target) => {
    const r = target.getBoundingClientRect();
    return [Math.max(0, r.left) + 12, Math.max(0, r.top) + Math.min(r.height, 28)];
  };
  const show = (target, e, x, y) => {
    const spec = menuFor(target, e);
    if (!spec) return false;
    openMenu({ returnTo: target instanceof HTMLElement && target !== document.body ? target : undefined, ...spec }, x, y);
    return true;
  };
  // A touch long press (see the head of this file). `press.fired` also marks the contextmenu and click it leads to.
  const PRESS_MS = 450;
  const SLOP = 10;
  let press = null;
  const sheetFor = (t) => {
    if (t.closest('.cui-menu, .cui-menu-scrim') || t.closest(EDITABLE)) return null;
    const spec = menuFor(t, null);
    return spec && (typeof longPress === 'function' ? longPress(t, spec) : longPress) ? spec : null;
  };
  const showSheet = (t, spec) => {
    openMenu({ returnTo: t instanceof HTMLElement ? t : undefined, ...spec, sheet: true, foot: undefined }, 0, 0);
    navigator.vibrate?.(10);
  };
  const cancelPress = () => { if (press && !press.fired) { clearTimeout(press.timer); press = null; } };
  const onDown = (e) => {
    if (e.pointerType === 'mouse' || !longPress || !e.isPrimary) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    cancelPress();
    const p = { t, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
    p.timer = setTimeout(() => {
      const spec = sheetFor(t);
      if (!spec) return;
      p.fired = true;
      showSheet(t, spec);
    }, PRESS_MS);
    press = p;
  };
  const onMove = (e) => { if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancelPress(); };
  // The tap that ends a fired press must not act on the thing underneath.
  const onClick = (e) => {
    if (!press?.fired) return;
    e.preventDefault();
    e.stopPropagation();
    press = null;
  };
  const onMenu = (e) => {
    if (press?.fired) { e.preventDefault(); return; } // Android's contextmenu, after our timer already opened the sheet
    // Android Chrome's own long press, where the timer didn't (a moved finger, a page without longPress): a sheet if wanted.
    if (longPress && e.pointerType === 'touch' && e.target instanceof Element) {
      const spec = sheetFor(e.target);
      if (spec) { e.preventDefault(); showSheet(e.target, spec); }
      return;
    }
    if (Date.now() - keyed < 800) { keyed = 0; e.preventDefault(); return; }
    const t = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!t) return;
    if (t.closest('.cui-menu')) { e.preventDefault(); return; }
    // A keyboard's contextmenu event (no pointer) when the keydown below didn't see the key.
    const keyboard = e.button !== 2 && !e.clientX && !e.clientY;
    if (!keyboard && e.shiftKey) return;
    if (t.closest(EDITABLE)) return;
    const [x, y] = keyboard ? at(t) : [e.clientX, e.clientY];
    if (show(t, e, x, y)) e.preventDefault();
  };
  const onKey = (e) => {
    if (!((e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) || e.key === 'ContextMenu')) return;
    const t = document.activeElement instanceof Element ? document.activeElement : document.body;
    if (t.closest('.cui-menu') || t.closest(EDITABLE) || !root.contains(t)) return;
    const [x, y] = t === document.body ? [innerWidth / 3, innerHeight / 3] : at(t);
    if (show(t, e, x, y)) { e.preventDefault(); keyed = Date.now(); }
  };
  root.addEventListener('contextmenu', onMenu);
  root.addEventListener('keydown', onKey);
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  // A fired press waits for its click; one whose click never comes (the finger slid off) is forgotten shortly.
  const onUp = () => { cancelPress(); const p = press; if (p?.fired) setTimeout(() => { if (press === p) press = null; }, 600); };
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', cancelPress);
  root.addEventListener('click', onClick, true);
  return () => {
    root.removeEventListener('contextmenu', onMenu);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', cancelPress);
    root.removeEventListener('click', onClick, true);
    cancelPress();
  };
}
