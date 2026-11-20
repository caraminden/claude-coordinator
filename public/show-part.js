// "Show me where" (#1122): a link ending in ?show=<part> opens its page, then this scrolls the part (an element with that
// data-part, named in src/show-parts.ts) into view and outlines it for a few seconds. core.js's route() calls it.
import { toast } from './ui/status.js';

const OUTLINE_MS = 3000;
const WAIT_MS = 8000; // a settings page loads its rows behind the route
let pending = null;

/**
 * Wait for `name` to appear on the page the route opens, then show it. `ready()` says the route has finished (core.js's
 * routeSeq moved on and nothing is navigating), so a twin on the page being left isn't the one outlined.
 */
export function showPart(name, ready) {
  const mine = (pending = {});
  const until = Date.now() + WAIT_MS;
  let opened = false;
  const tick = () => {
    if (pending !== mine) return; // another show link took over
    const el = ready() && document.querySelector(`[data-part="${name}"]`);
    if (el) {
      // A row that opens (settingsRow) opens, and so does any closed section around the part.
      for (let d = el.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) d.open = true;
      // Behind a phone's drawer or ⋯ menu: open that once, then look again.
      const btn = !opened && !el.getClientRects().length && opener(el);
      if (btn) opened = !void btn.click();
      const target = !btn && onScreen(el);
      if (target) {
        pending = null;
        return outline(target);
      }
    }
    if (Date.now() < until) return void setTimeout(tick, 100);
    pending = null;
    toast("Couldn't find that on this page: it may be for admins only, or not shown here right now", { tone: 'warn', ms: 6000 });
  };
  setTimeout(tick, 0);
}

/** The button that shows a hidden part on a phone: its panel's drawer handle, or the menu named by data-part-opener. */
function opener(el) {
  const side = el.closest('.panels > .shelf') ? 'left' : el.closest('.panels > .sidebar') ? 'right' : null;
  const via = el.closest('[data-part-opener]')?.dataset.partOpener;
  const btn = side ? document.querySelector(`.citadel-drawer-handle.${side}`) : via ? document.querySelector(`[data-part="${via}"]`) : null;
  return btn?.getClientRects().length ? btn : null;
}

/** The part, or while it's hidden the small thing on screen that holds it (a phone's ⚙ for its model picker); null if only the page does. */
function onScreen(el) {
  if (el.getClientRects().length) return el;
  let target = el;
  while (target && !target.getClientRects().length) target = target.parentElement;
  const r = target?.getBoundingClientRect();
  return r && r.width * r.height < (innerWidth * innerHeight) / 4 ? target : null;
}

function outline(target) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  target.classList.remove('part-show', 'part-show-in');
  void target.offsetWidth; // restart the pulse on a second click
  target.classList.add('part-show');
  target.classList.toggle('part-show-in', clipped(target));
  setTimeout(() => target.classList.remove('part-show', 'part-show-in'), OUTLINE_MS);
}

/** Whether a box around `el` that hides its overflow would cut off an outline drawn outside it (10 px: offset and pulse). */
function clipped(el) {
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const { overflowX: x, overflowY: y } = getComputedStyle(p);
    const b = p.getBoundingClientRect();
    if (x !== 'visible' && (r.left - b.left < 10 || b.right - r.right < 10)) return true;
    // A scroller's top and bottom move while it scrolls the part into view: only a box that hides its overflow counts.
    if ((y === 'hidden' || y === 'clip') && (r.top - b.top < 10 || b.bottom - r.bottom < 10)) return true;
  }
  return false;
}
