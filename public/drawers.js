// Phones: drawers pulled in from the screen edges, over the page. Citadel's own page passes its
// overview (left) and threads (right) panels; a contraption imports this as /apps/_citadel/drawers.js
// and passes its own elements, so the gesture lives in one place (Cara, 2026-11-01: "Share it, served
// by Citadel"). How a contraption calls it: kit/skills/contraption-ui/rail-and-drawers.md.
// The elements stay where the page's CSS puts them on wider screens; on phones they are hidden until
// one is pulled out as a drawer, and go back when closed. Slim handles on the edges open them with a
// tap too, since in a Safari tab the edges belong to the browser's back and forward swipes.
// With the app rail showing (rail.js), a swipe right past the open left drawer, or from the left edge of
// a page without one, slides out the app switcher (Cara, 2026-10-31: "you scroll left past the left
// panel again on mobile to access the app switcher").
// Standalone apart from rail.js, and brings its own styles, since contraptions load it from outside Citadel's pages.
import { hasRail, leaveEdge, openRail } from './rail.js';

export const NARROW = '(max-width: 800px)'; // the mobile layout's breakpoint in style.css
export const EDGE = 44; // px from the screen edge a swipe has to start in: a thumb's width, not a sliver
const SLOP = 10; // px of movement before deciding whether a touch is a swipe
const ANGLE = 1.2; // how much more sideways than up or down a swipe has to be (about 40° off level at most)
const FLING = 0.25; // px/ms: a flick this fast settles the drawer whichever way it goes
const COMMIT = 1 / 3; // how far along a slow drag has to get to finish the move it started

/**
 * Decide what a touch that has moved (dx, dy) is: 'wait' while it is too short to tell, 'swipe'
 * when it is mostly horizontal in direction `dir` (+1 rightward, -1 leftward), else 'ignore'.
 */
export function classify(dx, dy, dir) {
  if (Math.hypot(dx, dy) < SLOP) return 'wait';
  return Math.sign(dx) === dir && Math.abs(dx) > Math.abs(dy) * ANGLE ? 'swipe' : 'ignore';
}

/**
 * Whether a released drawer should end open: a fast enough flick decides, otherwise whether the drag
 * got a third of the way from where it started (`from`: 0 pulling it out, 1 pushing it back).
 * `progress` is 0 (closed) to 1 (open); `velocity` is px/ms in the opening direction.
 */
export function settleOpen(progress, velocity, from = 0) {
  if (velocity > FLING) return true;
  if (velocity < -FLING) return false;
  return from === 0 ? progress >= COMMIT : progress > 1 - COMMIT;
}

/** Which drawer a touch at `x` on a screen `width` wide would pull out, if any. */
export function edgeSide(x, width) {
  if (x <= EDGE) return 'left';
  if (x >= width - EDGE) return 'right';
  return null;
}

/**
 * Whether something under the finger scrolls sideways and still has room to go in the drag's
 * direction; then the drag scrolls it (a wide code block or table) rather than pulling a drawer.
 */
function scrollsSideways(target, dir, stop) {
  for (let el = target; el && el !== stop && el.nodeType === 1; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox !== 'auto' && ox !== 'scroll') continue;
    // Dragging rightward reveals what is to the left, and the reverse.
    if (dir > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Phones: pull `left` and `right` out from the screen edges as drawers. Each is `{ el, label }`, where
 * `el` is the element or a function that finds it (null when the current view has none), for pages
 * that redraw it. `main` (an element, a list, or a function returning either) goes inert behind an
 * open drawer, and the first of it is held still while a drawer comes and goes.
 * Returns `open(side)`, `close()` and `destroy()`.
 */
export function initDrawers({ left, right, main } = {}) {
  const sides = { left, right };
  const narrow = matchMedia(NARROW);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const stop = new AbortController();
  const { signal } = stop;
  addStyles();
  // A swipe from the left edge is now this drawer's, and only past it the switcher's.
  if (left) leaveEdge();
  // Elements given outright are hidden on phones until pulled out (the styles below); found ones are the page's to hide.
  for (const s of [left, right]) if (s?.el instanceof Element) s.el.setAttribute('data-citadel-drawer', '');
  const backdrop = document.createElement('div');
  backdrop.className = 'citadel-drawer-backdrop';
  backdrop.hidden = true;
  document.body.append(backdrop);

  let drawer = null; // { el, side, wasOpen, returnFocus, inerted, width, progress }
  let touch = null; // the touch being tracked: { id, x0, y0, side, dir, mode, from, samples }

  const panelFor = (side) => {
    const el = sides[side]?.el;
    return (typeof el === 'function' ? el() : el) ?? null;
  };
  const mains = () => {
    const m = typeof main === 'function' ? main() : main;
    return !m ? [] : m instanceof Element ? [m] : [...m].filter(Boolean);
  };

  /** Run `change` to the page's layout without what's behind the drawer moving. */
  function keepPlace(change) {
    const anchor = mains()[0];
    const y = anchor?.getBoundingClientRect().top;
    change();
    if (anchor?.isConnected) window.scrollBy(0, anchor.getBoundingClientRect().top - y);
  }

  function setProgress(p) {
    drawer.progress = Math.min(1, Math.max(0, p));
    const off = (1 - drawer.progress) * 100;
    drawer.el.style.transform = `translateX(${drawer.side === 'left' ? -off : off}%)`;
    backdrop.style.opacity = String(drawer.progress);
  }

  /** Lift an element out of the page into a drawer, fully closed, ready to be pulled or slid out. */
  function mount(side) {
    const el = panelFor(side);
    if (!el) return false;
    // A <details> panel (Citadel's) shows its contents in the drawer and goes back collapsed or not as it was.
    const details = el instanceof HTMLDetailsElement;
    drawer = { el, side, wasOpen: details && el.open, returnFocus: document.activeElement, inerted: [], progress: 0 };
    keepPlace(() => {
      el.classList.add('citadel-drawer', `citadel-drawer-${side}`);
      if (details) el.open = true;
    });
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', sides[side].label);
    el.tabIndex = -1;
    backdrop.hidden = false;
    setProgress(0);
    drawer.width = el.getBoundingClientRect().width || window.innerWidth;
    watch.observe(document.body, { childList: true, subtree: true });
    announce('citadel-drawer-open', side, el);
    return true;
  }

  /** Slide the drawer to open or shut; once shut it goes back into the page. */
  function settle(open, { instant = false } = {}) {
    if (!drawer) return;
    const d = drawer;
    const finish = () => {
      if (open) return;
      if (drawer === d) drawer = null;
      unmount(d);
    };
    if (open) {
      const other = panelFor(d.side === 'left' ? 'right' : 'left');
      // Not anything holding the drawer itself, which would go inert with it.
      for (const el of [...mains(), other])
        if (el && !el.contains(d.el) && !el.inert) {
          el.inert = true;
          d.inerted.push(el);
        }
      if (!d.el.contains(document.activeElement)) d.el.focus({ preventScroll: true });
    }
    const animate = !instant && !reduceMotion.matches && d.el.isConnected;
    d.el.classList.toggle('citadel-drawer-settling', animate);
    backdrop.classList.toggle('citadel-drawer-settling', animate);
    setProgress(open ? 1 : 0);
    if (!animate) return finish();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      d.el.classList.remove('citadel-drawer-settling');
      backdrop.classList.remove('citadel-drawer-settling');
      finish();
    };
    d.el.addEventListener('transitionend', end, { once: true });
    setTimeout(end, 400); // in case the transition never runs
  }

  function unmount(d) {
    // A second close while the first still slides (a link, then its hashchange) ends in here twice.
    if (d.back) return;
    d.back = true;
    const { el } = d;
    keepPlace(() => {
      el.classList.remove('citadel-drawer', 'citadel-drawer-left', 'citadel-drawer-right', 'citadel-drawer-settling');
      el.style.transform = '';
      if (el instanceof HTMLDetailsElement) el.open = d.wasOpen;
    });
    el.removeAttribute('role');
    el.removeAttribute('aria-modal');
    el.removeAttribute('aria-label');
    el.removeAttribute('tabindex');
    for (const other of d.inerted) other.inert = false;
    if (!drawer) {
      backdrop.hidden = true;
      backdrop.classList.remove('citadel-drawer-settling');
      watch.disconnect();
    }
    if (el.contains(document.activeElement) || document.activeElement === document.body) {
      if (d.returnFocus?.isConnected && d.returnFocus !== document.body) d.returnFocus.focus({ preventScroll: true });
      else document.activeElement?.blur?.();
    }
    announce('citadel-drawer-close', d.side, el);
  }

  const close = (opts) => drawer && settle(false, opts);
  // On document, which outlives a drawer element a new view replaced: citadel-drawer-open as the element
  // is pulled out (before it slides in, so a page can move its composer into it), citadel-drawer-close once
  // it is back in the page. Always in pairs. Names stay literal at each call: the contract test reads them.
  const announce = (name, side, el) => document.dispatchEvent(new CustomEvent(name, { detail: { side, el } }));

  /** Slide a drawer out by itself (a handle, or the page's own button); the switcher for a left edge with only the rail. */
  function open(side, returnFocus = document.activeElement) {
    if (side === 'left' && !drawer && narrow.matches && !panelFor(side) && hasRail()) return openRail();
    if (drawer || !narrow.matches || !mount(side)) return;
    drawer.returnFocus = returnFocus;
    // Let the closed position paint first so the drawer slides in.
    requestAnimationFrame(() => requestAnimationFrame(() => settle(true)));
  }

  // ---- the gesture ----

  document.addEventListener(
    'touchstart',
    (e) => {
      if (!narrow.matches || e.touches.length !== 1) {
        // A second finger mid-drag ends the drag where it began (as touchcancel does), not half out.
        if (touch?.mode === 'drag' && drawer) settle(touch.from === 1);
        touch = null;
        return;
      }
      const t = e.touches[0];
      if (drawer) {
        // A drag across an open drawer or its backdrop, toward its edge, pushes it back.
        if (!drawer.el.contains(e.target) && e.target !== backdrop) return;
        touch = { id: t.identifier, x0: t.clientX, y0: t.clientY, dir: drawer.side === 'left' ? -1 : 1, mode: 'wait', from: 1, target: e.target, samples: [] };
        return;
      }
      let side = edgeSide(t.clientX, window.innerWidth);
      if (side === 'left' && !panelFor(side) && hasRail()) side = 'rail';
      if (!side || (side !== 'rail' && !panelFor(side))) {
        touch = null;
        return;
      }
      touch = { id: t.identifier, x0: t.clientX, y0: t.clientY, side, dir: side === 'right' ? -1 : 1, mode: 'wait', from: 0, target: e.target, samples: [] };
    },
    { passive: true, signal },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!touch) return;
      const t = [...e.changedTouches].find((c) => c.identifier === touch.id);
      if (!t) return;
      const dx = t.clientX - touch.x0;
      const dy = t.clientY - touch.y0;
      if (touch.mode === 'wait') {
        const kind = classify(dx, dy, touch.dir);
        if (kind === 'wait') return;
        // Past the left drawer, or from an edge with none: the app switcher, which slides out by itself.
        const pastLeft = kind === 'ignore' && drawer?.side === 'left' && hasRail() && classify(dx, dy, 1) === 'swipe';
        if (pastLeft && !scrollsSideways(touch.target, 1, drawer.el)) {
          touch = null;
          openRail();
          return;
        }
        if (kind === 'ignore' || scrollsSideways(touch.target, touch.dir, drawer?.el ?? document.body)) {
          touch = null;
          return;
        }
        if (touch.side === 'rail') {
          touch = null;
          openRail();
          return;
        }
        if (!drawer && !mount(touch.side)) {
          touch = null;
          return;
        }
        touch.mode = 'drag';
        touch.x0 = t.clientX; // follow from here, so the drawer doesn't jump by the slop
        drawer.el.classList.remove('citadel-drawer-settling');
        backdrop.classList.remove('citadel-drawer-settling');
      }
      if (e.cancelable) e.preventDefault(); // the swipe is ours: no scrolling or history swipe
      const moved = (t.clientX - touch.x0) * (drawer.side === 'left' ? 1 : -1);
      setProgress(touch.from + moved / drawer.width);
      touch.samples.push([e.timeStamp, t.clientX]);
      if (touch.samples.length > 5) touch.samples.shift();
    },
    { passive: false, signal },
  );

  const release = (e) => {
    if (!touch) return;
    const tr = touch;
    if (![...e.changedTouches].some((c) => c.identifier === tr.id)) return;
    touch = null;
    if (tr.mode !== 'drag' || !drawer) return;
    const [first, last] = [tr.samples[0], tr.samples.at(-1)];
    const dt = last && first ? last[0] - first[0] : 0;
    // A finger that stopped before letting go isn't flicking.
    const held = last ? e.timeStamp - last[0] > 100 : true;
    const v = dt > 0 && !held ? ((last[1] - first[1]) / dt) * (drawer.side === 'left' ? 1 : -1) : 0;
    settle(e.type === 'touchcancel' ? tr.from === 1 : settleOpen(drawer.progress, v, tr.from));
  };
  document.addEventListener('touchend', release, { signal });
  document.addEventListener('touchcancel', release, { signal });

  // ---- other ways to close ----

  // Edge handles: the same drawers with a tap, where the browser's back/forward swipe wins the edge.
  const handles = Object.keys(sides)
    .filter((side) => sides[side])
    .map((side) => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = `citadel-drawer-handle ${side}`;
      handle.setAttribute('aria-label', `Open ${sides[side].label.toLowerCase()}`);
      handle.title = sides[side].label;
      handle.addEventListener('click', () => open(side, handle));
      document.body.append(handle);
      return handle;
    });

  backdrop.addEventListener('click', () => close());
  document.addEventListener(
    'keydown',
    (e) => {
      if (!drawer) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the open drawer.
      const items = [...drawer.el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) return;
      const [first, last] = [items[0], items.at(-1)];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer.el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    { signal },
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!drawer || !drawer.el.contains(e.target)) return;
      // A <details> panel's own bar collapses it in the page; in a drawer it closes the drawer. A button or
      // field or link in the bar (the project's rename ✎, its Settings link) does its own thing instead; a link
      // then puts the drawer away below.
      const summary = e.target.closest('summary');
      if (summary?.parentElement === drawer.el && !e.target.closest('button, input, a[href]')) {
        e.preventDefault();
        close();
        return;
      }
      // Following a link (a thread, project or artifact, or a contraption's own view) puts the drawer away.
      const a = e.target.closest('a[href]');
      if (a && !e.defaultPrevented) {
        drawer.wasOpen = false;
        close();
      }
    },
    { capture: true, signal },
  );
  // Going anywhere else (a new thread started from the drawer, say) puts the drawer away; a new view
  // may also replace the element, so don't leave a drawer of the old one over it.
  window.addEventListener(
    'hashchange',
    () => {
      if (!drawer) return;
      if (!drawer.el.isConnected) {
        settle(false, { instant: true });
        return;
      }
      drawer.wasOpen = false;
      close();
    },
    { signal },
  );
  // Watches the page only while a drawer is out.
  const watch = new MutationObserver(() => {
    if (drawer && !drawer.el.isConnected) settle(false, { instant: true });
  });
  narrow.addEventListener(
    'change',
    () => {
      if (!narrow.matches && drawer) settle(false, { instant: true });
    },
    { signal },
  );

  return {
    open: (side) => open(side),
    close: () => close(),
    destroy() {
      close({ instant: true });
      stop.abort();
      if (left) leaveEdge(false);
      watch.disconnect();
      backdrop.remove();
      for (const h of handles) h.remove();
      for (const s of [left, right]) if (s?.el instanceof Element) s.el.removeAttribute('data-citadel-drawer');
    },
  };
}

// A constructed sheet, since Citadel's Content-Security-Policy (and maybe a contraption's) refuses inline <style>.
// Placement and width win over the page's own rules (!important), so its desktop sizes don't leak in; the look
// (background, padding, border) is the page's, and the width is --citadel-drawer-width on the element.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(`
.citadel-drawer-backdrop[hidden], .citadel-drawer-handle { display: none; }
@media ${NARROW} {
  /* Leave sideways swipes to the page rather than browser history, where the browser allows it. */
  html, body { overscroll-behavior-x: none; }
  /* What's behind a drawer stays put from the moment it's pulled out until it goes back: a fling
     still coasting, the swipe's vertical drift or a wheel stop there. On html only, so the viewport
     keeps a sticky top bar in place; scripted scrolls (keepPlace) still work. */
  html:has(.citadel-drawer) { overflow: hidden; }
  [data-citadel-drawer]:not(.citadel-drawer) { display: none !important; }
  .citadel-drawer {
    position: fixed !important; top: 0 !important; bottom: 0 !important; left: 0 !important; right: auto !important; z-index: 30 !important;
    box-sizing: border-box; width: var(--citadel-drawer-width, min(86vw, 340px)) !important; height: auto !important; max-height: none !important; margin: 0 !important;
    overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
    background: var(--citadel-drawer-bg, Canvas); box-shadow: 0 0 24px rgb(0 0 0 / 0.25);
    will-change: transform;
  }
  .citadel-drawer.citadel-drawer-right { left: auto !important; right: 0 !important; }
  .citadel-drawer:focus { outline: none; }
  .citadel-drawer-backdrop { position: fixed; inset: 0; z-index: 29; background: rgb(0 0 0 / 0.4); opacity: 0; touch-action: none; }
  .citadel-drawer-settling.citadel-drawer { transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1); }
  .citadel-drawer-settling.citadel-drawer-backdrop { transition: opacity 0.25s; }
  /* Slim tabs on the screen edges that open the drawers with a tap, for browsers whose own edge
     swipes (back and forward) get there first. The button is wider than the pill it draws. */
  .citadel-drawer-handle {
    display: block; position: fixed; top: 50%; z-index: 28; width: 1.1rem; height: 4rem; margin: -2rem 0 0; padding: 0;
    border: 0; border-radius: 0; background: none; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .citadel-drawer-handle.left { left: env(safe-area-inset-left, 0px); }
  .citadel-drawer-handle.right { right: env(safe-area-inset-right, 0px); }
  .citadel-drawer-handle::before { content: ''; position: absolute; top: 0.6rem; bottom: 0.6rem; width: 4px; border-radius: 999px; background: var(--citadel-drawer-handle, #8a847c); opacity: 0.45; }
  .citadel-drawer-handle.left::before { left: 3px; }
  .citadel-drawer-handle.right::before { right: 3px; }
  .citadel-drawer-handle:hover::before, .citadel-drawer-handle:focus-visible::before { opacity: 0.9; }
  html:has(.citadel-drawer) .citadel-drawer-handle { visibility: hidden; }
}
@media (prefers-reduced-motion: reduce) { .citadel-drawer-settling { transition: none !important; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
