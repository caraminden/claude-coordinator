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
  const tick = () => {
    if (pending !== mine) return; // another show link took over
    const el = ready() && document.querySelector(`[data-part="${name}"]`);
    if (el) {
      pending = null;
      return outline(el);
    }
    if (Date.now() < until) return void setTimeout(tick, 100);
    pending = null;
    toast("Couldn't find that on this page: it may be for admins only, or not shown here right now", { tone: 'warn', ms: 6000 });
  };
  setTimeout(tick, 0);
}

function outline(el) {
  // A row that opens (settingsRow) opens, and so does any closed section around the part.
  for (let d = el.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) d.open = true;
  // A part hidden right now (a phone's picker menu) outlines the nearest thing on screen that holds it.
  let target = el;
  while (target.parentElement && !target.getClientRects().length) target = target.parentElement;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  target.classList.remove('part-show');
  void target.offsetWidth; // restart the pulse on a second click
  target.classList.add('part-show');
  setTimeout(() => target.classList.remove('part-show'), OUTLINE_MS);
}
