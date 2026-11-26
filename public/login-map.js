// The map behind the sign-in and invite cards (#1500). login-map-art.js draws it; this mounts it behind the card,
// keeps it clear of the top bar, and runs the big Citadel mark on the spire: it turns to face one minion at a time,
// lights it with a beam, and every few seconds turns to another (Cara, 2026-11-21: "It turns to face the minion it
// watches", "It should track faster though").

const still = matchMedia('(prefers-reduced-motion: reduce)');
const LS = 2.3; // the mark's scale in the art (scenes9.js)

/**
 * Puts the map behind app's sign-in card. Without the art (its script didn't load), the card shows on its own.
 * @param {Element} app
 */
export function mountLoginMap(app) {
  const map = /** @type {{ citadelMap?: { draw: (host: HTMLElement, prefix: string) => SVGSVGElement } }} */ (globalThis).citadelMap;
  if (!map) return;
  const root = document.createElement('div');
  root.className = 'login-map';
  root.setAttribute('aria-hidden', 'true');
  const scene = document.createElement('div');
  scene.className = 'scene scene-m';
  root.append(scene);
  app.prepend(root);
  map.draw(scene, 'lm-');
  // The map starts under the top bar, so the CITADEL banner at its top isn't hidden behind it.
  // Watched by its border box: a notch's inset (it changes on rotation) is padding, which the default content box misses.
  const fit = () => {
    const bar = document.querySelector('.topbar');
    const h = `${bar ? bar.getBoundingClientRect().height : 0}px`;
    if (root.style.getPropertyValue('--login-map-top') !== h) root.style.setProperty('--login-map-top', h);
  };
  fit();
  const ro = new ResizeObserver(() => (root.isConnected ? fit() : ro.disconnect()));
  const bar = document.querySelector('.topbar');
  if (bar) ro.observe(bar, { box: 'border-box' });
  watch(root);
}

/**
 * One loop per map: the mark picks a minion it can see, faces it and lights it, then darts to another.
 * The map's art always has the elements below, so each lookup is cast to what it finds.
 * @param {HTMLElement} root
 */
function watch(root) {
  const el = /** @type {SVGGraphicsElement | null} */ (root.querySelector('[data-watch]'));
  if (!el) return;
  const svg = /** @type {SVGSVGElement} */ (el.ownerSVGElement),
    scene = /** @type {Element} */ (root.querySelector('.scene'));
  const look = /** @type {Element} */ (el.querySelector('.logo-look')),
    halo = /** @type {Element} */ (el.querySelector('.logo-halo')),
    at = /** @type {Element} */ (el.querySelector('.eye-at'));
  const float = /** @type {Element} */ (el.closest('.mark-float')),
    light = /** @type {Element} */ (float.previousElementSibling);
  const ray = /** @type {Element} */ (light.querySelector('.logo-ray')),
    core = /** @type {Element} */ (light.querySelector('.logo-core'));
  /** @type {{ bx: number, by: number, yw: number, tp: number, flare: number, t: number, pawn: Element | null, gx: number, gy: number }} */
  const st = { bx: 0, by: 0, yw: 0, tp: 0, flare: 0, t: 0, pawn: null, gx: 0, gy: 0 };
  /**
   * @param {DOMRect | { left: number, top: number, right: number, bottom: number }} r
   * @param {DOMRect | { left: number, top: number, right: number, bottom: number }} v
   */
  const vis = (r, v) => r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom;
  /** @param {number} now */
  const tick = (now) => {
    if (!root.isConnected) return;
    requestAnimationFrame(tick);
    const box = scene.getBoundingClientRect();
    const er = at.getBoundingClientRect(),
      ex = er.left + er.width / 2,
      ey = er.top + er.height / 2;
    if (!vis(er, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })) return;
    const held = still.matches;
    if (!held && now > st.t) {
      const seen = [...svg.querySelectorAll('.pawn')].filter((p) => {
        const r = p.getBoundingClientRect();
        return r.width && vis(r, box) && Math.hypot(r.left - ex, r.top - ey) > 40;
      });
      const was = st.pawn;
      st.pawn = seen.length ? seen[Math.floor(Math.random() * seen.length)] : null;
      if (was && was !== st.pawn) was.classList.remove('seen');
      if (st.pawn && st.pawn !== was) {
        st.pawn.classList.add('seen');
        st.flare = 1;
      }
      st.gx = Math.random() * 2 - 1;
      st.gy = Math.random() * 0.8 - 0.1;
      st.t = now + 2400 + Math.random() * 2400;
    }
    const k = svg.getScreenCTM()?.a || 1;
    let dx, dy;
    if (st.pawn && st.pawn.isConnected) {
      const r = st.pawn.getBoundingClientRect();
      dx = (r.left + r.width / 2 - ex) / k;
      dy = (r.top + r.height / 2 - ey) / k;
    } else {
      dx = st.gx * 260;
      dy = st.gy * 200 + 60;
    }
    if (held) {
      dx = 0;
      dy = 120;
    }
    // It turns: swings sideways (a skew and a narrowing) towards the minion and tips a little towards it.
    const d = Math.hypot(dx, dy) || 1,
      reach = Math.min(1, d / 160),
      ease = held ? 1 : 0.24;
    const yaw = Math.max(-1, Math.min(1, (dx / d) * reach)),
      tip = Math.max(-0.4, Math.min(1, (dy / d) * reach));
    st.yw += (yaw - st.yw) * ease;
    st.tp += (tip - st.tp) * ease;
    look.setAttribute('transform', `translate(${(st.yw * 9).toFixed(2)} ${(st.tp * 4).toFixed(2)}) skewY(${(st.yw * 10).toFixed(2)}) scale(${(1 - 0.38 * Math.abs(st.yw)).toFixed(3)} ${(1 - 0.12 * Math.abs(st.tp)).toFixed(3)})`);
    st.flare *= 0.95;
    halo.setAttribute('r', (56 + st.flare * 18).toFixed(1));
    el.style.setProperty('--flare', st.flare.toFixed(3));
    // The beam runs from the mark (riding its bob) to the minion, a little behind the look so it sweeps.
    st.bx += (dx - st.bx) * (held ? 1 : 0.2);
    st.by += (dy - st.by) * (held ? 1 : 0.2);
    const m = getComputedStyle(float).transform,
      bob = m && m !== 'none' ? new DOMMatrix(m).f : 0;
    const px = st.yw * 9,
      py = -114 + bob + 9 * LS + st.tp * 4;
    const tx = st.bx,
      ty = st.by - 114,
      len = Math.hypot(tx - px, ty - py) || 1,
      nx = -(ty - py) / len,
      ny = (tx - px) / len;
    /**
     * @param {number} w0
     * @param {number} w1
     */
    const cone = (w0, w1) => `M${(px + nx * w0).toFixed(1)} ${(py + ny * w0).toFixed(1)}L${(tx + nx * w1).toFixed(1)} ${(ty + ny * w1).toFixed(1)}L${(tx - nx * w1).toFixed(1)} ${(ty - ny * w1).toFixed(1)}L${(px - nx * w0).toFixed(1)} ${(py - ny * w0).toFixed(1)}Z`;
    ray.setAttribute('d', cone(6, 24));
    core.setAttribute('d', cone(2.5, 10));
  };
  requestAnimationFrame(tick);
}
