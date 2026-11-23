// The right-click menu's placement (#1663): just past the cursor, flipped at the right and bottom edges, kept 8 px
// inside the window, and a menu taller than the window scrolls. The menu itself is driven in menu-browser.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeMenu } from '../public/ui/menu.js';

test('opens just past the cursor when it fits', () => {
  assert.deepEqual(placeMenu(100, 100, 268, 300, 1440, 900), { left: 102, top: 102, maxHeight: 884, flipX: false, flipY: false });
});

test('flips left at the right edge and up at the bottom edge', () => {
  const p = placeMenu(1400, 850, 268, 300, 1440, 900);
  assert.equal(p.flipX, true);
  assert.equal(p.flipY, true);
  assert.equal(p.left, 1400 - 268 - 2);
  assert.equal(p.top, 850 - 300 - 2);
});

test('stays 8 px inside a window too small to flip into', () => {
  // 390 wide: neither side of x=200 has room for 268, so it flips and is held at the left margin.
  const p = placeMenu(200, 30, 268, 300, 390, 320);
  assert.equal(p.left, 8);
  assert.ok(p.left + 268 <= 390 - 8);
  assert.equal(p.top, 8);
  assert.ok(p.top + Math.min(300, p.maxHeight) <= 320 - 8);
});

test('a menu taller than the window gets a max height and sits at the top margin', () => {
  const p = placeMenu(50, 400, 268, 2000, 1440, 600);
  assert.equal(p.maxHeight, 584);
  assert.equal(p.top, 8);
});
