import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, edgeSide, initDrawers, settleOpen } from '../public/drawers.js';

test('a swipe has to start at a screen edge', () => {
  assert.equal(edgeSide(5, 390), 'left');
  assert.equal(edgeSide(44, 390), 'left');
  assert.equal(edgeSide(100, 390), null);
  assert.equal(edgeSide(350, 390), 'right');
  assert.equal(edgeSide(340, 390), null);
});

test('only mostly-horizontal moves in the opening direction are swipes', () => {
  assert.equal(classify(4, 3, 1), 'wait');
  assert.equal(classify(40, 5, 1), 'swipe');
  assert.equal(classify(-40, 5, -1), 'swipe');
  assert.equal(classify(-40, 5, 1), 'ignore'); // wrong way
  assert.equal(classify(20, 30, 1), 'ignore'); // vertical scroll
  assert.equal(classify(30, 22, 1), 'swipe'); // a thumb's slightly curved swipe
  assert.equal(classify(20, 18, 1), 'ignore'); // diagonal
});

test('a released drawer settles by flick speed, then by how far the drag got', () => {
  assert.equal(settleOpen(0.2, 0.8), true);
  assert.equal(settleOpen(0.9, -0.8), false);
  // Pulling it out: a third of the way is enough.
  assert.equal(settleOpen(0.4, 0), true);
  assert.equal(settleOpen(0.25, 0.1), false);
  // Pushing it back: a third of the way in closes it.
  assert.equal(settleOpen(0.6, 0, 1), false);
  assert.equal(settleOpen(0.75, -0.1, 1), true);
});

// initDrawers on a tiny fake DOM at phone width: the open and close events an app moves its composer by
// (#287). drawers.js was imported above without a document, so rail.js set nothing up.
class FakeEl extends EventTarget {
  constructor(id) {
    super();
    const classes = new Set();
    Object.assign(this, { id, attrs: {}, style: {}, hidden: false, isConnected: true, inert: false });
    this.classList = { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  getBoundingClientRect() { return { top: 0, width: 300 }; }
  contains(x) { return x === this; }
  focus() {}
  append() {}
  remove() {}
}

test('a drawer fires citadel-drawer-open as it comes out and citadel-drawer-close once back, in pairs', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = new FakeEl('body');
  Object.assign(globalThis, {
    Element: FakeEl,
    HTMLDetailsElement: class extends FakeEl {},
    CSSStyleSheet: class { replaceSync() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    matchMedia: (q) => ({ matches: q.includes('max-width'), addEventListener() {} }),
    requestAnimationFrame: (fn) => fn(),
    window: Object.assign(new EventTarget(), { innerWidth: 390, scrollBy() {} }),
    document: Object.assign(new EventTarget(), { body, activeElement: body, adoptedStyleSheets: [], createElement: () => new FakeEl('made') }),
  });
  const seen = [];
  for (const name of ['citadel-drawer-open', 'citadel-drawer-close']) document.addEventListener(name, (e) => seen.push([name, e.detail.side, e.detail.el.id]));
  const side = new FakeEl('side');
  const drawers = initDrawers({ right: { el: side, label: 'Acolyte' }, main: new FakeEl('main') });
  drawers.open('right');
  assert.deepEqual(seen, [['citadel-drawer-open', 'right', 'side']]);
  // A link inside it closes it, then the hashchange it causes closes it again while it slides away.
  drawers.close();
  window.dispatchEvent(new Event('hashchange'));
  side.dispatchEvent(new Event('transitionend'));
  t.mock.timers.tick(400);
  assert.deepEqual(seen, [['citadel-drawer-open', 'right', 'side'], ['citadel-drawer-close', 'right', 'side']]);
  drawers.destroy();
  for (const k of ['Element', 'HTMLDetailsElement', 'CSSStyleSheet', 'MutationObserver', 'matchMedia', 'requestAnimationFrame', 'window', 'document']) delete globalThis[k];
});
