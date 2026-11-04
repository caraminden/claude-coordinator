// Citadel UI: tooltips. Served to apps as /apps/_citadel/ui/tip.js (types: tip.d.ts beside it); its look
// is base.css's cui-tip. Docs: kit/skills/contraption-ui/SKILL.md. Ported from Theory of Crafting's
// app/web/tip.ts (ToC #55), Cara 2026-11-04: "add useful additional details ... when things are moused
// over throughout the app, tooltips are great!"
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages:
// - no imports from outside ui/;
// - nothing it writes carries style="" or <style>; the tip's left, top and max-height are CSSOM writes
//   (el.style.left), which CSP allows and placement needs;
// - classes are cui-*, and every rule sits in :where(), so an app's own selectors win;
// - its exports and their behaviour are an API apps depend on: test/ui-contract.test.ts holds them.
//   Add, never rename; a real break ships as a new file beside this one.
//
// What it does: an element opts in with data-tip. Its tip opens on mouse hover after 250 ms (60 ms when
// moving from one tip to the next), at once on keyboard focus (:focus-visible), and on a touch screen on a
// tap for things a tap doesn't act on, or a 450 ms long press for things it does (buttons, links), which
// swallows the click that follows. It sits below the thing, or above when there's no room, never over it,
// and inside the window. It lives in the top layer (popover="manual"), so opening it never moves the page.
// A slow body shows skeleton lines first. Escape, a press outside or a scroll closes it; one tip is open
// at a time on the page; it follows its thing when a redraw replaces the element; the thing gets
// aria-describedby while it's open.

/** Space between the thing and its tip, and kept clear at the window's edges. */
const GAP = 6;
const EDGE = 8;

/**
 * Where a `w` × `h` tip goes for target `t` in a `vw` × `vh` window: below when it fits, else above,
 * else on the roomier side with its height capped to that side (it scrolls). Either way it never covers
 * the target and stays inside the window.
 */
export function placeTip(t, w, h, vw, vh) {
  const below = Math.max(0, vh - EDGE - (t.bottom + GAP));
  const above = Math.max(0, t.top - GAP - EDGE);
  const left = Math.max(EDGE, Math.min(t.left, vw - w - EDGE));
  if (h <= below || (h > above && below >= above)) return { left, top: t.bottom + GAP, maxHeight: below };
  return { left, top: Math.max(EDGE, t.top - GAP - h), maxHeight: above };
}

/**
 * Tip bodies by key and revision: a hover loads once per revision, a re-hover is instant, and a failed
 * load is forgotten so the next hover asks again. Least recently used out past `max`.
 */
export class TipCache {
  #got = new Map();
  #max;
  constructor(max = 300) {
    this.#max = max;
  }

  get(key, revision, load) {
    const k = `${revision} ${key}`;
    let hit = this.#got.get(k);
    if (hit) {
      // Most recently used last, so eviction takes the coldest.
      this.#got.delete(k);
      this.#got.set(k, hit);
      return hit;
    }
    hit = Promise.resolve().then(load);
    this.#got.set(k, hit);
    hit.catch(() => this.#got.get(k) === hit && this.#got.delete(k));
    if (this.#got.size > this.#max) this.#got.delete(this.#got.keys().next().value);
    return hit;
  }

  get size() {
    return this.#got.size;
  }
}

/** A tip's body while it loads: a few skeleton lines, so it opens at once at about its size. */
const LOADING = '<div class="cui-tip-skel" aria-busy="true"><span class="cui-skeleton" data-width="medium" aria-hidden="true"></span><span class="cui-skeleton" aria-hidden="true"></span><span class="cui-skeleton" data-width="long" aria-hidden="true"></span></div>';

/** Without a `body`: the element's data-tip, as text (line breaks kept). */
const textBody = (el) => {
  const text = el.dataset.tip;
  if (!text) return null;
  const span = document.createElement('span');
  span.className = 'cui-tip-text';
  span.textContent = text;
  return span;
};

/** Opens on hover after this pause; quicker while moving from one tip to the next. */
const OPEN_MS = 250;
const WARM_MS = 60;
const CLOSE_MS = 150;
const PRESS_MS = 450;
/** A finger moving this far isn't a long press (it's a scroll). */
const SLOP = 10;

/** Things a tap acts on: on a touch screen their tip waits for a long press. */
const ACTS = 'button, a[href], input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"]';
let shown = null;
let lastClosed = 0;

/** The data-tip* attributes, which say which thing an element is about: a redraw's copy has the same. */
const sameThing = (a, b) => a.id === b.id && [...a.attributes, ...b.attributes].every((at) => !at.name.startsWith('data-tip') || a.getAttribute(at.name) === b.getAttribute(at.name));

export function mountTips(root = document.body, o = {}) {
  const selector = o.selector ?? '[data-tip]';
  const acts = o.acts ? `${ACTS}, ${o.acts}` : ACTS;
  const body = o.body ?? textBody;
  const pop = document.createElement('div');
  pop.className = `cui-tip${o.className ? ` ${o.className}` : ''}`;
  pop.setAttribute('popover', 'manual');
  pop.setAttribute('role', o.role ?? 'tooltip');
  pop.id = `cui-tip-${Math.random().toString(36).slice(2, 9)}`;
  if (o.label) pop.setAttribute('aria-label', o.label);
  document.body.append(pop);

  let at = null;
  /** Opened by a click, tap or long press: stays open when the pointer leaves. */
  let pinned = false;
  /** Opened by the mouse resting on it: Escape closes it and still reaches a dialog around it. */
  let hovered = false;
  let timer = 0;
  let drawn = 0;
  /** Set while Escape hands focus back, so focusing doesn't reopen it. */
  let quiet = false;
  let press = null;
  const watch = new MutationObserver(() => {
    if (!at || at.isConnected) return;
    // The view redrew under the tip: follow the same thing's new element, or close.
    const same = [...root.querySelectorAll(selector)].find((el) => sameThing(el, at));
    if (!same) return close();
    at = same;
    describe(at, true);
    place();
  });

  const tipOf = (t) => (t instanceof Element ? t.closest(selector) : null);
  const later = (fn, ms) => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  /** Add or take our id from the thing's aria-describedby, keeping any of the page's own. */
  function describe(el, on) {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== pop.id);
    if (on) ids.push(pop.id);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  function place() {
    if (!at) return;
    pop.style.maxHeight = '';
    const p = placeTip(at.getBoundingClientRect(), pop.offsetWidth, pop.offsetHeight, document.documentElement.clientWidth, innerHeight);
    pop.style.left = `${p.left}px`;
    pop.style.top = `${p.top}px`;
    pop.style.maxHeight = `${p.maxHeight}px`;
  }

  const fill = (content) => (typeof content === 'string' ? (pop.innerHTML = content) : pop.replaceChildren(content));
  function failed(e) {
    const p = document.createElement('p');
    p.className = 'cui-tip-error';
    p.textContent = `Couldn't load this: ${e instanceof Error ? e.message : String(e)}`;
    fill(p);
  }

  function draw() {
    if (!at) return;
    const el = at;
    const n = ++drawn;
    let content;
    try {
      content = body(el);
    } catch (e) {
      failed(e);
      return place();
    }
    const show = (c) => {
      if (c === undefined) c = textBody(el);
      if (c === null) return close();
      fill(c);
      place();
    };
    if (typeof content?.then !== 'function') return show(content);
    // Only the skeleton the first time: a redraw keeps what's there until the new body comes.
    if (!pop.firstChild) pop.innerHTML = LOADING;
    place();
    content.then(
      (c) => n === drawn && at === el && show(c),
      (e) => n === drawn && at === el && (failed(e), place()),
    );
  }

  function open(el, pin = false, hover = false) {
    clearTimeout(timer);
    if (shown && shown !== close) shown();
    if (at !== el) {
      if (at) describe(at, false);
      pop.replaceChildren();
    }
    at = el;
    pinned = pin;
    hovered = hover;
    describe(at, true);
    if (!pop.matches(':popover-open')) pop.showPopover();
    shown = close;
    watch.observe(root, { childList: true, subtree: true });
    o.onChange?.(at);
    draw();
  }

  function close() {
    clearTimeout(timer);
    if (!at) return;
    describe(at, false);
    at = null;
    pinned = hovered = false;
    drawn++;
    watch.disconnect();
    if (pop.matches(':popover-open')) pop.hidePopover();
    pop.replaceChildren();
    if (shown === close) shown = null;
    lastClosed = Date.now();
    o.onChange?.(null);
  }

  const off = new AbortController();
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { signal: off.signal, ...opts });

  on(root, 'pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = tipOf(e.target);
    if (!el || pinned || el === at) return void (el === at && clearTimeout(timer));
    later(() => open(el, false, true), shown || Date.now() - lastClosed < 400 ? WARM_MS : OPEN_MS);
  });
  for (const el of [root, pop]) {
    on(el, 'pointerout', (e) => {
      if (e.pointerType !== 'mouse' || pinned) return;
      const to = e.relatedTarget;
      if (at && to && (pop.contains(to) || at.contains(to))) return;
      if (!at) return void clearTimeout(timer);
      later(close, CLOSE_MS);
    });
  }
  on(pop, 'pointerover', () => clearTimeout(timer));

  on(root, 'focusin', (e) => {
    const el = tipOf(e.target);
    if (el && el === e.target && !quiet && !(el === at && pinned) && el.matches(':focus-visible')) open(el);
  });
  for (const el of [root, pop]) {
    on(el, 'focusout', (e) => {
      const to = e.relatedTarget;
      if (at && !pinned && !(to && (pop.contains(to) || at.contains(to)))) close();
    });
  }

  // Touch: a long press opens any tip and swallows the click that follows; a tap opens the tip of
  // something a tap doesn't act on.
  on(root, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const el = tipOf(e.target);
    if (!el) return;
    if (press) clearTimeout(press.timer);
    const p = { el, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
    p.timer = setTimeout(() => {
      p.fired = true;
      open(el, true);
    }, PRESS_MS);
    press = p;
  });
  on(root, 'pointermove', (e) => {
    if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) {
      clearTimeout(press.timer);
      press = null;
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    on(root, type, () => {
      if (press && !press.fired) clearTimeout(press.timer);
    });
  }
  // A long press shouldn't also bring up the phone's own menu over the tip.
  on(root, 'contextmenu', (e) => {
    if (press?.fired) e.preventDefault();
  });
  on(root, 'click', (e) => {
    const el = tipOf(e.target);
    if (press?.fired && press.el === el) {
      // The click a long press ends in: the tip, not the thing's action.
      e.preventDefault();
      e.stopPropagation();
      press = null;
      return;
    }
    press = null;
    if (!el) return;
    const actor = e.target.closest(acts);
    if (!o.tapOpens && actor && el.contains(actor)) return;
    if (o.tapOpens) e.preventDefault();
    // A click or tap on a thing that only shows something: open and keep it, or close it again.
    if (at === el && pinned) return close();
    open(el, true);
  }, { capture: true });

  on(document, 'keydown', (e) => {
    press = null; // a click from the keyboard isn't the end of a long press
    if (!at) return;
    // Tab from the open thing goes into a dialog tip's links (the tip sits at the end of the page).
    const first = pop.querySelector('a[href], button');
    if (e.key === 'Tab' && !e.shiftKey && document.activeElement === at && first) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.key !== 'Escape') return;
    // Escape closes a tip someone opened on purpose, and only that, not a dialog or drawer around it too.
    if (!hovered) e.preventDefault();
    const el = at;
    close();
    quiet = true;
    if (document.activeElement !== el && pop.contains(document.activeElement)) el.focus();
    quiet = false;
  });
  on(document, 'pointerdown', (e) => {
    if (at && !pop.contains(e.target) && !at.contains(e.target)) close();
  });
  // Scrolling anything but the tip moves the thing out from under it.
  on(document, 'scroll', (e) => at && !pop.contains(e.target) && close(), { capture: true, passive: true });
  on(window, 'resize', () => at && close());

  return {
    refresh: () => at && draw(),
    close,
    get open() {
      return at;
    },
    destroy() {
      off.abort();
      close();
      watch.disconnect();
      pop.remove();
    },
  };
}
