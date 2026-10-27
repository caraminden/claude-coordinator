// Phones: swipe in from the left edge for the overview panel, from the right edge for the threads.
// The panels are the same .shelf and .sidebar that sit beside the chat on wider screens; on phones
// they are hidden until one is pulled out as a drawer over the page, and go back when closed.

export const NARROW = '(max-width: 800px)'; // the mobile layout's breakpoint in style.css
export const EDGE = 24; // px from the screen edge a swipe has to start in
const SLOP = 10; // px of movement before deciding whether a touch is a swipe
const FLING = 0.35; // px/ms: a flick this fast settles the drawer whichever way it goes

/**
 * Decide what a touch that has moved (dx, dy) is: 'wait' while it is too short to tell, 'swipe'
 * when it is mostly horizontal in direction `dir` (+1 rightward, -1 leftward), else 'ignore'.
 */
export function classify(dx, dy, dir) {
  if (Math.hypot(dx, dy) < SLOP) return 'wait';
  return Math.sign(dx) === dir && Math.abs(dx) > Math.abs(dy) * 1.5 ? 'swipe' : 'ignore';
}

/**
 * Whether a released drawer should end open: a fast enough flick decides, otherwise whether it is
 * at least half out. `progress` is 0 (closed) to 1 (open); `velocity` is px/ms in the opening direction.
 */
export function settleOpen(progress, velocity) {
  if (velocity > FLING) return true;
  if (velocity < -FLING) return false;
  return progress >= 0.5;
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

const LABELS = { left: 'Overview', right: 'Threads' };
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function initDrawers() {
  const narrow = matchMedia(NARROW);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.hidden = true;
  document.body.append(backdrop);

  let drawer = null; // { el, side, holder, wasOpen, returnFocus, inerted, width, progress }
  let touch = null; // the touch being tracked: { id, x0, y0, side, dir, mode, from, samples }

  const panelFor = (side) => document.querySelector(side === 'left' ? '#app .panels > .shelf' : '#app .panels > .sidebar');

  /** Run `change` to the page's layout without the chat behind the drawer moving. */
  function keepPlace(change) {
    const anchor = document.querySelector('#app .split > :last-child');
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

  /** Lift a panel out of the page into a drawer, fully closed, ready to be pulled or slid out. */
  function mount(side) {
    const el = panelFor(side);
    if (!el) return false;
    // Keep the panel's spot so nothing on the page behind it moves.
    const holder = document.createElement('div');
    holder.className = 'drawer-holder';
    holder.style.height = `${el.offsetHeight}px`;
    drawer = { el, side, holder, wasOpen: el.open, returnFocus: document.activeElement, inerted: [], progress: 0 };
    keepPlace(() => {
      el.before(holder);
      el.classList.add('as-drawer', `from-${side}`);
      el.open = true;
    });
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', LABELS[side]);
    el.tabIndex = -1;
    backdrop.hidden = false;
    setProgress(0);
    drawer.width = el.getBoundingClientRect().width || window.innerWidth;
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
      for (const sel of ['.topbar', '#app .split > :not(.panels)', '#app .panels > details:not(.as-drawer)']) {
        for (const other of document.querySelectorAll(sel)) if (!other.inert) { other.inert = true; d.inerted.push(other); }
      }
      if (!d.el.contains(document.activeElement)) d.el.focus({ preventScroll: true });
    }
    const animate = !instant && !reduceMotion.matches && d.el.isConnected;
    d.el.classList.toggle('settling', animate);
    backdrop.classList.toggle('settling', animate);
    setProgress(open ? 1 : 0);
    if (!animate) return finish();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      d.el.classList.remove('settling');
      backdrop.classList.remove('settling');
      finish();
    };
    d.el.addEventListener('transitionend', end, { once: true });
    setTimeout(end, 400); // in case the transition never runs
  }

  function unmount(d) {
    const { el, holder } = d;
    keepPlace(() => {
      el.classList.remove('as-drawer', 'from-left', 'from-right', 'settling');
      el.style.transform = '';
      el.open = d.wasOpen;
      holder.remove();
    });
    el.removeAttribute('role');
    el.removeAttribute('aria-modal');
    el.removeAttribute('aria-label');
    el.removeAttribute('tabindex');
    for (const other of d.inerted) other.inert = false;
    if (!drawer) {
      backdrop.hidden = true;
      backdrop.classList.remove('settling');
    }
    if (el.contains(document.activeElement) || document.activeElement === document.body) {
      if (d.returnFocus?.isConnected && d.returnFocus !== document.body) d.returnFocus.focus({ preventScroll: true });
      else document.activeElement?.blur?.();
    }
  }

  const close = (opts) => drawer && settle(false, opts);

  // ---- the gesture ----

  document.addEventListener('touchstart', (e) => {
    if (!narrow.matches || e.touches.length !== 1) { touch = null; return; }
    const t = e.touches[0];
    if (drawer) {
      // A drag across an open drawer or its backdrop, toward its edge, pushes it back.
      if (!drawer.el.contains(e.target) && e.target !== backdrop) return;
      touch = { id: t.identifier, x0: t.clientX, y0: t.clientY, dir: drawer.side === 'left' ? -1 : 1, mode: 'wait', from: 1, target: e.target, samples: [] };
      return;
    }
    const side = edgeSide(t.clientX, window.innerWidth);
    if (!side || !panelFor(side)) { touch = null; return; }
    touch = { id: t.identifier, x0: t.clientX, y0: t.clientY, side, dir: side === 'left' ? 1 : -1, mode: 'wait', from: 0, target: e.target, samples: [] };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = [...e.changedTouches].find((c) => c.identifier === touch.id);
    if (!t) return;
    const dx = t.clientX - touch.x0;
    const dy = t.clientY - touch.y0;
    if (touch.mode === 'wait') {
      const kind = classify(dx, dy, touch.dir);
      if (kind === 'wait') return;
      if (kind === 'ignore' || scrollsSideways(touch.target, touch.dir, drawer?.el ?? document.body)) { touch = null; return; }
      if (!drawer && !mount(touch.side)) { touch = null; return; }
      touch.mode = 'drag';
      touch.x0 = t.clientX; // follow from here, so the drawer doesn't jump by the slop
      drawer.el.classList.remove('settling');
      backdrop.classList.remove('settling');
    }
    if (e.cancelable) e.preventDefault(); // the swipe is ours: no scrolling or history swipe
    const moved = (t.clientX - touch.x0) * (drawer.side === 'left' ? 1 : -1);
    setProgress(touch.from + moved / drawer.width);
    touch.samples.push([e.timeStamp, t.clientX]);
    if (touch.samples.length > 5) touch.samples.shift();
  }, { passive: false });

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
    settle(e.type === 'touchcancel' ? tr.from === 1 : settleOpen(drawer.progress, v));
  };
  document.addEventListener('touchend', release);
  document.addEventListener('touchcancel', release);

  // ---- other ways to close ----

  // Edge handles: the same drawers with a tap, where the browser's back/forward swipe wins the edge.
  for (const side of ['left', 'right']) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = `drawer-handle ${side}`;
    handle.setAttribute('aria-label', `Open ${LABELS[side].toLowerCase()}`);
    handle.title = LABELS[side];
    handle.addEventListener('click', () => {
      if (drawer || !narrow.matches || !mount(side)) return;
      drawer.returnFocus = handle;
      // Let the closed position paint first so the drawer slides in.
      requestAnimationFrame(() => requestAnimationFrame(() => settle(true)));
    });
    document.body.append(handle);
  }

  backdrop.addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => {
    if (!drawer) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the open drawer.
    const items = [...drawer.el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) return;
    const [first, last] = [items[0], items.at(-1)];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer.el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (!drawer || !drawer.el.contains(e.target)) return;
    // The panel's own bar folds it in the page; in a drawer it closes the drawer.
    const summary = e.target.closest('summary');
    if (summary?.parentElement === drawer.el) { e.preventDefault(); close(); return; }
    // Picking a thread, project or artifact switches the view in place and puts the drawer away.
    const a = e.target.closest('a[href]');
    if (a && !e.defaultPrevented) {
      drawer.wasOpen = false;
      close();
    }
  }, true);
  // A new view may replace the panels; don't leave a drawer of the old one over it.
  window.addEventListener('hashchange', () => { if (drawer && !drawer.el.isConnected) settle(false, { instant: true }); });
  new MutationObserver(() => { if (drawer && !drawer.el.isConnected) settle(false, { instant: true }); })
    .observe(document.getElementById('app'), { childList: true });
  narrow.addEventListener('change', () => { if (!narrow.matches && drawer) settle(false, { instant: true }); });
}
